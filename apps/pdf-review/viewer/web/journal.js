// journal.js (2026-11-15): every mark made on this device is written here first, and stays until the Pi answers with
// a version that holds it. Laptop and phone alike: IndexedDB works on plain http too, where the offline engine
// (offline.js, Cache Storage) cannot run.
//
// Why: a save is a long trip (a 5 MB chapter took 2.5 minutes to upload from the phone), and before this the marks
// were kept on the device only AFTER the Pi refused them. A rebuild that landed during the trip, a page that reloaded,
// an app that was killed, and the marks were nowhere: the Pi never got them, the device had dropped them.
//
// What is kept: pdf.js saves by appending its marks to the file it loaded, so a record holds that file once (the
// "base", per version) and, per page, only what was appended (the "tail", a few kB): base + tail is the marked PDF.
// `since` is the tail the Pi last confirmed from that page, and `own` the version the Pi wrote verbatim from it:
// server.py carries only what changed since (X-Made-Length, X-Since-Length), deletions and edited notes included,
// when the file there moved on meanwhile. A record whose page is gone (reload, killed app) is sent again on the next
// open of the file, and shown on the page until the Pi has it.
const DB = "pdfreview-journal";
const MARKS = "marks", BASES = "bases";

let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(MARKS)) d.createObjectStore(MARKS, { keyPath: "id" }).createIndex("path", "path");
      if (!d.objectStoreNames.contains(BASES)) d.createObjectStore(BASES, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error); };
  });
  return dbp;
}
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const baseId = (path, sig, len) => `${path}|${sig}|${len}`;

/** Write (or replace) one page's record; `base` (the loaded file's bytes) is stored once per version. */
export async function put(rec, base) {
  const d = await db();
  const tx = d.transaction([MARKS, BASES], "readwrite");
  if (base && rec.len0) {
    const bid = baseId(rec.path, rec.baseSig, rec.len0);
    const have = await req(tx.objectStore(BASES).getKey(bid));
    if (have === undefined) tx.objectStore(BASES).put({ id: bid, bytes: base });
  }
  tx.objectStore(MARKS).put(rec);
  await done(tx);
}

/** Change fields of a record that is still there (after a partial confirmation). */
export async function patch(id, fields) {
  const d = await db();
  const tx = d.transaction(MARKS, "readwrite");
  const rec = await req(tx.objectStore(MARKS).get(id));
  if (rec) tx.objectStore(MARKS).put({ ...rec, ...fields });
  await done(tx);
}

export async function records(path) {
  const d = await db();
  const tx = d.transaction(MARKS, "readonly");
  const all = path ? await req(tx.objectStore(MARKS).index("path").getAll(path)) : await req(tx.objectStore(MARKS).getAll());
  return all.sort((a, b) => a.at - b.at);
}

export async function base(rec) {
  if (!rec.len0) return new Uint8Array(0);
  const d = await db();
  const b = await req(d.transaction(BASES, "readonly").objectStore(BASES).get(baseId(rec.path, rec.baseSig, rec.len0)));
  return b ? b.bytes : null;
}

/** Remove a record once the Pi holds its marks; a base no other record needs goes with it. Only when the record
 *  is still the one confirmed (seq): a newer snapshot written meanwhile stays. */
export async function remove(id, seq = Infinity) {
  const d = await db();
  const tx = d.transaction([MARKS, BASES], "readwrite");
  const marks = tx.objectStore(MARKS);
  const rec = await req(marks.get(id));
  if (rec && rec.seq <= seq) {
    marks.delete(id);
    const others = (await req(marks.index("path").getAll(rec.path))).filter((r) => r.id !== id && baseId(r.path, r.baseSig, r.len0) === baseId(rec.path, rec.baseSig, rec.len0));
    if (!others.length) tx.objectStore(BASES).delete(baseId(rec.path, rec.baseSig, rec.len0));
  }
  await done(tx);
  return !!rec && rec.seq <= seq;
}

export function isPrefix(head, bytes) {
  if (!head || head.length > bytes.length) return false;
  for (let i = 0; i < head.length; i++) if (head[i] !== bytes[i]) return false;
  return true;
}

export const available = typeof indexedDB !== "undefined";
