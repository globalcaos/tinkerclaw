// An open Edit paragraph box comes back after the page dies (an app or gateway restart): same text, cursor
// where it was, and the server knows what was typed. Cancel leaves nothing, here or on the server.
// As a phone, on a throwaway PDF that has its own .md source (papers/open/jarvistest/e.pdf).
// node test/edit-reopen.mjs   (server on 127.0.0.1:$PDF_REVIEW_PORT, default 18820; Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync, lstatSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const PORT = process.env.PDF_REVIEW_PORT || 18820;
const DIR = "/tmp/jarvis/edit-reopen";
const OLD = "The second paragraph is the one the test edits, and it is long enough to find.";
mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}/e.md`, `# Edit reopen fixture\n\nThe first paragraph only fills the page.\n\n${OLD}\n`);
execFileSync("python3", [`${ROOT}md2pdf.py`, `${DIR}/e.md`, `${DIR}/e.pdf`], { stdio: "ignore" });
const t = statSync(`${DIR}/e.pdf`).mtimeMs / 1000 - 30; // the source stays older than the PDF: no watcher rebuild
utimesSync(`${DIR}/e.md`, t, t);
mkdirSync(`${ROOT}papers/open/jarvistest`, { recursive: true });
try { lstatSync(`${ROOT}papers/open/jarvistest/e.pdf`); } catch { symlinkSync(`${DIR}/e.pdf`, `${ROOT}papers/open/jarvistest/e.pdf`); }
const SERVED = "/papers/open/jarvistest/e.pdf";
const BASE = `http://127.0.0.1:${PORT}`;
const URL_ = `${BASE}/viewer/web/viewer.html?file=${encodeURIComponent(SERVED)}`;
const draftOnServer = async () => (await fetch(`${BASE}/api/editdraft?path=${encodeURIComponent(SERVED)}`)).json();

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 411, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const open = async () => {
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && !!window.__pdfEditPopup, null, { timeout: 30000 });
  return page;
};
const TEXT = "The second paragraph, half rewritten when the app died";
const CARET = 20;
let page = await open();
const block = await (await fetch(`${BASE}/api/paragraph?path=${encodeURIComponent(SERVED)}&q=${encodeURIComponent(OLD)}`)).json();
await page.evaluate(([b, p]) => window.__pdfEditPopup(b, p), [block, SERVED]);
await page.fill(".epText", TEXT);
await page.evaluate((c) => { const ta = document.querySelector(".epText"); ta.selectionStart = ta.selectionEnd = c; ta.dispatchEvent(new Event("keyup")); }, CARET);
await page.waitForTimeout(1200); // the debounced post
const server = await draftOnServer();
await page.close({ runBeforeUnload: false });

page = await open();
await page.waitForSelector(".epWrap .epText", { timeout: 8000 }).catch(() => {});
const back = await page.evaluate(() => {
  const ta = document.querySelector(".epWrap .epText");
  return ta ? { text: ta.value, caret: ta.selectionStart, focused: document.activeElement === ta, rescue: !!document.getElementById("draftRescue") } : null;
});
// The device's copy is lost too (app data cleared): the server's copy alone brings the box back.
await page.evaluate(() => localStorage.clear());
await page.close({ runBeforeUnload: false });
page = await open();
await page.waitForSelector(".epWrap .epText", { timeout: 8000 }).catch(() => {});
const fromServer = await page.evaluate(() => document.querySelector(".epWrap .epText")?.value ?? null);
// Cancel clears both copies: nothing comes back.
await page.click(".epWrap .cancel");
await page.waitForTimeout(500);
const afterCancelServer = await draftOnServer();
await page.close({ runBeforeUnload: false });
page = await open();
await page.waitForTimeout(2000);
const afterCancel = await page.evaluate(() => !!document.querySelector(".epWrap") || !!document.getElementById("draftRescue"));
await browser.close();
console.log({ server, back, fromServer, afterCancelServer, afterCancel });
const ok = server.text === TEXT && server.old === block.text && server.index === block.index
  && back?.text === TEXT && back.caret === CARET && back.focused && !back.rescue
  && fromServer === TEXT && !afterCancelServer.text && afterCancel === false;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
