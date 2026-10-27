// End-to-end check of read-aloud: highlight, page turns, saved place, resume, start from a selection.
// node test/reader.mjs   (needs server.py on 127.0.0.1:18820; restores state/bookmarks.json after)
import { createRequire } from "node:module";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:18820";
const URL = `${BASE}/viewer/web/viewer.html?file=/papers/sample-paper.pdf`;
const STATE = new globalThis.URL("../", import.meta.url).pathname + "state/bookmarks.json";
const PAPER = new globalThis.URL("../", import.meta.url).pathname + "papers/sample-paper.pdf";
const EDGE = new globalThis.URL("../", import.meta.url).pathname + "papers/zz-edge-test.pdf";
const ORDER = new globalThis.URL("../", import.meta.url).pathname + "papers/zz-order-test.pdf";
const REBUILT = new globalThis.URL("../", import.meta.url).pathname + "papers/rebuilt/sample-paper.pdf";
const saved = fs.existsSync(STATE) ? fs.readFileSync(STATE) : null;

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("[console]", m.text()));
  const spoken = [];
  page.on("request", (r) => r.url().endsWith("/api/tts") && spoken.push(JSON.parse(r.postData()).text));

  const open = async () => {
    await page.goto(URL);
    await page.waitForFunction(() => window.PDFViewerApplication?.pdfDocument && document.getElementById("readerPlay"));
    await page.waitForFunction(() =>
      document.querySelector(`.page[data-page-number="${PDFViewerApplication.page}"] .textLayer span`));
  };
  const doc = async () => page.evaluate(() => PDFViewerApplication.pdfDocument.fingerprints[0]);
  const mark = async () => (await fetch(`${BASE}/api/bookmark?doc=${encodeURIComponent(await doc())}`)).json();
  // Polls from Node: page.waitForFunction treats a pending Promise as truthy and returns at once.
  const until = async (pred, ms, what) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
      const m = await mark();
      if (pred(m)) return m;
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  await open();
  // Start clean: no saved place under the document or its file name, then reopen without one.
  for (const key of [await doc(), `file:${PAPER.split("/").pop()}`]) {
    await fetch(`${BASE}/api/bookmark?doc=${encodeURIComponent(key)}`, { method: "PUT", body: "{}" });
  }
  await open();
  await page.evaluate(() => { PDFViewerApplication.page = 1; }); // pdf.js remembers the last page seen
  await page.waitForSelector('.page[data-page-number="1"] .textLayer span');
  await page.selectOption("#readerSpeed", "2");

  // 1. Read from the top of page 1.
  await page.click("#readerPlay");
  await page.waitForSelector('.page[data-page-number="1"] .readerMark > div', { timeout: 15000 });
  check(!spoken[0]?.includes("INTRODUCTION"), "running header is not read", JSON.stringify(spoken[0]?.slice(0, 60)));
  await until((m) => m.page === 1 && m.idx >= 2, 60000, "sentence 3 on page 1");
  const m1 = await mark();
  check(m1.page === 1 && m1.idx >= 2, "position saved as it reads", `p.${m1.page} #${m1.idx}: “${m1.text?.slice(0, 50)}”`);
  await page.screenshot({ path: "/tmp/reader-highlight.png" });

  // 2. Turn the page while listening: reading follows to the top of that page.
  await page.evaluate(() => { PDFViewerApplication.page = 3; });
  await until((m) => m.page === 3, 20000, "reading to move to page 3");
  check(true, "turning the page moves the reading there");
  await until((m) => m.page === 3 && m.idx >= 1, 30000, "sentence 2 on page 3");
  await page.click("#readerPlay"); // pause
  const m2 = await mark();
  check(await page.evaluate(() => document.getElementById("readerPlay").textContent.includes("Read")), "pause button pauses");

  // 3. Close and come back: the resume chip names the saved page and reading restarts on that sentence.
  await page.evaluate(() => { PDFViewerApplication.page = 1; });
  await open();
  await page.waitForFunction((p) => PDFViewerApplication.page === p, m2.page, { timeout: 10000 }).catch(() => {});
  await page.waitForSelector(`.page[data-page-number="${m2.page}"] .readerMark > div`, { timeout: 5000 }).catch(() => {});
  const markShown = await page.locator(`.page[data-page-number="${m2.page}"] .readerMark > div`).count();
  check((await page.evaluate(() => PDFViewerApplication.page)) === m2.page && markShown > 0,
    "reopening shows the saved page with the next sentence marked", `page ${await page.evaluate(() => PDFViewerApplication.page)}, ${markShown} mark boxes`);
  const chip = await page.textContent("#readerResume");
  check(chip.includes(`p.${m2.page}`) && !(await page.isHidden("#readerResume")), "resume chip after reopening", chip);
  spoken.length = 0;
  await page.click("#readerResume");
  await page.waitForFunction(() => PDFViewerApplication.page === 3, null, { timeout: 10000 });
  await page.waitForFunction((n) => n, spoken.length, { timeout: 100 }).catch(() => {});
  await page.waitForTimeout(800);
  check(spoken[0]?.startsWith(m2.text.slice(0, 40)), "resume starts at the saved sentence", `“${spoken[0]?.slice(0, 50)}”`);
  await page.click("#readerPlay"); // pause

  // 4. Select text on page 5 and press Read: it starts at the sentence holding the selection.
  await page.evaluate(() => { PDFViewerApplication.page = 5; });
  await page.waitForSelector('.page[data-page-number="5"] .textLayer span');
  const target = page.locator('.page[data-page-number="5"] .textLayer span').nth(12);
  const box = await target.boundingBox();
  const word = (await target.textContent()).trim();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  console.log("selection before Read:", JSON.stringify(await page.evaluate(() => String(getSelection()))));
  spoken.length = 0;
  await page.click("#readerPlay");
  await page.waitForTimeout(1200);
  const m4 = await mark();
  console.log("first requests after Read:", JSON.stringify(spoken.slice(0, 3).map((t) => t.slice(0, 40))));
  const want = word.replace(/\s+/g, " ").slice(0, 10);
  // A prefetch from the earlier reading can still land after the click, so look at the first three.
  check(m4.page === 5 && spoken.slice(0, 3).some((t) => t.startsWith(want)), "Read starts at the selected words", `p.${m4.page}, want “${want}…”`);
  await page.click("#readerPlay");

  // 6. Titles and paragraphs: a title is its own sentence, then the long pause; a paragraph a shorter one.
  const p3 = await page.evaluate(() => window.pdfReader.sentences(3));
  const ti = p3.findIndex((s) => s.text.startsWith("2. From HMAX"));
  check(ti > 0 && p3[ti].pause === "head" && p3[ti].text.length < 40, "a title is read alone, with the long pause",
    JSON.stringify(p3[ti]?.text));
  check(p3[ti - 1]?.pause === "para", "the paragraph before it ends with the paragraph pause", p3[ti - 1]?.text.slice(0, 40));
  await page.evaluate(() => {
    window.__gaps = [];
    const a = window.pdfReader.audio;
    a.addEventListener("ended", () => { window.__end = performance.now(); });
    a.addEventListener("playing", () => window.__end && window.__gaps.push(performance.now() - window.__end));
  });
  await page.evaluate((i) => { window.pdfReader.read(3, i); }, ti - 1); // read() resolves only when reading stops
  await page.waitForFunction(() => window.__gaps.length >= 2, null, { timeout: 30000 });
  await page.click("#readerPlay");
  const [paraGap, headGap] = await page.evaluate(() => window.__gaps.slice(0, 2));
  // At 2x: paragraph 0.43 s / 2 ≈ 210 ms, title (2 − 0.85) s / 2 ≈ 575 ms, both on top of the clip's own silence.
  check(paraGap > 150 && paraGap < 450, "paragraph pause", `${Math.round(paraGap)} ms`);
  check(headGap > 500 && headGap < 900, "title pause", `${Math.round(headGap)} ms`);

  // 7. While it reads, select words and press ▶ in the selection toolbar: reading jumps there.
  await page.evaluate(() => { window.pdfReader.read(3, 0); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { PDFViewerApplication.page = 5; });
  await page.waitForSelector('.page[data-page-number="5"] .textLayer span');
  const t7 = page.locator('.page[data-page-number="5"] .textLayer span').nth(30);
  const b7 = await t7.boundingBox();
  const w7 = (await t7.textContent()).trim().replace(/\s+/g, " ").slice(0, 10);
  await page.mouse.move(b7.x + 2, b7.y + b7.height / 2);
  await page.mouse.down();
  await page.mouse.move(b7.x + b7.width - 2, b7.y + b7.height / 2, { steps: 5 });
  await page.mouse.up();
  const here = page.locator(".editToolbar .readerHere");
  await here.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  check(await here.isVisible(), "▶ appears in the selection toolbar");
  spoken.length = 0;
  if (await here.isVisible()) await here.click();
  await page.waitForTimeout(1500);
  const m7 = await mark();
  check(m7.page === 5 && spoken.slice(0, 3).some((t) => t.startsWith(w7)) &&
    (await page.textContent("#readerPlay")).includes("Pause"), "▶ reads from the selection, even mid-reading", `p.${m7.page}, want “${w7}…”`);
  await page.click("#readerPlay");

  // 8. Space plays and pauses: on a page with nothing selected it starts at the top of that page.
  await page.evaluate(() => { getSelection().removeAllRanges(); PDFViewerApplication.page = 4; });
  await page.waitForSelector('.page[data-page-number="4"] .textLayer span');
  const p4 = await page.evaluate(() => window.pdfReader.sentences(4));
  await page.locator("#viewerContainer").click({ position: { x: 5, y: 5 } }); // focus the page, not a button
  spoken.length = 0;
  await page.keyboard.press("Space");
  await page.waitForTimeout(1500);
  check(spoken[0]?.startsWith(p4[0].text.slice(0, 30)) && (await page.textContent("#readerPlay")).includes("Pause"),
    "Space starts reading at the top of the page", `“${spoken[0]?.slice(0, 40)}”`);
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  check((await page.textContent("#readerPlay")).includes("Read") && (await page.evaluate(() => window.pdfReader.audio.paused)),
    "Space pauses");

  // 5. The paper is rebuilt (new document ID, a page added in front): the place is found again.
  const m5 = await mark();
  execFileSync("python3", ["-c", `
import fitz, os, sys
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(dst), exist_ok=True)
d = fitz.open(src); d.insert_page(0)
d.xref_set_key(-1, "ID", "[<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]")
d.save(dst)`, PAPER, REBUILT]);
  await page.goto(`${BASE}/viewer/web/viewer.html?file=/papers/rebuilt/${PAPER.split("/").pop()}`);
  await page.waitForFunction(() => window.PDFViewerApplication?.pdfDocument && document.getElementById("readerPlay"));
  await page.waitForFunction(() => !document.getElementById("readerResume").hidden, null, { timeout: 15000 });
  const chip5 = await page.textContent("#readerResume");
  check(chip5.includes(`p.${m5.page + 1}`), "rebuilt paper: place moves with the inserted page", `${chip5}, was p.${m5.page}`);
  spoken.length = 0;
  await page.click("#readerResume");
  await page.waitForTimeout(1500);
  check(spoken.slice(0, 3).some((t) => t.startsWith(m5.text.slice(0, 30))), "rebuilt paper: resumes on the same sentence", `“${spoken[0]?.slice(0, 40)}”`);
  await page.click("#readerPlay");

  // 9. Text printed right up to the page edge is read; a footer repeated page to page and a page
  // number are not (the Ink & Switch essay lost its first and last lines to a fixed band).
  execFileSync("python3", ["-c", `
import fitz, sys
d = fitz.open()
for n in ("one", "two"):
    p = d.new_page(width=595, height=842)
    p.insert_text((50, 30), f"Edge top line {n} of the body.", fontsize=12)
    p.insert_text((50, 400), "A sentence in the middle of the page.", fontsize=12)
    p.insert_text((50, 815), f"Edge bottom line {n} of the body.", fontsize=12)
    p.insert_text((50, 832), "Ink and Switch, a running footer", fontsize=9)
    p.insert_text((540, 832), "1" if n == "one" else "2", fontsize=9)
d.save(sys.argv[1])`, EDGE]);
  await page.goto(`${BASE}/viewer/web/viewer.html?file=/papers/${EDGE.split("/").pop()}`);
  await page.waitForFunction(() => window.pdfReader && PDFViewerApplication.pdfDocument);
  const e1 = (await page.evaluate(() => window.pdfReader.sentences(1))).map((x) => x.text);
  check(e1[0] === "Edge top line one of the body." && e1.includes("Edge bottom line one of the body."),
    "lines at the page edge are read", JSON.stringify(e1));
  check(!e1.some((x) => /footer|^\d+$/.test(x)), "running footer and page number are skipped");

  // 10. Reading order: down the main column, a margin note after the paragraph beside it, a sentence
  // cut by the page break read whole, and the note beside that paragraph held until it ends overleaf.
  execFileSync("python3", ["-c", `
import fitz, sys
d = fitz.open()
def main(p, y, t): p.insert_text((50, y), t, fontsize=12)
def note(p, y, t): p.insert_text((420, y), t, fontsize=9)
p = d.new_page(width=595, height=842)
main(p, 120, "Alpha opens the page and it runs on for a while, and")
main(p, 138, "then closes the first paragraph here, in one go, too.")
note(p, 120, "Note beside alpha.")
main(p, 200, "Beta begins further down and it keeps running across")
main(p, 218, "the column until its sentence reaches the very bottom")
note(p, 210, "Note beside beta.")
p = d.new_page(width=595, height=842)
main(p, 120, "of the page and ends overleaf. Beta then says more.")
main(p, 180, "Gamma is a paragraph of its own on the second page.")
d.save(sys.argv[1])`, ORDER]);
  await page.goto(`${BASE}/viewer/web/viewer.html?file=/papers/${ORDER.split("/").pop()}`);
  await page.waitForFunction(() => window.pdfReader && PDFViewerApplication.pdfDocument);
  const o1 = await page.evaluate(() => window.pdfReader.sentences(1));
  const o2 = await page.evaluate(() => window.pdfReader.sentences(2));
  const show = (l) => l.map((x) => `${x.page}${x.tail ? "t" : ""}:${x.text.slice(0, 18)}`).join(" | ");
  check(o1.map((x) => x.text.slice(0, 10)).join("/") ===
    "Alpha open/Note besid/Beta begin" && o1[2].text.endsWith("ends overleaf.") && o1[2].cont?.page === 2,
    "page 1: note after its paragraph, the cut sentence joined with its end", show(o1));
  check(o2.map((x) => `${x.page}${x.tail ? "t" : ""}:${x.text.slice(0, 10)}`).join("/") ===
    "2t:of the pag/2:Beta then /1:Note besid/2:Gamma is a",
    "page 2: the note beside beta waits until beta ends", show(o2));
  spoken.length = 0;
  await page.evaluate(() => { window.pdfReader.read(1, 2); });
  await page.waitForFunction(() => PDFViewerApplication.page === 2, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.click("#readerPlay");
  check(spoken[0]?.startsWith("Beta begins") && spoken[1] === "Beta then says more." && !spoken.some((x) => x.startsWith("of the page")),
    "reading skips the end it already read and turns the page", JSON.stringify(spoken.slice(0, 3).map((x) => x.slice(0, 24))));
} finally {
  await browser.close();
  fs.rmSync(REBUILT, { force: true });
  fs.rmSync(EDGE, { force: true });
  fs.rmSync(ORDER, { force: true });
  if (saved) fs.writeFileSync(STATE, saved);
  else fs.rmSync(STATE, { force: true });
}
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exitCode = failures ? 1 : 0;
