// The dark look and pictures (2026-11-12): the dark look darkened a page by inverting all of it, which showed
// every picture as its negative. A picture must look the same in both looks, only the paper changes: the dark
// veil has a hole over each picture.
// The test page holds one picture, dark navy on its left half and bright yellow on its right half:
//   T1 dark look: the paper is dark, and both halves of the picture show exactly as drawn
//   T2 the test can see the fault: with the holes taken away, the navy half shows bright (the negative)
//   T3 light look: the paper is white and both halves show as drawn
//   T4 one hole on the page with the picture, none on a page without one
// node test/dark-pictures.mjs   (server on 127.0.0.1:$PDF_REVIEW_PORT, default 18820; Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const DIR = "/tmp/jarvis/dark-pictures-test";
const NAVY = [10, 20, 70], YELLOW = [250, 220, 40];

const url = fixtureUrl(); // makes the served link; its PDF is replaced below by one with a picture
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const helper = await browser.newPage();
mkdirSync(DIR, { recursive: true });
const png = await helper.evaluate(([a, b]) => {
  const c = document.createElement("canvas"); c.width = 400; c.height = 200;
  const g = c.getContext("2d");
  g.fillStyle = `rgb(${a})`; g.fillRect(0, 0, 200, 200);
  g.fillStyle = `rgb(${b})`; g.fillRect(200, 0, 200, 200);
  return c.toDataURL("image/png").split(",")[1];
}, [NAVY.join(","), YELLOW.join(",")]);
writeFileSync(`${DIR}/pic.png`, Buffer.from(png, "base64"));
writeFileSync(`${DIR}/t.md`, `# Dark pictures test\n\nA line of text above the picture.\n\n![two halves](file://${DIR}/pic.png)\n\nA line of text below the picture.\n\n<div style="page-break-before:always"></div>\n\n## A page with no picture\n\nOnly text here.\n`);
const env = { ...process.env }; delete env.TC_SESSION_KEY; // a test PDF is not a review PDF
execFileSync("python3", [`${ROOT}md2pdf.py`, `${DIR}/t.md`, readlinkSync(`${ROOT}papers/open/jarvistest/t.pdf`)], { stdio: "ignore", env });

// The colours on screen at the given points, read back from a screenshot.
async function colours(page, pts) {
  const b64 = (await page.screenshot()).toString("base64");
  return helper.evaluate(async ({ b64, pts }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const g = new OffscreenCanvas(img.width, img.height).getContext("2d"); g.drawImage(img, 0, 0);
    return pts.map(([x, y]) => Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)));
  }, { b64, pts });
}
const luma = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
let failed = false;
const check = (ok, what, got) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}${got ? `   [${got}]` : ""}`); if (!ok) failed = true; };

for (const look of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((l) => localStorage.setItem("reader.look", l), look);
  const page = await ctx.newPage();
  await page.route("**/api/save**", (r) => r.fulfill({ status: 200, body: "{}" }));
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('.page[data-page-number="1"]')?.dataset.pictures?.length > 2, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const geo = await page.evaluate(() => {
    const p = document.querySelector('.page[data-page-number="1"]'), r = p.getBoundingClientRect();
    const all = JSON.parse(p.dataset.pictures), b = all[0];
    return { boxes: all.length, page: [r.left, r.top, r.width, r.height],
      box: [r.left + b[0] * r.width, r.top + b[1] * r.height, b[2] * r.width, b[3] * r.height] };
  });
  const [x, y, w, h] = geo.box;
  const pts = [[x + w * 0.25, y + h * 0.5], [x + w * 0.75, y + h * 0.5], [geo.page[0] + geo.page[2] * 0.04, y + h * 0.5]]; // the last point is on the paper, in the left margin
  const [navy, yellow, paper] = await colours(page, pts);
  const got = `navy ${navy} yellow ${yellow} paper ${paper}`;
  if (look === "dark") {
    await page.screenshot({ path: `${DIR}/dark.png` });
    const near = (c, want) => c.every((v, i) => Math.abs(v - want[i]) <= 6);
    check(luma(paper) < 0.3 && near(navy, NAVY) && near(yellow, YELLOW), "T1 dark look: dark paper, both halves of the picture exactly as drawn", got);
    await page.evaluate(() => document.querySelectorAll(".page").forEach((e) => e.style.setProperty("--pic-holes", "none")));
    await page.waitForTimeout(300);
    const [bare] = await colours(page, pts);
    check(luma(bare) > 0.6, "T2 without the holes the navy half shows bright, so the test sees the negative", `navy ${bare}`);
  } else {
    check(luma(paper) > 0.9 && luma(navy) < 0.2 && luma(yellow) > 0.7 && yellow[0] > yellow[2],
      "T3 light look: white paper, both halves as drawn", got);
    check(geo.boxes === 1 && w > geo.page[2] * 0.2, "T4a one hole on the page with the picture, as wide as the picture", `boxes ${geo.boxes} width ${Math.round(w)}`);
    await page.evaluate(() => { window.PDFViewerApplication.page = 2; });
    await page.waitForFunction(() => document.querySelector('.page[data-page-number="2"] canvas'), null, { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.waitForFunction(() => document.querySelector('.page[data-page-number="2"]')?.dataset.pictures, null, { timeout: 30000 });
    const n2 = await page.evaluate(() => { const p = document.querySelector('.page[data-page-number="2"]'); return `${p.dataset.pictures} ${p.style.getPropertyValue("--pic-holes")}`; });
    check(n2 === "[] none", "T4b no hole on the page without a picture", n2);
  }
  check(errors.length === 0, `no page error in the ${look} look`, errors.join(" | "));
  await ctx.close();
}
await browser.close();
console.log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
