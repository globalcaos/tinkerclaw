// Shared by test/contract-*.mjs (2026-11-15): "no mark and no edit is ever lost". Each test starts its own server
// (its own port, state folder and open roots, never the live viewer) on a throwaway document from fixture.mjs, and
// runs as the laptop (MODE=desktop: plain page, no offline engine) or the phone (MODE=phone: touch, small screen,
// offline engine on). Exit 0 = PASS.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, utimesSync, statSync, rmSync, openSync, copyFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fixtureDoc } from "./fixture.mjs";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
export const { chromium } = require("playwright");
export const ROOT = new URL("..", import.meta.url).pathname;
export const PY = `${ROOT}.venv/bin/python`;
export const MODE = process.env.MODE === "phone" ? "phone" : "desktop";
export const PHONE = MODE === "phone";
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms, step = 400) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await fn()) return true; await wait(step); }
  return !!(await fn());
}

let failures = 0;
export function check(ok, what, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  [${MODE}] ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}
export const failed = () => failures;

/** A server of this checkout on its own port: start(), stop(), the folder it may open, its state folder. */
export function testServer(name, port) {
  // CONTRACT_DIR and PORT_OFFSET let two checkouts run the set at once without touching each other.
  port += Number(process.env.PORT_OFFSET || 0);
  const dir = `${process.env.CONTRACT_DIR || "/tmp/jarvis/contract-test"}/${name}-${MODE}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/state`, { recursive: true });
  const log = `${dir}/server.log`;
  const s = {
    dir, state: `${dir}/state`, port, base: `http://127.0.0.1:${port}`, proc: null, log,
    async start() {
      s.proc = spawn(PY, [`${ROOT}server.py`], {
        env: { ...process.env, PDF_REVIEW_PORT: String(port), PDF_REVIEW_OPEN_ROOTS: dir, PDF_REVIEW_STATE: s.state, PDF_REVIEW_TRASH: `${dir}/trash`, TC_SESSION_KEY: "" },
        stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
      });
      for (let i = 0; i < 80; i++) { try { if ((await fetch(`${s.base}/api/history`)).ok) return; } catch {} await wait(250); }
      throw new Error("the test server did not start");
    },
    async stop() { if (!s.proc) return; const p = s.proc; s.proc = null; p.kill("SIGKILL"); await new Promise((r) => p.once("exit", r)); },
  };
  process.on("exit", () => s.proc?.kill("SIGKILL"));
  return s;
}

export const PARAS = [
  "Alpha opens the chapter with a sentence long enough to hold a comment on its first word.",
  "Bravo is the second paragraph, the one an agent rewrites while the reader marks the page.",
  "Charlie keeps going so that there is more to read and more words to put a highlight on.",
  "Delta sits near the end and carries the last comment the tests make on this page.",
  "Echo closes the page with one more line of plain words.",
];

/** A throwaway document in the server's folder: {md, pdf, served, url}. */
export function makeDoc(srv, name = "doc", paras = PARAS) {
  const d = fixtureDoc(srv.dir, `${name}-${MODE}`, paras);
  return { ...d, url: `${srv.base}/viewer/web/viewer.html?file=${encodeURIComponent(d.served)}` };
}

/** Rebuild the document as an agent or the server's builder would: new text for one paragraph, the marks on the
 *  file carried (keep) or the clean Apply build. Runs md2pdf.py, which holds the PDF's lock while it writes. */
export function rebuild(doc, { from = "Bravo is", to, keep = true } = {}) {
  let md = readFileSync(doc.md, "utf8");
  if (to) md = md.replace(new RegExp(`^${from}.*$`, "m"), to);
  writeFileSync(doc.md, md);
  const t = Date.now() / 1000 - 60; // the source stays older: the server's watcher does not build it a second time
  utimesSync(doc.md, t, t);
  const env = { ...process.env, PDF_REVIEW_STATE: process.env.PDF_REVIEW_STATE || "" };
  delete env.TC_SESSION_KEY;
  execFileSync("python3", [`${ROOT}md2pdf.py`, doc.md, doc.pdf, ...(keep ? ["--keep-marks"] : [])], { stdio: "ignore", env });
  const later = Date.now() / 1000 + 2; // a new Last-Modified second, as a real rebuild a moment later has
  utimesSync(doc.pdf, later, later);
}

/** Every note in the PDF on disk, as pdf-comments.py reads it. */
export const comments = (pdf) => execFileSync(PY, [`${ROOT}pdf-comments.py`, pdf], { encoding: "utf8" });
export const count = (pdf, note) => comments(pdf).split(note).length - 1;
export const pdfText = (pdf) => execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");

export async function launch() {
  return chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
}
export async function context(browser, mode = MODE) {
  const ctx = await browser.newContext(mode === "phone"
    ? { viewport: { width: 411, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1300, height: 900 } });
  if (mode === "phone") await ctx.addInitScript(() => localStorage.setItem("pdfreview.offline", "1"));
  // Apply comments must never wake a chat from a test.
  await ctx.route(/\/api\/redo/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  return ctx;
}
export async function open(ctx, url, errors = []) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${e.message}`));
  if (process.env.DEBUG) page.on("console", (m) => console.log(`  [page] ${m.type()} ${m.text()}`));
  await page.goto(url);
  await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && document.querySelector(".textLayer span"), null, { timeout: 60000 });
  await wait(2500); // autoreload.js has read the file's version (and the phone kept its copy)
  return page;
}

/** Select `word` on the page and put a comment on it through pdf.js's own commentSelection(). close=false leaves
 *  the comment box open with the note typed. */
export async function comment(page, word, note, { close = true } = {}) {
  const ok = await page.evaluate((w) => {
    for (const sp of document.querySelectorAll("#viewer .textLayer span")) {
      const node = sp.firstChild;
      const i = node?.nodeType === 3 ? node.textContent.indexOf(w) : -1;
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + w.length);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      window.PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.commentSelection("test");
      return true;
    }
    return false;
  }, word);
  if (!ok) throw new Error(`no "${word}" on the page`);
  await page.waitForSelector("#commentManagerDialog[open]", { timeout: 8000 });
  await page.type("#commentManagerTextInput", note, { delay: 15 });
  if (close) {
    await page.click("#commentManagerSaveButton");
    await wait(400);
  }
}

/** The notes the page shows: saved in the file it has open, or made on it and not saved yet. */
export const shown = (page) => page.evaluate(async () => {
  const app = window.PDFViewerApplication, doc = app.pdfDocument, out = [];
  if (!doc) return ""; // between two documents (a reload)
  for (let i = 1; i <= doc.numPages; i++) for (const a of await (await doc.getPage(i)).getAnnotations()) if (a.contentsObj?.str) out.push(a.contentsObj.str);
  for (const v of doc.annotationStorage.serializable.map?.values() ?? []) {
    const t = (v.popup?.contents ?? v.contents ?? "").toString();
    if (t && !v.popup?.deleted) out.push(t);
  }
  return [...new Set(out)].join("\n"); // a highlight and its popup both carry the note
});
export const waitingOnDevice = (page) => page.evaluate(() => window.__pdfJournal?.waiting() ?? 0);

/** Hold every PUT /api/save until release() (a slow upload); answers how many arrived. */
export async function holdSaves(page) {
  let open = null;
  const gate = { held: 0, release: () => {} };
  let release;
  const p = new Promise((r) => { release = r; });
  gate.release = release;
  await page.route(/\/api\/save/, async (route) => {
    gate.held++;
    await p;
    try { await route.continue(); } catch { try { await route.abort("connectionreset"); } catch {} }
  });
  gate.stop = () => page.unroute(/\/api\/save/);
  return gate;
}

export function finish(extra = 0) {
  const n = failures + extra;
  console.log(n ? `FAIL (${n})` : "PASS");
  process.exit(n ? 1 : 0);
}

export { readFileSync, writeFileSync, copyFileSync, statSync, mkdirSync, rmSync };
