import { TFile } from "obsidian";
import type LoreGraphPlugin from "../main";
import { RendererAdapter } from "./rendererAdapter";
import { warn } from "./log";
import type { GraphLink, GraphNode } from "./types";

/**
 * Public contract consumed by `GraphHook` (and any future orchestrator).
 * Documents exactly which methods GraphHook is allowed to call on a reveal
 * manager — every other method of `RevealManager` must stay an implementation
 * detail. Also a seam for future swapping (e.g. debug mode, "reveal by tag"
 * mode, testing with a fake manager).
 */
export interface IRevealManager {
  applyBaseVisibility(): void;
  handleHover(id: string, x: number, y: number): void;
  handleHoverEnd(): void;
  handleMainClick(id: string, x: number, y: number): void;
  clearSelection(): void;
  getPinnedNode(): string | null;
  invalidateSettingsCache(): void;
  unload(): void;
}

/**
 * RevealManager — "physical presence" model.
 *
 * Hidden-folder nodes are NOT removed from the graph. They exist physically
 * (positions, edges, force-directed). We only manipulate their `alpha` (PIXI
 * visibility) and their `eventMode` (interactivity).
 *
 *   - Initial state: all hidden nodes → alpha=0, eventMode=none
 *   - Hover on node A → its linked hidden nodes go to alpha=1 (preview)
 *   - HoverEnd → back to alpha=0 (unless pinned)
 *   - Click on node A → pin the reveal; it stays shown
 *   - Click on a revealed hidden node → cascade: new pin, new links
 *   - Click the pinned node a 2nd time → open the note
 *   - visitedNodes accumulates to exclude repeats across cascades
 */
export class RevealManager implements IRevealManager {
  private plugin: LoreGraphPlugin;
  private adapter: RendererAdapter;

  private pinnedNode: string | null = null;
  private hoveredNode: string | null = null;
  private visitedNodes = new Set<string>();
  private currentlyRevealed = new Set<string>();
  // Grace period before hiding revealed nodes after a mouseout (lets the user
  // move the mouse from the main node to a revealed one without losing it).
  private hoverEndTimer: number | null = null;

  constructor(plugin: LoreGraphPlugin, adapter: RendererAdapter) {
    this.plugin = plugin;
    this.adapter = adapter;
  }

  /**
   * Hide all hidden-folder nodes (except those currentlyRevealed). Called by
   * the PIXI ticker every frame — must be idempotent and must NOT call
   * renderer.changed() (otherwise infinite loop + flicker).
   */
  applyBaseVisibility(): void {
    const enabled = this.plugin.settings.enabled;
    const nodes = this.adapter.getNodes();
    if (nodes.length === 0) return;

    // dt in ms since the previous frame. Clamp to [1, 100]: avoids surprises on
    // the first frame (lastFrameTime=0) and on large gaps (inactive tab,
    // debugger breakpoint…).
    const now = performance.now();
    const dt = this.lastFrameTime
      ? Math.max(1, Math.min(100, now - this.lastFrameTime))
      : 16.67;
    this.lastFrameTime = now;

    // === Pin highlight via the getHighlightNode override ===
    // The native renderer calls r.getHighlightNode() in its render loop to
    // decide which node to color purple + dim the rest. The override (set by
    // RendererPatcher) returns our pinned node when set, so the native render
    // applies automatically, identical to hover.
    //
    // CRITICAL: only TOUCH hidden-folder nodes. Touching "normal" nodes would
    // cancel Obsidian's native dim/highlight (renderer.highlightNode + native
    // hover).
    let anyFading = false;
    for (const node of nodes) {
      if (!this.isInHiddenFolder(node.id)) continue;
      const shouldShow = !enabled ? true : this.currentlyRevealed.has(node.id);
      if (this.setNodeVisible(node, shouldShow, dt)) anyFading = true;
    }
    // For links: only touch those with at least one endpoint in a hidden
    // folder.
    for (const link of this.adapter.getLinks()) {
      const src = this.endpointId(link.source);
      const tgt = this.endpointId(link.target);
      if (!this.isInHiddenFolder(src) && !this.isInHiddenFolder(tgt)) continue;
      if (this.setLinkVisible(link, this.isLinkVisible(link, enabled), dt)) {
        anyFading = true;
      }
    }
    // Obsidian's PIXI ticker is `started: false`. During a fade, without
    // calling `forceRender()`, the canvas stays frozen on the first alpha tick
    // → "pop" effect. forceRender() = px.renderer.render(stage) + changed().
    if (anyFading) this.adapter.forceRender();
  }

  handleMainClick(id: string, _x: number, _y: number): void {
    this.handleClick(id);
  }

  /** Hover on a native node. Ephemeral preview if nothing is pinned. */
  handleHover(id: string, _x: number, _y: number): void {
    if (!this.plugin.settings.enabled) return;
    if (this.pinnedNode) return; // a pin takes priority
    if (this.hoverEndTimer !== null) {
      window.clearTimeout(this.hoverEndTimer);
      this.hoverEndTimer = null;
    }
    // Always track the node under the mouse (for wasHovered on click).
    if (this.currentlyRevealed.has(id)) {
      this.hoveredNode = id;
      return;
    }
    if (this.hoveredNode === id) return;
    this.hoveredNode = id;
    // Note: we don't touch renderer.highlightNode on hover — the native code
    // already handles the purple effect on hover.
    this.applyReveal(false);
  }

  handleHoverEnd(): void {
    if (this.pinnedNode) return;
    if (!this.hoveredNode) return;
    if (this.hoverEndTimer !== null) {
      window.clearTimeout(this.hoverEndTimer);
    }
    // Grace period (see HOVER_GRACE_MS): gives the mouse time to reach a
    // revealed node before it disappears.
    this.hoverEndTimer = window.setTimeout(() => {
      this.hoverEndTimer = null;
      if (this.pinnedNode) return;
      if (!this.hoveredNode) return;
      this.hoveredNode = null;
      this.hideAllRevealed();
    }, RevealManager.HOVER_GRACE_MS);
  }

  /** Public accessor used by RendererPatcher to patch getHighlightNode. */
  getPinnedNode(): string | null {
    return this.pinnedNode;
  }

  clearSelection(): void {
    if (this.hoverEndTimer !== null) {
      window.clearTimeout(this.hoverEndTimer);
      this.hoverEndTimer = null;
    }
    this.pinnedNode = null;
    this.hoveredNode = null;
    this.visitedNodes.clear();
    // Force-clear the native hover state. The original getter (Obsidian)
    // hit-tests on mouseX/Y → as long as those coords point at a node, it
    // returns that node even after our clear. So we move the hit off any node
    // (off-viewport coords) so the hit-test fails.
    this.adapter.setHighlightNode(null);
    this.adapter.resetMousePosition();
    this.adapter.flagChanged();
    this.hideAllRevealed();
  }

  unload(): void {
    // The grace timer may be in flight at unload time: without this clear, its
    // callback would fire later against a torn-down adapter.
    if (this.hoverEndTimer !== null) {
      window.clearTimeout(this.hoverEndTimer);
      this.hoverEndTimer = null;
    }
    this.adapter.setHighlightNode(null);
    // Restore visibility of all nodes (alpha = 1 instantly).
    for (const node of this.adapter.getNodes()) {
      this.myAlpha.delete(node.circle);
      this.myAlpha.delete(node.text);
      if (node.circle) {
        node.circle.alpha = 1;
        node.circle.visible = true;
        node.circle.renderable = true;
        if (node.circle.scale) {
          node.circle.scale.x = 1;
          node.circle.scale.y = 1;
        }
        try {
          node.circle.eventMode = "static";
        } catch {
          /* noop */
        }
      }
      if (node.text) {
        node.text.alpha = 1;
        node.text.visible = true;
        node.text.renderable = true;
      }
    }
    for (const link of this.adapter.getLinks()) {
      for (const obj of [link.line, link.px, link.arrow]) {
        if (!obj) continue;
        this.myAlpha.delete(obj);
        obj.alpha = 1;
        obj.visible = true;
      }
    }
    this.currentlyRevealed.clear();
    this.adapter.flagChanged();
  }

  private handleClick(id: string): void {
    // 2nd click on the pinned node = open the note.
    if (this.pinnedNode === id) {
      this.openNote(id);
      return;
    }

    const wasHovered = this.hoveredNode === id;
    // Forward cascade: we extend the current chain. That means either:
    //   - the clicked node was hovered (first click of the chain, after the
    //     hover preview), or
    //   - it is currently revealed as a child of the previous pin (natural
    //     extension of the cascade).
    // Any other case (clicking a node already visited but OUTSIDE the current
    // fan-out = back-nav to an older root, or clicking a brand-new node with no
    // visible link) → reset the history to start fresh.
    const isForwardCascade = wasHovered || this.currentlyRevealed.has(id);
    if (!isForwardCascade) {
      this.visitedNodes.clear();
    }
    this.visitedNodes.add(id);
    this.pinnedNode = id;
    this.hoveredNode = null;

    // Trigger a re-render — the getHighlightNode override (set by
    // RendererPatcher) will be consulted by the render loop and return our
    // pinned node → purple effect.
    this.adapter.flagChanged();

    if (wasHovered && this.currentlyRevealed.size > 0) {
      for (const revealedId of this.currentlyRevealed) {
        this.visitedNodes.add(revealedId);
      }
      return;
    }

    this.applyReveal(true);
  }

  private applyReveal(useVisited: boolean): void {
    const target = this.pinnedNode ?? this.hoveredNode;
    this.hideAllRevealed();
    if (!target || !this.plugin.settings.enabled) {
      this.adapter.flagChanged();
      return;
    }

    // If the target is itself a hidden node (cascade case: clicking a revealed
    // journal note), keep it visible during the cascade.
    if (this.isInHiddenFolder(target)) {
      const targetNode = this.adapter.getNode(target);
      if (targetNode) {
        this.setNodeVisible(targetNode, true);
        this.currentlyRevealed.add(target);
      }
    }

    const hiddenLinks = this.getHiddenLinks(target);
    const filtered = useVisited
      ? hiddenLinks.filter((l) => !this.visitedNodes.has(l))
      : hiddenLinks;
    const cap = this.plugin.settings.maxNodes;
    const shown = filtered.slice(0, cap);

    for (const linkId of shown) {
      const node = this.adapter.getNode(linkId);
      if (node) {
        this.setNodeVisible(node, true);
        this.currentlyRevealed.add(linkId);
        if (useVisited) this.visitedNodes.add(linkId);
      }
    }
    // Show the edges between target and revealed nodes (and between mutually
    // revealed nodes).
    for (const link of this.adapter.getLinks()) {
      const src = this.endpointId(link.source);
      const tgt = this.endpointId(link.target);
      const involvesRevealed =
        (src === target && this.currentlyRevealed.has(tgt)) ||
        (tgt === target && this.currentlyRevealed.has(src)) ||
        (this.currentlyRevealed.has(src) && this.currentlyRevealed.has(tgt));
      if (involvesRevealed) this.setLinkVisible(link, true);
    }
    this.adapter.flagChanged();
  }

  private hideAllRevealed(): void {
    for (const id of this.currentlyRevealed) {
      const node = this.adapter.getNode(id);
      if (node) this.setNodeVisible(node, false);
    }
    this.currentlyRevealed.clear();
    // Re-hide edges to non-revealed hidden endpoints.
    for (const link of this.adapter.getLinks()) {
      const src = this.endpointId(link.source);
      const tgt = this.endpointId(link.target);
      if (this.isInHiddenFolder(src) || this.isInHiddenFolder(tgt)) {
        const srcOk =
          !this.isInHiddenFolder(src) || this.currentlyRevealed.has(src);
        const tgtOk =
          !this.isInHiddenFolder(tgt) || this.currentlyRevealed.has(tgt);
        this.setLinkVisible(link, srcOk && tgtOk);
      }
    }
    this.adapter.flagChanged();
  }

  // === Visibility helpers ===

  // === Smooth animation (60fps lerp via the ticker) ===
  //
  // Subtlety: Obsidian's renderer resets alpha=1 on every node every frame. If
  // we read alpha from the node, the lerp restarts at 1 each time → stuck at
  // ~78%. Solution: track our own alpha in WeakMaps.

  /**
   * Half-life of the exponential lerp in ms. Modeled on Obsidian's native
   * `mQ(s, v)` that animates the hover dim: measured ~44ms by instrumenting
   * `fadeAlpha` on an unrelated node while `highlightNode` is set. So our
   * fade in/out has exactly the same curve and perceived duration as the native
   * dimming. Refresh-rate independent thanks to the measured `dt`.
   */
  private static readonly FADE_HALFLIFE_MS = 44;
  /**
   * Delay after mouseout before hiding the revealed nodes. Gives the user time
   * to move the mouse from a main node to a revealed one without it
   * disappearing on the way.
   */
  private static readonly HOVER_GRACE_MS = 250;
  /**
   * Threshold below which alpha is considered "fully hidden". Low (0.005) so
   * the tail of the fade is invisible to the eye before `visible/renderable`
   * flips — avoids a perceptible pop at the end of the animation.
   */
  private static readonly HIDE_THRESHOLD = 0.005;

  private lastFrameTime = 0;

  // Our own alpha state, ignoring the renderer's per-frame reset.
  private myAlpha = new WeakMap<any, number>();

  /**
   * Time-based exponential lerp. The factor depends on the measured `dt` → the
   * fade duration stays identical at 60Hz, 144Hz or 240Hz.
   * `factor = 1 - 0.5^(dt/halfLife)`: after `halfLife` ms, 50% of the remaining
   * distance has been covered.
   */
  private lerpAlpha(current: number, target: number, dt: number): number {
    if (Math.abs(target - current) < RevealManager.HIDE_THRESHOLD) return target;
    const factor = 1 - Math.pow(0.5, dt / RevealManager.FADE_HALFLIFE_MS);
    return current + (target - current) * factor;
  }

  /** Returns true if something changed this frame (a re-render is needed). */
  private applyAlpha(
    target: any,
    vis: boolean,
    withScale: boolean,
    withEvent: boolean,
    dt: number,
  ): boolean {
    if (!target) return false;
    const desired = vis ? 1 : 0;
    const current = this.myAlpha.get(target) ?? 1;
    const isStable = current === desired;
    let next = current;
    let changed = false;
    if (!isStable) {
      next = this.lerpAlpha(current, desired, dt);
      this.myAlpha.set(target, next);
      target.alpha = next;
      changed = true;
    }
    // visible/renderable/eventMode are ALWAYS resynced to the current state,
    // even when isStable — otherwise after a reload (fresh WeakMap, current
    // defaults to 1) we'd never have set visible=true on the nodes we want to
    // show, and they'd stay invisible despite alpha=1.
    const present = next > RevealManager.HIDE_THRESHOLD;
    if (target.visible !== present) {
      target.visible = present;
      changed = true;
    }
    if (target.renderable !== present) {
      target.renderable = present;
      changed = true;
    }
    // NOTE: we do NOT touch `target.scale`. Obsidian's render computes
    // `circle.scale = c/100*f` every frame (where c=node.getSize() and
    // f=renderer.nodeScale). Forcing scale=1 races the native render → when the
    // native code wins the last write, the scale is tiny, and the PIXI hit-test
    // (which maps global → local via 1/scale) produces local coords outside the
    // circle's 200×200 bounds → clicks miss the node. Visibility is carried by
    // alpha + renderable.
    if (withEvent) {
      try {
        const mode = present ? "static" : "none";
        if (target.eventMode !== mode) {
          target.eventMode = mode;
          changed = true;
        }
      } catch {
        /* noop */
      }
    }
    return changed;
  }

  /** Returns true if at least one sub-object changed state this frame. */
  private setNodeVisible(node: GraphNode, vis: boolean, dt = 16.67): boolean {
    const a = this.applyAlpha(node.circle, vis, true, true, dt);
    const b = this.applyAlpha(node.text, vis, false, false, dt);
    return a || b;
  }

  /** Returns true if at least one of the link's sub-objects changed this frame. */
  private setLinkVisible(link: GraphLink, vis: boolean, dt = 16.67): boolean {
    const a = this.applyAlpha(link.line, vis, false, false, dt);
    const b = this.applyAlpha(link.px, vis, false, false, dt);
    const c = this.applyAlpha(link.arrow, vis, false, false, dt);
    return a || b || c;
  }

  private isLinkVisible(link: GraphLink, enabled: boolean): boolean {
    if (!enabled) return true;
    const src = this.endpointId(link.source);
    const tgt = this.endpointId(link.target);
    const srcHidden = this.isInHiddenFolder(src);
    const tgtHidden = this.isInHiddenFolder(tgt);
    if (!srcHidden && !tgtHidden) return true;
    const srcOk = !srcHidden || this.currentlyRevealed.has(src);
    const tgtOk = !tgtHidden || this.currentlyRevealed.has(tgt);
    return srcOk && tgtOk;
  }

  private endpointId(endpoint: string | GraphNode | undefined): string {
    if (typeof endpoint === "string") return endpoint;
    if (endpoint && typeof endpoint === "object" && endpoint.id) return endpoint.id;
    return "";
  }

  // === Data: collect a node's hidden links ===

  private getHiddenLinks(filePath: string): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const app = this.plugin.app;

    const file = app.vault.getAbstractFileByPath(filePath);

    // Incoming (backlinks)
    if (file instanceof TFile) {
      try {
        const backlinks: any = (app.metadataCache as any).getBacklinksForFile(file);
        const dataMap = backlinks?.data ?? backlinks;
        if (dataMap && typeof dataMap.forEach === "function") {
          dataMap.forEach((_refs: any, path: string) => {
            if (!seen.has(path) && this.isInHiddenFolder(path)) {
              seen.add(path);
              result.push(path);
            }
          });
        } else if (dataMap && typeof dataMap === "object") {
          for (const path of Object.keys(dataMap)) {
            if (!seen.has(path) && this.isInHiddenFolder(path)) {
              seen.add(path);
              result.push(path);
            }
          }
        }
      } catch (err) {
        warn("getBacklinksForFile error", err);
      }
    }

    // Outgoing
    const cache = app.metadataCache.getCache(filePath);
    if (cache?.links) {
      for (const link of cache.links) {
        const target = app.metadataCache.getFirstLinkpathDest(link.link, filePath);
        if (target && !seen.has(target.path) && this.isInHiddenFolder(target.path)) {
          seen.add(target.path);
          result.push(target.path);
        }
      }
    }

    return result;
  }

  private normHiddenCache: string[] | null = null;

  /**
   * Normalized list (trailing slash, empty entries removed) of the hidden
   * folders, memoized. Recomputed only on a settings change
   * (`invalidateSettingsCache`, called by GraphHook.refresh) rather than
   * re-normalized N times per frame in `applyBaseVisibility`.
   */
  private normalizedHidden(): string[] {
    if (this.normHiddenCache === null) {
      this.normHiddenCache = this.plugin.settings.hiddenFolders
        .filter((f) => !!f)
        .map((f) => (f.endsWith("/") ? f : f + "/"));
    }
    return this.normHiddenCache;
  }

  /** Invalidate the normalized-folders cache (after a settings change). */
  invalidateSettingsCache(): void {
    this.normHiddenCache = null;
  }

  private isInHiddenFolder(path: string): boolean {
    if (!path) return false;
    const folders = this.normalizedHidden();
    for (const f of folders) {
      if (path.startsWith(f)) return true;
    }
    return false;
  }

  private openNote(path: string): void {
    this.plugin.app.workspace.openLinkText(path, "", false);
  }
}
