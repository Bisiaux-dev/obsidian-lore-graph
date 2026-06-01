# `_test/` — tests e2e via connexion directe CDP à Obsidian

Obsidian est une app Electron/Chromium. Lancée avec `--remote-debugging-port`,
elle expose un endpoint **Chrome DevTools Protocol** auquel on se branche en
WebSocket pour piloter le renderer du graph en live. C'est la couche e2e :
elle valide le comportement réel du plugin, là où les tests Vitext (`npm test`)
ne couvrent que la logique pure.

## Workflow complet

```bash
# 1. Build + déploie le plugin dans le vault de test
npm run deploy:test

# 2. Lance Obsidian en mode debug (port 9222) — il rouvre le dernier vault
powershell -ExecutionPolicy Bypass -File _test/launch-obsidian.ps1

# 3. Lance la suite e2e (recharge le plugin + assertions)
npm run test:e2e
```

`test:e2e` sort en code 0 si tout passe, 1 sinon — utilisable en CI locale.

## Pièces

| Fichier | Rôle |
|---|---|
| `deploy.cjs` | Copie `main.js`/`manifest.json`/`styles.css` → `<vault>/.obsidian/plugins/lore-graph/`. Vault = `$LORE_TEST_VAULT` ou `../lore-test-vault`. Ne touche pas `data.json`. |
| `launch-obsidian.ps1` | Tue toute instance Obsidian et la relance avec `--remote-debugging-port` (le flag n'agit qu'au démarrage). `-Port` configurable. |
| `e2e.cjs` | Runner d'assertions via CDP (voir checks ci-dessous). `CDP_PORT` configurable. |
| `exec.js` | Client CDP brut pour l'exploration manuelle (eval JS, reload, screenshot, hover synthétique). Pas d'assertions. |
| `capture-hover.js` | Poll l'état du renderer jusqu'à détecter un hover natif + dump/screenshot (rétro-ingénierie). |

## Ce que `e2e.cjs` vérifie

1. **plugin chargé & activé** — `app.plugins.plugins['lore-graph']`, `settings.enabled`.
2. **graph view ouverte** — sinon `graph:open` est exécuté.
3. **boucle rAF vivante** — `window.__loreFrames` s'incrémente.
4. **nodes cachés masqués au repos** — les nodes des dossiers cachés ont `circle.renderable === false`.
5. **révélation au clic** — un clic synthétique sur un node visible relié à un node caché passe ce dernier à `renderable === true`.

### ⚠️ Observable correct : `renderable`, pas `alpha`

Obsidian remet `circle.alpha = 1` **et** `circle.visible = true` à **chaque
frame** dans sa render loop. Le seul attribut que le plugin pose et qu'Obsidian
ne réécrit pas est **`renderable`**. Toute assertion de visibilité doit donc
porter sur `renderable` — mesurer `alpha` donne des faux négatifs (la valeur
oscille selon le moment de la frame où on échantillonne).

## ⚠️ La fenêtre Obsidian doit être visible

Chromium **met les `requestAnimationFrame` en pause** quand la fenêtre est
minimisée ou masquée. Comme tout le masquage du plugin repose sur une boucle
rAF, une fenêtre cachée = `__loreFrames` jamais incrémenté, rien n'est masqué.
`launch-obsidian.ps1` ramène la fenêtre au premier plan au démarrage, et
`e2e.cjs`/`regression.cjs` refusent de tourner (message explicite + exit 1) si
`document.visibilityState === 'hidden'`. Ne minimise pas Obsidian pendant un run.

## Prérequis vault

Le vault de test doit contenir au moins un **dossier caché peuplé** (ex.
`journal/`, `topics/`) avec des notes liées à des notes visibles — sinon les
checks 4 et 5 passent en `⊘ skip` (signalé, pas masqué).

## Artefacts

Screenshots (`*.png`), logs (`*.log`) et dumps d'état (`*.json`) sont gitignored.
Seuls les scripts (`*.cjs`, `*.js`, `*.ps1`) et ce README sont versionnés.
