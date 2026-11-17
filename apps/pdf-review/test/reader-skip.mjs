// ⏮ ¶ and ¶ ⏭ move the read-aloud by whole paragraphs (2026-11-14: two buttons move the
// reading forward or back, always starting at the beginning of a paragraph).
// The expected paragraph starts come from the viewer's own sentence lists (a paragraph ends at the
// sentence that carries `pause`); the buttons are then clicked for real. A silent voice answers /api/tts,
// so no speech engine is needed and the reading stays on a sentence until a button moves it.
//   P1 ¶⏭ from the middle of a paragraph lands on the first sentence of the next one, and the page follows
//   P2 ⏮¶ from the first sentence goes to the start of the paragraph before; from the middle, to its own start
//   P3 two quick presses go two paragraphs, one after the other
//   P4 a paragraph that runs over a page break: ⏮¶ from its second page lands on its first sentence
//   P5 the ends of the document: ¶⏭ on the last paragraph stays, ⏮¶ on the first restarts it
//   P0 not started yet: the buttons move the place and stay silent; ▶ Read then starts there
//   P6 paused: the buttons move the place, stay paused, and ▶ Read goes on from the new place
// node test/reader-skip.mjs   (server on 127.0.0.1:$PDF_REVIEW_PORT, default 18820)
// Pi: PW_CHROMIUM=/usr/bin/chromium PATH=<repo>/.venv/bin:$PATH node test/reader-skip.mjs  (md2pdf needs the venv's python3)
import { createRequire } from "node:module";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const URL_ = fixtureUrl();

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Two minutes of silence: 8 kHz, 8-bit, mono.
function silence(seconds) {
  const n = 8000 * seconds;
  const b = Buffer.alloc(44 + n, 0x80);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  const wav = silence(120);
  await page.route("**/api/tts", (r) => r.fulfill({ status: 200, contentType: "audio/wav", body: wav }));
  await page.goto(URL_);
  await page.waitForFunction(() => window.pdfReader && window.PDFViewerApplication?.pdfDocument && document.getElementById("readerNext"));
  await page.evaluate(() => localStorage.setItem("reader.voice", "")); // the server's default voice; the answer is canned anyway
  // No saved place under this document (an earlier run left one): the first press starts from the top of the page.
  const keys = await page.evaluate(() => [PDFViewerApplication.pdfDocument.fingerprints[0], `file:${decodeURIComponent((PDFViewerApplication.url || "").split("/").pop())}`]);
  for (const key of keys) await fetch(`${new globalThis.URL(URL_).origin}/api/bookmark?doc=${encodeURIComponent(key)}`, { method: "PUT", body: "{}" });
  await page.reload();
  await page.waitForFunction(() => window.pdfReader && window.PDFViewerApplication?.pdfDocument && document.getElementById("readerNext"));

  // The reading order, whole: every page's list, a tail fragment dropped when the sentence before it holds it.
  const seq = await page.evaluate(async () => {
    const out = [];
    for (let p = 1; p <= PDFViewerApplication.pagesCount; p++) {
      const list = await window.pdfReader.sentences(p);
      list.forEach((e, idx) => {
        const prev = out.at(-1);
        if (e.tail && prev?.cont && prev.cont.page === e.page && prev.cont.start === e.start) return;
        out.push({ lp: p, idx, page: e.page, pause: e.pause || "", cont: e.cont ? { page: e.cont.page, start: e.cont.start } : null });
      });
    }
    return out;
  });
  const starts = [0];
  seq.forEach((e, i) => e.pause && i + 1 < seq.length && starts.push(i + 1));
  const at = (i) => ({ page: seq[i].lp, idx: seq[i].idx });
  const same = (a, b) => a && b && a.page === b.page && a.idx === b.idx;
  console.log(`# ${seq.length} sentences, ${starts.length} paragraphs, ${page.url().split("/").pop()}`);
  check(starts.length >= 8, "the fixture has paragraphs to move between", `${starts.length}`);

  const cur = () => page.evaluate(() => window.pdfReader.cur());
  const expectCur = async (want, what) => {
    let got = null;
    for (let t = 0; t < 40; t++) {
      got = await cur();
      if (same(got, want)) break;
      await page.waitForTimeout(150);
    }
    check(same(got, want), what, same(got, want) ? "" : `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  const readAt = async (i) => {
    await page.evaluate(([p, x]) => window.pdfReader.read(p, x), [at(i).page, at(i).idx]);
    await expectCur(at(i), `reading started at sentence ${i}`);
  };
  const press = (id) => page.click(`#${id}`);

  // P0: nothing read yet. ¶⏭ moves the place to the next paragraph and says nothing; ⏮¶ goes back; ▶ Read starts there.
  await page.evaluate(() => { PDFViewerApplication.page = 1; });
  await press("readerNext");
  await expectCur(at(starts[1]), "P0 ¶⏭ before any reading moves the place to the second paragraph");
  const quiet = await page.evaluate(() => ({ src: window.pdfReader.audio.src, paused: window.pdfReader.audio.paused }));
  check((await page.textContent("#readerPlay")).includes("Read") && !quiet.src, "P0 and stays silent", JSON.stringify(quiet));
  await press("readerPrev");
  await expectCur(at(starts[0]), "P0 ⏮¶ goes back to the first paragraph");
  await press("readerPlay");
  await page.waitForFunction(() => document.getElementById("readerPlay").textContent.includes("Pause"));
  await expectCur(at(starts[0]), "P0 ▶ Read starts from the place the buttons moved to");

  // P1: a paragraph of 3+ sentences, from its third sentence.
  const k = starts.findIndex((s, j) => j >= 2 && j + 1 < starts.length && starts[j + 1] - s >= 3);
  const mid = starts[k] + 2;
  await readAt(mid);
  await press("readerNext");
  await expectCur(at(starts[k + 1]), "P1 ¶⏭ lands on the first sentence of the next paragraph");
  const e1 = await page.evaluate(() => PDFViewerApplication.page);
  check(e1 === seq[starts[k + 1]].page, "P1 the page follows the voice", `page ${e1}, sentence printed on ${seq[starts[k + 1]].page}`);
  check((await page.textContent("#readerPlay")).includes("Pause"), "P1 it is reading");

  // P2: from the first sentence, back goes to the paragraph before; from the middle, to its own start.
  await press("readerPrev");
  await expectCur(at(starts[k]), "P2 ⏮¶ from a first sentence goes to the paragraph before");
  await readAt(mid);
  await press("readerPrev");
  await expectCur(at(starts[k]), "P2 ⏮¶ from the middle goes to the start of its own paragraph");

  // P3: two quick presses.
  await readAt(starts[k]);
  await page.click("#readerNext");
  await page.click("#readerNext");
  await expectCur(at(starts[k + 2]), "P3 two quick ¶⏭ go two paragraphs");
  await page.click("#readerPrev");
  await page.click("#readerPrev");
  await expectCur(at(starts[k]), "P3 two quick ⏮¶ from a first sentence go two paragraphs back");

  // P4: a paragraph that spans two lists (its end is on a later page than its start).
  const j = starts.findIndex((s, n) => {
    const end = (starts[n + 1] ?? seq.length) - 1;
    return seq[s].lp !== seq[end].lp;
  });
  if (j < 0) console.log("NOTE  P4 no paragraph runs over a page break in this fixture");
  else {
    const end = (starts[j + 1] ?? seq.length) - 1;
    await readAt(end);
    await press("readerPrev");
    await expectCur(at(starts[j]), "P4 ⏮¶ from the second page of a paragraph lands on its first sentence");
    check(true, "P4 paragraph spans pages", `p${seq[starts[j]].lp} to p${seq[end].lp}`);
    await readAt(starts[j]);
    await press("readerNext");
    await expectCur(at(starts[j + 1]), "P4 ¶⏭ from its first sentence skips the whole paragraph, page break included");
  }

  // P5: the ends.
  await readAt(seq.length - 1);
  await press("readerNext");
  await page.waitForTimeout(800);
  check(same(await cur(), at(seq.length - 1)), "P5 ¶⏭ on the last paragraph stays", JSON.stringify(await cur()));
  await readAt(0);
  await press("readerPrev");
  await page.waitForTimeout(500);
  check(same(await cur(), at(0)), "P5 ⏮¶ on the first paragraph restarts it", JSON.stringify(await cur()));
  const early = starts.filter((s) => s <= 2).at(-1); // the document opens with a title, a paragraph of its own
  await readAt(2);
  await press("readerPrev");
  await expectCur(at(early), "P5 ⏮¶ from the middle of an early paragraph goes to its start");

  // P6: paused, the buttons move the place and stay paused; ▶ Read goes on from there.
  await readAt(starts[k]);
  await press("readerPlay");
  check((await page.textContent("#readerPlay")).includes("Read") && !(await page.textContent("#readerPlay")).includes("Pause"), "P6 paused");
  await press("readerNext");
  await expectCur(at(starts[k + 1]), "P6 ¶⏭ from a pause moves the place");
  check((await page.textContent("#readerPlay")).includes("Read"), "P6 and the voice stays paused");
  await press("readerNext");
  await press("readerPrev");
  await expectCur(at(starts[k + 1]), "P6 ¶⏭ then ⏮¶ from a pause: place moves both ways");
  await press("readerPlay");
  await page.waitForFunction(() => document.getElementById("readerPlay").textContent.includes("Pause"));
  await expectCur(at(starts[k + 1]), "P6 ▶ Read goes on from the new place, not the old sentence");

  // Both buttons have a name for the screen reader and a hint.
  const names = await page.evaluate(() => ["readerPrev", "readerNext"].map((id) => [document.getElementById(id).getAttribute("aria-label"), document.getElementById(id).title]));
  check(names.every(([a, t]) => a && t), "the buttons have a name and a hint", JSON.stringify(names));
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
