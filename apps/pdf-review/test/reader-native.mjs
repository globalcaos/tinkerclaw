// Read-aloud handed to the phone app (2026-11-12). Inside a newer app the page does not speak sentence
// by sentence: it gives the app the reading list and follows the app's position events, so reading goes
// on with the screen locked. Checked here with a stand-in for the app's bridge (window.JarvisNative):
//   N1 Read hands over the list: a first small part at once, the rest appended, the last part says so
//   N2 every sentence carries its paragraph number, and the numbers only grow
//   N3 a position event from the app moves the highlight and sets the button to Pause
//   N4 Pause, Read again and a speed pick go to the app as pause / resume / rate, with no new list
//   N5 a speed changed on the app's side (notification, cover screen) shows in the settings menu
//   N6 while the app reads, ⏮¶ and ¶⏭ go to the app as readCtl prev / next, with no new list
// node test/reader-native.mjs   (server on 127.0.0.1:$PDF_REVIEW_PORT, default 18820; Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 411, height: 922 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => {
  window.calls = [];
  const log = (m) => (...a) => window.calls.push([m, ...a]);
  window.JarvisNative = { speak: log("speak"), stopSpeaking: log("stopSpeaking"), voices: log("voices"),
    readQueue: log("readQueue"), readAppend: log("readAppend"), readCtl: log("readCtl") };
});
await page.goto(fixtureUrl());
await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && document.querySelector(".textLayer span") && document.querySelector("#readerVoice option"), null, { timeout: 60000 });
await page.waitForTimeout(800);
await page.click("#readerPlay");
await page.waitForFunction(() => window.calls.some(([m, j]) => m === "readAppend" && JSON.parse(j).more === false) || window.calls.some(([m, j]) => m === "readQueue" && JSON.parse(j).more === false), null, { timeout: 60000 });
const r = await page.evaluate(async () => {
  const parts = window.calls.filter(([m]) => m === "readQueue" || m === "readAppend").map(([m, j]) => [m, JSON.parse(j)]);
  const rows = parts.flatMap(([, p]) => p.items);
  const paras = rows.map((x) => x[3]);
  const out = {
    queues: parts.filter(([m]) => m === "readQueue").length, parts: parts.length, firstPart: parts[0][1].items.length,
    lastSaysEnd: parts.at(-1)[1].more === false, othersSayMore: parts.slice(0, -1).every(([, p]) => p.more === true),
    oneQueueId: new Set(parts.map(([, p]) => p.q)).size === 1, sentences: rows.length, pages: new Set(rows.map((x) => x[1])).size,
    parasGrow: paras.every((v, i) => i === 0 || v === paras[i - 1] || v === paras[i - 1] + 1), paragraphs: paras.at(-1) + 1,
    spoke: window.calls.filter(([m]) => m === "speak").length,
  };
  const head = parts[0][1];
  const fire = (d) => window.dispatchEvent(new CustomEvent("jarvis-native", { detail: { ev: "reader", q: head.q, doc: head.doc, active: true, rate: String(head.rate), ...d } }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const target = rows.find((x) => x[1] === 2) || rows[5]; // a sentence on page 2 when there is one
  fire({ state: "at", page: target[4], idx: target[5], playing: true });
  await wait(1200);
  out.viewPage = window.PDFViewerApplication.page; out.wantPage = target[1];
  out.marked = document.querySelectorAll(`.page[data-page-number="${target[1]}"] .readerMark > div`).length > 0;
  out.showsPause = document.getElementById("readerPlay").classList.contains("on");
  const before = window.calls.length;
  document.getElementById("readerPlay").click(); await wait(200);
  fire({ state: "paused", page: target[4], idx: target[5], playing: false }); await wait(200);
  out.showsRead = !document.getElementById("readerPlay").classList.contains("on");
  document.getElementById("readerPlay").click(); await wait(200);
  const sp = document.getElementById("readerSpeed"); sp.value = "1.4"; sp.dispatchEvent(new Event("change")); await wait(100);
  out.ctl = window.calls.slice(before).map((c) => c.slice(0, 3).join(":")).join(" ");
  fire({ state: "at", page: target[4], idx: target[5], playing: true, rate: "1.6" }); await wait(200);
  out.speedShown = sp.value; out.speedKept = localStorage.getItem("reader.speed");
  const mark = window.calls.length;
  document.getElementById("readerNext").click(); await wait(200);
  document.getElementById("readerPrev").click(); await wait(200);
  out.skipCtl = window.calls.slice(mark).map((c) => c.slice(0, 3).join(":")).join(" ");
  return out;
});
r.errors = errors;
console.log(JSON.stringify(r));
const ok = r.queues === 1 && r.parts >= 2 && r.firstPart <= 6 && r.lastSaysEnd && r.othersSayMore && r.oneQueueId && r.sentences > 20 && r.pages >= 2 &&
  r.parasGrow && r.paragraphs > 3 && r.spoke === 0 && r.viewPage === r.wantPage && r.marked && r.showsPause && r.showsRead &&
  r.ctl === "readCtl:pause: readCtl:resume: readCtl:rate:1.4" && r.speedShown === "1.6" && r.speedKept === "1.6" &&
  r.skipCtl === "readCtl:next: readCtl:prev:" && !errors.length;
await browser.close();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
