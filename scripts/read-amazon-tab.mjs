import fs from "node:fs";
// Read the architect's SHARED amazon tab and dump its search-result cards to disk.
// Written as a file (not a shell -e string) to dodge the CDP template-literal
// escape trap: the expression contains both quote flavours.
import { WebSocket } from "ws";

const WSURL = "ws://127.0.0.1:18792/cdp";
const TARGET = process.argv[2];
const OUT = process.argv[3] || "/tmp/tab-cards.html";

const EXPR = `(() => {
  const cards = [...document.querySelectorAll('[data-component-type="s-search-result"]')];
  return JSON.stringify({
    url: location.href,
    title: document.title,
    cardCount: cards.length,
    html: cards.map(e => e.outerHTML).join("\\n")
  });
})()`;

const ws = new WebSocket(WSURL);
let id = 0;
const waiters = new Map();
const send = (m, p, sid) =>
  new Promise((r) => {
    const i = ++id;
    waiters.set(i, r);
    ws.send(
      JSON.stringify(
        sid ? { id: i, method: m, params: p, sessionId: sid } : { id: i, method: m, params: p },
      ),
    );
  });
ws.on("message", (b) => {
  const m = JSON.parse(b);
  if (m.id && waiters.has(m.id)) {
    waiters.get(m.id)(m);
    waiters.delete(m.id);
  }
});
ws.on("open", async () => {
  try {
    const at = await send("Target.attachToTarget", { targetId: TARGET, flatten: true });
    const sid = at.result?.sessionId;
    if (!sid) {
      console.log("NO_SESSION " + JSON.stringify(at.error || at));
      process.exit(1);
    }
    const r = await send(
      "Runtime.evaluate",
      { expression: EXPR, returnByValue: true, awaitPromise: true },
      sid,
    );
    const raw = r.result?.result?.value;
    if (!raw) {
      console.log("NO_VALUE " + JSON.stringify(r.result?.result ?? r.error ?? {}).slice(0, 300));
      process.exit(1);
    }
    const data = JSON.parse(raw);
    fs.writeFileSync(OUT, data.html);
    console.log(
      JSON.stringify({
        url: data.url,
        title: data.title,
        cardCount: data.cardCount,
        bytes: data.html.length,
        out: OUT,
      }),
    );
  } catch (e) {
    console.log("ERR " + e);
  } finally {
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (e) => {
  console.log("WSERR " + e);
  process.exit(1);
});
setTimeout(() => {
  console.log("timeout");
  process.exit(1);
}, 30000);
