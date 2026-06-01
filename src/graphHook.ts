import type LoreGraphPlugin from "../main";
import { RendererAdapter } from "./rendererAdapter";
import { RendererPatcher } from "./rendererPatcher";
import { RevealManager, type IRevealManager } from "./revealManager";
import type { GraphView } from "./types";

/**
 * Delay before each initial attach retry: Obsidian can take a few frames to
 * fully instantiate the PIXI renderer (non-empty `renderer.nodes`,
 * `renderer.px.stage` ready).
 */
const INITIAL_ATTACH_DELAY_MS = 500;
/** Max number of initial attach attempts (× INITIAL_ATTACH_DELAY_MS). */
const MAX_ATTACH_RETRIES = 10;

/**
 * All state attached to a graph view: adapter, manager, and the patcher that
 * owns the renderer wiring (overrides, rAF, listeners).
 */
interface ViewBinding {
  adapter: RendererAdapter;
  mgr: IRevealManager;
  patcher: RendererPatcher;
}

/**
 * Anti-ghost-loop generation. Bumped once per `start()` (i.e. per plugin load)
 * and shared by every patcher of that load via `PatcherTarget`. Stored on
 * `window` so it survives module scope across loads: an rAF loop from a stale
 * generation (a previous instance that wasn't fully cleaned up) terminates
 * itself, while all loops of the current generation coexist — which is what
 * makes multi-view work.
 */
function nextGeneration(): number {
  const w = window as typeof window & {
    __loreRafGeneration?: number;
    __loreRafToken?: number;
  };
  w.__loreRafGeneration = (w.__loreRafGeneration ?? 0) + 1;
  // Also evict rAF loops from an OLDER plugin version (which self-terminated
  // via `window.__loreRafToken`, before the switch to generations). Without
  // this, a hot upgrade — reloading the plugin without restarting Obsidian —
  // leaves the old loop running ON TOP of the new one: alpha is then lerped
  // twice per frame and nodes seem to vanish instantly. Bumping the token
  // makes the old loop see `__loreRafToken !== myToken` and stop next frame.
  if (typeof w.__loreRafToken === "number") {
    w.__loreRafToken += 1;
  }
  return w.__loreRafGeneration;
}

/**
 * GraphHook — lightweight orchestrator.
 *
 * Single responsibility: on every `layout-change`, RECONCILE the set of open
 * "graph" leaves with the bindings — attach a `RendererPatcher` to new ones,
 * and DETACH those whose tab was closed (otherwise their rAF loop and overrides
 * would leak onto a dead renderer). The detailed wiring lives in the patcher,
 * the visibility logic in the RevealManager.
 */
export class GraphHook {
  private plugin: LoreGraphPlugin;
  // Map (not WeakMap) so we can iterate and detach bindings of closed views.
  // The explicit detach (reconcile/stop) is what prevents the orphan loop.
  private bindings = new Map<GraphView, ViewBinding>();
  private generation = 0;
  private attachTimer?: number;

  constructor(plugin: LoreGraphPlugin) {
    this.plugin = plugin;
  }

  start(): void {
    this.generation = nextGeneration();
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => this.reconcile()),
    );
    this.reconcile();
    // The PIXI renderer can take a few frames to be ready. Retry, bounded,
    // while no view is attached — beyond that we rely on `layout-change` (which
    // covers a graph view opened later). The timer is tracked so it can be
    // cancelled if the plugin unloads in the meantime.
    this.scheduleAttachRetry(0);
  }

  private scheduleAttachRetry(attempt: number): void {
    this.attachTimer = window.setTimeout(() => {
      this.attachTimer = undefined;
      this.reconcile();
      if (this.bindings.size === 0 && attempt + 1 < MAX_ATTACH_RETRIES) {
        this.scheduleAttachRetry(attempt + 1);
      }
    }, INITIAL_ATTACH_DELAY_MS);
  }

  stop(): void {
    if (this.attachTimer !== undefined) {
      window.clearTimeout(this.attachTimer);
      this.attachTimer = undefined;
    }
    for (const [view, binding] of this.bindings) {
      binding.patcher.detach();
      binding.mgr.unload();
      this.bindings.delete(view);
    }
  }

  /**
   * Force a recompute of hidden-node visibility on all active graph views
   * (used after a setting changes).
   */
  refresh(): void {
    for (const binding of this.bindings.values()) {
      binding.mgr.invalidateSettingsCache();
      binding.mgr.applyBaseVisibility();
    }
  }

  /**
   * Reconcile the bindings with the currently open graph views: detach those
   * that disappeared (closed tab), attach new ones, re-sync existing ones.
   * Called on every `layout-change`.
   */
  private reconcile(): void {
    const leaves = this.plugin.app.workspace.getLeavesOfType("graph");
    const openViews = new Set<GraphView>();
    for (const leaf of leaves) {
      const view = leaf.view as unknown as GraphView;
      if (view && view.renderer) openViews.add(view);
    }

    // Detach bindings whose view is no longer open. Without this, their rAF
    // loop and overrides would stay attached to a dead renderer.
    for (const [view, binding] of this.bindings) {
      if (!openViews.has(view)) {
        binding.patcher.detach();
        binding.mgr.unload();
        this.bindings.delete(view);
      }
    }

    // Attach new views, re-sync existing ones.
    for (const view of openViews) {
      let binding = this.bindings.get(view);
      if (!binding) {
        const adapter = new RendererAdapter(view.renderer);
        const mgr = new RevealManager(this.plugin, adapter);
        const patcher = new RendererPatcher();
        patcher.attach({ view, adapter, mgr, generation: this.generation });
        binding = { adapter, mgr, patcher };
        this.bindings.set(view, binding);
      } else {
        // layout-change: re-sync hover listeners for newly appeared nodes.
        binding.patcher.syncHoverListeners();
      }
      binding.mgr.applyBaseVisibility();
    }
  }
}
