// Phone gestures (2026-11-10): Comment tool = tap a word, box opens; Select tool = stable drag + handles, never
// leaves the page; Highlight button highlights the selection, or draws when nothing is selected; a highlight
// with no comment shows no comment icon beside it (2026-11-12; it showed one before). node test/select-gestures.mjs  (server on 127.0.0.1:18820; Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
import { fixtureUrl } from "./fixture.mjs";
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 411, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(fixtureUrl());
await page.waitForSelector(".textLayer span", { state: "attached", timeout: 60000 });
await page.waitForFunction(() => { const c = document.getElementById("viewerContainer"); const k = c.scrollTop; window.__st = window.__st && window.__st.k === k ? { k, n: window.__st.n + 1 } : { k, n: 0 }; return window.__st.n >= 6; }, null, { polling: 250, timeout: 30000 });
const cdp = await ctx.newCDPSession(page);
const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
const drag = async (x0, y0, x1, y1) => { await touch("touchStart", x0, y0); for (let i = 1; i <= 8; i++) await touch("touchMove", x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8); await touch("touchEnd"); await page.waitForTimeout(500); };
const lines = () => page.evaluate(() => [...document.querySelectorAll(".textLayer span")].filter((s) => s.textContent.trim().length > 25).map((s) => { const b = s.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }).filter((b) => b.y > 120 && b.y < 600 && document.elementFromPoint(b.x + 30, b.y + b.h / 2)?.closest(".textLayer") && !document.elementFromPoint(b.x + 30, b.y + b.h / 2)?.closest(".highlightEditor")));
const r = {};
const L = await lines();

// 1. Comment tool: one tap on a word opens the comment box.
await page.tap("#tapComment");
await page.touchscreen.tap(L[0].x + 30, L[0].y + L[0].h / 2);
await page.waitForSelector("#commentManagerDialog[open]", { timeout: 5000 });
r.tapOpensBox = true;
await page.tap("#commentManagerCancelButton");
await page.waitForTimeout(400);
await page.tap("#tapComment"); // off

// 2. Select tool: drag over two lines, then a handle drag far past the page: the selection stays on the page.
await page.tap("#selectTool");
await drag(L[1].x + 20, L[1].y + L[1].h / 2, L[2].x + L[2].w * 0.5, L[2].y + L[2].h / 2);
r.sel = await page.evaluate(() => String(getSelection()));
const end = await page.evaluate(() => { const b = document.querySelector(".selHandle.end").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
await drag(end.x, end.y, end.x + 10, 810); // small sideways nudge, then down into the toolbar row and the next page
r.selAfter = await page.evaluate(() => { const s = getSelection(); const la = s.anchorNode?.parentElement?.closest(".textLayer"), lf = s.focusNode?.parentElement?.closest(".textLayer"); return { len: String(s).length, samePage: !!la && la === lf }; });
r.stayedOnPage = r.selAfter.samePage && r.selAfter.len < 3000;

// 3. The toolbar Highlight button highlights the selection. Done twice: the first turns pdf.js's tool on and
// reveals the saved highlights, so the second one is the clean count (one more highlight, no comment icon).
await page.evaluate(() => getSelection().removeAllRanges());
const L1 = await lines();
await drag(L1[3].x + 10, L1[3].y + L1[3].h / 2, L1[3].x + L1[3].w * 0.5, L1[3].y + L1[3].h / 2);
const vis = () => page.evaluate(() => ({ hl: document.querySelectorAll(".highlightEditor").length, icons: [...document.querySelectorAll(".annotationCommentButton")].filter((b) => b.getBoundingClientRect().width > 0).length, sel: String(getSelection()).length, mode: window.PDFViewerApplication.pdfViewer.annotationEditorMode }));
await page.tap("#editorHighlightButton");
await page.waitForTimeout(900);
r.first = await vis();
const L2 = await lines();
const t = L2[L2.length - 1];
await drag(t.x + 10, t.y + t.h / 2, t.x + t.w * 0.5, t.y + t.h / 2);
r.selected2 = (await vis()).sel > 5;
r.before2 = await vis();
await page.tap("#editorHighlightButton");
await page.waitForTimeout(900);
r.after2 = await vis();
r.highlightedSelection = r.after2.hl - r.before2.hl;
r.newIcon = await page.evaluate(() => [...document.querySelectorAll(".hlCommentBtn, .annotationCommentButton")].filter((b) => b.getBoundingClientRect().width > 0).length);

console.log(JSON.stringify(r), JSON.stringify(errors));
const ok = r.tapOpensBox && r.sel.length > 20 && r.stayedOnPage && r.first.sel === 0 && r.highlightedSelection === 1 && r.newIcon === 0 && !errors.length;
await browser.close();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
