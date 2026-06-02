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
 *   - Click on node A → pin it; reveal its hidden links
 *   - Click a linked node (hidden candidate or visible neighbour) → cascade:
 *     it becomes the new pin and extends `pathNodes` (the clicked chain)
 *   - Re-click a node already on the path → walk back up (truncate the chain)
 *   - Click the pinned node a 2nd time → open the note
 *
 * `pathNodes` is the breadcrumb of clicked nodes. With the `keepTrail` setting
 * on, the whole path stays revealed and is tinted blue (current pin excepted —
 * it keeps the native purple highlight); with it off, only the current node and
 * its children are shown. `currentlyRevealed` is derived each reveal as
 * {hidden path nodes} ∪ {current node's candidates}.
 */
export class RevealManager implements IRevealManager {
  private plugin: LoreGraphPlugin;
  private adapter: RendererAdapter;

  private pinnedNode: string | null = null;
  private hoveredNode: string | null = null;
  private currentlyRevealed = new Set<string>();
  // Ordered chain of clicked nodes (the breadcrumb). When keepTrail is on, the
  // hidden nodes of this path stay revealed and tinted blue as you cascade
  // deeper, while siblings of each step fade out.
  private pathNodes: string[] = [];
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
    // CRITICAL: only touch the alpha/visibility of hidden-folder nodes.
    // Touching "normal" nodes' alpha would cancel Obsidian's native dim/highlight
    // (renderer.highlightNode + native hover). The one thing we DO override on
    // normal nodes is `tint` (breadcrumb coloring) — that doesn't affect the
    // dim/highlight, which are driven by alpha.
    let anyFading = false;
    // Index of each path node (built once per frame): membership for node
    // tinting + adjacency for path-edge tinting. Null when keepTrail is off.
    const tintPath = enabled && this.plugin.settings.keepTrail;
    const pathIdx = tintPath
      ? new Map(this.pathNodes.map((p, i) => [p, i] as const))
      : null;
    // A breadcrumb node tinted blue = on the path, not the current pin (which
    // keeps Obsidian's native purple highlight).
    const onTrail = (id: string) =>
      pathIdx !== null && id !== this.pinnedNode && pathIdx.has(id);
    for (const node of nodes) {
      if (this.isInHiddenFolder(node.id)) {
        const shouldShow = !enabled ? true : this.currentlyRevealed.has(node.id);
        if (this.setNodeVisible(node, shouldShow, dt)) anyFading = true;
        const tint = onTrail(node.id) && shouldShow ? RevealManager.PATH_TINT : null;
        if (this.applyTint(node, tint)) anyFading = true;
      } else {
        // Always-visible (evergreen) node: never touch its alpha/visibility
        // (that would cancel Obsidian's native dim/highlight) — only tint it
        // blue when it's part of the breadcrumb.
        const tint = onTrail(node.id) ? RevealManager.PATH_TINT : null;
        if (this.applyTint(node, tint)) anyFading = true;
      }
    }
    // Links: manage visibility for those touching a hidden node; tint the path
    // edges (between consecutive breadcrumb nodes) blue — including edges
    // between two always-visible nodes.
    for (const link of this.adapter.getLinks()) {
      const src = this.endpointId(link.source);
      const tgt = this.endpointId(link.target);
      if (this.isInHiddenFolder(src) || this.isInHiddenFolder(tgt)) {
        if (this.setLinkVisible(link, this.isLinkVisible(link, enabled), dt)) {
          anyFading = true;
        }
      }
      const onPath =
        pathIdx !== null &&
        pathIdx.has(src) &&
        pathIdx.has(tgt) &&
        Math.abs((pathIdx.get(src) as number) - (pathIdx.get(tgt) as number)) === 1;
      const tint = onPath ? RevealManager.PATH_TINT : null;
      if (this.applyTintObj(link.line, tint)) anyFading = true;
      if (this.applyTintObj(link.arrow, tint)) anyFading = true;
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
    this.pathNodes = [];
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
      // Restore any breadcrumb tint we applied.
      if (node.circle && this.myTint.has(node.circle)) {
        (node.circle as any).tint = this.myTint.get(node.circle) as number;
        this.myTint.delete(node.circle);
      }
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
        if (this.myTint.has(obj)) {
          (obj as any).tint = this.myTint.get(obj) as number;
          this.myTint.delete(obj);
        }
        obj.alpha = 1;
        obj.visible = true;
      }
    }
    this.currentlyRevealed.clear();
    this.pathNodes = [];
    this.adapter.flagChanged();
  }

  private handleClick(id: string): void {
    // 2nd click on the pinned node = open the note.
    if (this.pinnedNode === id) {
      this.openNote(id);
      return;
    }

    // Maintain the breadcrumb path of clicked nodes.
    const inPath = this.pathNodes.indexOf(id);
    // Extend the path when clicking a node LINKED to the current one — a hidden
    // candidate OR an always-visible (evergreen) neighbour. The breadcrumb can
    // thus weave through both hidden and visible nodes.
    const extendsPath =
      inPath === -1 &&
      this.pinnedNode !== null &&
      this.areLinked(this.pinnedNode, id);
    if (inPath !== -1) {
      // Re-click a node already on the path → walk back up to it.
      this.pathNodes = this.pathNodes.slice(0, inPath + 1);
    } else if (extendsPath) {
      // Forward cascade: extend the path with the clicked neighbour.
      this.pathNodes.push(id);
    } else {
      // New root: first click, or a node unrelated to the current fan-out.
      this.pathNodes = [id];
    }

    this.pinnedNode = id;
    this.hoveredNode = null;

    // Trigger a re-render — the getHighlightNode override (set by
    // RendererPatcher) will be consulted by the render loop and return our
    // pinned node → purple effect.
    this.adapter.flagChanged();
    this.applyReveal(true);
  }

  private applyReveal(excludePath: boolean): void {
    const target = this.pinnedNode ?? this.hoveredNode;
    if (!target || !this.plugin.settings.enabled) {
      this.hideAllRevealed();
      this.adapter.flagChanged();
      return;
    }

    const keepTrail = this.plugin.settings.keepTrail && this.pinnedNode !== null;

    // Trail = the hidden nodes to keep visible besides the fresh candidates.
    //   - keepTrail ON  → every hidden node of the clicked path (the breadcrumb)
    //   - keepTrail OFF → just the current node if it's hidden (base behavior:
    //     a cascaded-into hidden note stays while its children are revealed)
    const trail = keepTrail
      ? this.pathNodes.filter((p) => this.isInHiddenFolder(p))
      : this.isInHiddenFolder(target)
        ? [target]
        : [];

    // Candidates = the current node's hidden links, minus the path ancestors
    // (don't re-offer where we came from), capped.
    const onPath = new Set(this.pathNodes);
    const hiddenLinks = this.getHiddenLinks(target);
    const filtered = excludePath
      ? hiddenLinks.filter((l) => !onPath.has(l))
      : hiddenLinks;
    const candidates = filtered.slice(0, this.plugin.settings.maxNodes);

    const desired = new Set<string>([...trail, ...candidates]);

    // Diff against what's currently shown: fade out what leaves (faded
    // siblings), reveal what enters.
    for (const id of this.currentlyRevealed) {
      if (!desired.has(id)) {
        const node = this.adapter.getNode(id);
        if (node) this.setNodeVisible(node, false);
      }
    }
    for (const id of desired) {
      const node = this.adapter.getNode(id);
      if (node) this.setNodeVisible(node, true);
    }
    this.currentlyRevealed = desired;

    // Recompute link visibility: path + current→candidate edges become visible,
    // edges to faded siblings hide. isLinkVisible already encodes "a hidden
    // endpoint must be currently revealed".
    const enabled = this.plugin.settings.enabled;
    for (const link of this.adapter.getLinks()) {
      const src = this.endpointId(link.source);
      const tgt = this.endpointId(link.target);
      if (!this.isInHiddenFolder(src) && !this.isInHiddenFolder(tgt)) continue;
      this.setLinkVisible(link, this.isLinkVisible(link, enabled));
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

  /**
   * Tint applied to the already-traversed breadcrumb nodes. A blue in the same
   * tone as Obsidian's native reveal highlight (#8a5cf5, hue 258°): same
   * saturation/lightness, hue shifted to ~220° → #5c8ff5.
   */
  private static readonly PATH_TINT = 0x5c8ff5;

  private lastFrameTime = 0;

  // Our own alpha state, ignoring the renderer's per-frame reset.
  private myAlpha = new WeakMap<any, number>();
  // Saved native tint of circles we override (to restore when they leave the path).
  private myTint = new WeakMap<any, number>();

  /**
   * Override a node's tint (breadcrumb coloring), or restore its native tint
   * when `tint` is null. The native renderer rewrites `tint` every frame, so we
   * re-assert ours from the ticker — same approach as the alpha override.
   * Returns true if something changed this frame.
   */
  private applyTintObj(obj: any, tint: number | null): boolean {
    if (!obj || typeof obj.tint !== "number") return false;
    if (tint === null) {
      if (!this.myTint.has(obj)) return false;
      obj.tint = this.myTint.get(obj) as number;
      this.myTint.delete(obj);
      return true;
    }
    if (!this.myTint.has(obj)) this.myTint.set(obj, obj.tint);
    if (obj.tint === tint) return false;
    obj.tint = tint;
    return true;
  }

  private applyTint(node: GraphNode, tint: number | null): boolean {
    return this.applyTintObj(node.circle, tint);
  }

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
    } else if (desired === 1 && target.alpha !== 1) {
      // Stable AND meant to be fully visible, but the native renderer dimmed us:
      // Obsidian's focus highlight (active while a node is pinned) fades every
      // node that isn't a direct neighbour of the pinned node down to ~0.2.
      // Without this, kept "trail" nodes (not adjacent to the current pin) would
      // be faded out by the native highlight even though we keep them revealed.
      // Re-assert our own alpha so the revealed subgraph stays visible.
      target.alpha = 1;
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

  /** True if there is a graph edge directly connecting `a` and `b`. */
  private areLinked(a: string, b: string): boolean {
    for (const link of this.adapter.getLinks()) {
      const s = this.endpointId(link.source);
      const t = this.endpointId(link.target);
      if ((s === a && t === b) || (s === b && t === a)) return true;
    }
    return false;
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
