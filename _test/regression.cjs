#!/usr/bin/env node
/**
 * Tests de RÉGRESSION e2e pour les bugs de cycle de vie corrigés dans le
 * "lot 1" de l'audit. Chaque check reproduit un bug précis ; il doit ÉCHOUER
 * sur le code bogué et PASSER après correction.
 *
 *   #1 multi-view  — le rAF token global tuait toutes les boucles sauf la
 *                    dernière → la 1ʳᵉ graph view ne masquait plus ses nodes.
 *   #2 detach      — fermer une graph view ne détachait jamais le binding →
 *                    boucle rAF orpheline qui tourne sur un renderer mort.
 *
 * Prérequis : Obsidian en debug (port 9222) sur le vault de test peuplé.
 *   npm run test:e2e:regression
 *
 * Exit 0 si tout passe, 1 sinon.
 */
const { connect, sleep, PORT, isVisible } = require("./cdp.cjs");

const PLUGIN_ID = "lore-graph";

async function reloadPlugin(cdp) {
  await cdp.evalJS(`(async () => {
    await app.plugins.disablePlugin('${PLUGIN_ID}');
    await app.plugins.enablePlugin('${PLUGIN_ID}');
    return true;
  })()`);
  await sleep(1500);
}

async function ensureOneGraphView(cdp) {
  const n = await cdp.evalJS(`app.workspace.getLeavesOfType('graph').length`);
  if (n === 0) {
    await cdp.evalJS(`app.commands.executeCommandById('graph:open')`);
    await sleep(1500);
  }
}

/**
 * RÉGRESSION #1 — multi-view.
 * Ouvre une 2ᵉ graph view, recharge le plugin (les deux s'attachent), puis
 * vérifie que CHAQUE view masque ses nodes cachés (renderable=false).
 * Bug : seule la dernière boucle rAF survivait → la 1ʳᵉ view gardait ses
 * nodes cachés rendus (alpha jamais fondu jusqu'au seuil).
 */
async function checkMultiView(cdp) {
  await ensureOneGraphView(cdp);
  // 2ᵉ graph view dans un split.
  await cdp.evalJS(`(async () => {
    const leaf = app.workspace.getLeaf('split');
    await leaf.setViewState({ type: 'graph', active: true });
    return true;
  })()`);
  await sleep(500);
  await reloadPlugin(cdp); // les deux views s'attachent dans le même load
  await sleep(1200); // laisse les fades atteindre le seuil de masquage

  const perView = await cdp.evalJS(`(() => {
    const p = app.plugins.plugins['${PLUGIN_ID}'];
    const hidden = (p?.settings?.hiddenFolders || []).map(f => f.endsWith('/') ? f : f + '/');
    const inHidden = (id) => hidden.some(f => id.startsWith(f));
    return app.workspace.getLeavesOfType('graph').map((leaf, i) => {
      const nodes = leaf.view?.renderer?.nodes || [];
      const hiddenNodes = nodes.filter(n => inHidden(n.id) && n.circle);
      return { view: i, hidden: hiddenNodes.length, rendered: hiddenNodes.filter(n => n.circle.renderable).length };
    });
  })()`);

  // Nettoyage : referme la view en trop.
  await cdp.evalJS(`(() => {
    const ls = app.workspace.getLeavesOfType('graph');
    if (ls.length > 1) ls[ls.length - 1].detach();
    return true;
  })()`);

  const withHidden = perView.filter((v) => v.hidden > 0);
  if (withHidden.length < 2) {
    return { status: "skip", msg: `besoin de 2 views avec nodes cachés, obtenu ${withHidden.length} (vault à peupler)` };
  }
  const broken = withHidden.filter((v) => v.rendered > 0);
  if (broken.length === 0) {
    return { status: "pass", msg: `les ${withHidden.length} views masquent (` + perView.map((v) => `v${v.view}:${v.rendered}/${v.hidden}`).join(", ") + ")" };
  }
  return { status: "fail", msg: `view(s) ne masquant pas : ` + broken.map((v) => `v${v.view} ${v.rendered}/${v.hidden} rendus`).join(", ") };
}

/**
 * RÉGRESSION #2 — boucle orpheline après fermeture.
 * Ferme TOUTES les graph views et vérifie que le compteur de frames rAF
 * (`window.__loreFrames`) cesse d'augmenter — preuve qu'aucune boucle ne
 * tourne plus. Bug : la fermeture ne détachait pas → la boucle continuait.
 */
async function checkDetachStopsRaf(cdp) {
  await reloadPlugin(cdp);
  await ensureOneGraphView(cdp);
  await sleep(600);

  // Sanity : la boucle tourne bien avant fermeture.
  const a1 = await cdp.evalJS(`window.__loreFrames ?? null`);
  await sleep(400);
  const a2 = await cdp.evalJS(`window.__loreFrames ?? null`);
  if (a1 === null || !(a2 > a1)) {
    return { status: "skip", msg: `rAF pas actif avant fermeture (${a1} → ${a2}) — préconditions non réunies` };
  }

  // Ferme toutes les graph views.
  await cdp.evalJS(`(() => {
    app.workspace.getLeavesOfType('graph').forEach(l => l.detach());
    return true;
  })()`);
  await sleep(500); // laisse layout-change déclencher le detach

  const b1 = await cdp.evalJS(`window.__loreFrames ?? 0`);
  await sleep(800);
  const b2 = await cdp.evalJS(`window.__loreFrames ?? 0`);

  // Nettoyage : rouvre une graph view pour laisser Obsidian utilisable.
  await cdp.evalJS(`app.commands.executeCommandById('graph:open')`);
  await sleep(800);

  if (b2 === b1) {
    return { status: "pass", msg: `rAF stoppé après fermeture (frozen à ${b1})` };
  }
  return { status: "fail", msg: `boucle orpheline : __loreFrames continue (${b1} → ${b2}) après fermeture de toutes les views` };
}

async function main() {
  let cdp;
  try {
    cdp = await connect();
  } catch (e) {
    console.error(`\n✗ Connexion CDP impossible sur le port ${PORT}. ${e.message}`);
    console.error(`  → Lance Obsidian en debug : powershell -File _test/launch-obsidian.ps1\n`);
    process.exit(1);
  }
  console.log(`[regression] connecté à : ${cdp.target.title || cdp.target.url}\n`);

  if (!(await isVisible(cdp))) {
    console.error(
      `⚠ Fenêtre Obsidian masquée (visibilityState=hidden) : les rAF sont en\n` +
        `  pause, les régressions rAF ne sont pas testables. Ramène Obsidian au\n` +
        `  premier plan puis relance.\n`,
    );
    cdp.close();
    process.exit(1);
  }

  const checks = [
    ["#1 multi-view : 2 graph views masquent toutes les deux", checkMultiView],
    ["#2 detach : fermer les views stoppe le rAF (pas d'orphelin)", checkDetachStopsRaf],
  ];

  let failed = 0;
  let skipped = 0;
  for (const [name, fn] of checks) {
    let res;
    try {
      res = await fn(cdp);
    } catch (e) {
      res = { status: "fail", msg: `exception: ${e.message}` };
    }
    const icon = res.status === "pass" ? "✓" : res.status === "skip" ? "⊘" : "✗";
    console.log(`  ${icon} ${name}\n      ${res.msg}`);
    if (res.status === "fail") failed++;
    if (res.status === "skip") skipped++;
  }

  console.log(`\n[regression] ${checks.length - failed - skipped} pass, ${failed} fail, ${skipped} skip`);
  cdp.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
