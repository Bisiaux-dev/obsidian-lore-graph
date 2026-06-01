/**
 * Client CDP partagé : connexion WebSocket au endpoint Chrome DevTools
 * d'Obsidian (lancé avec --remote-debugging-port). Factorise le boilerplate
 * réutilisé par e2e.cjs et regression.cjs.
 *
 * `exec.js` et `capture-hover.js` gardent leur propre copie (outils
 * d'exploration autonomes, antérieurs à ce module).
 */
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.CDP_PORT || 9222);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("timeout")));
  });
}

async function findTarget() {
  const targets = await fetchJson(`http://localhost:${PORT}/json/list`);
  const page = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("devtools://"),
  );
  if (!page) throw new Error("aucune page Obsidian trouvée sur le CDP");
  return page;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Se connecte à Obsidian et renvoie { evalJS, close, target }.
 * `evalJS(expr)` évalue une expression JS (await + returnByValue) et renvoie
 * la valeur, ou throw sur exception côté page.
 */
async function connect() {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send("Runtime.enable");

  async function evalJS(expression) {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        "eval exception: " +
          (res.exceptionDetails.exception?.description ||
            res.exceptionDetails.text),
      );
    }
    return res.result?.value;
  }

  return { evalJS, close: () => ws.close(), target };
}

/**
 * Vérifie que la fenêtre Obsidian est visible. Chromium met les
 * `requestAnimationFrame` en pause quand la fenêtre est masquée/minimisée —
 * or tout le masquage du plugin repose sur le rAF. Un run e2e contre une
 * fenêtre cachée ne teste donc rien. Renvoie true si visible.
 */
async function isVisible(cdp) {
  return (await cdp.evalJS(`document.visibilityState`)) === "visible";
}

module.exports = { connect, sleep, PORT, isVisible };
