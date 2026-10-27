// Real-time render probe (2026-10-22): loads a viewer URL in Chromium, prints console errors and HTTP >=400,
// then pages/canvases/text spans every 2.5 s, and saves a screenshot. Headless --screenshot with
// --virtual-time-budget shows "of 0" even for good PDFs: do not trust it.
// Usage: node test/probe-render.mjs "<viewer url>" [shot.png] [--phone] [--landscape]
import { chromium } from "../../../node_modules/playwright-core/index.mjs";
const U = process.argv[2];
const land = process.argv.includes("--landscape");
const mobile = land || process.argv.includes("--phone");
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--password-store=basic"] });
const pg = await b.newPage(mobile ? { viewport: land ? { width: 860, height: 412 } : { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 } : { viewport: { width: 1000, height: 1300 } });
pg.on("console", m => { if (m.type() !== "log") console.log("CONSOLE", m.type(), m.text().slice(0, 250)); });
pg.on("pageerror", e => console.log("PAGEERROR", String(e).slice(0, 300)));
pg.on("requestfailed", r => console.log("FAIL", r.url().slice(0, 150), r.failure()?.errorText));
pg.on("response", r => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url().slice(0, 150)); });
await pg.goto(U);
for (let i = 0; i < 12; i++) {
  await pg.waitForTimeout(2500);
  const s = await pg.evaluate(() => ({ n: window.PDFViewerApplication?.pagesCount, canv: document.querySelectorAll(".page canvas").length, loaded: document.querySelectorAll(".page[data-loaded]").length, txt: document.querySelectorAll(".textLayer span").length }));
  console.log(i, JSON.stringify(s));
  if (s.canv > 0 && s.txt > 0) break;
}
await pg.screenshot({ path: process.argv[3] || "/tmp/viewer-probe.png" });
await b.close();
