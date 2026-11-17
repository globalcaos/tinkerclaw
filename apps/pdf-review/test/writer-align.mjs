// Does ✏️ Write line up on a real document? Taps words across its pages and measures, for each editor that opens,
// how far its words sit from the printed ones and whether its lines break where the print's do.
//   node test/writer-align.mjs <some.pdf> [--phone]   (Pi: PW_CHROMIUM=/usr/bin/chromium; exit 0 = within limits)
// The PDF and the .md beside it are COPIED to /tmp/jarvis/writer-align and served by a server this starts itself:
// the real document is never opened, so nothing can be saved into it. Nothing is typed.
// 2026-11-15, the book's ch02: the fixture in writer.mjs passed while real chapters were 2-17 px off (a page box
// rounded smaller than its viewport, alternating line gaps, per-line text width); this is how that was found.
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, existsSync, rmSync, symlinkSync, openSync, utimesSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename } from "node:path";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const src = process.argv[2];
const PHONE = process.argv.includes("--phone");
if (!src || !existsSync(src) || !existsSync(src.replace(/\.pdf$/i, ".md"))) throw new Error("usage: node test/writer-align.mjs <a .pdf with its .md beside it> [--phone]");
const DIR = "/tmp/jarvis/writer-align", PORT = process.env.WRITER_ALIGN_PORT || 18841;
mkdirSync(`${DIR}/state`, { recursive: true });
const pdf = `${DIR}/${basename(src)}`, md = pdf.replace(/\.pdf$/i, ".md");
copyFileSync(src, pdf);
copyFileSync(src.replace(/\.pdf$/i, ".md"), md);
const t = statSync(pdf).mtimeMs / 1000 - 60;
utimesSync(md, t, t); // the copy's source older than its PDF: no rebuild
const LINK = `${ROOT}papers/open/jarvistest/align.pdf`;
rmSync(LINK, { force: true });
symlinkSync(pdf, LINK);
const LOG = `${DIR}/server.log`;
const server = spawn(`${ROOT}.venv/bin/python`, [`${ROOT}server.py`], {
  env: { ...process.env, PDF_REVIEW_PORT: String(PORT), PDF_REVIEW_OPEN_ROOTS: DIR, PDF_REVIEW_STATE: `${DIR}/state`, PDF_REVIEW_TRASH: `${DIR}/trash` },
  stdio: ["ignore", openSync(LOG, "w"), openSync(LOG, "a")],
});
process.on("exit", () => server.kill());
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/history`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext(PHONE ? { viewport: { width: 411, height: 922 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true } : { viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(`${BASE}/viewer/web/viewer.html?file=${encodeURIComponent("/papers/open/jarvistest/align.pdf")}`);
await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && !!window.__pdfWriter, null, { timeout: 30000 });
await page.waitForSelector("#editSource:not([hidden])", { state: "attached", timeout: 15000 });
await page.evaluate(() => document.getElementById("editSource").click());
await page.waitForTimeout(1500);
const N = await page.evaluate(() => window.PDFViewerApplication.pdfViewer.pagesCount);
const pages = [...new Set([1, 2, 4, 7, 11, 16, 22, 27, 35, 45].filter((p) => p <= N).concat(N))];
const out = { pages: N, taps: 0, editors: 0, box: 0, refused: 0, dx: [], dy: [], breaksDiffer: [], missing: [] };
for (const pn of pages) {
  await page.evaluate((n) => { window.PDFViewerApplication.pdfViewer.currentPageNumber = n; }, pn);
  await page.waitForTimeout(1200);
  const spans = await page.evaluate((n) => [...document.querySelectorAll(`#viewer .page[data-page-number="${n}"] .textLayer span`)]
    .map((sp, i) => ({ i, m: sp.firstChild?.nodeType === 3 ? /[A-Za-z]{6,}/.exec(sp.firstChild.textContent) : null })).filter((o) => o.m).map((o) => ({ i: o.i, t: o.m[0], at: o.m.index })), pn);
  for (const s of spans.filter((_, k) => k % Math.max(1, Math.floor(spans.length / 5)) === 0).slice(0, 5)) {
    out.taps++;
    const p = await page.evaluate(([n, i, at, len]) => {
      const sp = document.querySelectorAll(`#viewer .page[data-page-number="${n}"] .textLayer span`)[i];
      sp.scrollIntoView({ block: "center" });
      const g = document.createRange(); g.setStart(sp.firstChild, at); g.setEnd(sp.firstChild, at + len);
      const b = g.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, bottom: b.bottom };
    }, [pn, s.i, s.at, s.t.length]);
    if (PHONE) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(350);
    const r = await page.evaluate(async ([w, n]) => {
      if (document.querySelector(".epWrap")) return { kind: "box" };
      const el = document.querySelector(".wrEd.wrOpen");
      if (!el) return { kind: "none" };
      const hits = [], tops = new Set();
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        for (let i = 0; i < t.textContent.length; i++) { const g = document.createRange(); g.setStart(t, i); g.setEnd(t, i + 1); const b = g.getBoundingClientRect(); if (b.width) tops.add(Math.round(b.top)); }
        let i = -1;
        while ((i = t.textContent.indexOf(w, i + 1)) >= 0) { const g = document.createRange(); g.setStart(t, i); g.setEnd(t, i + w.length); const b = g.getBoundingClientRect(); hits.push({ left: b.left, bottom: b.bottom }); }
      }
      const P = (await window.__pdfWriter.paragraphs(n)).find((q) => q.text.replace(/\s+/g, " ").includes(el.innerText.replace(/\s+/g, " ").slice(0, 40)));
      return { kind: "editor", hits, lines: tops.size, printed: P?.lines.length ?? null };
    }, [s.t, pn]);
    if (r.kind === "editor") {
      out.editors++;
      const h = r.hits.sort((a, b) => Math.hypot(a.left - p.left, a.bottom - p.bottom) - Math.hypot(b.left - p.left, b.bottom - p.bottom))[0];
      if (!h) out.missing.push(`p${pn} ${s.t}`);
      else { out.dx.push(Math.abs(h.left - p.left)); out.dy.push(Math.abs(h.bottom - p.bottom)); }
      if (r.printed && r.lines !== r.printed) out.breaksDiffer.push(`p${pn} ${s.t}: ${r.lines} lines here, ${r.printed} printed`);
      await page.keyboard.press("Escape");
    } else if (r.kind === "box") { out.box++; await page.click(".epWrap .cancel"); }
    else out.refused++;
    await page.waitForTimeout(150);
  }
}
await browser.close();
const max = (a) => +Math.max(0, ...a).toFixed(1);
const res = { ...out, dx: undefined, dy: undefined, maxDx: max(out.dx), maxDy: max(out.dy), over1px: out.dx.filter((v, i) => v > 1 || out.dy[i] > 1).length, errs };
console.log(JSON.stringify(res, null, 1));
const ok = !errs.length && !out.missing.length && !out.breaksDiffer.length && res.maxDx <= 3 && res.maxDy <= 2;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
