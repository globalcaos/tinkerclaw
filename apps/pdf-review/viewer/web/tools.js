// Left-hand tools and the Select tool (2026-11-10). Need: select with a drag, keep the selection visible
// after release so it can be changed, and offer a comment icon and a highlight colour button beside it.
// Replaces the 2026-10-23 tap-a-word Comment tool.
//
// I Select is a toggle. While it is on, a drag over the page's text selects it (a tap selects one word);
// the finger no longer scrolls the page, so turn the tool off to scroll. On release the selection stays,
// with a round handle at each end to drag and change it, and a small bar beside it: 💬 comment, ✎ highlight
// in the current colour, ● the colour (each press moves to the next), ✕ drop the selection. Comment and
// highlight call pdf.js's own commentSelection() / highlightSelection(), as its own selection bar does.
const app = window.PDFViewerApplication;
await app.initializedPromise;

const left = document.getElementById("toolbarViewerLeft");
const selectBtn = document.createElement("button");
selectBtn.id = "selectTool";
selectBtn.type = "button";
selectBtn.className = "toolbarButton readerBtn";
selectBtn.textContent = "Select";
selectBtn.title = "Select text: drag over the words, then comment or highlight";
selectBtn.setAttribute("aria-pressed", "false");

const highlight = document.getElementById("editorHighlight");
left.prepend(selectBtn);
if (highlight) selectBtn.after(highlight);

let on = false;
function setOn(v) {
  on = v;
  selectBtn.setAttribute("aria-pressed", String(v));
  selectBtn.classList.toggle("on", v);
  document.body.classList.toggle("selectTool", v);
  if (v && typeof offTap === "function") offTap();
  if (!v) { document.getSelection().removeAllRanges(); place(); }
  window.__clientLog?.("select-tool", { on: v });
}
selectBtn.addEventListener("click", () => setOn(!on));

// The caret (text node + offset) under a point, inside the text layer; null elsewhere.
function caretAt(x, y) {
  let node, offset;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    node = p?.offsetNode; offset = p?.offset;
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    node = r?.startContainer; offset = r?.startOffset;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement?.closest(".textLayer")) return null;
  return { node, offset: Math.min(offset, node.textContent.length) };
}
// A caret inside ONE page's text layer, whatever the finger touches. The browser's own lookup answers
// with the end of the whole text layer (or another page) when the point falls in a gap between lines, and
// a drag then jumps across pages. Here the nearest line wins (vertical distance first), and the lookup
// runs on a point inside that line's span.
function caretIn(layer, x, y) {
  let best = null, bd = Infinity;
  for (const sp of layer.querySelectorAll("span")) {
    if (!sp.firstChild || sp.firstChild.nodeType !== Node.TEXT_NODE) continue;
    const r = sp.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const d = dy * 4 + dx;
    if (d < bd) { bd = d; best = { sp, r }; }
  }
  if (!best) return null;
  const { sp, r } = best;
  const c = caretAt(Math.min(Math.max(x, r.left + 1), r.right - 1), r.top + r.height / 2);
  if (c && sp.contains(c.node)) return c;
  const t = sp.firstChild;
  return { node: t, offset: x <= r.left ? 0 : t.length };
}
// The word around a caret, as a Range.
function wordRange(c) {
  const s = c.node.textContent;
  let a = c.offset, b = a;
  while (a > 0 && /\S/.test(s[a - 1])) a--;
  while (b < s.length && /\S/.test(s[b])) b++;
  if (a === b) { a = 0; b = s.length; } // tapped a space: take the whole run
  if (!s.slice(a, b).trim()) return null;
  const range = document.createRange();
  range.setStart(c.node, a);
  range.setEnd(c.node, b);
  return range;
}
const select = (a, b) => document.getSelection().setBaseAndExtent(a.node, a.offset, b.node, b.offset);
// The word a finger means (2026-11-15): the word under it. When nothing is under it (a gap between lines, past a
// line's end, several lines under one finger at a small zoom), the nearest line wins, by vertical distance, and on
// it the word at the finger's x, clamped to the line's ends. null when no text lies within NEAR px. Lines and
// letters are measured on the text itself, the boxes a selection is drawn from: a span's own box sits up to a
// pixel lower, which picked the wrong line in a 2 px gap at zoom 0.33; and the browser's caret lookup answers
// for whatever is drawn over the line.
const NEAR = 40;
function wordNear(x, y) {
  const near = [], cr = document.createRange();
  for (const layer of document.querySelectorAll("#viewer .page .textLayer")) {
    const lr = layer.getBoundingClientRect();
    if (x < lr.left - NEAR || x > lr.right + NEAR || y < lr.top - NEAR || y > lr.bottom + NEAR) continue;
    for (const sp of layer.querySelectorAll("span")) {
      const t = sp.firstChild;
      if (t?.nodeType !== Node.TEXT_NODE || !t.textContent.trim()) continue;
      cr.selectNodeContents(t);
      const r = cr.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (Math.hypot(dx, dy) <= NEAR) near.push({ t, r, dx, dy });
    }
  }
  if (!near.length) return null;
  const line = near.reduce((a, b) => (b.dy < a.dy || (b.dy === a.dy && b.dx < a.dx) ? b : a));
  const mid = (q) => q.r.top + q.r.height / 2;
  const on = near.filter((q) => Math.abs(mid(q) - mid(line)) < line.r.height / 2).reduce((a, b) => (b.dx < a.dx ? b : a));
  const t = on.t, s = t.textContent;
  let i = -1, best = Infinity;
  for (let k = 0; k < s.length; k++) {
    if (!/\S/.test(s[k])) continue;
    cr.setStart(t, k); cr.setEnd(t, k + 1);
    const q = cr.getBoundingClientRect();
    const d = x < q.left ? q.left - x : x > q.right ? x - q.right : 0;
    if (d < best) { best = d; i = k; if (!d) break; }
  }
  if (i < 0) return null;
  let a = i, b = i + 1;
  while (a > 0 && /\S/.test(s[a - 1])) a--;
  while (b < s.length && /\S/.test(s[b])) b++;
  // as the phone's own word selection: no quote mark or comma at either end ("That's" from "That's,)
  while (b - a > 1 && /\p{P}/u.test(s[a])) a++;
  while (b - a > 1 && /\p{P}/u.test(s[b - 1])) b--;
  cr.setStart(t, a); cr.setEnd(t, b);
  return cr;
}
const selectRange = (range) => { const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range); };

// ---- the drag ----
const ui = (el) => el?.closest?.("button, dialog, .editToolbar, .annotationCommentButton, .commentPopup, #selBar, .selHandle");
let handling = false; // a handle is being dragged
let drag = null; // { from, layer, x, y, moved }
const container = app.pdfViewer.container;
container.addEventListener("touchstart", (e) => {
  // Keeps the phone's own long-press word selection and page scroll out of the way; a pinch still reaches pdf.js.
  if (on && e.touches.length === 1 && e.target.closest?.(".textLayer") && !ui(e.target)) e.preventDefault();
}, { capture: true, passive: false });
container.addEventListener("contextmenu", (e) => { if (on && e.target.closest?.(".textLayer")) e.preventDefault(); }, true);
container.addEventListener("pointerdown", (e) => {
  drag = null;
  if (!on || !e.isPrimary || ui(e.target) || !e.target.closest?.(".textLayer")) return;
  const from = caretAt(e.clientX, e.clientY);
  if (!from) return;
  e.preventDefault();
  drag = { from, layer: e.target.closest(".textLayer"), x: e.clientX, y: e.clientY, moved: false };
  document.getSelection().removeAllRanges();
  place();
}, true);
container.addEventListener("pointermove", (e) => {
  if (!drag || !e.isPrimary) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
  drag.moved = true;
  const to = caretIn(drag.layer, e.clientX, e.clientY);
  if (to) select(drag.from, to);
  place();
}, true);
container.addEventListener("pointerup", (e) => {
  const d = drag;
  drag = null;
  if (!d || !e.isPrimary) return;
  e.preventDefault();
  e.stopPropagation();
  if (!d.moved) {
    const range = wordRange(d.from);
    window.__clientLog?.("select-tap", { hit: !!range, word: range ? String(range).slice(0, 40) : null });
    if (range) { const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
  }
  window.__clientLog?.("select-release", { sel: String(document.getSelection()).slice(0, 40) });
  place();
}, true);

// ---- handles and the action bar ----
// On a phone (2026-11-12) the bar also comes up for a selection made without the Select tool (press and
// hold), and for a tapped highlight, with that highlight's own tools: comment, colour, delete. pdf.js's own
// selection bar and highlight bar step aside while it is up, so there is one bar. The colour goes to the
// tapped highlight, or, for a new selection, to the next highlight: before, a highlight still selected by
// pdf.js took the colour instead, and pdf.js's own bar ignored the colour picked here.
const phone = () => document.body.classList.contains("withPhoneBar");
const mk = (cls, parent = document.body) => { const d = document.createElement("div"); d.className = cls; d.hidden = true; parent.append(d); return d; };
const hStart = mk("selHandle start"), hEnd = mk("selHandle end");
const bar = mk("selBar");
bar.id = "selBar";
const COLORS = ["#FFFF98", "#53FFBC", "#80EBFF", "#FFCBE6", "#FF4F5F"];
const colorIx = () => Number(localStorage.getItem("reader.hlColor") || 0) % COLORS.length;
const manager = () => app.pdfViewer._layerProperties?.annotationEditorUIManager;
let target = null; // the highlight editor the bar works on after a tap on it; null: the text selection
let entered = false; // the tap switched pdf.js to its Highlight tool; closing switches it back
const applyColor = () => {
  const c = COLORS[colorIx()];
  if (target) target.updateParams(31, c); // AnnotationEditorParamsType.HIGHLIGHT_COLOR
  else { manager()?.unselectAll(); manager()?.updateParams(31, c); }
  bar.style.setProperty("--hl", c);
};
function barBtn(id, title, onClick) {
  const b = document.createElement("button");
  b.id = id; b.type = "button"; b.className = "selBtn"; b.title = title; b.setAttribute("aria-label", title);
  b.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the selection alive
  b.addEventListener("click", onClick);
  bar.append(b);
  return b;
}
const selLen = () => String(document.getSelection()).length;
barBtn("selComment", "Comment", () => {
  window.__clientLog?.("select-comment", { highlight: !!target, sel: selLen() });
  if (target) return target.editComment();
  applyColor(); manager()?.commentSelection("selbar");
});
barBtn("selHighlight", "Highlight the selection", () => { window.__clientLog?.("select-highlight", { sel: selLen() }); applyColor(); manager()?.highlightSelection("selbar"); });
barBtn("selColor", "Highlight colour: press for the next one", () => {
  const now = target ? COLORS.indexOf(String(target.color).toUpperCase()) : colorIx();
  localStorage.setItem("reader.hlColor", String((now + 1) % COLORS.length));
  applyColor();
  window.__clientLog?.("select-color", { color: COLORS[colorIx()], highlight: !!target });
});
// ⧉ Copy (2026-11-15): the phone's own copy menu no longer comes up (press and hold, below). Plain http has no
// navigator.clipboard, so the older copy command is the fallback; both copy what is selected.
const copyBtn = barBtn("selCopy", "Copy the selected words", async () => {
  const text = String(document.getSelection());
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {}
  if (!ok) try { ok = document.execCommand("copy"); } catch {}
  window.__clientLog?.("select-copy", { chars: text.length, ok });
  copyBtn.classList.toggle("done", ok);
  setTimeout(() => copyBtn.classList.remove("done"), 900);
});
barBtn("selRead", "Read aloud from here", () => window.pdfReader?.readSelection?.());
barBtn("selDelete", "Delete this highlight", () => {
  const um = manager();
  if (target) { um?.setSelected(target); um?.delete(); }
  window.__clientLog?.("highlight-delete", {});
  closeHighlight();
});
barBtn("selClear", "Close", () => { if (target) return closeHighlight(); document.getSelection().removeAllRanges(); place(); });
applyColor();

// The highlight under a point, by pdf.js id: one made in this session (an editor) or one saved in the file.
function highlightAt(x, y) {
  let best = null, area = Infinity;
  for (const el of document.querySelectorAll(".annotationEditorLayer .highlightEditor, .annotationLayer .highlightAnnotation")) {
    const r = el.getBoundingClientRect();
    const tiny = el.classList.contains("tiny"); // autoreload.js: a 32x24 px target around a small one
    const px = tiny ? Math.max(0, (32 - r.width) / 2) : 0, py = tiny ? Math.max(0, (24 - r.height) / 2) : 0;
    if (!r.width || x < r.left - px || x > r.right + px || y < r.top - py || y > r.bottom + py || r.width * r.height >= area) continue;
    best = el; area = r.width * r.height;
  }
  if (!best) return null;
  return best.classList.contains("highlightEditor") ? manager()?.getEditor(best.id)?.uid : best.dataset.annotationId;
}
// Tools for one highlight: pdf.js edits a highlight only with its Highlight tool on, so the tap turns it on
// with that highlight selected (as pdf.js's own double click does), and closing turns it off again.
async function openHighlight(uid) {
  const um = manager();
  if (!um || !uid) return;
  document.getSelection().removeAllRanges();
  if (app.pdfViewer.annotationEditorMode !== 9) { // AnnotationEditorType.HIGHLIGHT
    entered = true;
    app.eventBus.dispatch("switchannotationeditormode", { source: app, mode: 9, editId: uid });
    for (let i = 0; i < 40 && um.firstSelectedEditor?.uid !== uid; i++) await new Promise((r) => setTimeout(r, 25));
  } else {
    for (const d of document.querySelectorAll(".annotationEditorLayer .highlightEditor")) {
      const ed = um.getEditor(d.id);
      if (ed?.uid === uid) um.setSelected(ed);
    }
  }
  target = um.firstSelectedEditor?.uid === uid ? um.firstSelectedEditor : null;
  window.__clientLog?.("highlight-tap", { found: !!target, entered });
  if (!target) return closeHighlight();
  // A note carried onto a rebuilt PDF (pdf-carry-marks.py) has no popup object, and pdf.js then leaves the note off
  // the editor: its 💬 opened an empty box (2026-11-15). The editor gets it as pdf.js gives a note with a popup.
  giveNote(target);
  place();
}
function giveNote(ed) {
  const was = ed._initialData;
  if (ed.hasComment || !was?.comment || was.popupRef) return;
  ed.setCommentData({ ...was, popupRef: "carried" });
  ed.addStandaloneCommentButton();
}
// With pdf.js's Highlight tool on, every marking is an editor: the carried notes get theirs there too.
app.eventBus.on("editorsrendered", () => {
  for (const d of document.querySelectorAll(".annotationEditorLayer .highlightEditor")) {
    const ed = manager()?.getEditor(d.id);
    if (ed) { giveNote(ed); guardColour(ed); }
  }
});
function closeHighlight() {
  if (!target && !entered) return;
  target = null;
  manager()?.unselectAll();
  if (entered) { entered = false; app.eventBus.dispatch("switchannotationeditormode", { source: app, mode: 0 }); }
  place();
}
// ---- one tap, or two (the architect 2026-11-15 17:01) ----
// "A double click should just select the word and open the contextual menu, allowing me to extend the selection",
// and "when I single-click an existing marking, with comment or not, the comment card should not open". So:
// - a tap on a marking shows that marking's tools (the bar below), on the laptop too, with no tool, 💬 Comment,
//   Select or Highlight on (Draw and pdf.js's note tools keep their own taps);
// - with 💬 Comment on, a tap on a word still makes a marking and opens its comment box;
// - two taps on a word only select it, with the bar and the handles (the laptop's own double click selects it, and
//   pdf.js's bar offers Comment and Highlight).
// With no tool or 💬 Comment on, a single tap waits out the double-click interval, so the first tap of a double
// never acts. Select and pdf.js's own tools act at once, as before.
const DBL = 300; // ms
const writing = () => document.body.classList.contains("writeMode"); // ✏️ Write has its own taps (writer.js)
let tapNow = null; // this press: { x, y, t, second, closed }
let tapUp = null; // where and when the last tap ended: { x, y, t }
let tapLast = null; // a single tap waiting out DBL: { timer }
let quietEnd = false; // the touch that ends now made its own selection: no mouse events or click after it
let iconAt = 0; // when a comment icon was last clicked
// The taps are the reader's: no tool, 💬 Comment, or a marking's tools (they turn pdf.js's Highlight tool on)
let downAt = -1e9; // when the last press on the page began (event time)
const editorAt = (x, y) => [...document.querySelectorAll(".annotationEditorLayer .highlightEditor")].some((el) => {
  const r = el.getBoundingClientRect();
  return r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
});
const ours = () => !on && ((app.pdfViewer.annotationEditorMode ?? 0) === 0 || entered);
const dropTap = () => { clearTimeout(tapLast?.timer); tapLast = null; };
document.addEventListener("pointerdown", (e) => { if (!container.contains(e.target)) dropTap(); }, true);
container.addEventListener("pointerdown", (e) => {
  tapNow = null;
  if (!e.isPrimary || ui(e.target) || writing()) return;
  dropTap();
  const second = !!tapUp && Date.now() - tapUp.t < DBL && Math.hypot(e.clientX - tapUp.x, e.clientY - tapUp.y) < 30;
  let closed = false;
  // A second press on a marking made this session never reaches its editor (2026-11-15). pdf.js's editor turns
  // it into its own double click, which enters the Highlight tool; and when the press below closes the tools, the
  // editor it lands on is already gone and pdf.js throws. twoTaps selects the word instead.
  // With its tools shut pdf.js finds the marking under a second press on the text (500 ms apart, its own test).
  const quick = e.timeStamp - downAt < 500;
  downAt = e.timeStamp;
  if ((second || quick) && ours() && (e.target.closest?.(".highlightEditor") || editorAt(e.clientX, e.clientY))) {
    e.stopPropagation();
    if (e.pointerType === "mouse") e.preventDefault();
  }
  // A marking's tools close on a press beside it, and on a second tap on it: two taps select a word. The tools keep
  // pdf.js's Highlight tool on, which would turn the laptop's own double click selection into a new marking.
  if (target && (second || !highlightAt(e.clientX, e.clientY))) {
    closed = entered;
    if (second && entered && e.pointerType === "mouse") e.preventDefault();
    closeHighlight();
  }
  if (e.target.closest?.(".page")) tapNow = { x: e.clientX, y: e.clientY, t: Date.now(), second, closed };
}, true);
container.addEventListener("pointerup", (e) => {
  const d = tapNow;
  tapNow = null;
  if (!d || !e.isPrimary || hold?.fired) return; // a press and hold made its own selection
  if (Date.now() - d.t > 600 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return; // a scroll or a drag
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return; // shift-click grows the selection: the browser's own
  const mode = app.pdfViewer.annotationEditorMode ?? 0;
  if (mode !== 0 && mode !== 9 && !d.closed) return; // Draw, a text note, a picture: pdf.js's own taps
  const x = e.clientX, y = e.clientY;
  tapUp = d.second ? null : { x, y, t: Date.now() };
  if (d.second) return twoTaps(e, x, y, d.closed);
  if ((mode === 0 && !on) || iconNear(x, y)) {
    tapLast = { timer: setTimeout(() => { tapLast = null; oneTap(x, y, d.t); }, DBL) };
    return;
  }
  if (highlightAt(x, y)) { e.preventDefault(); e.stopPropagation(); }
  oneTap(x, y, d.t);
}, true);
// A comment icon is a button, so a press right on it never gets here. A finger that lands a little beside it, on
// the marking under it, may still give the icon its click (the phone sends a tap to the button nearest the finger).
// Then the card opens and the marking's tools stay shut. Near an icon a tap waits for that click in every mode.
function iconNear(x, y) {
  for (const b of document.querySelectorAll("#viewer .annotationCommentButton")) {
    const r = b.getBoundingClientRect();
    if (r.width && x > r.left - 12 && x < r.right + 12 && y > r.top - 12 && y < r.bottom + 12) return b;
  }
  return null;
}
container.addEventListener("click", (e) => { if (e.target.closest?.(".annotationCommentButton")) iconAt = Date.now(); }, true);
function oneTap(x, y, t0) {
  if (dialog?.open || iconAt >= t0) return;
  const uid = highlightAt(x, y);
  if (uid && lockedUid(uid)) return lockedNote("tap");
  if (uid) return openHighlight(uid);
  if (!tapOn) return;
  // 💬 Comment: the word under the finger gets a marking and the comment box opens on it
  const c = caretAt(x, y);
  const range = c && wordRange(c);
  window.__clientLog?.("tap-comment-tap", { hit: !!range, word: range ? String(range).slice(0, 40) : null });
  if (!range) return;
  selectRange(range);
  manager()?.commentSelection("tap");
}
// Two taps, with no tool or 💬 Comment on. With Select or one of pdf.js's own tools on, two taps do what that tool
// does. closed: the press closed a marking's tools, so pdf.js leaves the Highlight tool they turned on first.
async function twoTaps(e, x, y, closed) {
  const mouse = e.pointerType === "mouse";
  if (on || (!closed && (app.pdfViewer.annotationEditorMode ?? 0) !== 0)) return;
  if (mouse && textSel()) return; // the laptop's own double click selected the word
  if (!mouse) quietEnd = true;
  for (let i = 0; closed && i < 40 && app.pdfViewer.annotationEditorMode !== 0; i++) await new Promise((r) => setTimeout(r, 25));
  const range = wordNear(x, y);
  window.__clientLog?.("double-tap", { word: range ? String(range).slice(0, 40) : null, touch: [Math.round(x), Math.round(y)], type: e.pointerType });
  if (!range || app.pdfViewer.annotationEditorMode !== 0) return;
  selectRange(range);
  place();
}
// pdf.js makes a saved marking whose note has no popup object (a note carried onto a rebuilt PDF) the trigger of
// its own comment card: a click on it opened the card, a touch showed it, a double click entered pdf.js's editing.
// A marking takes taps as every other marking does (above); its card opens from its comment icon.
const marking = (e) => !ui(e.target) && e.target.closest?.(".annotationLayer .highlightAnnotation");
let cardFor = null; // the carried marking whose 💬 was just pressed: its click goes on to pdf.js's card
container.addEventListener("click", (e) => { if (marking(e) && e.target !== cardFor) e.stopPropagation(); }, true);
// Such a marking had no 💬 to press (2026-11-15): pdf.js gives it none. It gets one at its top right corner, as
// pdf.js places its own, and a press on it opens the card through the marking.
app.eventBus.on("annotationlayerrendered", ({ source }) => {
  for (const m of source?.div?.querySelectorAll(".annotationLayer .highlightAnnotation.popupTriggerArea") ?? []) {
    if (m.nextElementSibling?.classList.contains("carriedNote")) continue;
    const b = document.createElement("button");
    b.className = "annotationCommentButton carriedNote";
    b.title = "Comment";
    b.style.zIndex = (parseInt(m.style.zIndex, 10) || 0) + 1;
    b.style.left = `calc(${m.style.left} + ${m.style.width})`;
    b.style.top = `calc(${m.style.top} - var(--comment-button-dim))`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      cardFor = m;
      try { m.click(); } finally { cardFor = null; }
    });
    m.after(b);
  }
});
container.addEventListener("dblclick", (e) => { if (marking(e) || (ours() && e.target.closest?.(".highlightEditor"))) e.stopPropagation(); }, true);
for (const t of ["pointerenter", "pointerleave"]) container.addEventListener(t, (e) => { if (e.pointerType !== "mouse" && marking(e)) e.stopPropagation(); }, true);

// A handle moves one end of the selection; the other end stays where it was.
for (const [h, isStart] of [[hStart, true], [hEnd, false]]) {
  let fixed = null, dy = 0, layer = null;
  h.addEventListener("pointerdown", (e) => {
    const sel = document.getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    handling = true;
    fixed = isStart ? { node: r.endContainer, offset: r.endOffset } : { node: r.startContainer, offset: r.startOffset };
    const rs = [...r.getClientRects()].filter((q) => q.width > 1 && q.height > 1);
    const line = isStart ? rs[0] : rs[rs.length - 1];
    dy = line ? line.top + line.height / 2 - e.clientY : -24; // keep the finger where it grabbed, aimed at this end's line
    layer = fixed.node.parentElement?.closest(".textLayer");
    h.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  h.addEventListener("pointermove", (e) => {
    if (!fixed || !layer) return;
    const to = caretIn(layer, e.clientX, e.clientY + dy);
    if (to) select(fixed, to);
    place();
  });
  const end = () => { fixed = null; handling = false; window.__clientLog?.("select-handle", { sel: String(document.getSelection()).slice(0, 40) }); };
  h.addEventListener("pointerup", end);
  h.addEventListener("pointercancel", end);
}

function place() {
  if (target && !target.div?.isConnected) return closeHighlight();
  const sel = document.getSelection();
  const r = !target && (on || phone()) && sel.rangeCount && !sel.isCollapsed && sel.anchorNode?.parentElement?.closest?.(".textLayer") ? sel.getRangeAt(0) : null;
  const rects = target ? [target.div.getBoundingClientRect()] : r ? [...r.getClientRects()].filter((q) => q.width > 1 && q.height > 1) : [];
  const show = rects.length > 0 && !drag?.moved;
  bar.hidden = !show;
  // Since 2026-11-15 the phone makes no selection of its own on the page (press and hold, below): every selection
  // there is the reader's, with the reader's handles.
  hStart.hidden = hEnd.hidden = !show || !r;
  bar.classList.toggle("forHighlight", !!target);
  bar.style.setProperty("--hl", target ? target.color : COLORS[colorIx()]);
  document.body.classList.toggle("selBarOn", show);
  document.body.classList.toggle("hlTools", !!target);
  if (!show) return;
  const first = rects[0], last = rects[rects.length - 1];
  hStart.style.left = `${first.left}px`; hStart.style.top = `${first.bottom}px`;
  hEnd.style.left = `${last.right}px`; hEnd.style.top = `${last.bottom}px`;
  const w = bar.offsetWidth || 170, m = 6;
  let x = Math.min(Math.max(m, (first.left + last.right) / 2 - w / 2), innerWidth - w - m);
  if (rects.length > 1) x = Math.min(Math.max(m, first.left), innerWidth - w - m);
  const h = bar.offsetHeight || 44;
  const above = first.top - h - 10, below = last.bottom + 38;
  bar.style.left = `${x}px`;
  // A marking's tools go under it (2026-11-15): its 💬 icon sits over its top right corner, and a bar above it hid
  // the icon. A selection's bar stays above, clear of the handles under it.
  const under = last.bottom + 10;
  bar.style.top = `${target ? (under + h < innerHeight - m ? under : above) : above > m ? above : below}px`;
}
document.addEventListener("selectionchange", () => { if (target && textSel()) closeHighlight(); requestAnimationFrame(place); });
container.addEventListener("scroll", () => requestAnimationFrame(place), { passive: true });
addEventListener("resize", () => requestAnimationFrame(place));
app.eventBus.on("pagesinit", applyColor);


// ---- 💬 Comment: tap a word, its comment box opens at once (the way it worked before the Select tool) ----
const tapBtn = document.createElement("button");
tapBtn.id = "tapComment";
tapBtn.type = "button";
tapBtn.className = "toolbarButton readerBtn";
tapBtn.textContent = "Comment";
tapBtn.title = "Comment: tap a word in the text and the comment box opens on it";
tapBtn.setAttribute("aria-pressed", "false");
selectBtn.after(tapBtn);
let tapOn = false;
function setTap(v) {
  tapOn = v;
  tapBtn.setAttribute("aria-pressed", String(v));
  tapBtn.classList.toggle("on", v);
  document.body.classList.toggle("tapComment", v);
  if (v && on) setOn(false);
  window.__clientLog?.("tap-comment", { on: v });
}
tapBtn.addEventListener("click", () => setTap(!tapOn));
const offTap = () => tapOn && setTap(false);
selectBtn.addEventListener("click", offTap);
// The tap itself: oneTap() in "one tap, or two" above (since 2026-11-15 it waits out a double tap first).

// ---- ✎ Highlight (the toolbar button) ----
// With text selected it highlights that text, in the colour set on the selection bar; with nothing
// selected pdf.js's own tool turns on, and a drag over a figure or blank page area draws a highlight.
const selectedText = () => {
  const s = document.getSelection();
  return s && !s.isCollapsed && s.anchorNode?.parentElement?.closest?.(".textLayer");
};
const hlButton = () => document.getElementById("editorHighlightButton");
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest?.("#editorHighlightButton") && selectedText()) e.preventDefault(); // keep the selection alive
}, true);
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("#editorHighlightButton") || !selectedText()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  applyColor();
  manager()?.highlightSelection("main_toolbar");
  window.__clientLog?.("toolbar-highlight-selection", {});
}, true);

// ---- a selection never jumps across pages ----
// A small drag of the phone's own selection handles has been seen to extend the selection by a whole
// page or more (the caret lands at the end of a text layer). A selection must stay inside one page's
// text: when an end leaves it, the last good selection is put back.
let good = null;
document.addEventListener("selectionchange", () => {
  const s = document.getSelection();
  if (!s || s.isCollapsed || !s.anchorNode) { good = null; return; }
  const la = s.anchorNode.parentElement?.closest?.(".textLayer");
  const lf = s.focusNode?.parentElement?.closest?.(".textLayer");
  if (!la && !lf) { good = null; return; } // not ours: a field, a dialog
  const len = String(s).length;
  const bad = la !== lf || !la;
  if (bad && good && !drag?.moved && !handling) {
    window.__clientLog?.("selection-jump-undone", { len, was: good.len, samePage: la === lf });
    s.setBaseAndExtent(good.an, good.ao, good.fn, good.fo);
    return;
  }
  good = { an: s.anchorNode, ao: s.anchorOffset, fn: s.focusNode, fo: s.focusOffset, len };
});


// Keep the comment box on screen. pdf.js places it once, as a percentage of the window, with a width it
// measured once; turning the phone from landscape to portrait left it half off the right edge with Add
// out of reach (the architect 2026-10-23 11:42). On open and on every resize, pull it back inside the window.
const dialog = document.getElementById("commentManagerDialog");
function fitDialog() {
  if (!dialog?.open) return;
  const m = 8;
  dialog.style.maxWidth = `${innerWidth - 2 * m}px`;
  const r = dialog.getBoundingClientRect();
  if (r.right > innerWidth - m || r.left < m) dialog.style.left = `${Math.max(m, innerWidth - m - r.width)}px`;
  if (r.bottom > innerHeight - m || r.top < m) dialog.style.top = `${Math.max(m, innerHeight - m - r.height)}px`;
  window.__clientLog?.("comment-box-fit", { w: innerWidth, h: innerHeight, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
}
if (dialog) new MutationObserver(() => requestAnimationFrame(fitDialog)).observe(dialog, { attributes: true, attributeFilter: ["open"] });
addEventListener("resize", () => requestAnimationFrame(fitDialog));
visualViewport?.addEventListener("resize", () => requestAnimationFrame(fitDialog));

// Voice notes (the architect 2026-10-28: "When I put a comment marker, I want to be able to input a voice note
// that goes into the text box ... press and hold on the lock button"). Holding the phone's side key
// runs the Jarvis app's speech recognizer; Tinker (phone/pdf-reader.ts pdfDictate) hands the words here
// while this viewer sits in its reader layer. With the comment box open they are added at the cursor,
// and the input event turns Done on, as typing would. Closed box: false, and Tinker sends a chat prompt.
const commentText = document.getElementById("commentManagerTextInput");
window.__pdfDictate = (text) => {
  const t = String(text ?? "").trim();
  // The Edit paragraph popup, when open, sits above everything and owns the cursor.
  const box = document.querySelector(".epText") || (dialog?.open ? commentText : null);
  if (!box || !t) return false;
  const v = box.value;
  const at = box.selectionStart ?? v.length;
  const end = box.selectionEnd ?? at;
  const before = v.slice(0, at);
  const after = v.slice(end);
  const add = (before && !/\s$/.test(before) ? " " : "") + t + (/^[^\s.,;:!?)]/.test(after) ? " " : "");
  box.value = before + add + after;
  box.selectionStart = box.selectionEnd = at + add.length;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
  window.__clientLog?.("comment-dictate", { chars: t.length });
  return true;
};

// ---- ↶ Undo / ↷ Redo (the architect 2026-10-23 15:00: "I mistook the drawing button for the highlight button,
// and now I cannot undo it. We need an undo and redo button on the page.") pdf.js keeps an undo history
// for every mark (ink, highlight, comment, note) but only Ctrl+Z / Ctrl+Y reach it; a phone has neither.
// The buttons send pdf.js's own "undo" / "redo" editing actions and grey out when there is nothing to do.
function editBtn(id, text, title, action) {
  const b = document.createElement("button");
  b.id = id;
  b.type = "button";
  b.className = "toolbarButton readerBtn";
  b.textContent = text;
  b.title = title;
  b.disabled = true;
  b.addEventListener("click", () => {
    app.eventBus.dispatch("editingaction", { source: b, name: action });
    window.__clientLog?.("edit-" + action, {});
  });
  return b;
}
const undoBtn = editBtn("editUndo", "↶", "Undo the last mark (drawing, highlight, comment)", "undo");
const redoBtn = editBtn("editRedo", "↷", "Redo", "redo");
(highlight ?? selectBtn).after(undoBtn, redoBtn);
app.eventBus.on("editingstateschanged", ({ details }) => {
  if ("hasSomethingToUndo" in details) undoBtn.disabled = !details.hasSomethingToUndo;
  if ("hasSomethingToRedo" in details) redoBtn.disabled = !details.hasSomethingToRedo;
});

// ---- 🤖 An Apply round locks the comments it takes (2026-11-15) ----
// From the press of ✎ Apply comments (autoreload.js redo) until the round ends (the rebuilt PDF is opened, or the
// wake fails), every marking that had a comment at the press is locked: no edit of its comment, no delete, no colour,
// and no ↶ / ↷ that reaches back past the press. Its comment icon shows the robot of the Apply button. Its card still
// opens to be read, without Edit and Delete. A comment made after the press is not taken by this round and stays free.
// A marking is known by pdf.js's uid: the saved annotation's id, which its editor keeps, or the new editor's own id.
let lock = null; // while a round runs: { uids, undo: commands made since the press still undoable, redo: same for redo }
const lockedUid = (uid) => !!lock && !!uid && lock.uids.has(uid);
const lockedEd = (ed) => !!ed && lockedUid(ed.uid);
function* allEditors() {
  const um = manager();
  for (let p = 0; um && p < app.pdfViewer.pagesCount; p++) yield* um.getEditors(p);
}
const selectedLocked = () => [...allEditors()].some((ed) => ed.div?.classList.contains("selectedEditor") && lockedEd(ed));
let lockToast = null;
function lockedNote(what) {
  window.__clientLog?.("apply-lock-refused", { what });
  lockToast?.remove();
  const t = lockToast = document.createElement("div");
  t.id = "applyLockNote";
  t.textContent = "🤖 This comment is being applied. It can be changed again when the new PDF arrives.";
  document.body.append(t);
  setTimeout(() => t.remove(), 2500);
}
// The colour goes through the editor's own updateParams (pdf.js's colour picker and its keyboard alike).
function guardColour(ed) {
  for (let p = Object.getPrototypeOf(ed); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    if (!Object.hasOwn(p, "updateParams")) continue;
    if (Object.hasOwn(p, "_applyLockGuard")) return;
    p._applyLockGuard = true;
    const f = p.updateParams;
    p.updateParams = function (...a) { return lockedEd(this) ? lockedNote("colour") : f.apply(this, a); };
    return;
  }
}
// The robot: class applyLocked on the editor's div (its icon is inside it) and on a saved marking and the icon after
// it. A card opens right after its owner, so `.applyLocked + .commentPopup` is a locked comment's card (reader.css).
function paintLocks() {
  const um = manager();
  for (const el of document.querySelectorAll("#viewer .annotationEditorLayer > [id]")) el.classList.toggle("applyLocked", lockedEd(um?.getEditor(el.id)));
  for (const sec of document.querySelectorAll("#viewer .annotationLayer [data-annotation-id]")) {
    const on = lockedUid(sec.dataset.annotationId);
    sec.classList.toggle("applyLocked", on);
    const b = sec.nextElementSibling;
    if (b?.classList.contains("annotationCommentButton")) b.classList.toggle("applyLocked", on);
  }
}
let paintQueued = false;
const lockWatch = new MutationObserver(() => { // pages and icons are drawn as he scrolls
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paintLocks(); });
});
async function applyLock() {
  const me = lock = { uids: new Set(), undo: 0, redo: 0 };
  for (const ed of allEditors()) { guardColour(ed); if (ed.hasComment) me.uids.add(ed.uid); }
  if (target && lockedEd(target)) closeHighlight();
  lockWatch.observe(container, { childList: true, subtree: true });
  paintLocks();
  const doc = app.pdfDocument;
  try { // the saved markings that have no editor on the page
    for (let i = 1; doc && i <= doc.numPages; i++) {
      for (const a of await (await doc.getPage(i)).getAnnotations()) if (a.contentsObj?.str) me.uids.add(a.id);
    }
  } catch (err) {
    console.error("[apply-lock] reading the saved comments failed", err);
  }
  if (lock !== me) return;
  paintLocks();
  window.__clientLog?.("apply-lock", { comments: me.uids.size });
}
function applyUnlock(why) {
  if (!lock) return;
  lock = null;
  lockWatch.disconnect();
  paintLocks();
  window.__clientLog?.("apply-unlock", { why });
}
window.__pdfApplyLock = { on: applyLock, off: applyUnlock, has: lockedUid };
// Edit and Delete of a card pdf.js draws for a saved marking (its own path, not through the uiManager): hidden by CSS,
// refused here as well.
document.addEventListener("click", (e) => {
  if (!lock || !e.target.closest?.(".commentPopupEdit, .commentPopupDelete")) return;
  if (!e.target.closest(".commentPopup")?.previousElementSibling?.classList.contains("applyLocked")) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  lockedNote("card");
}, true);
// pdf.js's keyboard calls its own undo, redo and delete, not the guarded ones below: while locked, Ctrl+Z and Ctrl+Y go
// through the guarded ones, and Delete on a locked marking stops here.
addEventListener("keydown", (e) => {
  if (!lock || !(app.pdfViewer.annotationEditorMode > 0) || e.target.closest?.("input, textarea, [contenteditable='true']")) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  const act = mod && k === "z" && !e.shiftKey ? "undo" : mod && (k === "y" || k === "z") ? "redo" : null;
  if (!act && !((k === "delete" || k === "backspace") && selectedLocked())) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (act) manager()?.[act]();
  else lockedNote("delete-key");
}, true);

// ---- a comment box closed empty leaves no marking (2026-11-15 17:01: a selection with no comment
// stays a selection) ----
// 💬 on the reader's bar or on pdf.js's own bar, or a tap with 💬 Comment on, first makes a marking and then opens
// its comment box. Closed with no words in it (Cancel, Done or Esc), that marking goes again and the words are
// selected again, with their bar. The marking's own undo takes it off, which also starts the autosave; the redo
// entry that leaves behind is cut with a placeholder command, so ↶ and ↷ stand where they stood before. When the
// last command is not that marking's, nothing is taken off. A marking stays when it is highlighted on purpose or
// gets a comment.
const DROP = "pdf-review-drop";
let asked = null; // the selection a comment was asked for: { an, ao, fn, fo, mode, t }
let made = null; // the marking made for that comment: { ed, sel }
const watchComments = (um) => {
  if (!um || um._readerComments) return;
  um._readerComments = true;
  const hs = um.highlightSelection, ec = um.editComment;
  // The Apply lock (above). The undo stack is counted from the press: a command made since then can be undone, one
  // made before it cannot (it could take a locked comment off, or its colour back).
  const ud = um.undo, rd = um.redo, ac = um.addCommands, cu = um.cleanUndoStack, del = um.delete, dc = um.deleteComment;
  um.undo = function () {
    if (lock && lock.undo <= 0) return lockedNote("undo");
    if (lock) { lock.undo--; lock.redo++; }
    return ud.call(this);
  };
  um.redo = function () {
    if (lock && lock.redo <= 0) return lockedNote("redo");
    if (lock) { lock.redo--; lock.undo++; }
    return rd.call(this);
  };
  um.addCommands = function (params) {
    if (lock) { lock.undo++; lock.redo = 0; }
    return ac.call(this, params);
  };
  um.cleanUndoStack = function (type) {
    if (lock && type === DROP) lock.undo = Math.max(0, lock.undo - 1); // the placeholder below comes off again
    return cu.call(this, type);
  };
  um.delete = function () { return selectedLocked() ? lockedNote("delete") : del.call(this); };
  um.deleteComment = function (editor, ...rest) { return lockedEd(editor) ? lockedNote("delete-comment") : dc.call(this, editor, ...rest); };
  um.highlightSelection = function (how, comment = false) {
    const s = document.getSelection();
    asked = comment && s?.rangeCount && !s.isCollapsed ? { an: s.anchorNode, ao: s.anchorOffset, fn: s.focusNode, fo: s.focusOffset, mode: app.pdfViewer.annotationEditorMode ?? 0, t: Date.now() } : null;
    const out = hs.call(this, how, comment);
    if (!s?.isCollapsed) asked = null; // pdf.js clears the selection when it makes the marking: none was made
    return out;
  };
  um.editComment = function (editor, ...rest) {
    if (lockedEd(editor)) return lockedNote("edit");
    made =asked && Date.now() - asked.t < 3000 && editor !== target ? { ed: editor, sel: asked } : null;
    asked = null;
    return ec.call(this, editor, ...rest);
  };
};
app.eventBus.on("annotationeditoruimanager", ({ uiManager }) => watchComments(uiManager));
watchComments(manager());
dialog?.addEventListener("close", async () => {
  const m = made, um = manager();
  made = null;
  if (!m || !um || m.ed.hasComment || !um.getEditor(m.ed.id)) return;
  um.undo();
  if (um.getEditor(m.ed.id)) { // the last command was another one: it is put back, and the marking stays
    um.redo();
    window.__clientLog?.("comment-empty-kept", {});
    return;
  }
  um.addCommands({ cmd() {}, undo() {}, mustExec: false, type: DROP });
  um.cleanUndoStack(DROP);
  // pdf.js tells ↶ / ↷ only what changed; it is told the true state again (its Highlight tool is still on here)
  if (app.pdfViewer.annotationEditorMode !== 0) um.setEditingState(true);
  if (m.sel.mode === 0 && app.pdfViewer.annotationEditorMode !== 0) {
    app.eventBus.dispatch("switchannotationeditormode", { source: app, mode: 0 });
    for (let i = 0; i < 40 && app.pdfViewer.annotationEditorMode !== 0; i++) await new Promise((r) => setTimeout(r, 25));
  }
  const { an, ao, fn, fo } = m.sel;
  // in a marking tool's mode a selection would become a marking at once: the words come back only with no tool on
  if (app.pdfViewer.annotationEditorMode === 0 && an?.isConnected && fn?.isConnected) document.getSelection().setBaseAndExtent(an, ao, fn, fo);
  window.__clientLog?.("comment-empty-unmarked", { sel: String(document.getSelection()).slice(0, 40) });
});

// ---- Selecting text on a phone (the architect 2026-10-23 15:00: "after I select something, no play button or
// comment button appears, only the typical cut-copy-paste menu ... when highlighting text, it is very
// hard"). pdf.js shows its Highlight / Comment bar, and in Highlight mode turns the selection into a
// highlight, only on the pointerup that ends the selecting gesture. On Android a long-press that becomes
// a text selection ends in pointercancel instead, so pdf.js waits for a pointerup that never comes.
// ASSUMED cause (the client log below is what confirms it on his phone): a pointercancel is answered
// with a synthetic primary-button pointerup, which is exactly what pdf.js was waiting for.
const textSel = () => {
  const s = document.getSelection();
  return s && !s.isCollapsed && s.anchorNode?.parentElement?.closest?.(".textLayer") ? String(s).slice(0, 40) : null;
};
addEventListener("pointercancel", (e) => {
  window.__clientLog?.("pointercancel", { type: e.pointerType, sel: textSel() });
  if (e.pointerType !== "touch") return;
  // After the browser's own handlers, so pdf.js sees the selection before the end of the gesture.
  setTimeout(() => {
    dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, isPrimary: true, pointerType: "touch" }));
    window.__clientLog?.("pointerup-synth", { sel: textSel() });
  }, 0);
}, true);
let lastSel = null;
document.addEventListener("selectionchange", () => {
  const s = textSel();
  if (s === lastSel) return;
  lastSel = s;
  if (s) window.__clientLog?.("text-select", { sel: s, mode: app.pdfViewer.annotationEditorMode ?? 0 });
  // The bar is built lazily; report whether it is on screen a moment after the selection settles.
  if (s) setTimeout(() => {
    const bar = document.querySelector(".editToolbar .highlightButton, .editToolbar #highlightButton")?.closest(".editToolbar");
    window.__clientLog?.("selection-bar", { shown: !!bar && !bar.hidden && bar.getBoundingClientRect().width > 0 });
  }, 400);
});

// ---- Press and hold on a phone (2026-11-15) ----
// 2026-11-15 17:01: a press and hold on the phone must always select the word under the finger; about half the
// presses selected a word an inch lower than the finger. The device log (event
// longpress-pick, 2026-11-14 and 15) showed why: in about half of his presses no word lies exactly under the finger
// (a gap between lines, past a line's end, several lines under one finger when zoomed out), and the phone then
// picks a word 8 to 400 px away. The snap that moved the selection to the nearest word afterwards (2026-11-14)
// moved only the page's selection: the phone's own handles and copy menu stayed on its far word, and that is what
// he saw. Now the phone makes no selection of its own on the page. While one finger is held on a page, the
// selectstart event the browser sends before any selection a gesture makes is cancelled, and when the hold is long
// enough (the phone's contextmenu event, or 500 ms with the finger still and nothing scrolled) the reader selects
// wordNear() itself, with its own handles and bar (⧉ Copy stands in for the phone's copy menu) and a short buzz.
// Not with Select on (its own drag), in ✏️ Write (the editor keeps the browser's caret and selection), or with a
// drawing or note tool. A hold that selects logs longpress-pick (finger, word, its box, the offset, the zoom); a
// hold with no text near logs longpress-none with the reason.
let hold = null; // the finger held now: { x, y, sx, sy, t, sl, st, at, timer, fired }
const viewInfo = () => {
  const vv = window.visualViewport;
  const out = {
    vv: vv ? [Math.round(vv.offsetLeft), Math.round(vv.offsetTop), Math.round(vv.pageTop), +vv.scale.toFixed(3), Math.round(vv.height)] : null,
    inner: [innerWidth, innerHeight], scrollTop: Math.round(container.scrollTop), scale: +(app.pdfViewer.currentScale || 0).toFixed(3),
  };
  try {
    const fr = window.frameElement?.getBoundingClientRect();
    if (fr) out.frame = [Math.round(fr.left), Math.round(fr.top), Math.round(fr.width), Math.round(fr.height)];
    if (parent !== window) {
      const pv = parent.visualViewport;
      out.parent = { scrollY: Math.round(parent.scrollY), inner: [parent.innerWidth, parent.innerHeight],
        vv: pv ? [Math.round(pv.offsetTop), Math.round(pv.pageTop), +pv.scale.toFixed(3), Math.round(pv.height)] : null };
    }
  } catch { out.frame = "cross-origin"; }
  return out;
};
const holdable = (e) => phone() && !on && !writing() && [0, 9].includes(app.pdfViewer.annotationEditorMode ?? 0)
  && !!e.target.closest?.("#viewer .page") && !ui(e.target) && !e.target.closest?.("a[href], input, textarea, [contenteditable='true']");
container.addEventListener("touchstart", (e) => {
  clearTimeout(hold?.timer);
  hold = null;
  if (e.touches.length !== 1 || !holdable(e)) return; // a second finger: a pinch
  const t = e.touches[0];
  hold = { x: t.clientX, y: t.clientY, sx: Math.round(t.screenX), sy: Math.round(t.screenY), t: Date.now(),
    sl: container.scrollLeft, st: container.scrollTop, at: viewInfo(), fired: false };
  hold.timer = setTimeout(() => holdFire("timer"), 500);
}, { capture: true, passive: true });
const holdOff = () => { if (hold && !hold.fired) { clearTimeout(hold.timer); hold = null; } };
container.addEventListener("touchmove", (e) => {
  const t = e.touches[0];
  if (hold && (e.touches.length > 1 || Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > 10)) holdOff(); // a scroll, a drag
}, { capture: true, passive: true });
container.addEventListener("scroll", () => {
  if (hold && (container.scrollTop !== hold.st || container.scrollLeft !== hold.sl)) holdOff();
}, { passive: true });
// After a hold that selected, or a second tap that did: no click and no mouse events, which would put a caret
// over the new selection.
const holdEnd = (e) => {
  const h = hold;
  hold = null;
  clearTimeout(h?.timer);
  if ((h?.fired || quietEnd) && e.cancelable) e.preventDefault();
  quietEnd = false;
};
container.addEventListener("touchend", holdEnd, { capture: true, passive: false });
container.addEventListener("touchcancel", holdEnd, { capture: true, passive: true });
document.addEventListener("selectstart", (e) => { if (hold) e.preventDefault(); }, true);
container.addEventListener("contextmenu", (e) => {
  if (!hold) return;
  e.preventDefault();
  holdFire("contextmenu");
}, true);
async function holdFire(via) {
  const h = hold;
  if (!h || h.fired) return;
  h.fired = true;
  clearTimeout(h.timer);
  dropTap();
  const range = wordNear(h.x, h.y);
  const at = { touch: [Math.round(h.x), Math.round(h.y)], screen: [h.sx, h.sy], zoom: +(app.pdfViewer.currentScale || 0).toFixed(3),
    via, ms: Date.now() - h.t };
  if (!range) {
    window.__clientLog?.("longpress-none", { ...at, why: `no text within ${NEAR} px of the finger`, atTouch: h.at });
    return;
  }
  navigator.vibrate?.(12);
  if (target) { // a marking's tools close first, and pdf.js leaves the Highlight tool they turned on
    const was = entered;
    closeHighlight();
    for (let i = 0; was && i < 40 && app.pdfViewer.annotationEditorMode !== 0; i++) await new Promise((r) => setTimeout(r, 25));
  }
  const c = caretAt(h.x, h.y);
  selectRange(range);
  place();
  const r = range.getBoundingClientRect();
  window.__clientLog?.("longpress-pick", {
    word: String(range).slice(0, 40), under: c ? String(wordRange(c) || "").slice(0, 40) : null, ...at,
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    dx: Math.round(r.left + r.width / 2 - h.x), dy: Math.round(r.top + r.height / 2 - h.y), atTouch: h.at, now: viewInfo(),
  });
}
