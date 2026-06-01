import type { GraphLink, GraphNode, GraphRenderer } from "./types";

/**
 * `RendererAdapter` encapsulates every access to Obsidian/PIXI's private
 * renderer API. When Obsidian breaks one of these properties or methods (e.g.
 * renames `renderer.nodeLookup`, changes the `changed()` signature, etc.), this
 * file — and only this file — is what needs patching.
 *
 * `RevealManager` and `RendererPatcher` consume the adapter, never the raw
 * renderer directly.
 *
 * All "read" methods return safe values (empty array, `null`, `undefined`)
 * rather than throwing when the API isn't ready — this lets the call chain (the
 * rAF loop in particular) keep running even if a frame catches the object
 * mid-initialization.
 */
export class RendererAdapter {
  constructor(private renderer: GraphRenderer) {}

  // === Read access ===

  getNodes(): GraphNode[] {
    return this.renderer.nodes ?? [];
  }

  getLinks(): GraphLink[] {
    return this.renderer.links ?? [];
  }

  getNode(id: string): GraphNode | undefined {
    return this.renderer.nodeLookup?.[id];
  }

  getHighlightNode(): GraphNode | null {
    return this.renderer.highlightNode ?? null;
  }

  /** The root PIXI stage. Useful to attach a global pointerdown. */
  getStage(): unknown {
    return this.renderer.px?.stage;
  }

  // === Write access (mutations on the renderer) ===

  setHighlightNode(node: GraphNode | null): void {
    this.renderer.highlightNode = node;
  }

  /**
   * Move the renderer's mouse position off-viewport. Used to invalidate the
   * native hit-test after a `clearSelection()`: without it, the renderer may
   * keep treating a node as "under the cursor" even though we just unpinned it.
   */
  resetMousePosition(): void {
    this.renderer.mouseX = -1e9;
    this.renderer.mouseY = -1e9;
  }

  // === Render trigger ===

  /**
   * Lightweight flag: "the scene changed, repaint on the native's next tick".
   * Enough for a one-shot state change (click, pin, clear). Obsidian's renderer
   * will do the PIXI render when it's ready.
   */
  flagChanged(): void {
    if (typeof this.renderer.changed === "function") {
      this.renderer.changed();
    }
  }

  /**
   * Force an immediate PIXI re-render AND flag Obsidian. Heavier than
   * `flagChanged()` since it triggers a draw call. Needed during fades: since
   * Obsidian's PIXI ticker isn't started (`px.ticker.started === false`),
   * without an explicit render per frame the canvas stays frozen on the first
   * alpha tick ("pop" effect).
   */
  forceRender(): void {
    try {
      const px = this.renderer.px;
      if (px?.renderer && px?.stage) px.renderer.render(px.stage);
    } catch {
      /* renderer not ready — silent, we'll retry next frame */
    }
    this.flagChanged();
  }

  /**
   * Raw access to the renderer for the cases that genuinely need to manipulate
   * the object directly (e.g. `RendererPatcher` overriding methods like
   * `onNodeClick` or `getHighlightNode`).
   *
   * Use as little as possible — prefer the typed methods above.
   */
  raw(): GraphRenderer {
    return this.renderer;
  }
}
