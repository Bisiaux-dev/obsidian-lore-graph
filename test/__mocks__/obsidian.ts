/**
 * Minimal stub of the `obsidian` module for unit tests.
 *
 * Obsidian doesn't expose a requirable implementation (the module is provided
 * at runtime by the app — see `external: ["obsidian"]` in esbuild). So we mock
 * ONLY the symbols actually imported by the code under test, with just enough
 * surface for `instanceof` and the constructions to work.
 *
 * When a test needs precise Obsidian behavior (e.g. metadataCache), pass a fake
 * `app`/`plugin` object to the constructor rather than enriching this stub — it
 * should stay a simple satisfy-the-imports shim.
 */

export class TFile {
  path = "";
  name = "";
}

export class TFolder {
  path = "";
  name = "";
  children: unknown[] = [];
}

export class TAbstractFile {
  path = "";
  name = "";
}

export class Plugin {
  app: unknown;
  constructor(app?: unknown) {
    this.app = app;
  }
  addSettingTab(): void {}
  registerEvent(): void {}
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(): Promise<void> {}
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: unknown;
  constructor(app?: unknown, plugin?: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class Setting {
  constructor(_containerEl?: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addSlider(): this {
    return this;
  }
}

export class App {}

export class Notice {
  constructor(_message?: string) {}
}
