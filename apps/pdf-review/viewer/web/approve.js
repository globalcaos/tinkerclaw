// approve.js: ✓ Approve (2026-11-15). A paragraph printed blue is new text he has not read yet, and it keeps its
// colour until he approves it with the button at its end. The rule (2026-11-15 14:38): a blue
// paragraph never turns black again on its own; the approve button at its end does that, so no change goes
// unread. At 16:03 the button became less prominent, in the
// colour of the text; pressed, the text turns black at once and the button goes.
//
// The server finds the paragraphs that print blue (GET /api/approve: the PDF's span colours, each paragraph's .md
// block, its printed lines and where the last one ends) and approves one (POST /api/approve: into the approved text
// its build paints by, or its nw marker off). The button goes the moment it is pressed; once the Pi has the approval,
// the paragraph's blue on the page as drawn is painted in the body's grey (blacken), and painted again after every
// redraw, until the rebuilt PDF prints it so. autoreload.js asks ready() before it swaps a changed file in, so a run
// of approvals made close together is one swap: a swap reloads the whole document, seconds on a phone.
import { BASE, served } from "./base.js";

const app = window.PDFViewerApplication;
await app.initializedPromise;
const clog = (ev, d) => window.__clientLog?.(ev, d);
const QUIET_MS = 8000; // the rebuilt PDF comes in once no approval came for this long

const A = {
  path: "", // the PDF the items belong to
  items: [], // [{index, old, page, x, y0, y1, W, H, lines: [[page, x0, y0, x1, y1]]}]: PDF points from the page's top left
  pending: new Set(), // .md blocks whose approval is on its way to the Pi: no button, still blue
  done: new Set(), // .md blocks the Pi has approved that the PDF on screen still prints blue: no button, painted black
  last: 0, // when he last approved one
  gen: 0,
  quietT: 0,
  head: null, // [x0, y0, W, H]: where page 1's first printed line starts; ✓ Approve all goes in the margin above it
};
const UNDO_MS = 15000; // how long "N approved. ↶ Undo" stays after Approve all
const pathNow = () => (app.url ? decodeURIComponent(served(app.url)) : "");

async function load() {
  const path = pathNow();
  const doc = app.pdfDocument;
  const gen = ++A.gen;
  if (path !== A.path) { A.done.clear(); A.pending.clear(); }
  A.path = path;
  A.items = [];
  drawAll();
  if (!path) return;
  let body;
  try {
    const r = await fetch(`${BASE}/api/approve?path=${encodeURIComponent(path)}`, { cache: "no-store" });
    if (!r.ok) return;
    body = await r.json();
  } catch {
    return; // no connection to the Pi: no buttons, since an approval is made there
  }
  if (gen !== A.gen || app.pdfDocument !== doc) return; // another document came in meanwhile
  A.items = Array.isArray(body.items) ? body.items : [];
  A.head = Array.isArray(body.head) ? body.head : null;
  const blue = new Set(A.items.map((it) => it.old));
  for (const old of [...A.done]) if (!blue.has(old)) A.done.delete(old); // the PDF on screen prints it black now
  if (A.items.length) clog("approve-list", { n: A.items.length, done: A.done.size });
  drawAll();
}

function drawAll() {
  for (let n = 1; n <= (app.pdfViewer?.pagesCount || 0); n++) draw(n);
}

// pdf.js empties a page's div, and draws its canvas again, when it redraws it (zoom, or back from far away): the
// buttons are put back and the approved paragraphs painted black again each time.
function draw(n) {
  const div = app.pdfViewer.getPageView(n - 1)?.div;
  if (!div) return;
  for (const b of div.querySelectorAll(":scope > .apBtn")) b.remove();
  if (n === 1) drawAll1(div);
  for (const it of A.items) {
    if (it.page !== n || A.done.has(it.old) || A.pending.has(it.old)) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "apBtn";
    b.dataset.index = it.index;
    b.title = "Approve: you have read this change. It prints black from now on.";
    b.setAttribute("aria-label", "Approve this paragraph");
    // The page's own tools (selection, comments, Write) never see a press on the button.
    for (const ev of ["pointerdown", "mousedown", "touchstart"]) b.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      approve(it, b);
    });
    div.append(b);
    place(b, it, div);
  }
  blacken(n);
}

// ✓ Approve all (2026-11-17: when any blue text waits for approval, an extra Approve all button sits at
// the very beginning of the document). It sits in page 1's top margin, above the first printed line, and says how
// many are left. One press approves them all (2026-11-17 07:04: a first version asked for a second press within 4 s;
// he pressed once, looked for the change, and nothing had happened). A stray tap must still not mark a whole chapter
// as read for good, which is what the blue is there to prevent: a note offers ↶ Undo for UNDO_MS.
const waiting = () => A.items.filter((it) => !A.done.has(it.old) && !A.pending.has(it.old));
function drawAll1(div) {
  const left = waiting();
  if (!left.length) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "apBtn apAll";
  b.title = "Approve all: you have read every blue paragraph in this document. They print black from now on.";
  b.setAttribute("aria-label", `Approve all ${left.length} blue paragraphs`);
  for (const ev of ["pointerdown", "mousedown", "touchstart"]) b.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    approveAll();
  });
  div.append(b);
  allLabel(b);
  // Its size follows the printed lines, like the paragraph buttons; its place, the margin above page 1's first line.
  const it = left[0], h = div.clientHeight;
  if (h) b.style.setProperty("--ap", `${Math.max(15, Math.min(22, Math.round(((it.y1 - it.y0) / it.H) * h * 1.9)))}px`);
  const [x0, y0, W, H] = A.head || [it.W * 0.08, it.H * 0.06, it.W, it.H];
  b.style.left = `${(x0 / W) * 100}%`;
  b.style.top = `${(y0 / 2 / H) * 100}%`;
}
const allLabel = (b) => { b.textContent = `✓ Approve all (${waiting().length})`; };

async function approveAll() {
  const todo = waiting();
  if (!todo.length) return;
  for (const it of todo) A.pending.add(it.old);
  drawAll(); // every button goes at once
  clog("approve-all-sent", { n: todo.length });
  let r, body;
  try {
    r = await fetch(`${BASE}/api/approve?path=${encodeURIComponent(A.path)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: todo.map((it) => ({ index: it.index, old: it.old })) }),
    });
    body = await r.json().catch(() => ({}));
  } catch (err) {
    console.error("[approve] the Pi did not answer", err);
    clog("approve-all-failed", { n: todo.length, why: "no answer" });
    for (const it of todo) A.pending.delete(it.old);
    drawAll(); // the buttons come back
    return say("Not approved: the Pi did not answer. The paragraphs stay blue; press ✓ Approve all again when the connection is back.");
  }
  for (const it of todo) A.pending.delete(it.old);
  const ok = new Set(r.ok && Array.isArray(body.approved) ? body.approved : []);
  const pages = new Set();
  for (const it of todo) {
    if (!ok.has(it.old)) continue;
    A.done.add(it.old);
    for (const l of it.lines || []) pages.add(l[0]);
  }
  let px = 0;
  for (const n of pages) px += blacken(n);
  const missed = todo.length - ok.size;
  clog(ok.size ? "approve-all-ok" : "approve-all-failed", { n: ok.size, missed, status: r.status, px });
  drawAll();
  if (missed) {
    console.error("[approve] approve all: some changed meanwhile", r.status, body);
    load(); // read the blue paragraphs again: the changed ones get their buttons back
    say(ok.size ? `${ok.size} approved. ${missed} changed meanwhile and stay blue.` : `Not approved: ${body.error || `HTTP ${r.status}`}.`);
  }
  if (!ok.size) return;
  A.last = Date.now();
  clearTimeout(A.quietT);
  A.quietT = setTimeout(() => window.dispatchEvent(new Event("pdfreview:writer-idle")), QUIET_MS + 200);
  if (typeof body.undo === "string") undoNote(todo.filter((it) => ok.has(it.old)), body.undo);
}

// "N approved. ↶ Undo": the Pi puts the .md and the approved text back as they were (only if nothing changed them
// since); the paragraphs are no longer painted black, the pages are drawn again from the PDF, and the rebuild prints
// them blue again.
function undoNote(items, token) {
  document.querySelector(".apNote")?.remove();
  const n = document.createElement("div");
  n.className = "wrNote apNote apUndo";
  n.append(`${items.length} approved. `);
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "↶ Undo";
  b.addEventListener("click", () => { n.remove(); undoAll(items, token); });
  n.append(b);
  document.body.append(n);
  setTimeout(() => n.remove(), UNDO_MS);
}

async function undoAll(items, token) {
  clog("approve-all-undo", { n: items.length });
  let r, body;
  try {
    r = await fetch(`${BASE}/api/approve?path=${encodeURIComponent(A.path)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ undo: token }),
    });
    body = await r.json().catch(() => ({}));
  } catch (err) {
    console.error("[approve] the Pi did not answer the undo", err);
    clog("approve-all-undo-failed", { why: "no answer" });
    return say("Not undone: the Pi did not answer. The paragraphs stay approved.");
  }
  if (!r.ok) {
    clog("approve-all-undo-failed", { status: r.status, why: String(body.error || "").slice(0, 160) });
    return say(`Not undone: ${body.error || `HTTP ${r.status}`}.`);
  }
  for (const it of items) A.done.delete(it.old);
  A.last = Date.now(); // the rebuilt PDF, blue again, comes in after the usual quiet
  clearTimeout(A.quietT);
  A.quietT = setTimeout(() => window.dispatchEvent(new Event("pdfreview:writer-idle")), QUIET_MS + 200);
  app.pdfViewer.refresh(); // pages drawn again from the PDF on screen: no black paint
  drawAll();
  clog("approve-all-undone", { n: body.undone });
}

const label = (b) => { b.textContent = b.classList.contains("apIcon") ? "✓" : "✓ Approve"; };

// Right after the paragraph's last word, its top on the top of that last line, so it hangs into the space under the
// paragraph and never over the line above (a phone page shows a line about 10 px tall: a button centred on it
// covered the words above, 2026-11-15). Its size follows the printed line. A line that runs to the margin gets only
// the tick, in the margin; where even that does not fit, the button goes under the line's end. Positions are shares
// of the page, so they hold while pdf.js zooms the page before it redraws it.
function place(b, it, div) {
  const w = div.clientWidth, h = div.clientHeight;
  const x = (it.x / it.W) * 100, top = (it.y0 / it.H) * 100;
  if (h) b.style.setProperty("--ap", `${Math.max(13, Math.min(19, Math.round(((it.y1 - it.y0) / it.H) * h * 1.7)))}px`);
  b.classList.remove("apIcon", "apBelow");
  b.style.left = `calc(${x}% + 4px)`;
  b.style.top = `calc(${top}% - 1px)`;
  label(b);
  const xPx = (it.x / it.W) * w;
  if (!w || xPx + 4 + b.offsetWidth <= w - 2) return;
  b.classList.add("apIcon");
  label(b);
  b.style.left = `calc(${x}% + 3px)`;
  if (xPx + 3 + b.offsetWidth <= w - 1) return;
  b.classList.add("apBelow");
  b.style.left = `${x}%`;
  b.style.top = `calc(${(it.y1 / it.H) * 100}% + 2px)`;
}

// The approved paragraphs on page n, painted in the body's grey (#404040, md2pdf's text) on every canvas pdf.js drew
// the page on (the page, and the sharper one it adds over a zoomed-in part). Only the new-text blue changes: on the
// white page its pixels keep a full blue channel, with red and green falling in step as the letter's edge fades in
// (#1e90ff over white), so grey, brown and black ink, pictures and highlights are left as they are. Returns the
// pixels painted.
function blacken(n) {
  const div = app.pdfViewer.getPageView(n - 1)?.div;
  if (!div?.isConnected) return 0;
  const boxes = [];
  for (const it of A.items) if (A.done.has(it.old)) for (const l of it.lines || []) if (l[0] === n) boxes.push([it.W, it.H, l[1], l[2], l[3], l[4]]);
  if (!boxes.length) return 0;
  const pr = div.getBoundingClientRect();
  const ox = pr.left + div.clientLeft, oy = pr.top + div.clientTop, pw = div.clientWidth, ph = div.clientHeight;
  let painted = 0;
  for (const cv of div.querySelectorAll(".canvasWrapper canvas")) {
    const cr = cv.getBoundingClientRect();
    if (!cr.width || !cr.height || !cv.width || !cv.height) continue;
    const kx = cv.width / cr.width, ky = cv.height / cr.height;
    let ctx;
    try { ctx = cv.getContext("2d"); } catch { continue; }
    if (!ctx) continue;
    for (const [W, H, x0, y0, x1, y1] of boxes) {
      const pad = (y1 - y0) * 0.15;
      const X0 = Math.max(0, Math.floor((ox + ((x0 - pad) / W) * pw - cr.left) * kx));
      const X1 = Math.min(cv.width, Math.ceil((ox + ((x1 + pad) / W) * pw - cr.left) * kx));
      const Y0 = Math.max(0, Math.floor((oy + ((y0 - pad) / H) * ph - cr.top) * ky));
      const Y1 = Math.min(cv.height, Math.ceil((oy + ((y1 + pad) / H) * ph - cr.top) * ky));
      if (X1 <= X0 || Y1 <= Y0) continue;
      let img;
      try { img = ctx.getImageData(X0, Y0, X1 - X0, Y1 - Y0); } catch (err) { console.error("[approve] reading the page failed", err); return painted; }
      const d = img.data;
      let k = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 2] < 225) continue;
        const tr = (255 - d[i]) / 225, tg = (255 - d[i + 1]) / 111;
        if (tr < 0.04 || Math.abs(tr - tg) > 0.25) continue;
        d[i] = d[i + 1] = d[i + 2] = Math.round(255 - Math.min(1, tr) * (255 - 0x40));
        k++;
      }
      if (k) { ctx.putImageData(img, X0, Y0); painted += k; }
    }
  }
  return painted;
}

function say(text) {
  document.querySelector(".apNote")?.remove();
  const n = document.createElement("div");
  n.className = "wrNote apNote";
  n.textContent = text;
  document.body.append(n);
  setTimeout(() => n.remove(), 5000);
}

async function approve(it, b) {
  if (A.pending.has(it.old) || A.done.has(it.old)) return;
  A.pending.add(it.old);
  b.remove(); // pressed: the button goes at once
  clog("approve-sent", { index: it.index, page: it.page });
  let r, body;
  try {
    r = await fetch(`${BASE}/api/approve?path=${encodeURIComponent(A.path)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: it.index, old: it.old }),
    });
    body = await r.json().catch(() => ({}));
  } catch (err) {
    console.error("[approve] the Pi did not answer", err);
    clog("approve-failed", { index: it.index, why: "no answer" });
    A.pending.delete(it.old);
    draw(it.page); // the button comes back
    return say("Not approved: the Pi did not answer. The paragraph stays blue; press ✓ Approve again when the connection is back.");
  }
  A.pending.delete(it.old);
  if (!r.ok) {
    console.error("[approve] refused", r.status, body);
    clog("approve-failed", { index: it.index, status: r.status, why: String(body.error || "").slice(0, 160) });
    draw(it.page);
    if (r.status === 409) load(); // the paragraph changed in the source: read the blue paragraphs again
    return say(`Not approved: ${body.error || `HTTP ${r.status}`}.`);
  }
  A.done.add(it.old);
  A.last = Date.now();
  draw(1); // Approve all counts one fewer, or goes
  let px = 0;
  for (const n of new Set((it.lines || []).map((l) => l[0]))) px += blacken(n);
  clog("approve-ok", { index: it.index, how: body.how, px });
  // Once he stops approving for a while, autoreload.js swaps in the rebuilt PDF (it asks ready() first).
  clearTimeout(A.quietT);
  A.quietT = setTimeout(() => window.dispatchEvent(new Event("pdfreview:writer-idle")), QUIET_MS + 200);
}

app.eventBus.on("documentloaded", () => load());
app.eventBus.on("pagerendered", ({ pageNumber }) => draw(pageNumber));
// One page at a time (the phone's ⇆ Pages): pdf.js keeps only the page shown in the document and puts a drawn page
// back without drawing it again, so its buttons are placed again once it is on screen and has a size.
app.eventBus.on("pagechanging", ({ pageNumber }) => requestAnimationFrame(() => draw(pageNumber)));
if (app.pdfDocument) load();

export const approver = {
  /** May autoreload.js swap a changed file in now? Not while he is approving paragraph after paragraph. */
  ready: () => Date.now() - A.last >= QUIET_MS,
};
// For the tests: the blue paragraphs the page knows, those approved here, a fresh read of them, and preview: show
// these paragraphs as approved on this page only (nothing reaches the Pi; the next load forgets it).
window.__pdfApprove = { ...approver, items: () => A.items, done: () => [...A.done], head: () => A.head, load,
  preview: (olds) => { for (const o of olds) A.done.add(o); drawAll(); } };
