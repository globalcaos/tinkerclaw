#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * FORK 2026-06-04 — ui-shot: headless screenshot of the live Tinker UI so the
 * agent has a closed loop for UI work (see what it renders, not just what it
 * compiles). Uses the repo's playwright-core + the installed chromium.
 *
 *   node scripts/ui-shot.mjs <out.png> [selector] [--pulse]
 *     out.png   : output path (default /tmp/ui-shot.png)
 *     selector  : element to capture full-height (default '.exec-panel'); '' = full page
 *     --pulse   : open Exec mode + the Pulse tab before shooting
 *
 * Prints any console errors/warnings + page errors — that's the diagnosis.
 */
import { chromium } from "playwright-core";

const CHROME =
  process.env.UI_SHOT_CHROME ||
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1134/chrome-linux/chrome");
let URL = process.env.UI_SHOT_URL || "http://localhost:18790";
// The dev UI authenticates via a ?token= param; pull the gateway token from
// openclaw.json so the headless instance connects like the real browser.
// (Token is appended to the URL but never printed.)
try {
  const tok =
    process.env.UI_SHOT_TOKEN ||
    JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"))
      ?.gateway?.auth?.token;
  if (tok && !URL.includes("token="))
    URL += (URL.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok);
} catch {
  /* no token available */
}
const OUT = process.argv[2] || "/tmp/ui-shot.png";
const SEL = process.argv[3] !== undefined ? process.argv[3] : ".exec-panel";
const PULSE = process.argv.includes("--pulse");

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
const logs = [];
page.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warning") logs.push(`[${t}] ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500); // let the app connect to the gateway + render
  if (PULSE) {
    try {
      await page.click("#tb-exec", { timeout: 5000 });
    } catch (e) {
      logs.push(`[warn] click #tb-exec: ${e.message}`);
    }
    await page.waitForTimeout(700);
    try {
      await page.click('.exec-tab[data-tab="pulse"]', { timeout: 5000 });
    } catch (e) {
      logs.push(`[warn] click pulse tab: ${e.message}`);
    }
    // Metrics arrive over the gateway WS (several seconds) — wait for the
    // charts (or an error block) rather than a fixed delay.
    try {
      await page.waitForSelector(".pg-chart, .exec-kpi-error", { timeout: 25000 });
    } catch {
      logs.push("[warn] no .pg-chart after 25s");
    }
    await page.waitForTimeout(1800);
  }
  const target = SEL ? page.locator(SEL).first() : null;
  if (target && (await target.count()) > 0) {
    await target.screenshot({ path: OUT });
    console.log("SHOT(element)", OUT);
  } else {
    if (SEL) logs.push(`[warn] selector "${SEL}" not found — full-page shot`);
    await page.screenshot({ path: OUT, fullPage: true });
    console.log("SHOT(fullpage)", OUT);
  }
} catch (e) {
  console.log("FATAL", e.message);
  try {
    await page.screenshot({ path: OUT, fullPage: true });
  } catch {
    /* noop */
  }
}
console.log("--- console errors/warnings + page errors ---");
console.log(logs.length ? logs.join("\n") : "(none)");
await browser.close();
