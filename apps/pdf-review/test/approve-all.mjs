// ✓ Approve all (viewer/web/approve.js, 2026-11-17): when any paragraph prints blue, one button at the very beginning
// of the document approves them all. A real browser on a throwaway document whose .md marks new text in nw, against a
// server this test starts itself (its own port and state folder, so nothing reaches the live viewer or his journals).
//   node test/approve-all.mjs     (Pi: PW_CHROMIUM=/usr/bin/chromium; exit 0 = PASS; pictures in /tmp/jarvis/approve-all-test)
// PHONE=1 runs it as a phone (411x922, touch).
// Checks: the button is on page 1, in the margin above the first printed line, inside the page, over no word, quiet,
// with the count; a single approval lowers the count; one press sends one request, every button goes and page 1
// turns black at once; the note's ↶ Undo brings the buttons and the blue back and the Pi lists them again; a second
// Approve all ends with a rebuilt PDF that prints no blue and a .md with its words and no markers.
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync, readlinkSync, writeFileSync, readFileSync, utimesSync, statSync, rmSync, openSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const PHONE = !!process.env.PHONE;
const DIR = `/tmp/jarvis/approve-all-test${PHONE ? "-phone" : ""}`;
const PORT = process.env.APPROVE_ALL_PORT || (PHONE ? 18838 : 18837);
const MD = `${DIR}/b.md`, PDF = `${DIR}/b.pdf`;

mkdirSync(`${DIR}/state`, { recursive: true });
for (const f of ["state/approve-journal.jsonl", "state/built-from.json", "state/edit-drafts.json", "state/edit-journal.jsonl"]) rmSync(`${DIR}/${f}`, { force: true });
const filler = (n) => Array.from({ length: n }, (_, i) => `An old paragraph, number ${i + 1}, that has always been here and prints in the body grey; it only fills the page.`).join("\n\n");
const nw = (s) => `<div class="nw" markdown="1">\n\n${s}\n\n</div>`;
writeFileSync(MD, `# Approve all fixture

An old paragraph that has always been here, printed in the body grey, before anything new.

${nw("The first new paragraph of this round.\n\nThe second new paragraph, in the same marked block.")}

Some old words with <span class="nw">a phrase added this round</span> and more old words after it.

${filler(10)}

${nw("A new paragraph on the second page.")}

${filler(4)}

${nw("The last new paragraph, near the end.")}

The last old paragraph.
`);
execFileSync("python3", [`${ROOT}md2pdf.py`, MD, PDF], { stdio: "ignore", env: { ...process.env, TC_SESSION_KEY: "" } });
const t0 = statSync(PDF).mtimeMs / 1000 - 30; // the source stays older than the PDF: no rebuild at start
utimesSync(MD, t0, t0);
const NAME = `approve-all${PHONE ? "-phone" : ""}.pdf`;
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
const items = await blueList();
check("the server lists the five blue paragraphs", items.length === 5, items.map((it) => `${it.page}:${it.old.slice(0, 18)}`).join(" | "));
check("...on more than one page", new Set(items.map((it) => it.page)).size >= 2);

const ALL = "#viewer .page[data-page-number=\"1\"] > .apAll";
const top1 = async () => {
  await page.evaluate(() => window.PDFViewerApplication.pdfViewer.scrollPageIntoView({ pageNumber: 1 }));
  await page.waitForSelector(ALL, { timeout: 15000 });
  await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), ALL);
  await wait(300);
};
await top1();
const geo = await page.evaluate((s) => {
  const b = document.querySelector(s), div = b.closest(".page");
  const br = b.getBoundingClientRect(), pr = div.getBoundingClientRect();
  let firstTop = Infinity;
  const covers = [];
  for (const sp of div.querySelectorAll(".textLayer span")) {
    const r = sp.getBoundingClientRect();
    if (!r.width || !r.height || !sp.textContent.trim()) continue;
    firstTop = Math.min(firstTop, r.top);
    const ox = Math.min(r.right, br.right) - Math.max(r.left, br.left), oy = Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top);
    if (ox > 1 && oy > 1) covers.push(sp.textContent.trim().slice(0, 12));
  }
  const cs = getComputedStyle(b);
  return { text: b.textContent, top: Math.round(br.top - pr.top), bottom: Math.round(br.bottom), firstTop: Math.round(firstTop),
    inside: br.left >= pr.left && br.right <= pr.right && br.top >= pr.top, covers, h: Math.round(br.height),
    look: [cs.color, cs.backgroundColor, cs.boxShadow], all: document.querySelectorAll("#viewer .apAll").length };
}, ALL);
check("Approve all is on page 1, once", geo.all === 1, `${geo.all}`);
check("...says how many are blue", geo.text === `✓ Approve all (${items.length})`, geo.text);
check("...sits in the margin above the first printed line", geo.bottom <= geo.firstTop, `button ends ${geo.bottom}, first line at ${geo.firstTop}, ${geo.h} px tall`);
check("...inside the page and over no word", geo.inside && !geo.covers.length, JSON.stringify(geo.covers));
check("...quiet: the text's blue, no fill, no shadow", geo.look[0] === "rgb(30, 144, 255)" && geo.look[1] === "rgba(0, 0, 0, 0)" && geo.look[2] === "none", JSON.stringify(geo.look));
await page.screenshot({ path: `${DIR}/all-button.png` });

const tap = async (sel) => { if (PHONE) await page.tap(sel); else await page.click(sel); };
// A single approval first: the count on Approve all goes down by one.
const one = items.find((it) => it.page === 1);
const oneSel = `#viewer .apBtn[data-index="${one.index}"]`;
await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), oneSel);
await wait(300);
await tap(oneSel);
await page.waitForFunction(() => window.__pdfApprove.done().length === 1, null, { timeout: 10000 }).catch(() => {});
await top1();
check("a single approval lowers the count", (await page.textContent(ALL)) === `✓ Approve all (${items.length - 1})`, await page.textContent(ALL));

// One press approves them all in one request: every button goes and page 1 turns black at once; a note offers Undo.
const p0 = posts();
const loads0 = await page.evaluate(() => window.__loads);
await tap(ALL);
const tAll = Date.now();
await page.waitForFunction((n) => window.__pdfApprove.done().length === n, items.length, { timeout: 15000 }).catch(() => {});
const paraButtons = () => page.evaluate(() => { const v = window.PDFViewerApplication.pdfViewer; let n = 0; for (let i = 0; i < v.pagesCount; i++) n += v.getPageView(i).div.querySelectorAll(":scope > .apBtn:not(.apAll)").length; return n; });
check("one press approves them all in one request", posts() === p0 + 1 && (await page.evaluate(() => window.__pdfApprove.done().length)) === items.length, `${posts() - p0} requests, ${await page.evaluate(() => window.__pdfApprove.done().length)} done`);
check("...and every button goes, Approve all too", (await paraButtons()) === 0 && (await page.$$("#viewer .apAll")).length === 0);
// Blue pixels left on page 1, in the lines of its blue paragraphs (its own reading of blue: blue well above red).
const bluePx = () => page.evaluate(() => {
  const app = window.PDFViewerApplication;
  const div = app.pdfViewer.getPageView(0).div;
  const pr = div.getBoundingClientRect(), ox = pr.left + div.clientLeft, oy = pr.top + div.clientTop;
  let n = 0;
  for (const it of window.__pdfApprove.items()) for (const [pg, x0, y0, x1, y1] of it.lines) {
    if (pg !== 1) continue;
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
});
const b1 = await bluePx();
check("...and page 1 turns black at once", b1 === 0, `${b1} blue pixels, ${Date.now() - tAll} ms after the press`);
const note = await page.evaluate(() => { const n = document.querySelector(".apUndo"); return n ? { text: n.textContent, btn: !!n.querySelector("button") } : null; });
check("a note says how many were approved and offers Undo", note?.text === `${items.length - 1} approved. ↶ Undo` && note.btn, JSON.stringify(note));
await page.screenshot({ path: `${DIR}/undo-note.png` });

// ↶ Undo: the buttons come back at once and page 1 is drawn blue again; the rebuild prints them blue again.
await tap(".apUndo button");
await page.waitForFunction(() => window.__pdfApprove.done().length === 1, null, { timeout: 15000 }).catch(() => {});
await top1().catch(() => {});
await wait(1500);
const b2 = await bluePx();
check("Undo: the buttons come back at once", (await paraButtons()) === items.length - 1 && (await page.textContent(ALL)) === `✓ Approve all (${items.length - 1})`, `${await paraButtons()} buttons`);
check("...and page 1 is blue again", b2 > 30, `${b2} blue pixels`);
const mdUndone = readFileSync(MD, "utf8");
check("...and the .md has its markers back, except the one approved alone", (mdUndone.match(/class="nw"/g) || []).length >= 3 && mdUndone.includes("A new paragraph on the second page."));
for (let k = 0; k < 120 && (await blueList()).length !== items.length - 1; k++) await wait(500);
check("...and the Pi lists them as blue again", (await blueList()).length === items.length - 1, `${(await blueList()).length}`);

// Approve all again, for good: once the quiet is over, the rebuilt PDF comes in and prints no blue.
await page.waitForFunction((n) => window.__pdfApprove.items().length === n && !!document.querySelector('#viewer .page[data-page-number="1"] > .apAll'), items.length - 1, { timeout: 90000 }).catch(() => {});
await top1();
await tap(ALL);
await page.waitForFunction((n) => window.__pdfApprove.done().length >= n, items.length - 1, { timeout: 15000 }).catch(() => {});
const loads1 = await page.evaluate(() => window.__loads);
await page.waitForFunction((n) => window.__loads > n, loads1, { timeout: 90000 }).catch(() => {});
await wait(6000);
check("the rebuilt PDF comes in", (await page.evaluate(() => window.__loads)) > loads1, `${(await page.evaluate(() => window.__loads)) - loads0} loads in all`);
check("...and nothing prints blue any more", (await blueList()).length === 0);
const md = readFileSync(MD, "utf8");
check("the .md keeps its words, without a marker", !md.includes('class="nw"') && md.includes("A new paragraph on the second page.") && md.includes("a phrase added this round"));
const journal = readFileSync(`${DIR}/state/approve-journal.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("the journal: the single one, both Approve alls, and the undo", journal.filter((j) => j.all).length === 2 * (items.length - 1) && journal.filter((j) => j.undo).length === 1, `${journal.length} lines`);
check("no Approve all left", (await page.$$("#viewer .apAll")).length === 0);

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
server.kill();
rmSync(LINK, { force: true });
const failed = results.filter((x) => !x).length;
console.log(failed ? `FAIL: ${failed}` : "PASS");
process.exit(failed ? 1 : 0);
