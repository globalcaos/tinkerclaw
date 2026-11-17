// A rebuild that lands while a desktop save is on its way is never written over (burn review 2026-11-13 F4).
// On plain http (the desktop, offline engine off) the save sent no version: the viewer checked the file before
// saveDocument(), and a rebuild in the seconds that took was replaced by the old document plus its marks, which
// the viewer then took for its own write and never reloaded. Here the save's PUT is held until the file has
// been rebuilt; the rebuild must still be on disk afterwards, and the viewer must show it.
// node test/save-vs-rebuild.mjs   (server on 127.0.0.1:$PDF_REVIEW_PORT, default 18820; Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
import { readlinkSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fixtureUrl } from "./fixture.mjs";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const URL_ = fixtureUrl();
const COPY = readlinkSync(`${ROOT}papers/open/jarvistest/t.pdf`);
const MARK = "savevsrebuildmarker";
const md = `${dirname(COPY)}/save-vs-rebuild.md`, built = `${dirname(COPY)}/save-vs-rebuild.pdf`;
writeFileSync(md, `# Rebuilt\n\nThe agent's rebuild ${MARK} replaced the old text.\n`);
const env = { ...process.env };
delete env.TC_SESSION_KEY; // a test PDF is never linked to a chat
execFileSync("python3", [`${ROOT}md2pdf.py`, md, built], { stdio: "ignore", env });
const REBUILT = readFileSync(built);

let failures = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  await page.goto(URL_);
  await page.waitForSelector(".textLayer span", { state: "attached", timeout: 60000 });
  await page.waitForTimeout(2500); // autoreload.js has read the file's version
  let rebuilt = false;
  await page.route(/\/api\/save/, async (route) => {
    if (!rebuilt) { // the agent's rebuild lands after the viewer's check, before its PUT arrives
      rebuilt = true;
      writeFileSync(COPY, REBUILT);
      const t = new Date(Date.now() + 10000);
      utimesSync(COPY, t, t);
    }
    await route.continue();
  });
  await page.keyboard.press("Control+s"); // saveOriginal(true)
  for (let i = 0; i < 60 && !rebuilt; i++) await page.waitForTimeout(500);
  await page.waitForTimeout(8000); // the save answered, and a reload if one is due
  check(rebuilt, "the save reached the server after the file was rebuilt");
  check(Buffer.compare(readFileSync(COPY), REBUILT) === 0, "the rebuilt file is still on disk after the save");
  const shown = await page.evaluate(() => document.querySelector("#viewer")?.textContent || "");
  check(shown.includes(MARK), "the viewer shows the rebuilt file");
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
