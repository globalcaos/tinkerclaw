// ✓ Approve on a real document: is every blue paragraph's button where it belongs? (The writer passed its fixture
// while real chapters were off, 2026-11-15; this is the same check for the buttons.) It copies the PDF, its .md and
// its approved text (.approved/<name>.md, when there is one) to /tmp and serves the copy, so the document itself is
// only read. Nothing is pressed; the repaint a press makes is previewed on the page alone.
//   node test/approve-align.mjs <file.pdf> [--phone]   (Pi: PW_CHROMIUM=/usr/bin/chromium; exit 0 = PASS)
// Checks each button: on the page where its paragraph ends, right after the last word (or in the margin, or under
// the line, when the line runs to the margin), its top on that line's top, inside the page, over no printed word.
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync, copyFileSync, existsSync, rmSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const SRC = process.argv[2];
const PHONE = process.argv.includes("--phone");
if (!SRC || !existsSync(SRC)) { console.error("usage: node test/approve-align.mjs <file.pdf> [--phone]"); process.exit(2); }
const name = basename(SRC, ".pdf");
const DIR = `/tmp/jarvis/approve-align/${name}${PHONE ? "-phone" : ""}`;
const PORT = process.env.APPROVE_ALIGN_PORT || (PHONE ? 18838 : 18837);
mkdirSync(`${DIR}/.approved`, { recursive: true });
rmSync(`${DIR}/.approved/${name}.md`, { force: true }); // a copy from an earlier run; the copies below overwrite the rest
copyFileSync(SRC, `${DIR}/${name}.pdf`);
copyFileSync(join(dirname(SRC), `${name}.md`), `${DIR}/${name}.md`);
const store = join(dirname(SRC), ".approved", `${name}.md`);
if (existsSync(store)) copyFileSync(store, `${DIR}/.approved/${name}.md`);
const LINK = `${ROOT}papers/open/jarvistest/align-${name}${PHONE ? "-phone" : ""}.pdf`;
mkdirSync(dirname(LINK), { recursive: true });
rmSync(LINK, { force: true });
symlinkSync(`${DIR}/${name}.pdf`, LINK);
const served = `/papers/open/jarvistest/${basename(LINK)}`;

const LOG = `${DIR}/server.log`;
const server = spawn(`${ROOT}.venv/bin/python`, [`${ROOT}server.py`], {
  env: { ...process.env, PDF_REVIEW_PORT: String(PORT), PDF_REVIEW_OPEN_ROOTS: DIR, PDF_REVIEW_STATE: `${DIR}/state`, PDF_REVIEW_TRASH: `${DIR}/trash`, TC_SESSION_KEY: "" },
  stdio: ["ignore", openSync(LOG, "w"), openSync(LOG, "a")],
});
const done = (code) => { server.kill(); rmSync(LINK, { force: true }); process.exit(code); };
process.on("uncaughtException", (err) => { console.error(err); done(1); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/history`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const items = (await (await fetch(`${BASE}/api/approve?path=${encodeURIComponent(served)}`)).json()).items || [];
console.log(`${name}: ${items.length} blue paragraphs on ${new Set(items.map((it) => it.page)).size} pages`);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext(PHONE ? { viewport: { width: 411, height: 922 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true } : { viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${BASE}/viewer/web/viewer.html?file=${encodeURIComponent(served)}`);
await page.waitForFunction((n) => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && window.__pdfApprove?.items().length === n, items.length, { timeout: 60000 });
const L = await page.evaluate(async () => {
  const app = window.PDFViewerApplication;
  const out = [];
  const byPage = new Map();
  for (const it of window.__pdfApprove.items()) byPage.set(it.page, [...(byPage.get(it.page) || []), it]);
  for (const [n, its] of byPage) {
    app.pdfViewer.scrollPageIntoView({ pageNumber: n });
    const pv = app.pdfViewer.getPageView(n - 1);
    for (let k = 0; k < 80 && (pv.renderingState !== 3 || !pv.div.isConnected || !pv.div.querySelector(".textLayer span")); k++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    const div = pv.div, pr = div.getBoundingClientRect();
    const spans = [...div.querySelectorAll(".textLayer span")].filter((sp) => sp.textContent.trim()).map((sp) => [sp.getBoundingClientRect(), sp.textContent.trim()]);
    for (const it of its) {
      const b = div.querySelector(`:scope > .apBtn[data-index="${it.index}"]`);
      if (!b) { out.push({ index: it.index, page: n, missing: true }); continue; }
      const br = b.getBoundingClientRect();
      const sx = pr.left + div.clientLeft + (it.x / it.W) * div.clientWidth;
      const sy0 = pr.top + div.clientTop + (it.y0 / it.H) * div.clientHeight;
      const below = b.classList.contains("apBelow");
      const covers = spans.filter(([r]) => Math.min(r.right, br.right) - Math.max(r.left, br.left) > 1 && Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top) > 1).map(([, t]) => t.slice(-14));
      out.push({ index: it.index, page: n, form: below ? "below" : b.classList.contains("apIcon") ? "tick" : "label", gap: Math.round(br.left - sx),
        dtop: Math.round(br.top - (sy0 - 1)), inside: br.right <= pr.right - div.clientLeft + 0.5 && br.left >= pr.left, covers, old: it.old.slice(0, 40) });
    }
  }
  return out;
});
const bad = L.filter((b) => b.missing || !b.inside || b.covers.length || (!(b.form === "below") && (b.gap < 2 || b.gap > 6 || Math.abs(b.dtop) > 2)));
const forms = L.reduce((m, b) => ({ ...m, [b.form || "missing"]: (m[b.form || "missing"] || 0) + 1 }), {});
console.log(`forms: ${JSON.stringify(forms)}`);
for (const b of bad.slice(0, 12)) console.log(`FAIL p.${b.page} #${b.index} ${JSON.stringify(b)}`);
// ✓ Approve all (2026-11-17): on page 1, in the margin above its first printed line, inside the page, over no word.
const AL = await page.evaluate(async () => {
  const app = window.PDFViewerApplication;
  app.pdfViewer.scrollPageIntoView({ pageNumber: 1 });
  const pv = app.pdfViewer.getPageView(0);
  for (let k = 0; k < 80 && (pv.renderingState !== 3 || !pv.div.isConnected || !pv.div.querySelector(".textLayer span")); k++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  const div = pv.div, b = div.querySelector(":scope > .apAll");
  if (!b) return { missing: true };
  const br = b.getBoundingClientRect(), pr = div.getBoundingClientRect();
  let first = Infinity;
  const covers = [];
  for (const sp of div.querySelectorAll(".textLayer span")) {
    const r = sp.getBoundingClientRect();
    if (!r.width || !r.height || !sp.textContent.trim()) continue;
    first = Math.min(first, r.top);
    if (Math.min(r.right, br.right) - Math.max(r.left, br.left) > 1 && Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top) > 1) covers.push(sp.textContent.trim().slice(0, 14));
  }
  for (const im of div.querySelectorAll(".textLayerImages > *, img")) first = Math.min(first, im.getBoundingClientRect().top || Infinity);
  return { text: b.textContent, gap: Math.round(first - br.bottom), inside: br.left >= pr.left && br.right <= pr.right && br.top >= pr.top, covers };
});
const allOk = items.length ? !AL.missing && AL.gap >= 0 && AL.inside && !AL.covers.length : !!AL.missing;
console.log(`approve all: ${JSON.stringify(AL)}${allOk ? "" : "  FAIL"}`);
const firstPage = L[0]?.page;
if (firstPage) {
  await page.evaluate((n) => window.PDFViewerApplication.pdfViewer.scrollPageIntoView({ pageNumber: n }), firstPage);
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${DIR}/page-${firstPage}.png` });
}
// The repaint a press makes, on every page holding a blue line: each paragraph previewed as approved (on this page
// only, nothing is sent), then no blue may be left inside their printed lines, and the darkest repainted pixel must
// be the body's grey (#404040, 64).
const R = await page.evaluate(async () => {
  const app = window.PDFViewerApplication, its = window.__pdfApprove.items();
  const pages = [...new Set(its.flatMap((it) => it.lines.map((l) => l[0])))].sort((a, b) => a - b);
  const res = { pages: pages.length, painted: 0, blueLeft: 0, darkest: 255, where: [] };
  for (const n of pages) {
    app.pdfViewer.scrollPageIntoView({ pageNumber: n });
    const pv = app.pdfViewer.getPageView(n - 1);
    for (let k = 0; k < 80 && (pv.renderingState !== 3 || !pv.div.isConnected); k++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 200));
    const div = pv.div, cvs = [...div.querySelectorAll(".canvasWrapper canvas")];
    const before = cvs.map((cv) => cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data.slice());
    const mine = its.filter((it) => it.lines.some((l) => l[0] === n));
    window.__pdfApprove.preview(mine.map((it) => it.old));
    await new Promise((r) => setTimeout(r, 100));
    const pr = div.getBoundingClientRect(), ox = pr.left + div.clientLeft, oy = pr.top + div.clientTop;
    cvs.forEach((cv, ci) => {
      const a = before[ci], b = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      for (let k = 0; k < b.length; k += 4) {
        if (a[k] !== b[k] || a[k + 1] !== b[k + 1] || a[k + 2] !== b[k + 2]) { res.painted++; res.darkest = Math.min(res.darkest, b[k]); }
      }
      const cr = cv.getBoundingClientRect(), kx = cv.width / cr.width, ky = cv.height / cr.height;
      for (const it of mine) for (const [pg, x0, y0, x1, y1] of it.lines) {
        if (pg !== n) continue;
        const X0 = Math.max(0, Math.floor((ox + (x0 / it.W) * div.clientWidth - cr.left) * kx)), X1 = Math.min(cv.width, Math.ceil((ox + (x1 / it.W) * div.clientWidth - cr.left) * kx));
        const Y0 = Math.max(0, Math.floor((oy + (y0 / it.H) * div.clientHeight - cr.top) * ky)), Y1 = Math.min(cv.height, Math.ceil((oy + (y1 / it.H) * div.clientHeight - cr.top) * ky));
        for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
          const k = (y * cv.width + x) * 4;
          if (b[k + 2] > 150 && b[k + 2] - b[k] > 50) { res.blueLeft++; if (res.where.length < 5) res.where.push([n, it.index]); }
        }
      }
    });
  }
  return res;
});
console.log(`repaint: ${R.pages} pages, ${R.painted} pixels painted, darkest ${R.darkest}, blue left in approved lines ${R.blueLeft} ${JSON.stringify(R.where)}`);
const repaintOk = R.blueLeft === 0 && (items.length === 0 || (R.painted > 0 && Math.abs(R.darkest - 64) <= 6));
if (firstPage) {
  await page.evaluate((n) => window.PDFViewerApplication.pdfViewer.scrollPageIntoView({ pageNumber: n }), firstPage);
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${DIR}/page-${firstPage}-approved.png` });
}
if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`);
await browser.close();
const ok = L.length === items.length && !bad.length && !errors.length && repaintOk && allOk;
console.log(ok ? `PASS ${L.length} buttons` : `FAIL ${bad.length} of ${L.length} buttons`);
done(ok ? 0 : 1);
