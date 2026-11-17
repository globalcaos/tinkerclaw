// The toolbar on a phone (2026-11-12): every tool shows at once. Upright the toolbar sits at the bottom,
// wrapped into rows; sideways it is a rail on the right edge, in columns. Before, upright it was one row that hid ten buttons to the right,
// and sideways a column that ran below the screen. Checked inside a stand-in of Tinker's reader layer (same
// origin, as on the phone), with the sometimes-hidden buttons shown so the fullest bar is the one measured:
//   T1 no toolbar button is off screen, in either orientation
//   T2 the tools come in their groups' order (mark up, read, listen, send): upright left to right, top to
//      bottom; sideways top to bottom, column by column
//   T3 the page ends where the bar begins (upright: above it; sideways: left of it, and the bar touches the right edge)
//   T6 with the dark look the page itself is dark, not only the bars
//   T4 sideways: Tinker's title bar is hidden, ✕ is in the bar and closes the layer; upright: neither
//   T5 the three tools that once all wore a pencil have three different pictures
// node test/toolbar-rows.mjs   (server on 127.0.0.1:$PDF_REVIEW_PORT, default 18820; Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const view = new URL(fixtureUrl());
const VIEW = view.pathname + view.search;
const ORDER = ["selectTool", "tapComment", "editorHighlightButton", "editorFreeTextButton", "editorInkButton", "editorStampButton", "editUndo", "editRedo",
  "recentFiles", "viewsManagerToggleButton", "viewFindButton", "previous", "pageNumber", "next", "viewMode", "readerPrev", "readerPlay", "readerNext", "readerResume", "readerSettings",
  "editSource", "redoDocument", "saveState", "secondaryToolbarToggleButton"];
let failed = false;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
for (const [name, w, h] of [["sideways", 922, 381], ["upright", 411, 922]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${view.origin}/api/history`);
  await page.evaluate((src) => {
    document.open(); document.write(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      body{margin:0} #pdf-reader-layer{position:fixed;inset:0;display:flex;flex-direction:column;background:#f6efe2}
      .pdf-reader-bar{flex:none;display:flex;align-items:center;justify-content:space-between;height:40px;padding:0 4px 0 14px;background:#3b2a1c;color:#f6efe2;font:15px Georgia}
      .pdf-reader-close{width:44px;height:40px;border:0;background:transparent;color:#f6efe2;font-size:20px}
      .pdf-reader-frame{flex:1;width:100%;border:0}</style></head><body>
      <div id="pdf-reader-layer"><div class="pdf-reader-bar"><span>PDF reader</span><button class="pdf-reader-close" onclick="document.getElementById('pdf-reader-layer').remove()">✕</button></div>
      <iframe class="pdf-reader-frame" src="${src}"></iframe></div></body></html>`); document.close();
  }, VIEW);
  let frame = null;
  for (let i = 0; i < 60 && !frame; i++) { frame = page.frames().find((f) => f.url().includes("viewer.html")) || null; if (!frame) await page.waitForTimeout(500); }
  await frame.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && document.querySelector(".textLayer span"), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const info = await frame.evaluate(([ORDER, sideways]) => {
    for (const id of ["editSource", "redoDocument", "readerResume", "saveState"]) { const e = document.getElementById(id); if (e) e.hidden = false; }
    return new Promise((done) => setTimeout(() => {
      const box = {}, off = [];
      for (const b of document.querySelectorAll("#toolbarViewer .toolbarButton, #toolbarViewer input#pageNumber")) {
        if (b.closest(".doorHanger, .doorHangerRight, .menuContainer, .editorParamsToolbar")) continue;
        const r = b.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        box[b.id] = r;
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) off.push(b.id);
      }
      const seen = ORDER.filter((id) => box[id]);
      const reading = [...seen].sort((a, b) => sideways
        ? (Math.abs(box[a].left - box[b].left) > 8 ? box[a].left - box[b].left : box[a].top - box[b].top)
        : (Math.abs(box[a].top - box[b].top) > 8 ? box[a].top - box[b].top : box[a].left - box[b].left));
      const bar = document.getElementById("toolbarContainer").getBoundingClientRect();
      const pageBox = document.getElementById("viewerContainer").getBoundingClientRect();
      const pic = (id) => getComputedStyle(document.getElementById(id), "::before").backgroundImage;
      done({
        rows: document.body.classList.contains("tbRows"), count: Object.keys(box).length, off,
        inOrder: seen.join() === reading.join(), reading: reading.join(" "),
        barAtBottom: sideways ? Math.abs(bar.right - innerWidth) <= 1 && bar.top <= 1 : Math.abs(bar.bottom - innerHeight) <= 1,
        pageEndsAtBar: sideways ? Math.abs(pageBox.right - bar.left) <= 2 && Math.abs(pageBox.bottom - innerHeight) <= 1 : Math.abs(pageBox.bottom - bar.top) <= 2,
        barHeight: Math.round(bar.height), barWidth: Math.round(bar.width),
        close: !document.getElementById("closeReader").hidden,
        pictures: new Set(["editorHighlightButton", "editorInkButton", "editSource"].map(pic)).size,
      });
    }, 500));
  }, [ORDER, name === "sideways"]);
  // T6: the middle of the first page, light look then dark look.
  const paper = async () => {
    // The left margin of whichever page is on screen (a saved place may have reopened the file further down).
    const b = await frame.evaluate(() => {
      const box = document.getElementById("viewerContainer").getBoundingClientRect();
      const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".page");
      const r = el.getBoundingClientRect();
      const f = window.frameElement.getBoundingClientRect();
      return { x: f.left + Math.max(r.left, box.left) + 4, y: f.top + box.top + box.height / 2 };
    });
    const shot = await page.screenshot({ clip: { x: b.x, y: b.y, width: 6, height: 6 } });
    return frame.evaluate(async (b64) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const c = new OffscreenCanvas(1, 1).getContext("2d"); c.drawImage(img, 0, 0, 1, 1);
      const [r, g, bl] = c.getImageData(0, 0, 1, 1).data; return (r + g + bl) / 3;
    }, shot.toString("base64"));
  };
  const setLook = (v) => frame.evaluate((v) => { const s = document.getElementById("readerLook"); s.value = v; s.dispatchEvent(new Event("change")); }, v);
  await setLook("light"); await page.waitForTimeout(300); const paperLight = await paper();
  await setLook("dark"); await page.waitForTimeout(300); const paperDark = await paper();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}-dark.png` });
  await setLook("auto"); await page.waitForTimeout(200);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}-light.png` });
  const hostBarShown = await page.evaluate(() => getComputedStyle(document.querySelector(".pdf-reader-bar")).display !== "none");
  let closed = null;
  if (name === "sideways") { await frame.click("#closeReader"); closed = await page.evaluate(() => !document.getElementById("pdf-reader-layer")); }
  const r = { ...info, paperLight: Math.round(paperLight), paperDark: Math.round(paperDark), hostBarShown, closed, errors };
  console.log(name, JSON.stringify(r));
  const common = r.rows && r.count >= 20 && !r.off.length && r.inOrder && r.barAtBottom && r.pageEndsAtBar && r.pictures === 3 && r.paperLight > 200 && r.paperDark < 70 && !errors.length;
  const ok = common && (name === "sideways" ? r.close && !r.hostBarShown && r.closed : !r.close && r.hostBarShown);
  if (!ok) failed = true;
  await ctx.close();
}
await browser.close();
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
