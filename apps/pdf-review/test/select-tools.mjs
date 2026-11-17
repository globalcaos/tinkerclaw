// Selection and highlight tools on a phone (2026-11-12):
//   S1 a selection made without the Select tool (press and hold) brings up the reader's bar, not pdf.js's, and
//      since 2026-11-15 the reader's handles (the phone makes no selection of its own on the page any more)
//   S2 the colour picked on that bar is the colour the new highlight gets
//   S3 a highlight with no comment has no comment icon beside it
//   S4 a tap on a highlight brings up the bar with that highlight's tools: comment, colour, delete
//   S5 its comment button opens the comment box; the note is saved
//   S6 a colour changed there is the colour in the saved file, and after a reload
//   S7 a tap on a highlight saved in the file (after a reload) brings up the same tools; its colour changes too
//   S8 delete removes the highlight, in the file and after a reload
// Press and hold: CDP Input.dispatchTouchEvent (touchStart, 700 ms, touchEnd). Headless Chromium may not turn
// that into a word selection; then the selection is set with a Range (the browser fires selectionchange). Either
// way this proves the bar follows any selection in the text layer, not that a real phone's long press makes one.
// node test/select-tools.mjs   (server on 127.0.0.1:$PDF_REVIEW_PORT, default 18820; Pi: PW_CHROMIUM=/usr/bin/chromium)
// Screenshots go to $SHOTS (default /tmp/jarvis/select-tools).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readlinkSync } from "node:fs";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const SHOTS = process.env.SHOTS || "/tmp/jarvis/select-tools";
mkdirSync(SHOTS, { recursive: true });
const url = fixtureUrl();
const FILE = readlinkSync(`${ROOT}papers/open/jarvistest/t.pdf`);
const marks = () => JSON.parse(execFileSync(`${ROOT}.venv/bin/python`, ["-I", "-W", "ignore", "-c",
  "import pymupdf,sys,json; d=pymupdf.open(sys.argv[1]); print(json.dumps([['#%02X%02X%02X' % tuple(round(c*255) for c in (a.colors.get('stroke') or a.colors.get('fill'))), a.info.get('content')] for p in d for a in p.annots() if a.type[1]=='Highlight']))", FILE], { encoding: "utf8" }));

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 411, height: 922 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
const settle = async () => {
  await page.waitForSelector(".textLayer span", { state: "attached", timeout: 60000 });
  await page.waitForFunction(() => { const c = document.getElementById("viewerContainer"); const k = c.scrollTop; window.__st = window.__st && window.__st.k === k ? { k, n: window.__st.n + 1 } : { k, n: 0 }; return window.__st.n >= 6; }, null, { polling: 250, timeout: 30000 });
};
await page.goto(url);
await settle();
const cdp = await ctx.newCDPSession(page);
const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
const lines = () => page.evaluate(() => [...document.querySelectorAll(".textLayer span")].filter((s) => s.textContent.trim().length > 25).map((s, i) => { const b = s.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }).filter((b) => b.y > 150 && b.y < 600));
// Press and hold on a line; if that made no selection, select the first 20 characters of the line with a Range.
const holdSelect = async (L) => {
  await touch("touchStart", L.x + 30, L.y + L.h / 2);
  await page.waitForTimeout(700);
  await touch("touchEnd");
  await page.waitForTimeout(400);
  const held = await page.evaluate(() => String(getSelection()).trim().length > 0);
  if (!held) await page.evaluate(({ x, y }) => {
    const sp = [...document.querySelectorAll(".textLayer span")].find((s) => { const r = s.getBoundingClientRect(); return Math.abs(r.x - x) < 1 && Math.abs(r.y - y) < 1; });
    const t = sp.firstChild; getSelection().setBaseAndExtent(t, 0, t, Math.min(20, t.length));
  }, L);
  await page.waitForTimeout(400);
  return held;
};
const state = () => page.evaluate(() => {
  const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
  const um = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
  const bar = document.getElementById("selBar");
  return {
    sel: String(getSelection()).length,
    bar: vis(bar), forHighlight: bar.classList.contains("forHighlight"),
    buttons: [...bar.children].filter(vis).map((b) => b.id),
    handles: [...document.querySelectorAll(".selHandle")].some(vis),
    pdfjsSelBar: [...document.querySelectorAll(".editToolbar")].filter((t) => t.querySelector(".highlightButton")).some(vis),
    pdfjsHlBar: [...document.querySelectorAll(".highlightEditor .editToolbar")].some(vis),
    commentIcons: [...document.querySelectorAll(".hlCommentBtn, .annotationCommentButton")].filter(vis).length,
    mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
    editors: [...document.querySelectorAll(".annotationEditorLayer .highlightEditor")].map((d) => um.getEditor(d.id)?.color?.toUpperCase()),
    saved: document.querySelectorAll(".annotationLayer .highlightAnnotation:not([hidden])").length,
  };
});
// The centre of the n-th highlight on screen: a highlight editor, or a saved highlight after a reload.
const hlCentre = (n) => page.evaluate((n) => {
  const els = [...document.querySelectorAll(".annotationEditorLayer .highlightEditor, .annotationLayer .highlightAnnotation")].filter((e) => e.getBoundingClientRect().width > 0).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const r = els[n]?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
}, n);
const r = {};
const check = (name, ok, info) => { r[name] = ok; console.log(`${ok ? "ok  " : "FAIL"} ${name}${info === undefined ? "" : " " + JSON.stringify(info)}`); };

// S1, S2, S3: first highlight, red, made from a press-and-hold selection.
await page.evaluate(() => localStorage.setItem("reader.hlColor", "3"));
const L = await lines();
r.held = await holdSelect(L[0]);
console.log(`press and hold made a selection by itself: ${r.held}`);
let s = await state();
check("S1 bar and handles over a selection made without the Select tool", s.sel > 0 && s.bar && !s.forHighlight && s.handles && !s.pdfjsSelBar && s.buttons.includes("selHighlight") && s.buttons.includes("selColor"), s);
await page.screenshot({ path: `${SHOTS}/a-selection-bar.png` });
await page.tap("#selColor"); // 3 -> 4, red
await page.tap("#selHighlight");
await page.waitForTimeout(900);
s = await state();
check("S2 the new highlight has the colour picked", s.editors.length === 1 && s.editors[0] === "#FF4F5F", s.editors);
check("S3 no comment icon beside a highlight with no comment", s.commentIcons === 0, s.commentIcons);
await page.waitForTimeout(2500); // pdf.js leaves its Highlight tool (autoreload.js) and the autosave runs

// Second highlight, to delete later.
const L2 = await lines();
const far = L2.find((q) => q.y > L[0].y + 60) || L2[L2.length - 1];
await holdSelect(far);
await page.tap("#selHighlight");
await page.waitForTimeout(3500);

// S4, S5, S6: tap the first highlight, comment on it, change its colour.
let c = await hlCentre(0);
await page.touchscreen.tap(c.x, c.y);
await page.waitForTimeout(800);
s = await state();
check("S4 a tap on a highlight shows its tools: comment, colour, delete", s.bar && s.forHighlight && ["selComment", "selColor", "selDelete"].every((b) => s.buttons.includes(b)) && !s.buttons.includes("selHighlight") && !s.pdfjsHlBar && s.sel === 0, s);
await page.screenshot({ path: `${SHOTS}/b-highlight-tools.png` });
await page.tap("#selComment");
await page.waitForSelector("#commentManagerDialog[open]", { timeout: 5000 }).then(() => { r.boxOpened = true; }).catch(() => { r.boxOpened = false; });
if (r.boxOpened) { await page.type("#commentManagerTextInput", "select tools note"); await page.tap("#commentManagerSaveButton"); await page.waitForTimeout(600); }
s = await state();
check("S5 the comment button opens the comment box, and the tools stay open", r.boxOpened && s.bar && s.forHighlight, { box: r.boxOpened, bar: s.bar });
await page.tap("#selColor"); // red -> yellow
await page.tap("#selColor"); // yellow -> green
await page.waitForTimeout(300);
s = await state();
const green = s.editors.includes("#53FFBC");
await page.tap("#selClear");
await page.waitForTimeout(5000);
const m1 = marks();
s = await state();
check("S6 the colour changed on a tapped highlight is in the saved file", green && m1.some(([col, note]) => col === "#53FFBC" && note === "select tools note") && !s.bar && s.mode === 0, { m1, mode: s.mode });

// S8 (first half): delete the second highlight.
c = await hlCentre(1);
await page.touchscreen.tap(c.x, c.y);
await page.waitForTimeout(800);
s = await state();
r.delShown = s.forHighlight && s.buttons.includes("selDelete");
await page.tap("#selDelete");
await page.waitForTimeout(5000);
const m2 = marks();
check("S8a delete removes the highlight from the saved file", r.delShown && m2.length === 1 && m2[0][0] === "#53FFBC", m2);

// After a reload: the saved highlight keeps its colour; a tap on it shows the tools; colour and delete still work.
await page.reload();
await settle();
s = await state();
c = await hlCentre(0);
check("S6b after a reload the highlight is there, green, and the deleted one is not", s.saved === 1 && !!c && marks().length === 1, { saved: s.saved });
await page.touchscreen.tap(c.x, c.y);
await page.waitForTimeout(1200);
s = await state();
const blueBefore = s.editors;
check("S7 a tap on a highlight saved in the file shows its tools", s.bar && s.forHighlight && s.buttons.includes("selDelete") && s.buttons.includes("selColor"), s);
await page.tap("#selColor"); // green -> blue
await page.waitForTimeout(300);
await page.tap("#selClear");
await page.waitForTimeout(5000);
const m3 = marks();
check("S7b its colour changes in the file", m3.length === 1 && m3[0][0] === "#80EBFF" && m3[0][1] === "select tools note", { before: blueBefore, m3 });
await page.reload();
await settle();
c = await hlCentre(0);
await page.touchscreen.tap(c.x, c.y);
await page.waitForTimeout(1200);
s = await state();
check("S7c after another reload the highlight is blue", s.editors.length === 1 && s.editors[0] === "#80EBFF", s.editors);
await page.tap("#selDelete");
await page.waitForTimeout(5000);
await page.reload();
await settle();
s = await state();
check("S8b deleted: gone from the file and from the page after a reload", marks().length === 0 && s.saved === 0 && s.editors.length === 0, { file: marks(), saved: s.saved });

check("no page errors", errors.length === 0, errors);
await browser.close();
const ok = Object.entries(r).filter(([k]) => /^S|no page/.test(k)).every(([, v]) => v);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
