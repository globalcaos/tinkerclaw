/**
 * Opens tabs of the owner's real tab list in a headless page served by real-proxy.mjs, scrolls each
 * to the top until nothing more comes, and prints one JSON line per tab: rows and prompts when it
 * opened and at the top, the oldest row shown (from the proxy, by the page's own row identity), the
 * archive dividers, whether the loading marker was still up, and the EEG paper's prompt markers and
 * trunk strokes. Compare a build against develop's on the same tabs: the stock build is the control.
 *
 * Usage: node drive.mjs --url http://127.0.0.1:18996 [--tabs <sessionKey,...>] [--cap 200] [--quiet 35]
 * The tab list is read from ~/.openclaw/data/tinker-ui-state.json and only seeded into this browser.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const URL_ = args.url ?? "http://127.0.0.1:18996";
const CAP_S = Number(args.cap ?? 200);
const QUIET_S = Number(args.quiet ?? 35);
const state = JSON.parse(
  readFileSync(join(os.homedir(), ".openclaw", "data", "tinker-ui-state.json"), "utf8"),
);
const allTabs = state.tabs.map((t) => ({
  id: t.id,
  sessionKey: t.sessionKey,
  title: t.title,
  isAttached: true,
}));
const want = args.tabs ? args.tabs.split(",") : allTabs.map((t) => t.sessionKey);
const fmt = (t) =>
  typeof t === "number" ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "-";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addInitScript((tabs) => {
  if (!localStorage.getItem("tinker-tabs")) {
    localStorage.setItem("tinker-tabs", JSON.stringify(tabs));
    localStorage.setItem("tinker.uiChoices", JSON.stringify({ "tab:active": "tab-main" }));
  }
}, allTabs);
const page = await ctx.newPage();
const consoleLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/eeg-dbg|history|archive|dup-prov/i.test(t))
    consoleLines.push(`${Date.now()} ${t.slice(0, 300)}`);
});

async function snapshot() {
  const s = await page.evaluate(() => {
    const el = document.getElementById("messages");
    const ids = el
      ? Array.from(el.querySelectorAll("[data-oc-id]")).map((n) => n.dataset.ocId)
      : [];
    const paper = document.getElementById("eeg-paper");
    return {
      ids: Array.from(new Set(ids)),
      dividers: el ? el.querySelectorAll(".msg-reset-divider").length : 0,
      users: el ? el.querySelectorAll(".msg.user").length : 0,
      loading: el?.classList.contains("archive-loading") ?? false,
      markers: paper ? paper.querySelectorAll(".eeg-marker").length : -1,
      trunk: paper ? paper.querySelectorAll("[class*='eeg-main']").length : -1,
    };
  });
  const pr = await (
    await fetch(`${URL_}/__proxy/rows`, { method: "POST", body: JSON.stringify(s.ids) })
  ).json();
  return {
    rows: s.ids.length,
    users: s.users,
    oldest: pr.oldest,
    known: pr.known,
    inflight: pr.inflight,
    dividers: s.dividers,
    loading: s.loading,
    eeg: { markers: s.markers, trunk: s.trunk },
  };
}

await page.goto(`${URL_}/tinker/`, { waitUntil: "load" });
await page.waitForTimeout(4000);
await page.evaluate(() => {
  const g = document.querySelector('.model-group[data-section="eeg"]');
  if (g && !g.classList.contains("open")) g.querySelector(".model-group-label")?.click();
});

for (const sk of want) {
  const tab = allTabs.find((t) => t.sessionKey === sk);
  if (!tab) continue;
  await page.click(`[data-tab-id="${tab.id}"]`).catch(() => {});
  for (let i = 0; i < 40 && (await snapshot()).rows === 0; i++) await page.waitForTimeout(1000);
  await page.waitForTimeout(3000);
  const opened = await snapshot();
  const box = await page.locator("#messages").boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let s = opened;
  let last = `${opened.rows}|${opened.oldest}`;
  let quietSince = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < CAP_S * 1000) {
    await page.mouse.wheel(0, -5000);
    await page.waitForTimeout(700);
    s = await snapshot();
    const now = `${s.rows}|${s.oldest}`;
    if (now !== last || s.loading || s.inflight > 0) {
      last = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince > QUIET_S * 1000) {
      break;
    }
  }
  console.log(
    JSON.stringify({
      title: tab.title,
      sk,
      opened: { rows: opened.rows, users: opened.users, oldest: fmt(opened.oldest) },
      top: {
        rows: s.rows,
        users: s.users,
        oldest: fmt(s.oldest),
        known: s.known,
        dividers: s.dividers,
        stillLoading: s.loading,
        eeg: s.eeg,
      },
      scrollS: Math.round((Date.now() - t0) / 1000),
    }),
  );
}
mkdirSync(join(os.tmpdir(), "tinker-real-data"), { recursive: true });
writeFileSync(join(os.tmpdir(), "tinker-real-data", "console.log"), consoleLines.join("\n"));
await browser.close();
