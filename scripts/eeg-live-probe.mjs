#!/usr/bin/env node
/**
 * Drive the LIVE Tinker UI to a given session and MEASURE what the EEG actually paints.
 *
 * A screenshot alone misleads (a 260px panel viewport onto a 1200px+ paper clips almost
 * everything), so this does three things a shot cannot: reads the DOM per path (how many
 * branch strands, how many the renderer itself labels "N× parallel here", the distinct x
 * columns that prove a depth fan rather than one stacked column), dumps the FULL svg so it
 * can be rendered whole, and prints the app's own `[eeg-dbg]` console lines — the single
 * diagnostic that separates "no data" from "data arrived and the client refused it".
 *
 *   node scripts/eeg-live-probe.mjs <sessionKey> [out.png] [--seed <n>]
 *
 * --seed <n> pre-loads the tab's localStorage with n persisted MAIN samples before the app
 * boots. That reproduces a long-lived browser tab, which is what wedged the rebuild guard:
 * the guard compared total store samples against the 500-capped anatomy payload, so any tab
 * holding 500+ samples answered "local is richer" forever and never rebuilt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const SESSION_KEY = process.argv[2] ?? "";
const OUT =
  process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "/tmp/eeg-live.png";
const seedIdx = process.argv.indexOf("--seed");
const SEED = seedIdx > -1 ? Number(process.argv[seedIdx + 1] || 0) : 0;
const CHROME =
  process.env.UI_SHOT_CHROME ||
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1134/chrome-linux/chrome");
let URL = process.env.UI_SHOT_URL || "http://localhost:18790";
try {
  const tok = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"),
  )?.gateway?.auth?.token;
  if (tok) URL += (URL.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok);
} catch {
  /* unauthenticated — the UI will say so */
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const dbg = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[eeg-dbg]")) dbg.push(t);
});
page.on("pageerror", (e) => dbg.push(`PAGEERROR ${e.message}`));

if (SEED > 0 && SESSION_KEY) {
  await page.addInitScript(
    ({ key, n }) => {
      const base = Date.now() - n * 60_000;
      const samples = Array.from({ length: n }, (_, i) => ({
        runId: `seed-${i}`,
        model: "claude-opus-5",
        provider: "anthropic",
        chosenLevel: "medium",
        startedAt: base + i * 60_000,
      }));
      localStorage.setItem("tinker-eeg:" + key, JSON.stringify({ samples, ends: [] }));
    },
    { key: SESSION_KEY, n: SEED },
  );
}

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000); // gateway WS connect + sessions.list + first chat load

if (SESSION_KEY) {
  // The sessions panel starts collapsed and a collapsed group renders no children, so the row
  // is simply not in the DOM until the header is opened.
  const sel = `[data-session-key="${SESSION_KEY}"]`;
  if (!(await page.$(sel))) {
    for (const h of await page.$$("h3, .rpanel-header, [class*=header]")) {
      const txt = ((await h.textContent()) ?? "").trim().toUpperCase();
      if (txt.startsWith("SESSIONS")) {
        await h.click().catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(2500);
  }
  const row = await page.$(sel);
  if (row) {
    await row.click().catch(() => {});
    console.log(
      `clicked session row ${SESSION_KEY}${SEED ? ` (seeded ${SEED} local samples)` : ""}`,
    );
  } else {
    console.log(`session row NOT FOUND: ${SESSION_KEY}`);
  }
  await page.waitForTimeout(9000); // chat load + anatomy backfill + repaint
}

const measured = await page.evaluate(() => {
  const paper = document.getElementById("eeg-paper");
  if (!paper) return { paper: false };
  const svg = paper.querySelector("svg");
  const paths = [...paper.querySelectorAll("path")];
  const titles = [...paper.querySelectorAll("title")].map((t) => t.textContent ?? "");
  const parallel = titles.filter((t) => t.includes("parallel here"));
  const nums = parallel.map((t) => Number((t.match(/(\d+)× parallel here/) ?? [])[1] ?? 0));
  // A branch splits off the trunk, so its FIRST coordinate is the trunk column for every
  // strand — measuring that says nothing. The fan lives in the bbox: overlapping strands are
  // pushed to different x by lane + depth offset.
  const cols = {};
  for (const p of paths) {
    const b = p.getBBox();
    const x = Math.round(b.x);
    cols[x] = (cols[x] ?? 0) + 1;
  }
  return {
    paper: true,
    paperHeight: svg?.getAttribute("height") ?? "",
    paths: paths.length,
    parallelTooltips: parallel.length,
    maxMultiplicity: nums.length ? Math.max(...nums) : 0,
    strandColumns: cols,
    svg: svg?.outerHTML ?? "",
  };
});

const { svg, ...summary } = measured;
console.log("\n--- EEG measured from the live DOM ---");
console.log(JSON.stringify(summary, null, 1));
console.log("\n--- app's own [eeg-dbg] console lines ---");
for (const l of dbg) console.log(l.slice(0, 400));

if (svg) {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#241c14">${svg}</body>`;
  fs.writeFileSync("/tmp/eeg-paper.html", html);
  console.log("\nFULL SVG → /tmp/eeg-paper.html (render it to see the whole paper)");
}
const el = (await page.$("#eeg-paper")) ?? (await page.$("#eeg-panel-body"));
if (el) await el.screenshot({ path: OUT });
console.log(`SHOT ${OUT}`);
await browser.close();
