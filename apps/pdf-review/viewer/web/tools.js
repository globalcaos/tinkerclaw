// Left-hand tools and tap-to-comment (the architect 2026-10-23: "I should be able to activate the button, then
// press somewhere on the text and the comment pop-up should appear, right away ... the comment and
// highlight buttons should be on the left of the toolbar so I don't even have to scroll").
//
// 💬 Comment is a toggle. While it is on, a tap on the page's text selects the word under the finger
// and calls pdf.js's own commentSelection(): the word is highlighted and the comment box opens at once,
// the same path as Select → Comment in the selection bar. A drag still scrolls; only a short, still tap
// counts. The tool stays on for the next comment until the button is tapped again.
const app = window.PDFViewerApplication;
await app.initializedPromise;

const left = document.getElementById("toolbarViewerLeft");
const commentBtn = document.createElement("button");
commentBtn.id = "tapComment";
commentBtn.type = "button";
commentBtn.className = "readerBtn";
commentBtn.textContent = "💬 Comment";
commentBtn.title = "Tap here, then tap a word in the text: the comment box opens on it";
commentBtn.setAttribute("aria-pressed", "false");

const highlight = document.getElementById("editorHighlight");
left.prepend(commentBtn);
if (highlight) commentBtn.after(highlight);

let on = false;
function setOn(v) {
  on = v;
  commentBtn.setAttribute("aria-pressed", String(v));
  commentBtn.classList.toggle("on", v);
  document.body.classList.toggle("tapComment", v);
  window.__clientLog?.("tap-comment", { on: v });
}
commentBtn.addEventListener("click", () => setOn(!on));

// The word under a point, as a Range inside one text-layer span.
function wordAt(x, y) {
  let node, offset;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    node = p?.offsetNode; offset = p?.offset;
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    node = r?.startContainer; offset = r?.startOffset;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement?.closest(".textLayer")) return null;
  const s = node.textContent;
  let a = Math.min(offset, s.length), b = a;
  while (a > 0 && /\S/.test(s[a - 1])) a--;
  while (b < s.length && /\S/.test(s[b])) b++;
  if (a === b) { a = 0; b = s.length; } // tapped a space: take the whole run
  if (!s.slice(a, b).trim()) return null;
  const range = document.createRange();
  range.setStart(node, a);
  range.setEnd(node, b);
  return range;
}

let down = null;
const container = app.pdfViewer.container;
container.addEventListener("pointerdown", (e) => {
  down = on && e.isPrimary ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
}, true);
container.addEventListener("pointerup", (e) => {
  const d = down;
  down = null;
  if (!on || !d || !e.isPrimary) return;
  if (Date.now() - d.t > 600 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return; // a scroll, not a tap
  if (e.target.closest?.("button, dialog, .editToolbar, .annotationCommentButton")) return;
  const range = wordAt(e.clientX, e.clientY);
  window.__clientLog?.("tap-comment-tap", { hit: !!range, word: range ? String(range).slice(0, 40) : null });
  if (!range) return;
  e.preventDefault();
  e.stopPropagation();
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  app.pdfViewer._layerProperties.annotationEditorUIManager?.commentSelection("tap");
}, true);

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

// ---- ↶ Undo / ↷ Redo (the architect 2026-10-23 15:00: "I mistook the drawing button for the highlight button,
// and now I cannot undo it. We need an undo and redo button on the page.") pdf.js keeps an undo history
// for every mark (ink, highlight, comment, note) but only Ctrl+Z / Ctrl+Y reach it; a phone has neither.
// The buttons send pdf.js's own "undo" / "redo" editing actions and grey out when there is nothing to do.
function editBtn(id, text, title, action) {
  const b = document.createElement("button");
  b.id = id;
  b.type = "button";
  b.className = "readerBtn";
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
(highlight ?? commentBtn).after(undoBtn, redoBtn);
app.eventBus.on("editingstateschanged", ({ details }) => {
  if ("hasSomethingToUndo" in details) undoBtn.disabled = !details.hasSomethingToUndo;
  if ("hasSomethingToRedo" in details) redoBtn.disabled = !details.hasSomethingToRedo;
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
