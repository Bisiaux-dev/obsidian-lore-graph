import { describe, it, expect } from "vitest";
import { RevealManager } from "../src/revealManager";

/**
 * Breadcrumb semantics of keepTrail, driven through the real entry point
 * (handleMainClick → handleClick → applyReveal). The graph:
 *
 *   projects/p (visible hub) → j1, j2
 *   j1 → j1a
 *   j1a → j1a1
 *
 * keepTrail ON  → the CLICKED path stays; unclicked siblings fade.
 * keepTrail OFF → only the current node + its children (no path memory).
 */
function setup(keepTrail: boolean) {
  const nodes: Record<string, any> = {};
  const ensure = (id: string) => (nodes[id] ||= { id, circle: {}, text: {} });
  ["projects/p.md", "journal/j1.md", "journal/j2.md", "journal/j1a.md", "journal/j1a1.md", "topics/ever.md"].forEach(ensure);
  const edges: Array<[string, string]> = [
    ["projects/p.md", "journal/j1.md"],
    ["projects/p.md", "journal/j2.md"],
    ["journal/j1.md", "journal/j1a.md"],
    ["journal/j1a.md", "journal/j1a1.md"],
    ["journal/j1a.md", "topics/ever.md"], // an always-visible neighbour of j1a
  ];
  const adapter = {
    getNode: (id: string) => nodes[id] ?? null,
    getNodes: () => Object.values(nodes),
    getLinks: () => edges.map(([source, target]) => ({ source, target })),
    flagChanged: () => {}, forceRender: () => {},
    setHighlightNode: () => {}, resetMousePosition: () => {},
  };
  const plugin = { settings: { hiddenFolders: ["journal/"], enabled: true, maxNodes: 20, keepTrail } };
  const mgr = new RevealManager(plugin as any, adapter as any) as any;
  const links: Record<string, string[]> = {
    "projects/p.md": ["journal/j1.md", "journal/j2.md"],
    "journal/j1.md": ["journal/j1a.md"],
    "journal/j1a.md": ["journal/j1a1.md"],
  };
  mgr.getHiddenLinks = (id: string) => links[id] ?? [];
  const revealed = () => [...mgr.currentlyRevealed].map((x: string) => x.replace("journal/", "").replace(".md", ""));
  return { mgr, revealed };
}

describe("keepTrail breadcrumb — click sequence", () => {
  it("ON: keeps the whole clicked path, drops unclicked siblings", () => {
    const { mgr, revealed } = setup(true);
    mgr.handleMainClick("projects/p.md", 0, 0);
    expect(revealed().sort()).toEqual(["j1", "j2"]); // candidates of hub
    mgr.handleMainClick("journal/j1.md", 0, 0);
    expect(revealed().sort()).toEqual(["j1", "j1a"]); // j2 (unclicked sibling) gone
    mgr.handleMainClick("journal/j1a.md", 0, 0);
    // path j1 → j1a kept, j1a1 is the new candidate; j2 never comes back
    expect(revealed().sort()).toEqual(["j1", "j1a", "j1a1"]);
  });

  it("OFF: keeps only the current node + its children (no path)", () => {
    const { mgr, revealed } = setup(false);
    mgr.handleMainClick("projects/p.md", 0, 0);
    mgr.handleMainClick("journal/j1.md", 0, 0);
    expect(revealed().sort()).toEqual(["j1", "j1a"]);
    mgr.handleMainClick("journal/j1a.md", 0, 0);
    // j1 dropped (no trail) — only the current node j1a + its child j1a1
    expect(revealed().sort()).toEqual(["j1a", "j1a1"]);
  });

  it("ON: clicking a linked always-visible node EXTENDS the path (doesn't reset)", () => {
    const { mgr } = setup(true);
    mgr.handleMainClick("projects/p.md", 0, 0);
    mgr.handleMainClick("journal/j1.md", 0, 0);
    mgr.handleMainClick("journal/j1a.md", 0, 0);
    // topics/ever is a base (always-visible) neighbour of the current node j1a.
    mgr.handleMainClick("topics/ever.md", 0, 0);
    // The breadcrumb is preserved and extended through the evergreen node.
    expect(mgr.pathNodes).toEqual([
      "projects/p.md",
      "journal/j1.md",
      "journal/j1a.md",
      "topics/ever.md",
    ]);
  });

  it("ON: re-clicking a path node truncates the breadcrumb (walk back up)", () => {
    const { mgr, revealed } = setup(true);
    mgr.handleMainClick("projects/p.md", 0, 0);
    mgr.handleMainClick("journal/j1.md", 0, 0);
    mgr.handleMainClick("journal/j1a.md", 0, 0);
    expect(revealed().sort()).toEqual(["j1", "j1a", "j1a1"]);
    mgr.handleMainClick("journal/j1.md", 0, 0); // back up to j1
    expect(mgr.pathNodes).toEqual(["projects/p.md", "journal/j1.md"]);
    expect(revealed().sort()).toEqual(["j1", "j1a"]); // j1a1 dropped
  });
});
