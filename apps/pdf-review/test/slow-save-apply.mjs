// A note typed while a slow save runs must still reach the file, and Apply must wait for it (2026-11-10).
// On a 20 MB book a phone's save took about 45 s. The save that started when the highlight was made
// carried no note; every later save request (typing pause, Done, Apply) returned at once because a save
// was running, and Apply gave up waiting after 10 s. The wake went out at 08:38:23, the only save landed
// at 08:38:43, and the file held a bare highlight: the note was lost, twice that morning.
// Here the first PUT /api/save is held for 14 s. The note is typed and Apply pressed during it. The
// note must be in the SAVED FILE when the wake is sent. The wake itself is answered here, so no chat wakes.
// node test/slow-save-apply.mjs   (server on 127.0.0.1:18820; on the Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
import { readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fixtureUrl } from "./fixture.mjs";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const URL_ = fixtureUrl();
const COPY = readlinkSync(`${ROOT}papers/open/jarvistest/t.pdf`);
const comments = () => execFileSync(`${ROOT}.venv/bin/python`, ["-I", `${ROOT}pdf-comments.py`, COPY], { encoding: "utf8" });
const NOTE = "note typed during a slow save";
const HOLD = 14000;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 411, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const r = { saves: 0, wakes: 0, noteInFileAtWake: null };
await page.route(/\/api\/origin/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
await page.route(/\/api\/save/, async (route) => {
  if (r.saves++ === 0) await new Promise((res) => setTimeout(res, HOLD));
  await route.continue();
});
await page.route(/\/api\/redo/, async (route) => {
  r.wakes++;
  r.noteInFileAtWake = comments().includes(NOTE);
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
});
await page.goto(URL_);
await page.waitForSelector(".textLayer span", { state: "attached", timeout: 60000 });
await page.waitForTimeout(1500);
await page.evaluate(() => localStorage.clear());
await page.tap("#selectTool");
const span = await page.evaluateHandle(() => [...document.querySelectorAll(".textLayer span")].find((s) => s.textContent.trim().length > 3 && s.getBoundingClientRect().top > 80));
const box = await span.boundingBox();
await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
await page.waitForSelector("#selBar:not([hidden])", { timeout: 5000 });
await page.tap("#selComment");
await page.waitForSelector("#commentManagerDialog[open]", { timeout: 5000 });
await page.waitForTimeout(3500); // the new highlight's own save has started and is now held
r.firstSaveRunning = r.saves === 1;
await page.type("#commentManagerTextInput", NOTE);
await page.tap("#commentManagerSaveButton");
await page.waitForTimeout(500);
await page.evaluate(() => document.getElementById("redoDocument").click()); // Apply, pressed while the first save still runs
for (let i = 0; i < 120 && !r.wakes; i++) await page.waitForTimeout(500);
await page.waitForTimeout(1000);
r.noteInFileAtEnd = comments().includes(NOTE);
await browser.close();

const ok = r.firstSaveRunning && r.wakes === 1 && r.noteInFileAtWake === true && r.noteInFileAtEnd && errors.length === 0;
console.log(JSON.stringify({ ...r, errors }));
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
