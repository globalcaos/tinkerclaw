import { BASE, served, viewerUrl, TOUCH } from "./base.js";
import { OFFLINE, fresh, keptMeta, keepCopy, keepPending, hasPending, flush, localParagraph, queueParagraph, queueRedo, waiting, isKept, state as net } from "./offline.js";
// The 2026-11-11 additions (fetchChanged, putSave, serverSeen) are read from the namespace and may be
// missing: on a slow link this file can arrive new while the kept offline.js is still the older one, and a
// named import of something that file lacks would stop this whole module, saving included.
import * as off from "./offline.js";
import { writer } from "./writer.js";
// The journal (journal.js, 2026-11-15): every mark is written on this device first and stays there until the Pi
// holds it. Loaded so that its absence costs only itself (a slow link can bring this file before journal.js).
const J = await import("./journal.js").catch((err) => { console.error("[journal] not loaded; marks are saved as before", err); return null; });
// ✓ Approve (approve.js, 2026-11-15): the button at the end of each blue paragraph. Loaded the same way, and not
// waited for: without it the page works as before, with no buttons. A swap waits while he approves (ready()).
let approver = null;
import("./approve.js").then((m) => { approver = m.approver; }, (err) => console.error("[approve] not loaded; no Approve buttons", err));
const approvalsQuiet = () => !approver || approver.ready();

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
// 2026-11-11: POLL_MS is now the rhythm only while a change is being taken in (`chase`) and for an older
// server. At rest one request waits at the server instead: see "waiting for news" near the end.
// 20 s: the phone's door gives a request 30 s to start answering (door.mjs FIRST_BYTE_TIMEOUT_MS).
const WATCH_WAIT = 20; // seconds one /api/watch request waits
let chase = false;     // the server said the file changed and tick() has not settled it yet
const st = { url: "", sig: null, pending: null, busy: false, saving: false, unsaved: false, edits: 0 };

// Status note, not a button: shows "✓ Saved" for a moment after each automatic save.
const saveBtn = document.createElement("span");
saveBtn.id = "saveState";
saveBtn.className = "toolbarButton readerBtn";
saveBtn.style.cssText = "cursor:default;opacity:.85";
saveBtn.hidden = true;
document.getElementById("toolbarViewerRight").prepend(saveBtn);

const folderBtn = document.createElement("button");
folderBtn.id = "showInFolder";
folderBtn.className = "toolbarButton readerBtn";
folderBtn.textContent = "📂 Folder";
folderBtn.title = "Open the folder that holds this PDF, with the file selected, to move, rename or copy it";
folderBtn.hidden = true;
document.getElementById("toolbarViewerRight").prepend(folderBtn);

// ---- the journal: every mark stays on this device until the Pi holds it (journal.js, 2026-11-15) -------------
// A save is: write the marks to the journal (IndexedDB), send them, and drop them from the journal only when the Pi
// answers with a version that holds them. Anything else (no network, a refusal, a server restarting, a page that
// dies or reloads) leaves them in the journal; the page keeps showing them, and they are sent again on the next
// chance (every 10 s while some wait, when the Pi answers again, on the next open of the file). The Pi carries
// them onto a file that moved on meanwhile (server.py X-Made-Length), so a rebuild never refuses them again.
const D = {
  doc: null, docId: "", path: "", baseSig: null, own: null, B: null,
  since: new Uint8Array(0), seq: 0, chain: Promise.resolve(), mem: null, edits0: 0, kept: false,
};
let adopting = null; // a journal record this page is reopened on, to show its marks while the Pi cannot take them
let pumping = null, pumpTimer = 0, journalTimer = 0, journalCount = 0, caps = null, capsAsked = 0;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function newDoc() {
  const doc = app.pdfDocument;
  if (!doc || D.doc === doc) return;
  const a = adopting;
  adopting = null;
  const path = decodeURIComponent(served(st.url));
  D.chain = Promise.resolve();
  D.edits0 = st.edits;
  D.kept = false;
  if (a && a.path === path) {
    // A page of its own (another tab may still be writing the record it shows): the record is dropped once this
    // page's first snapshot, which holds its marks, is written.
    Object.assign(D, { doc, path, docId: newId(), baseSig: a.baseSig, own: a.own, B: a.B, since: a.since || new Uint8Array(0), seq: a.seq, mem: null, supersedes: a.id });
    st.sig = a.own || a.baseSig;
  } else Object.assign(D, { doc, path, docId: newId(), baseSig: null, own: null, B: null, since: new Uint8Array(0), seq: 0, mem: null, supersedes: null });
}

/** Write what the page holds now to the journal: {bytes, rec}, or null (no document). */
async function snapshot() {
  const doc = app.pdfDocument;
  if (!doc || doc !== D.doc || !st.url) return null;
  const seq = ++D.seq;
  const bytes = await doc.saveDocument();
  if (doc !== D.doc) return null;
  D.B ??= await doc.getData();
  D.baseSig ??= st.sig || (await signature(st.url).catch(() => null));
  const pre = !!J && J.isPrefix(D.B, bytes);
  const rec = {
    id: `${D.path}|${D.docId}`, path: D.path, docId: D.docId, baseSig: D.baseSig, own: D.own,
    len0: pre ? D.B.length : 0, seq, at: Date.now(), tail: pre ? bytes.slice(D.B.length) : bytes, since: D.since,
  };
  D.mem = rec;
  if (J) {
    try {
      // The base goes with every record; put() writes it only when the journal does not hold it. A flag that said
      // "stored" outlived the base the page's first confirmed send removed: every later record of the page was
      // written without it, and the one a page died with could never be sent (ch09, 2026-11-18).
      await J.put(rec, pre ? D.B : null);
      if (D.supersedes) { await J.remove(D.supersedes); D.supersedes = null; } // its marks are in this record now
    } catch (err) {
      console.error("[journal] writing the marks to this device failed", err);
      window.__clientLog?.("journal-failed", { err: String(err) });
    }
  }
  journalState();
  return { bytes, rec };
}
const snap = () => (D.chain = D.chain.then(snapshot, snapshot));
function journalSoon() {
  clearTimeout(journalTimer);
  journalTimer = setTimeout(snap, 250);
}

async function records(path = D.path) {
  if (path === "*") { // every file's (a page that died on another chapter left its marks here too)
    if (!J) return D.mem ? [D.mem] : [];
    try { return await J.records(); } catch { return D.mem ? [D.mem] : []; }
  }
  if (!path) return [];
  if (!J) return D.mem && D.mem.path === path ? [D.mem] : [];
  try { return await J.records(path); } catch { return D.mem && D.mem.path === path ? [D.mem] : []; }
}
async function waitingHere() {
  if (!st.url) return false;
  journalCount = (await records(decodeURIComponent(served(st.url)))).length;
  return journalCount > 0;
}

// A server older than this viewer (the files are served from disk at once, the server restarts later) has no
// /api/caps: then only what it understands is sent, and it is asked again a minute later.
async function serverCaps() {
  if (caps) return caps;
  if (Date.now() - capsAsked < 60000) return [];
  capsAsked = Date.now();
  try {
    const r = await fetch(BASE + "/api/caps", { cache: "no-store" });
    if (r.ok) caps = (await r.json()).save || [];
  } catch {}
  if (!caps) return [];
  return caps;
}

/** Send one record. Answers {ok, carried, sig} or {kept: why}; throws TypeError with no connection. */
async function send(rec, bytes) {
  const can = await serverCaps();
  const base = rec.own || rec.baseSig || "";
  const url = BASE + `/api/save?path=${encodeURIComponent(rec.path)}${base ? `&base=${encodeURIComponent(base)}` : ""}`;
  let r = null;
  // Only what pdf.js appended travels when the Pi still has the file it was appended to (2026-11-11).
  if (rec.len0 && base && bytes.length > rec.len0) {
    const d = await import("./delta.js").catch(() => null);
    if (d) {
      r = await fetch(`${url}&keep=${rec.len0}&len=${bytes.length}&crc=${d.crc32(bytes).toString(16)}`, { method: "PUT", body: bytes.subarray(rec.len0) });
      if (r.ok) window.__clientLog?.("save-part", { sent: bytes.length - rec.len0, of: bytes.length });
      else if ([400, 409, 422].includes(r.status)) { window.__clientLog?.("save-part-refused", { status: r.status }); r = null; }
    }
  }
  if (!r) {
    // The whole marked file. It names where the version it was made on ends, and what the Pi last confirmed from
    // this page: when the file there moved on, the Pi carries the new marks onto it instead of refusing them.
    const since = can.includes("since") ? rec.since || new Uint8Array(0) : new Uint8Array(0);
    const headers = rec.len0 && can.includes("made") ? { "X-Made-Length": String(rec.len0), "X-Since-Length": String(since.length) } : {};
    let body = bytes;
    if (since.length && headers["X-Made-Length"]) {
      body = new Uint8Array(bytes.length + since.length);
      body.set(bytes, 0);
      body.set(since, bytes.length);
    }
    r = await fetch(url, { method: "PUT", body, headers });
  }
  const answer = await r.json().catch(() => ({}));
  if (!r.ok) return { kept: answer.error || `HTTP ${r.status}`, status: r.status };
  return { ok: true, carried: !!answer.carried, sig: answer.sig || null };
}

// A record whose base the journal lost (written by a viewer before 2026-11-18, see snapshot): the base is rebuilt
// from the file this page has open. pdf.js appends its marks to the file it loaded, so every later version of the
// same file starts with that one, unless the file was rebuilt since. Checked, not assumed: that start must end the
// way a PDF ends, and the marks' cross-reference section must point back (/Prev) at the one it ends with.
const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);
async function baseFromOpen(rec) {
  const have = await app.pdfDocument?.getData().catch(() => null);
  if (!have || have.length < rec.len0) return null;
  const B = have.subarray(0, rec.len0);
  const end = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(latin1(B.subarray(Math.max(0, B.length - 64))));
  const prev = [...latin1(rec.tail).matchAll(/\/Prev\s+(\d+)/g)].pop();
  const ok = !!end && !!prev && end[1] === prev[1];
  window.__clientLog?.("journal-base-rebuilt", { seq: rec.seq, len0: rec.len0, ok });
  return ok ? B.slice() : null;
}

// A record with no base that the open file cannot give back either (rebuilt since) can never be sent whole. Its
// marks go to the Pi as they are: the crc is never a number, so the Pi can only refuse the part, and it keeps every
// part it refuses under state/refused/ (pdf-refused.py). Answers whether the Pi kept them.
async function keepOnPi(rec) {
  const base = rec.own || rec.baseSig || "";
  const url = BASE + `/api/save?path=${encodeURIComponent(rec.path)}&base=${encodeURIComponent(base)}&keep=${rec.len0}&len=${rec.len0 + rec.tail.length}&crc=none`;
  try {
    const r = await fetch(url, { method: "PUT", body: rec.tail });
    const answer = await r.json().catch(() => ({}));
    window.__clientLog?.("journal-kept-on-pi", { seq: rec.seq, len0: rec.len0, bytes: rec.tail.length, status: r.status, kept: !!answer.kept });
    return !r.ok && answer.kept === true;
  } catch {
    return false; // no connection: tried again on the next pump
  }
}

/** Send every record of the open file, oldest first. Answers {sent, kept, carried, offline}. */
async function pump() {
  if (pumping) return pumping;
  pumping = (async () => {
    const out = { sent: 0, kept: 0, carried: false, offline: false, others: 0, lost: 0, why: "" };
    const path = st.url ? decodeURIComponent(served(st.url)) : "";
    if (!path) return out;
    const left = [];
    // The open file's first, then any other file's: marks a page left on another chapter go out from here too.
    const all = await records("*");
    for (const rec of [...all.filter((r) => r.path === path), ...all.filter((r) => r.path !== path)]) {
      const mine = rec.docId === D.docId && D.doc === app.pdfDocument;
      const here = rec.path === path;
      let B = !rec.len0 ? new Uint8Array(0) : mine && D.B ? D.B : J ? await J.base(rec).catch(() => null) : null;
      if (!B && here && D.doc && D.doc === app.pdfDocument) {
        B = await baseFromOpen(rec);
        if (!B && (await keepOnPi(rec))) { // on the Pi as it is, so it leaves the device and holds no Apply
          if (J) await J.remove(rec.id, rec.seq).catch(() => {});
          out.lost++;
          continue;
        }
      }
      if (!B) { if (here) { left.push(rec); out.kept++; out.why = "the version these marks were made on is missing"; } continue; }
      const bytes = new Uint8Array(B.length + rec.tail.length);
      bytes.set(B, 0);
      bytes.set(rec.tail, B.length);
      let res;
      try { res = await send(rec, bytes); }
      catch (err) {
        if (!(err instanceof TypeError)) console.error("[journal] sending failed", err);
        res = { kept: "no connection", offline: true };
      }
      if (!res.ok) {
        if (!here) { if (res.offline) break; continue; } // another file's: it waits, and is not this page's to show
        left.push({ ...rec, B });
        out.kept++;
        out.offline ||= !!res.offline;
        out.why = res.kept;
        window.__clientLog?.("journal-kept", { why: res.kept, status: res.status, seq: rec.seq, mine });
        continue;
      }
      out.sent++;
      out.carried ||= res.carried;
      window.__clientLog?.("journal-sent", { carried: res.carried, seq: rec.seq, mine, bytes: bytes.length });
      if (mine) {
        // The Pi has these marks now: the next save from this page sends only what is newer than them.
        D.since = rec.tail;
        D.own = res.carried ? null : res.sig;
        if (!res.carried && res.sig) st.sig = res.sig; // our own write: not a change to reload
        if (OFFLINE && !res.carried) keepCopy(path, bytes, res.sig);
      } else if (here) out.others++;
      if (J) {
        const gone = await J.remove(rec.id, rec.seq).catch(() => false);
        if (!gone && mine) await J.patch(rec.id, { since: D.since, own: D.own }).catch(() => {});
      } else if (D.mem === rec) D.mem = null;
    }
    // Marks this page cannot send now and does not show (it died, or reopened on another version): shown here,
    // on the version they were made on, until the Pi takes them. Only when nothing was marked on this page yet.
    // A record still without its base (no connection to hand it over yet) has nothing to show: it waits.
    const shown = left.filter((r) => r.B && !(r.docId === D.docId && D.doc === app.pdfDocument) && r.id !== D.supersedes); // not the one shown already
    if (shown.length && st.edits === D.edits0 && !st.busy && D.doc === app.pdfDocument && !document.getElementById("commentManagerDialog")?.open) {
      const rec = shown[shown.length - 1];
      const bytes = new Uint8Array(rec.B.length + rec.tail.length);
      bytes.set(rec.B, 0);
      bytes.set(rec.tail, rec.B.length);
      adopting = rec; // rec.B: the version they were made on (empty: none known, the tail is the whole file)
      window.__clientLog?.("journal-shown", { seq: rec.seq, why: out.why });
      app.open({ url: st.url, data: bytes }).catch((err) => console.error("[journal] showing the kept marks failed", err));
    }
    if (out.carried || out.others) { chase = true; setTimeout(tick, 0); } // the Pi's file holds more now: show it
    if (out.lost) offlineNote("⚠ Marks made on an older version of this file could not be put on it: they are kept on the Pi (state/refused)");
    D.kept = out.kept > 0;
    return out;
  })().finally(() => { pumping = null; journalState(); });
  return pumping;
}
function pumpSoon(now = false) {
  clearTimeout(pumpTimer);
  pumpTimer = setTimeout(() => pump().catch((err) => console.error("[journal]", err)), now ? 0 : 300);
}
setInterval(async () => { if (!document.hidden && (journalCount || (await records("*")).length)) pump().catch(() => {}); }, 10000);
addEventListener("online", () => pumpSoon(true));

let journalShown = false, journalRecheck = 0;
async function journalState() {
  const recs = st.url ? await records(decodeURIComponent(served(st.url))) : [];
  journalCount = recs.length;
  if (window.__pdfJournalCount !== recs.length) { // the phone's Online/Offline chip counts them too (offline-ui.js)
    window.__pdfJournalCount = recs.length;
    window.dispatchEvent(new Event("pdfreview:offline-state"));
  }
  // Shown once marks have waited: a save in its normal two seconds is not news.
  const oldest = recs.length ? Math.min(...recs.map((r) => r.at)) : 0;
  const waited = recs.length && (D.kept || Date.now() - oldest > 8000);
  clearTimeout(journalRecheck);
  if (recs.length && !waited) journalRecheck = setTimeout(journalState, 8500 - (Date.now() - oldest));
  if (waited) {
    journalShown = true;
    saveBtn.hidden = false;
    saveBtn.dataset.journal = String(recs.length);
    if (saveBtn.textContent !== "Saving…") saveBtn.textContent = "⏳ Marks waiting on this device, not on the Pi yet";
    saveBtn.title = "Your latest marks are kept on this device and shown here; they go to the Pi as soon as it takes them. Tap to send now.";
  } else if (!recs.length && journalShown) {
    journalShown = false;
    delete saveBtn.dataset.journal;
    saveBtn.hidden = false;
    saveBtn.textContent = "✓ All marks on the Pi";
    saveBtn.title = "Every mark made here is on the Pi";
    setTimeout(() => { if (!saveBtn.dataset.journal && saveBtn.textContent === "✓ All marks on the Pi") saveBtn.hidden = true; }, 2500);
  }
}
saveBtn.addEventListener("click", () => { if (saveBtn.dataset.journal) pumpSoon(true); });
saveBtn.style.cursor = "pointer";
window.__pdfJournalWaiting = async (path) => (await records(path)).length > 0; // offline.js holds a queued Apply on it
window.__pdfJournal = { waiting: async () => ((await waitingHere()) ? journalCount : 0), all: async () => (await records("*")).length, pump, snap, records: () => records() };

// ---- save over the original ------------------------------------------------------------------

// Edited since the last save. (annotationStorage.size counts every mark in the file, saved or not,
// which made the reload bar appear after any review: fixed 2026-10-16.)
const dirty = () => st.unsaved;

// force: an explicit Ctrl+S writes even when the auto-save already did.
async function saveOriginal(force = false) {
  if (!st.url || (!force && !dirty())) return;
  // A save asked for while one runs is run again when that one ends. It used to be dropped: on a 20 MB
  // book the phone's save took 45 s, the save started by a new highlight carried no note, and the note
  // typed meanwhile never reached the file (2026-11-10 08:38 and 08:52, two comments lost at Apply).
  if (st.saving) { st.again = true; return; }
  st.saving = true;
  // An edit made while this save runs is not in it: the save after it carries it (2026-11-12).
  const edits0 = st.edits;
  saveBtn.hidden = false;
  saveBtn.textContent = "Saving…";
  const draftAtStart = readDraft();
  try {
    // The marks go to this device's journal first, then to the Pi. A rebuild that lands meanwhile is no refusal
    // any more: the Pi carries them onto it (pump), and the page shows the newer file once the Pi has them.
    // Before 2026-11-15 they were kept on the device only after a refusal, and on the laptop a refusal reloaded
    // the newer file over them: a rebuild during a save lost them.
    if (!(await snap())) return;
    if (st.edits === edits0) st.unsaved = false; // in the journal now: nothing of them depends on this page any more
    else st.again = true;
    const out = await pump();
    if (!out.kept) {
      app.pdfDocument.annotationStorage.resetModified();
      draftSaved(draftAtStart);
      saveBtn.textContent = out.carried ? "✓ Saved onto the newer version" : "✓ Saved";
    } else {
      saveBtn.textContent = out.offline ? "✓ Kept on this device; sent when the Pi answers" : "✓ Kept on this device; the Pi did not take it yet";
      saveBtn.title = out.why || "";
    }
    st.pending = null;
    bar(false);
  } catch (err) {
    console.error("[save] writing the original file failed", err);
    saveBtn.textContent = "⚠ Not saved";
    saveBtn.title = String(err.message || err);
  } finally {
    st.saving = false;
    setTimeout(() => {
      if (saveBtn.textContent !== "⚠ Not saved" && !saveBtn.dataset.journal) saveBtn.hidden = true;
      journalState();
    }, 2500);
    if (st.again) { st.again = false; saveOriginal(true); } // sets st.saving again before it yields
  }
}


// ✏️ Write (writer.js, 2026-11-15): tap a paragraph and type in it, on the page. Shown only when the PDF is built
// from a .md beside it. Before, this button picked a paragraph for the Markdown box below and every Save rebuilt
// the PDF behind a frozen page; the box is still there for what the writer leaves to it (a table, raw HTML, the
// writer's Md button).
const editBtn = document.createElement("button");
editBtn.id = "editSource";
editBtn.className = "toolbarButton readerBtn";
editBtn.textContent = "✏️ Write";
editBtn.title = "Write: tap a paragraph and type in it. The words go into the text source at once; the PDF catches up by itself";
editBtn.hidden = true;
document.getElementById("toolbarViewerRight").prepend(editBtn);
writer.attach(editBtn);
editBtn.addEventListener("click", () => writer.toggle());

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

// The open Edit paragraph box also goes to the server a moment after each change (the chat can then
// read what was being typed), and the next time the file opens the box itself comes back: same text,
// cursor where it was. A PDF with no .md source falls back to the "not saved" rescue box.
const editDraftUrl = (path) => BASE + `/api/editdraft?path=${encodeURIComponent(path)}`;
let editPostTimer = null;
function postEdit(path, d) {
  clearTimeout(editPostTimer);
  const send = () => fetch(editDraftUrl(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) })
    .catch((err) => console.error("[edit] sending the open edit to the server failed", err));
  if (d.clear) send();
  else editPostTimer = setTimeout(send, 600);
}
async function restoreEdit() {
  if (!st.url || document.querySelector(".epWrap")) return;
  const path = decodeURIComponent(served(st.url));
  let d = readDraft();
  if (d?.kind !== "edit" || typeof d.old !== "string") d = null;
  try {
    const r = await fetch(editDraftUrl(path));
    const s = r.ok ? await r.json() : null;
    if (s && typeof s.text === "string" && typeof s.old === "string" && (!d || (s.at || 0) > (d.at || 0))) d = s;
  } catch (err) {
    console.error("[edit] asking the server for an open edit failed", err);
  }
  if (!d || document.querySelector(".epWrap")) return;
  window.__clientLog?.("edit-restored", { chars: d.text.length, at: d.at, changed: d.text !== d.old });
  document.getElementById("draftRescue")?.remove();
  editPopup({ index: d.index, text: d.old }, path, d);
}

function editPopup(block, path, draft) {
  const wrap = document.createElement("div");
  wrap.className = "epWrap";
  wrap.innerHTML = `<div class="epBox"><div class="epTitle">Edit paragraph</div>
    <textarea rows="1" class="epText"></textarea>
    <div class="epRow"><span class="msg epMsg">Markdown: **bold**, *italic*, [text](link)</span>
      <button class="cancel epBtn">Cancel</button><button class="save epBtn primary">Save</button></div></div>`;
  const ta = wrap.querySelector("textarea");
  ta.value = draft ? draft.text : block.text;
  // Fit the box to the text on open and while typing (up to 70% of the screen, then it scrolls).
  const fit = () => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  // An unsaved edit is copied to this device as it changes (typing or dictation), so a page that dies
  // with the box open loses nothing: the next open offers it back (offerDraft). Save and Cancel clear it.
  let kept = null;
  const keep = () => {
    const now = `${ta.selectionStart}|${ta.value}`;
    if (now === kept) return;
    kept = now;
    const d = { text: ta.value, at: Date.now(), saved: false, kind: "edit", index: block.index, old: block.text, caret: ta.selectionStart };
    try { localStorage.setItem(draftKey(), JSON.stringify(d)); } catch {}
    postEdit(path, d);
  };
  ta.addEventListener("input", keep);
  for (const ev of ["keyup", "pointerup"]) ta.addEventListener(ev, keep); // the cursor moved
  const keepTimer = setInterval(keep, 1000); // dictation sets the value without an input event
  const close = () => {
    clearInterval(keepTimer);
    if (readDraft()?.kind === "edit") localStorage.removeItem(draftKey());
    postEdit(path, { clear: true });
    wrap.remove();
  };
  wrap.querySelector(".cancel").onclick = close;
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); e.stopPropagation(); });
  wrap.querySelector(".save").onclick = async () => {
    const msg = wrap.querySelector(".msg");
    if (ta.value === block.text) return close();
    msg.textContent = "Saving…";
    // With no connection the page cannot be rebuilt: the edit waits on this phone and goes to the Pi, in
    // order, when the connection returns (offline.js). An edit behind others still waiting waits too.
    const keepHere = () => {
      queueParagraph(path, block.index, block.text, ta.value);
      close();
      offlineNote("✏️ Edit kept on this phone. It is applied on the Pi, and the page rebuilt, when the connection returns.");
      flush();
    };
    if (OFFLINE && (block.local || waiting().paragraphs.some((e) => e.path === path && !e.conflict))) return keepHere();
    try {
      const r = await fetch(BASE + `/api/paragraph?path=${encodeURIComponent(path)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: block.index, old: block.text, new: ta.value }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409 && typeof body.current === "string") {
        // The paragraph changed under him (an agent, the other device). His words stay in the box (and on the Pi, and
        // on this device); one more tap puts them in place of the paragraph that took the old one's place.
        block.index = body.index;
        block.text = body.current;
        msg.textContent = "⚠ This paragraph was changed meanwhile. Your words are kept: Save again puts them in its place.";
        wrap.querySelector(".save").textContent = "Put my words in";
        window.__clientLog?.("edit-refused-kept", { index: body.index });
        keep();
        return;
      }
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      close();
      rebuildFreeze(); // frozen until the rebuilt PDF is reopened
    } catch (err) {
      if (OFFLINE && err instanceof TypeError) return keepHere();
      console.error("[edit] saving the paragraph failed", err);
      msg.textContent = "⚠ " + (err.message || err);
    }
  };
  document.body.append(wrap);
  ta.focus();
  if (draft && Number.isInteger(draft.caret)) ta.selectionStart = ta.selectionEnd = Math.min(draft.caret, ta.value.length);
  keep(); // an untouched box comes back too
}

window.__pdfEditPopup = editPopup; // writer.js opens the box for what it leaves to it; test/edit-draft.mjs too
async function showEdit() {
  // The button keeps its state while this asks (a rebuild reopens the same file: ✏️ Write stays on, no blink).
  let has = false;
  if (st.url) {
    try {
      const where = served(st.url);
      const r = await fetch(BASE + `/api/source?path=${encodeURIComponent(decodeURIComponent(where))}${OFFLINE ? "&text=1" : ""}`);
      has = r.ok && (await r.json()).has;
    } catch {
      has = false;
    }
  }
  editBtn.hidden = !has;
  if (!has && writer.on) writer.toggle(false);
  if (!st.url) return;
  if (!has) offerDraft(true); // no source to edit: offer the kept text back to copy
  else restoreEdit();
}

// pdf.js's own Save buttons are hidden: saving is automatic.
for (const id of ["downloadButton", "secondaryDownload"]) {
  const b = document.getElementById(id);
  if (b) b.hidden = true, b.style.display = "none";
}

const redoBtn = document.createElement("button");
redoBtn.id = "redoDocument";
redoBtn.className = "toolbarButton readerBtn";
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
  // Marks still on their way to the Pi: send them first (they are carried onto the newer file there), and swap
  // the file in only once the Pi holds them. Swapping first threw away the page they were drawn on (2026-11-15).
  // A mark made and not saved yet goes first too (it is saved, which carries it); the swap comes on the next round.
  if (st.unsaved) { scheduleSave(); return; }
  if (await waitingHere()) { pumpSoon(); return; }
  st.busy = true;
  const edits0 = st.edits;
  st.sig0 = D.own || D.baseSig;
  // Never ask. A save already running is allowed to finish (up to 10 s) so the reopen does not race the write.
  for (let i = 0; i < 50 && st.saving; i++) await new Promise((r) => setTimeout(r, 200));
  bar(false);
  const viewer = app.pdfViewer;
  const container = viewer.container;
  let still = null; // a still copy of the page while the new file loads under it, so nothing blinks (writer.js)
  const keep = {
    page: viewer.currentPageNumber,
    scale: viewer.currentScaleValue,
    top: container.scrollTop,
    left: container.scrollLeft,
  };
  try {
    let data;
    if (OFFLINE && off.fetchChanged) {
      // The new file is rebuilt from the copy on this device plus the parts that changed, when the server
      // can say which (offline.js fetchChanged); else the whole file comes, as before.
      const got = await off.fetchChanged(decodeURIComponent(served(st.url)), st.sig);
      data = got.bytes;
      if (got.sig) st.sig = got.sig;
    } else {
      const r = await fetch(OFFLINE ? fresh(st.url) : st.url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = new Uint8Array(await r.arrayBuffer());
      // The version these bytes are, not the one the last check saw: the file can move on in between, and the
      // marks made on this page are sent against this version (journal).
      if (r.headers.get("Last-Modified")) st.sig = `${r.headers.get("Last-Modified")}|${r.headers.get("Content-Length")}`;
    }
    const copy = OFFLINE ? new Blob([data]) : null; // app.open hands `data` to the worker
    const restore = () => {
      viewer.currentScaleValue = keep.scale;
      viewer.currentPageNumber = Math.min(keep.page, viewer.pagesCount);
      container.scrollTop = keep.top;
      container.scrollLeft = keep.left;
    };
    // The fetch took a while (seconds on the phone): if he started marking or typing meanwhile, the swap waits for
    // the next round, or it would throw away the mark being made (an open comment box lost its note, 2026-11-15).
    if (st.edits !== edits0 || document.getElementById("commentManagerDialog")?.open || !(await writer.ready()) || !approvalsQuiet() || (await waitingHere())) {
      window.__clientLog?.("reload-deferred", {});
      st.sig = D.own || D.baseSig || st.sig0;
      return;
    }
    app.eventBus.on("pagesloaded", restore, { once: true });
    still = writer.frame();
    writer.landed();
    await app.open({ url: st.url, data });
    still.release(keep.page);
    console.info("[autoreload] reopened", st.url);
    if (copy) keepCopy(decodeURIComponent(served(st.url)), copy, st.sig);
    applyDone(); // the AI's rebuild arrived: the thinking indicator ends
    rebuildDone(); // a text edit's rebuild arrived: unfreeze
  } catch (err) {
    console.error("[autoreload] reopening the changed file failed", err);
    still?.drop();
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
  if (OFFLINE && hasPending(decodeURIComponent(served(st.url)))) {
    if (net.online) flush(); // offline.js probes the connection every 10 s and flushes then too
    return;
  }
  if (await waitingHere()) { pumpSoon(); return; } // the journal first: see reload()
  let sig;
  try {
    sig = await signature(st.url);
  } catch (err) {
    return console.error("[autoreload] checking the file failed", err);
  }
  if (!sig || sig === st.sig) {
    st.pending = null;
    chase = false;
    return;
  }
  // A file still being written changes size between checks: wait for two equal readings.
  if (sig !== st.pending) {
    st.pending = sig;
    return;
  }
  // An edit typed on the page is still drawn over it: swap the file in only once it holds that edit (writer.js).
  // He is approving paragraph after paragraph: the swap waits until he pauses (approve.js), then comes once.
  if (!(await writer.ready()) || !approvalsQuiet()) {
    st.pending = null;
    return;
  }
  st.sig = sig;
  st.pending = null;
  await reload();
}
window.addEventListener("pdfreview:writer-idle", () => { chase = true; tick(); });

async function onDocument() {
  const url = app.url;
  folderBtn.hidden = TOUCH || !watchable(url);
  if (!watchable(url)) {
    st.url = "";
    return;
  }
  if (url !== st.url) st.sig = null;
  st.url = url;
  newDoc();
  // How long the file was when it was loaded: a save then sends only what pdf.js appended after that
  // (offline.js putSave). Zero until known, and zero means "send the whole file".
  st.len0 = 0;
  const doc0 = app.pdfDocument;
  doc0?.getDownloadInfo().then(({ length }) => { if (app.pdfDocument === doc0) st.len0 = length; }).catch(() => {});
  // Top of the 🕘 Recent list, and what the phone's 📄 button reopens.
  // A test fixture never takes that place.
  if (!/\/papers\/open\/jarvistest\//.test(decodeURIComponent(url))) fetch(BASE + `/api/opened?path=${encodeURIComponent(decodeURIComponent(served(url)))}`, { method: "POST" })
    .catch((err) => console.error("[autoreload] recording the open file failed", err));
  // Once per file: a reload reopens the same url, and reload() keeps that copy itself.
  if (OFFLINE && st.keptUrl !== url) { st.keptUrl = url; await keepOpened(url); }
  try {
    st.sig ??= await signature(url);
  } catch (err) {
    console.error("[autoreload] reading the file's date failed", err);
  }
  if (D.doc === app.pdfDocument) D.baseSig ??= st.sig; // the version this page's marks are made on
  showRedo();
  showEdit();
  pumpSoon(true); // marks a page that died left in the journal: to the Pi now, or shown here
}

// Offline engine (offline.js): a file opened from the copy on this device keeps that copy's signature, so
// the tick fetches the server's file only when it differs (P4). A file that came from the network becomes
// the copy here (every opened file is kept). The last one opened is what offline.html opens.
async function keepOpened(url) {
  const path = decodeURIComponent(served(url));
  try { localStorage.setItem("pdfreview.last", path); } catch {}
  try {
    const meta = await keptMeta(path);
    if (meta && navigator.serviceWorker.controller) {
      st.sig = meta.sig;
      window.__clientLog?.("opened-kept-copy", { path, pending: meta.pending });
      return;
    }
    const sig = await signature(url);
    if (sig) {
      st.sig = sig;
      await keepCopy(path, await app.pdfDocument.getData(), sig);
    }
  } catch (err) {
    console.error("[offline] keeping the opened file failed", err);
  }
}

// What the offline engine did, said in the save note's place for a few seconds.
function offlineNote(text) {
  saveBtn.hidden = false;
  saveBtn.textContent = text;
  saveBtn.title = text;
  setTimeout(() => { if (saveBtn.textContent === text) { saveBtn.hidden = true; journalState(); } }, 6000);
}
window.addEventListener("pdfreview:synced", (e) => {
  const { path, kind, sig, ok, carried } = e.detail || {};
  if (!st.url || path !== decodeURIComponent(served(st.url))) return;
  if (kind === "marks") st.sig = carried ? null : sig || null; // carried onto a newer file: the tick reloads it
  if (kind === "redo" && ok) applyThinking();
  else if (kind === "redo") window.__pdfApplyLock?.off("not-woken");
  if (kind === "paragraph") offlineNote("✏️ Your edit reached the Pi; the page is being rebuilt");
});
// The copy kept for the file shown here stays the version it shows until reload() keeps the newer one (offline.js).
off.setOpenFile?.(() => (st.url ? { path: decodeURIComponent(served(st.url)), sig: st.sig } : null));
app.eventBus.on("documentloaded", onDocument);
if (app.pdfDocument) onDocument();

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
const edited = () => { st.unsaved = true; st.edits++; journalSoon(); scheduleSave(); };
// The storage calls onSetModified exactly when an edit commits, which is the moment to save.
const watchStorage = () => {
  const storage = app.pdfDocument?.annotationStorage;
  if (!storage || storage._pdfReviewWatched) return;
  storage._pdfReviewWatched = true;
  const prev = storage.onSetModified;
  storage.onSetModified = () => {
    prev?.();
    edited();
  };
};
// pdf.js sets the storage's modified flag only when a mark is added, and clears it when the last mark is
// deleted, so a colour change or a delete was never autosaved (2026-11-12). Every editing command, undo and
// redo now counts as an edit.
const watchCommands = (um) => {
  if (!um || um._pdfReviewWatched) return;
  um._pdfReviewWatched = true;
  for (const k of ["addCommands", "undo", "redo"]) {
    const f = um[k];
    um[k] = function (...a) { const r = f.apply(this, a); edited(); return r; };
  }
};
app.eventBus.on("annotationeditoruimanager", ({ uiManager }) => watchCommands(uiManager));
watchCommands(app.pdfViewer._layerProperties?.annotationEditorUIManager);
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
  st.unsaved = true;
  journalSoon();
  clearTimeout(typedTimer);
  typedTimer = setTimeout(() => saveOriginal(true), 1000);
});
function offerDraft(alsoEdit) {
  const d = readDraft();
  if (!d || d.saved || !d.text?.trim() || document.getElementById("draftRescue")) return;
  if (d.kind === "edit" && typeof d.old === "string" && !alsoEdit) return; // restoreEdit reopens the box itself
  window.__clientLog?.("draft-offered", { chars: d.text.length, at: d.at });
  const box = document.createElement("div");
  box.id = "draftRescue";
  box.style.cssText = "position:fixed;left:8px;right:8px;bottom:56px;z-index:100000;background:#fff8e8;border:2px solid #7A3921;border-radius:8px;padding:8px;font:14px sans-serif;color:#3b2a1a;box-shadow:0 4px 16px #0004";
  const when = new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  box.innerHTML = `<div style="font-weight:bold;margin-bottom:4px">${d.kind === "edit" ? "Paragraph edit" : "Comment"} not saved (${when}), kept on this device</div>`;
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
// The phone locked, the app sent to the back, the page about to go: what is on the page is written to the journal.
document.addEventListener("visibilitychange", () => { if (document.hidden && st.url && dirty()) snap(); });
addEventListener("pagehide", () => { if (st.url && dirty()) snap(); });

// ↻ Redo: save first, then ask the server to wake the chat recorded for this file.
// While the AI works: the button turns into a thinking indicator (animated dots) and stays disabled
// until the rebuilt file arrives and the viewer reopens it (reload() calls applyDone), or 30 min pass.
const REDO_LABEL = "✎ Apply comments";
const REDO_TITLE = "Save, then have the chat that made this PDF apply your comments to this same file (the PDF only, nothing else)";
let applyAnim = null, applyGiveUp = null;
function applyDone() {
  window.__pdfApplyLock?.off("done"); // the comments this round took are free again (tools.js)
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
  // Every comment on the page now is what this round applies: locked, with the robot on its icon, until the round
  // ends (tools.js). Held below for marks still on their way: unlocked. Queued offline: stays locked until it is sent.
  window.__pdfApplyLock?.on();
  clearTimeout(saveTimer);
  // A comment still open in its text box is not in the document until it loses focus, and a save
  // already running makes saveOriginal() return at once: both let the wake go out ahead of the
  // marks (2026-10-23 11:05, a written comment lost). Commit the box, wait the running save out.
  // The wait was 10 s; a big file's save outlasted it and the wake left first (2026-11-10). Now up to 3 min.
  document.activeElement?.blur?.();
  redoBtn.disabled = true;
  redoBtn.textContent = "Saving…";
  await new Promise((r) => setTimeout(r, 300));
  const waitedFrom = Date.now();
  for (let i = 0; i < 900 && st.saving; i++) await new Promise((r) => setTimeout(r, 200));
  if (Date.now() - waitedFrom > 2000) log("redo-waited-for-save", { ms: Date.now() - waitedFrom, still: !!st.saving });
  try { await saveOriginal(true); } catch (err) { log("redo-save-failed", { err: String(err) }); window.__pdfApplyLock?.off("save-failed"); throw err; }
  for (let i = 0; i < 900 && st.saving; i++) await new Promise((r) => setTimeout(r, 200));
  // Every mark on the Pi before the wake: the round's marked copy is what gets applied.
  if (await waitingHere()) await pump();
  if (await waitingHere()) {
    log("redo-held-marks-waiting", {});
    if (OFFLINE) {
      queueRedo(decodeURIComponent(served(st.url)));
      offlineNote("✎ Apply comments waits for the connection; it is sent once your marks reach the Pi");
    } else {
      offlineNote("⚠ Your latest marks have not reached the Pi yet: Apply waits for them. Press it again in a moment.");
      window.__pdfApplyLock?.off("held");
    }
    redoBtn.disabled = false;
    redoBtn.textContent = REDO_LABEL;
    return;
  }
  redoBtn.textContent = "Waking…";
  try {
    const where = served(st.url);
    const r = await fetch(BASE + `/api/redo?path=${encodeURIComponent(decodeURIComponent(where))}`, { method: "POST" });
    const body = await r.json().catch(() => ({}));
    log("redo-answer", { status: r.status, body });
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    applyThinking();
  } catch (err) {
    if (OFFLINE && err instanceof TypeError) {
      queueRedo(decodeURIComponent(served(st.url)));
      redoBtn.disabled = false;
      redoBtn.textContent = REDO_LABEL;
      offlineNote("✎ Apply comments waits for the connection; it is sent once your marks reach the Pi");
      return;
    }
    console.error("[redo] waking the chat failed", err);
    window.__pdfApplyLock?.off("not-woken");
    redoBtn.disabled = false;
    redoBtn.textContent = "⚠ Not woken";
    redoBtn.title = String(err.message || err);
    setTimeout(() => { redoBtn.textContent = REDO_LABEL; redoBtn.title = REDO_TITLE; }, 3000);
  }
}
redoBtn.addEventListener("click", redo);

// Apply in the comment box, beside Done (2026-11-15): saves this comment as Done does, then starts the same Apply as
// the toolbar's button. Shown only where that button is, and greyed while a round runs.
const commentDialog = document.getElementById("commentManagerDialog");
const doneBtn = document.getElementById("commentManagerSaveButton");
const applyHere = document.createElement("button");
applyHere.id = "commentManagerApplyButton";
applyHere.type = "button";
applyHere.className = "secondaryButton";
applyHere.tabIndex = 0;
applyHere.textContent = "Apply";
applyHere.title = "Save this comment, then have the chat apply all your comments now (as ✎ Apply comments)";
doneBtn?.before(applyHere);
applyHere.addEventListener("click", () => {
  window.__clientLog?.("redo-from-comment", {});
  doneBtn.click();
  redo();
});
if (commentDialog) new MutationObserver(() => {
  if (!commentDialog.open) return;
  applyHere.hidden = redoBtn.hidden || !st.url;
  applyHere.disabled = redoBtn.disabled;
}).observe(commentDialog, { attributes: true, attributeFilter: ["open"] });

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
async function answerMarks(asked = false) {
  const doc = app.pdfDocument;
  if (!st.url || !doc) return;
  if (!asked) { // the old rhythm: ask first (an older server, or the waiting request is switched off)
    let want;
    try {
      const r = await fetch(BASE + `/api/marks/want?path=${encodeURIComponent(served(st.url))}`);
      if (!r.ok) return;
      want = await r.json();
    } catch {
      return;
    }
    if (!want.want || want.have) return;
  }
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

// ---- waiting for news instead of asking every 2 s (2026-11-11) ------------------------------------
// The open viewer asked the server twice every 2 s: "did the file change?" and "does someone want my
// marks?". That is 60 requests a minute to read a book, it kept the phone's radio awake, and the second
// question made the phone hand over its marks every 30 s although nobody had asked. Now one request
// waits at the server (/api/watch) and is answered when either thing happens, or after WATCH_WAIT
// seconds. While a change is being taken in, the 2 s rhythm runs (`chase`): tick() wants two equal
// readings and waits for an open comment box. An older server has no /api/watch: the old polling runs.
// localStorage pdfreview.poll = "old" forces the old polling.
let oldPoll = 0;
const startOldPoll = () => { oldPoll ||= setInterval(() => { tick(); answerMarks(); }, POLL_MS); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const shown = () => new Promise((r) => {
  if (!document.hidden) return r();
  document.addEventListener("visibilitychange", function on() {
    if (document.hidden) return;
    document.removeEventListener("visibilitychange", on);
    r();
  });
});

async function watch() {
  let seen = null; // the version last heard of, in the server's words
  let forUrl = "";
  let fails = 0;
  for (;;) {
    if (document.hidden) await shown();
    if (!st.url) { await pause(1000); continue; }
    if (forUrl !== st.url) { forUrl = st.url; seen = null; }
    let r;
    try {
      r = await fetch(BASE + `/api/watch?path=${encodeURIComponent(served(st.url))}&sig=${encodeURIComponent(seen ?? st.sig ?? "")}&wait=${WATCH_WAIT}`, { cache: "no-store" });
    } catch {
      off.serverSeen?.(false);
      fails++;
      await pause(Math.min(30000, 5000 * fails));
      continue;
    }
    if (!r.ok) {
      const why = await r.text().catch(() => "");
      if (r.status === 404 && !why.includes("served paper")) {
        window.__clientLog?.("watch-old-server", {});
        return startOldPoll();
      }
      await pause(5000);
      continue;
    }
    fails = 0;
    off.serverSeen?.(true);
    if (journalCount) pumpSoon();
    const news = await r.json().catch(() => null);
    if (!news) { await pause(5000); continue; }
    seen = news.sig;
    if (news.want) answerMarks(true);
    if (news.changed) { chase = true; tick(); }
    if (news.want) await pause(1000); // the marks are on their way: do not ask before they can have arrived
  }
}

setInterval(() => { if (chase) tick(); }, POLL_MS);
setInterval(tick, 60000); // a safety net: one reading a minute, should a waiting request ever be lost
if (localStorage.getItem("pdfreview.poll") === "old") startOldPoll();
else watch();
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
  if (document.body.classList.contains("hlTools")) return; // a tapped highlight's tools are open (tools.js, 2026-11-12)
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

// ---- a highlight made in this session: its comment ----------------------------------------------
// 2026-10-16 a click on a new highlight pressed its comment's 💬 button here, because a comment just written
// could not be reopened ("when I refresh the page the comments seem to disappear"). Since 2026-11-15 a click
// on any highlight shows its tools instead, and the card opens from the 💬 icon (tools.js, "one tap, or two";
// a single click on an existing marking, with a comment or not, does not open the comment card).

// ---- 🕘 Recent: every PDF opened with this viewer that still exists, newest first (2026-10-21) ----
const recentBtn = document.createElement("button");
recentBtn.id = "recentFiles";
recentBtn.className = "toolbarButton readerBtn";
recentBtn.textContent = "🕘 Recent";
recentBtn.title = "The PDFs opened with this viewer, most recent first, and the books' PDFs by kind";
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

// 2026-11-19, need: every PDF of the books at hand, opened or not, one tab per kind of file, the book files by name.
// Beside Recent, one tab per kind of book file, from /api/books (every PDF under the book folders, sorted by name on
// the Pi: numbers by value, ch2 before ch10). The dialog opens on the tab used last. With no book folder set up
// (~/.config/pdf-review/books) it has no tabs: Recent alone.
const TABS = [
  ["recent", "Recent", "The PDFs opened with this viewer, most recent first"],
  ["chapters", "Chapters", "Every chapter of the books, by name"],
  ["notes", "Notes", "The books' other documents (plot, rules, plans), by name"],
  ["marked", "Marked", "Your marked copies, kept before each Apply round, by name"],
  ["earlier", "Earlier", "The build kept before each text edit, by name"],
  ["backups", "Backups", "The copies in the books' backup folders, by name, the newest backup first"],
];
const TAB_KEY = "pdfreview.recentTab";

async function showRecent() {
  document.getElementById("recentDialog")?.remove();
  const dlg = document.createElement("dialog");
  dlg.id = "recentDialog";
  dlg.innerHTML = `<div class="recentHead"><b>Recent PDFs</b><button type="button" class="recentClose" aria-label="Close">✕</button></div>` +
    `<div class="recentTabs" role="tablist" hidden></div><div class="recentList">Loading…</div>`;
  document.body.append(dlg);
  dlg.querySelector(".recentClose").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  const list = dlg.querySelector(".recentList"), tabs = dlg.querySelector(".recentTabs");
  const open = st.url ? decodeURIComponent(served(st.url)) : "";
  let tab = "recent";
  try { tab = localStorage.getItem(TAB_KEY) || "recent"; } catch {}
  const got = { recent: null, books: null }; // each answer as it comes: its files, or the Error
  const drawTabs = () => {
    const books = Array.isArray(got.books) ? got.books : [];
    const shown = TABS.filter(([id]) => id === "recent" || books.some((f) => f.kind === id));
    tabs.hidden = shown.length < 2;
    dlg.querySelector(".recentHead b").textContent = shown.length < 2 ? "Recent PDFs" : "PDFs";
    tabs.innerHTML = shown.map(([id, label, tip]) => {
      const n = id === "recent" ? (Array.isArray(got.recent) ? got.recent.length : "") : books.filter((f) => f.kind === id).length;
      return `<button type="button" role="tab" class="recentTab${id === tab ? " on" : ""}" data-tab="${id}" aria-selected="${id === tab}" ` +
        `title="${escHtml(tip)}">${label}<span class="n">${n}</span></button>`;
    }).join("");
  };
  const drawList = () => {
    const files = tab === "recent" ? got.recent : got.books;
    if (files === null) list.textContent = "Loading…";
    else if (files instanceof Error) list.textContent = `The list could not be loaded: ${files.message}`;
    else if (tab === "recent") drawRecent(list, files, open, dlg);
    else drawBook(list, files.filter((f) => f.kind === tab), open, tab);
  };
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".recentTab");
    if (!b || b.dataset.tab === tab) return;
    tab = b.dataset.tab;
    try { localStorage.setItem(TAB_KEY, tab); } catch {}
    list.scrollTop = 0;
    drawTabs();
    drawList();
  });
  drawTabs();
  const get = async (p) => {
    const r = await fetch(BASE + p, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).files || [];
  };
  get("/api/history").catch((err) => { console.error("[recent] the list failed", err); return err; }).then((files) => {
    got.recent = files;
    drawTabs();
    if (tab === "recent") drawList();
  });
  // No book list (offline with no copy kept, a server older than /api/books): Recent alone, never an error.
  get("/api/books").catch((err) => { console.warn("[recent] the book list failed; Recent only", err); return []; }).then((files) => {
    got.books = files;
    const was = tab;
    if (tab !== "recent" && !files.some((f) => f.kind === tab)) tab = "recent";
    drawTabs();
    if (was !== "recent") drawList();
  });
}

function drawRecent(list, files, open, dlg) {
  list.innerHTML = files.length
    ? files.map((f) => `<a class="recentRow${f.path === open ? " current" : ""}" href="${escHtml(viewerUrl(f.path))}">` +
        `<span class="recentName">${escHtml(f.name)}</span>` +
        `<span class="recentMeta">${escHtml(ago(f.at))} · ${escHtml(f.dir)}</span></a>`).join("")
    : "No PDF opened yet.";
  list.querySelectorAll(".recentRow").forEach((row, i) => holdForMenu(row, files[i], dlg));
  if (OFFLINE) list.querySelectorAll(".recentRow").forEach((row, i) => row.classList.toggle("kept", isKept(files[i].path)));
  blueNames(list, files);
}

// A book tab: its files in the Pi's order. A file never opened has no link yet (path null): a tap links it (/api/open,
// as a file link tapped in Tinker does) and opens it. Only chapters and notes have a .md, so new text to approve.
function drawBook(list, files, open, kind) {
  list.innerHTML = files.map((f) => `<a class="recentRow${f.path && f.path === open ? " current" : ""}" ` +
    `href="${f.path ? escHtml(viewerUrl(f.path)) : "#"}"><span class="recentName">${escHtml(f.name)}</span>` +
    `<span class="recentMeta">${escHtml(f.dir)} · changed ${escHtml(ago(f.at))}</span></a>`).join("");
  list.querySelectorAll(".recentRow").forEach((row, i) => {
    const f = files[i];
    if (!f.path) row.addEventListener("click", (e) => { e.preventDefault(); openBookFile(f, row); });
    else if (OFFLINE) row.classList.toggle("kept", isKept(f.path));
  });
  list.querySelector(".recentRow.current")?.scrollIntoView({ block: "center" });
  if (kind === "chapters" || kind === "notes") blueNames(list, files);
}

async function openBookFile(f, row) {
  const meta = row.querySelector(".recentMeta");
  meta.textContent = "Opening…";
  try {
    const r = await fetch(`${BASE}/api/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: f.file }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.path) throw new Error(body.error || `HTTP ${r.status}`);
    location.href = viewerUrl(body.path);
  } catch (err) {
    console.error(`[recent] opening ${f.file} failed`, err);
    meta.textContent = `Could not open it: ${err.message}`;
  }
}

// 2026-11-18, need: see at a glance which files still hold unapproved new text. A name is blue while its
// PDF has paragraphs waiting for ✓ Approve, the count in its tooltip. The count is the Pi's ✓ Approve scan
// (server.py approve_scan, the one the page's buttons come from), so the list and the open page agree. The list
// draws first with the counts the Pi already knew (/api/history `blue`); /api/blue then scans the rest. With no
// answer (offline, a failed scan) the names keep the last counts this device saw, or stay as they are.
const BLUE_SEEN = "pdfreview.blue"; // url path -> paragraphs waiting, the last the Pi said
async function blueNames(list, files) {
  const rows = [...list.querySelectorAll(".recentRow")];
  const paint = (counts) => rows.forEach((row, i) => {
    const n = counts[files[i].path];
    if (n === undefined) return;
    const name = row.querySelector(".recentName");
    name.classList.toggle("toApprove", n > 0);
    if (n > 0) row.title = `${n} blue paragraph${n === 1 ? "" : "s"} to approve`;
    else row.removeAttribute("title");
    row.dataset.blue = String(n);
  });
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(BLUE_SEEN) || "{}") || {}; } catch {}
  const known = Object.fromEntries(files.filter((f) => typeof f.blue === "number").map((f) => [f.path, f.blue]));
  paint(known);
  const asked = files.filter((f) => f.path); // a book file never opened has no link to ask about
  if (!asked.length) return;
  try {
    const q = asked.map((f) => `path=${encodeURIComponent(f.path)}`).join("&");
    const r = await fetch(`${BASE}/api/blue?${q}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { blue } = await r.json();
    paint(blue);
    try { localStorage.setItem(BLUE_SEEN, JSON.stringify({ ...seen, ...known, ...blue })); } catch {}
  } catch (err) {
    console.warn("[recent] the blue names could not be checked; the last ones known stay", err);
    paint(Object.fromEntries(files.filter((f) => !(f.path in known) && typeof seen[f.path] === "number").map((f) => [f.path, seen[f.path]])));
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

