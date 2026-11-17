import { BASE, viewerUrl } from "./base.js";

// pdf-review offline (2026-11-10): use the copy on the phone instead of downloading each time, and let
// comments and paragraph edits work with no connection (a long flight).
// On a secure origin (the tailnet HTTPS door; localhost with localStorage pdfreview.offline=1 for the tests):
//   - sw.js keeps the viewer, every PDF opened here, and its .md source on this device;
//   - a PDF opens from the kept copy at once; autoreload.js then compares the server's signature with the
//     copy's and fetches the file only when it changed;
//   - marks saved with no connection are kept here (a "pending" copy) and sent when it comes back, with the
//     version they were made on: a server file that moved on meanwhile gets only the new marks carried
//     onto it (server.py /api/save base=…, pdf-carry-marks.py --since), never the old file written over it;
//   - ✏️ paragraph edits made with no connection wait in a queue (same /api/paragraph contract) and are
//     sent in order; one the server refuses stays in the list with its reason, never dropped;
//   - Apply comments pressed offline is sent once the marks are on the server;
//   - "Keep this folder" fetches every PDF of the folder (and its source) ahead.
// The plain-http path (no service worker possible there) is left exactly as it was.
export const OFFLINE = !!(window.isSecureContext && "serviceWorker" in navigator && "caches" in window
  && (location.protocol === "https:" || localStorage.getItem("pdfreview.offline") === "1"
    // 2026-11-10: the phone app loads the door through a relay on 127.0.0.1 (a secure origin), under /pdf/.
    || (location.hostname === "127.0.0.1" && location.pathname.startsWith("/pdf/"))));

const DOCS = "pdfreview-docs-v1";
const log = (e, d) => window.__clientLog?.(e, d);
const enc = encodeURIComponent;
const fileUrl = (path) => BASE + path.split("/").map(enc).join("/");
const docKey = (path) => BASE + path;
const pendingKey = (path) => `${BASE}/__pending__${path}`;
const sourceUrl = (path) => `${BASE}/api/source?path=${enc(path)}&text=1`;
const nameOf = (path) => path.split("/").pop();
/** A URL the service worker sends to the server, never answered from the copy here (sw.js). */
export const fresh = (url) => `${url}${url.includes("?") ? "&" : "?"}fresh=${Date.now()}`;

// A request that never answers must not hold a whole round: on the in-flight link one stuck request
// stopped the keep at 3 of 21 files (2026-11-11 01:37). Short calls get 20 s, a file 5 minutes.
const limit = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
const QUICK = 20000, SLOW = 5 * 60000;
// Two readings of one version. The size half may be missing after a proxy; then the dates decide.
const sameVersion = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const [da, sa] = a.split("|"), [db, sb] = b.split("|");
  return da === db && (!sa || !sb || sa === "null" || sb === "null");
};

// delta.js (crc32, the chunk table, the rebuild) is loaded when first needed, and its absence is survivable:
// on a slow link the viewer's files can arrive as a mix of new ones and kept ones, and a missing helper
// must cost only the saving in data, never the save itself.
let deltaJs;
const helpers = () => (deltaJs ??= import("./delta.js").catch((err) => {
  console.error("[offline] delta.js did not load; whole files travel until it does", err);
  deltaJs = undefined;
  return null;
}));

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (err) { console.error("[offline] storing", k, err); } };
const PENDING = "pdfreview.pending";  // path -> {base, at, error?}: marks saved here, not yet on the server
const REDO = "pdfreview.redo";        // path -> at: Apply comments pressed offline
const PARAQ = "pdfreview.paraq";      // [{id, path, index, old, new, at, conflict?}] in the order typed
const KEPT = "pdfreview.kept";        // path -> {name, sig, at}: copies on this device
const FOLDERS = "pdfreview.folders";  // folder of a served path -> [served paths]: what "keep this folder" covers

export const state = { online: navigator.onLine, syncing: false };
const changed = () => window.dispatchEvent(new Event("pdfreview:offline-state"));

if (OFFLINE) {
  navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` })
    .then(() => log("sw-registered", { controlled: !!navigator.serviceWorker.controller }))
    .catch((err) => { console.error("[offline] registering the service worker failed", err); log("sw-failed", { err: String(err) }); });
}

// ---- copies on this device --------------------------------------------------------------------------
export async function keptMeta(path) {
  if (!OFFLINE) return null;
  const docs = await caches.open(DOCS);
  const p = await docs.match(pendingKey(path));
  if (p) return { sig: p.headers.get("x-sig"), pending: true };
  const k = await docs.match(docKey(path));
  return k ? { sig: k.headers.get("x-sig"), pending: false } : null;
}

async function put(key, body, sig) {
  const docs = await caches.open(DOCS);
  const len = body?.size ?? body?.byteLength ?? "";
  await docs.put(key, new Response(body, { headers: { "Content-Type": "application/pdf", "x-sig": sig || "", "x-len": String(len) } }));
}

/** Keep `body` (bytes, a Blob or a Response's body) as this device's copy of the server version `sig`. */
export async function keepCopy(path, body, sig) {
  if (!OFFLINE || !sig) return;
  try {
    await put(docKey(path), body, sig);
    const kept = load(KEPT, {});
    kept[path] = { name: nameOf(path), sig, at: Date.now() };
    store(KEPT, kept);
    changed();
  } catch (err) {
    console.error("[offline] keeping a copy failed", path, err);
    log("keep-failed", { path, err: String(err) });
  }
}

/** Marks saved with no connection (or onto a file that moved on): kept here until the server has them. */
export async function keepPending(path, bytes, base) {
  await put(pendingKey(path), bytes, base);
  const p = load(PENDING, {});
  p[path] = { base, at: Date.now() };
  store(PENDING, p);
  log("marks-kept-on-device", { path, bytes: bytes.length });
  changed();
}

export const hasPending = (path) => !!load(PENDING, {})[path];

// ---- fetch ahead ------------------------------------------------------------------------------------
async function serverSig(path) {
  const r = await fetch(fileUrl(path), { method: "HEAD", cache: "no-store", signal: limit(QUICK) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return `${r.headers.get("Last-Modified")}|${r.headers.get("Content-Length")}`;
}

// 2026-11-11: a changed PDF is rebuilt here from the copy on this device. A rebuilt chapter is 94 to 98 %
// the bytes of the one before (pictures, fonts, untouched pages), so about 20 to 50 kB travel instead of
// 1.1 MB. delta.js describes the copy; server.py /api/delta answers what to reuse and what is new; the
// result's crc32 is checked before it is kept. Anything that fails falls back to the whole file.
const DELTA_MIN = 20000; // a smaller file is fetched whole: the exchange would cost as much

/** The server's file now, as {bytes, sig, delta}: rebuilt from the copy here when that works. */
export async function fetchChanged(path, sigHint) {
  const hit = OFFLINE ? await (await caches.open(DOCS)).match(docKey(path)) : null;
  const d = hit ? await helpers() : null;
  if (hit && d) {
    try {
      const old = new Uint8Array(await hit.arrayBuffer());
      if (old.length >= DELTA_MIN) {
        const table = d.chunkTable(old);
        const r = await fetch(`${BASE}/api/delta?path=${enc(path)}`, {
          method: "POST", body: new Uint8Array(table.buffer), headers: { "Content-Type": "application/octet-stream" }, signal: limit(SLOW),
        });
        if (r.ok) {
          const answer = new Uint8Array(await r.arrayBuffer());
          const { bytes, copied } = d.applyDelta(old, answer);
          log("delta-fetched", { path, size: bytes.length, reused: copied, sent: table.byteLength, got: answer.length });
          return { bytes, sig: r.headers.get("X-Sig") || sigHint, delta: true };
        }
        if (r.status !== 404) log("delta-refused", { path, status: r.status });
      }
    } catch (err) {
      console.error("[offline] rebuilding from the copy here failed; fetching the whole file", path, err);
      log("delta-failed", { path, err: String(err) });
    }
  }
  const r = await fetch(fresh(fileUrl(path)), { cache: "no-store", signal: limit(SLOW) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { bytes, sig: sigHint || `${r.headers.get("Last-Modified")}|${r.headers.get("Content-Length")}`, delta: false };
}

// The origin and source answers the viewer asks for on open must be on the device too. They are stored
// here, by the page, in the cache sw.js answers from: on a first load the worker does not control the
// page yet, the answers passed it by, and the Edit button then had no source offline (test/offline.mjs
// P3 failed whenever the worker's install took over two seconds). Asked again only when the PDF changed
// or no answer is kept: a quiet round used to ask both for every file.
const askedAhead = new Set();

// The file open in this page and the version it shows (autoreload.js). Its copy here is the base its marks are
// carried from (sendMarks), so while the page still shows an older version (a comment box held the reload),
// only the page's own reload replaces that copy (burn review 2026-11-13 F5: a keep round put S2 there, and the
// next carry brought every comment the agent had applied back onto the clean rebuild).
let openFile = () => null;
export const setOpenFile = (f) => { openFile = f; };

/** Fetch one PDF (only when the server's version differs from the copy here) and its source.
 *  sig: the server's version when the caller already has it (the folder list), which saves the HEAD. */
export async function fetchAhead(path, { source = true, sig: known } = {}) {
  const meta = await keptMeta(path);
  const sig = known || await serverSig(path);
  const open = openFile();
  const behindOnScreen = !!open && open.path === path && !sameVersion(open.sig, sig);
  let fetched = false;
  if (!behindOnScreen && (!meta || (!meta.pending && !sameVersion(meta.sig, sig)))) {
    const got = await fetchChanged(path, sig);
    await keepCopy(path, got.bytes, got.sig);
    fetched = true;
  }
  const api = await caches.open("pdfreview-api-v1");
  const ask = async (url) => {
    if (!fetched && (askedAhead.has(url) || await api.match(url))) return;
    askedAhead.add(url);
    try {
      const r = await fetch(url, { signal: limit(QUICK) });
      if (r.ok) await api.put(url, r);
    } catch (err) {
      askedAhead.delete(url); // no answer at all: ask again next round
    }
  };
  await ask(`${BASE}/api/origin?path=${enc(path)}`);
  if (source) await ask(sourceUrl(path));
  return fetched;
}

const folderOf = (path) => path.replace(/\/[^/]*$/, "");
let lastKeepMissed = 0; // files the last keepFolder could not fetch, after its second try

/** Keep every PDF in the folder of `path`; progress(done, total). Answers {kept, total}. */
export async function keepFolder(path, progress = () => {}) {
  const r = await fetch(`${BASE}/api/folder?path=${enc(path)}`, { cache: "no-store", signal: limit(QUICK) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  const files = body.files || [];
  const folders = load(FOLDERS, {});
  folders[folderOf(path)] = files.map((f) => f.path);
  store(FOLDERS, folders);
  let done = 0, failed = 0;
  const again = [];
  progress(done, files.length);
  for (const f of files) {
    try { await fetchAhead(f.path, { source: f.source, sig: f.sig }); }
    catch (err) { again.push(f); console.error("[offline] fetching ahead failed", f.path, err); }
    progress(++done, files.length);
  }
  // One more try for the files that failed or ran out of time, once the others are in.
  for (const f of again) {
    try { await fetchAhead(f.path, { source: f.source, sig: f.sig }); }
    catch (err) { failed++; console.error("[offline] fetching ahead failed twice", f.path, err); }
  }
  lastKeepMissed = failed;
  log("folder-kept", { folder: folderOf(path), total: files.length, failed });
  return folderCount(path);
}

// 2026-11-10: the latest copy of what he reads is always on the phone, unasked. Whenever the Pi answers:
// every folder opened in the last 14 days (the history, newest first) is kept; fetchAhead downloads only
// a file whose version here differs. The folder list carries each file's version, so a quiet round costs
// one request per folder (it was one HEAD and two more requests per file). At most every 5 minutes.
const AUTO = "pdfreview.autokeep";    // when the last automatic round ended (ms)
const AUTO_EVERY = 5 * 60 * 1000, AUTO_DAYS = 14;
let autoRunning = false;
export async function autoKeep({ force = false } = {}) {
  if (!OFFLINE || autoRunning) return;
  if (!force && Date.now() - load(AUTO, 0) < AUTO_EVERY) return;
  autoRunning = true;
  try {
    const r = await fetch(`${BASE}/api/history`, { cache: "no-store", signal: limit(QUICK) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const since = Date.now() - AUTO_DAYS * 86400000;
    const covered = new Set();
    let folders = 0, files = 0, missed = 0;
    for (const f of (await r.json()).files || []) {
      if (covered.has(f.path) || !(f.at >= since)) continue;
      try {
        await keepFolder(f.path);
        missed += lastKeepMissed;
        const all = load(FOLDERS, {})[folderOf(f.path)] || [];
        all.forEach((x) => covered.add(x));
        folders++; files += all.length;
      } catch (err) { console.error("[offline] automatic keep failed", f.path, err); }
    }
    // A round that missed files comes back in a minute, not in five.
    store(AUTO, missed ? Date.now() - AUTO_EVERY + 60000 : Date.now());
    log("auto-kept", { folders, files, missed });
    changed();
  } catch (err) {
    console.error("[offline] automatic keep failed", err);
    log("auto-keep-failed", { err: String(err) });
  } finally { autoRunning = false; }
}

export function folderCount(path) {
  const all = load(FOLDERS, {})[folderOf(path)];
  if (!all) return null;
  const kept = load(KEPT, {});
  return { kept: all.filter((p) => kept[p]).length, total: all.length };
}

export const isKept = (path) => !!load(KEPT, {})[path];

// ---- ✏️ paragraphs with no connection -----------------------------------------------------------------
// The same split and the same fuzzy match as server.py (_md_split, _letters, _paragraph_get), on the source
// kept here with the edits still waiting applied, so a second edit sees the first.
const split = (text) => text.split(/(\n\n|\n(?=[-*] |\d+\. ))/);
const letters = (t) => t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/<[^>]+>/g, " ").toLowerCase().replace(/[^a-z0-9]/g, "");

function longestCommon(a, b) {
  let best = 0;
  let prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    [prev, cur] = [cur, prev];
  }
  return best;
}

function applyEdit(text, e) {
  const parts = split(text);
  if (parts[2 * e.index] !== e.old) return null;
  const i = 2 * e.index;
  if (!e.writer) parts[i] = e.new.replace(/^\n+|\n+$/g, "").replaceAll("\n\n", "\n");
  // Typed on the page (writer.js): it may be several blocks (Enter) or none (all deleted), as server.py keeps it.
  else if (e.new.trim()) parts[i] = e.new.replace(/^\n+|\n+$/g, "") + (parts[i].match(/\n+$/)?.[0] ?? "");
  else if (parts.length === 1) parts[0] = "";
  else if (i + 1 < parts.length) parts.splice(i, 2);
  else { const tail = parts[i].match(/\n+$/)?.[0] ?? ""; parts.splice(i - 1, 2); parts[i - 2] += tail; }
  return parts.join("");
}

/** The source text with the paragraph edits still waiting on this device applied, as he sees it. */
export function pendingApplied(path, text) {
  for (const e of load(PARAQ, []).filter((e) => e.path === path && !e.conflict)) text = applyEdit(text, e) ?? text;
  return text;
}

async function localSource(path) {
  const r = await fetch(sourceUrl(path));
  const body = await r.json();
  if (!r.ok || typeof body.text !== "string") throw new Error("this file's source is not kept on this phone");
  let text = body.text;
  for (const e of load(PARAQ, []).filter((e) => e.path === path && !e.conflict)) text = applyEdit(text, e) ?? text;
  return text;
}

/** The paragraph under the click, found in the source kept on this device: {index, text}. */
export async function localParagraph(path, q) {
  const ql = letters(q);
  if (ql.length < 6) throw new Error("click on a line of text");
  const blocks = split(await localSource(path)).filter((_, i) => i % 2 === 0);
  let best = null, score = 0;
  blocks.forEach((b, i) => {
    const lb = letters(b);
    if (!lb) return;
    const s = longestCommon(ql, lb);
    if (s > score) { best = i; score = s; }
  });
  if (best === null || score < Math.min(12, ql.length * 0.6)) throw new Error("no matching paragraph found");
  return { index: best, text: blocks[best], local: true };
}

/** Queue a paragraph edit. Editing a paragraph that already waits replaces that edit.
 *  extra: {writer: true, vis} for an edit typed on the page, which the server checks against vis. */
export function queueParagraph(path, index, old, text, extra = {}) {
  const q = load(PARAQ, []);
  const same = q.find((e) => e.path === path && e.index === index && (e.new === old || e.old === old));
  if (same) {
    same.new = text; same.at = Date.now(); delete same.conflict;
    if (!extra.writer) { delete same.writer; delete same.vis; } // changed in the Markdown box: the box's rules, no word check
    Object.assign(same, extra);
  }
  else q.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, path, index, old, new: text, at: Date.now(), ...extra });
  store(PARAQ, q);
  log("paragraph-queued", { path, index, chars: text.length });
  changed();
}

export function queueRedo(path) {
  const r = load(REDO, {});
  r[path] = Date.now();
  store(REDO, r);
  log("redo-queued", { path });
  changed();
}

export function waiting() {
  const pend = load(PENDING, {}), redo = load(REDO, {}), paraq = load(PARAQ, []);
  return { marks: Object.entries(pend), redo: Object.keys(redo), paragraphs: paraq,
    count: Object.keys(pend).length + Object.keys(redo).length + paraq.length };
}

// ---- sync ----------------------------------------------------------------------------------------------
const isNetErr = (err) => err instanceof TypeError; // fetch's "Failed to fetch": no connection

// 2026-11-11: a save sends only what pdf.js appended. saveDocument() answers the file as it was loaded
// plus the new marks at its end (1 to 5 kB on a 2 MB file), and the whole file used to travel on every
// autosave. `keep` = how many leading bytes the server already has; it rebuilds the file and checks the
// length and crc32 given here. 422 (or an older server's 400) means "send the whole file": done at once.
export async function putSave(url, data, keep) {
  const d = keep > 0 && data.length > keep ? await helpers() : null;
  if (d) {
    const r = await fetch(`${url}&keep=${keep}&len=${data.length}&crc=${d.crc32(data).toString(16)}`, { method: "PUT", body: data.subarray(keep) });
    if (r.status !== 422 && r.status !== 400) {
      if (r.ok) log("save-part", { sent: data.length - keep, of: data.length });
      return r;
    }
    log("save-part-refused", { status: r.status, keep, of: data.length });
  }
  return fetch(url, { method: "PUT", body: data });
}

async function sendMarks(path, entry) {
  const docs = await caches.open(DOCS);
  const pend = await docs.match(pendingKey(path));
  if (!pend) return true;
  const bytes = new Uint8Array(await pend.arrayBuffer());
  const url = `${BASE}/api/save?path=${enc(path)}&base=${enc(entry.base || "")}`;
  // The marks were made on the copy kept here: when that is still the server's version, only the part
  // after it travels.
  let keep = 0;
  const made = await docs.match(docKey(path));
  if (made && made.headers.get("x-sig") === entry.base) keep = Number(made.headers.get("x-len")) || (await made.arrayBuffer()).byteLength;
  let r = await putSave(url, bytes, keep);
  if (r.status === 409) {
    // The server's file moved on: send the copy the marks were made on too, so only the new marks go across.
    const baseCopy = await docs.match(docKey(path));
    const base = baseCopy && baseCopy.headers.get("x-sig") === entry.base ? new Uint8Array(await baseCopy.arrayBuffer()) : new Uint8Array(0);
    const both = new Uint8Array(base.length + bytes.length);
    both.set(base, 0);
    both.set(bytes, base.length);
    r = await fetch(url, { method: "PUT", body: both, headers: { "X-Base-Length": String(base.length) } });
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { http: r.status });
  await docs.delete(pendingKey(path));
  const p = load(PENDING, {});
  delete p[path];
  store(PENDING, p);
  // Signatures as the viewer reads them (HEAD through every proxy), so the tick compares like with like.
  if (body.carried) await fetchAhead(path).catch(() => {});
  else await keepCopy(path, bytes, await serverSig(path).catch(() => body.sig));
  log("marks-synced", { path, carried: !!body.carried, note: body.note || "" });
  window.dispatchEvent(new CustomEvent("pdfreview:synced", { detail: { path, kind: "marks", sig: body.sig, carried: !!body.carried } }));
  return true;
}

async function sendRedo(path) {
  const r = await fetch(`${BASE}/api/redo?path=${enc(path)}`, { method: "POST" });
  const body = await r.json().catch(() => ({}));
  const all = load(REDO, {});
  if (!r.ok) {
    log("redo-sync-failed", { path, status: r.status, body });
    if (r.status >= 500) throw new Error(body.error || `HTTP ${r.status}`);
  }
  delete all[path];
  store(REDO, all);
  log("redo-synced", { path, status: r.status });
  window.dispatchEvent(new CustomEvent("pdfreview:synced", { detail: { path, kind: "redo", ok: r.ok } }));
}

async function sendParagraph(e) {
  const r = await fetch(`${BASE}/api/paragraph?path=${enc(e.path)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(e.writer ? { index: e.index, old: e.old, new: e.new, vis: e.vis, writer: true } : { index: e.index, old: e.old, new: e.new }),
  });
  const body = await r.json().catch(() => ({}));
  const q = load(PARAQ, []);
  const mine = q.find((x) => x.id === e.id);
  if (r.ok) {
    store(PARAQ, q.filter((x) => x.id !== e.id));
    await fetch(sourceUrl(e.path)).catch(() => {}); // the kept source follows the server's
    log("paragraph-synced", { path: e.path, index: e.index });
    window.dispatchEvent(new CustomEvent("pdfreview:synced", { detail: { path: e.path, kind: "paragraph" } }));
  } else if (mine) {
    // Refused (the paragraph changed on the Pi meanwhile): kept, with the reason, for him to decide.
    mine.conflict = body.error || `HTTP ${r.status}`;
    store(PARAQ, q);
    log("paragraph-conflict", { path: e.path, index: e.index, error: mine.conflict });
  }
}

/** Send everything waiting, oldest first: marks, then paragraph edits, then Apply comments. */
export async function flush() {
  if (!OFFLINE || state.syncing) return;
  const w = waiting();
  if (!w.count) return;
  state.syncing = true;
  changed();
  try {
    for (const [path, entry] of w.marks) {
      try { await sendMarks(path, entry); }
      catch (err) {
        if (isNetErr(err)) throw err;
        const p = load(PENDING, {});
        if (p[path]) { p[path].error = String(err.message || err); store(PENDING, p); }
        console.error("[offline] sending marks failed", path, err);
        log("marks-sync-failed", { path, err: String(err.message || err) });
      }
    }
    for (const e of w.paragraphs.filter((e) => !e.conflict)) await sendParagraph(e);
    const stillMarked = load(PENDING, {});
    // Apply goes only once that file's marks are on the Pi: the old pending copy, and the journal (autoreload.js).
    for (const path of Object.keys(load(REDO, {}))) {
      if (!stillMarked[path] && !(await window.__pdfJournalWaiting?.(path).catch(() => false))) await sendRedo(path);
    }
    state.online = true;
  } catch (err) {
    if (isNetErr(err)) state.online = false;
    else console.error("[offline] sync failed", err);
  } finally {
    state.syncing = false;
    changed();
  }
}

export function discardParagraph(id) {
  store(PARAQ, load(PARAQ, []).filter((e) => e.id !== id));
  changed();
}

// 2026-11-10: is the READER itself on this device? The worker answers offline only after its install fetched
// every viewer file, and nothing on screen said how far that was: a reader with 70 of 154 files looked the
// same as a finished one, and failed with no network. Counted here from the worker's cache against the
// server's list, remembered for the chip (offline-ui.js) and sent to the server log as "offline-ready".
const READY = "pdfreview.ready";      // {have, total, active, at}: viewer files kept here, of the server's list
export const readiness = () => load(READY, null);
export const isReady = (r = readiness()) => !!(r && r.active && r.total > 0 && r.have >= r.total);
async function checkReady() {
  const was = readiness();
  if (isReady(was) && Date.now() - was.at < 5 * 60 * 1000) return;
  try {
    const r = await fetch(`${BASE}/api/offline-manifest`, { cache: "no-store" });
    if (!r.ok) return;
    const files = (await r.json()).files || [];
    const shell = await caches.open("pdfreview-shell-v1");
    const where = (f) => new URL(BASE + f, location.origin).pathname;
    let kept = new Set((await shell.keys()).map((k) => new URL(k.url).pathname));
    // 2026-11-12: a file the worker's install missed (one failed fetch on a bad link) was never asked for
    // again, so the reader stayed "not ready" for good: the phone sat at 153 of 155 for a day. The page
    // fetches what is missing itself and puts it where the worker looks.
    const missing = files.filter((f) => !kept.has(where(f)));
    if (missing.length && missing.length <= 40) {
      for (const f of missing) {
        try {
          const got = await fetch(BASE + f, { cache: "no-store", signal: limit(SLOW) });
          if (got.ok) await shell.put(BASE + f, got);
        } catch (err) {
          console.error("[offline] fetching a missing viewer file failed", f, err);
        }
      }
      log("offline-repair", { missing: missing.slice(0, 6), count: missing.length });
      kept = new Set((await shell.keys()).map((k) => new URL(k.url).pathname));
    }
    const have = files.filter((f) => kept.has(where(f))).length;
    const active = !!(await navigator.serviceWorker.getRegistration(`${BASE}/`))?.active;
    store(READY, { have, total: files.length, active, at: Date.now() });
    if (!was || was.have !== have || was.total !== files.length || was.active !== active) {
      log("offline-ready", { have, total: files.length, active, ready: isReady() });
      changed();
    }
  } catch (err) {
    console.error("[offline] counting the kept viewer files failed", err);
  }
}

// Online or not: navigator.onLine says "offline" in flight mode; a cheap HEAD says whether the Pi answers.
async function probe() {
  if (!OFFLINE) return;
  let up = navigator.onLine;
  if (up) {
    try { await fetch(`${BASE}/sw.js`, { method: "HEAD", cache: "no-store" }); }
    catch { up = false; }
  }
  if (up !== state.online) { state.online = up; log("connection", { online: up }); changed(); }
  if (up) { flush(); autoKeep(); checkReady(); }
}
if (OFFLINE) {
  window.addEventListener("online", probe);
  window.addEventListener("offline", () => { state.online = false; changed(); });
  // Every 10 s while something waits to be sent, the Pi is out of reach, or the reader itself is not yet
  // complete on this device (the chip counts its files); once a minute when all is well. It was every
  // 10 s always: 360 requests an hour that only said "still there".
  const again = () => setTimeout(async () => { await probe(); again(); }, state.online && !waiting().count && isReady() ? 60000 : 10000);
  setTimeout(async () => { await probe(); again(); }, 1500);
  setTimeout(helpers, 4000); // so the worker keeps delta.js before the first save needs it
}

/** autoreload.js tells what its waiting request saw, so a lost or regained Pi is noticed at once. */
export function serverSeen(ok) {
  if (OFFLINE && ok !== state.online) probe();
}

export { viewerUrl };
