import { readFileSync } from "node:fs";
// Pin dock look check (2026-10-13): pin an answer in one real tab, drag the grip, screenshot.
// node pin-look.mjs --url http://127.0.0.1:18996 --key agent:main:tinker:<id> --out <dir>
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
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addInitScript(
  ([tabs, id]) => {
    localStorage.setItem("tinker-tabs", JSON.stringify(tabs));
    localStorage.setItem("tinker.uiChoices", JSON.stringify({ "tab:active": id }));
  },
  [tabs, tab.id],
);
const page = await ctx.newPage();
await page.goto(`${a.url}/tinker/`);
await page.waitForSelector("#messages .msg.assistant table", { timeout: 90000 });
const bubble = page.locator("#messages .msg.assistant:has(table)").last();
await bubble.scrollIntoViewIfNeeded();
await bubble.hover();
await page.locator("#messages .msg-pin-btn").last().click();
await page.waitForSelector("#pin-dock:not([hidden])");
await page.screenshot({ path: `${a.out}/1-pinned.png` });
const g = await page.locator("#pin-dock .pd-grip").boundingBox();
await page.mouse.move(g.x + g.width / 2, g.y + 4);
await page.mouse.down();
await page.mouse.move(g.x + g.width / 2, g.y + 204, { steps: 8 });
await page.mouse.up();
await page.screenshot({ path: `${a.out}/2-dragged.png` });
console.log(
  JSON.stringify(
    await page.evaluate(() => ({ h: document.querySelector("#pin-dock .pd-body").style.height })),
  ),
);
await browser.close();
