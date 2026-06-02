import { describe, it, expect } from "vitest";
import { RevealManager } from "../src/revealManager";

/**
 * These tests target the PURE logic of RevealManager — not PIXI rendering or
 * Obsidian state. We instantiate the manager with a fake plugin/adapter and
 * call the methods via an `as any` cast: they're private, but they are the
 * easiest deterministic building blocks to lock down (see audit #11).
 *
 * NB: testing private methods couples the tests to the implementation. If these
 * helpers are ever extracted into a pure module (recommended refactor), these
 * tests would point at the module instead of a cast.
 */
function makeManager(hiddenFolders: string[]): any {
  const plugin = {
    settings: { hiddenFolders, enabled: true, maxNodes: 20 },
  };
  return new RevealManager(plugin as any, {} as any) as any;
}

describe("isInHiddenFolder", () => {
  it("matches a file under a hidden folder", () => {
    const mgr = makeManager(["journal/"]);
    expect(mgr.isInHiddenFolder("journal/2024-01-01.md")).toBe(true);
  });

  it("does not match a file outside the hidden folders", () => {
    const mgr = makeManager(["journal/"]);
    expect(mgr.isInHiddenFolder("notes/idea.md")).toBe(false);
  });

  it("normalizes the trailing slash: 'journal' covers 'journal/...'", () => {
    const mgr = makeManager(["journal"]);
    expect(mgr.isInHiddenFolder("journal/2024.md")).toBe(true);
  });

  it("does not confuse 'journal/' with a 'journalism/' prefix", () => {
    const mgr = makeManager(["journal/"]);
    expect(mgr.isInHiddenFolder("journalism/post.md")).toBe(false);
  });

  it("returns false on an empty path", () => {
    const mgr = makeManager(["journal/"]);
    expect(mgr.isInHiddenFolder("")).toBe(false);
  });

  it("ignores empty folder entries in the list", () => {
    const mgr = makeManager(["", "journal/"]);
    expect(mgr.isInHiddenFolder("journal/x.md")).toBe(true);
    expect(mgr.isInHiddenFolder("other/x.md")).toBe(false);
  });

  it("supports multiple hidden folders", () => {
    const mgr = makeManager(["journal/", "inbox/"]);
    expect(mgr.isInHiddenFolder("inbox/note.md")).toBe(true);
    expect(mgr.isInHiddenFolder("journal/note.md")).toBe(true);
  });
});

describe("endpointId", () => {
  const mgr = makeManager([]);

  it("returns the string as-is", () => {
    expect(mgr.endpointId("foo/bar.md")).toBe("foo/bar.md");
  });

  it("extracts the id from a node object", () => {
    expect(mgr.endpointId({ id: "node-1" })).toBe("node-1");
  });

  it("returns '' for undefined", () => {
    expect(mgr.endpointId(undefined)).toBe("");
  });

  it("returns '' for an object without id", () => {
    expect(mgr.endpointId({})).toBe("");
  });
});

describe("lerpAlpha (time-based exponential fade)", () => {
  const mgr = makeManager([]);

  it("covers 50% of the distance after one half-life (dt = 44ms)", () => {
    // factor = 1 - 0.5^(44/44) = 0.5  →  0 + (1-0)*0.5 = 0.5
    expect(mgr.lerpAlpha(0, 1, 44)).toBeCloseTo(0.5, 6);
  });

  it("covers 75% after two half-lives (dt = 88ms)", () => {
    // factor = 1 - 0.5^2 = 0.75
    expect(mgr.lerpAlpha(0, 1, 88)).toBeCloseTo(0.75, 6);
  });

  it("snaps straight to the target below HIDE_THRESHOLD", () => {
    // |1 - 0.999| = 0.001 < 0.005  →  returns exactly the target
    expect(mgr.lerpAlpha(0.999, 1, 16.67)).toBe(1);
  });

  it("does not move when current == target", () => {
    expect(mgr.lerpAlpha(0.5, 0.5, 16.67)).toBe(0.5);
  });

  it("progresses strictly toward the target (in)", () => {
    const next = mgr.lerpAlpha(0, 1, 16.67);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(1);
  });

  it("progresses strictly toward the target (out)", () => {
    const next = mgr.lerpAlpha(1, 0, 16.67);
    expect(next).toBeLessThan(1);
    expect(next).toBeGreaterThan(0);
  });
});

describe("applyAlpha — resists native dimming of kept nodes", () => {
  it("re-asserts alpha to 1 when a stable-visible node was dimmed by the native highlight", () => {
    const mgr = makeManager([]);
    const target: any = { alpha: 0.2 }; // native focus-highlight dimmed it
    mgr.myAlpha.set(target, 1); // our state: fully visible and stable
    const changed = mgr.applyAlpha(target, true, false, false, 16.67);
    expect(target.alpha).toBe(1);
    expect(changed).toBe(true);
  });

  it("leaves a stable-visible node already at full alpha untouched", () => {
    const mgr = makeManager([]);
    // visible/renderable already in sync so only the alpha branch could flip `changed`.
    const target: any = { alpha: 1, visible: true, renderable: true };
    mgr.myAlpha.set(target, 1);
    const changed = mgr.applyAlpha(target, true, false, false, 16.67);
    expect(target.alpha).toBe(1);
    expect(changed).toBe(false);
  });

  it("does NOT force alpha on a stable-hidden node (desired 0)", () => {
    const mgr = makeManager([]);
    const target: any = { alpha: 0.2 };
    mgr.myAlpha.set(target, 0);
    mgr.applyAlpha(target, false, false, false, 16.67);
    expect(target.alpha).toBe(0.2); // untouched
  });
});
