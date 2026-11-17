// Less data on the wire (2026-11-11), checked against a real server with no browser:
//   D1 a changed PDF is rebuilt from the old copy + /api/delta's answer, byte for byte, and most of it is reused
//   D2 the same file against itself reuses everything (the cut rule in delta.js equals server.py's)
//   S1 a save that sends only the appended part writes the same file a whole save would
//   S2 a part that does not fit is refused (422) and nothing is written; a rebuilt file answers 409
//   W1 /api/watch waits while nothing changes, answers at once on a change, and passes on a request for marks
//   Z1 the viewer's files travel compressed and still answer 304
//   F1 the folder list carries each file's version, equal to what a HEAD says
//   L1 a batch of client log events is accepted
// Needs a second server (never the live one): from the worktree,
//   PDF_REVIEW_PORT=18832 PDF_REVIEW_OPEN_ROOTS=/tmp/jarvis/pdf-delta-test .venv/bin/python server.py
// then PDF_REVIEW_PORT=18832 node test/delta.mjs
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { crc32, adler32, chunkTable, applyDelta } from "../viewer/web/delta.js";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = process.env.PDF_REVIEW_PORT || 18832;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = "/tmp/jarvis/pdf-delta-test/book";
mkdirSync(DIR, { recursive: true });

let failed = 0;
const ok = (name, cond, note = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${note ? "  " + note : ""}`); if (!cond) failed++; };
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// Several pages, and an edit that moves no line: like a real chapter, where one page changes and the rest
// (other pages, fonts, pictures) stays the same bytes.
const line = (i, edit) => `Paragraph ${i + 1} of the chapter says something plain about ${edit ? "the weather, the road" : "the road, the weather"} and the people on it, so the page has text.`;
const paras = (edit) => Array.from({ length: 260 }, (_, i) => line(i, edit && i === 17)).join("\n\n");
const build = (name, edit) => {
  writeFileSync(`${DIR}/${name}.md`, `# The chapter\n\n${paras(edit)}\n`);
  execFileSync("python3", [`${ROOT}md2pdf.py`, `${DIR}/${name}.md`, `${DIR}/${name}.pdf`], { stdio: "ignore" });
};
build("old", false);
build("new", true);
copyFileSync(`${DIR}/new.pdf`, `${DIR}/save.pdf`);

const post = async (p, body) => (await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const open = async (name) => (await post("/api/open", { path: `${DIR}/${name}.pdf` })).path;
const enc = encodeURIComponent;
const delta = async (served, oldBytes) => {
  const table = chunkTable(oldBytes);
  const r = await fetch(`${BASE}/api/delta?path=${enc(served)}`, { method: "POST", body: new Uint8Array(table.buffer) });
  return { r, table, answer: new Uint8Array(await r.arrayBuffer()) };
};

// crc32 and adler32 equal zlib's
const probe = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
ok("crc32 and adler32 are zlib's", crc32(probe) === 0x414fa339 && adler32(probe) === 0x5bdc0fda);

// D1, D2
const oldBytes = new Uint8Array(readFileSync(`${DIR}/old.pdf`)), newBytes = new Uint8Array(readFileSync(`${DIR}/new.pdf`));
const servedNew = await open("new");
{
  const { r, table, answer } = await delta(servedNew, oldBytes);
  const { bytes, copied } = applyDelta(oldBytes, answer);
  ok("D1 the changed file is rebuilt byte for byte", r.ok && same(bytes, newBytes));
  ok("D1 most of it comes from the old copy", copied / newBytes.length > 0.5, `${(100 * copied / newBytes.length).toFixed(1)} % reused; ${table.byteLength} B sent, ${answer.length} B answered, file ${newBytes.length} B`);
  ok("D1 the answer names the new version", (r.headers.get("X-Sig") || "").endsWith(`|${newBytes.length}`));
  const self = await delta(servedNew, newBytes);
  const again = applyDelta(newBytes, self.answer);
  ok("D2 a file against itself reuses everything", same(again.bytes, newBytes) && again.copied === newBytes.length && self.answer.length < 64, `${self.answer.length} B answered`);
  // A copy here that differs inside a range the answer reuses: the rebuilt file fails its check.
  const dv = new DataView(answer.buffer, answer.byteOffset);
  let at = -1;
  for (let k = 0, p = 16; k < dv.getUint32(12, true) && at < 0; k++) {
    if (answer[p] === 0) at = dv.getUint32(p + 1, true) + (dv.getUint32(p + 5, true) >> 1);
    else p += 5 + dv.getUint32(p + 1, true);
  }
  const wrong = oldBytes.slice();
  wrong[at] ^= 0xff;
  let threw = false;
  try { applyDelta(wrong, answer); } catch { threw = true; }
  ok("D1 a wrong old copy is refused, not kept", at >= 0 && threw);
}

// S1, S2
const servedSave = await open("save");
const head = async (served) => { const r = await fetch(BASE + served, { method: "HEAD" }); return `${r.headers.get("Last-Modified")}|${r.headers.get("Content-Length")}`; };
{
  const loaded = new Uint8Array(readFileSync(`${DIR}/save.pdf`));
  const withTail = (text) => { const t = new TextEncoder().encode(text); const d = new Uint8Array(loaded.length + t.length); d.set(loaded); d.set(t, loaded.length); return d; };
  const put = (data, keep, extra = "", crc = crc32(data)) => fetch(`${BASE}/api/save?path=${enc(servedSave)}${extra}&keep=${keep}&len=${data.length}&crc=${crc.toString(16)}`, { method: "PUT", body: data.subarray(keep) });
  const one = withTail("\n1 0 obj\n<< /Note (first) >>\nendobj\n%%EOF\n");
  let r = await put(one, loaded.length);
  ok("S1 the appended part alone writes the whole file", r.ok && same(readFileSync(`${DIR}/save.pdf`), one), `${one.length - loaded.length} B travelled for ${one.length} B`);
  const two = withTail("\n1 0 obj\n<< /Note (first, then more of it) >>\nendobj\n2 0 obj\n<< >>\nendobj\n%%EOF\n");
  r = await put(two, loaded.length);
  ok("S1 a second save still counts from the loaded file", r.ok && same(readFileSync(`${DIR}/save.pdf`), two));
  r = await put(withTail("\n%other\n"), loaded.length, "", 12345);
  ok("S2 a part that does not fit is refused", r.status === 422 && same(readFileSync(`${DIR}/save.pdf`), two));
  r = await fetch(`${BASE}/api/save?path=${enc(servedSave)}&keep=${two.length + 50}&len=${two.length + 50}&crc=${crc32(two).toString(16)}`, { method: "PUT", body: new Uint8Array(0) });
  ok("S2 a keep longer than the file here is refused", r.status === 422 && same(readFileSync(`${DIR}/save.pdf`), two));
  r = await put(two, loaded.length, `&base=${enc("Mon, 01 Jan 2001 00:00:00 GMT|1")}`);
  ok("S2 a file that moved on answers 409", r.status === 409 && same(readFileSync(`${DIR}/save.pdf`), two));
  r = await fetch(`${BASE}/api/save?path=${enc(servedSave)}`, { method: "PUT", body: loaded });
  ok("S1 a whole save still works", r.ok && same(readFileSync(`${DIR}/save.pdf`), loaded));
}

// W1
{
  const sig = await head(servedSave);
  let t = Date.now();
  let j = await (await fetch(`${BASE}/api/watch?path=${enc(servedSave)}&sig=${enc(sig)}&wait=2`)).json();
  ok("W1 nothing changed: it waits, then says so", !j.changed && !j.want && Date.now() - t >= 1800, `${Date.now() - t} ms`);
  t = Date.now();
  j = await (await fetch(`${BASE}/api/watch?path=${enc(servedSave)}&sig=${enc("x|1")}&wait=20`)).json();
  ok("W1 another version: answered at once, with the version", j.changed && j.sig === sig && Date.now() - t < 1500);
  t = Date.now();
  const waiting = fetch(`${BASE}/api/watch?path=${enc(servedSave)}&sig=${enc(sig)}&wait=20`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 700));
  await fetch(`${BASE}/api/marks/want?path=${enc(servedSave)}`);
  j = await waiting;
  ok("W1 a request for the marks ends the wait", j.want && !j.changed && Date.now() - t < 3000, `${Date.now() - t} ms`);
  await fetch(`${BASE}/api/marks?path=${enc(servedSave)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pending: 0, marks: [] }) });
  j = await (await fetch(`${BASE}/api/watch?path=${enc(servedSave)}&sig=${enc(sig)}&wait=1`)).json();
  ok("W1 once the marks arrived nobody is asked again", !j.want);
  t = Date.now();
  const changing = fetch(`${BASE}/api/watch?path=${enc(servedSave)}&sig=${enc(sig)}&wait=20`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 1200));
  writeFileSync(`${DIR}/save.pdf`, Buffer.concat([readFileSync(`${DIR}/save.pdf`), Buffer.from("\n%changed\n")]));
  j = await changing;
  ok("W1 a change on disk ends the wait", j.changed && Date.now() - t < 4000, `${Date.now() - t} ms`);
  const r = await fetch(`${BASE}/api/watch?path=${enc("/papers/open/none/none.pdf")}&wait=0`);
  ok("W1 an unknown paper is a 404 that names itself", r.status === 404 && (await r.text()).includes("served paper"));
}

// Z1 (plain http: node's fetch trips over a compressed answer on a connection the server closes)
const get = (path, headers) => new Promise((resolve, reject) => {
  http.get(BASE + path, { headers }, (res) => {
    const parts = [];
    res.on("data", (d) => parts.push(d));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  }).on("error", reject);
});
{
  const size = statSync(`${ROOT}viewer/build/pdf.mjs`).size;
  let r = await get("/viewer/build/pdf.mjs", { "Accept-Encoding": "gzip" });
  ok("Z1 a viewer file travels compressed", r.headers["content-encoding"] === "gzip" && gunzipSync(r.body).length === size && Number(r.headers["content-length"]) === r.body.length, `${r.body.length} B on the wire for ${size} B`);
  r = await get("/viewer/build/pdf.mjs", { "Accept-Encoding": "gzip", "If-Modified-Since": r.headers["last-modified"] });
  ok("Z1 and still answers 304", r.status === 304);
  r = await get("/viewer/build/pdf.mjs", {});
  ok("Z1 a caller that cannot unpack gets it plain", !r.headers["content-encoding"] && r.body.length === size);
  r = await get(servedNew, { "Accept-Encoding": "gzip" });
  ok("Z1 a PDF is never compressed", !r.headers["content-encoding"] && r.body.length === newBytes.length);
  r = await get(`/api/folder?path=${enc(servedNew)}`, { "Accept-Encoding": "gzip" });
  ok("Z1 a small answer stays plain", r.status === 200 && (r.body.length > 1400 ? r.headers["content-encoding"] === "gzip" : !r.headers["content-encoding"]));
}

// F1
{
  const j = await (await fetch(`${BASE}/api/folder?path=${enc(servedNew)}`)).json();
  const f = j.files.find((x) => x.name === "new.pdf");
  ok("F1 the folder list carries the version a HEAD says", f && f.sig === await head(f.path), f?.sig);
}

// L1
{
  const r = await fetch(`${BASE}/api/clientlog`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ id: "test", event: "delta-test-a" }, { id: "test", event: "delta-test-b" }]) });
  ok("L1 a batch of log events is accepted", r.status === 204);
}

console.log(failed ? `${failed} FAILED` : "PASS");
process.exit(failed ? 1 : 0);
