// Partial type declarations for Obsidian's undocumented Graph View internals.
// These shapes are inferred from runtime inspection of Obsidian 1.5.x — they
// are NOT part of the official Obsidian API and could change between
// versions. The interfaces only cover the props/methods the plugin actually
// touches: extending them when we observe a new field is preferred over
// chasing complete coverage.

/**
 * Minimal surface of a PIXI display object (Graphics/Text) as the plugin
 * manipulates it. PIXI doesn't export its types via Obsidian, but listing the
 * touched members explicitly beats `any`: a typo (`aplha`) or a nonexistent
 * member is now caught at compile time.
 */
export interface PixiObject {
  alpha: number;
  visible: boolean;
  renderable: boolean;
  eventMode?: string;
  interactive?: boolean;
  scale?: { x: number; y: number };
  on(event: string, fn: (...args: unknown[]) => void): void;
  off(event: string, fn: (...args: unknown[]) => void): void;
}

/** A node in the graph (file or tag). Comes from `renderer.nodes`. */
export interface GraphNode {
  id: string;
  x: number;
  y: number;
  /** PIXI.Graphics (the node's circle). */
  circle?: PixiObject;
  /** PIXI.Text (the node's label). */
  text?: PixiObject;
  /** Adjacency : `forward[neighborId]` truthy iff this node links TO neighborId. */
  forward?: Record<string, unknown>;
  /** Adjacency : `reverse[neighborId]` truthy iff neighborId links TO this node. */
  reverse?: Record<string, unknown>;
}

/** An edge between two nodes. Comes from `renderer.links`. */
export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  /** PIXI.Graphics representing the line. */
  line?: PixiObject;
  /** PIXI.Graphics for the link's midpoint / control point handle. */
  px?: PixiObject;
  /** PIXI.Graphics for the directional arrow head. */
  arrow?: PixiObject;
}

/**
 * The renderer attached to a Graph view leaf. Lives at `leaf.view.renderer`.
 * Exposes a mix of state mutations and lifecycle hooks the plugin overrides.
 */
export interface GraphRenderer {
  nodes: GraphNode[];
  links: GraphLink[];
  nodeLookup: Record<string, GraphNode>;
  highlightNode: GraphNode | null;
  mouseX: number;
  mouseY: number;
  onNodeClick: (e: MouseEvent | null, id: string, type: string) => void;
  getHighlightNode(): GraphNode | null;
  /** Flags Obsidian's render loop that the scene needs to be repainted. */
  changed(): void;
  /** PIXI application root (stage + WebGL renderer). */
  px?: {
    stage: any;
    renderer: { render(stage: any): void };
  };
}

/** A Graph view leaf. `leaf.view` in Obsidian terms. */
export interface GraphView {
  renderer: GraphRenderer;
  containerEl: HTMLElement;
}
