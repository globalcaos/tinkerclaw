// Offline reading and editing (2026-11-10, for the flight): as a phone, on a throwaway three-chapter book.
//   P5 keep the folder (3 of 3) · P1 open a fetched-ahead chapter in flight mode · P2 a comment made offline
//   survives killing the page and reaches the server's PDF when back online · P3 a paragraph edit made offline
//   waits, can be changed, and is applied on the Pi online · Apply comments pressed offline is sent once ·
//   a chapter rebuilt on the Pi meanwhile keeps the comment made offline (carried) · P4 online, a kept chapter
//   opens from the phone and is fetched again only after it changed.
// Needs a second server (never the live one): from the worktree,
//   PDF_REVIEW_PORT=18831 PDF_REVIEW_OPEN_ROOTS=/tmp/jarvis/pdf-offline-test .venv/bin/python server.py
// then PW_CHROMIUM=/usr/bin/chromium PDF_REVIEW_PORT=18831 node test/offline.mjs
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, utimesSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const PORT = process.env.PDF_REVIEW_PORT || 18831;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = "/tmp/jarvis/pdf-offline-test/book";
const LOG = "/tmp/jarvis/pdf-offline-test/server.log";
mkdirSync(DIR, { recursive: true });

const para2 = (n) => `The second paragraph of chapter ${n} is the one the test edits, and it is long enough to find again.`;
function build(n, title = `Chapter ${n}`) {
  const md = `${DIR}/ch0${n}.md`, pdf = `${DIR}/ch0${n}.pdf`;
  writeFileSync(md, `# ${title}\n\nThe first paragraph of chapter ${n} fills the page with some words to select.\n\n${para2(n)}\n`);
  execFileSync("python3", [`${ROOT}md2pdf.py`, md, pdf], { stdio: "ignore" });
  const t = statSync(pdf).mtimeMs / 1000 - 30; // the source stays older: no watcher rebuild
  utimesSync(md, t, t);
}
for (const n of [1, 2, 3]) build(n);
const post = async (p, body) => (await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const served = {};
for (const n of [1, 2, 3]) served[n] = (await post("/api/open", { path: `${DIR}/ch0${n}.pdf` })).path;
await post(`/api/origin?path=${encodeURIComponent(served[2])}`, { session: "agent:main:pdf-offline-test" });
const url = (n) => `${BASE}/viewer/web/viewer.html?file=${encodeURIComponent(served[n])}`;
const comments = (n) => execFileSync(`${ROOT}.venv/bin/python`, [`${ROOT}pdf-comments.py`, `${DIR}/ch0${n}.pdf`], { encoding: "utf8" });
const text = (n) => execFileSync("pdftotext", [`${DIR}/ch0${n}.pdf`, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
const gets = (n) => readFileSync(LOG, "utf8").split("\n").filter((l) => l.includes(`"GET ${served[n]}`)).length;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 411, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => localStorage.setItem("pdfreview.offline", "1"));
let redoCalls = 0, offline = false;
// The real /api/redo would wake a chat. The stand-in answers only "online", as the network would.
await ctx.route("**/api/redo**", (route) => { if (offline) return route.abort("internetdisconnected"); redoCalls++; route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }); });
const errors = [];
const open = async (n, href = url(n)) => {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${e.message} ${(e.stack || "").split("\n").slice(1, 3).join(" ")}`));
  const fromSw = [];
  page.on("response", (r) => { if (/\.pdf$/.test(new URL(r.url()).pathname) && r.request().method() === "GET") fromSw.push(`${r.fromServiceWorker()} ${r.url().slice(-40)}`); });
  page.on("console", (m) => { if (process.env.DEBUG) console.log(`[${n}] ${m.type()} ${m.text()}`); });
  await page.goto(href);
  await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && document.querySelector(".textLayer span"), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  page.fromSw = fromSw;
  return page;
};
const ls = (page, k) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), k);
const pageText = (page) => page.evaluate(() => [...document.querySelectorAll(".textLayer span")].map((s) => s.textContent).join(" "));
const until = async (fn, ms, step = 500) => { for (let t = 0; t < ms; t += step) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); } return false; };
async function comment(page, note) {
  await page.tap("#selectTool");
  const span = await page.evaluateHandle(() => {
    const all = [...document.querySelectorAll(".textLayer span")];
    return all.find((s) => /first/.test(s.textContent)) || all.find((s) => s.textContent.trim().length > 3 && s.getBoundingClientRect().top > 80);
  });
  const box = await span.asElement().boundingBox();
  await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
  await page.waitForSelector("#selBar:not([hidden])", { timeout: 5000 });
  await page.tap("#selComment");
  await page.waitForSelector("#commentManagerDialog[open]", { timeout: 5000 });
  await page.type("#commentManagerTextInput", note);
  await page.click("#commentManagerSaveButton");
}
const hasNote = (page, note) => page.evaluate(async (note) => {
  if (!window.PDFViewerApplication.pdfDocument) return false; // between two documents
  const p = await window.PDFViewerApplication.pdfDocument.getPage(1);
  return (await p.getAnnotations()).some((a) => JSON.stringify(a).includes(note));
}, note);
const r = {};
const logStart = readFileSync(LOG, "utf8").length;

// --- online: the service worker takes the page, the open chapter is kept, then the whole folder (P5)
let page = await open(1);
r.controlled = await until(() => page.evaluate(() => !!navigator.serviceWorker.controller), 60000);
r.keptOnOpen = await until(async () => !!(await ls(page, "pdfreview.kept"))?.[served[1]], 15000);
// 2026-11-10: the chip says when the reader's own files are all on the device (it failed in flight at 70 of 154, unseen)
r.readySign = await until(async () => /ready for offline/.test(await page.textContent("#syncState")), 60000);
// P8 (2026-11-12): two viewer files are gone from the copy (as after a failed fetch during the install): the
// page fetches them again by itself and the reader is ready once more.
const lost = await page.evaluate(async () => {
  const shell = await caches.open("pdfreview-shell-v1");
  const keys = (await shell.keys()).filter((k) => /\/images\/.*\.svg$/.test(k.url)).slice(0, 2);
  for (const k of keys) await shell.delete(k);
  localStorage.removeItem("pdfreview.ready");
  return keys.map((k) => k.url);
});
r.p8Repaired = lost.length === 2 && await until(() => page.evaluate(async (lost) => {
  const shell = await caches.open("pdfreview-shell-v1");
  const back = (await Promise.all(lost.map((u) => shell.match(u)))).every(Boolean);
  return back && /ready for offline/.test(document.getElementById("syncState").textContent);
}, lost), 40000);
await page.click("#syncState");
await page.click('#syncDialog button[data-a="folder"]');
r.folder = await until(async () => /3 of 3 kept on this phone/.test(await page.textContent("#syncDialog .syncFolder")), 60000)
  ? "3 of 3 kept on this phone" : await page.textContent("#syncDialog .syncFolder");
await page.close({ runBeforeUnload: false });

// --- flight mode: open a chapter only fetched ahead (P1), comment on it, kill the page, reopen (P2)
await ctx.setOffline(true);
offline = true;
page = await open(2);
r.p1Opened = /chapter 2/i.test(await pageText(page));
r.p1FromPhone = page.fromSw.length > 0 && page.fromSw.every((x) => x.startsWith("true"));
r.chipOffline = /Offline/.test(await page.textContent("#syncState"));
const NOTE2 = "offline note on chapter two";
await comment(page, NOTE2);
// 2026-11-15: marks wait in the journal (journal.js), not in pdfreview.pending
r.p2KeptPending = await until(async () => (await page.evaluate(() => window.__pdfJournal.waiting())) > 0, 15000);
await page.close({ runBeforeUnload: false });
page = await open(2);
r.p2AfterKill = await until(() => hasNote(page, NOTE2), 20000); // the reopened page shows the kept marks
await page.waitForTimeout(2000);

// --- P3: write in the second paragraph offline (✏️ Write, writer.js), kill, reopen, change it from the list
await page.waitForSelector("#editSource:not([hidden])", { timeout: 10000 });
await page.click("#editSource");
await page.waitForFunction(() => document.body.classList.contains("writeMode"), null, { timeout: 10000 });
await page.waitForTimeout(1500); // the page's text is read and the kept source loaded
const at = await page.evaluate(() => {
  for (const sp of document.querySelectorAll("#viewer .textLayer span")) {
    if (!/second/.test(sp.textContent)) continue;
    const b = sp.getBoundingClientRect();
    if (b.width) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  return null;
});
await page.mouse.click(at.x, at.y);
await page.waitForSelector(".wrEd.wrOpen", { timeout: 10000 });
r.p3Found = (await page.evaluate(() => document.querySelector(".wrEd.wrOpen").innerText)).replace(/\s+/g, " ").trim() === para2(2);
await page.evaluate(() => { const el = document.querySelector(".wrEd.wrOpen"); const g = document.createRange(); g.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(g); });
await page.keyboard.type("First offline edit of the second paragraph.");
await page.keyboard.press("Escape");
r.p3Queued = await until(async () => (await ls(page, "pdfreview.paraq"))?.length === 1, 10000);
await page.close({ runBeforeUnload: false });
page = await open(2);
r.chipWaiting = await page.textContent("#syncState");
await page.click("#syncState");
await page.click('#syncDialog button[data-a="change"]');
await page.waitForSelector(".epWrap .epText", { timeout: 5000 });
r.p3Reopened = (await page.inputValue(".epText")) === "First offline edit of the second paragraph.";
const NEW2 = "The second paragraph, rewritten on the plane and changed once more.";
await page.fill(".epText", NEW2);
await page.click(".epWrap .save");
const q = await ls(page, "pdfreview.paraq");
r.p3Changed = q?.length === 1 && q[0].new === NEW2 && q[0].old.trim() === para2(2);
// Apply comments pressed offline waits
await page.waitForSelector("#redoDocument:not([hidden])", { timeout: 5000 });
await page.click("#redoDocument");
r.redoQueued = await until(async () => !!(await ls(page, "pdfreview.redo"))?.[served[2]], 10000);
await page.close({ runBeforeUnload: false });

// --- chapter 3: commented offline while the Pi rebuilds it (carry)
page = await open(3);
const NOTE3 = "offline note on chapter three";
await comment(page, NOTE3);
await until(async () => (await page.evaluate(() => window.__pdfJournal.waiting())) > 0, 15000);
await page.close({ runBeforeUnload: false });
build(3, "Chapter 3 rebuilt on the Pi");

// --- the shell the app opens with no door
page = await ctx.newPage();
await page.goto(`${BASE}/viewer/web/offline.html`);
const frame = await (await page.waitForSelector("#reader")).contentFrame();
r.shellOpens = await until(() => frame.evaluate(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0).catch(() => false), 30000);

// --- back online: everything goes, in order, and nothing is left waiting
await ctx.setOffline(false);
offline = false;
r.synced = await until(async () => {
  const w = await frame.evaluate(async () => [await window.__pdfJournal?.all(), ...["pdfreview.paraq", "pdfreview.redo"].map((k) => localStorage.getItem(k))]);
  return w[0] === 0 && (w[1] ?? "[]") === "[]" && (w[2] ?? "{}") === "{}";
}, 120000, 1000);
await page.close({ runBeforeUnload: false });
await new Promise((r) => setTimeout(r, 3000));
r.serverNote2 = comments(2).includes(NOTE2);
r.serverSource2 = readFileSync(`${DIR}/ch02.md`, "utf8").includes(NEW2);
r.serverPdf2 = text(2).includes("rewritten on the plane");
r.redoSentOnce = redoCalls === 1;
r.carriedNote3 = comments(3).includes(NOTE3);
r.keptRebuild3 = text(3).includes("rebuilt on the Pi");

// --- P4: online, a kept chapter opens from the phone; fetched again only once it changed
const before = gets(1);
page = await open(1);
r.p4Responses = page.fromSw.slice();
r.p4FromPhone = page.fromSw.length > 0 && page.fromSw.every((x) => x.startsWith("true"));
await page.waitForTimeout(5000);
r.p4NoDownload = gets(1) === before;
build(1, "Chapter 1 version two");
r.p4Refetched = await until(async () => /version two/.test(await pageText(page)), 30000);
r.p4OneDownload = gets(1) === before + 1;

// --- P6 (2026-11-11): a kept chapter that changed is rebuilt on the phone from its copy plus the changed
// parts (/api/delta); the whole file does not travel again. Several pages, like a real chapter: one page
// changes, the rest and the fonts stay the same bytes.
const big = (edit) => "# Chapter 4\n\n" + Array.from({ length: 260 }, (_, i) =>
  `Paragraph ${i + 1} tells of ${edit && i === 3 ? "the weather, the road" : "the road, the weather"} and the people on it, with enough words for a line.`).join("\n\n") + "\n";
const BIG = "/tmp/jarvis/pdf-offline-test/big"; // its own folder: the book above must stay three chapters
mkdirSync(BIG, { recursive: true });
const buildBig = (edit) => {
  writeFileSync(`${BIG}/ch04.md`, big(edit));
  execFileSync("python3", [`${ROOT}md2pdf.py`, `${BIG}/ch04.md`, `${BIG}/ch04.pdf`], { stdio: "ignore" });
  const t = statSync(`${BIG}/ch04.pdf`).mtimeMs / 1000 - 30;
  utimesSync(`${BIG}/ch04.md`, t, t);
};
buildBig(false);
served[4] = (await post("/api/open", { path: `${BIG}/ch04.pdf` })).path;
page = await open(4);
r.p6Kept = await until(() => page.evaluate((p) => !!JSON.parse(localStorage.getItem("pdfreview.kept") || "{}")[p], served[4]), 20000);
await page.waitForTimeout(1500);
const wholeBefore = gets(4);
buildBig(true);
r.p6Reloaded = await until(async () => /the weather, the road/.test(await pageText(page)), 40000);
const travelled = readFileSync(LOG, "utf8").match(/delta for ch04\.pdf: (\d+) of (\d+) bytes travel/);
r.p6Delta = !!travelled && Number(travelled[1]) < Number(travelled[2]) / 2;
r.p6Travelled = travelled ? `${travelled[1]} of ${travelled[2]} bytes` : "no delta";
r.p6NoWholeDownload = gets(4) === wholeBefore;

// --- P7 (2026-11-11): the viewer no longer polls. Someone asks for the open viewer's marks (pdf-marks.py
// does this): the waiting request passes it on and the viewer hands them over. The only /api/marks/want in
// the whole run is this one, and the 2 s polling is gone.
await fetch(`${BASE}/api/marks/want?path=${encodeURIComponent(served[4])}`);
r.p7MarksHanded = await until(async () => (await fetch(`${BASE}/api/marks?path=${encodeURIComponent(served[4])}`)).status === 200, 8000);
const runLog = readFileSync(LOG, "utf8").slice(logStart).split("\n"); // this run only: the log is shared
r.p7NoPolling = runLog.filter((l) => l.includes("GET /api/marks/want")).length === 1 && runLog.some((l) => l.includes("GET /api/watch"));
await browser.close();

console.log(r);
if (errors.length) console.log("page errors:", errors);
const ok = Object.entries(r).every(([k, v]) => k === "chipWaiting" || k === "folder" || k === "p4Responses" || k === "p6Travelled" ? true : v === true)
  && r.folder === "3 of 3 kept on this phone" && /Offline · 2 waiting/.test(r.chipWaiting);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
