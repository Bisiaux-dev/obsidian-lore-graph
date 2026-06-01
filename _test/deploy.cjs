#!/usr/bin/env node
/**
 * Déploie le build courant (main.js + manifest.json + styles.css) dans le
 * dossier plugin du vault de test, pour qu'Obsidian le charge au prochain
 * reload du plugin.
 *
 * Vault cible : $LORE_TEST_VAULT, sinon `../lore-test-vault` (sibling du repo).
 * `data.json` (settings du vault de test) n'est JAMAIS touché.
 *
 * Usage : node _test/deploy.cjs   (ou `npm run deploy:test` qui build d'abord)
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const VAULT =
  process.env.LORE_TEST_VAULT ||
  path.resolve(REPO_ROOT, "..", "lore-test-vault");
const DEST = path.join(VAULT, ".obsidian", "plugins", "lore-graph");
const FILES = ["main.js", "manifest.json", "styles.css"];

if (!fs.existsSync(VAULT)) {
  console.error(`[deploy] vault introuvable: ${VAULT}`);
  console.error(`[deploy] définis LORE_TEST_VAULT pour pointer ailleurs.`);
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });

for (const f of FILES) {
  const src = path.join(REPO_ROOT, f);
  if (!fs.existsSync(src)) {
    console.error(`[deploy] manquant: ${src} — as-tu lancé le build ?`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(DEST, f));
  console.log(`[deploy] ${f} → ${path.join(DEST, f)}`);
}
console.log(`[deploy] OK. Recharge le plugin dans Obsidian (ou lance npm run test:e2e qui le fait).`);
