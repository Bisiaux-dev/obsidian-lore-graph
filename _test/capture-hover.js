#!/usr/bin/env node
/**
 * Poll en boucle l'état du renderer. Capture l'instant où highlightNode
 * devient non-null (signature du hover natif). Affiche TOUT ce qui peut
 * être pertinent + screenshot.
 *
 * Usage : node capture-hover.js
 *   Puis hover un node dans Obsidian — capture déclenchée auto.
 */

const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const PORT = 9222;
const POLL_MS = 100;
const TIMEOUT_MS = 60000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function main() {
  const targets = await fetchJson(`http://localhost:${PORT}/json/list`);
  const target = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("devtools://"),
  );
  if (!target) throw new Error("No Obsidian target");
  console.log(`[CDP] connected to ${target.title}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
    }
  });

  await new Promise((r, e) => {
    ws.once("open", r);
    ws.once("error", e);
  });
  await send("Runtime.enable");

  console.log(`[CDP] polling toutes les ${POLL_MS}ms — hover un node dans Obsidian...`);

  const start = Date.now();
  let captured = false;

  while (Date.now() - start < TIMEOUT_MS && !captured) {
    const expr = `(() => {
      const v = app.workspace.getLeavesOfType('graph')[0]?.view;
      if (!v) return { error: 'no graph view' };
      const r = v.renderer;
      const hl = r.getHighlightNode?.() || r.highlightNode;
      return JSON.stringify({
        hasHL: !!hl,
        hlId: hl?.id || null,
        hlWeight: hl?.weight || null,
        mouseX: r.mouseX,
        mouseY: r.mouseY,
        scale: r.scale,
        panX: r.panX,
        panY: r.panY,
        hangerX: r.hanger?.x,
        hangerY: r.hanger?.y,
        hangerScaleX: r.hanger?.scale?.x,
        textAlpha: r.textAlpha,
        nodeScale: r.nodeScale,
        targetScale: r.targetScale,
        canvasRect: (() => { const c = r.px?.view || r.px?.canvas; if (!c?.getBoundingClientRect) return null; const b = c.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })(),
      });
    })()`;

    const res = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    const state = JSON.parse(res.result?.value || "{}");

    if (state.hasHL) {
      console.log(`\n[CDP] 🎯 hover DETECTED on "${state.hlId}"`);
      console.log(JSON.stringify(state, null, 2));
      console.log(`[CDP] capturing screenshot...`);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync("native-hover.png", Buffer.from(shot.data, "base64"));
      console.log(`[CDP] saved native-hover.png`);
      // Save state for later programmatic reproduction
      fs.writeFileSync("hover-state.json", JSON.stringify(state, null, 2));
      console.log(`[CDP] saved hover-state.json`);
      captured = true;
      break;
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (!captured) console.log("\n[CDP] timeout — no hover detected");
  ws.close();
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
