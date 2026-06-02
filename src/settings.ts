import { App, PluginSettingTab, Setting } from "obsidian";
import type LoreGraphPlugin from "../main";
import { t } from "./i18n";

/**
 * Bump on every breaking change to the `LoreGraphSettings` shape.
 * `coerceSettings()` keeps only the keys present in the current settings when
 * the stored `version` doesn't match — cleanly dropping removed legacy fields
 * (e.g. nodeSize, edgeStyle, cascadeReveal in v2).
 *
 * v2: removed nodeSize, edgeStyle, cascadeReveal — leftovers of the old "we
 * draw our own circles/edges" approach, dropped at the pivot to "physical
 * presence" where Obsidian renders the revealed nodes natively.
 */
export const SETTINGS_VERSION = 2;

export interface LoreGraphSettings {
  version: number;
  enabled: boolean;
  hiddenFolders: string[];
  maxNodes: number;
  /**
   * When true, a cascade reveal (deep search) keeps the previously revealed
   * nodes on screen instead of replacing them — so the path from the initial
   * node stays visible. When false (default), each cascade step replaces the
   * previous reveal.
   */
  keepTrail: boolean;
}

export const DEFAULT_SETTINGS: LoreGraphSettings = {
  version: SETTINGS_VERSION,
  enabled: true,
  hiddenFolders: ["journal/"],
  maxNodes: 20,
  keepTrail: false,
};

/** Bounds of the `maxNodes` slider (see settings tab). */
export const MAX_NODES_MIN = 1;
export const MAX_NODES_MAX = 50;

/**
 * Produces VALID settings from raw data (`data.json`) that may be null,
 * partial, from an older version, or corrupted (wrong type, hand edit). Each
 * field is validated/coerced and falls back to the default if invalid;
 * `maxNodes` is clamped to [MIN, MAX]. Unknown keys (removed legacy fields)
 * are dropped.
 *
 * `migrated` tells the caller whether it should re-persist (stale version or
 * missing data) — avoiding a needless write on every load.
 */
export function coerceSettings(raw: unknown): {
  settings: LoreGraphSettings;
  migrated: boolean;
} {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;

  const enabled =
    typeof obj?.enabled === "boolean" ? obj.enabled : DEFAULT_SETTINGS.enabled;

  const rawFolders = obj && Array.isArray(obj.hiddenFolders) ? obj.hiddenFolders : null;
  const hiddenFolders = rawFolders
    ? (rawFolders as unknown[]).filter((f): f is string => typeof f === "string")
    : [...DEFAULT_SETTINGS.hiddenFolders];

  let maxNodes = DEFAULT_SETTINGS.maxNodes;
  if (typeof obj?.maxNodes === "number" && Number.isFinite(obj.maxNodes)) {
    maxNodes = Math.round(
      Math.min(MAX_NODES_MAX, Math.max(MAX_NODES_MIN, obj.maxNodes)),
    );
  }

  const keepTrail =
    typeof obj?.keepTrail === "boolean"
      ? obj.keepTrail
      : DEFAULT_SETTINGS.keepTrail;

  const settings: LoreGraphSettings = {
    version: SETTINGS_VERSION,
    enabled,
    hiddenFolders,
    maxNodes,
    keepTrail,
  };
  const migrated = !obj || obj.version !== SETTINGS_VERSION;
  return { settings, migrated };
}

export class LoreGraphSettingTab extends PluginSettingTab {
  plugin: LoreGraphPlugin;

  constructor(app: App, plugin: LoreGraphPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text: t.pluginDescription,
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName(t.enableName)
      .setDesc(t.enableDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.refresh();
        }),
      );

    // Hidden folders — dynamic list
    this.renderHiddenFoldersSection(containerEl);

    new Setting(containerEl)
      .setName(t.maxNodesName)
      .setDesc(t.maxNodesDesc)
      .addSlider((slider) =>
        slider
          .setLimits(1, 50, 1)
          .setValue(this.plugin.settings.maxNodes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxNodes = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t.keepTrailName)
      .setDesc(t.keepTrailDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.keepTrail).onChange(async (v) => {
          this.plugin.settings.keepTrail = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderHiddenFoldersSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t.hiddenFoldersName).setDesc(t.hiddenFoldersDesc);

    // Wrapper for the dynamic list
    const listEl = containerEl.createDiv({ cls: "lore-graph-folder-list" });

    const renderList = () => {
      listEl.empty();
      this.plugin.settings.hiddenFolders.forEach((folder, idx) => {
        const row = listEl.createDiv({ cls: "lore-graph-folder-row" });
        const input = row.createEl("input", {
          type: "text",
          value: folder,
        });
        input.addEventListener("change", async () => {
          this.plugin.settings.hiddenFolders[idx] = input.value;
          await this.plugin.saveSettings();
          this.plugin.refresh();
        });
        const removeBtn = row.createEl("button", {
          text: "×",
          cls: "lore-graph-remove-btn",
        });
        removeBtn.title = t.removeFolderTooltip;
        removeBtn.addEventListener("click", async () => {
          this.plugin.settings.hiddenFolders.splice(idx, 1);
          await this.plugin.saveSettings();
          renderList();
          this.plugin.refresh();
        });
      });

      const addBtn = listEl.createEl("button", {
        text: t.addFolderButton,
        cls: "lore-graph-add-btn",
      });
      addBtn.addEventListener("click", async () => {
        this.plugin.settings.hiddenFolders.push(t.newFolderPlaceholder);
        await this.plugin.saveSettings();
        renderList();
        this.plugin.refresh();
      });
    };

    renderList();
  }
}
