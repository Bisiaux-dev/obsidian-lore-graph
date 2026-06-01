import { Plugin } from "obsidian";
import {
  LoreGraphSettings,
  LoreGraphSettingTab,
  coerceSettings,
} from "./src/settings";
import { GraphHook } from "./src/graphHook";
import { debug } from "./src/log";

export default class LoreGraphPlugin extends Plugin {
  settings!: LoreGraphSettings;
  private hook?: GraphHook;

  async onload() {
    debug("loading");
    await this.loadSettings();

    this.addSettingTab(new LoreGraphSettingTab(this.app, this));

    this.hook = new GraphHook(this);
    this.hook.start();
  }

  onunload() {
    debug("unloading");
    this.hook?.stop();
  }

  async loadSettings() {
    // `coerceSettings` validates/coerces every field (data.json may be null,
    // from an older version, or corrupted) and drops unknown keys.
    const { settings, migrated } = coerceSettings(await this.loadData());
    this.settings = settings;
    if (migrated) await this.saveSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Force a recompute of hidden-node visibility on all active graph views. */
  refresh() {
    this.hook?.refresh();
  }
}
