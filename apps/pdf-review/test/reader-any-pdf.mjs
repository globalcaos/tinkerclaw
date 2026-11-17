// Read-aloud on ANY PDF, with a fake 0.3 s voice: scroll during reading, pause+scroll+play, start at a selected word.
// node test/reader-any-pdf.mjs <pdf> [page=5] [word=<a word on that page>]   (server.py on :18820; PW_CHROMIUM or /usr/bin/chromium)
// Needs no fixture: test/reader.mjs needs papers/sample-paper.pdf, which only the laptop has.
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const [pdf, pg = "5", word] = process.argv.slice(2);
if (!pdf) { console.error("usage: node test/reader-any-pdf.mjs <pdf> [page] [word]"); process.exit(2); }
const BASE = "http://127.0.0.1:18820", P = Number(pg);
const where = (await (await fetch(BASE + "/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: pdf }) })).json()).path;
const url = `${BASE}/viewer/web/viewer.html?file=${encodeURIComponent(where.split("/").map(encodeURIComponent).join("/"))}#page=${P}`;
const n = 4800, wav = Buffer.alloc(44 + n * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(n * 2, 40);
let fails = 0; const check = (ok, what, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${d ? " — " + d : ""}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || "/usr/bin/chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.route("**/api/tts", (rt) => rt.fulfill({ status: 200, contentType: "audio/wav", body: wav }));
  await page.route("**/api/bookmark*", (rt) => rt.fulfill({ status: 200, contentType: "application/json", body: "{}" })); // never touch real bookmarks
  await page.goto(url);
  await page.waitForFunction(() => window.PDFViewerApplication?.pdfDocument && window.pdfReader);
  await page.waitForTimeout(2500);
  const far = Math.min(P + 30, await page.evaluate(() => PDFViewerApplication.pagesCount));
  await page.evaluate((p) => pdfReader.read(p, 0), P);
  await page.waitForTimeout(1500);
  await page.evaluate((p) => { PDFViewerApplication.page = p; }, far);
  await page.waitForTimeout(3000);
  check((await page.evaluate(() => PDFViewerApplication.page)) === far, "scrolling away keeps the view where I put it");
  check(/Pause/.test(await page.textContent("#readerPlay")), "still reading after the scroll");
  await page.click("#readerPlay");
  const paused = await page.evaluate(() => document.querySelector("#readerResume").title);
  check(paused.includes(`page ${P}`) || paused.includes(`page ${P + 1}`), "reading went on in order while scrolled away", paused.slice(0, 90));
  await page.evaluate((p) => { PDFViewerApplication.page = p; }, Math.max(1, far - 5));
  await page.waitForTimeout(800);
  await page.click("#readerPlay");
  await page.waitForTimeout(800);
  const v = await page.evaluate(() => PDFViewerApplication.page);
  check(v >= P && v <= P + 2, "play after pause goes back to the remembered place", `view p.${v}`);
  await page.click("#readerPlay");
  const w = word || (await page.evaluate(async (p) => (await pdfReader.sentences(p)).map((s) => s.text).join(" ").match(/\b([A-Z][a-z]{3,})\b/)?.[1], P));
  const near = await page.evaluate(async ({ p, w }) => {
    PDFViewerApplication.page = p; await new Promise((r) => setTimeout(r, 1500));
    const layer = document.querySelector(`.page[data-page-number="${p}"] .textLayer`);
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT); let last = null, node;
    while ((node = walker.nextNode())) { let i = -1; while ((i = node.data.indexOf(w, i + 1)) >= 0) last = [node, i]; }
    if (!last) return null;
    const r = document.createRange(); r.setStart(last[0], last[1]); r.setEnd(last[0], last[1] + w.length);
    getSelection().removeAllRanges(); getSelection().addRange(r); return last[0].data.slice(Math.max(0, last[1] - 20), last[1] + 30);
  }, { p: P, w });
  await page.click("#readerPlay");
  await page.waitForTimeout(700);
  const now = await page.evaluate(() => document.querySelector("#readerResume").title);
  check(Boolean(near) && now.includes(w), `selection start: begins at the LAST "${w}" on p.${P}`, `near ${JSON.stringify(near)} | now ${now.slice(0, 90)}`);
} finally { await browser.close(); }
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
