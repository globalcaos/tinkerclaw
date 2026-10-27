import fs from "node:fs";
// Drive the architect's SHARED amazon.es tab across several capacity queries, keeping
// his "Get It Tomorrow" filter (rh=p_90:6820340031), and dump the result cards
// for each. SAME-SITE ONLY (amazon.es → amazon.es), per the standing relay rule.
// Restores the original URL when done.
import { WebSocket } from "ws";

const WSURL = "ws://127.0.0.1:18792/cdp";
const TARGET = process.argv[2];
const TOMORROW = "p_90%3A6820340031";
const QUERIES = ["micro sd 128gb", "micro sd 256gb", "micro sd 512gb", "micro sd 1tb"];

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GRAB = `(() => {
  const cards = [...document.querySelectorAll('[data-component-type="s-search-result"]')];
  return JSON.stringify({ url: location.href, n: cards.length, html: cards.map(e => e.outerHTML).join("\\n") });
})()`;

ws.on("open", async () => {
  try {
    const at = await send("Target.attachToTarget", { targetId: TARGET, flatten: true });
    const sid = at.result?.sessionId;
    if (!sid) {
      console.log("NO_SESSION");
      process.exit(1);
    }

    const orig = await send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      sid,
    );
    const originalUrl = orig.result?.result?.value;
    console.log("original tab url:", originalUrl);

    for (const q of QUERIES) {
      const url = `https://www.amazon.es/s?k=${encodeURIComponent(q)}&rh=${TOMORROW}&language=en`;
      if (!url.startsWith("https://www.amazon.es/")) {
        console.log("REFUSED cross-site:", url);
        continue;
      }
      await send("Page.navigate", { url }, sid);
      // Poll for cards rather than guessing a fixed delay.
      let got = null;
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const r = await send(
          "Runtime.evaluate",
          { expression: GRAB, returnByValue: true, awaitPromise: true },
          sid,
        );
        const raw = r.result?.result?.value;
        if (!raw) continue;
        const d = JSON.parse(raw);
        if (d.n > 0 && d.url.includes(encodeURIComponent(q).replace(/%20/g, "+")) === false) {
          // URL may normalise; accept any page that has cards after navigation.
        }
        if (d.n > 0) {
          got = d;
          break;
        }
      }
      if (!got) {
        console.log(`  ! ${q}: no cards`);
        continue;
      }
      const out = `/tmp/tab-${q.replace(/\s+/g, "-")}.html`;
      fs.writeFileSync(out, got.html);
      console.log(`  ok ${q}: ${got.n} cards → ${out}`);
      await sleep(1500);
    }

    if (originalUrl && originalUrl.startsWith("https://www.amazon.es/")) {
      await send("Page.navigate", { url: originalUrl }, sid);
      console.log("restored tab to:", originalUrl);
    }
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
}, 240000);
