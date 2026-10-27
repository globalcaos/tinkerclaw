// Landscape phone (2026-10-24, the architect: "When the pdf reader turns horizontal, I would like to have all
// the available vertical space ... make all the toolbox only icons and present them on the left side of
// the screen, with vertical scroll"). Inside a stand-in of Tinker's reader layer (same origin, as on the
// phone): landscape → icon column on, Tinker's title bar hidden, the column scrolls, ✕ closes the layer;
// portrait → unchanged. node test/landscape-rail.mjs  (server on 127.0.0.1:18820; Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const VIEW = "/viewer/web/viewer.html?file=%2Fpapers%2Fopen%2Fjarvistest%2Ft.pdf";
let failed = false;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
for (const [name, w, h] of [["land", 915, 340], ["port", 411, 820]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:18820/api/history");
  await page.evaluate((src) => {
    document.open(); document.write(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      body{margin:0} #pdf-reader-layer{position:fixed;inset:0;display:flex;flex-direction:column;background:#f6efe2}
      .pdf-reader-bar{flex:none;display:flex;align-items:center;justify-content:space-between;height:40px;padding:0 4px 0 14px;background:#3b2a1c;color:#f6efe2;font:15px Georgia}
      .pdf-reader-close{width:44px;height:40px;border:0;background:transparent;color:#f6efe2;font-size:20px}
      .pdf-reader-frame{flex:1;width:100%;border:0}</style></head><body>
      <div id="pdf-reader-layer"><div class="pdf-reader-bar"><span>PDF reader</span><button class="pdf-reader-close" onclick="document.getElementById('pdf-reader-layer').remove()">✕</button></div>
      <iframe class="pdf-reader-frame" src="${src}"></iframe></div></body></html>`); document.close();
  }, VIEW);
  await page.waitForTimeout(9000);
  const frame = page.frames().find((f) => f.url().includes("viewer.html"));
  await page.waitForTimeout(2000);
  
  const info = await frame.evaluate(() => ({ rail: document.body.classList.contains("sideRail"), close: !document.getElementById("closeReader").hidden, scrollable: (() => { const t = document.getElementById("toolbarViewer"); return [t.scrollHeight, t.clientHeight]; })() }));
  const barShown = await page.evaluate(() => getComputedStyle(document.querySelector(".pdf-reader-bar")).display !== "none");
  let closed = null;
  if (name === "land") { await frame.click("#closeReader"); closed = await page.evaluate(() => !document.getElementById("pdf-reader-layer")); }
  const r = { ...info, hostBarShown: barShown, closed, errors };
  console.log(name, JSON.stringify(r));
  const ok = name === "land"
    ? r.rail && r.close && !r.hostBarShown && r.scrollable[0] > r.scrollable[1] && r.closed && !errors.length
    : !r.rail && !r.close && r.hostBarShown && !errors.length;
  if (!ok) failed = true;
  await ctx.close();
}
await browser.close();
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
