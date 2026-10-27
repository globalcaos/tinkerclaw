// Tap-to-comment, end to end, as a phone (2026-10-23). the architect's flow: 💬 Comment on, tap a word, type,
// let the autosave run, press Add, and the comment must be in the SAVED FILE. The first version of
// this tool was "verified" by seeing the box open; Add then failed twice over (a reload under the box,
// and no save after Add). Stopping before Add is the gap this test closes.
// node test/tap-comment.mjs   (server on 127.0.0.1:18820; on the Pi: PW_CHROMIUM=/usr/bin/chromium)
// Works on a /tmp copy served through papers/open/jarvistest/t.pdf, so no real paper is written.
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const LINK = `${ROOT}papers/open/jarvistest/t.pdf`;
let COPY = "/tmp/jarvis/tap-comment/t.pdf";
try { COPY = readlinkSync(LINK); } catch {} // an existing link keeps its target
mkdirSync(dirname(COPY), { recursive: true });
execFileSync("python3", [`${ROOT}md2pdf.py`, `${ROOT}README.md`, COPY], { stdio: "ignore" }); // own fixture: the README as a PDF
mkdirSync(`${ROOT}papers/open/jarvistest`, { recursive: true });
if (!existsSync(LINK) && !(() => { try { return lstatSync(LINK); } catch { return null; } })()) symlinkSync(COPY, LINK);

const NOTE = "tap comment test";
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 411, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let pdfGets = 0;
page.on("request", (r) => r.method() === "GET" && /jarvistest\/t\.pdf$/.test(r.url()) && pdfGets++);
await page.goto("http://127.0.0.1:18820/viewer/web/viewer.html?file=%2Fpapers%2Fopen%2Fjarvistest%2Ft.pdf");
await page.waitForSelector(".textLayer span", { state: "attached", timeout: 60000 });
await page.waitForTimeout(1500);

await page.tap("#tapComment");
const span = await page.evaluateHandle(() => [...document.querySelectorAll(".textLayer span")].find((s) => s.textContent.trim().length > 3 && s.getBoundingClientRect().top > 80));
const box = await span.boundingBox();
await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
await page.waitForSelector("#commentManagerDialog[open]", { timeout: 5000 });
await page.type("#commentManagerTextInput", NOTE);
await page.waitForTimeout(9000); // the highlight's autosave and two watcher ticks, with the box open
await page.tap("#commentManagerSaveButton");
await page.waitForTimeout(5000);
await browser.close();

const comments = execFileSync(`${ROOT}.venv/bin/python`, ["-I", `${ROOT}pdf-comments.py`, COPY], { encoding: "utf8" });
const ok = comments.includes(NOTE) && pdfGets === 1 && errors.length === 0;
console.log(comments.trim());
console.log(JSON.stringify({ noteInFile: comments.includes(NOTE), reloads: pdfGets - 1, errors }));
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
