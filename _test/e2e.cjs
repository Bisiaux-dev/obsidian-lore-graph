#!/usr/bin/env node
/**
 * Runner e2e — connexion directe à Obsidian via Chrome DevTools Protocol.
 *
 * Obsidian est une app Electron/Chromium : lancée avec
 * `--remote-debugging-port=9222`, elle expose un endpoint CDP auquel on se
 * branche en WebSocket (cf. _test/cdp.cjs). Ici on ajoute des ASSERTIONS et un
 * exit code.
 *
 * Philosophie : on teste le comportement OBSERVABLE du renderer (`renderable`
 * des nodes, vivacité du rAF), pas l'état interne du RevealManager (encapsulé
 * dans des closures). La logique pure est couverte par Vitest (`npm test`),
 * les régressions des bugs de cycle de vie par `npm run test:e2e:regression`.
 *
 * Prérequis :
 *   1. npm run deploy:test                       (pousse le build dans le vault)
 *   2. _test/launch-obsidian.ps1                 (Obsidian en debug + vault test)
 *   3. npm run test:e2e
 *
 * Exit 0 si tout passe (skips inclus), 1 si au moins une assertion échoue.
 */
const { connect, sleep, PORT, isVisible } = require("./cdp.cjs");

const PLUGIN_ID = "lore-graph";

function hiddenWindowError() {
  console.error(
    `\n⚠ Fenêtre Obsidian masquée (visibilityState=hidden).\n` +
      `  Chromium met les requestAnimationFrame en pause → le plugin ne masque\n` +
      `  rien tant que la fenêtre n'est pas au premier plan. Ramène Obsidian\n` +
      `  devant puis relance (launch-obsidian.ps1 le fait au démarrage).\n`,
  );
}

// === Assertions ===
// Chaque check renvoie { status: 'pass'|'fail'|'skip', msg }.

async function checkPluginEnabled(cdp) {
  const info = await cdp.evalJS(`(() => {
    const p = app.plugins.plugins['${PLUGIN_ID}'];
    if (!p) return null;
    return { enabled: !!p.settings?.enabled, hidden: p.settings?.hiddenFolders || [] };
  })()`);
  if (!info) return { status: "fail", msg: "plugin non chargé" };
  if (!info.enabled) return { status: "fail", msg: "plugin chargé mais settings.enabled=false" };
  return { status: "pass", msg: `enabled, hiddenFolders=${JSON.stringify(info.hidden)}` };
}

async function checkGraphView(cdp) {
  let n = await cdp.evalJS(`app.workspace.getLeavesOfType('graph').length`);
  if (n === 0) {
    await cdp.evalJS(`app.commands.executeCommandById('graph:open')`);
    await sleep(1800);
    n = await cdp.evalJS(`app.workspace.getLeavesOfType('graph').length`);
  }
  if (n > 0) return { status: "pass", msg: `${n} graph view(s) ouverte(s)` };
  return { status: "fail", msg: "aucune graph view (échec de graph:open)" };
}

async function checkRafAlive(cdp) {
  const a = await cdp.evalJS(`window.__loreFrames ?? null`);
  if (a === null) return { status: "fail", msg: "window.__loreFrames absent — rAF jamais démarré" };
  await sleep(600);
  const b = await cdp.evalJS(`window.__loreFrames ?? null`);
  if (b > a) return { status: "pass", msg: `rAF vivant (${a} → ${b} frames)` };
  return { status: "fail", msg: `rAF figé (${a} → ${b})` };
}

async function checkHiddenNodesDimmed(cdp) {
  // L'observable fiable est `circle.renderable`, PAS `circle.alpha` : Obsidian
  // remet alpha=1 et visible=true à chaque frame, mais ne touche jamais
  // `renderable`. Le plugin masque les nodes cachés via renderable=false.
  const r = await cdp.evalJS(`(() => {
    const p = app.plugins.plugins['${PLUGIN_ID}'];
    const hidden = (p?.settings?.hiddenFolders || []).map(f => f.endsWith('/') ? f : f + '/');
    const v = app.workspace.getLeavesOfType('graph')[0]?.view;
    const nodes = v?.renderer?.nodes || [];
    const inHidden = (id) => hidden.some(f => id.startsWith(f));
    const hiddenNodes = nodes.filter(n => inHidden(n.id) && n.circle);
    return { count: hiddenNodes.length, rendered: hiddenNodes.filter(n => n.circle.renderable).length };
  })()`);
  if (r.count === 0) {
    return { status: "skip", msg: "aucun node de dossier caché dans le graph (vault de test à peupler)" };
  }
  if (r.rendered === 0) return { status: "pass", msg: `${r.count} nodes cachés, 0 rendu (renderable=false) — masqués au repos` };
  return { status: "fail", msg: `${r.rendered}/${r.count} nodes cachés encore rendus au repos (devraient être masqués)` };
}

async function checkRevealOnClick(cdp) {
  // Cherche un node NON caché ayant un voisin dans un dossier caché, le clique,
  // et vérifie qu'au moins un node caché devient rendu (renderable=true).
  const candidate = await cdp.evalJS(`(() => {
    const p = app.plugins.plugins['${PLUGIN_ID}'];
    const hidden = (p?.settings?.hiddenFolders || []).map(f => f.endsWith('/') ? f : f + '/');
    const inHidden = (id) => hidden.some(f => id.startsWith(f));
    const v = app.workspace.getLeavesOfType('graph')[0]?.view;
    const nodes = v?.renderer?.nodes || [];
    for (const n of nodes) {
      if (inHidden(n.id)) continue;
      const neighbors = Object.assign({}, n.forward, n.reverse);
      const hit = Object.keys(neighbors).find(inHidden);
      if (hit) return { id: n.id, neighbor: hit };
    }
    return null;
  })()`);

  if (!candidate) {
    return { status: "skip", msg: "aucun node visible relié à un node caché (rien à révéler)" };
  }

  // État AVANT : le voisin caché doit être non rendu (renderable=false).
  const before = await cdp.evalJS(`(() => {
    const v = app.workspace.getLeavesOfType('graph')[0].view;
    const n = v.renderer.nodeLookup['${candidate.neighbor}'];
    return n?.circle ? n.circle.renderable : null;
  })()`);

  // Clic synthétique via l'API du renderer (le plugin override onNodeClick ;
  // on l'appelle directement comme le ferait Obsidian).
  await cdp.evalJS(`(() => {
    const r = app.workspace.getLeavesOfType('graph')[0].view.renderer;
    const node = r.nodeLookup['${candidate.id}'] || r.nodes.find(n => n.id === '${candidate.id}');
    r.onNodeClick(null, node.id, 'file');
    return true;
  })()`);
  await sleep(600);

  // État APRÈS : le voisin doit être rendu (renderable=true).
  const after = await cdp.evalJS(`(() => {
    const v = app.workspace.getLeavesOfType('graph')[0].view;
    const n = v.renderer.nodeLookup['${candidate.neighbor}'];
    return n?.circle ? n.circle.renderable : null;
  })()`);

  if (after === null) return { status: "fail", msg: `voisin caché ${candidate.neighbor} introuvable après clic` };
  if (after === true) {
    return { status: "pass", msg: `clic sur ${candidate.id} → voisin ${candidate.neighbor} révélé (renderable ${before}→true)` };
  }
  return { status: "fail", msg: `clic sur ${candidate.id} mais voisin reste masqué (renderable=${after})` };
}

async function main() {
  let cdp;
  try {
    cdp = await connect();
  } catch (e) {
    console.error(`\n✗ Connexion CDP impossible sur le port ${PORT}.`);
    console.error(`  ${e.message}`);
    console.error(`  → Lance Obsidian en debug : powershell -File _test/launch-obsidian.ps1\n`);
    process.exit(1);
  }
  console.log(`[e2e] connecté à : ${cdp.target.title || cdp.target.url}`);

  if (!(await isVisible(cdp))) {
    hiddenWindowError();
    cdp.close();
    process.exit(1);
  }

  // Reload du plugin pour partir d'un état propre (recharge aussi le main.js
  // fraîchement déployé).
  try {
    await cdp.evalJS(`(async () => {
      await app.plugins.disablePlugin('${PLUGIN_ID}');
      await app.plugins.enablePlugin('${PLUGIN_ID}');
      return 'reloaded';
    })()`);
    console.log(`[e2e] plugin rechargé`);
  } catch (e) {
    console.error(`[e2e] échec du reload plugin: ${e.message}`);
  }
  await sleep(1500); // laisse le hook s'attacher (retry à 500ms + premières frames)

  const checks = [
    ["plugin chargé & activé", checkPluginEnabled],
    ["graph view ouverte", checkGraphView],
    ["boucle rAF vivante", checkRafAlive],
    ["nodes cachés masqués au repos", checkHiddenNodesDimmed],
    ["révélation au clic", checkRevealOnClick],
  ];

  let failed = 0;
  let skipped = 0;
  console.log("");
  for (const [name, fn] of checks) {
    let res;
    try {
      res = await fn(cdp);
    } catch (e) {
      res = { status: "fail", msg: `exception: ${e.message}` };
    }
    const icon = res.status === "pass" ? "✓" : res.status === "skip" ? "⊘" : "✗";
    console.log(`  ${icon} ${name} — ${res.msg}`);
    if (res.status === "fail") failed++;
    if (res.status === "skip") skipped++;
  }

  console.log(`\n[e2e] ${checks.length - failed - skipped} pass, ${failed} fail, ${skipped} skip`);
  cdp.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
