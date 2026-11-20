// Book tabs (2026-11-19, need: every PDF of the books at hand, opened or not, one tab per kind of file, the book
// files by name): beside 🕘 Recent the dialog has a tab per kind of book file from GET /api/books (chapters, notes,
// marked copies, earlier builds, backups), each sorted by name with numbers by value. A throwaway book folder on a
// server this test starts itself (contract-lib.mjs), never his books.
//   MODE=desktop node test/book-tabs.mjs   ·   MODE=phone node test/book-tabs.mjs   (Pi: PW_CHROMIUM=/usr/bin/chromium)
// SHOTS=<folder>: where tabs-<mode>.png goes (default: the test's own folder).
// Checks: the kinds and the order (ch2 before ch10, a file before its copies, the newest backup first), dot folders
// and other files left out, nothing linked by listing; the tabs and their counts; a tap on a file never opened links
// and opens it; the dialog reopens on the tab used last, that file current, linked and blue while it has new text;
// with no book list (none set up, no answer) the dialog is the Recent list alone; offline the phone keeps the tabs.
import { mkdirSync, writeFileSync, copyFileSync, statSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { testServer, makeDoc, launch, context, open, check, until, wait, finish, PHONE, MODE, PARAS, ROOT } from "./contract-lib.mjs";

const srv = testServer("book-tabs", 18874 + (PHONE ? 100 : 0));
const BOOKS = `${srv.dir}/books`;
process.env.PDF_REVIEW_BOOKS = BOOKS; // the test server's own book folder
const A = makeDoc(srv, "reading"); // the page the viewer starts on: not a book file

const put = (dir, names) => {
  mkdirSync(`${BOOKS}/${dir}`, { recursive: true });
  for (const n of names) copyFileSync(A.pdf, `${BOOKS}/${dir}/${n}`);
};
put("book1/chapters", ["ch10.pdf", "ch1.pdf", "ch1-before-edit.pdf", "ch1-marques-oscar-10.pdf", "ch1-marques-oscar-2.pdf"]);
put("", ["Plot.pdf", "AI notes.pdf", "Plot-marques-oscar-1.pdf"]);
put("book1/backup-2026-11-17-r21/chapters", ["ch1.pdf"]);
put("book1/backup-2026-11-19-r22/chapters", ["ch1.pdf"]);
put("book1/.approved", ["ch1.pdf"]);
writeFileSync(`${BOOKS}/book1/chapters/notes.txt`, "not a PDF");
// ch2 is built from its own .md with one paragraph of new text: blue in the list once it is linked.
const ch2md = `${BOOKS}/book1/chapters/ch2.md`, ch2 = `${BOOKS}/book1/chapters/ch2.pdf`;
writeFileSync(ch2md, `# ch2\n\n${PARAS[0]}\n\n<div class="nw" markdown="1">\n\nA new paragraph written this round, still blue until it is approved.\n\n</div>\n\n${PARAS[2]}\n`);
const env = { ...process.env };
delete env.TC_SESSION_KEY; // a test PDF is never linked to a chat
execFileSync("python3", [`${ROOT}md2pdf.py`, ch2md, ch2], { stdio: "ignore", env });
const t = statSync(ch2).mtimeMs / 1000 - 30; // the source older than the PDF: no watcher rebuild
utimesSync(ch2md, t, t);
await srv.start();

const api = async (p) => (await fetch(srv.base + p)).json();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let books = (await api("/api/books")).files;
const names = (kind) => books.filter((f) => f.kind === kind).map((f) => f.name);
check(same(names("chapters"), ["ch1.pdf", "ch2.pdf", "ch10.pdf"]), "chapters by name, numbers by value", names("chapters").join(", "));
check(same(names("notes"), ["AI notes.pdf", "Plot.pdf"]), "the book's other documents by name, any case", names("notes").join(", "));
check(same(names("marked"), ["ch1-marques-oscar-2.pdf", "ch1-marques-oscar-10.pdf", "Plot-marques-oscar-1.pdf"]),
  "marked copies by name, numbers by value", names("marked").join(", "));
check(same(names("earlier"), ["ch1-before-edit.pdf"]), "the build before an edit has its own kind", names("earlier").join(", "));
const backups = books.filter((f) => f.kind === "backups").map((f) => f.dir);
check(backups.length === 2 && /r22/.test(backups[0]) && /r21/.test(backups[1]), "a name in two backups: the newest backup first", backups.join(" | "));
check(!books.some((f) => f.dir.includes(".approved") || !f.name.endsWith(".pdf")), "dot folders and other files are left out",
  books.map((f) => `${f.dir}/${f.name}`).join(", "));
check(books.find((f) => f.name === "ch1.pdf" && f.kind === "chapters")?.dir === "books/book1/chapters",
  "each file names its folder from the book folder down");
check(books.every((f) => f.path === null), "listing links nothing", books.filter((f) => f.path).map((f) => f.name).join(", "));
check(!(await api("/api/history")).files.some((f) => f.dir.startsWith(BOOKS)), "...so the Recent list does not change");

const browser = await launch();
const ctx = await context(browser);
const errors = [];
const page = await open(ctx, A.url, errors);
const tap = async (sel) => { if (PHONE) await page.tap(sel, { timeout: 5000 }); else await page.click(sel, { timeout: 5000 }); };

async function dialog() {
  await page.evaluate(() => document.getElementById("recentDialog")?.close());
  try { await tap("#recentFiles"); } catch { await page.evaluate(() => document.getElementById("recentFiles").click()); }
  await page.waitForSelector("#recentDialog[open]", { timeout: 10000 });
  await until(() => page.evaluate(() => !/Loading/.test(document.querySelector("#recentDialog .recentList").textContent)), 15000, 200);
}
const tabs = () => page.evaluate(() => [...document.querySelectorAll("#recentDialog .recentTab")]
  .map((b) => `${b.dataset.tab}:${b.querySelector(".n").textContent}${b.classList.contains("on") ? "*" : ""}`).join(" "));
const tabsShown = () => page.evaluate(() => !document.querySelector("#recentDialog .recentTabs").hidden);
const title = () => page.textContent("#recentDialog .recentHead b");
const rows = () => page.evaluate(() => [...document.querySelectorAll("#recentDialog .recentRow")].map((r) => ({
  name: r.querySelector(".recentName").textContent, meta: r.querySelector(".recentMeta").textContent, current: r.classList.contains("current"),
  blue: r.querySelector(".recentName").classList.contains("toApprove"), linked: r.getAttribute("href") !== "#" })));

// The tabs: Recent first and chosen, then one per kind there is, each with its count.
await dialog();
await until(async () => (await tabs()).includes("chapters"), 10000, 200);
check(await tabsShown(), "the dialog shows tabs when there is a book folder");
check((await tabs()) === "recent:1* chapters:3 notes:2 marked:3 earlier:1 backups:2", "Recent, then one tab per kind, with counts", await tabs());
check((await title()) === "PDFs", "...under the title PDFs", await title());

// Chapters: by name, each row its folder and when it changed; none opened yet, so none linked.
await tap('#recentDialog .recentTab[data-tab="chapters"]');
let r = await rows();
check(same(r.map((x) => x.name), ["ch1.pdf", "ch2.pdf", "ch10.pdf"]), "the Chapters tab lists the chapters by name", r.map((x) => x.name).join(", "));
check(r.every((x) => /^books\/book1\/chapters · changed /.test(x.meta)), "...each with its folder and when it changed", r[0]?.meta);
check(r.every((x) => !x.linked), "...none linked yet", JSON.stringify(r.map((x) => x.linked)));

// A tap on a file never opened: linked through /api/open, then opened.
await tap("#recentDialog .recentRow:nth-child(2)");
await page.waitForURL(/ch2\.pdf/, { timeout: 20000 });
await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0, null, { timeout: 60000 });
await wait(2500); // the viewer has told the Pi it opened the file
books = (await api("/api/books")).files;
check(!!books.find((f) => f.name === "ch2.pdf")?.path, "a tap on a file never opened links it and opens it", page.url().slice(-60));
check((await api("/api/history")).files.some((f) => f.name === "ch2.pdf"), "...and it joins the Recent list");

// The dialog comes back on the tab used last, the open file current, linked, blue while it holds new text.
await dialog();
await until(async () => (await tabs()).includes("chapters:3*"), 10000, 200);
check((await tabs()).includes("chapters:3*"), "the dialog reopens on the tab used last", await tabs());
await until(async () => (await rows()).find((x) => x.name === "ch2.pdf")?.blue, 15000, 250);
const c2 = (await rows()).find((x) => x.name === "ch2.pdf");
check(c2?.current && c2?.linked, "the open chapter is marked current and linked", JSON.stringify(c2));
check(c2?.blue, "a chapter with new text to approve shows blue in its tab", JSON.stringify(c2));
await page.screenshot({ path: `${process.env.SHOTS || srv.dir}/tabs-${MODE}.png` });

// Back to Recent: the opened chapter is there; the next dialog opens on Recent.
await tap('#recentDialog .recentTab[data-tab="recent"]');
check((await rows()).some((x) => x.name === "ch2.pdf"), "the Recent tab lists what was opened", (await rows()).map((x) => x.name).join(", "));
await dialog();
check(/^recent:\d+\*/.test(await tabs()), "...and the dialog then reopens on Recent", await tabs());

if (PHONE) {
  // No connection: the phone keeps the last book list, so the tabs stay.
  await until(() => page.evaluate(() => !!navigator.serviceWorker?.controller), 30000);
  await dialog(); // online once under the service worker, so it keeps this answer
  await ctx.setOffline(true);
  await dialog();
  await until(async () => (await tabs()).includes("chapters"), 10000, 200);
  check((await tabs()).includes("chapters:3"), "offline, the phone keeps the book tabs", await tabs());
  await ctx.setOffline(false);
} else {
  // No book list (none set up, a server older than /api/books, no answer): Recent alone, as before, never an error.
  await page.evaluate(() => localStorage.setItem("pdfreview.recentTab", "chapters"));
  await page.route(/\/api\/books/, (q) => q.fulfill({ status: 200, contentType: "application/json", body: '{"files":[]}' }));
  await dialog();
  await wait(500);
  check(!(await tabsShown()) && (await title()) === "Recent PDFs", "with no book files the dialog is the Recent list alone", `${await tabs()} | ${await title()}`);
  check((await rows()).some((x) => x.name === "ch2.pdf"), "...a remembered book tab falls back to Recent");
  await page.unroute(/\/api\/books/);
  await page.route(/\/api\/books/, (q) => q.abort("failed"));
  await dialog();
  await wait(500);
  const txt = await page.textContent("#recentDialog .recentList");
  check(!(await tabsShown()) && !/could not be loaded/.test(txt) && (await rows()).length > 0, "a book list that fails leaves Recent drawn, no error", txt.slice(0, 80));
  await page.unroute(/\/api\/books/);
}

check(!errors.length, "no page errors", errors.join(" | "));
await browser.close();
await srv.stop();
finish();
