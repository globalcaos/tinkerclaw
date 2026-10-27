// Comments save as they are typed (2026-10-23 18:30). the architect lost a long comment when the Jarvis app
// restarted with the box open. As a phone: type without pressing anything and the text must reach the
// SAVED FILE; the button reads Done; kill the page mid-sentence (no beforeunload, like an app restart)
// and the reopened viewer must offer the whole text back; Done after an edit saves it too.
// node test/live-comment.mjs   (server on 127.0.0.1:18820; on the Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const LINK = `${ROOT}papers/open/jarvistest/t.pdf`;
let COPY = "/tmp/jarvis/tap-comment/t.pdf";
try { COPY = readlinkSync(LINK); } catch {}
mkdirSync(dirname(COPY), { recursive: true });
execFileSync("python3", [`${ROOT}md2pdf.py`, `${ROOT}README.md`, COPY], { stdio: "ignore" });
mkdirSync(`${ROOT}papers/open/jarvistest`, { recursive: true });
if (!existsSync(LINK) && !(() => { try { return lstatSync(LINK); } catch { return null; } })()) symlinkSync(COPY, LINK);
const URL_ = "http://127.0.0.1:18820/viewer/web/viewer.html?file=%2Fpapers%2Fopen%2Fjarvistest%2Ft.pdf";
const comments = () => execFileSync(`${ROOT}.venv/bin/python`, ["-I", `${ROOT}pdf-comments.py`, COPY], { encoding: "utf8" });

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 411, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [];
const open = async () => {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForSelector(".textLayer span", { state: "attached", timeout: 60000 });
  await page.waitForTimeout(1500);
  return page;
};
const r = {};
let page = await open();
await page.evaluate(() => localStorage.clear());
await page.tap("#tapComment");
const span = await page.evaluateHandle(() => [...document.querySelectorAll(".textLayer span")].find((s) => s.textContent.trim().length > 3 && s.getBoundingClientRect().top > 80));
const box = await span.boundingBox();
await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
await page.waitForSelector("#commentManagerDialog[open]", { timeout: 5000 });
r.buttonLabel = (await page.textContent("#commentManagerSaveButton")).trim();
r.buttonEnabled = !(await page.isDisabled("#commentManagerSaveButton"));
await page.type("#commentManagerTextInput", "first half typed");
await page.waitForTimeout(6000); // a second's pause, the save, and slack for the Pi
r.savedWhileTyping = comments().includes("first half typed");
await page.type("#commentManagerTextInput", " and the second half lost to a crash");
await page.close({ runBeforeUnload: false }); // the app dies: nothing more runs on that page

page = await open();
await page.waitForTimeout(1200);
r.rescueShown = await page.isVisible("#draftRescue");
r.rescueText = r.rescueShown ? await page.inputValue("#draftRescue textarea") : null;
r.rescueComplete = r.rescueText === "first half typed and the second half lost to a crash";
await page.tap("#draftRescue button:last-child"); // Dismiss
r.rescueGone = !(await page.isVisible("#draftRescue"));
await browser.close();

const ok = r.buttonLabel === "Done" && r.buttonEnabled && r.savedWhileTyping && r.rescueShown && r.rescueComplete && r.rescueGone && errors.length === 0;
console.log(JSON.stringify({ ...r, errors }));
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
