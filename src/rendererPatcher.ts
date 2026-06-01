import type { RendererAdapter } from "./rendererAdapter";
import type { IRevealManager } from "./revealManager";
import { debug, warn, error } from "./log";
import type { GraphNode, GraphRenderer, GraphView } from "./types";

/**
 * All the wiring for a view: passed to `attach()` / `detach()`. The patcher
 * keeps these refs internally between the two calls.
 */
export interface PatcherTarget {
  view: GraphView;
  adapter: RendererAdapter;
  mgr: IRevealManager;
  /**
   * Anti-ghost-loop generation, provided by `GraphHook` (one per plugin load,
   * shared by all patchers of that load). See `startRafLoop`.
   */
  generation: number;
}

interface HoverPair {
  onOver: () => void;
  onOut: () => void;
}

/**
 * `RendererPatcher` is the single owner of the changes made to the Obsidian
 * renderer for a given view:
 *
 *   - override of `onNodeClick` (intercept node clicks)
 *   - override of `getHighlightNode` (persistent pin via the native render)
 *   - `pointerover`/`pointerout` listeners on each circle (hover preview)
 *   - a `pointerdown` listener on the stage (empty-click → clearSelection)
 *   - a requestAnimationFrame loop driving `mgr.applyBaseVisibility()`
 *   - generation-based anti-ghost-loop (`window.__loreRafGeneration`)
 *   - debug counter (`window.__loreFrames`)
 *
 * `attach()` sets everything up, `detach()` tears it all down symmetrically.
 * `syncHoverListeners()` must be called again on every `layout-change` to wire
 * listeners onto nodes that appeared since the last sync.
 *
 * A patcher is bound to ONE view. `GraphHook` creates one patcher per view and
 * keeps the mapping in a Map.
 */
export class RendererPatcher {
  private attached = false;
  private target?: PatcherTarget;
  private origOnNodeClick?: GraphRenderer["onNodeClick"];
  private origGetHighlightNode?: GraphRenderer["getHighlightNode"];
  private stageHandler?: (e: unknown) => void;
  private hoverHandlers = new WeakMap<GraphNode, HoverPair>();
  private rafState?: { id: number; stopped: boolean; frameCount: number };

  attach(target: PatcherTarget): void {
    if (this.attached) return;
    this.attached = true;
    this.target = target;
    this.patchOnNodeClick();
    this.patchGetHighlightNode();
    this.attachStageHandler();
    this.attachHoverListeners();
    this.startRafLoop();
  }

  /**
   * Call again when `layout-change` signals that new nodes may have appeared in
   * the graph. Idempotent: only wires nodes that don't have a handler yet.
   */
  syncHoverListeners(): void {
    if (!this.attached) return;
    this.attachHoverListeners();
  }

  detach(): void {
    if (!this.attached) return;
    this.stopRafLoop();
    this.detachHoverListeners();
    this.detachStageHandler();
    this.unpatchGetHighlightNode();
    this.unpatchOnNodeClick();
    this.cleanupGlobals();
    this.attached = false;
    this.target = undefined;
  }

  // === onNodeClick ===

  private patchOnNodeClick(): void {
    if (!this.target) return;
    const { adapter, mgr } = this.target;
    const renderer = adapter.raw();
    this.origOnNodeClick = renderer.onNodeClick;
    renderer.onNodeClick = (_e, id, type) => {
      const node = adapter.getNode(id);
      if (!node) {
        warn("node not found", id);
        return;
      }
      debug(`click id=${id} type=${type}`);
      try {
        mgr.handleMainClick(id, node.x, node.y);
      } catch (err) {
        // The plugin handler threw: we don't want to swallow the click
        // silently → log it and fall back to the native behavior.
        error("onNodeClick handler threw — falling back to native", err);
        this.origOnNodeClick?.call(renderer, _e, id, type);
      }
    };
  }

  private unpatchOnNodeClick(): void {
    if (!this.target || !this.origOnNodeClick) return;
    this.target.adapter.raw().onNodeClick = this.origOnNodeClick;
    this.origOnNodeClick = undefined;
  }

  // === getHighlightNode (override for the persistent pin) ===

  private patchGetHighlightNode(): void {
    if (!this.target) return;
    const { adapter, mgr } = this.target;
    const renderer = adapter.raw();
    // The native render loop calls r.getHighlightNode() → we return the pinned
    // node when set. Otherwise we read the `highlightNode` property DIRECTLY
    // (which the native pointermove keeps updated on hover) rather than
    // delegating to the original getter — that getter holds hidden state which
    // persists after a clear, which prevented empty-click from truly clearing
    // the highlight.
    this.origGetHighlightNode = renderer.getHighlightNode?.bind(renderer);
    renderer.getHighlightNode = function () {
      const pinId = mgr.getPinnedNode();
      if (pinId) {
        const pinNode = adapter.getNode(pinId);
        if (pinNode) return pinNode;
      }
      return adapter.getHighlightNode();
    };
  }

  private unpatchGetHighlightNode(): void {
    if (!this.target || !this.origGetHighlightNode) return;
    this.target.adapter.raw().getHighlightNode = this.origGetHighlightNode;
    this.origGetHighlightNode = undefined;
  }

  // === Stage pointerdown (empty-click → clearSelection) ===

  private attachStageHandler(): void {
    if (!this.target) return;
    const { adapter, mgr } = this.target;
    const stage = adapter.getStage() as { on?: Function; off?: Function } | undefined;
    if (!stage || typeof stage.on !== "function") return;
    this.stageHandler = (_e: unknown) => {
      // Read the `highlightNode` PROPERTY directly (not the getter override).
      // If null at click time → cursor over empty space → clear.
      if (!adapter.getHighlightNode()) mgr.clearSelection();
    };
    try {
      stage.on("pointerdown", this.stageHandler);
    } catch (err) {
      warn("stage click hook failed", err);
      this.stageHandler = undefined;
    }
  }

  private detachStageHandler(): void {
    if (!this.target || !this.stageHandler) return;
    const stage = this.target.adapter.getStage() as
      | { on?: Function; off?: Function }
      | undefined;
    if (stage && typeof stage.off === "function") {
      try {
        stage.off("pointerdown", this.stageHandler);
      } catch {
        /* ignore */
      }
    }
    this.stageHandler = undefined;
  }

  // === Per-circle hover listeners ===

  private attachHoverListeners(): void {
    if (!this.target) return;
    const { adapter, mgr } = this.target;
    for (const node of adapter.getNodes()) {
      if (!node.circle) continue;
      if (this.hoverHandlers.has(node)) continue; // already attached
      const circle = node.circle;
      try {
        circle.eventMode = "static";
        circle.interactive = true;
      } catch {
        /* ignore */
      }
      const onOver = () => mgr.handleHover(node.id, node.x, node.y);
      const onOut = () => mgr.handleHoverEnd();
      try {
        circle.on("pointerover", onOver);
        circle.on("pointerout", onOut);
        this.hoverHandlers.set(node, { onOver, onOut });
      } catch (err) {
        warn("hover attach failed", err);
      }
    }
  }

  private detachHoverListeners(): void {
    if (!this.target) return;
    for (const node of this.target.adapter.getNodes()) {
      const pair = this.hoverHandlers.get(node);
      if (!pair || !node.circle) continue;
      try {
        node.circle.off("pointerover", pair.onOver);
        node.circle.off("pointerout", pair.onOut);
      } catch {
        /* ignore */
      }
      this.hoverHandlers.delete(node);
    }
  }

  // === requestAnimationFrame loop ===

  /**
   * Obsidian's PIXI ticker exists but isn't started — their render loop is
   * custom. So we bootstrap our own rAF that calls `applyBaseVisibility()`
   * every frame.
   *
   * GENERATION-BASED ANTI-GHOST-LOOP (vs the old global per-loop token, which
   * collapsed all views into a single surviving loop → multi-view broken).
   * `GraphHook` bumps `window.__loreRafGeneration` once per plugin load and
   * passes that value to ALL its patchers. So:
   *   - every loop of the current generation coexists (multi-view OK)
   *   - a loop left by a previous instance (stale generation, e.g. a reload
   *     where `detach()` didn't fully clean up) sees `generation` ≠ the current
   *     generation and terminates itself next frame.
   */
  private startRafLoop(): void {
    if (!this.target) return;
    const { mgr, generation } = this.target;
    const win = window as typeof window & {
      __loreRafGeneration?: number;
      __loreFrames?: number;
    };
    const state = { id: 0, stopped: false, frameCount: 0 };
    this.rafState = state;
    const loop = () => {
      if (state.stopped) return;
      if (win.__loreRafGeneration !== generation) {
        state.stopped = true;
        return;
      }
      state.frameCount++;
      win.__loreFrames = (win.__loreFrames ?? 0) + 1;
      if (state.frameCount === 1) {
        debug("[rAF] first frame, view hooked");
      }
      try {
        mgr.applyBaseVisibility();
      } catch (err) {
        error("rAF error", err);
      }
      state.id = requestAnimationFrame(loop);
    };
    state.id = requestAnimationFrame(loop);
    debug("rAF started (gen=" + generation + ")");
  }

  private stopRafLoop(): void {
    if (!this.rafState) return;
    this.rafState.stopped = true;
    if (this.rafState.id) cancelAnimationFrame(this.rafState.id);
    this.rafState = undefined;
  }

  /**
   * Clean up the `__loreFrames` debug counter. We deliberately keep
   * `__loreRafGeneration` so its increments keep serving the anti-ghost-loop
   * check across future sessions.
   */
  private cleanupGlobals(): void {
    try {
      delete (window as typeof window & { __loreFrames?: number }).__loreFrames;
    } catch {
      /* ignore */
    }
  }
}
