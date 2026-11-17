// ✏️ Write (viewer/web/writer.js): tap a paragraph, type in it on the page, and the .md changes at once while the
// PDF follows in the background. A real browser on a throwaway document with its own .md, against a server this
// test starts itself (its own port and state folder, so nothing reaches the live viewer or his edit journal).
//   node test/writer.mjs            (Pi: PW_CHROMIUM=/usr/bin/chromium; exit 0 = PASS; pictures in /tmp/jarvis/writer-test)
// PHONE=1 runs it as a phone (411x922, touch).
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync, readlinkSync, writeFileSync, readFileSync, utimesSync, statSync, rmSync, existsSync, openSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const DIR = "/tmp/jarvis/writer-test";
const PORT = process.env.WRITER_TEST_PORT || 18831;
const PHONE = !!process.env.PHONE;
const MD = `${DIR}/w.md`, PDF = `${DIR}/w.pdf`;

mkdirSync(`${DIR}/state`, { recursive: true });
for (const f of ["state/edit-journal.jsonl", "state/built-from.json", "state/edit-drafts.json"]) rmSync(`${DIR}/${f}`, { force: true });
const long = Array(26).fill("This long paragraph keeps going so that it runs across the bottom of the first page and on to the next one, which the writer must handle.").join(" ");
writeFileSync(MD, `# Writer fixture

The first paragraph has **bold words**, *a phrase in italics* and [a link](https://example.com/a_b) in it, so the editor must show all three looks.

- A list item with its own bullet
- Another item, longer than the first one so that it wraps onto a second line of the page when printed at this size

> A quoted paragraph in a peach box, narrower than the column, so its lines break earlier than the body text does.

| a | table |
|---|---|
| goes to | the box |

## A heading in brown

${long}

The last paragraph is short.
`);
execFileSync("python3", [`${ROOT}md2pdf.py`, MD, PDF], { stdio: "ignore", env: { ...process.env, TC_SESSION_KEY: "" } });
const t0 = statSync(PDF).mtimeMs / 1000 - 30; // the source stays older than the PDF: no rebuild at start
utimesSync(MD, t0, t0);
const LINK = `${ROOT}papers/open/jarvistest/writer.pdf`;
mkdirSync(`${ROOT}papers/open/jarvistest`, { recursive: true });
try { if (readlinkSync(LINK) !== PDF) { rmSync(LINK); symlinkSync(PDF, LINK); } } catch { rmSync(LINK, { force: true }); symlinkSync(PDF, LINK); }

// The server writes to a file, not a pipe: a pipe left behind by a test that crashed breaks its every answer.
const LOG = `${DIR}/server.log`;
const server = spawn(`${ROOT}.venv/bin/python`, [`${ROOT}server.py`], {
  env: { ...process.env, PDF_REVIEW_PORT: String(PORT), PDF_REVIEW_OPEN_ROOTS: DIR, PDF_REVIEW_STATE: `${DIR}/state`, PDF_REVIEW_TRASH: `${DIR}/trash` },
  stdio: ["ignore", openSync(LOG, "w"), openSync(LOG, "a")],
});
process.on("exit", () => server.kill());
process.on("uncaughtException", (err) => { console.error(err); server.kill(); process.exit(1); });
const serverLog = { match: (re) => readFileSync(LOG, "utf8").match(re), split: (sep) => readFileSync(LOG, "utf8").split(sep) };
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/history`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const results = [];
const check = (name, ok, info = "") => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? `  (${info})` : ""}`); };
const md = () => readFileSync(MD, "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext(PHONE ? { viewport: { width: 411, height: 922 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true } : { viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|ERR_|404/.test(m.text())) errors.push(m.text()); });
await page.goto(`${BASE}/viewer/web/viewer.html?file=${encodeURIComponent("/papers/open/jarvistest/writer.pdf")}`);
await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && !!window.__pdfWriter, null, { timeout: 30000 });
await page.waitForSelector("#editSource:not([hidden])", { state: "attached", timeout: 15000 });
const pages = await page.evaluate(() => window.PDFViewerApplication.pdfViewer.pagesCount);
check("fixture has two pages", pages >= 2, `${pages}`);
const zoom0 = await page.evaluate(() => String(window.PDFViewerApplication.pdfViewer.currentScaleValue));
const posts = () => (serverLog.match(/POST \/api\/paragraph/g) || []).length;
const writeToggle = async (on) => {
  await page.evaluate(() => document.getElementById("editSource").click());
  await page.waitForFunction((v) => document.body.classList.contains("writeMode") === v, on);
  if (on) await wait(1200); // the page's text is read and the source fetched
};
await page.evaluate(() => document.getElementById("editSource").click());
await page.waitForFunction(() => document.body.classList.contains("writeMode"));
await wait(1200); // the page's text is read and the source fetched

// where a word of the printed page is on screen
const wordAt = (word, nth = 0) => page.evaluate(([w, k]) => {
  const hits = [];
  for (const sp of document.querySelectorAll("#viewer .textLayer span")) {
    const node = sp.firstChild;
    if (!node || node.nodeType !== 3) continue;
    let i = -1;
    while ((i = node.textContent.indexOf(w, i + 1)) >= 0) {
      const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + w.length);
      const b = r.getBoundingClientRect();
      if (b.width) hits.push({ x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, top: b.top, bottom: b.bottom, page: +sp.closest(".page").dataset.pageNumber });
    }
  }
  return hits[k] || null;
}, [word, nth]);
const tap = async (p) => { if (PHONE) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); };
// select a word inside the open editor
const selectInEditor = (w) => page.evaluate((word) => {
  const el = document.querySelector(".wrEd.wrOpen");
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const i = n.textContent.indexOf(word);
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return true;
  }
  return false;
}, w);
const editorAt = (w) => page.evaluate((word) => {
  const el = document.querySelector(".wrEd.wrOpen");
  if (!el) return null;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const i = n.textContent.indexOf(word);
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length);
    const b = r.getBoundingClientRect();
    return { left: b.left, top: b.top, bottom: b.bottom, font: getComputedStyle(n.parentElement).fontFamily, italic: getComputedStyle(n.parentElement).fontStyle };
  }
  return null;
}, w);
const swapped = async (word, ms = 25000) => {
  const start = Date.now();
  for (;;) {
    const s = await page.evaluate((w) => ({ eds: document.querySelectorAll(".wrEd").length, has: [...document.querySelectorAll("#viewer .textLayer")].some((t) => t.textContent.includes(w)) }), word);
    if (s.eds === 0 && s.has) return Date.now() - start;
    if (Date.now() - start > ms) return -1;
    await wait(150);
  }
};

// 1. tap a word: the paragraph becomes an editor, over the print, in the print's face
const italics = await wordAt("italics");
const tTap = Date.now();
await tap(italics);
await page.waitForSelector(".wrEd.wrOpen", { timeout: 5000 });
const opened = Date.now() - tTap;
const ed = await editorAt("italics");
check("tap opens an editor on the paragraph", !!ed, `${opened} ms`);
const firstPrint = await wordAt("paragraph"), firstEd = await editorAt("paragraph"); // no ligature in it: pdf.js splits "fi" into its own span
const dx = Math.abs(firstPrint.left - firstEd.left), dy = Math.abs(firstPrint.bottom - firstEd.bottom);
check("the editor's words sit on the printed words", dx < 3 && dy < 3, `dx ${dx.toFixed(1)} dy ${dy.toFixed(1)} px`);
check("in the PDF's own face, italics kept", /wr-DejaVuSerif/.test(ed?.font || "") && ed?.italic === "italic", `${ed?.font} ${ed?.italic}`);
const caretOk = await page.evaluate(() => { const s = getSelection(); return s.rangeCount && document.querySelector(".wrEd.wrOpen").contains(s.anchorNode); });
check("the caret is in the editor", caretOk);
await page.screenshot({ path: `${DIR}/1-open${PHONE ? "-phone" : ""}.png` });

// 2. replace a word inside italics: the .md keeps the * markers around the new words
await selectInEditor("italics");
const tType = Date.now();
await page.keyboard.type("slanted letters");
const shownNow = await page.evaluate(() => document.querySelector(".wrEd.wrOpen").innerText.includes("slanted letters"));
check("typed words show at once", shownNow, `${Date.now() - tType} ms for 15 keys`);
// typing saves nothing yet (each save is a rebuild on the Pi); the draft keeps the words
const posts0 = posts();
await wait(5000);
check("typing alone sends no save", posts() === posts0, `${posts() - posts0} saves in 5 s`);
// the phone's keyboard: the screen loses 40 % of its height with the editor open (his phone 2026-11-15: the page
// refit to the shorter screen, pdf.js redrew it and the editor closed a second after it opened)
const size0 = page.viewportSize();
const scale0 = await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale);
await page.setViewportSize({ width: size0.width, height: Math.round(size0.height * 0.6) });
await wait(1000);
const kb = await page.evaluate(() => { const el = document.querySelector(".wrEd.wrOpen"), v = window.PDFViewerApplication.pdfViewer; return { open: !!el, focused: !!el && document.activeElement === el, same: !!el && el.innerText.includes("slanted letters"), scale: v.currentScale, value: String(v.currentScaleValue) }; });
check("the keyboard leaves the editor open, focused and the zoom alone", kb.open && kb.focused && kb.same && Math.abs(kb.scale - scale0) < 1e-6, JSON.stringify(kb));
await page.setViewportSize(size0);
await wait(600);
// ✓ Done: the one button by the editor; it saves and closes, and no Markdown card appears
const done = await page.evaluate(() => { const b = document.querySelector(".wrDone"); if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2, h: Math.round(r.height), onScreen: r.left >= 0 && r.right <= innerWidth && r.top >= 0 }; });
check("✓ Done is there, labelled, finger-sized, on screen", !!done && done.text.includes("Done") && done.h >= 30 && done.onScreen, JSON.stringify(done));
const tSave = Date.now();
await tap(done);
await page.waitForFunction(() => !document.querySelector(".wrEd.wrOpen"));
let saved = false;
for (let i = 0; i < 40 && !saved; i++) { saved = md().includes("*a phrase in slanted letters*"); if (!saved) await wait(100); }
check("Done saves: the .md holds the change, markers kept", saved, `${Date.now() - tSave} ms after Done`);
check("nothing else in the .md moved", md().includes("**bold words**") && md().includes("[a link](https://example.com/a_b)"));
await wait(400);
check("no Markdown card after Done", !(await page.evaluate(() => !!document.querySelector(".epWrap"))));
check("Done turns Write off: the ✏️ button is no longer pressed", await page.evaluate(() => document.getElementById("editSource")?.getAttribute("aria-pressed") === "false"));
await page.evaluate(() => { const b = document.getElementById("editSource"); if (b?.getAttribute("aria-pressed") !== "true") b.click(); }); // the next steps type again
// the rebuilt PDF waits while he is still writing: no reload between two paragraphs
await wait(7000);
const held = await page.evaluate(() => document.querySelectorAll(".wrEd").length === 1 && !document.querySelector(".wrFrame"));
check("while Write is on, the edit stays drawn and the page is not reloaded", held);
const frameSeen = page.waitForSelector(".wrFrame", { state: "attached", timeout: 25000 }).then(() => true).catch(() => false);
await writeToggle(false);
const swapMs = await swapped("slanted letters");
check("Write off: the rebuilt PDF swaps in", swapMs >= 0, `${(swapMs / 1000).toFixed(1)} s after Write off`);
check("under a still copy of the page (no blank flash)", await frameSeen);
check("the page stayed where it was", await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentPageNumber) === 1);
check("the zoom's fit is back with Write off", await page.evaluate(() => String(window.PDFViewerApplication.pdfViewer.currentScaleValue)) === zoom0, zoom0);
await writeToggle(true);

// 2b. (phone) held sideways, the way his phone was on 2026-11-15 10:31: 922x271, the keyboard leaves 151 px. The
// fit-to-width zoom moved with the side toolbar, pdf.js redrew the page and the editor closed 47 ms later.
if (PHONE) {
  await page.setViewportSize({ width: 922, height: 271 });
  await wait(1500);
  await page.evaluate(() => { window.PDFViewerApplication.pdfViewer.container.scrollTop = 0; });
  await wait(600);
  const w = await wordAt("editor");
  await tap(w);
  const opened2 = await page.waitForSelector(".wrEd.wrOpen", { timeout: 5000 }).then(() => true).catch(() => false);
  const s0 = await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale);
  for (const h of [179, 152, 151]) { await page.setViewportSize({ width: 922, height: h }); await wait(150); }
  await wait(900);
  const side = await page.evaluate(() => { const el = document.querySelector(".wrEd.wrOpen"); return { open: !!el, focused: !!el && document.activeElement === el, scale: window.PDFViewerApplication.pdfViewer.currentScale }; });
  check("sideways, the keyboard leaves the editor open, focused and the zoom alone", opened2 && side.open && side.focused && Math.abs(side.scale - s0) < 1e-6, JSON.stringify({ opened2, ...side, s0 }));
  await page.keyboard.press("Escape");
  await page.setViewportSize(size0);
  await wait(1500);
}

// 3. a paragraph that grows: the text below moves down with it, at once
await tap(await wordAt("looks"));
await page.waitForSelector(".wrEd.wrOpen");
const before = await page.evaluate(() => document.querySelector(".wrEd.wrOpen").offsetHeight);
await page.evaluate(() => { const el = document.querySelector(".wrEd.wrOpen"); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
await page.keyboard.type(" Here is a whole new sentence, long enough to need another line or two of the page when it is printed.");
await page.waitForTimeout(200);
const grown = await page.evaluate(() => ({ h: document.querySelector(".wrEd.wrOpen").offsetHeight, shift: !!document.querySelector(".wrShift") }));
check("a growing paragraph pushes the text below down", grown.h > before && grown.shift, `${before} -> ${grown.h} px`);
await page.screenshot({ path: `${DIR}/3-grown${PHONE ? "-phone" : ""}.png` });

// 4. tapping the next paragraph closes this one (saved) and opens that one; Enter there makes two paragraphs
const bullet = await wordAt("bullet");
await tap({ x: bullet.x, y: bullet.y + (grown.h - before) }); // the item has moved down on screen
await page.waitForFunction(() => document.querySelector(".wrEd.wrOpen")?.innerText.includes("bullet"), null, { timeout: 5000 }).catch(() => {});
const onItem = await page.evaluate(() => document.querySelector(".wrEd.wrOpen")?.innerText || "");
check("a tap on the moved text opens that item", onItem.includes("A list item with its own bullet"), onItem.slice(0, 40));
await selectInEditor("with");
await page.evaluate(() => getSelection().collapseToStart());
await page.keyboard.press("Enter");
await page.keyboard.press("Escape");
let split = false;
for (let i = 0; i < 40 && !split; i++) { split = md().includes("- A list item\n- with its own bullet") && md().includes("Here is a whole new sentence"); if (!split) await wait(100); }
check("Enter in a list item makes a new item; the grown paragraph was saved", split);

// 5. the paragraph that runs on to page 2: tapping its part on page 2 edits only that part
const p2 = await page.evaluate(() => {
  const L = document.querySelector('#viewer .page[data-page-number="2"] .textLayer');
  return !!L;
});
await page.evaluate(() => { const v = window.PDFViewerApplication.pdfViewer; v.currentPageNumber = 2; });
await wait(800);
let cont = null;
for (let k = 0; k < 40 && !cont; k++) { const h = await wordAt("handle", k); if (h?.page === 2) cont = h; }
check("the long paragraph continues on page 2", p2 !== null && !!cont);
if (cont) {
  await tap(cont);
  await page.waitForSelector(".wrEd.wrOpen", { timeout: 5000 });
  const part = await page.evaluate(() => { const el = document.querySelector(".wrEd.wrOpen"); return { text: el.innerText, page: +el.closest(".page").dataset.pageNumber }; });
  const longWords = long.split(" ").length, partWords = part.text.split(/\s+/).length;
  check("only the page-2 part is in the editor", part.page === 2 && partWords < longWords, `${partWords} of ${longWords} words`);
  await page.evaluate(() => { const el = document.querySelector(".wrEd.wrOpen"); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.keyboard.type(" Written on page two.");
  await page.keyboard.press("Escape");
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { ok = md().includes("which the writer must handle. Written on page two.\n"); if (!ok) await wait(100); }
  check("the page-2 words land at the end of the right block", ok);
}

// 7. every save is in the journal, and all of it reaches the PDF
await writeToggle(false);
const swap2 = await swapped("Written on page two", 30000); // page 2 is on screen: its words are in its text layer
check("the PDF catches up with every edit", swap2 >= 0);
await writeToggle(true);
// 6. (after the swap) a table is not just words: the Markdown box opens instead
await page.evaluate(() => { window.PDFViewerApplication.pdfViewer.currentPageNumber = 1; });
await wait(600);
const table = await wordAt("goes to");
if (table) {
  await tap(table);
  const boxed = await page.waitForSelector(".epWrap", { timeout: 5000 }).then(() => true).catch(() => false);
  check("a table opens the Markdown box", boxed);
  if (boxed) await page.click(".epWrap .cancel");
} else check("the table is on the page", false);


const journal = existsSync(`${DIR}/state/edit-journal.jsonl`) ? readFileSync(`${DIR}/state/edit-journal.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
check("each save is in the journal", journal.length >= 4 && journal.every((j) => j.via === "writer"), `${journal.length} entries`);
const builds = (serverLog.match(/\[md2pdf\] w\.md -> w\.pdf: ok/g) || []).length;
check("one build per pause, not one per save", builds >= 1 && builds <= journal.length, `${builds} builds for ${journal.length} saves`);
check("no errors in the page", errors.length === 0, errors.slice(0, 3).join(" | "));
await page.screenshot({ path: `${DIR}/7-final${PHONE ? "-phone" : ""}.png` });

await browser.close();
server.kill();
const pass = results.every(Boolean);
if (!pass) console.log(serverLog.split("\n").filter((l) => /md2pdf|error|Traceback|POST \/api\/paragraph/.test(l)).slice(-15).join("\n"));
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
