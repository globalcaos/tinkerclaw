// End-to-end check of auto-reload: a PDF replaced on disk reopens on the same page,
// marks save themselves so a change on disk reopens without asking, the bar only appears when a
// save is still running, and 💾 Save writes the marked-up PDF over the original without a prompt.
// node test/autoreload.mjs A.pdf B.pdf   (two different PDFs of 3+ pages; needs server.py on 127.0.0.1:18820)
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");

const [A, B] = process.argv.slice(2);
if (!A || !B) throw new Error("usage: node test/autoreload.mjs A.pdf B.pdf");
const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "papers", "autoreload-test");
const WORK = fs.mkdtempSync("/tmp/autoreload-");
const FILE = path.join(WORK, "doc.pdf");
const URL = "http://127.0.0.1:18820/viewer/web/viewer.html?v=1&file=/papers/autoreload-test/doc.pdf";

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
// Polls from Node: page.waitForFunction treats a pending Promise as truthy and returns at once.
const until = async (fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    if (await fn()) return true;
  }
  return false;
};
// Same size and same second would look unchanged to a Last-Modified check: push the mtime forward.
const replace = (src) => {
  fs.copyFileSync(src, FILE);
  const t = new Date(Date.now() + 5000 + Math.random() * 1000);
  fs.utimesSync(FILE, t, t);
};

fs.mkdirSync(DIR, { recursive: true });
fs.copyFileSync(A, FILE);
fs.rmSync(path.join(DIR, "doc.pdf"), { force: true });
fs.symlinkSync(FILE, path.join(DIR, "doc.pdf"));

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  const fp = () => page.evaluate(() => PDFViewerApplication.pdfDocument?.fingerprints[0]);
  const pageNo = () => page.evaluate(() => PDFViewerApplication.page);

  await page.goto(URL);
  await until(async () => (await fp()) && (await page.evaluate(() => PDFViewerApplication.pagesCount)) > 2);
  await page.evaluate(() => (PDFViewerApplication.page = 3));
  await until(async () => (await pageNo()) === 3);
  const first = await fp();
  await new Promise((r) => setTimeout(r, 2500)); // let the watcher take its baseline

  replace(B);
  const changed = await until(async () => (await fp()) && (await fp()) !== first);
  check(changed, "the viewer reopens the file after it changes on disk");
  await until(async () => (await pageNo()) === 3, 5000);
  check((await pageNo()) === 3, "it stays on the same page", `page ${await pageNo()}`);

  // The reload never asks (2026-10-16). Case 1, the one the architect hit: the document already holds SAVED
  // marks (annotationStorage.size > 0, nothing unsaved). A changed file must reopen by itself, no bar.
  const second = await fp();
  const savedAt = fs.statSync(FILE).mtimeMs;
  await page.evaluate(() => PDFViewerApplication.pdfDocument.annotationStorage.setValue("test", { value: "x" }));
  await until(() => fs.statSync(FILE).mtimeMs !== savedAt, 8000); // the auto-save wrote it
  await new Promise((r) => setTimeout(r, 1500));
  replace(A);
  check(await until(async () => (await fp()) === first, 12000), "with saved marks, a changed file reopens by itself");
  check(!(await page.evaluate(() => !!document.getElementById("autoreloadBar"))), "and no bar appears");
  await new Promise((r) => setTimeout(r, 2500));

  // Case 2: a save that never finishes. The reload waits (up to 10 s), then reopens anyway, still no bar.
  await page.evaluate(() => {
    const orig = window.fetch;
    window.fetch = (url, opts) =>
      String(url).includes("/api/save") ? new Promise(() => {}) : orig(url, opts);
    PDFViewerApplication.pdfDocument.annotationStorage.setValue("test2", { value: "y" });
  });
  await new Promise((r) => setTimeout(r, 2600)); // the auto-save starts and hangs
  replace(B);
  check(await until(async () => (await fp()) === second, 20000), "with a save stuck, the file still reopens");
  check(!(await page.evaluate(() => !!document.getElementById("autoreloadBar"))), "and the bar never appears");
  await page.reload();
  await until(async () => (await fp()) && (await page.evaluate(() => PDFViewerApplication.pagesCount)) > 2);
  await new Promise((r) => setTimeout(r, 2500)); // the watcher takes a fresh baseline after the reload

  // Save (Ctrl+S; the Save buttons are gone since 2026-10-16, saving is automatic) writes the document
  // over the original file behind the papers/ link.
  // A real editor, not a bare storage entry: only an editor serializes into bytes pdf.js will write.
  await page.click("#editorFreeTextButton");
  const pageBox = await page.locator(".page").first().boundingBox();
  await page.mouse.click(pageBox.x + 150, pageBox.y + 150);
  await page.keyboard.type("note");
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 500));
  const before = fs.statSync(FILE);
  const fpBefore = await fp();
  await page.keyboard.press("Control+s");
  check(await until(() => fs.statSync(FILE).mtimeMs !== before.mtimeMs, 8000), "Save writes the original file");
  check(fs.readFileSync(FILE).subarray(0, 5).toString() === "%PDF-", "the saved file is a PDF");
  check(fs.lstatSync(path.join(DIR, "doc.pdf")).isSymbolicLink(), "the papers/ link is still a link");
  await new Promise((r) => setTimeout(r, 5000));
  check((await fp()) === fpBefore && !(await page.evaluate(() => !!document.getElementById("autoreloadBar"))),
    "its own save does not trigger a reload");
  // pdf.js's own Save buttons are hidden; 📂 Folder replaces them. Ctrl+S still writes the original,
  // with no download (no dialog).
  const shown = (id) => page.evaluate((id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null; }, id);
  check(!(await shown("downloadButton")) && !(await shown("secondaryDownload")), "the stock Save buttons are hidden");
  check(await shown("showInFolder"), "the Folder button is shown for a served file");
  check((await page.evaluate(async () => (await fetch("/api/reveal?path=/server.py", { method: "POST" })).status)) === 404,
    "Folder refuses a path outside papers/");
  let downloads = 0;
  page.on("download", () => downloads++);
  for (const [what, act] of [["Ctrl+S", () => page.keyboard.press("Control+s")]]) {
    await new Promise((r) => setTimeout(r, 3000));
    const t = fs.statSync(FILE).mtimeMs;
    await act();
    check(await until(() => fs.statSync(FILE).mtimeMs !== t, 8000), `${what} writes the original file`);
  }
  check(downloads === 0, "and it opens no download", `${downloads} downloads`);
  const put = (q, body) => page.evaluate(async ([q, body]) => (await fetch(`/api/save?path=${encodeURIComponent(q)}`,
    { method: "PUT", body })).status, [q, body]);
  check((await put("/server.py", "%PDF-x")) === 404, "Save refuses a path outside papers/");
  check((await put("/papers/../server.py", "%PDF-x")) === 404, "Save refuses a path climbing out of papers/");
  check((await put("/papers/autoreload-test/doc.pdf", "not a pdf")) === 400, "Save refuses a body that is not a PDF");
} finally {
  await browser.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
