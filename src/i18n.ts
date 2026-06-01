/**
 * Minimal i18n module — detects Obsidian's language via `window.i18next`
 * (which Obsidian initializes at startup) and exposes a static strings object.
 *
 * The static lookup (`t.enableName`) rather than a `t("enableName")` function
 * is deliberate: the TS compiler catches keys that don't exist in the catalog
 * → impossible to forget a string when adding a setting.
 *
 * The language is frozen at load — Obsidian requires a restart to change
 * language, so we don't need reactivity.
 */
type Lang = "en" | "fr";

interface Strings {
  enableName: string;
  enableDesc: string;
  hiddenFoldersName: string;
  hiddenFoldersDesc: string;
  maxNodesName: string;
  maxNodesDesc: string;
  addFolderButton: string;
  removeFolderTooltip: string;
  newFolderPlaceholder: string;
  pluginDescription: string;
}

const catalog: Record<Lang, Strings> = {
  en: {
    enableName: "Enable feature",
    enableDesc:
      "Hide nodes from configured folders and reveal them on demand when clicking a related node.",
    hiddenFoldersName: "Hidden folders",
    hiddenFoldersDesc:
      "Folders hidden from the main graph. Their content will be revealed on demand when clicking a related node.",
    maxNodesName: "Max nodes shown",
    maxNodesDesc:
      "Hard cap on the number of nodes revealed per click. If a node has more hidden links than this limit, the extras are not shown (priority follows the metadataCache order).",
    addFolderButton: "+ Add folder",
    removeFolderTooltip: "Remove this folder",
    newFolderPlaceholder: "new-folder/",
    pluginDescription:
      "Hide whole folders from the graph view and reveal their content on demand by clicking a related node (cascade reveal).",
  },
  fr: {
    enableName: "Activer la feature",
    enableDesc:
      "Cache les nodes des dossiers configurés et les révèle à la demande au clic sur un node lié.",
    hiddenFoldersName: "Dossiers cachés",
    hiddenFoldersDesc:
      "Dossiers cachés du graph principal. Leur contenu sera révélé à la demande au clic sur un node lié.",
    maxNodesName: "Nombre max de nodes affichés",
    maxNodesDesc:
      "Cap dur sur le nombre de nodes révélés par clic. Si un node a plus de liens cachés que cette limite, les liens supplémentaires ne sont pas affichés (priorité à l'ordre des liens dans le metadataCache).",
    addFolderButton: "+ Ajouter un dossier",
    removeFolderTooltip: "Retirer ce dossier",
    newFolderPlaceholder: "nouveau-dossier/",
    pluginDescription:
      "Cache des dossiers entiers du graph view et affiche leur contenu à la demande au clic sur un node lié (cascade reveal).",
  },
};

function detectLang(): Lang {
  // Obsidian exposes `window.i18next` (an i18next instance) with `.language`.
  // Fallback: `navigator.language` if that private API ever disappears.
  // The `typeof` guards avoid a crash outside a browser (node tests, etc.).
  const win =
    typeof window !== "undefined"
      ? (window as typeof window & { i18next?: { language?: string } })
      : undefined;
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  const raw = (win?.i18next?.language || nav || "en").toLowerCase();
  if (raw.startsWith("fr")) return "fr";
  return "en";
}

export const t: Strings = catalog[detectLang()];
