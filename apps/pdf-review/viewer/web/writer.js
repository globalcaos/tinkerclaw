// writer.js: ✏️ Write (2026-11-15). Tap a paragraph of a PDF built from a .md and type in it, on the page.
//
// Before, ✏️ opened the paragraph's Markdown in a box, and Save rebuilt the whole PDF behind a frozen page (a
// cold Chromium, PyMuPDF, the marks carried: 5 to 8 s on the Pi), then the page reloaded. Now the paragraph turns
// into the editor itself, in the print's face, size, colour and line width, and what he types shows at once; the
// text below a paragraph that grows or shrinks moves with it. The change goes into the .md through mdmap.js (only
// the characters he changed), the server saves it at once and rebuilds the PDF in the background (server.py
// Builder), and the page swaps the new PDF in only when it holds every edit made here, under a still copy of the
// page (frame()), so nothing blinks.
//
// A block mdmap.js cannot map (a table, a code block, raw HTML) opens the Markdown box, as before. The open
// editor has one button, ✓ Done (2026-11-15: a small "Md" button there opened the old Markdown card, and on his
// phone it looked like the way to save).
//
// autoreload.js owns the ✏️ button and the reload: it calls writer.toggle(), asks writer.ready() before swapping a
// changed file in, and wraps the swap in writer.frame() / writer.landed().
import { BASE, served } from "./base.js";
import { SPLIT, parse, applyEdit, runs, blocksOf, blockLetters, findBlock, portion, norm, lettersOf } from "./mdmap.js";
import * as off from "./offline.js";

const app = window.PDFViewerApplication;
await app.initializedPromise;
const clog = (ev, d) => window.__clientLog?.(ev, d);
const DRAFT_MS = 700;
// While Write is on, the rebuilt PDF waits until he has not touched a paragraph for this long: a swap reloads the
// whole document, seconds on a phone, and came between two paragraphs (2026-11-15). Write off swaps at once.
const WRITE_QUIET_MS = 30000;

const W = {
  on: false,
  btn: null,
  src: null, // {text, vis}: the .md as this page knows it, edits made here included
  srcFor: "",
  ed: null, // the edit being typed
  pages: new Map(), // page number -> {edits: [...], shift: canvas, bg}
  paras: new Map(), // page number -> the paragraphs read from that page's text
  doc: null, // the document the two maps above belong to
  saving: Promise.resolve(),
  inflight: 0,
  maxSaved: 0n, // the newest .md version (st_mtime_ns) an edit made here produced
  unsure: false, // an edit waits offline: its version is not known
  told: false,
  gen: 0, // counts edits made here: a source fetched before the latest one is out of date on arrival
  lastAct: 0, // when he last opened, typed in or closed a paragraph
  zoomWas: null, // the fit (page-fit, page-width) the page had before Write held its zoom
};
const pathNow = () => (app.url ? decodeURIComponent(served(app.url)) : "");
const pageView = (n) => app.pdfViewer.getPageView(n - 1);

// ---- the source ------------------------------------------------------------------------------------------
async function loadSource(force = false) {
  const path = pathNow();
  if (!force && W.src && W.srcFor === path) return W.src;
  const gen = W.gen;
  const r = await fetch(`${BASE}/api/source?path=${encodeURIComponent(path)}&text=1`, { cache: "no-store" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || typeof body.text !== "string") throw new Error(body.error || "this PDF has no text source");
  if (gen !== W.gen && W.srcFor === path) return W.src; // an edit was made meanwhile: the copy here is newer
  const text = off.OFFLINE && off.pendingApplied ? off.pendingApplied(path, body.text) : body.text;
  // The server's reading of each block holds only for the text it sent: edits waiting here change it.
  W.src = { text, vis: text === body.text && Array.isArray(body.vis) ? body.vis : null };
  W.srcFor = path;
  return W.src;
}

// ---- fonts: the PDF's own faces, whole, from the server (server.py /viewer/web/fonts/) ----------------------
const faces = new Map();
function family(base) {
  if (!base) return "";
  if (faces.has(base)) return faces.get(base);
  const fam = `wr-${base}`;
  faces.set(base, fam);
  for (const [suf, weight, style] of [["", "400", "normal"], ["-Bold", "700", "normal"], ["-Italic", "400", "italic"], ["-BoldItalic", "700", "italic"]]) {
    const f = new FontFace(fam, `url("${BASE}/viewer/web/fonts/${base}${suf}.ttf")`, { weight, style });
    document.fonts.add(f);
    f.load().then(() => relayoutAll()).catch(() => {}); // a face this machine lacks: the browser slants or bolds the regular one
  }
  return fam;
}
function fontOf(pv, fontName) {
  let name = "";
  try { if (pv.pdfPage.commonObjs.has(fontName)) name = pv.pdfPage.commonObjs.get(fontName)?.name || ""; } catch {}
  name = String(name).replace(/^[A-Z]{6}\+/, "");
  const base = name.replace(/[-,]?(BoldItalic|BoldOblique|Bold|Italic|Oblique|Regular|Roman|Book|Medium)$/i, "");
  return { base: /^[A-Za-z0-9._+-]{1,60}$/.test(base) ? base : "", bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique/i.test(name) };
}

// ---- reading a page: its lines and paragraphs, in PDF units -------------------------------------------------
const MARKER = /^([•◦▪‣·–-]|\d+[.)])$/;
async function readPage(pv) {
  if (W.doc !== app.pdfDocument) { W.doc = app.pdfDocument; W.paras.clear(); }
  if (W.paras.has(pv.id)) return W.paras.get(pv.id);
  const tc = await pv.pdfPage.getTextContent();
  const lines = [];
  let L = null;
  for (const it of tc.items) {
    if (typeof it.str !== "string") continue;
    const [a, b, c, d, x, y] = it.transform;
    const fs = Math.hypot(c, d) || Math.hypot(a, b) || 1;
    const blank = !it.str.trim();
    if (!L || Math.abs(y - L.y) > Math.min(fs, L.fs || fs) * 0.45) {
      if (blank) { L = null; continue; }
      L = { y, fs: 0, x0: Infinity, x1: -Infinity, items: [], fonts: {}, text: "" };
      lines.push(L);
    }
    L.items.push({ s: it.str, x, w: it.width, f: it.fontName });
    L.text += it.str;
    if (!blank) {
      L.x0 = Math.min(L.x0, x);
      L.x1 = Math.max(L.x1, x + it.width);
      L.fs = Math.max(L.fs, fs);
      L.fonts[it.fontName] = (L.fonts[it.fontName] || 0) + it.str.length;
    }
    if (it.hasEOL) L = null;
  }
  for (const l of lines) {
    const words = l.items.filter((it) => it.s.trim());
    const first = words[0]?.s.trim() || "";
    l.marker = MARKER.test(first) && words.length > 1;
    l.tx0 = l.marker ? words[1].x : l.x0;
    l.text = l.text.trim();
  }
  lines.sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const paras = [];
  for (const l of lines) {
    const P = paras[paras.length - 1];
    const last = P?.lines[P.lines.length - 1];
    const gap = last ? last.y - l.y : Infinity;
    if (P && !l.marker && Math.abs(l.fs - P.fs) < P.fs * 0.12 && gap > 0 && gap < P.fs * 2.1 && Math.abs(l.tx0 - P.tx0) < P.fs * 6) P.lines.push(l);
    else paras.push({ lines: [l], fs: l.fs, tx0: l.tx0 });
  }
  // the page's measures: body text size, its left edge, line height to text size
  const sizes = {};
  for (const l of lines) sizes[l.fs.toFixed(1)] = (sizes[l.fs.toFixed(1)] || 0) + l.text.length;
  const body = +Object.entries(sizes).sort((p, q) => q[1] - p[1])[0]?.[0] || 10;
  const left = Math.min(...lines.filter((l) => Math.abs(l.fs - body) < body * 0.12).map((l) => l.x0), Infinity);
  // Chromium prints each line on a whole pixel, so gaps alternate (14.33 and 14.98 pt for a true 14.51 on a SOUL
  // TAX page, 2026-11-15): line height is the mean gap, never one gap.
  let gapSum = 0, gapN = 0;
  for (const P of paras) if (P.lines.length > 1) { gapSum += (P.lines[0].y - P.lines[P.lines.length - 1].y) / P.fs; gapN += P.lines.length - 1; }
  const ratio = gapN ? gapSum / gapN : 1.65;
  const [vx0, , vx1] = pv.pdfPage.view;
  for (const P of paras) {
    P.text = P.lines.map((l) => l.text).join(" ");
    P.tx0 = Math.min(...P.lines.map((l) => l.tx0));
    P.lh = P.lines.length > 1 ? (P.lines[0].y - P.lines[P.lines.length - 1].y) / (P.lines.length - 1) : ratio * P.fs;
    P.W = width(P, Number.isFinite(left) ? vx1 - vx0 - (left - vx0) - P.tx0 + vx0 : Infinity);
    const fonts = {};
    for (const l of P.lines) for (const [f, n] of Object.entries(l.fonts)) fonts[f] = (fonts[f] || 0) + n;
    P.font = Object.entries(fonts).sort((p, q) => q[1] - p[1])[0]?.[0];
    P.generic = tc.styles[P.font]?.fontFamily || "serif";
  }
  W.paras.set(pv.id, paras);
  return paras;
}

// The width the lines were broken at. Each line but the last broke because its next word did not fit, so the
// width lies between the longest line and (a line + a space + the next line's first word). The column's own
// width (symmetric page margins) wins when it fits in that range; a box (a quote) gets the middle of it.
function width(P, column) {
  const words = (l) => l.items.filter((it) => it.s.trim());
  let lo = 0, hi = Infinity, space = [];
  for (const l of P.lines) for (const it of l.items) if (it.s === " " && it.w > 0) space.push(it.w);
  space = space.length ? space.sort((p, q) => p - q)[space.length >> 1] : P.fs * 0.318;
  P.lines.forEach((l, i) => {
    lo = Math.max(lo, l.x1 - P.tx0);
    const next = P.lines[i + 1];
    if (!next) return;
    let w = 0;
    for (const it of words(next).slice(next.marker ? 1 : 0)) {
      const sp = it.s.search(/\s/);
      if (sp >= 0) { w += it.w * (sp / it.s.length); break; }
      w += it.w;
      if (/\s$/.test(it.s)) break;
    }
    hi = Math.min(hi, l.x1 - P.tx0 + space + w);
  });
  P.space = space;
  P.lineW = P.lines.map((l) => l.x1 - P.tx0);
  const room = 0.0012 * (Number.isFinite(column) ? column : lo); // ~0.6 pt on a page column
  if (hi === Infinity) return Math.max(lo + room, Number.isFinite(column) ? column : lo);
  // The column wins unless a line is longer than it, or it misses the bound by more than measuring noise: the
  // bound comes from summed advances, and a column 0.5 pt over it sent four book paragraphs to a width 13 pt
  // too narrow, every line breaking early (2026-11-15). A quote's box is ~30 pt narrower, well past that.
  let w = column >= lo - 0.5 && column < hi + P.fs * 0.35 ? column : (lo + hi) / 2;
  // Keep clear of both bounds where there is room: a printed line that filled the column to 0.09 pt (ch02 p.2)
  // must still fit here, and a word that just missed a line in print must miss it here too.
  if (hi - lo > 2 * room) w = Math.min(Math.max(w, lo + room), hi - room);
  return hi > lo ? w : lo + 0.5;
}

// The letters of a block, kept: after each save only the changed block is read again (on a phone, reading every
// block of a chapter again took a noticeable moment on the next tap).
const lettersMemo = new Map();
function lettersOfBlock(b) {
  let v = lettersMemo.get(b);
  if (v === undefined) {
    v = blockLetters([b])[0];
    if (lettersMemo.size > 5000) lettersMemo.clear();
    lettersMemo.set(b, v);
  }
  return v;
}

function hit(paras, x, y) {
  let best = null, bd = Infinity;
  for (const P of paras) {
    const top = P.lines[0].y + P.fs * 1.0 + P.lh * 0.2, bottom = P.lines[P.lines.length - 1].y - P.fs * 0.3 - P.lh * 0.3;
    if (y > top || y < bottom || x < P.tx0 - P.fs * 2.5 || x > P.tx0 + P.W + P.fs) continue;
    const d = Math.abs(y - (top + bottom) / 2);
    if (d < bd) { bd = d; best = P; }
  }
  return best;
}

// ---- colours, read off the printed page ----------------------------------------------------------------
// The ink colour of thin antialiased letters never reaches the true colour at low zoom, so a colour near one
// md2pdf prints in (body, bold, headings, the round's new-text blue, greys) is taken as that colour.
const PALETTE = ["#404040", "#3b2a14", "#7a3921", "#1e90ff", "#6a6a6a", "#000000", "#333333", "#555555", "#222222"].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
function colours(pv, P) {
  const out = { bg: "#ffffff", color: "#404040" };
  try {
    const vp = pv.viewport, cv = pv.canvas, l = P.lines[0];
    const [x1, y1] = vp.convertToViewportPoint(l.tx0, l.y + l.fs * 0.85);
    const [x2, y2] = vp.convertToViewportPoint(Math.min(l.x1, l.tx0 + l.fs * 25), l.y - l.fs * 0.25);
    const k = cv.width / vp.width;
    const X = Math.max(0, Math.floor(Math.min(x1, x2) * k)), Y = Math.max(0, Math.floor(Math.min(y1, y2) * k));
    const w = Math.max(1, Math.min(cv.width - X, Math.ceil(Math.abs(x2 - x1) * k))), h = Math.max(1, Math.min(cv.height - Y, Math.ceil(Math.abs(y2 - y1) * k)));
    const d = cv.getContext("2d").getImageData(X, Y, w, h).data;
    const count = new Map();
    for (let i = 0; i < d.length; i += 4) { const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); count.set(key, (count.get(key) || 0) + 1); }
    let bgKey = 0, most = -1;
    for (const [key, n] of count) if (n > most) { most = n; bgKey = key; }
    let s = [0, 0, 0], n = 0;
    for (let i = 0; i < d.length; i += 4) if ((((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)) === bgKey) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
    const bg = s.map((v) => Math.round(v / n));
    let far = -1, ink = bg;
    for (let i = 0; i < d.length; i += 4) { const dist = (d[i] - bg[0]) ** 2 + (d[i + 1] - bg[1]) ** 2 + (d[i + 2] - bg[2]) ** 2; if (dist > far) { far = dist; ink = [d[i], d[i + 1], d[i + 2]]; } }
    let pick = ink, bestD = 40 ** 2;
    for (const c of PALETTE) {
      const v = c.map((x, j) => x - bg[j]), u = ink.map((x, j) => x - bg[j]);
      const vv = v.reduce((a, x) => a + x * x, 0);
      if (!vv) continue;
      const t = u.reduce((a, x, j) => a + x * v[j], 0) / vv;
      if (t < 0.45 || t > 1.08) continue;
      const dist = u.reduce((a, x, j) => a + (x - t * v[j]) ** 2, 0);
      if (dist < bestD) { bestD = dist; pick = c; }
    }
    out.bg = `rgb(${bg.join(",")})`;
    out.color = `rgb(${pick.join(",")})`;
  } catch (err) {
    console.error("[writer] reading the page colours failed", err);
  }
  return out;
}

// ---- edits on a page, and the page moving under them ------------------------------------------------------
const probe = document.createElement("div");
Object.assign(probe.style, { position: "absolute", left: "0", top: "0", visibility: "hidden", whiteSpace: "nowrap", margin: "0", padding: "0", border: "0" });
const mark = document.createElement("span"); // a box of no size sits on the baseline
Object.assign(mark.style, { display: "inline-block", width: "0", height: "0" });
function baseline(el) {
  probe.style.font = getComputedStyle(el).font;
  probe.style.lineHeight = el.style.lineHeight;
  probe.replaceChildren("Hg", mark);
  el.parentNode.append(probe);
  const off = probe.lastChild.getBoundingClientRect().top - probe.getBoundingClientRect().top;
  probe.remove();
  return off;
}

// The page as pdf.js shows it: its viewport, scaled to the page's real box. pdf.js rounds a page's box (on a
// phone 369×522 CSS px for a 371×525 viewport, 2026-11-15) and its canvas and text layer fill that box, so a point
// placed by the viewport alone drifts up to 3 px toward the bottom right.
function frameOf(pv) {
  const vp = pv.viewport;
  const fx = (pv.div.clientWidth || vp.width) / vp.width, fy = (pv.div.clientHeight || vp.height) / vp.height;
  return {
    fx, fy, w: vp.width * fx, h: vp.height * fy, s: vp.scale,
    toCss: (x, y) => { const [a, b] = vp.convertToViewportPoint(x, y); return [a * fx, b * fy]; },
    toPdf: (x, y) => vp.convertToPdfPoint(x / fx, y / fy),
  };
}

function relayout(n) {
  const pg = W.pages.get(n);
  const pv = pageView(n);
  if (!pg || !pv?.viewport || !pv.div) return;
  if (!pg.edits.length) { pg.shift?.remove(); W.pages.delete(n); return; }
  const F = frameOf(pv), s = F.s;
  for (const E of pg.edits) {
    if (E.el.parentNode !== pv.div) pv.div.append(E.el);
    if (E.open && E.md && E.md.previousSibling !== E.el) E.el.after(E.md);
    const g = E.geo;
    const [cx, cy] = F.toCss(g.x0, g.y0);
    Object.assign(E.el.style, { left: `${cx}px`, width: `${g.W * s * F.fx}px`, fontSize: `${g.fs * s * F.fy}px`, lineHeight: `${g.lh * s * F.fy}px` });
    E.origTop = cy - baseline(E.el);
    E.origH = g.n * g.lh * s * F.fy;
  }
  pg.edits.sort((p, q) => p.origTop - q.origTop);
  let D = 0, prev = null;
  const segs = [];
  for (const E of pg.edits) {
    if (prev !== null) segs.push([prev, E.origTop, D]);
    E.el.style.top = `${E.origTop + D}px`;
    E.h = E.el.offsetHeight;
    D += E.h - E.origH;
    prev = E.origTop + E.origH;
  }
  segs.push([prev, F.h, D]);
  pg.D = D;
  for (const E of pg.edits) if (E.open) placeMd(E);
  const src = pv.canvas;
  if (!src?.width) return;
  const top = Math.max(0, pg.edits[0].origTop);
  const c = pg.shift || (pg.shift = Object.assign(document.createElement("canvas"), { className: "wrShift" }));
  if (c.parentNode !== pv.div) pv.div.append(c);
  const k = src.height / F.h, H = Math.max(1, F.h - top); // canvas pixels per CSS pixel of the page's box
  c.width = src.width;
  c.height = Math.max(1, Math.round(H * k));
  c.style.top = `${top}px`;
  c.style.width = `${F.w}px`;
  c.style.height = `${H}px`;
  const ctx = c.getContext("2d");
  ctx.fillStyle = pg.bg || "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  for (const [a, b, d] of segs) {
    if (b - a < 0.5) continue;
    ctx.drawImage(src, 0, a * k, src.width, (b - a) * k, 0, (a + d - top) * k, c.width, (b - a) * k);
  }
}
let laidOut = 0;
// The editor's words as wide as the print's. At a small screen size Chromium sets a line ~0.16 % narrower than
// the print did at its own size (the book's ch02, 2026-11-15: 0.02 % at 13.5 px), enough to pull a word up a line
// and shift every word after it; and the error differs line to line, so a printed line that filled the column to
// 0.09 pt still broke elsewhere with one figure for the whole paragraph. Measured once, before any typing: the
// words of each printed line, here and on one line, against that line in print; the difference goes over its
// characters as letter spacing, in em so it holds at any zoom. Typing in a line keeps that line's spacing.
function calibrate(E, pv) {
  const g = E.geo;
  if (!E.base.length) return;
  const F = frameOf(pv);
  const fontPx = parseFloat(E.el.style.fontSize) || g.fs * F.s * F.fy;
  const c = E.el.cloneNode(true);
  Object.assign(c.style, { position: "absolute", visibility: "hidden", whiteSpace: "nowrap", width: "auto", letterSpacing: "0px", top: "0", left: "0" });
  pv.div.append(c);
  const clones = c.querySelectorAll(".wrLine"), live = E.el.querySelectorAll(".wrLine");
  if (E.lines && clones.length === E.lines.length && live.length === E.lines.length) {
    g.lines.forEach((l, k) => {
      const [c0, c1] = E.lines[k];
      const em = ((l.x1 - l.tx0) * F.s * F.fx - clones[k].getBoundingClientRect().width) / [...E.base.slice(c0, c1)].length / fontPx;
      if (Math.abs(em) < 0.05) live[k].style.letterSpacing = `${em}em`; // a bigger gap means a measuring error: leave it
    });
  } else if (g.lineW?.length) {
    const printed = (g.lineW.reduce((a, w) => a + w, 0) + (g.lineW.length - 1) * g.space) * F.s * F.fx;
    const em = (printed - c.getBoundingClientRect().width) / [...E.base].length / fontPx;
    if (Math.abs(em) < 0.02) E.el.style.letterSpacing = `${em}em`;
  }
  c.remove();
}

// Which characters of the editor's text each printed line holds: [[from, to], ...], or null when the lines and
// the text do not line up letter for letter. A line keeps the punctuation at its ends; the space a break took
// stays between lines.
function lineRanges(E) {
  const t = E.base;
  const [bl, bm] = lettersOf(t);
  const out = [];
  let pos = 0;
  for (const l of E.geo.lines) {
    const [ll] = lettersOf(l.marker ? l.text.replace(/^\s*\S+\s+/, "") : l.text);
    if (!ll.length || bl.slice(pos, pos + ll.length) !== ll) return null;
    let c0 = bm[pos], c1 = bm[pos + ll.length - 1] + 1;
    const from = out.length ? out[out.length - 1][1] : 0;
    while (c0 > from && t[c0 - 1] !== " " && !/[\p{L}\p{N}]/u.test(t[c0 - 1])) c0--;
    while (c1 < t.length && t[c1] !== " " && !/[\p{L}\p{N}]/u.test(t[c1])) c1++;
    out.push([c0, c1]);
    pos += ll.length;
  }
  return pos === bl.length ? out : null;
}

function relayoutAll() {
  cancelAnimationFrame(laidOut);
  laidOut = requestAnimationFrame(() => { for (const n of [...W.pages.keys()]) relayout(n); });
}
const relayoutSoon = (n) => requestAnimationFrame(() => relayout(n));

// A point on the page as it shows (with edits moving text) back to where it is in the printed page.
function original(n, y) {
  const pg = W.pages.get(n);
  if (!pg) return { y };
  let D = 0;
  for (const E of pg.edits) {
    const top = E.origTop + D;
    if (y < top) return { y: y - D };
    if (y <= top + E.h) return { edit: E };
    D += E.h - E.origH;
  }
  return { y: y - D };
}

// ---- notes ----------------------------------------------------------------------------------------------
function note(text, { typed = "", buttons = [], ms = 4500 } = {}) {
  document.querySelector(".wrNote")?.remove();
  const n = document.createElement("div");
  n.className = "wrNote";
  n.textContent = text;
  if (typed) {
    const t = document.createElement("span");
    t.className = "wrTyped";
    t.textContent = typed;
    n.append(t);
  }
  for (const [label, f] of [...buttons, ["OK", () => {}]]) {
    if (!buttons.length && label === "OK") break;
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { n.remove(); f(); };
    n.append(b);
  }
  document.body.append(n);
  if (!buttons.length) setTimeout(() => n.remove(), ms);
}

// ---- the Markdown box (autoreload.js editPopup), for what is not just words -------------------------------
function box(index, text) {
  if (!window.__pdfEditPopup) return note("The Markdown box is not available on this page.");
  window.__pdfEditPopup({ index, text }, pathNow());
}

// ---- opening, typing, saving ----------------------------------------------------------------------------
const textOf = (el) => el.innerText.replace(/ /g, " ").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n+/g, "\n").trim();

function makeEditor(E) {
  const el = document.createElement("div");
  el.className = "wrEd";
  el.spellcheck = true;
  el.setAttribute("autocapitalize", "sentences");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-label", "Paragraph text");
  const g = E.geo;
  el.style.fontFamily = `${g.fam ? `"${g.fam}", ` : ""}${g.generic}`;
  el.style.fontWeight = g.bold ? "700" : "400";
  el.style.fontStyle = g.italic ? "italic" : "normal";
  el.style.color = g.color;
  el.style.background = g.bg;
  // Through the DOM: the page's CSP drops style attributes written in HTML. Each printed line in a span of its
  // own, so calibrate() can give it its own letter spacing.
  const add = (parent, from, to) => {
    for (const r of runs(E.P, E.a + from, E.a + to)) {
      if (!Object.keys(r.css).length) { parent.append(r.text); continue; }
      const sp = document.createElement("span");
      Object.assign(sp.style, r.css);
      sp.textContent = r.text;
      parent.append(sp);
    }
  };
  E.lines = lineRanges(E);
  if (E.lines) {
    let at = 0;
    for (const [c0, c1] of E.lines) {
      if (c0 > at) add(el, at, c0);
      const w = document.createElement("span");
      w.className = "wrLine";
      add(w, c0, c1);
      el.append(w);
      at = c1;
    }
    if (at < E.base.length) add(el, at, E.base.length);
  } else add(el, 0, E.base.length);
  el.addEventListener("input", () => typed(E));
  el.addEventListener("keydown", (e) => {
    e.stopPropagation(); // pdf.js and the tools read keys on window: none of them is meant while typing
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); document.execCommand("insertLineBreak"); typed(E); }
    else if (e.key === "Escape") { e.preventDefault(); finish(E); }
    else if ((e.ctrlKey || e.metaKey) && /^[biu]$/i.test(e.key)) e.preventDefault(); // words only: the Md button does looks
  });
  el.addEventListener("paste", (e) => {
    e.preventDefault();
    const t = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n");
    if (t) document.execCommand("insertText", false, t);
  });
  el.addEventListener("drop", (e) => e.preventDefault());
  // A blur is not a decision to stop: the phone's keyboard closing, the page redrawn under the editor or another
  // app taking the screen all blur it (his phone, 2026-11-15: editors closed a second after they opened). What is
  // typed is saved; the editor stays open until ✓ Done, a tap elsewhere on the page, Esc, or Write off.
  el.addEventListener("blur", () => setTimeout(() => {
    if (W.ed === E && E.open && document.activeElement !== E.el) commit(E);
  }, 0));
  return el;
}

function caretAt(el, x, y) {
  let r = null;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p && el.contains(p.offsetNode)) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); }
  } else if (document.caretRangeFromPoint) {
    const q = document.caretRangeFromPoint(x, y);
    if (q && el.contains(q.startContainer)) r = q;
  }
  if (!r) { r = document.createRange(); r.selectNodeContents(el); r.collapse(false); }
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function startEditing(E, x, y) {
  if (W.ed && W.ed !== E) finish(W.ed);
  W.ed = E;
  E.open = true;
  E.el.contentEditable = "true";
  E.el.classList.add("wrOpen");
  E.el.classList.remove("wrBad");
  E.el.focus({ preventScroll: true });
  if (x !== undefined) caretAt(E.el, x, y);
  if (!E.md) {
    E.md = document.createElement("button");
    E.md.type = "button";
    E.md.className = "wrDone";
    E.md.textContent = "✓ Done";
    E.md.title = "Save this paragraph and stop typing in it";
    E.md.addEventListener("pointerdown", (e) => e.preventDefault()); // the caret stays until the click lands
    E.md.addEventListener("click", (e) => {
      e.stopPropagation();
      finish(E);
      E.el.blur();
      setOn(false); // the architect 2026-11-15 23:10: when the paragraph is done, the ✏️ button unpresses by itself
    });
  }
  E.el.after(E.md);
  placeMd(E);
  W.lastAct = Date.now();
  keepCaretVisible();
  clog("write-open", { page: E.page, index: E.index, chars: E.base.length, part: E.a > 0 || E.b < E.P0len });
}
// ✓ Done sits above the editor's right end, inside the page (beside it, a phone's narrow screen cut it off).
function placeMd(E) {
  if (!E.md?.isConnected) return;
  const top = parseFloat(E.el.style.top), h = E.md.offsetHeight || 20;
  E.md.style.left = `${parseFloat(E.el.style.left) + E.el.offsetWidth - (E.md.offsetWidth || 30)}px`;
  E.md.style.top = `${top - h - 5 >= 0 ? top - h - 5 : top + E.el.offsetHeight + 5}px`;
}

function keepCaretVisible() {
  const sel = getSelection();
  if (!W.ed || !sel.rangeCount) return;
  const r = sel.getRangeAt(0).getClientRects()[0] || W.ed.el.getBoundingClientRect();
  const bar = document.body.classList.contains("tbRows") ? document.getElementById("toolbarContainer")?.getBoundingClientRect().top : Infinity;
  const limit = Math.min(window.visualViewport?.height ?? innerHeight, bar || Infinity) - 12;
  const c = app.pdfViewer.container;
  if (r.bottom > limit) c.scrollTop += r.bottom - limit + 24;
  else if (r.top < c.getBoundingClientRect().top + 8) c.scrollTop -= c.getBoundingClientRect().top + 8 - r.top + 24;
}
window.visualViewport?.addEventListener("resize", () => W.ed && requestAnimationFrame(keepCaretVisible));

// Typing saves nothing yet: a save is a rebuild of the whole PDF on the Pi, and one every few seconds of typing
// kept a busy Pi busier (2026-11-15). The draft below keeps the words safe until ✓ Done.
function typed(E) {
  W.lastAct = Date.now();
  relayoutSoon(E.page);
  requestAnimationFrame(() => { placeMd(E); keepCaretVisible(); });
  clearTimeout(E.draftT);
  E.draftT = setTimeout(() => keepDraft(E), DRAFT_MS);
}

// What is typed and not saved yet goes to this device and the server as an Edit paragraph draft, the same one
// the Markdown box keeps: a page that dies brings it back (autoreload.js restoreEdit), and the chat can read it.
const draftKey = () => "pdfreview.draft:" + decodeURIComponent(app.url || "");
// One after another: on a slow link a draft sent just before the clear could arrive after it and stay on the
// server, and the next open would bring back the Markdown box with it.
let draftChain = Promise.resolve();
const postDraft = (d) => {
  const path = pathNow();
  draftChain = draftChain.then(() => fetch(`${BASE}/api/editdraft?path=${encodeURIComponent(path)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) })
    .catch((err) => console.error("[writer] sending the draft failed", err)));
  return draftChain;
};
function keepDraft(E) {
  const t = textOf(E.el);
  if (t === E.savedRaw) return;
  let md = E.old;
  try { md = applyEdit(E.old, E.P, E.prefix + t + E.suffix) || md; } catch {}
  const d = { text: md, at: Date.now(), saved: false, kind: "edit", index: E.index, old: E.old, caret: 0 };
  try { localStorage.setItem(draftKey(), JSON.stringify(d)); } catch {}
  postDraft(d);
  E.drafted = true;
}
function dropDraft(E) {
  clearTimeout(E.draftT);
  if (!E.drafted) return;
  E.drafted = false;
  try { if (JSON.parse(localStorage.getItem(draftKey()) || "null")?.kind === "edit") localStorage.removeItem(draftKey()); } catch {}
  postDraft({ clear: true });
}

function fail(E, why, typedText, retry = null) {
  E.el.classList.add("wrBad");
  if (E.open) { // stop typing into a paragraph whose save went wrong; the note says what to do
    E.open = false;
    E.el.contentEditable = "false";
    E.el.classList.remove("wrOpen");
    E.md?.remove();
    if (W.ed === E) W.ed = null;
    window.dispatchEvent(new Event("pdfreview:writer-idle"));
  }
  console.error("[writer] edit not saved:", why);
  clog("write-failed", { index: E.index, why: String(why).slice(0, 200) });
  const words = typedText ?? textOf(E.el);
  note(`This change was not saved: ${why}. Your words:`, {
    typed: words,
    buttons: [
      // The paragraph moved on under him (an agent, the other device): his words go in its place, with one tap. The
      // Pi kept them too (state/refused/, and the open box comes back with them on the next open).
      ...(retry ? [["Put my words in", retry]] : []),
      ["Copy", () => navigator.clipboard?.writeText(words).catch(() => {})],
      ["Undo it", () => { removeEdit(E); loadSource(true).catch(() => {}); }],
      ["Markdown box", async () => { removeEdit(E); await loadSource(true).catch(() => {}); const bl = blocksOf(W.src?.text || ""); const i = findBlock(bl, E.P.text); if (i >= 0) box(i, bl[i]); }],
    ],
  });
}

/** Save what is typed in E now (the editor may stay open). */
function commit(E) {
  const t = textOf(E.el);
  if (t === E.savedRaw) return;
  let md;
  try { md = applyEdit(E.old, E.P, E.prefix + t + E.suffix); }
  catch (err) { fail(E, err.message, t); return; }
  if (md === E.old) { E.savedRaw = t; dropDraft(E); return; }
  const parts = W.src.text.split(SPLIT);
  const i = 2 * E.index;
  if (parts[i] !== E.old) { fail(E, "the text source changed under this page", t); return; }
  // The same rule as server.py: a deleted last block hands the file's final newline to the block before it.
  if (md) parts[i] = md;
  else if (parts.length === 1) parts[0] = "";
  else if (i + 1 < parts.length) parts.splice(i, 2);
  else { const tail = parts[i].match(/\n+$/)?.[0] ?? ""; parts.splice(i - 1, 2); parts[i - 2] += tail; }
  const whole = blocksOf(md).length === 1;
  W.src.text = parts.join("");
  if (W.src.vis && whole) W.src.vis[E.index] = norm(E.prefix + t + E.suffix);
  else W.src.vis = null; // block numbers moved: the server's reading comes back with the next fetch
  // Sent without the file's final newline: the server (and offline.js for a waiting edit) keeps the old block's own.
  const req = { path: pathNow(), index: E.index, old: E.old, new: md.replace(/\n+$/, ""), vis: norm(E.prefix + t + E.suffix) };
  E.savedRaw = t;
  E.changed = true;
  W.gen++;
  if (whole) { E.old = md; E.P = parse(md); }
  else if (E.open) setTimeout(() => finish(E), 0); // now several paragraphs (or none): this editor is done
  E.pending = (E.pending || 0) + 1;
  W.inflight++;
  W.saving = W.saving.then(() => save(E, req, t)).finally(() => {
    E.pending--;
    if (--W.inflight === 0) { loadSource(true).catch(() => {}); window.dispatchEvent(new Event("pdfreview:writer-idle")); }
  });
}

async function save(E, req, t) {
  let r, body;
  try {
    r = await fetch(`${BASE}/api/paragraph?path=${encodeURIComponent(req.path)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: req.index, old: req.old, new: req.new, vis: req.vis, writer: true }),
    });
    body = await r.json().catch(() => ({}));
  } catch (err) {
    if (off.OFFLINE && err instanceof TypeError) {
      off.queueParagraph(req.path, req.index, req.old, req.new, { writer: true, vis: req.vis });
      W.unsure = true;
      dropDraft(E);
      note("✏️ Kept on this phone. It reaches the Pi, and the PDF is rebuilt, when the connection returns.");
      off.flush();
      return;
    }
    fail(E, "the Pi did not answer", t);
    return;
  }
  if (r.ok) {
    const v = BigInt(body.saved || 0);
    if (v > W.maxSaved) W.maxSaved = v;
    E.saved = v;
    if (E.savedRaw === t) dropDraft(E);
    clog("write-saved", { index: req.index, chars: req.new.length, blocks: req.new ? blocksOf(req.new).length : 0 });
    return;
  }
  const retry = r.status === 409 && typeof body.current === "string" ? () => putBack(E, req, body, t) : null;
  fail(E, r.status === 409 ? "this paragraph changed in the source meanwhile (another device or an agent)" : body.error || `HTTP ${r.status}`, t, retry);
}

/** One tap after a refusal: his words replace the paragraph that took the old one's place (the server's guess). */
async function putBack(E, req, at, t) {
  try {
    const r = await fetch(`${BASE}/api/paragraph?path=${encodeURIComponent(req.path)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: at.index, old: at.current, new: req.new, vis: req.vis, writer: true }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const again = r.status === 409 && typeof body.current === "string" ? () => putBack(E, req, body, t) : null;
      return note(`Still not saved: ${body.error || `HTTP ${r.status}`}. Your words:`, { typed: t, buttons: again ? [["Put my words in", again]] : [["Copy", () => navigator.clipboard?.writeText(t).catch(() => {})]] });
    }
    const v = BigInt(body.saved || 0);
    if (v > W.maxSaved) W.maxSaved = v;
    E.el.classList.remove("wrBad");
    E.drafted = true;
    dropDraft(E);
    clog("write-put-back", { index: at.index, chars: req.new.length });
    note("✓ Your words are in that paragraph now; the page catches up in a moment.");
    loadSource(true).catch(() => {});
    window.dispatchEvent(new Event("pdfreview:writer-idle"));
  } catch (err) {
    note(`The Pi did not answer: ${err.message || err}. Your words:`, { typed: t, buttons: [["Put my words in", () => putBack(E, req, at, t)]] });
  }
}

/** Close E: save it, and keep it drawn over the page until the rebuilt PDF shows it. */
function finish(E) {
  if (!E.open) return;
  commit(E);
  E.open = false;
  E.el.contentEditable = "false";
  E.el.classList.remove("wrOpen");
  E.md?.remove();
  if (W.ed === E) W.ed = null;
  if (!E.changed) removeEdit(E); // looked at, nothing changed: the print shows again
  else relayoutSoon(E.page);
  clog("write-close", {});
  W.lastAct = Date.now();
  window.dispatchEvent(new Event("pdfreview:writer-idle"));
  // the rebuilt PDF may come in once he has left the paragraphs alone for a while (ready())
  clearTimeout(W.quietT);
  W.quietT = setTimeout(() => window.dispatchEvent(new Event("pdfreview:writer-idle")), WRITE_QUIET_MS + 200);
}

function addEdit(n, E) {
  const pg = W.pages.get(n) || { edits: [], shift: null, bg: E.geo.bg };
  W.pages.set(n, pg);
  pg.edits.push(E);
}
function removeEdit(E) {
  const pg = W.pages.get(E.page);
  E.el.remove();
  E.md?.remove();
  dropDraft(E);
  if (W.ed === E) W.ed = null;
  if (!pg) return;
  pg.edits = pg.edits.filter((x) => x !== E);
  relayout(E.page);
}

async function prepare(pv) {
  try { await readPage(pv); } catch (err) { console.error("[writer] reading the page's text failed", err); }
}

function open(pageDiv, x, y, again = false) {
  const n = +pageDiv.dataset.pageNumber;
  const pv = pageView(n);
  if (!pv?.viewport) return;
  const r = pageDiv.getBoundingClientRect();
  const cx = x - r.left - pageDiv.clientLeft, cy = y - r.top - pageDiv.clientTop;
  const at = original(n, cy);
  if (at.edit) return startEditing(at.edit, x, y); // an edit already on the page: type in it again
  const paras = W.doc === app.pdfDocument ? W.paras.get(pv.id) : null;
  // A page not read yet (just redrawn after a rebuild): read it, then carry on with the same tap. On a phone the
  // keyboard may then wait for a second tap in the editor.
  if (!paras) { if (!again) prepare(pv).then(() => open(pageDiv, x, y, true)); return; }
  const [px, py] = frameOf(pv).toPdf(cx, at.y);
  const P = hit(paras, px, py);
  if (!P) { if (W.ed) finish(W.ed); return; }
  if (!W.src || W.srcFor !== pathNow()) {
    if (!again) loadSource().then(() => open(pageDiv, x, y, true), (err) => note(`The text source could not be loaded: ${err.message}`));
    return;
  }
  const blocks = blocksOf(W.src.text);
  if (W.src.lettersFor !== W.src.text) { W.src.letters = blocks.map(lettersOfBlock); W.src.lettersFor = W.src.text; }
  const k = paras.indexOf(P), near = [];
  for (let d = 1; d <= 6; d++) { if (paras[k - d]) near.push([paras[k - d].text, -1]); if (paras[k + d]) near.push([paras[k + d].text, 1]); }
  const i = findBlock(blocks, P.text, near, W.src.letters);
  if (i < 0) { note("This text is not in the source as it stands (a card, a caption, or words found in more than one place)."); clog("write-nosource", { text: P.text.slice(0, 80) }); return; }
  const parsed = parse(blocks[i]);
  const vis = W.src.vis?.[i];
  if (!parsed.ok || (W.src.vis && (typeof vis !== "string" || norm(vis) !== norm(parsed.text)))) {
    clog("write-box", { index: i, why: parsed.ok ? "read differently than the server" : parsed.why });
    return box(i, blocks[i]);
  }
  const part = portion(parsed.text, P.text, P === paras[0] ? "top" : P === paras[paras.length - 1] ? "bottom" : undefined);
  if (!part) { note("This paragraph could not be found in the text source."); clog("write-noportion", { index: i, text: P.text.slice(0, 80) }); return; }
  const [a, b] = part;
  const fnt = fontOf(pv, P.font);
  const col = colours(pv, P);
  const E = {
    page: n, index: i, old: blocks[i], P: parsed, P0len: parsed.text.length, a, b,
    prefix: parsed.text.slice(0, a), suffix: parsed.text.slice(b), base: parsed.text.slice(a, b),
    geo: { x0: P.tx0, y0: P.lines[0].y, W: P.W, fs: P.fs, lh: P.lh, n: P.lines.length, fam: family(fnt.base), generic: P.generic, bold: fnt.bold, italic: fnt.italic, lineW: P.lineW, space: P.space, lines: P.lines.map((l) => ({ text: l.text, tx0: l.tx0, x1: l.x1, marker: l.marker })), ...col },
    open: false, saved: null,
  };
  E.el = makeEditor(E);
  if (W.ed) finish(W.ed);
  addEdit(n, E);
  relayout(n);
  calibrate(E, pv);
  relayout(n);
  if (norm(textOf(E.el)) !== norm(E.base)) { // never type over words that differ from what will be saved
    removeEdit(E);
    clog("write-box", { index: i, why: "editor text differs" });
    return box(i, blocks[i]);
  }
  startEditing(E, x, y);
}

// Taps, while Write is on. Capture phase: the page's own tools never see them.
document.addEventListener("click", (e) => {
  if (!W.on) return;
  if (W.ed && (W.ed.el.contains(e.target) || e.target === W.ed.md)) return; // in the editor: the browser places the caret
  if (e.target.closest?.(".wrNote, .epWrap, #toolbarContainer, #phoneBar, .doorHanger, dialog, .apBtn")) return; // .apBtn: ✓ Approve (approve.js)
  // a marking's 💬 icon and its comment card are pdf.js's: the icon opens the card in Write too (2026-11-15)
  if (e.target.closest?.(".annotationCommentButton, .commentPopup")) return;
  const pageDiv = e.target.closest?.("#viewer .page");
  if (!pageDiv) { if (W.ed) finish(W.ed); return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  open(pageDiv, e.clientX, e.clientY);
}, true);

// pdf.js redraws a page (zoom, or back from far away) and drops what it did not make: put the edits back.
const rerendered = ({ pageNumber }) => {
  const pg = W.pages.get(pageNumber);
  if (pg) {
    const focused = W.ed && pg.edits.includes(W.ed) && document.activeElement === W.ed.el;
    relayout(pageNumber);
    if (focused && document.activeElement !== W.ed.el) W.ed.el.focus({ preventScroll: true });
  }
  if (W.on) { const pv = pageView(pageNumber); if (pv?.pdfPage) prepare(pv); }
};
app.eventBus.on("pagerendered", rerendered);
app.eventBus.on("textlayerrendered", rerendered);
app.eventBus.on("scalechanging", (e) => {
  relayoutAll();
  if (W.on && /^(auto|page-fit|page-width)$/.test(String(e?.presetValue ?? ""))) setTimeout(() => holdZoom(true), 0);
});
// A newly loaded document gets the phone's fit again (phone.js applyMode on pagesinit): hold it again after that.
app.eventBus.on("pagesinit", () => { if (W.on) setTimeout(() => setTimeout(() => holdZoom(true), 0), 0); });

// While Write is on the page keeps its zoom. On a phone the viewer fits the page to the screen's height
// (page-fit); the keyboard takes half that height, pdf.js refits and redraws the page, and the redraw took the
// editor away a second after it opened (his phone, 2026-11-15 10:31). A number instead of a fit holds the zoom;
// the fit comes back with Write off.
function holdZoom(on) {
  const v = app.pdfViewer;
  if (!v?.pagesCount) return;
  if (on) {
    const now = String(v.currentScaleValue);
    if (/^(auto|page-fit|page-width)$/.test(now)) {
      W.zoomWas = now;
      v.currentScaleValue = String(v.currentScale);
    }
  } else if (W.zoomWas) {
    const fit = W.zoomWas;
    W.zoomWas = null;
    v.currentScaleValue = fit;
  }
}
app.eventBus.on("documentloaded", () => {
  if (W.srcFor === pathNow()) return; // the same file again (a rebuild): landed() did the rest
  if (W.ed) finish(W.ed);
  writer.landed();
  W.src = null;
  if (W.on) loadSource(true).catch(() => {});
});
document.addEventListener("visibilitychange", () => { if (document.hidden && W.ed) commit(W.ed); });
addEventListener("pagehide", () => { if (W.ed) commit(W.ed); });

function setOn(on) {
  if (on === W.on) return;
  W.on = on;
  W.btn?.classList.toggle("on", on);
  W.btn?.setAttribute("aria-pressed", String(on));
  document.body.classList.toggle("writeMode", on);
  if (!on) {
    if (W.ed) finish(W.ed);
    holdZoom(false);
    clog("write-mode", { on });
    clearTimeout(W.quietT);
    window.dispatchEvent(new Event("pdfreview:writer-idle")); // Write off: the rebuilt PDF comes in now
    return;
  }
  holdZoom(true);
  for (const id of ["selectTool", "tapComment"]) {
    const b = document.getElementById(id);
    if (b?.getAttribute("aria-pressed") === "true") b.click();
  }
  if ((app.pdfViewer.annotationEditorMode ?? 0) > 0) app.eventBus.dispatch("switchannotationeditormode", { source: app, mode: 0 });
  family("DejaVuSerif");
  family("LiberationMono");
  loadSource(true).catch((err) => { console.error("[writer] loading the text source failed", err); note(`The text source could not be loaded: ${err.message}`); });
  for (let i = 1; i <= app.pdfViewer.pagesCount; i++) { const pv = pageView(i); if (pv?.pdfPage && pv.renderingState === 3) prepare(pv); }
  if (!W.told) {
    W.told = true;
    note("✏️ Write: tap a paragraph and type in it. The words go into the source at once; the PDF catches up by itself.");
  }
  clog("write-mode", { on });
}
// Select and Comment are the other way of tapping the page: choosing one ends Write.
document.addEventListener("click", (e) => { if (W.on && e.target.closest?.("#selectTool, #tapComment, #editorHighlightButton, #editorInkButton")) setOn(false); }, true);

// ---- the swap: a still copy of the page while the rebuilt PDF loads under it ----------------------------------
function frame() {
  const cont = app.pdfViewer.container;
  const cr = cont.getBoundingClientRect();
  const f = document.createElement("div");
  f.className = "wrFrame";
  Object.assign(f.style, { left: `${cr.left}px`, top: `${cr.top}px`, width: `${cr.width}px`, height: `${cr.height}px`, background: getComputedStyle(cont).backgroundColor });
  try {
    for (let i = 1; i <= app.pdfViewer.pagesCount; i++) {
      const pv = pageView(i);
      const r = pv?.div?.getBoundingClientRect();
      if (!r || r.bottom < cr.top || r.top > cr.bottom || !pv.canvas?.width) continue;
      const p = document.createElement("div");
      p.className = "wrFramePage";
      Object.assign(p.style, { left: `${r.left - cr.left + pv.div.clientLeft}px`, top: `${r.top - cr.top + pv.div.clientTop}px`, width: `${pv.div.clientWidth}px`, height: `${pv.div.clientHeight}px` });
      const holes = pv.div.style.getPropertyValue("--pic-holes");
      if (holes) p.style.setProperty("--pic-holes", holes);
      const copy = (src, css) => {
        const c = document.createElement("canvas");
        c.width = src.width;
        c.height = src.height;
        c.getContext("2d").drawImage(src, 0, 0);
        c.style.cssText = css;
        p.append(c);
      };
      copy(pv.canvas, "position:absolute;left:0;top:0;width:100%;height:100%");
      for (const el of pv.div.querySelectorAll(".wrShift")) copy(el, `position:absolute;left:0;top:${el.style.top};width:100%;height:${el.style.height}`);
      for (const el of pv.div.querySelectorAll(".wrEd")) p.append(Object.assign(el.cloneNode(true), { contentEditable: "false" }));
      f.append(p);
    }
  } catch (err) {
    console.error("[writer] the still copy of the page failed", err);
  }
  document.body.append(f);
  let gone = false;
  const release = () => {
    if (gone) return;
    gone = true;
    f.style.opacity = "0";
    setTimeout(() => f.remove(), 200);
  };
  return {
    /** Remove the copy once page n of the new document is drawn (at most 3 s). */
    release(n = app.pdfViewer.currentPageNumber) {
      const done = ({ pageNumber }) => { if (pageNumber === n) { app.eventBus.off("pagerendered", done); requestAnimationFrame(release); } };
      app.eventBus.on("pagerendered", done);
      setTimeout(() => { app.eventBus.off("pagerendered", done); release(); }, 3000);
    },
    drop: release,
  };
}

export const writer = {
  /** The ✏️ button, owned by autoreload.js. */
  attach(btn) {
    W.btn = btn;
    btn.setAttribute("aria-pressed", "false");
  },
  toggle(on = !W.on) { setOn(on); },
  get on() { return W.on; },
  /** May the viewer swap the changed file in now? Not under an open editor, not before a save has landed, and
   *  not while the file on disk lacks an edit still drawn over the page and a build that will hold it is due. */
  async ready() {
    if (W.ed?.open || W.inflight) return false;
    if (W.on && Date.now() - W.lastAct < WRITE_QUIET_MS) return false; // he is still writing: the edits stay drawn
    const edits = [...W.pages.values()].flatMap((p) => p.edits);
    if (!edits.length || W.unsure) return true;
    try {
      const r = await fetch(`${BASE}/api/built?path=${encodeURIComponent(pathNow())}`, { cache: "no-store" });
      const b = await r.json();
      if (b.built && BigInt(b.built) >= W.maxSaved) return true;
      return !b.pending;
    } catch {
      return true;
    }
  },
  frame,
  /** The rebuilt PDF is in: it shows every edit, so the drawn ones go. */
  landed() {
    for (const [, pg] of W.pages) { for (const E of pg.edits) { E.el.remove(); E.md?.remove(); } pg.shift?.remove(); }
    W.pages.clear();
    W.paras.clear();
    W.doc = null;
    W.unsure = false;
    if (W.on) loadSource(true).catch(() => {});
  },
  /** For the tests: the paragraphs read from page n. */
  async paragraphs(n) { return readPage(pageView(n)); },
};
window.__pdfWriter = writer;
