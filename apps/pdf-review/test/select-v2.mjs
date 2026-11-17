// Selecting, comments and press and hold, v2 (the architect 2026-11-15 17:01). One check per requirement, as the laptop
// (MODE=desktop, 1744x1360) and as his phone (MODE=phone, 411x922 at dpr 2.625):
//   R1 two clicks (two taps) on a word with no tool or 💬 Comment on select it with its menu (laptop: pdf.js's bar
//      with Comment and Highlight; phone: the reader's bar and handles), no marking, no comment box; the selection
//      grows (laptop: shift-click; phone: the end handle)
//   R2 with 💬 Comment on, one click on a word gives a marking and its comment box
//   R3 that box closed with no words (Cancel; Done after typing and deleting) takes the marking off the page and out
//      of the saved file; the words stay selected with their menu; ↶ and ↷ stand where they stood. A marking made
//      on purpose (Highlight) or with a saved comment stays
//   R4 a click on a marking (made now, and saved then reloaded; with and without a comment) shows its tools and no
//      comment card, with no tool, 💬 Comment, Select or Highlight on
//   R5 a press on a marking's comment icon opens its comment card with no tool, 💬 Comment, Select, Highlight, Draw
//      or ✏️ Write on, and with the marking's tools open
//   R6 (phone) a held touch (CDP touchStart, 700 ms, touchEnd) selects the word under the finger; in a gap between
//      lines the nearer line's word at the finger's x; past a line's end its last word; at zoom 1.2 and 0.33; the
//      reader's handles and bar on that word; nothing with no text within 40 px; a drag and a pinch select nothing;
//      the phone's contextmenu event selects at once; selectstart is cancelled only while the finger is held;
//      ⧉ Copy copies the words
//   R7 (phone) longpress-pick (finger, word, box, offset, zoom) and longpress-none (why) reach the client log
// Headless Chromium has no long-press gesture of its own: a held touch there reaches the reader's 500 ms timer, and
// the phone's contextmenu event is sent by hand. What a real Android long press does beyond that is not tested here.
// Its own server and documents (contract-lib.mjs), never the live viewer:
//   MODE=desktop|phone node test/select-v2.mjs   (Pi: PW_CHROMIUM=/usr/bin/chromium; CONTRACT_DIR, PORT_OFFSET as for the contract)
import { testServer, makeDoc, launch, check, finish, wait, until, PHONE, PY } from "./contract-lib.mjs";
import { execFileSync } from "node:child_process";

const srv = testServer("select-v2", 19020 + (PHONE ? 100 : 0));
await srv.start();
const doc = makeDoc(srv, "v2", [
  "Alpha opens the chapter with a sentence long enough to hold a comment and to wrap onto more lines of the page.",
  "Bravo is the second paragraph, the one an agent rewrites while the reader marks the page with a few words.",
  "Charlie keeps going so that there is more to read and more words to put a highlight on.",
  "Delta sits near the end and carries the last comment the tests make on this page.",
  "Echo closes.",
]);
// R6 holds use a document of their own: at a small zoom a comment icon (24 px at any zoom) covers whole lines.
const holdDoc = makeDoc(srv, "v2-hold", [
  "Alpha opens the chapter with a sentence long enough to hold a comment and to wrap onto more lines of the page.",
  "Bravo is the second paragraph, the one an agent rewrites while the reader marks the page with a few words.",
  "Charlie keeps going so that there is more to read and more words to put a highlight on.",
  "Echo closes.",
]);
const NOTE = "kept note";
// a note carried onto a rebuilt PDF: a highlight with a note and no popup object (pdf-carry-marks.py)
const CARRIED = "carried note";
const carried = makeDoc(srv, "v2-carried", ["Alpha has a note carried from an older build of this page."]);
execFileSync(PY, ["-I", "-W", "ignore", "-c", `import pymupdf,sys
d=pymupdf.open(sys.argv[1]); p=d[0]; q=p.search_for("carried")[0]
a=p.add_highlight_annot(q); a.set_info(content=sys.argv[2]); a.update()
assert not a.has_popup; d.saveIncr()`, carried.pdf, CARRIED]);
const marks = () => JSON.parse(execFileSync(PY, ["-I", "-W", "ignore", "-c",
  "import pymupdf,sys,json; d=pymupdf.open(sys.argv[1]); print(json.dumps([a.info.get('content') or '' for p in d for a in p.annots() if a.type[1]=='Highlight']))", doc.pdf], { encoding: "utf8" }));

const browser = await launch();
const ctx = await browser.newContext(PHONE
  ? { viewport: { width: 411, height: 922 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }
  : { viewport: { width: 1744, height: 1360 } });
if (PHONE) await ctx.addInitScript(() => localStorage.setItem("pdfreview.offline", "1"));
await ctx.route(/\/api\/redo/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: srv.base });
await ctx.addInitScript(() => { // every client log event, kept for R7
  window.__logs = [];
  let send = null;
  Object.defineProperty(window, "__clientLog", { configurable: true, set(f) { send = f; },
    get() { return (ev, d) => { window.__logs.push({ ev, ...d }); send?.(ev, d); }; } });
});
const errors = [];
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
const load = async (reload = false, url = doc.url) => {
  if (reload) await page.reload(); else await page.goto(url);
  await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && document.querySelector(".textLayer span"), null, { timeout: 60000 });
  await wait(2500);
};
await load();
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts = []) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });

// The box of a word on the page (n: which one), from the text layer.
const box = (w, n = 0) => page.evaluate(({ w, n }) => {
  for (const sp of document.querySelectorAll("#viewer .textLayer span")) {
    const t = sp.firstChild;
    if (t?.nodeType !== 3) continue;
    for (let i = t.textContent.indexOf(w); i >= 0; i = t.textContent.indexOf(w, i + 1)) {
      if (n-- > 0) continue;
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left, r: b.right, t: b.top, b: b.bottom };
    }
  }
  return null;
}, { w, n });
// Every word, with its box and its line, from the text layer (punctuation off its ends, as a word is selected).
const words = () => page.evaluate(() => {
  const out = [];
  for (const sp of document.querySelectorAll("#viewer .textLayer span")) {
    const t = sp.firstChild;
    if (t?.nodeType !== 3) continue;
    for (const m of t.textContent.matchAll(/\S+/g)) {
      const r = document.createRange(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length);
      const b = r.getBoundingClientRect();
      if (b.width) out.push({ w: m[0].replace(/^\p{P}+|\p{P}+$/gu, ""), l: b.left, r: b.right, t: b.top, b: b.bottom, x: b.left + b.width / 2, y: b.top + b.height / 2 });
    }
  }
  return out;
});
const state = () => page.evaluate(() => {
  const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
  const s = getSelection();
  const rects = s.rangeCount && !s.isCollapsed ? [...s.getRangeAt(0).getClientRects()].filter((q) => q.width > 1 && q.height > 1).map((q) => [q.left, q.top, q.right, q.bottom]) : [];
  const bar = document.getElementById("selBar");
  const card = [...document.querySelectorAll(".commentPopup")].find(vis);
  const br = bar.getBoundingClientRect();
  return {
    sel: String(s).trim(), rects, mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
    dialog: !!document.getElementById("commentManagerDialog")?.open,
    card: card ? card.textContent : null,
    bar: vis(bar), forHighlight: bar.classList.contains("forHighlight"), barBox: [br.left, br.top, br.right, br.bottom],
    buttons: [...bar.children].filter(vis).map((b) => b.id),
    handles: [...document.querySelectorAll(".selHandle")].filter(vis).map((h) => [parseFloat(h.style.left), parseFloat(h.style.top)]),
    pdfBar: [...document.querySelectorAll(".editToolbar")].filter(vis).flatMap((t) => [...t.querySelectorAll("button")].filter(vis).map((b) => b.className)),
    editors: document.querySelectorAll(".annotationEditorLayer .highlightEditor").length,
    writing: document.querySelectorAll(".wrEd.wrOpen").length,
    undo: document.getElementById("editUndo").disabled, redo: document.getElementById("editRedo").disabled,
  };
});
const brief = (s) => JSON.stringify({ ...s, rects: s.rects.length, barBox: undefined, card: s.card?.slice(0, 30) });
// The reader's handles at the selection's two ends, and its bar right above or under it.
const onWord = (s) => s.rects.length > 0 && s.handles.length === 2
  && Math.abs(s.handles[0][0] - s.rects[0][0]) < 1.5 && Math.abs(s.handles[0][1] - s.rects[0][3]) < 1.5
  && Math.abs(s.handles[1][0] - s.rects.at(-1)[2]) < 1.5 && Math.abs(s.handles[1][1] - s.rects.at(-1)[3]) < 1.5
  && s.bar && !s.forHighlight && (Math.abs(s.barBox[3] - s.rects[0][1]) < 20 || Math.abs(s.barBox[1] - s.rects.at(-1)[3]) < 45);
const menu = (s) => (PHONE ? onWord(s) && ["selComment", "selHighlight", "selCopy"].every((b) => s.buttons.includes(b))
  : s.pdfBar.some((c) => c.includes("commentButton")) && s.pdfBar.some((c) => c.includes("highlightButton")));
const tools = (s) => s.bar && s.forHighlight && ["selComment", "selColor", "selDelete"].every((b) => s.buttons.includes(b));
const press = async (p) => { if (PHONE) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); };
const pressBtn = async (sel) => { if (PHONE) await page.tap(sel); else await page.click(sel); };
const twice = async (p) => {
  if (!PHONE) return page.mouse.dblclick(p.x, p.y);
  await page.touchscreen.tap(p.x, p.y);
  await wait(90);
  await page.touchscreen.tap(p.x, p.y);
};
const BTN = { comment: "#tapComment", select: "#selectTool", highlight: "#editorHighlightButton", draw: "#editorInkButton", write: "#editSource" };
const setTool = async (t) => {
  if (!BTN[t]) return;
  await pressBtn(BTN[t]);
  await wait(t === "write" ? 2500 : 700);
};
const clear = async () => { await page.evaluate(() => getSelection().removeAllRanges()); await wait(300); };

try {
  // ---- R1, R2, R3 -----------------------------------------------------------------------------------------
  for (const t of ["none", "comment"]) {
    await setTool(t);
    const w = await box("rewrites");
    await twice(w);
    await wait(1000);
    let s = await state();
    check(s.sel === "rewrites" && menu(s) && s.editors === 0 && !s.dialog && !s.card,
      `R1 two ${PHONE ? "taps" : "clicks"} on a word (${t}): selected, with its menu; no marking, no comment box`, brief(s));
    const len = s.sel.length;
    if (PHONE) { // the end handle, 80 px to the right
      const [hx, hy] = s.handles[1];
      await touch("touchStart", [[hx, hy + 9]]);
      for (let i = 1; i <= 8; i++) await touch("touchMove", [[hx + i * 10, hy + 9]]);
      await touch("touchEnd");
    } else {
      const to = await box("reader");
      await page.keyboard.down("Shift");
      await page.mouse.click(to.x, to.y);
      await page.keyboard.up("Shift");
    }
    await wait(700);
    s = await state();
    check(s.sel.length > len + 3 && s.sel.startsWith("rewrites") && s.editors === 0, `R1 the selection grows (${PHONE ? "end handle" : "shift-click"}, ${t})`, JSON.stringify(s.sel));
    await clear();
    await setTool(t); // off again
  }

  // R2 + R3: 💬 Comment, one click, then Cancel with no words
  await setTool("comment");
  const before = await state();
  const a = await box("agent");
  await press(a);
  const opened = await until(() => page.evaluate(() => !!document.getElementById("commentManagerDialog")?.open), 5000, 100);
  let s = await state();
  check(opened && s.editors === 1, "R2 one click with 💬 Comment on: a marking and its comment box", brief(s));
  const inFile = await until(() => marks().length === 1, 20000, 500); // the autosave, with the box still open
  await pressBtn("#commentManagerCancelButton");
  await wait(1500);
  s = await state();
  check(s.editors === 0 && s.sel === "agent" && menu(s) && s.mode === 0,
    "R3 Cancel with no words: the marking is gone, the word stays selected with its menu", brief(s));
  check(s.undo === before.undo && s.redo, "R3 ↶ and ↷ stand where they stood", JSON.stringify({ before: [before.undo, before.redo], after: [s.undo, s.redo] }));
  const outOfFile = await until(() => marks().length === 0, 20000, 500);
  check(inFile && outOfFile, "R3 the marking was in the saved file while the box was open, and is gone from it", JSON.stringify(marks()));
  await clear();
  await setTool("comment"); // off

  // R3 through the menu's Comment: typed, deleted, Done
  const c = await box("Charlie");
  await twice(c);
  await wait(1000);
  if (PHONE) await page.tap("#selComment"); else await page.click(".editToolbar .commentButton");
  await page.waitForSelector("#commentManagerDialog[open]", { timeout: 5000 });
  await page.type("#commentManagerTextInput", "xy", { delay: 30 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await pressBtn("#commentManagerSaveButton");
  await wait(1500);
  s = await state();
  check(s.editors === 0 && s.sel === "Charlie" && menu(s), "R3 the menu's Comment, typed and deleted, Done: no marking, the word stays selected", brief(s));
  await clear();

  // the two markings the next checks use: "Bravo" with a comment (💬 Comment, Done), "Delta" highlighted on purpose
  await setTool("comment");
  const b = await box("Bravo");
  await press(b);
  await page.waitForSelector("#commentManagerDialog[open]", { timeout: 5000 });
  await page.type("#commentManagerTextInput", NOTE, { delay: 20 });
  await pressBtn("#commentManagerSaveButton");
  await wait(1200);
  await setTool("comment"); // off
  const d = await box("Delta");
  await twice(d);
  await wait(1000);
  if (PHONE) await page.tap("#selHighlight"); else await page.click(".editToolbar .highlightButton");
  await wait(1500);
  const saved = await until(() => { const m = marks(); return m.length === 2 && m.includes(NOTE); }, 20000, 500);
  check(saved, "R3 a marking with a saved comment, and one highlighted on purpose, stay (in the file)", JSON.stringify(marks()));

  // R1 on a marking made now: two presses select the word, with its tools shut and with them open (2026-11-15)
  for (const open of [false, true]) {
    await clear();
    if (open) { await press(await box("Delta")); await wait(1000); }
    await twice(await box("Delta"));
    await wait(1500);
    s = await state();
    check(s.sel === "Delta" && menu(s) && s.mode === 0 && !s.dialog && !s.card,
      `R1 two ${PHONE ? "taps" : "clicks"} on a marking made now (its tools ${open ? "open" : "shut"}): the word, with its menu`, brief(s));
  }
  await clear();

  // ---- R4 -------------------------------------------------------------------------------------------------
  for (const when of ["made now", "saved, after a reload"]) {
    if (when !== "made now") await load(true);
    for (const t of ["none", "comment", "select", "highlight"]) {
      await setTool(t);
      for (const [w, what] of [["Bravo", "with a comment"], ["Delta", "without"]]) {
        const p = await box(w);
        await press(p);
        await wait(1000);
        s = await state();
        check(tools(s) && !s.card && !s.dialog, `R4 a ${PHONE ? "tap" : "click"} on a marking ${what} (${when}, ${t}): its tools, no comment card`, brief(s));
        await pressBtn("#selClear");
        await wait(800);
      }
      await setTool(t); // off
      await clear();
    }
  }
  check(marks().length === 2, "R4 no marking was added or lost", JSON.stringify(marks()));

  // ---- R5 -------------------------------------------------------------------------------------------------
  for (const t of ["none", "comment", "select", "highlight", "draw", "write", "its tools open"]) {
    await load(true);
    if (t === "its tools open") { await press(await box("Bravo")); await wait(1000); } else await setTool(t);
    const icon = await page.evaluate(() => {
      const i = [...document.querySelectorAll("#viewer .annotationCommentButton")].find((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== "none");
      const r = i?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (!icon) { check(false, `R5 a comment icon shows (${t})`); continue; }
    await press(icon);
    await wait(1000);
    s = await state();
    check(!!s.card?.includes(NOTE) && !s.dialog && (t === "its tools open" || !s.bar) && !s.writing && s.sel === "",
      `R5 a press on the comment icon opens its card (${t})`, brief(s));
  }
  check(marks().length === 2, "R5 no marking was added or lost", JSON.stringify(marks()));
  // A note carried onto a rebuilt PDF has no popup object, and pdf.js draws it no icon (2026-11-15)
  for (const t of ["none", "comment", "select", "highlight"]) {
    await load(false, carried.url);
    await setTool(t);
    const icon = await page.evaluate(() => {
      const i = [...document.querySelectorAll("#viewer .annotationCommentButton")].find((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== "none");
      const r = i?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (!icon) { check(false, `R5 a carried note shows a comment icon (${t})`); continue; }
    await press(icon);
    await wait(1000);
    s = await state();
    check(!!s.card?.includes(CARRIED) && !s.dialog && !s.bar, `R5 a press on a carried note's icon opens its card (${t})`, brief(s));
  }

  // ---- R6, R7 (phone) -------------------------------------------------------------------------------------
  if (PHONE) {
    await load(false, holdDoc.url);
    const zoom = async (z) => {
      await page.evaluate((z) => { PDFViewerApplication.pdfViewer.currentScale = z; PDFViewerApplication.pdfViewer.container.scrollTop = 0; }, z);
      await wait(2500);
    };
    const holdAt = async (x, y, ms = 700) => {
      await clear();
      await touch("touchStart", [[x, y]]);
      await wait(ms);
      await touch("touchEnd");
      await wait(500);
      return state();
    };
    for (const z of [1.2, 0.33]) {
      await zoom(z);
      const W = (await words()).filter((q) => q.t > 40 && q.b < 700 && q.l > 4 && q.r < 380); // on screen, clear of the edge
      const lines = [...new Set(W.map((q) => Math.round(q.t)))].sort((p, q) => p - q).map((top) => W.filter((q) => Math.round(q.t) === top));
      // on a word
      const w = W.find((q) => q.w.length >= 4 && q.t > W[0].b);
      s = await holdAt(w.x, w.y);
      check(s.sel === w.w && onWord(s), `R6 held on a word (zoom ${z}): that word, with the reader's handles and bar on it`, `${brief(s)} want ${w.w}`);
      // in the gap between two lines, nearer the upper one: the upper line's word at the finger's x
      const i = lines.findIndex((L, k) => k + 1 < lines.length && lines[k + 1][0].t - L[0].b > 0.6 && L.length > 3);
      const up = lines[i], down = lines[i + 1], gap = down[0].t - up[0].b;
      const pick = up[Math.floor(up.length / 2)];
      s = await holdAt(pick.x, up[0].b + gap * 0.35);
      check(s.sel === pick.w && onWord(s), `R6 held in the gap between two lines (zoom ${z}, gap ${gap.toFixed(1)} px): the nearer line's word at the finger`, `${brief(s)} want ${pick.w}`);
      const pick2 = down[Math.min(1, down.length - 1)];
      s = await holdAt(pick2.x, down[0].t - gap * 0.3);
      check(s.sel === pick2.w, `R6 held in the gap, nearer the lower line (zoom ${z}): the lower line's word`, `${brief(s)} want ${pick2.w}`);
      // past a line's end: that line's last word
      const short = lines.find((L) => L.at(-1).r < 300 && L.length < 6) || lines.at(-1);
      const last = short.at(-1);
      s = await holdAt(last.r + 15, last.y);
      check(s.sel === last.w && onWord(s), `R6 held 15 px past a line's end (zoom ${z}): its last word`, `${brief(s)} want ${last.w}`);
    }
    // nothing near (zoom 0.33, the empty lower part of the page): no selection, and longpress-none with the reason
    const W = await words();
    const pg = await page.evaluate(() => { const r = document.querySelector("#viewer .page").getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
    const dist = (x, y) => Math.min(...W.map((q) => Math.hypot(Math.max(q.l - x, 0, x - q.r), Math.max(q.t - y, 0, y - q.b))));
    let far = null;
    for (let y = pg.b - 12; !far && y > pg.t; y -= 10) for (let x = pg.l + 12; !far && x < Math.min(pg.r, 400); x += 10) if (dist(x, y) > 60) far = { x, y };
    s = await holdAt(far.x, far.y);
    const none = await page.evaluate(() => window.__logs.filter((l) => l.ev === "longpress-none").at(-1));
    check(s.sel === "" && !s.bar && !!none?.why, "R6 held with no text within 40 px: nothing selected; R7 longpress-none says why", JSON.stringify({ sel: s.sel, none }));
    const pickLog = await page.evaluate(() => window.__logs.filter((l) => l.ev === "longpress-pick").at(-1));
    check(!!pickLog && ["touch", "word", "rect", "dx", "dy", "zoom"].every((k) => k in pickLog), "R7 longpress-pick: finger, word, its box, offset, zoom", JSON.stringify(pickLog)?.slice(0, 300));
    // a drag scrolls and selects nothing (zoom 1.2: the page is taller than the screen)
    await zoom(1.2);
    const ag = await box("Bravo");
    await clear();
    await touch("touchStart", [[ag.x, ag.y]]);
    for (let k = 1; k <= 6; k++) { await touch("touchMove", [[ag.x, ag.y - k * 12]]); await wait(30); }
    await wait(700);
    await touch("touchEnd");
    await wait(500);
    s = await state();
    check(s.sel === "", "R6 a drag selects nothing", brief(s));
    // a pinch selects nothing
    await page.evaluate(() => { PDFViewerApplication.pdfViewer.container.scrollTop = 0; });
    await wait(600);
    const br = await box("Bravo");
    await touch("touchStart", [[br.x, br.y]]);
    await touch("touchStart", [[br.x, br.y], [br.x + 80, br.y + 80]]);
    await wait(700);
    await touch("touchEnd");
    await wait(500);
    s = await state();
    check(s.sel === "", "R6 a pinch selects nothing", brief(s));
    // the phone's own long-press signal (contextmenu) selects at once, and its menu is cancelled
    const ch = await box("Charlie");
    await clear();
    await touch("touchStart", [[ch.x, ch.y]]);
    await wait(150);
    const cm = await page.evaluate(({ x, y }) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y });
      document.elementFromPoint(x, y).dispatchEvent(e);
      return { prevented: e.defaultPrevented, sel: String(getSelection()).trim() };
    }, ch);
    // selectstart: cancelled while the finger is held, not after
    const held = await page.evaluate(({ x, y }) => { const e = new Event("selectstart", { bubbles: true, cancelable: true }); document.elementFromPoint(x, y).dispatchEvent(e); return e.defaultPrevented; }, ch);
    await touch("touchEnd");
    await wait(400);
    const after = await page.evaluate(({ x, y }) => { const e = new Event("selectstart", { bubbles: true, cancelable: true }); document.elementFromPoint(x, y).dispatchEvent(e); return e.defaultPrevented; }, ch);
    check(cm.prevented && cm.sel === "Charlie", "R6 the phone's contextmenu during a hold selects the word at once, and is cancelled", JSON.stringify(cm));
    check(held && !after, "R6 selectstart is cancelled while the finger is held, and not after", JSON.stringify({ held, after }));
    // ⧉ Copy
    await page.tap("#selCopy");
    await wait(500);
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `! ${e}`));
    check(copied === "Charlie", "R6 ⧉ Copy puts the selected words on the clipboard", JSON.stringify(copied));
  }
  check(errors.length === 0, "no page errors", JSON.stringify(errors));
} catch (err) {
  check(false, "the test ran to its end", String(err?.stack || err));
} finally {
  await browser.close();
  await srv.stop();
}
finish();
