import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RendererPatcher } from "../src/rendererPatcher";

/**
 * Regression of the rAF lifecycle bugs (audit #1 multi-view, #2 detach) at the
 * patcher level — without Obsidian. We drive `requestAnimationFrame` manually
 * and simulate the generation that `GraphHook` sets on `window`.
 *
 * The full behavior (real masking, orphan loops) stays verified e2e by
 * `npm run test:e2e:regression`; these are the fast CI safety net.
 */
let rafQueue: Array<(t: number) => void> = [];
const orig = {
  window: (globalThis as any).window,
  raf: (globalThis as any).requestAnimationFrame,
  caf: (globalThis as any).cancelAnimationFrame,
};

beforeEach(() => {
  rafQueue = [];
  (globalThis as any).window = {};
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  (globalThis as any).cancelAnimationFrame = () => {};
});

afterEach(() => {
  (globalThis as any).window = orig.window;
  (globalThis as any).requestAnimationFrame = orig.raf;
  (globalThis as any).cancelAnimationFrame = orig.caf;
});

/** Advance n frames: each pending rAF runs and re-registers itself. */
function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb(0);
  }
}

function setGeneration(gen: number): void {
  (globalThis as any).window.__loreRafGeneration = gen;
}

function fakeAdapter(): any {
  const renderer = { onNodeClick: () => {}, getHighlightNode: () => null };
  return {
    raw: () => renderer,
    getStage: () => ({ on() {}, off() {} }),
    getNodes: () => [],
    getHighlightNode: () => null,
  };
}

function fakeMgr() {
  return {
    applyBaseVisibility: vi.fn(),
    handleMainClick: vi.fn(),
    getPinnedNode: () => null,
    handleHover: vi.fn(),
    handleHoverEnd: vi.fn(),
    clearSelection: vi.fn(),
    invalidateSettingsCache: vi.fn(),
    unload: vi.fn(),
  };
}

function attach(generation: number, mgr: any): RendererPatcher {
  const p = new RendererPatcher();
  p.attach({ view: {} as any, adapter: fakeAdapter(), mgr, generation });
  return p;
}

describe("RendererPatcher — generation-based anti-ghost", () => {
  it("multi-view: two patchers of the same generation both run (regression #1)", () => {
    setGeneration(1);
    const a = fakeMgr();
    const b = fakeMgr();
    attach(1, a);
    attach(1, b);
    frames(5);
    // Before the fix (global per-loop token), the 2nd attach killed the 1st loop.
    expect(a.applyBaseVisibility.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(b.applyBaseVisibility.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("a stale-generation loop terminates itself when the generation is bumped (reload)", () => {
    setGeneration(1);
    const old = fakeMgr();
    attach(1, old);
    frames(2);
    const before = old.applyBaseVisibility.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);

    setGeneration(2); // GraphHook.start() of a new load
    frames(3);
    expect(old.applyBaseVisibility.mock.calls.length).toBe(before); // frozen

    const fresh = fakeMgr();
    attach(2, fresh);
    frames(3);
    expect(fresh.applyBaseVisibility.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("detach() stops the loop (regression #2, patcher level)", () => {
    setGeneration(1);
    const mgr = fakeMgr();
    const p = attach(1, mgr);
    frames(2);
    const before = mgr.applyBaseVisibility.mock.calls.length;
    p.detach();
    frames(3);
    expect(mgr.applyBaseVisibility.mock.calls.length).toBe(before);
  });
});

describe("RendererPatcher — onNodeClick (#7)", () => {
  function clickAdapter(native: () => void): any {
    const renderer = { onNodeClick: native, getHighlightNode: () => null };
    return {
      raw: () => renderer,
      getStage: () => ({ on() {}, off() {} }),
      getNodes: () => [],
      getNode: () => ({ id: "n1", x: 0, y: 0 }),
      getHighlightNode: () => null,
      _renderer: renderer,
    };
  }

  it("falls back to the native handler when the plugin handler throws", () => {
    setGeneration(1);
    const native = vi.fn();
    const adapter = clickAdapter(native);
    const mgr = fakeMgr();
    mgr.handleMainClick = vi.fn(() => {
      throw new Error("boom");
    });
    new RendererPatcher().attach({ view: {} as any, adapter, mgr, generation: 1 });
    adapter._renderer.onNodeClick(null, "n1", "file"); // the installed override
    expect(mgr.handleMainClick).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith(null, "n1", "file");
  });

  it("does NOT call native when the plugin handler succeeds", () => {
    setGeneration(1);
    const native = vi.fn();
    const adapter = clickAdapter(native);
    const mgr = fakeMgr();
    new RendererPatcher().attach({ view: {} as any, adapter, mgr, generation: 1 });
    adapter._renderer.onNodeClick(null, "n1", "file");
    expect(mgr.handleMainClick).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
  });
});
