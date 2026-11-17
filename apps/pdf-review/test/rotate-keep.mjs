// Turning the phone keeps the place and the zoom (2026-11-15). The text at the middle of the screen
// stays there when the phone turns between landscape and portrait, and the pages do not jump.
// A long throwaway document on a server this test starts itself, read as a phone (touch, 2.625 dpr, the flip phone's
// 411x922 upright and 922x381 sideways) and turned several times, on its own and inside a stand-in of Tinker's reader
// layer (an iframe under a 40 px title bar, same origin, so phone.js hides the bar sideways). After each turn:
//   K1 the zoom is the fit of the settled page area (↕ Scroll: its width; ⇆ Pages: the whole page), worked out here
//      from the area and the page's size, and a second later it still is
//   K2 ↕ Scroll: the line in the middle of the page area before the turn is within one line of the middle after it,
//      on the same page
//   K3 ⇆ Pages: the same page is shown
//   K4 zoomed in with two fingers: the same point stays in the middle; the zoom stays while the page is still wider
//      than the screen, and the page fits the screen again where it would be narrower
//   K5 ✏️ Write on: the zoom is still held as a number (writer.js), at the new screen's fit; Write off gives the fit back
//   K6 read aloud (a silent voice): a turn keeps the view on the page being read, and the view still follows the
//      voice onto the next page
//   K6b the voice turns the page within 600 ms of a turn: the view goes with it, the restore does not pull it back
//   K8 at the very top of the document a turn keeps the top in view
//   K7 ⇆ Pages after the turns: a swipe left and right still turns the page
// node test/rotate-keep.mjs   (Pi: PW_CHROMIUM=/usr/bin/chromium; CONTRACT_DIR and PORT_OFFSET as for test/contract.sh)
import { testServer, makeDoc, chromium, wait } from "./contract-lib.mjs";

const UP = { width: 411, height: 922 }, SIDE = { width: 922, height: 381 };
const SIDE_ROOM = 40, END_ROOM = 5; // pdf.js leaves 40 px beside a fitted page and 5 px above and below it
const words = "amber birch cedar delta ember fjord grove heron indigo juniper kestrel lumen maple nectar onyx pebble quartz raven sorrel thistle umber velvet willow xylem yarrow zephyr".split(" ");
// 110 paragraphs, 14 pages; every few words carry the paragraph's number, so a line names its place.
const paras = Array.from({ length: 110 }, (_, i) => `P${i + 1} ` + Array.from({ length: 58 }, (_, k) => `${words[(i * 7 + k) % words.length]}${k % 9 === 0 ? i + 1 : ""}`).join(" ") + ".");

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
};

const srv = testServer("rotate", 18859);
await srv.start();
const doc = makeDoc(srv, "long", paras);
const view = new URL(doc.url);
const HOST = `${srv.base}/rotate-host.html`;
const hostPage = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body{margin:0} #pdf-reader-layer{position:fixed;inset:0;display:flex;flex-direction:column;background:#f6efe2}
  .pdf-reader-bar{flex:none;display:flex;align-items:center;justify-content:space-between;height:40px;padding:0 4px 0 14px;background:#3b2a1c;color:#f6efe2;font:15px Georgia}
  .pdf-reader-close{width:44px;height:40px;border:0;background:transparent;color:#f6efe2;font-size:20px}
  .pdf-reader-frame{flex:1;width:100%;border:0}</style></head><body>
  <div id="pdf-reader-layer"><div class="pdf-reader-bar"><span>PDF reader</span><button class="pdf-reader-close">✕</button></div>
  <iframe class="pdf-reader-frame" src="${view.pathname}${view.search}"></iframe></div></body></html>`;

// What the viewer shows now: the page area and the zoom it should have, the zoom it has, the line in the middle.
const look = (where) => where.evaluate(async ([SIDE_ROOM, END_ROOM]) => {
  const app = window.PDFViewerApplication, v = app.pdfViewer, c = v.container;
  const box = c.getBoundingClientRect();
  const mx = box.left + c.clientLeft + c.clientWidth / 2, my = box.top + c.clientTop + c.clientHeight / 2;
  // The page area once settled: left of the rail sideways, above the rows upright.
  const bar = document.getElementById("toolbarContainer").getBoundingClientRect();
  const wide = document.body.classList.contains("tbWide");
  const area = wide ? { w: bar.left, h: innerHeight } : { w: innerWidth, h: bar.top };
  let best = null;
  for (let i = 0; i < v.pagesCount; i++) {
    const div = v.getPageView(i).div;
    if (!div.isConnected) continue;
    const b = div.getBoundingClientRect();
    if (!b.height) continue;
    const d = Math.max(b.top - my, my - b.bottom, 0);
    if (!best || d < best.d) best = { d, n: i + 1, b };
  }
  const pdfPage = await app.pdfDocument.getPage(best.n);
  const [x0, y0, x1, y1] = pdfPage.view;
  const css = 96 / 72; // a PDF point in CSS px at zoom 1
  const pageW = (x1 - x0) * css, pageH = (y1 - y0) * css;
  const pages = localStorage.getItem("reader.phoneMode") === "page";
  const fitW = (area.w - SIDE_ROOM) / pageW, fitH = (area.h - END_ROOM) / pageH;
  // The middle in the page's own units (points, y up), and the printed line nearest it.
  const px = x0 + ((mx - best.b.left) / best.b.width) * (x1 - x0);
  const py = y1 - ((my - best.b.top) / best.b.height) * (y1 - y0);
  const items = (await pdfPage.getTextContent()).items.filter((t) => t.str.trim());
  const base = [...new Set(items.map((t) => Math.round(t.transform[5] * 10) / 10))].sort((a, b) => b - a);
  const gaps = base.slice(1).map((y, i) => base[i] - y).filter((g) => g > 1).sort((a, b) => a - b);
  const pitch = gaps[Math.floor(gaps.length / 2)] || 16;
  const line = items.reduce((a, t) => (Math.abs(t.transform[5] + t.height * 0.35 - py) < Math.abs(a.transform[5] + a.height * 0.35 - py) ? t : a), items[0]);
  return {
    w: innerWidth, h: innerHeight, wide, rails: wide === innerWidth > innerHeight,
    area: [Math.round(area.w), Math.round(area.h)], box: [c.clientWidth, c.clientHeight],
    settled: Math.abs(c.clientWidth - area.w) <= 2 && Math.abs(c.clientHeight - area.h) <= 2,
    zoom: v.currentScale, value: String(v.currentScaleValue), fit: pages ? Math.min(fitW, fitH) : fitW,
    page: v.currentPageNumber, shown: best.n, px, py, pitch, line: line.str.slice(0, 48),
    hostBar: (() => { try { const hb = parent.document.querySelector(".pdf-reader-bar"); return hb ? getComputedStyle(hb).display !== "none" : null; } catch { return null; } })(),
  };
}, [SIDE_ROOM, END_ROOM]);

const near = (a, b, rel = 0.003) => Math.abs(a - b) <= rel * b;
const fmt = (z) => z.toFixed(3);

async function open(browser, { pages = false, framed = false } = {}) {
  const ctx = await browser.newContext({ viewport: UP, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  await ctx.addInitScript((m) => localStorage.setItem("reader.phoneMode", m), pages ? "page" : "scroll");
  await ctx.route(/\/api\/redo/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  if (framed) await ctx.route(HOST, (r) => r.fulfill({ status: 200, contentType: "text/html", body: hostPage }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(framed ? HOST : doc.url);
  let where = page;
  if (framed) {
    for (let i = 0; i < 60 && where === page; i++) { where = page.frames().find((f) => f.url().includes("viewer.html")) || page; if (where === page) await wait(500); }
  }
  await where.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && document.querySelector(".textLayer span"), null, { timeout: 60000 });
  await wait(2500);
  return { ctx, page, where, errors };
}

// One turn: where the middle was, the turn, then the checks; `label` names the run in the output.
async function turn(t, to, label, { pinchZoom = 0 } = {}) {
  const before = await look(t.where);
  await t.page.setViewportSize(to);
  await wait(1500);
  const after = await look(t.where);
  await wait(1000);
  const later = await look(t.where);
  const pages = (await t.where.evaluate(() => localStorage.getItem("reader.phoneMode"))) === "page";
  const name = `${label} ${before.w}x${before.h} -> ${after.w}x${after.h}`;
  check(after.settled && after.rails, `${name}: the page area settled beside the bar`, `area ${after.area}, page area ${after.box}`);
  if (!pinchZoom) {
    check(near(after.zoom, after.fit) && near(later.zoom, later.fit), `K1 ${name}: the zoom fits the settled page area`,
      `zoom ${fmt(after.zoom)} then ${fmt(later.zoom)}, fit ${fmt(after.fit)} (${after.value})`);
  }
  if (pages) {
    check(after.page === before.page && after.shown === before.shown && later.page === before.page, `K3 ${name}: the same page is shown`,
      `page ${before.page} -> ${after.page}, shown ${before.shown} -> ${after.shown}`);
  } else {
    const dy = Math.abs(after.py - before.py) / before.pitch, ldy = Math.abs(later.py - before.py) / before.pitch;
    check(after.shown === before.shown && dy <= 1 && ldy <= 1, `K2 ${name}: the middle line stays in the middle`,
      `p.${before.shown} "${before.line}" -> p.${after.shown} "${after.line}", ${dy.toFixed(2)} then ${ldy.toFixed(2)} lines off`);
    if (pinchZoom) {
      const dx = Math.abs(after.px - before.px) / before.pitch;
      check(dx <= 1, `K4 ${name}: zoomed in, the same point stays in the middle across too`, `${dx.toFixed(2)} lines off sideways`);
    }
  }
  if (after.hostBar !== null) check(after.hostBar === !after.wide, `${name}: Tinker's title bar is hidden only sideways`, `shown: ${after.hostBar}`);
  return { before, after, later };
}

// Somewhere in the middle of the document, not on a page's edge.
const place = (t, n, share = 0.45) => t.where.evaluate(([n, share]) => {
  const v = window.PDFViewerApplication.pdfViewer, c = v.container;
  v.currentPageNumber = n;
  const div = v.getPageView(n - 1).div;
  c.scrollTop = div.offsetTop + share * div.offsetHeight - c.clientHeight / 2;
}, [n, share]);
const scrollBy = (t, part) => t.where.evaluate((part) => { const c = window.PDFViewerApplication.pdfViewer.container; c.scrollTop += part * c.clientHeight; }, part);

// A two-finger pinch at the middle of the page area, through the phone's own touch input.
async function pinch(t, from, to) {
  const c = await t.where.evaluate(() => { const c = window.PDFViewerApplication.pdfViewer.container, r = c.getBoundingClientRect(); return [r.left + c.clientWidth / 2, r.top + c.clientHeight / 2]; });
  const cdp = await t.page.context().newCDPSession(t.page);
  const at = (d) => [{ x: c[0] - d / 2, y: c[1], id: 1 }, { x: c[0] + d / 2, y: c[1], id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from) });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(from + ((to - from) * i) / 12) });
    await wait(40);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await wait(1500);
}

// A quick one-finger flick sideways across the middle of the page area (dx < 0: to the left).
async function swipe(t, dx) {
  const c = await t.where.evaluate(() => { const c = window.PDFViewerApplication.pdfViewer.container, r = c.getBoundingClientRect(); return [r.left + c.clientWidth / 2, r.top + c.clientHeight / 2]; });
  const cdp = await t.page.context().newCDPSession(t.page);
  const at = (x) => [{ x, y: c[1], id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(c[0] - dx / 2) });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(c[0] - dx / 2 + (dx * i) / 6) });
    await wait(20);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await wait(1000);
}

// Silence as a WAV (8 kHz, 8-bit, mono), the voice for K6, as in test/reader-skip.mjs.
function silence(seconds) {
  const n = Math.round(8000 * seconds);
  const b = Buffer.alloc(44 + n, 0x80);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}

// The test browser's own back swipe (Chromium's overscroll history navigation) is off: it took K7's swipe to the
// right as Back and left the viewer.
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined,
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=OverscrollHistoryNavigation,TouchpadOverscrollHistoryNavigation"] });
try {
  for (const framed of [false, true]) {
    for (const pages of [false, true]) {
      const label = `${pages ? "Pages" : "Scroll"}${framed ? " in Tinker's layer" : ""}`;
      const t = await open(browser, { pages, framed });
      if (pages) await t.where.evaluate(() => { window.PDFViewerApplication.pdfViewer.currentPageNumber = 6; });
      else await place(t, 6);
      await wait(800);
      for (const [i, to] of [SIDE, UP, SIDE, UP].entries()) {
        await turn(t, to, `${label} #${i + 1}`);
        if (!pages) await scrollBy(t, 0.37); // a new place for the next turn: the middle is followed while he scrolls
        else await t.where.evaluate(() => window.PDFViewerApplication.pdfViewer.nextPage());
        await wait(600);
      }
      if (pages && !framed) {
        const page = () => t.where.evaluate(() => window.PDFViewerApplication.page);
        const p0 = await page();
        await swipe(t, -220);
        const p1 = await page();
        await swipe(t, 220);
        const p2 = await page();
        check(p1 === p0 + 1 && p2 === p0, "K7 Pages after the turns: a swipe left and right still turns the page", `${p0} -> ${p1} -> ${p2}`);
      }
      check(!t.errors.length, `${label}: no page errors`, t.errors.slice(0, 2).join(" | "));
      await t.ctx.close();
    }
  }

  // K4: zoomed in with two fingers past the width, then turned.
  {
    const t = await open(browser);
    await place(t, 7, 0.4);
    await wait(800);
    const z0 = (await look(t.where)).zoom;
    await pinch(t, 60, 220);
    const z1 = (await look(t.where)).zoom;
    check(z1 > z0 * 2.5, "K4 a two-finger pinch zooms in", `${fmt(z0)} -> ${fmt(z1)}`);
    const a = await turn(t, SIDE, "K4 pinched", { pinchZoom: z1 });
    check(Math.abs(a.after.zoom - z1) < 0.01 && a.after.zoom > a.after.fit, "K4 sideways his zoom stays (the page is still wider than the screen)",
      `zoom ${fmt(a.after.zoom)}, fit ${fmt(a.after.fit)}`);
    const b = await turn(t, UP, "K4 pinched", { pinchZoom: z1 });
    check(Math.abs(b.after.zoom - z1) < 0.01, "K4 upright again his zoom stays", `zoom ${fmt(b.after.zoom)}`);
    // A smaller pinch: sideways the page would sit narrower than the screen, so it fits the screen again.
    await t.where.evaluate(() => { window.PDFViewerApplication.pdfViewer.currentScaleValue = "page-width"; });
    await place(t, 7, 0.6);
    await wait(800);
    await pinch(t, 100, 150);
    const z2 = (await look(t.where)).zoom;
    const c = await turn(t, SIDE, "K4 pinched a little", { pinchZoom: z2 });
    check(near(c.after.zoom, c.after.fit) && c.after.value === "page-width", "K4 a zoom smaller than the new fit gives way to the fit",
      `pinched ${fmt(z2)}, now ${fmt(c.after.zoom)} (${c.after.value}), fit ${fmt(c.after.fit)}`);
    await t.ctx.close();
  }

  // K5: Write holds the zoom; a turn refits it and Write keeps holding the new one.
  {
    const t = await open(browser);
    await place(t, 4, 0.5);
    await wait(800);
    await t.where.evaluate(() => document.getElementById("editSource").click());
    await t.where.waitForFunction(() => document.body.classList.contains("writeMode"));
    await wait(1500);
    for (const to of [SIDE, UP]) {
      const r = await turn(t, to, "K5 Write on");
      check(!/^(auto|page-fit|page-width)$/.test(r.later.value), `K5 Write on ${r.after.w}x${r.after.h}: the zoom is still held as a number`, r.later.value);
    }
    await t.where.evaluate(() => document.getElementById("editSource").click());
    await t.where.waitForFunction(() => !document.body.classList.contains("writeMode"));
    await wait(800);
    const off = await look(t.where);
    check(off.value === "page-width" && near(off.zoom, off.fit), "K5 Write off: the fit is back", `${off.value} ${fmt(off.zoom)}, fit ${fmt(off.fit)}`);
    check(!t.errors.length, "K4/K5: no page errors", t.errors.slice(0, 2).join(" | "));
    await t.ctx.close();
  }

  // K6: reading aloud, 1.5 s of silence per sentence, from three sentences before the end of page 5.
  {
    const t = await open(browser);
    const wav = silence(1.5);
    await t.page.route("**/api/tts", (r) => r.fulfill({ status: 200, contentType: "audio/wav", body: wav }));
    await t.where.evaluate(() => localStorage.setItem("reader.voice", ""));
    const n = await t.where.evaluate(async () => (await window.pdfReader.sentences(5)).length);
    await t.where.evaluate((i) => window.pdfReader.read(5, i), n - 3);
    await t.where.waitForFunction(() => window.pdfReader.cur()?.page === 5 && window.PDFViewerApplication.page === 5, null, { timeout: 15000 });
    await t.page.setViewportSize(SIDE);
    await wait(1500);
    const side = await t.where.evaluate(() => ({ view: window.PDFViewerApplication.page, reading: window.pdfReader.cur() }));
    check(side.view === 5 && side.reading?.page === 5, "K6 sideways while reading: the view stays on the page being read", JSON.stringify(side));
    const moved = await t.where.waitForFunction(() => window.pdfReader.cur()?.page === 6, null, { timeout: 30000 }).then(() => true).catch(() => false);
    await wait(800);
    const next = await t.where.evaluate(() => ({ view: window.PDFViewerApplication.page, reading: window.pdfReader.cur() }));
    check(moved && next.view === 6, "K6 the voice goes on to page 6 and the view follows it", JSON.stringify(next));
    await t.page.setViewportSize(UP);
    await wait(1500);
    const up = await t.where.evaluate(() => ({ view: window.PDFViewerApplication.page, reading: window.pdfReader.cur() }));
    check(up.view === up.reading?.page, "K6 upright again: the view is on the page being read", JSON.stringify(up));
    await t.where.evaluate(() => document.getElementById("readerPlay").click()); // pause
    check(!t.errors.length, "K6: no page errors", t.errors.slice(0, 2).join(" | "));
    await t.ctx.close();
  }

  // K6b (review, 2026-11-15): the voice turns the page inside the 600 ms after a turn. The view must go with it.
  {
    const t = await open(browser);
    const wav = silence(1.5);
    await t.page.route("**/api/tts", (r) => r.fulfill({ status: 200, contentType: "audio/wav", body: wav }));
    await t.where.evaluate(() => localStorage.setItem("reader.voice", ""));
    await t.where.evaluate(() => window.pdfReader.read(5, 0));
    await t.where.waitForFunction(() => window.pdfReader.cur()?.page === 5 && window.PDFViewerApplication.page === 5, null, { timeout: 15000 });
    await t.page.setViewportSize(SIDE);
    await wait(100);
    await t.where.evaluate(() => window.pdfReader.read(6, 0));
    await wait(1500);
    const r = await t.where.evaluate(() => ({ view: window.PDFViewerApplication.page, reading: window.pdfReader.cur() }));
    check(r.view === 6 && r.reading?.page === 6, "K6b the voice turns the page 100 ms after a turn: the view follows", JSON.stringify(r));
    await t.where.evaluate(() => document.getElementById("readerPlay").click());
    await t.ctx.close();
  }

  // K8 (review, 2026-11-15): at the very top of the document a turn keeps the top.
  {
    const t = await open(browser);
    await t.where.evaluate(() => { window.PDFViewerApplication.pdfViewer.container.scrollTop = 0; });
    await wait(500);
    for (const to of [SIDE, UP]) {
      await t.page.setViewportSize(to);
      await wait(1500);
      const top = await t.where.evaluate(() => window.PDFViewerApplication.pdfViewer.container.scrollTop);
      check(top === 0, `K8 at the top, turned to ${to.width}x${to.height}: still at the top`, `scrollTop ${top}`);
    }
    await t.ctx.close();
  }
} finally {
  await browser.close();
  await srv.stop();
}
console.log(failures ? `FAIL (${failures})` : "PASS");
process.exit(failures ? 1 : 0);
