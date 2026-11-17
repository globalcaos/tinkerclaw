import { readFileSync } from "node:fs";
// Job trail look check (2026-11-14, job-trail.ts): open a real tab whose long job runs, click the job's row
// under the thinking dots, wait for the trail, open its first tool row, screenshot each step, print counts.
// node trail-look.mjs --url http://127.0.0.1:18996 --key agent:main:tinker:<id> --out <dir> [--chrome /usr/bin/chromium] [--watch 90]
// (--chrome: the system browser, where Playwright's own build is not installed, as on the Pi)
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const a = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((r, x, i, all) => (x.startsWith("--") ? [...r, [x.slice(2), all[i + 1]]] : r), []),
);
const state = JSON.parse(
  readFileSync(join(os.homedir(), ".openclaw", "data", "tinker-ui-state.json"), "utf8"),
);
const tabs = state.tabs.map((t) => ({
  id: t.id,
  sessionKey: t.sessionKey,
  title: t.title,
  isAttached: true,
}));
const tab = tabs.find((t) => t.sessionKey === a.key);
if (!tab) {
  throw new Error(`no tab for ${a.key}`);
}
const browser = await chromium.launch(a.chrome ? { executablePath: a.chrome } : {});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await ctx.addInitScript(
  ([tabs, id]) => {
    localStorage.setItem("tinker-tabs", JSON.stringify(tabs));
    localStorage.setItem("tinker.uiChoices", JSON.stringify({ "tab:active": id }));
  },
  [tabs, tab.id],
);
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
await page.goto(`${a.url}/tinker/`);
const row = page.locator("#messages .thinking-run.job-run-openable").first();
await row.waitFor({ timeout: 90000 });
await row.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${a.out}/1-row.png` });
const before = await row.evaluate((el) => ({
  title: el.getAttribute("title"),
  chev: el.querySelector(".job-run-chev")?.textContent,
  cursor: getComputedStyle(el).cursor,
}));
await row.click();
const trail = page.locator("#messages .job-trail").first();
await trail.waitFor({ timeout: 30000 });
await page.waitForFunction(
  () => !document.querySelector("#messages .job-trail")?.textContent?.includes("Loading this job"),
  null,
  { timeout: 30000 },
);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${a.out}/2-trail-bottom.png` });
await trail.screenshot({ path: `${a.out}/3-trail-whole.png` });
const firstTool = trail.locator(".tool-row").first();
await firstTool.scrollIntoViewIfNeeded();
await firstTool.click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${a.out}/4-tool-open.png` });
const after = await page.evaluate(() => {
  const t = document.querySelector("#messages .job-trail");
  const rowEl = document.querySelector("#messages .thinking-run.job-run-openable");
  return {
    head: t?.querySelector(".job-trail-head")?.textContent?.replace(/\s+/g, " ").trim(),
    toolRows: t?.querySelectorAll(".tool-row").length,
    narration: t?.querySelectorAll(".msg.assistant.job-trail-text").length,
    thinkingWithText: t?.querySelectorAll(".job-trail-thought").length,
    thoughtTimes: t?.querySelectorAll(".job-trail-thought-time").length,
    live: t?.querySelector(".job-trail-live-text")?.textContent,
    openDetail: !!t?.querySelector(".tool-detail"),
    rowChevAfter: rowEl?.querySelector(".job-run-chev")?.textContent,
    trailBeforeIndicator:
      !!t &&
      !!document.querySelector("#messages .thinking-indicator") &&
      (t.compareDocumentPosition(document.querySelector("#messages .thinking-indicator")) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
  };
});
// --watch N: keep the trail open N seconds and count again, to see it grow while the job works.
let later = null;
if (Number(a.watch) > 0) {
  await page.waitForTimeout(Number(a.watch) * 1000);
  later = await page.evaluate(() => {
    const t = document.querySelector("#messages .job-trail");
    return {
      toolRows: t?.querySelectorAll(".tool-row").length,
      narration: t?.querySelectorAll(".msg.assistant.job-trail-text").length,
      live: t?.querySelector(".job-trail-live-text")?.textContent,
    };
  });
  await page.screenshot({ path: `${a.out}/5-after-watch.png` });
}
console.log(
  JSON.stringify(
    { before, after, later, errors: errors.filter((e) => /job-trail|trail/i.test(e)) },
    null,
    1,
  ),
);
await browser.close();
