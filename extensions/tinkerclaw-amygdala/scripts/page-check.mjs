#!/usr/bin/env node
/**
 * What the amygdala shows on the LIVE Tinker page, for one chat tab: refusal strips (Rewind active or greyed), held /
 * sent-back cards, Jev windows. The check every amygdala change is judged by (2026-09-30: four layers passed their own
 * tests while the CTO tab showed no strip; only the page told the truth). Read-only: it opens a headless Chrome on
 * the prod UI, clicks the tab's title and never presses a button inside the chat.
 *
 *   node extensions/tinkerclaw-amygdala/scripts/page-check.mjs "⚖️ CTO" [--shot /path/out.png]
 *
 * Needs playwright-core (repo node_modules) and /usr/bin/google-chrome. Exit 0 with a summary; exit 1 if the page or
 * tab cannot be reached.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(fileURLToPath(import.meta.url));
const { chromium } = require("playwright-core");
const tabTitle = process.argv[2];
const shotAt = process.argv.indexOf("--shot");
const shot = shotAt > 0 ? process.argv[shotAt + 1] : null;
if (!tabTitle) {
  console.error('usage: page-check.mjs "<tab title>" [--shot out.png]');
  process.exit(2);
}
const url = process.env.TINKER_URL ?? "http://127.0.0.1:18793/tinker/";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const tab = page.getByText(tabTitle, { exact: false }).first();
  await tab.waitFor({ timeout: 45_000 });
  await tab.click();
  await page.waitForTimeout(6_000); // the tab's own amygdala feed loads on first draw
  const summary = await page.evaluate(() => {
    const strips = [...document.querySelectorAll(".amy-refstrip")].map((s) => ({
      turn: s.getAttribute("data-turn"),
      rewind: s.querySelector('[data-amy-act="rewind"]')
        ? "active"
        : s.querySelector("button[disabled]")
          ? "greyed"
          : "none",
    }));
    const windows = [...document.querySelectorAll(".amy-turn")].length;
    const rewound = [...document.querySelectorAll(".amy-turn")].filter((t) =>
      /Rewound/.test(t.textContent ?? ""),
    ).length;
    return { strips, windows, rewound };
  });
  console.log(JSON.stringify({ tab: tabTitle, ...summary }, null, 1));
  if (shot) {
    const last = page.locator(".amy-turn").last();
    if (await last.count()) await last.scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot });
    console.log(`screenshot: ${shot}`);
  }
} catch (err) {
  console.error("page check failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
