import { BASE, served, viewerUrl, TOUCH } from "./base.js";

// pdf-review auto-reload. When the open PDF changes on disk (a rebuild, a new export), the viewer
// reopens it on the same page and scroll position. It asks the server for the file's
// Last-Modified and Content-Length with a HEAD request every couple of seconds; the static server
// already sends both, so nothing changes on the server side.
// The reload is always automatic, with no prompt (the architect 2026-10-16: "the warning should never appear"):
// a save in progress is waited for, and a queued save is cancelled so it can't overwrite the new file.
// Marks save themselves over the original file (server.py /api/save): two seconds after the last
// edit, and again when the window closes, so no comment is ever lost. There is no Save button any more
// (the architect 2026-10-16: "completely useless since it is supposed to save automatically"); a small
// "✓ Saved" note confirms each write. 📂 Folder opens the file manager with the file selected
// (server.py /api/reveal), to move, rename or copy it. ↻ Redo asks the chat that opened the file to read the comments and
// redo the document (server.py /api/redo).
const app = window.PDFViewerApplication;
await app.initializedPromise;

const POLL_MS = 2000;
const st = { url: "", sig: null, pending: null, busy: false, saving: false, unsaved: false };

// Status note, not a button: shows "✓ Saved" for a moment after each automatic save.
const saveBtn = document.createElement("span");
saveBtn.id = "saveState";
saveBtn.className = "readerBtn";
saveBtn.style.cssText = "cursor:default;opacity:.85";
saveBtn.hidden = true;
document.getElementById("toolbarViewerRight").prepend(saveBtn);

const folderBtn = document.createElement("button");
folderBtn.id = "showInFolder";
folderBtn.className = "readerBtn";
folderBtn.textContent = "📂 Folder";
folderBtn.title = "Open the folder that holds this PDF, with the file selected, to move, rename or copy it";
folderBtn.hidden = true;
document.getElementById("toolbarViewerRight").prepend(folderBtn);

// ✏️ Edit text: opens the Markdown the PDF is built from; saving it rebuilds the PDF (server.py
// watch_sources) and this window reloads it. Shown only when that .md exists (2026-10-16).
const editBtn = document.createElement("button");
editBtn.id = "editSource";
editBtn.className = "readerBtn";
editBtn.textContent = "✏️ Edit text";
editBtn.title = "Open the text this PDF is built from; save it and the PDF rebuilds here by itself";
editBtn.hidden = true;
document.getElementById("toolbarViewerRight").prepend(editBtn);
// Pick mode: the next click on the page's text picks that paragraph; a popup lets the architect edit it, and
// saving rewrites that block of the .md (server.py /api/paragraph), which rebuilds the PDF.
editBtn.title = "Pick a paragraph to edit its text; the PDF rebuilds by itself";
let picking = false;

// Group a page's text-layer spans into paragraphs by line gaps, and lay one clickable box over each,
// so the space between lines belongs to the paragraph too (the architect 2026-10-16).
function paragraphBoxes(pageDiv) {
  const layer = pageDiv.querySelector(".textLayer");
  if (!layer) return;
  pageDiv.querySelectorAll(".paraPick").forEach((b) => b.remove());
  const pr = pageDiv.getBoundingClientRect();
  const spans = [...layer.querySelectorAll("span")]
    .filter((sp) => sp.textContent.trim())
    .map((sp) => ({ sp, r: sp.getBoundingClientRect() }))
    .filter((o) => o.r.width > 0 && o.r.height > 0);
  // lines: spans sharing a baseline band
  spans.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
  const lines = [];
  for (const o of spans) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(o.r.top - L.top) < Math.max(3, o.r.height * 0.45)) {
      L.items.push(o); L.left = Math.min(L.left, o.r.left); L.right = Math.max(L.right, o.r.right);
      L.bottom = Math.max(L.bottom, o.r.bottom); L.h = Math.max(L.h, o.r.height);
    } else lines.push({ items: [o], top: o.r.top, bottom: o.r.bottom, left: o.r.left, right: o.r.right, h: o.r.height });
  }
  // paragraphs: a gap clearly bigger than normal line spacing, or a change of text size, starts a new one
  const paras = [];
  for (const L of lines) {
    const P = paras[paras.length - 1];
    const gap = P ? L.top - P.bottom : Infinity;
    if (P && gap < L.h * 0.9 && Math.abs(L.h - P.h) < L.h * 0.25 && !/^[•\-–]/.test(L.items[0].sp.textContent.trim())) {
      P.lines.push(L); P.bottom = Math.max(P.bottom, L.bottom);
      P.left = Math.min(P.left, L.left); P.right = Math.max(P.right, L.right);
    } else paras.push({ lines: [L], top: L.top, bottom: L.bottom, left: L.left, right: L.right, h: L.h });
  }
  for (const P of paras) {
    const box = document.createElement("div");
    box.className = "paraPick";
    box.style.position = "absolute"; // pdf.js page styles would otherwise put it in the flow
    box.style.zIndex = "30";
    const pad = 4;
    // Offsets are from the page's padding box: subtract its (transparent) border.
    box.style.left = `${P.left - pr.left - pageDiv.clientLeft - pad}px`;
    box.style.top = `${P.top - pr.top - pageDiv.clientTop - pad}px`;
    box.style.width = `${P.right - P.left + 2 * pad}px`;
    box.style.height = `${P.bottom - P.top + 2 * pad}px`;
    box.dataset.q = P.lines.map((L) => L.items.map((o) => o.sp.textContent).join(" ")).join(" ").slice(0, 400);
    pageDiv.append(box);
  }
}
function allBoxes(on) {
  document.querySelectorAll("#viewer .page").forEach((pg) => {
    if (on) paragraphBoxes(pg);
    else pg.querySelectorAll(".paraPick").forEach((b) => b.remove());
  });
}
app.eventBus.on("textlayerrendered", ({ pageNumber }) => {
  if (!picking) return;
  const pg = document.querySelector(`#viewer .page[data-page-number="${pageNumber}"]`);
  if (pg) paragraphBoxes(pg);
});
app.eventBus.on("scalechanging", () => { if (picking) setTimeout(() => allBoxes(true), 300); });
function setPicking(on) {
  picking = on;
  editBtn.classList.toggle("on", on);
  allBoxes(on);
}
editBtn.addEventListener("click", () => setPicking(!picking));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) setPicking(false); });

// After Save: freeze the page behind a turning indicator until the rebuilt PDF is reopened (reload()
// calls rebuildDone), or 90 s pass (the architect 2026-10-16).
let rebuildTimer = null;
function rebuildFreeze() {
  const c = document.getElementById("viewerContainer");
  if (!c || document.getElementById("rebuildFreeze")) return;
  const f = document.createElement("div");
  f.id = "rebuildFreeze";
  f.className = "rbFreeze";
  f.innerHTML = `<div class="rbCard"><span class="rbSpin"></span>Rebuilding the PDF…</div>`;
  document.body.append(f);
  rebuildTimer = setTimeout(rebuildDone, 90000);
}
function rebuildDone() {
  clearTimeout(rebuildTimer);
  document.getElementById("rebuildFreeze")?.remove();
}

function editPopup(block, path) {
  const wrap = document.createElement("div");
  wrap.className = "epWrap";
  wrap.innerHTML = `<div class="epBox"><div class="epTitle">Edit paragraph</div>
    <textarea rows="1" class="epText"></textarea>
    <div class="epRow"><span class="msg epMsg">Markdown: **bold**, *italic*, [text](link)</span>
      <button class="cancel epBtn">Cancel</button><button class="save epBtn primary">Save</button></div></div>`;
  const ta = wrap.querySelector("textarea");
  ta.value = block.text;
  // Fit the box to the text on open and while typing (up to 70% of the screen, then it scrolls).
  const fit = () => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  const close = () => wrap.remove();
  wrap.querySelector(".cancel").onclick = close;
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); e.stopPropagation(); });
  wrap.querySelector(".save").onclick = async () => {
    const msg = wrap.querySelector(".msg");
    if (ta.value === block.text) return close();
    msg.textContent = "Saving…";
    try {
      const r = await fetch(BASE + `/api/paragraph?path=${encodeURIComponent(path)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: block.index, old: block.text, new: ta.value }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      close();
      rebuildFreeze(); // frozen until the rebuilt PDF is reopened
    } catch (err) {
      console.error("[edit] saving the paragraph failed", err);
      msg.textContent = "⚠ " + (err.message || err);
    }
  };
  document.body.append(wrap);
  ta.focus();
}

document.addEventListener("click", async (e) => {
  if (!picking || !st.url) return;
  const box = e.target.closest?.(".paraPick");
  if (!box) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const q = box.dataset.q || "";
  setPicking(false);
  const path = decodeURIComponent(served(st.url));
  try {
    const r = await fetch(BASE + `/api/paragraph?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`);
    const block = await r.json();
    if (!r.ok) throw new Error(block.error || `HTTP ${r.status}`);
    editPopup(block, path);
  } catch (err) {
    console.error("[edit] finding the paragraph failed", err);
    editBtn.textContent = "⚠ " + (err.message || "not found");
    setTimeout(() => { editBtn.textContent = "✏️ Edit text"; }, 2500);
  }
}, true);
async function showEdit() {
  editBtn.hidden = true;
  if (!st.url) return;
  try {
    const where = served(st.url);
    const r = await fetch(BASE + `/api/source?path=${encodeURIComponent(decodeURIComponent(where))}`);
    editBtn.hidden = !(r.ok && (await r.json()).has);
  } catch {
    editBtn.hidden = true;
  }
}

// pdf.js's own Save buttons are hidden: saving is automatic.
for (const id of ["downloadButton", "secondaryDownload"]) {
  const b = document.getElementById(id);
  if (b) b.hidden = true, b.style.display = "none";
}

const redoBtn = document.createElement("button");
redoBtn.id = "redoDocument";
redoBtn.className = "readerBtn";
redoBtn.textContent = "✎ Apply comments";
redoBtn.title = "Save, then have the chat that made this PDF apply your comments to this same file (the PDF only, nothing else)";
redoBtn.hidden = true;
document.getElementById("toolbarViewerRight").prepend(redoBtn);

// Only files served by this server can be watched (not a PDF opened with the Open button or dropped).
const watchable = (url) => {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin;
  } catch {
    return false;
  }
};

async function signature(url) {
  const r = await fetch(url, { method: "HEAD", cache: "no-store" });
  if (!r.ok) return null;
  return `${r.headers.get("Last-Modified")}|${r.headers.get("Content-Length")}`;
}

// The old "unsaved marks" bar is gone (2026-10-16); this only clears one left on the page.
function bar() {
  document.getElementById("autoreloadBar")?.remove();
}

async function reload() {
  if (st.busy) return;
  st.busy = true;
  // Never ask. A save already running is allowed to finish (up to 10 s) so the reopen does not race
  // the write; a save still queued is cancelled, because it would write the old document over the
  // new file. Marks typed in the last two seconds before a rebuild are the only thing that can be lost.
  for (let i = 0; i < 50 && st.saving; i++) await new Promise((r) => setTimeout(r, 200));
  clearTimeout(saveTimer);
  st.unsaved = false;
  bar(false);
  const viewer = app.pdfViewer;
  const container = viewer.container;
  const keep = {
    page: viewer.currentPageNumber,
    scale: viewer.currentScaleValue,
    top: container.scrollTop,
    left: container.scrollLeft,
  };
  try {
    const r = await fetch(st.url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = new Uint8Array(await r.arrayBuffer());
    const restore = () => {
      viewer.currentScaleValue = keep.scale;
      viewer.currentPageNumber = Math.min(keep.page, viewer.pagesCount);
      container.scrollTop = keep.top;
      container.scrollLeft = keep.left;
    };
    app.eventBus.on("pagesloaded", restore, { once: true });
    await app.open({ url: st.url, data });
    console.info("[autoreload] reopened", st.url);
    applyDone(); // the AI's rebuild arrived: the thinking indicator ends
    rebuildDone(); // a text edit's rebuild arrived: unfreeze
  } catch (err) {
    console.error("[autoreload] reopening the changed file failed", err);
  } finally {
    st.busy = false;
  }
}

async function tick() {
  if (!st.url || document.hidden) return;
  // A reload in progress must not start a second one. A save must not: the file can change on
  // disk while it runs, and reload() then shows the bar instead of reopening over a write.
  // Nor while our own save runs (it read its own write as a rebuild), nor while a comment box is open:
  // the reload destroys the highlight the box belongs to and Add then fails with "setting 'comment'
  // of null" (the architect 2026-10-23 11:31, "I press add and it does nothing").
  if (st.busy || st.saving) return;
  if (document.getElementById("commentManagerDialog")?.open) return;
  let sig;
  try {
    sig = await signature(st.url);
  } catch (err) {
    return console.error("[autoreload] checking the file failed", err);
  }
  if (!sig || sig === st.sig) {
    st.pending = null;
    return;
  }
  // A file still being written changes size between checks: wait for two equal readings.
  if (sig !== st.pending) {
    st.pending = sig;
    return;
  }
  st.sig = sig;
  st.pending = null;
  await reload();
}

async function onDocument() {
  const url = app.url;
  folderBtn.hidden = TOUCH || !watchable(url);
  if (!watchable(url)) {
    st.url = "";
    return;
  }
  if (url !== st.url) st.sig = null;
  st.url = url;
  // Top of the 🕘 Recent list, and what the phone's 📄 button reopens.
  fetch(BASE + `/api/opened?path=${encodeURIComponent(decodeURIComponent(served(url)))}`, { method: "POST" })
    .catch((err) => console.error("[autoreload] recording the open file failed", err));
  try {
    st.sig ??= await signature(url);
  } catch (err) {
    console.error("[autoreload] reading the file's date failed", err);
  }
  showRedo();
  showEdit();
}
app.eventBus.on("documentloaded", onDocument);
if (app.pdfDocument) onDocument();

// ---- save over the original ------------------------------------------------------------------

// Edited since the last save. (annotationStorage.size counts every mark in the file, saved or not,
// which made the reload bar appear after any review: fixed 2026-10-16.)
const dirty = () => st.unsaved;

// force: an explicit Ctrl+S writes even when the auto-save already did.
async function saveOriginal(force = false) {
  if (!st.url || st.busy || st.saving || (!force && !dirty())) return;
  st.saving = true;
  // Never write over a newer file. The phone autosaved the copy it had open 8 s after a rebuild and
  // put the old text back (2026-10-23 11:54, the architect: "I still see instructions and rules in different
  // bullets"). If the file changed on disk since we loaded it, reload it instead of saving.
  const onDisk = await signature(st.url).catch(() => null);
  if (st.sig && onDisk && onDisk !== st.sig && document.getElementById("commentManagerDialog")?.open) {
    // A rebuild landed while he is typing: reloading now would destroy the box and the text. Keep both;
    // the text is on the device (draft below) and comes back after the reload that Done triggers.
    window.__clientLog?.("save-held-newer-file-box-open", { loaded: st.sig, onDisk });
    st.saving = false;
    saveBtn.hidden = false;
    saveBtn.textContent = "⚠ File was rebuilt: your comment is kept on this device";
    return;
  }
  if (st.sig && onDisk && onDisk !== st.sig) {
    window.__clientLog?.("save-refused-newer-file", { loaded: st.sig, onDisk });
    st.saving = false;
    st.sig = onDisk;
    saveBtn.hidden = false;
    saveBtn.textContent = "↻ Updated version loaded";
    reload();
    return;
  }
  saveBtn.hidden = false;
  saveBtn.textContent = "Saving…";
  const draftAtStart = readDraft();
  try {
    const data = await app.pdfDocument.saveDocument();
    const where = served(st.url);
    const r = await fetch(BASE + `/api/save?path=${encodeURIComponent(decodeURIComponent(where))}`, {
      method: "PUT",
      body: data,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    app.pdfDocument.annotationStorage.resetModified();
    st.unsaved = false;
    draftSaved(draftAtStart);
    st.sig = await signature(st.url); // our own write: not a change to reload
    st.pending = null;
    bar(false);
    saveBtn.textContent = "✓ Saved";
  } catch (err) {
    console.error("[save] writing the original file failed", err);
    saveBtn.textContent = "⚠ Not saved";
    saveBtn.title = String(err.message || err);
  } finally {
    st.saving = false;
    setTimeout(() => {
      if (saveBtn.textContent !== "⚠ Not saved") saveBtn.hidden = true;
    }, 2500);
  }
}

// 📂 Folder: ask the server to open the file manager on the real file, selected.
folderBtn.addEventListener("click", async () => {
  if (!st.url) return;
  const where = served(st.url);
  try {
    const r = await fetch(BASE + `/api/reveal?path=${encodeURIComponent(decodeURIComponent(where))}`, { method: "POST" });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  } catch (err) {
    console.error("[reveal] opening the folder failed", err);
    folderBtn.textContent = "⚠ No folder";
    folderBtn.title = String(err.message || err);
    setTimeout(() => { folderBtn.textContent = "📂 Folder"; }, 2500);
  }
});

// Auto-save. The storage only grows when an editor commits, so a comment still being typed is not
// written half-done: the timer restarts on every change and fires once the editing pauses.
let saveTimer = null;
function scheduleSave() {
  if (!st.url || !dirty()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveOriginal(), 2000);
}
// The storage calls onSetModified exactly when an edit commits, which is the moment to save.
const watchStorage = () => {
  const storage = app.pdfDocument?.annotationStorage;
  if (!storage || storage._pdfReviewWatched) return;
  storage._pdfReviewWatched = true;
  const prev = storage.onSetModified;
  storage.onSetModified = () => {
    prev?.();
    st.unsaved = true;
    scheduleSave();
  };
};
// Add in the comment box stores the text on the editor without marking the storage modified, so the
// autosave above never fired and the comment stayed in the page only (2026-10-23). Save after Add.
document.addEventListener("click", (e) => {
  if (e.target.closest?.("#commentManagerSaveButton")) setTimeout(() => saveOriginal(true), 500);
}, true);
// Comments save as they are typed (the architect 2026-10-23 18:30: "I was in the middle of writing a long and
// complicated comment and then an update hit and I lost it all"; the Jarvis app restarted at 18:27:48
// with the box open). viewer.mjs puts every keystroke on the highlight and fires pdfreview:comment-typed;
// here each keystroke is copied to this device at once, and the file is saved a second after typing
// pauses. A copy that never reached the file is offered back, with Copy, the next time the file opens.
const draftKey = () => "pdfreview.draft:" + decodeURIComponent(st.url || app.url || "");
function readDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch { return null; }
}
function draftSaved(d) {
  const now = readDraft();
  if (!d || !now || now.text !== d.text) return; // typed on since this save started: still pending
  if (document.getElementById("commentManagerDialog")?.open) localStorage.setItem(draftKey(), JSON.stringify({ ...now, saved: true }));
  else localStorage.removeItem(draftKey());
}
let typedTimer = null;
window.addEventListener("pdfreview:comment-typed", (e) => {
  try { localStorage.setItem(draftKey(), JSON.stringify({ text: e.detail.text, at: Date.now(), saved: false })); } catch {}
  clearTimeout(typedTimer);
  typedTimer = setTimeout(() => saveOriginal(true), 1000);
});
function offerDraft() {
  const d = readDraft();
  if (!d || d.saved || !d.text?.trim() || document.getElementById("draftRescue")) return;
  window.__clientLog?.("draft-offered", { chars: d.text.length, at: d.at });
  const box = document.createElement("div");
  box.id = "draftRescue";
  box.style.cssText = "position:fixed;left:8px;right:8px;bottom:56px;z-index:100000;background:#fff8e8;border:2px solid #7A3921;border-radius:8px;padding:8px;font:14px sans-serif;color:#3b2a1a;box-shadow:0 4px 16px #0004";
  const when = new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  box.innerHTML = `<div style="font-weight:bold;margin-bottom:4px">Comment not saved (${when}), kept on this device</div>`;
  const ta = document.createElement("textarea");
  ta.readOnly = true;
  ta.value = d.text;
  ta.style.cssText = "width:100%;box-sizing:border-box;height:90px;font:14px sans-serif";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:6px";
  const copy = Object.assign(document.createElement("button"), { className: "readerBtn", textContent: "Copy" });
  const drop = Object.assign(document.createElement("button"), { className: "readerBtn", textContent: "Dismiss" });
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(d.text); copy.textContent = "✓ Copied"; }
    catch { ta.select(); document.execCommand?.("copy"); copy.textContent = "✓ Copied"; }
  };
  drop.onclick = () => { localStorage.removeItem(draftKey()); box.remove(); };
  row.append(copy, drop);
  box.append(ta, row);
  document.body.append(box);
}
app.eventBus.on("pagesloaded", () => setTimeout(offerDraft, 500));
document.getElementById("commentManagerDialog")?.addEventListener("close", () => {
  clearTimeout(typedTimer);
  setTimeout(() => saveOriginal(true), 300);
});
app.eventBus.on("documentloaded", watchStorage);
watchStorage();
window.addEventListener("beforeunload", () => {
  if (st.url && dirty()) saveOriginal();
});

// ↻ Redo: save first, then ask the server to wake the chat recorded for this file.
// While the AI works: the button turns into a thinking indicator (animated dots) and stays disabled
// until the rebuilt file arrives and the viewer reopens it (reload() calls applyDone), or 30 min pass.
const REDO_LABEL = "✎ Apply comments";
const REDO_TITLE = "Save, then have the chat that made this PDF apply your comments to this same file (the PDF only, nothing else)";
let applyAnim = null, applyGiveUp = null;
function applyDone() {
  if (!applyAnim) return;
  clearInterval(applyAnim); clearTimeout(applyGiveUp);
  applyAnim = applyGiveUp = null;
  redoBtn.disabled = false;
  redoBtn.textContent = REDO_LABEL;
  redoBtn.title = REDO_TITLE;
}
function applyThinking() {
  let n = 0;
  redoBtn.disabled = true;
  redoBtn.title = "The AI is applying your comments; the PDF reloads by itself when it is done";
  const draw = () => { redoBtn.textContent = "🤖 Applying comments" + ".".repeat((n++ % 3) + 1); };
  draw();
  applyAnim = setInterval(draw, 500);
  applyGiveUp = setTimeout(applyDone, 30 * 60 * 1000);
}

async function redo() {
  // Log every press (2026-10-23: a 10:30 press left no /api/redo line and no error).
  const log = (e, d) => window.__clientLog?.(e, d);
  log("redo-press", { url: !!st.url, locked: !!applyAnim });
  if (!st.url || applyAnim) return;
  clearTimeout(saveTimer);
  // A comment still open in its text box is not in the document until it loses focus, and a save
  // already running makes saveOriginal() return at once: both let the wake go out ahead of the
  // marks (2026-10-23 11:05, a written comment lost). Commit the box, wait the running save out.
  document.activeElement?.blur?.();
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 50 && st.saving; i++) await new Promise((r) => setTimeout(r, 200));
  try { await saveOriginal(true); } catch (err) { log("redo-save-failed", { err: String(err) }); throw err; }
  redoBtn.disabled = true;
  redoBtn.textContent = "Waking…";
  try {
    const where = served(st.url);
    const r = await fetch(BASE + `/api/redo?path=${encodeURIComponent(decodeURIComponent(where))}`, { method: "POST" });
    const body = await r.json().catch(() => ({}));
    log("redo-answer", { status: r.status, body });
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    applyThinking();
  } catch (err) {
    console.error("[redo] waking the chat failed", err);
    redoBtn.disabled = false;
    redoBtn.textContent = "⚠ Not woken";
    redoBtn.title = String(err.message || err);
    setTimeout(() => { redoBtn.textContent = REDO_LABEL; redoBtn.title = REDO_TITLE; }, 3000);
  }
}
redoBtn.addEventListener("click", redo);

// The button only shows for a file a chat registered (server.py /api/origin). Checked on load.
async function showRedo() {
  if (!st.url) return;
  try {
    const where = served(st.url);
    const r = await fetch(BASE + `/api/origin?path=${encodeURIComponent(decodeURIComponent(where))}`);
    redoBtn.hidden = !r.ok;
  } catch {
    redoBtn.hidden = true;
  }
}

// pdf.js's own Save buttons and Ctrl+S go through the browser download (a "save as" dialog).
// For a served file they write over the original too; a PDF opened locally keeps the download.
const stockSave = ["downloadButton", "secondaryDownload"];
document.addEventListener(
  "click",
  (e) => {
    if (!st.url || !stockSave.includes(e.target.closest("button")?.id)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    saveOriginal(true);
  },
  true,
);
window.addEventListener(
  "keydown",
  (e) => {
    if (!st.url || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    saveOriginal(true);
  },
  true,
);

// Someone asked for the marks that have not been saved yet (server.py /api/marks/pull). Answer with
// what the annotation storage holds right now: page, kind, the text under a highlight, the note.
// Nothing is written to the file, so this never throws away an unsaved mark.
async function answerMarks() {
  const doc = app.pdfDocument;
  if (!st.url || !doc) return;
  let want;
  try {
    const r = await fetch(BASE + `/api/marks/want?path=${encodeURIComponent(served(st.url))}`);
    if (!r.ok) return;
    want = await r.json();
  } catch {
    return;
  }
  if (!want.want || want.have) return;
  // Read once: the getter serializes every editor and hashes the result. An edited comment lands in
  // popup.contents (addComment), a free-text note in contents. A comment typed but not yet committed
  // is not here, so the count is reported separately and a caller can tell the two apart.
  const serial = doc.annotationStorage.serializable;
  const marks = [];
  for (const val of serial.map?.values() ?? []) {
    const note = (val.popup?.contents ?? val.contents ?? "").toString().trim();
    if (!note || val.popup?.deleted) continue;
    marks.push({ page: (val.pageIndex ?? 0) + 1, kind: val.annotationType ?? null, note });
  }
  await fetch(BASE + `/api/marks?path=${encodeURIComponent(served(st.url))}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pending: doc.annotationStorage.size, marks }),
  }).catch((err) => console.error("[marks] handing over the unsaved marks failed", err));
}

setInterval(() => { tick(); answerMarks(); }, POLL_MS);
document.addEventListener("visibilitychange", tick);

// ---- free selection after a highlight or comment ---------------------------------------------
// Highlighting or commenting a text selection makes pdf.js switch to the Highlight tool, which leaves
// that toolbar button pressed, so the next drag paints instead of just selecting. When the switch was
// automatic (the button was not clicked just before), go back to "no tool" once the comment box is
// closed (the architect 2026-10-16: "make it so it does not press automatically").
const HIGHLIGHT_MODE = 9; // AnnotationEditorType.HIGHLIGHT
let highlightClickedAt = 0;
let autoHighlightAt = 0;
document.addEventListener(
  "pointerdown",
  (e) => {
    if (e.target.closest?.("#editorHighlightButton")) highlightClickedAt = Date.now();
  },
  true,
);
app.eventBus.on("annotationeditormodechanged", ({ mode }) => {
  if (mode === HIGHLIGHT_MODE && Date.now() - highlightClickedAt > 1500) autoHighlightAt = Date.now();
  else if (mode !== HIGHLIGHT_MODE) autoHighlightAt = 0;
});
setInterval(() => {
  if (!autoHighlightAt || Date.now() - autoHighlightAt < 1000) return; // give the comment box time to open
  if (document.getElementById("commentManagerDialog")?.open) return; // still writing the comment
  autoHighlightAt = 0;
  app.eventBus.dispatch("switchannotationeditormode", { source: app, mode: 0 });
}, 300);

// ---- tiny highlights get a bigger click target ---------------------------------------------------
// A highlight over one or two letters was a few pixels wide, so its comment could not be reopened
// (the architect 2026-10-16). Tag small ones; reader.css gives a .tiny highlight a 32x24 px hit area.
function tagTinyHighlights() {
  for (const el of document.querySelectorAll(".highlightEditor, .annotationLayer .highlightAnnotation")) {
    const r = el.getBoundingClientRect();
    const tiny = r.width > 0 && (r.width < 32 || r.height < 14);
    el.classList.toggle("tiny", tiny);
    // a saved highlight is clipped to its own shape, which would clip the bigger target too;
    // a tiny one is a single short rectangle, so lifting the clip changes nothing visible
    if (tiny && el.classList.contains("highlightAnnotation")) el.style.clipPath = "none";
  }
}
let tinyQueued = false;
new MutationObserver(() => {
  if (tinyQueued) return;
  tinyQueued = true;
  requestAnimationFrame(() => { tinyQueued = false; tagTinyHighlights(); });
}).observe(document.getElementById("viewerContainer") || document.body, { childList: true, subtree: true });

// ---- a highlight made in this session opens its comment on click -----------------------------------
// When the Highlight tool switches off, pdf.js leaves the new highlights inactive and the text layer
// takes the click, so a comment just written could not be reopened until the page was refreshed
// (the architect 2026-10-16: "when I refresh the page the comments seem to disappear"). The comment's 💬 button
// still works, so a click on the highlight (or its tiny-mark target) presses that button: the one
// pdf.js puts at the highlight's top-right corner on the same page.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0 || e.target.closest?.("button, dialog, .editToolbar, #toolbarContainer")) return;
    for (const ed of document.querySelectorAll(".highlightEditor.disabled")) {
      const r = ed.getBoundingClientRect();
      const padX = ed.classList.contains("tiny") ? Math.max(0, (32 - r.width) / 2) : 0;
      const padY = ed.classList.contains("tiny") ? Math.max(0, (24 - r.height) / 2) : 0;
      if (e.clientX < r.left - padX || e.clientX > r.right + padX || e.clientY < r.top - padY || e.clientY > r.bottom + padY) continue;
      const page = ed.closest(".page");
      let best = null, bestD = 48;
      for (const b of page?.querySelectorAll(".annotationCommentButton") || []) {
        const br = b.getBoundingClientRect();
        const d = Math.hypot(br.left - r.right, br.bottom - r.top);
        if (d < bestD) { best = b; bestD = d; }
      }
      if (!best) return; // a highlight with no comment: leave the click to the page
      e.preventDefault();
      e.stopPropagation();
      best.click();
      return;
    }
  },
  true,
);

// ---- 🕘 Recent: every PDF opened with this viewer that still exists, newest first (2026-10-21) ----
const recentBtn = document.createElement("button");
recentBtn.id = "recentFiles";
recentBtn.className = "readerBtn";
recentBtn.textContent = "🕘 Recent";
recentBtn.title = "The PDFs opened with this viewer, most recent first";
document.getElementById("toolbarViewerRight").prepend(recentBtn);

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function showRecent() {
  document.getElementById("recentDialog")?.remove();
  const dlg = document.createElement("dialog");
  dlg.id = "recentDialog";
  dlg.innerHTML = `<div class="recentHead"><b>Recent PDFs</b><button type="button" class="recentClose" aria-label="Close">✕</button></div>` +
    `<div class="recentList">Loading…</div>`;
  document.body.append(dlg);
  dlg.querySelector(".recentClose").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  const list = dlg.querySelector(".recentList");
  try {
    const r = await fetch(BASE + "/api/history", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { files } = await r.json();
    const open = st.url ? decodeURIComponent(served(st.url)) : "";
    list.innerHTML = files.length
      ? files.map((f) => `<a class="recentRow${f.path === open ? " current" : ""}" href="${escHtml(viewerUrl(f.path))}">` +
          `<span class="recentName">${escHtml(f.name)}</span>` +
          `<span class="recentMeta">${escHtml(ago(f.at))} · ${escHtml(f.dir)}</span></a>`).join("")
      : "No PDF opened yet.";
    list.querySelectorAll(".recentRow").forEach((row, i) => holdForMenu(row, files[i], dlg));
  } catch (err) {
    console.error("[recent] the list failed", err);
    list.textContent = `The list could not be loaded: ${err.message}`;
  }
}

// 2026-10-27 (the architect: "There is currently no way to delete current files. On long press the option should pop up"):
// hold a row (right-click on a desktop) for its menu: take it off this list, or move the PDF to the trash, where a
// file manager can put it back. The trash asks for a second tap inside the menu (the phone app's WebView may not
// show a confirm() box). After a hold, the tap that ends it does not open the file.
const HOLD_MS = 550;

function holdForMenu(row, f, dlg) {
  let timer = 0, x = 0, y = 0, held = false;
  const clear = () => { clearTimeout(timer); timer = 0; };
  row.addEventListener("pointerdown", (e) => {
    held = false; x = e.clientX; y = e.clientY;
    timer = setTimeout(() => { held = true; rowMenu(row, f, dlg); }, HOLD_MS);
  });
  row.addEventListener("pointermove", (e) => { if (Math.abs(e.clientX - x) + Math.abs(e.clientY - y) > 12) clear(); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) row.addEventListener(ev, clear);
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); clear(); if (!held) { held = true; rowMenu(row, f, dlg); } });
  row.addEventListener("click", (e) => { if (held) { e.preventDefault(); held = false; } });
}

function rowMenu(row, f, dlg) {
  dlg.querySelector(".rowMenu")?.remove();
  const m = document.createElement("div");
  m.className = "rowMenu";
  m.innerHTML = `<button type="button" data-a="hide">Remove from this list</button>` +
    `<button type="button" data-a="trash" class="danger">Delete the PDF (to the trash)</button>` +
    `<button type="button" data-a="cancel">Cancel</button><div class="rowMenuNote"></div>`;
  row.after(m);
  m.scrollIntoView({ block: "nearest" });
  const note = m.querySelector(".rowMenuNote");
  let armed = false;
  m.addEventListener("click", async (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (!a) return;
    if (a === "cancel") return m.remove();
    if (a === "trash" && !armed) {
      armed = true;
      e.target.textContent = `Tap again to delete ${f.name}`;
      setTimeout(() => { armed = false; e.target.textContent = "Delete the PDF (to the trash)"; }, 4000);
      return;
    }
    m.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const r = await fetch(`${BASE}/api/${a}?path=${encodeURIComponent(f.path)}`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      showRecent();
    } catch (err) {
      console.error(`[recent] ${a} failed for ${f.path}`, err);
      note.textContent = `That did not work: ${err.message}`;
      m.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  });
}
recentBtn.addEventListener("click", showRecent);
if (new URLSearchParams(location.search).has("recent")) showRecent();

