// Undo / redo buttons and text selection on a phone (2026-10-23). the architect drew with Ink by mistake and had
// no way back; and a long-press selection showed only Android's cut-copy-paste menu, no Highlight /
// Comment bar, and highlighting was "very hard". Android ends a long-press that becomes a selection with
// pointercancel, never pointerup, and pdf.js waits for the pointerup. This test replays that gesture.
// node test/undo-select.mjs   (server on 127.0.0.1:18820; on the Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const LINK = `${ROOT}papers/open/jarvistest/t.pdf`;
let COPY = "/tmp/jarvis/tap-comment/t.pdf";
try { COPY = readlinkSync(LINK); } catch {}
mkdirSync(dirname(COPY), { recursive: true });
execFileSync("python3", [`${ROOT}md2pdf.py`, `${ROOT}README.md`, COPY], { stdio: "ignore" });
mkdirSync(`${ROOT}papers/open/jarvistest`, { recursive: true });
if (!existsSync(LINK) && !(() => { try { return lstatSync(LINK); } catch { return null; } })()) symlinkSync(COPY, LINK);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 411, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://127.0.0.1:18820/viewer/web/viewer.html?file=%2Fpapers%2Fopen%2Fjarvistest%2Ft.pdf");
await page.waitForSelector(".textLayer span", { state: "attached", timeout: 60000 });
await page.waitForTimeout(1500);
const r = {};
const mode = (m) => page.evaluate((m) => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { source: null, mode: m }), m);
const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

// 1. Undo / redo an ink stroke.
r.undoDisabledAtStart = await page.isDisabled("#editUndo");
await mode(15); // INK
await page.waitForTimeout(300);
const layer = await (await page.$(".page[data-page-number='1'] .annotationEditorLayer")).boundingBox();
await page.mouse.move(layer.x + 60, layer.y + 200);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(layer.x + 60 + i * 15, layer.y + 200 + (i % 2) * 20);
await page.mouse.up();
await mode(0);
await page.waitForTimeout(500);
r.inkAfterDraw = await count(".inkEditor");
r.undoEnabled = !(await page.isDisabled("#editUndo"));
await page.tap("#editUndo");
await page.waitForTimeout(400);
r.inkAfterUndo = await count(".inkEditor");
r.redoEnabled = !(await page.isDisabled("#editRedo"));
await page.tap("#editRedo");
await page.waitForTimeout(400);
r.inkAfterRedo = await count(".inkEditor");
await page.tap("#editUndo"); // leave the fixture clean
await page.waitForTimeout(300);

// 2. Android long-press: touch pointerdown, the selection, then pointercancel (no pointerup).
const longPress = (n) => page.evaluate((n) => {
  const spans = [...document.querySelectorAll(".page[data-page-number='1'] .textLayer span")].filter((s) => s.textContent.trim().length > 8);
  const s = spans[n];
  const b = s.getBoundingClientRect();
  const opt = { bubbles: true, isPrimary: true, pointerType: "touch", clientX: b.left + 5, clientY: b.top + 3 };
  s.dispatchEvent(new PointerEvent("pointerdown", opt));
  const range = document.createRange();
  range.selectNodeContents(s);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}, n);
const barShown = () => page.evaluate(() => {
  const bar = document.querySelector(".editToolbar .highlightButton")?.closest(".editToolbar");
  return !!bar && bar.getBoundingClientRect().width > 0;
});
const cancel = () => page.evaluate(() => dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, isPrimary: true, pointerType: "touch" })));

await longPress(1);
await page.waitForTimeout(400);
r.barBeforeCancel = await barShown(); // control: pdf.js is still waiting for the end of the gesture
await cancel();
await page.waitForTimeout(500);
r.barAfterCancel = await barShown();
await page.evaluate(() => getSelection().removeAllRanges());
await page.waitForTimeout(300);

await mode(9); // HIGHLIGHT
await page.waitForTimeout(300);
const before = await count(".highlightEditor");
await longPress(2);
await page.waitForTimeout(300);
await cancel();
await page.waitForTimeout(600);
r.highlightMade = (await count(".highlightEditor")) > before;
await browser.close();

const ok = r.undoDisabledAtStart && r.inkAfterDraw === 1 && r.undoEnabled && r.inkAfterUndo === 0 && r.redoEnabled
  && r.inkAfterRedo === 1 && !r.barBeforeCancel && r.barAfterCancel && r.highlightMade && errors.length === 0;
console.log(JSON.stringify({ ...r, errors }));
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
