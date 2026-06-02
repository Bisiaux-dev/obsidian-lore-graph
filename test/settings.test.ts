import { describe, it, expect } from "vitest";
import {
  coerceSettings,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  MAX_NODES_MIN,
  MAX_NODES_MAX,
} from "../src/settings";

const cur = SETTINGS_VERSION;

describe("coerceSettings", () => {
  it("null → defaults, migrated=true", () => {
    const { settings, migrated } = coerceSettings(null);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(migrated).toBe(true);
  });

  it("primitive (string) → defaults, migrated=true", () => {
    const { settings, migrated } = coerceSettings("garbage");
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(migrated).toBe(true);
  });

  it("valid data at the current version → unchanged, migrated=false", () => {
    const raw = {
      version: cur,
      enabled: false,
      hiddenFolders: ["a/", "b/"],
      maxNodes: 10,
      keepTrail: true,
    };
    const { settings, migrated } = coerceSettings(raw);
    expect(settings).toEqual(raw);
    expect(migrated).toBe(false);
  });

  it("keepTrail: defaults to false when absent", () => {
    expect(coerceSettings({ version: cur }).settings.keepTrail).toBe(
      DEFAULT_SETTINGS.keepTrail,
    );
  });

  it("keepTrail: honored when a boolean", () => {
    expect(coerceSettings({ version: cur, keepTrail: true }).settings.keepTrail).toBe(
      true,
    );
  });

  it("keepTrail: non-boolean → default", () => {
    expect(coerceSettings({ version: cur, keepTrail: "yes" }).settings.keepTrail).toBe(
      DEFAULT_SETTINGS.keepTrail,
    );
  });

  it("stale version → migrated=true and unknown keys dropped", () => {
    const raw = {
      version: 1,
      enabled: true,
      hiddenFolders: ["x/"],
      maxNodes: 5,
      nodeSize: 7, // removed legacy field
      edgeStyle: "dashed", // removed legacy field
    };
    const { settings, migrated } = coerceSettings(raw);
    expect(migrated).toBe(true);
    expect(settings.version).toBe(cur);
    expect(settings.maxNodes).toBe(5);
    expect(settings).not.toHaveProperty("nodeSize");
    expect(settings).not.toHaveProperty("edgeStyle");
  });

  it("non-boolean enabled → default", () => {
    expect(coerceSettings({ version: cur, enabled: "yes" }).settings.enabled).toBe(
      DEFAULT_SETTINGS.enabled,
    );
  });

  it("non-array hiddenFolders → default", () => {
    expect(
      coerceSettings({ version: cur, hiddenFolders: "journal/" }).settings.hiddenFolders,
    ).toEqual(DEFAULT_SETTINGS.hiddenFolders);
  });

  it("hiddenFolders: filters out non-string entries", () => {
    expect(
      coerceSettings({ version: cur, hiddenFolders: ["ok/", 42, null, "good/"] })
        .settings.hiddenFolders,
    ).toEqual(["ok/", "good/"]);
  });

  it("out-of-range maxNodes → clamped", () => {
    expect(coerceSettings({ version: cur, maxNodes: 9999 }).settings.maxNodes).toBe(
      MAX_NODES_MAX,
    );
    expect(coerceSettings({ version: cur, maxNodes: -5 }).settings.maxNodes).toBe(
      MAX_NODES_MIN,
    );
  });

  it("non-numeric or NaN maxNodes → default", () => {
    expect(coerceSettings({ version: cur, maxNodes: "abc" }).settings.maxNodes).toBe(
      DEFAULT_SETTINGS.maxNodes,
    );
    expect(coerceSettings({ version: cur, maxNodes: NaN }).settings.maxNodes).toBe(
      DEFAULT_SETTINGS.maxNodes,
    );
  });

  it("float maxNodes → rounded and clamped", () => {
    expect(coerceSettings({ version: cur, maxNodes: 12.7 }).settings.maxNodes).toBe(13);
  });
});
