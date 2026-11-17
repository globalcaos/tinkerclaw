// A keep round while a rebuilt file waits behind an open comment box never makes the next carry put back the
// comments the rebuild removed (burn review 2026-11-13 F5). The phone showed S1 (with a comment the agent was
// applying), the agent rebuilt it clean (S2) while the box was open, a keep round stored S2 as this device's copy,
// and closing the box then synced the marks with no base copy: the server carried every mark of S1, the applied
// comment included, back onto the clean rebuild. The copy of the open file must stay S1 until the page reloads.
// Run against a test server whose open roots hold the fixture's folder (default /tmp/jarvis/tap-comment):
//   PDF_REVIEW_PORT=18833 PDF_REVIEW_OPEN_ROOTS=/tmp/jarvis/tap-comment .venv/bin/python server.py
// then PW_CHROMIUM=/usr/bin/chromium PDF_REVIEW_PORT=18833 node test/offline-keep-base.mjs
import { createRequire } from "node:module";
import { readlinkSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fixtureUrl } from "./fixture.mjs";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const BASE = `http://127.0.0.1:${process.env.PDF_REVIEW_PORT || 18820}`;
fixtureUrl();
const COPY = readlinkSync(`${ROOT}papers/open/jarvistest/t.pdf`);
// Opened as a phone opens a file (/api/open), so the folder list and the history name it by the same path.
const SERVED = (await (await fetch(`${BASE}/api/open`, { method: "POST", body: JSON.stringify({ path: COPY }) })).json()).path;
const URL_ = `${BASE}/viewer/web/viewer.html?file=${encodeURIComponent(SERVED)}`;
const NOTE = "ALREADY APPLIED keep-base";
const CLEAN = readFileSync(COPY); // S2: the agent's clean rebuild
// S1: the file as he reviewed it, with one comment the agent is about to apply.
execFileSync(`${ROOT}.venv/bin/python`, ["-I", "-c", "import pymupdf,sys; d=pymupdf.open(sys.argv[1]); d[0].add_text_annot((60,60),sys.argv[2]); d.saveIncr()", COPY, NOTE]);
const notes = () => execFileSync(`${ROOT}.venv/bin/python`, ["-I", `${ROOT}pdf-comments.py`, COPY], { encoding: "utf8" }).split(NOTE).length - 1;

let failures = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };
check(notes() === 1, "the reviewed file holds the comment");
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
try {
  const ctx = await browser.newContext({ viewport: { width: 411, height: 820 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => localStorage.setItem("pdfreview.offline", "1"));
  const page = await ctx.newPage();
  await page.route(/\/api\/origin/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto(URL_);
  await page.waitForSelector(".textLayer span", { state: "attached", timeout: 60000 });
  await page.waitForTimeout(3000); // the opened file is kept on the device (keepOpened)
  await page.evaluate(() => document.getElementById("commentManagerDialog").showModal()); // he is typing a comment
  writeFileSync(COPY, CLEAN); // the agent's clean rebuild lands
  const later = new Date(Date.now() + 10000);
  utimesSync(COPY, later, later);
  check(notes() === 0, "the rebuild is clean");
  // The automatic keep round runs while the box is open: it walks the history (the open file is first) into keepFolder.
  const kept = page.waitForRequest((r) => r.url().includes("/api/clientlog") && (r.postData() || "").includes("auto-kept"), { timeout: 60000 });
  await page.evaluate(async () => (await import("./offline.js")).autoKeep({ force: true }));
  await kept;
  check(true, "a keep round ran while the box was open");
  await page.evaluate(() => document.getElementById("commentManagerDialog").close()); // Add/Cancel: the save runs
  await page.waitForTimeout(15000); // 409, kept as pending, synced with a carry
  check(notes() === 0, "the comment the rebuild removed is not carried back onto it", `found ${notes()}`);
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
