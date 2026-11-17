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
// 2026-11-12: on a phone the whole toolbar shows at once: upright at the bottom, wrapped into rows;
// sideways on the right edge, in columns, in thumb reach
// (reader.css body.tbRows, body.tbWide). Before, upright it was one row that scrolled
// sideways and hid half the tools, and sideways a column on the left that ran below the screen.
// Sideways the Tinker page around the frame still hides its title bar, and ✕ in the bar closes the reader.
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
modeBtn.className = "toolbarButton readerBtn";
modeBtn.hidden = true;
phoneBar.append(modeBtn);

const OWN = ["syncState", "recentFiles", "redoDocument", "editSource", "showInFolder", "saveState", "readerControls"];

// keepZoom: a turn keeps a zoom made with two fingers (see "turning the phone" below).
function applyMode(keepZoom = false) {
  const m = mode();
  modeBtn.textContent = m === "page" ? "⇆ Pages" : "↕ Scroll";
  modeBtn.dataset.mode = m;
  modeBtn.title = m === "page" ? "One page at a time; swipe to turn. Tap for continuous scrolling" : "Continuous scrolling. Tap for one page at a time";
  if (!narrow.matches || !app.pdfDocument) return;
  const viewer = app.pdfViewer;
  const want = m === "page" ? PAGE : SCROLL;
  if (viewer.scrollMode !== want) viewer.scrollMode = want;
  if (!keepZoom) viewer.currentScaleValue = m === "page" ? "page-fit" : "page-width";
}

const framed = window.parent !== window;
const closeBtn = document.createElement("button");
closeBtn.id = "closeReader";
closeBtn.type = "button";
closeBtn.className = "toolbarButton readerBtn";
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

// Every button here is an icon (reader.css hides its words). The words stay in the DOM as the state:
// this copies them to the accessible name, turns a ⚠ message into the tooltip and a warn icon, and gives
// the auto-save note its icon (✓ saved, Saving… or ↻ updated, ⚠ failed).
function syncLabels() {
  for (const b of document.querySelectorAll("#toolbarViewer .readerBtn")) {
    const t = (b.textContent || "").trim();
    const warn = t.startsWith("⚠");
    const state = warn ? "warn" : b.id !== "saveState" ? "" : t.startsWith("✓") ? "ok" : t ? "busy" : "";
    if ((b.dataset.state || "") !== state) b.dataset.state = state;
    if (warn && b.title !== t) b.title = t;
    if (b.id === "saveState" && t && !warn && b.title !== t) b.title = t;
    const label = warn || b.id === "saveState" ? t : b.title || t;
    if (label && b.getAttribute("aria-label") !== label) b.setAttribute("aria-label", label);
  }
}
syncLabels();
new MutationObserver(syncLabels)
  .observe(document.getElementById("toolbarViewer"), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title"] });

// Two row breaks, so an upright phone shows the groups as rows (reader.css gives them their place).
for (const after of ["mark", "listen"]) {
  const br = document.createElement("span");
  br.className = "tbBreak";
  br.dataset.after = after;
  document.getElementById("toolbarViewer").append(br);
}
// The page ends where the bar begins, however many rows the bar takes.
const barBox = document.getElementById("toolbarContainer");
const fitPage = () => {
  if (!document.body.classList.contains("tbRows")) return;
  // Sideways the bar is a rail on the right (reader.css body.tbWide): its width is what the page loses.
  const box = barBox.getBoundingClientRect();
  const [name, v] = document.body.classList.contains("tbWide") ? ["--tbr", Math.round(box.width)] : ["--tbh", Math.round(box.height)];
  if (v && document.body.style.getPropertyValue(name) !== `${v}px`) {
    document.body.style.setProperty(name, `${v}px`);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }
};
new ResizeObserver(fitPage).observe(barBox);

// ---- turning the phone keeps the place (2026-11-15) --------------------------------------------
// The text at the middle of the screen must stay there when the phone turns between landscape and portrait,
// and the pages must not jump. A turn lost the reader's place twice over. The page area slid to its new
// size for 200 ms and the zoom was fitted at the start of the slide, so it fitted the old screen for minutes
// (reader.css now stops the slide). And on a zoom change pdf.js keeps the line at the TOP of the screen, not the
// one in the middle.
// So while the view is still, the point in the middle of the page area is kept: its page, and where on that page
// as a share of the page's width and height. A resize that changes the width starts a turn and freezes the point.
// A turn fires several resizes (the window, the rail or the rows, --tbr or --tbh, Tinker's title bar, pdf.js's
// own). After each one, and on every frame until 600 ms after the last, the point goes back to the middle; then
// the zoom is fitted once more to the settled page area.
// A zoom made with two fingers stays through a turn while the page is still wider than the screen (⇆ Pages: or
// taller): he zoomed in to look at something. Where the page would sit narrower than the screen, the fit comes
// back. Write's held zoom (writer.js holdZoom) is a fit kept as a number: a turn fits it again and Write holds the new one.
const container = app.pdfViewer.container;
const SETTLE_MS = 600;
let spot = null; // the point in the middle of the page area: { page, fx, fy }
let turn = null; // a turn under way: { last, pinch }
let width = innerWidth;
const fitValue = () => (mode() === "page" ? "page-fit" : "page-width");
const middle = () => {
  const r = container.getBoundingClientRect();
  return [r.left + container.clientLeft + container.clientWidth / 2, r.top + container.clientTop + container.clientHeight / 2];
};
function readSpot() {
  const [x, y] = middle();
  let best = null;
  for (const { view } of app.pdfViewer._getVisiblePages().views) {
    const b = view.div.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const d = Math.max(b.top - y, y - b.bottom, 0); // between two pages, the nearer one
    if (!best || d < best.d) best = { d, page: view.id, fx: (x - b.left) / b.width, fy: (y - b.top) / b.height };
  }
  return best;
}
// Not while the width differs from the last one seen: pdf.js fits the zoom to a resize before turning() hears of it
// (Chromium calls a window's resize listeners in the order they were added, capture or not), and that moved view
// is not his place.
// Nor for 300 ms after any resize (2026-11-15, review): a turn sent as two resizes, height first, would read the
// point at the in-between shape.
let resized = -1e9, atTop = false;
function followSpot() {
  if (turn || innerWidth !== width || performance.now() - resized < 300 || !app.pdfViewer.pagesCount) return;
  spot = readSpot() ?? spot;
  atTop = container.scrollTop === 0;
}
container.addEventListener("scroll", followSpot, { passive: true });
app.eventBus.on("updateviewarea", followSpot);
function putBack() {
  const v = app.pdfViewer;
  const pv = spot && v.getPageView(spot.page - 1);
  if (!pv) return;
  // At the very top of the document he reads the top: keep it there (2026-11-15, review).
  if (turn?.top && mode() !== "page") { container.scrollTop = 0; return; }
  if (!pv.div.isConnected) { ours = true; v.currentPageNumber = spot.page; ours = false; } // ⇆ Pages holds only the page shown
  const b = pv.div.getBoundingClientRect();
  if (!b.width || !b.height) return;
  const [x, y] = middle();
  const dx = b.left + spot.fx * b.width - x, dy = b.top + spot.fy * b.height - y;
  if (Math.abs(dy) >= 1) container.scrollTop += dy;
  if (Math.abs(dx) >= 1) container.scrollLeft += dx;
}
// Every resize calls this, and so does place(): whichever a turn fires first starts it.
function turning() {
  const turned = innerWidth !== width;
  width = innerWidth;
  if (turn) { turn.last = performance.now(); return; }
  if (!turned || !narrow.matches || !spot || !app.pdfDocument) return;
  const v = app.pdfViewer, cls = document.body.classList;
  // His own zoom: a number while the phone layout was on (not a desktop zoom coming along), and not Write's hold.
  const own = cls.contains("tbRows") && !cls.contains("writeMode") && !/^(auto|page-fit|page-width)$/.test(String(v.currentScaleValue));
  turn = { last: performance.now(), pinch: own ? v.currentScale : 0, top: atTop };
  requestAnimationFrame(settle);
}
function settle() {
  if (!turn) return;
  const v = app.pdfViewer;
  if (turn.pinch) {
    const pv = v.getPageView(v.currentPageNumber - 1);
    const big = pv && (pv.width > container.clientWidth || (mode() === "page" && pv.height > container.clientHeight));
    if (!big) { turn.pinch = 0; v.currentScaleValue = fitValue(); }
  }
  putBack();
  if (performance.now() - turn.last < SETTLE_MS) { requestAnimationFrame(settle); return; }
  if (!turn.pinch && narrow.matches) v.currentScaleValue = fitValue(); // the fit of the settled area; Write holds it again
  putBack();
  window.__clientLog?.("turn-kept", { page: spot.page, fy: Math.round(spot.fy * 1000) / 1000, zoom: Math.round(v.currentScale * 1000) / 1000, value: String(v.currentScaleValue), w: innerWidth, h: innerHeight });
  turn = null;
  followSpot();
}
// Added after pdf.js's own resize listener, so this runs once pdf.js has fitted the zoom to the resize.
addEventListener("resize", () => { turning(); if (turn) putBack(); resized = performance.now(); });
container.addEventListener("touchstart", () => { turn = null; }, { passive: true }); // a finger takes over
// A page turn by anyone else ends a turn too (2026-11-15, review): the voice reading on, the page buttons, the
// page box, an outline link. Without this the restore pulled the view back for 600 ms and read aloud stopped
// following. A zoom change also scrolls pages into view; those calls pass allowNegativeOffset and are not a turn.
let ours = false;
{
  const v = app.pdfViewer;
  const ownTurn = () => { if (turn && !ours) { turn = null; followSpot(); } };
  const scroll = v.scrollPageIntoView.bind(v);
  v.scrollPageIntoView = (p) => { if (!p?.allowNegativeOffset) ownTurn(); return scroll(p); };
  let proto = Object.getPrototypeOf(v), d;
  while (proto && !(d = Object.getOwnPropertyDescriptor(proto, "currentPageNumber"))) proto = Object.getPrototypeOf(proto);
  if (d?.set) Object.defineProperty(v, "currentPageNumber", { configurable: true, get: d.get, set(n) { ownTurn(); d.set.call(this, n); } });
}

function place() {
  turning();
  const rail = landscape.matches;
  const bar = narrow.matches; // a phone, upright or sideways: the wrapped bar at the bottom
  const host = document.getElementById("toolbarViewerRight");
  for (const id of [...OWN].reverse()) {
    const el = document.getElementById(id);
    if (el && el.parentElement !== host) host.prepend(el);
  }
  if (narrow.matches) host.prepend(modeBtn);
  modeBtn.hidden = !narrow.matches;
  phoneBar.hidden = true;
  closeBtn.hidden = !(rail && framed && hostBar());
  const hb = hostBar();
  if (hb) hb.style.display = rail ? "none" : "";
  document.body.classList.toggle("withPhoneBar", bar);
  document.body.classList.toggle("tbRows", bar);
  document.body.classList.toggle("tbWide", bar && rail);
  if (!bar) document.body.style.removeProperty("--tbh");
  applyMode(Boolean(turn?.pinch));
  fitPage();
  if (turn) putBack();
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
