// ✓ Approve (viewer/web/approve.js): a paragraph printed blue keeps its colour until he presses the button at its
// end. A real browser on a throwaway document whose .md marks new text in nw, against a server this test starts
// itself (its own port and state folder, so nothing reaches the live viewer or his journals).
//   node test/approve.mjs        (Pi: PW_CHROMIUM=/usr/bin/chromium; exit 0 = PASS; pictures in /tmp/jarvis/approve-test)
// PHONE=1 runs it as a phone (411x922, touch).
// Checks: one button per blue paragraph, after its last word and inside the page (a paragraph cut by a page break
// gets it on the page where it ends), quiet (the text's blue, no fill, no shadow); a press removes the button and
// turns the paragraph black at once, and a redraw keeps it black; the rebuilt PDF comes in only after he stops
// approving for a while, once for several presses, and prints those paragraphs black; in ✏️ Write a press approves
// and opens no editor.
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync, readlinkSync, writeFileSync, readFileSync, utimesSync, statSync, rmSync, openSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const PHONE = !!process.env.PHONE;
const DIR = `/tmp/jarvis/approve-test${PHONE ? "-phone" : ""}`;
const PORT = process.env.APPROVE_TEST_PORT || (PHONE ? 18836 : 18835);
const MD = `${DIR}/a.md`, PDF = `${DIR}/a.pdf`;

mkdirSync(`${DIR}/state`, { recursive: true });
for (const f of ["state/approve-journal.jsonl", "state/built-from.json", "state/edit-drafts.json", "state/edit-journal.jsonl"]) rmSync(`${DIR}/${f}`, { force: true });
const filler = (n) => Array.from({ length: n }, (_, i) => `An old paragraph, number ${i + 1}, that has always been here and prints in the body grey; it only fills the page so the next new paragraph runs across the break.`).join("\n\n");
const long = Array(14).fill("This new paragraph keeps going across the bottom of the first page and on to the next one").join(", ") + ".";
const nw = (s) => `<div class="nw" markdown="1">\n\n${s}\n\n</div>`;
writeFileSync(MD, `# Approve fixture

An old paragraph that has always been here, printed in the body grey, before anything new.

${nw("A short new paragraph.")}

Some old words with <span class="nw">a phrase added this round</span> and more old words after it.

${nw("A second new paragraph, written this round, ends here.")}

${filler(9)}

${nw(long)}

The last old paragraph.
`);
execFileSync("python3", [`${ROOT}md2pdf.py`, MD, PDF], { stdio: "ignore", env: { ...process.env, TC_SESSION_KEY: "" } });
const t0 = statSync(PDF).mtimeMs / 1000 - 30; // the source stays older than the PDF: no rebuild at start
utimesSync(MD, t0, t0);
const NAME = `approve${PHONE ? "-phone" : ""}.pdf`;
const LINK = `${ROOT}papers/open/jarvistest/${NAME}`;
mkdirSync(`${ROOT}papers/open/jarvistest`, { recursive: true });
try { if (readlinkSync(LINK) !== PDF) { rmSync(LINK); symlinkSync(PDF, LINK); } } catch { rmSync(LINK, { force: true }); symlinkSync(PDF, LINK); }

const LOG = `${DIR}/server.log`;
const server = spawn(`${ROOT}.venv/bin/python`, [`${ROOT}server.py`], {
  env: { ...process.env, PDF_REVIEW_PORT: String(PORT), PDF_REVIEW_OPEN_ROOTS: DIR, PDF_REVIEW_STATE: `${DIR}/state`, PDF_REVIEW_TRASH: `${DIR}/trash`, TC_SESSION_KEY: "" },
  stdio: ["ignore", openSync(LOG, "w"), openSync(LOG, "a")],
});
process.on("exit", () => server.kill());
process.on("uncaughtException", (err) => { console.error(err); server.kill(); process.exit(1); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/history`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const results = [];
const check = (name, ok, info = "") => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? `  (${info})` : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const posts = () => (readFileSync(LOG, "utf8").match(/POST \/api\/approve/g) || []).length;
const blueList = async () => (await (await fetch(`${BASE}/api/approve?path=${encodeURIComponent(`/papers/open/jarvistest/${NAME}`)}`)).json()).items;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext(PHONE ? { viewport: { width: 411, height: 922 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true } : { viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|ERR_|404/.test(m.text())) errors.push(m.text()); });
await page.goto(`${BASE}/viewer/web/viewer.html?file=${encodeURIComponent(`/papers/open/jarvistest/${NAME}`)}`);
await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && !!window.__pdfApprove, null, { timeout: 30000 });
await page.evaluate(() => {
  window.__loads = 0;
  window.PDFViewerApplication.eventBus.on("documentloaded", () => { window.__loads++; window.__loadedAt = Date.now(); });
});
const pages = await page.evaluate(() => window.PDFViewerApplication.pdfViewer.pagesCount);
check("fixture has two pages", pages >= 2, `${pages}`);

const items = await blueList();
check("the server lists the four blue paragraphs", items.length === 4, items.map((it) => `${it.page}:${it.old.slice(0, 18)}`).join(" | "));

// Where each button is, against the end of its paragraph's last line on screen, measured with its page shown (one
// page at a time, pdf.js keeps only that page in the document).
const layout = async () => page.evaluate(async () => {
  const app = window.PDFViewerApplication;
  const out = [];
  for (const it of window.__pdfApprove.items()) {
    app.pdfViewer.scrollPageIntoView({ pageNumber: it.page });
    const pv = app.pdfViewer.getPageView(it.page - 1);
    for (let k = 0; k < 60 && (pv.renderingState !== 3 || !pv.div.isConnected); k++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 250));
    const div = pv.div;
    const b = div.querySelector(`:scope > .apBtn[data-index="${it.index}"]`);
    if (!b) { out.push({ index: it.index, missing: true }); continue; }
    const pr = div.getBoundingClientRect(), br = b.getBoundingClientRect();
    const sx = pr.left + div.clientLeft + (it.x / it.W) * div.clientWidth;
    const sy0 = pr.top + div.clientTop + (it.y0 / it.H) * div.clientHeight;
    const below = b.classList.contains("apBelow");
    // Printed words under the button: the text layer's boxes on that page that overlap it by more than a pixel.
    const covers = [];
    for (const sp of div.querySelectorAll(".textLayer span")) {
      const r = sp.getBoundingClientRect();
      if (!r.width || !r.height || !sp.textContent.trim()) continue;
      const ox = Math.min(r.right, br.right) - Math.max(r.left, br.left), oy = Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top);
      if (ox > 1 && oy > 1) covers.push(sp.textContent.trim().slice(-12));
    }
    out.push({ index: it.index, page: it.page, text: b.textContent, form: below ? "below" : b.classList.contains("apIcon") ? "tick" : "label",
      gap: Math.round(br.left - sx), dtop: Math.round(br.top - (sy0 - 1)), inside: br.right <= pr.right - div.clientLeft + 0.5,
      h: Math.round(br.height), below, covers });
  }
  return out;
});
// Every page's buttons, the pages pdf.js keeps out of the document included.
const buttonCount = () => page.evaluate(() => {
  const v = window.PDFViewerApplication.pdfViewer;
  let n = 0;
  for (let i = 0; i < v.pagesCount; i++) n += v.getPageView(i).div.querySelectorAll(":scope > .apBtn:not(.apAll)").length; // paragraph buttons; Approve all is test/approve-all.mjs
  return n;
});
await page.waitForFunction(() => document.querySelectorAll("#viewer .apBtn").length >= 1, null, { timeout: 20000 });
console.log(`     (scroll mode ${await page.evaluate(() => window.PDFViewerApplication.pdfViewer.scrollMode)})`);
let L = await layout();
check("one button per blue paragraph", L.length === 4 && L.every((b) => !b.missing), JSON.stringify(L.map((b) => b.index)));
check("each button starts right after its paragraph's last word", L.every((b) => b.below || (b.gap >= 2 && b.gap <= 6)), JSON.stringify(L.map((b) => [b.form, b.gap])));
check("...its top on the top of that last line", L.every((b) => b.below || Math.abs(b.dtop) <= 2), JSON.stringify(L.map((b) => [b.dtop, b.h])));
check("...inside the page", L.every((b) => b.inside), JSON.stringify(L.map((b) => [b.form, b.inside])));
check("...and over no printed word", L.every((b) => !b.covers.length), JSON.stringify(L.map((b) => b.covers)));
const longItem = items.find((it) => it.old.includes("keeps going across"));
check("a paragraph cut by the page break gets its button where it ends, on page 2", longItem?.page === 2 && L.find((b) => b.index === longItem.index)?.page === 2);
check("the paragraph with a new phrase in it has one too", items.some((it) => it.old.includes("phrase added")));
await page.screenshot({ path: `${DIR}/buttons.png` });

// A press: the button goes and the paragraph turns black at once (16:03); the rebuilt PDF comes in only after he
// stops pressing for a while (8 s), once.
const show = async (index) => {
  const sel = `#viewer .apBtn[data-index="${index}"]`;
  // pdf.js empties a page it is not showing: go to the page first, and its buttons are drawn again with it.
  const pg = (await page.evaluate(() => window.__pdfApprove.items())).find((it) => it.index === index)?.page || 1;
  await page.evaluate((n) => window.PDFViewerApplication.pdfViewer.scrollPageIntoView({ pageNumber: n }), pg);
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sel);
  await wait(300);
  return sel;
};
const press = async (index) => {
  const sel = await show(index);
  if (PHONE) await page.tap(sel); else await page.click(sel);
};
// Blue pixels the page shows inside one paragraph's printed lines, on every canvas of its page (its own reading of
// "blue", not approve.js's: a blue channel well above the red one).
const bluePx = (index) => page.evaluate((i) => {
  const app = window.PDFViewerApplication;
  const it = window.__pdfApprove.items().find((x) => x.index === i);
  if (!it) return -1;
  let n = 0;
  for (const [pg, x0, y0, x1, y1] of it.lines) {
    const div = app.pdfViewer.getPageView(pg - 1).div;
    if (!div.isConnected) continue;
    const pr = div.getBoundingClientRect(), ox = pr.left + div.clientLeft, oy = pr.top + div.clientTop;
    for (const cv of div.querySelectorAll(".canvasWrapper canvas")) {
      const cr = cv.getBoundingClientRect();
      if (!cr.width) continue;
      const kx = cv.width / cr.width, ky = cv.height / cr.height;
      const X0 = Math.max(0, Math.floor((ox + (x0 / it.W) * div.clientWidth - cr.left) * kx)), X1 = Math.min(cv.width, Math.ceil((ox + (x1 / it.W) * div.clientWidth - cr.left) * kx));
      const Y0 = Math.max(0, Math.floor((oy + (y0 / it.H) * div.clientHeight - cr.top) * ky)), Y1 = Math.min(cv.height, Math.ceil((oy + (y1 / it.H) * div.clientHeight - cr.top) * ky));
      if (X1 <= X0 || Y1 <= Y0) continue;
      const d = cv.getContext("2d").getImageData(X0, Y0, X1 - X0, Y1 - Y0).data;
      for (let k = 0; k < d.length; k += 4) if (d[k + 2] > 150 && d[k + 2] - d[k] > 50) n++;
    }
  }
  return n;
}, index);
const short = items.find((it) => it.old.includes("A short new"));
const second = items.find((it) => it.old.includes("A second new"));
const sel1 = await show(short.index);
const look = await page.evaluate((s) => { const cs = getComputedStyle(document.querySelector(s)); return [cs.color, cs.backgroundColor, cs.boxShadow]; }, sel1);
check("the button is quiet: the text's blue, no fill, no shadow", look[0] === "rgb(30, 144, 255)" && look[1] === "rgba(0, 0, 0, 0)" && look[2] === "none", JSON.stringify(look));
const blue0 = await bluePx(short.index);
check("before the press the paragraph prints blue", blue0 > 30, `${blue0} blue pixels`);
const p0 = posts();
const loads0 = await page.evaluate(() => window.__loads);
if (PHONE) await page.tap(sel1); else await page.click(sel1);
const t1 = Date.now();
check("pressed, the button goes at once", (await page.$(sel1)) === null);
await page.waitForFunction(() => window.__pdfApprove.done().length === 1, null, { timeout: 10000 }).catch(() => {});
const blue1 = await bluePx(short.index);
check("...and the paragraph turns black at once", blue1 === 0, `${blue0} -> ${blue1} blue pixels, ${Date.now() - t1} ms after the press`);
check("...the other blue paragraphs stay blue", (await bluePx(second.index)) > 30, `${await bluePx(second.index)} blue pixels`);
check("...and the server took it", posts() === p0 + 1);
check("the .md: that paragraph left its nw block", !/<div class="nw" markdown="1">\s*A short new paragraph/.test(readFileSync(MD, "utf8")) && readFileSync(MD, "utf8").includes("A short new paragraph."));
await page.screenshot({ path: `${DIR}/pressed.png` });
// pdf.js draws the page again on a zoom: the approved paragraph stays black, the button stays gone.
const zoom0 = await page.evaluate(() => { const v = window.PDFViewerApplication.pdfViewer; const z = String(v.currentScaleValue); v.currentScale = v.currentScale * 1.3; return z; });
await wait(2500);
check("a zoom redraws the page and it stays black", (await bluePx(short.index)) === 0 && (await page.$(sel1)) === null, `${await bluePx(short.index)} blue pixels`);
await page.evaluate((z) => { window.PDFViewerApplication.pdfViewer.currentScaleValue = z; }, zoom0);
await wait(2500);
await press(second.index);
await page.waitForFunction(() => window.__pdfApprove.done().length === 2, null, { timeout: 10000 }).catch(() => {});
const t2 = Date.now();
await page.waitForFunction((n) => window.__loads > n, loads0, { timeout: 60000 }).catch(() => {});
const loadedAt = await page.evaluate(() => window.__loadedAt || 0);
check("the rebuilt PDF comes in once he stops approving", loadedAt > 0 && loadedAt - t2 >= 7500, `${Math.round((loadedAt - t2) / 1000)} s after the second press, ${Math.round((loadedAt - t1) / 1000)} s after the first`);
await wait(6000);
check("...once for both presses", (await page.evaluate(() => window.__loads)) === loads0 + 1, `${(await page.evaluate(() => window.__loads)) - loads0} loads`);
const after = await blueList();
check("both print black now; the other two stay blue", after.length === 2 && !after.some((it) => /A short new|A second new/.test(it.old)), after.map((it) => it.old.slice(0, 24)).join(" | "));
for (let k = 0; k < 60 && (await buttonCount()) !== 2; k++) await wait(250);
check("the page shows two buttons now", (await buttonCount()) === 2, `${await buttonCount()}`);

// In ✏️ Write a press on the button approves; it opens no editor.
await page.waitForSelector("#editSource:not([hidden])", { state: "attached", timeout: 15000 });
await page.evaluate(() => document.getElementById("editSource").click());
await page.waitForFunction(() => document.body.classList.contains("writeMode"));
await wait(1200);
const phrase = after.find((it) => it.old.includes("phrase added"));
const p1 = posts();
await press(phrase.index);
await page.waitForFunction((t) => window.__pdfApprove.done().includes(t), phrase.old, { timeout: 10000 }).catch(() => {});
check("in Write a press approves", posts() === p1 + 1 && readFileSync(MD, "utf8").includes("Some old words with a phrase added this round and more"));
check("...the phrase turns black at once", (await bluePx(phrase.index)) === 0, `${await bluePx(phrase.index)} blue pixels`);
check("...and opens no editor", (await page.evaluate(() => document.querySelectorAll(".wrEd.wrOpen").length)) === 0);
await page.screenshot({ path: `${DIR}/write-mode.png` });

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
server.kill();
rmSync(LINK, { force: true });
const failed = results.filter((x) => !x).length;
console.log(failed ? `FAIL: ${failed}` : "PASS");
process.exit(failed ? 1 : 0);
