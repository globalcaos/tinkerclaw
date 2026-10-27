// Phone layout (2026-10-21). The toolbar is twice a phone's width, so on a narrow screen this viewer's
// own controls (Recent, Redo, Edit, Read, speed, voice) move to a bar along the bottom, in thumb
// reach, and pdf.js keeps the top row. The outline pdf.js opens for some papers would cover the page,
// so it starts closed there. Widening the window (unfolding the phone) moves them back.
//
// Two ways to read (the architect 2026-10-21: "no need to + - since zooming is done by pinching. However,
// swipe right and left should change page in page view mode, but we should have a continuous view
// mode where I only need to scroll down to keep reading"):
//   - ↕ Scroll: one column of pages at the screen's width, a small gap between them;
//   - ⇆ Pages: one page at a time, fitted to the screen; a swipe left or right turns it.
// The − / + buttons and the zoom menu are hidden: pdf.js zooms on a pinch. The choice is kept.
const app = window.PDFViewerApplication;
await app.initializedPromise;

// A phone turned sideways is ~880 px wide but only ~410 tall: it is still a phone (the architect 2026-10-23,
// the landscape toolbar ran past the screen in one line).
const narrow = matchMedia("(max-width: 700px), (pointer: coarse) and (max-height: 500px)");
// A phone held sideways gives the page every pixel of height (the architect 2026-10-24: "not even the tools or
// the page title should appear ... make all the toolbox only icons and present them on the left side of
// the screen, with vertical scroll"). The pdf.js toolbar becomes a scrolling column of icons on the left
// (reader.css body.sideRail), this viewer's own controls join it, the bottom bar goes, and the Tinker
// page around the frame hides its title bar (tinker-ui phone.css); ✕ in the column closes the reader.
const landscape = matchMedia("(pointer: coarse) and (orientation: landscape) and (max-height: 500px)");
const SCROLL = 0; // pdf.js ScrollMode.VERTICAL
const PAGE = 3; // pdf.js ScrollMode.PAGE
const MODE_KEY = "reader.phoneMode";
const mode = () => (localStorage.getItem(MODE_KEY) === "page" ? "page" : "scroll");

const phoneBar = document.createElement("div");
phoneBar.id = "phoneBar";
phoneBar.hidden = true;
document.body.append(phoneBar);

const modeBtn = document.createElement("button");
modeBtn.id = "viewMode";
modeBtn.className = "readerBtn";
modeBtn.hidden = true;
phoneBar.append(modeBtn);

const OWN = ["recentFiles", "redoDocument", "editSource", "showInFolder", "saveState", "readerControls"];

function applyMode() {
  const m = mode();
  modeBtn.textContent = m === "page" ? "⇆ Pages" : "↕ Scroll";
  modeBtn.title = m === "page" ? "One page at a time; swipe to turn. Tap for continuous scrolling" : "Continuous scrolling. Tap for one page at a time";
  if (!narrow.matches || !app.pdfDocument) return;
  const viewer = app.pdfViewer;
  const want = m === "page" ? PAGE : SCROLL;
  if (viewer.scrollMode !== want) viewer.scrollMode = want;
  viewer.currentScaleValue = m === "page" ? "page-fit" : "page-width";
}

const framed = window.parent !== window;
const closeBtn = document.createElement("button");
closeBtn.id = "closeReader";
closeBtn.type = "button";
closeBtn.className = "readerBtn";
closeBtn.textContent = "✕";
closeBtn.title = "Close the reader";
closeBtn.hidden = true;
// The Tinker page serves this viewer from its own origin (/pdf/), so the frame can reach the reader
// layer around it: hide its title bar sideways, and press its own ✕ to close.
const hostBar = () => {
  try { return parent.document.querySelector("#pdf-reader-layer .pdf-reader-bar"); } catch { return null; }
};
closeBtn.addEventListener("click", () => {
  try { parent.document.querySelector("#pdf-reader-layer .pdf-reader-close")?.click(); } catch {}
});
document.getElementById("toolbarViewerLeft")?.prepend(closeBtn);

// Icon only in the column: each of our buttons shows its first symbol (reader.css ::before), kept in step
// with labels that change by themselves (▶ Read / ⏸ Pause, Saving… / ✓ Saved, the Apply dots).
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function iconize() {
  for (const b of document.querySelectorAll("#toolbarViewer .readerBtn")) {
    const t = (b.textContent || "").trim();
    const first = t ? seg.segment(t)[Symbol.iterator]().next().value.segment : "";
    if (b.dataset.icon !== first) b.dataset.icon = first;
  }
}
new MutationObserver(() => document.body.classList.contains("sideRail") && iconize())
  .observe(document.getElementById("toolbarViewer"), { subtree: true, childList: true, characterData: true });

function place() {
  const rail = landscape.matches;
  const bar = narrow.matches && !rail;
  const host = bar ? phoneBar : document.getElementById("toolbarViewerRight");
  for (const id of [...OWN].reverse()) {
    const el = document.getElementById(id);
    if (el && el.parentElement !== host) host.prepend(el);
  }
  if (bar) phoneBar.prepend(modeBtn);
  else if (rail) host.prepend(modeBtn);
  modeBtn.hidden = !narrow.matches;
  phoneBar.hidden = !bar;
  closeBtn.hidden = !(rail && framed && hostBar());
  const hb = hostBar();
  if (hb) hb.style.display = rail ? "none" : "";
  document.body.classList.toggle("withPhoneBar", bar);
  document.body.classList.toggle("sideRail", rail);
  if (rail) iconize();
  applyMode();
  // The page area changed shape: let pdf.js refit page-width to it.
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  window.__clientLog?.("layout", { rail, bar, w: innerWidth, h: innerHeight });
}
place();
narrow.addEventListener("change", place);
landscape.addEventListener("change", place);

modeBtn.addEventListener("click", () => {
  localStorage.setItem(MODE_KEY, mode() === "page" ? "scroll" : "page");
  applyMode();
});

const closeOutline = () => narrow.matches && app.viewsManager?.isOpen && app.viewsManager.close();
app.eventBus.on("pagesinit", () => setTimeout(applyMode, 0));
for (const ev of ["pagesloaded", "outlineloaded"]) app.eventBus.on(ev, () => setTimeout(closeOutline, 0));

// ---- swipe to turn the page (⇆ Pages only) ----------------------------------------------------
// Not while drawing or placing a note (an editor mode is on), not when zoomed past the screen's width
// (then the finger pans the page), not when the gesture selects text, and only for a clear sideways flick.
const container = app.pdfViewer.container;
let touch = null;
container.addEventListener("touchstart", (e) => {
  touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
}, { passive: true });
container.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1) touch = null; // a pinch
}, { passive: true });
container.addEventListener("touchend", (e) => {
  const s = touch;
  touch = null;
  if (!s || !narrow.matches || mode() !== "page") return;
  if ((app.pdfViewer.annotationEditorMode ?? 0) > 0) return;
  if (container.scrollWidth > container.clientWidth + 2) return;
  if (String(document.getSelection() ?? "").trim()) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - s.x;
  const dy = t.clientY - s.y;
  if (Date.now() - s.t > 700 || Math.abs(dx) < 60 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
  if (dx < 0) app.pdfViewer.nextPage();
  else app.pdfViewer.previousPage();
}, { passive: true });
