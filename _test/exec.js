#!/usr/bin/env node
/**
 * CDP client minimal pour Obsidian.
 *
 * Usage :
 *   node exec.js "<JS expression>"
 *   node exec.js --file path/to/script.js
 *   node exec.js --reload-plugin lore-graph
 *   node exec.js --logs   (juste capture la console 5s)
 *
 * Prérequis : Obsidian lancé avec --remote-debugging-port=9222
 */

const http = require("http");
const WebSocket = require("ws");

const PORT = 9222;
const CAPTURE_MS = parseInt(process.env.CAPTURE_MS || "3000", 10);
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(
    "Usage:\n  node exec.js \"<js>\"\n  node exec.js --reload-plugin <id>\n  node exec.js --logs\n  node exec.js --file <path>",
  );
  process.exit(1);
}

let mode, payload;
let screenshotPath = null;
if (args[0] === "--reload-plugin") {
  mode = "eval";
  const id = args[1];
  payload = `(async () => {
    try {
      await app.plugins.disablePlugin('${id}');
      await app.plugins.enablePlugin('${id}');
      return 'reloaded ${id}';
    } catch (e) { return 'ERROR: ' + e.message; }
  })()`;
} else if (args[0] === "--logs") {
  mode = "logs-only";
  payload = null;
} else if (args[0] === "--file") {
  mode = "eval";
  payload = require("fs").readFileSync(args[1], "utf8");
} else if (args[0] === "--hover-node") {
  // Hover par dispatch d'un mousemove à la position d'un node
  mode = "hover-node";
  payload = args[1];
  screenshotPath = args[2] || "hover.png";
} else if (args[0] === "--screenshot") {
  mode = "screenshot";
  screenshotPath = args[1] || "screenshot.png";
  payload = null;
} else if (args[0] === "--eval-and-screenshot") {
  mode = "eval-screenshot";
  payload = args[1];
  screenshotPath = args[2] || "screenshot.png";
} else {
  mode = "eval";
  payload = args[0];
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function findObsidianTarget() {
  const targets = await fetchJson(`http://localhost:${PORT}/json/list`);
  // Filtre : on veut la page principale du renderer Obsidian (pas devtools)
  const candidates = targets.filter(
    (t) =>
      t.type === "page" &&
      !t.url.startsWith("devtools://") &&
      (t.url.startsWith("app://") || t.title === "Obsidian" || t.url.includes("obsidian")),
  );
  if (candidates.length === 0) {
    // Fallback : première page non-devtools
    const fallback = targets.find(
      (t) => t.type === "page" && !t.url.startsWith("devtools://"),
    );
    if (fallback) return fallback;
    throw new Error(
      "Aucun target Obsidian trouvé. Targets disponibles:\n" +
        JSON.stringify(targets, null, 2),
    );
  }
  return candidates[0];
}

async function main() {
  const target = await findObsidianTarget();
  console.error(`[CDP] target: ${target.title || target.url}`);
  const wsUrl = target.webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();

  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const { type, args: argsArr, timestamp } = msg.params;
      const formatted = argsArr
        .map((a) => {
          if (a.value !== undefined) return String(a.value);
          if (a.description) return a.description;
          if (a.preview)
            return a.preview.properties
              .map((p) => `${p.name}=${p.value}`)
              .join(",");
          return JSON.stringify(a);
        })
        .join(" ");
      const ts = new Date(timestamp).toISOString().slice(11, 23);
      console.log(`[${ts}] ${type.toUpperCase()} ${formatted}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      console.log("[EXCEPTION]", JSON.stringify(msg.params.exceptionDetails));
    }
  });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  console.error(`[CDP] connected, enabling Runtime/Console`);
  await send("Runtime.enable");
  await send("Console.enable");

  if ((mode === "eval" || mode === "eval-screenshot") && payload) {
    console.error(`[CDP] evaluating: ${payload.slice(0, 80)}${payload.length > 80 ? "…" : ""}`);
    const result = await send("Runtime.evaluate", {
      expression: payload,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      console.error("[CDP] exception:", JSON.stringify(result.exceptionDetails));
    } else {
      console.error(`[CDP] result:`, JSON.stringify(result.result?.value));
    }
  }

  if (mode === "hover-node") {
    // Formule : screen = canvas.rect + pan + node*scale
    // (canvas via DOM query car r.px.view retourne parfois rect (0,0) buggé)
    const posExpr = `(() => {
      const v = app.workspace.getLeavesOfType('graph')[0]?.view;
      const r = v?.renderer;
      const node = r?.nodeLookup?.['${payload}'] || r?.nodes?.find(n => n.id === '${payload}');
      if (!node) return null;
      const canvas = v.containerEl.querySelector('canvas') || document.querySelector('.view-content canvas');
      const rect = canvas.getBoundingClientRect();
      const sx = rect.left + r.panX + node.x * r.scale;
      const sy = rect.top + r.panY + node.y * r.scale;
      return { sx, sy, id: node.id, nx: node.x, ny: node.y, scale: r.scale, panX: r.panX, panY: r.panY, rectL: rect.left, rectT: rect.top };
    })()`;
    const posResult = await send("Runtime.evaluate", {
      expression: posExpr,
      returnByValue: true,
    });
    const pos = posResult.result?.value;
    console.error(`[CDP] node pos:`, JSON.stringify(pos));
    if (pos && pos.sx !== undefined) {
      // 2. Dispatch a real browser mouseMoved event at that position
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: pos.sx,
        y: pos.sy,
        button: "none",
        clickCount: 0,
      });
      console.error(`[CDP] mouseMoved dispatched at (${pos.sx}, ${pos.sy})`);
      await new Promise((r) => setTimeout(r, 400));
      // 3. Screenshot
      const shot = await send("Page.captureScreenshot", { format: "png" });
      require("fs").writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
      console.error(`[CDP] screenshot saved: ${screenshotPath}`);
    }
  }

  if (mode === "screenshot" || mode === "eval-screenshot") {
    // Petite pause pour laisser le render se faire
    await new Promise((r) => setTimeout(r, 300));
    console.error(`[CDP] capturing screenshot...`);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    require("fs").writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
    console.error(`[CDP] screenshot saved: ${screenshotPath}`);
  }

  if (mode !== "screenshot") {
    console.error(`[CDP] capturing console for ${CAPTURE_MS}ms...`);
    await new Promise((r) => setTimeout(r, CAPTURE_MS));
  }
  ws.close();
  console.error(`[CDP] done`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
