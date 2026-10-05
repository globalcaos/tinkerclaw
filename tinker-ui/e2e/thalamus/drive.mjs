/**
 * Drives the built tinker-ui against mock-gateway.mjs through every state of the Thalamus v4 block (charter phase G) and
 * writes screenshots. Never touches a real gateway: the page's WebSocket goes to the mock on the same host and port.
 *
 * Usage: node drive.mjs --url http://127.0.0.1:18996 --out <screens dir>
 * Exit code 1 when an assertion fails.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const URL_ = args.url ?? "http://127.0.0.1:18996";
const OUT = args.out ?? "/tmp/t4-e2e/screens";
mkdirSync(OUT, { recursive: true });

import { EMPTY, panel, uses } from "./fixtures.mjs";

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};
const post = (path, body) =>
  fetch(`${URL_}${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }).then((r) =>
    r.json(),
  );
const calls = async () =>
  (await fetch(`${URL_}/__mock/calls`).then((r) => r.json())).map((c) => c.method);

// ── the browser ─────────────────────────────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const pageErrors = [];
async function open(label) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${label}: ${e}`));
  await page.goto(`${URL_}/tinker/`, { waitUntil: "load" });
  await page.waitForFunction(
    () => (document.getElementById("thalamus-panel-body")?.innerHTML.length ?? 0) > 200,
    null,
    { timeout: 15000 },
  );
  return { ctx, page };
}
const settle = (page, ms = 1500) => page.waitForTimeout(ms);
/** The right rail as a reader sees it, scrolled to `focus` (default: the Thalamus v4 block). */
const shot = async (page, name, focus = "#thalamus-panel-body .thalamus-v4") => {
  await page
    .locator(focus)
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await page.waitForTimeout(150);
  await page.screenshot({
    path: join(OUT, name),
    clip: { x: 1078, y: 0, width: 422, height: 1100 },
  });
};
const body = (page) =>
  page.evaluate(() => document.getElementById("thalamus-panel-body").innerHTML);
const text = (page, sel = "#thalamus-panel-body") =>
  page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
/** Text as a reader sees it, on one line: cells of a row are joined by spaces, and group labels (drawn in capitals) in lower case. */
const norm = async (page, sel = "#thalamus-panel-body") =>
  (await text(page, sel)).replace(/\s+/g, " ").trim();
const v4 = (page) => page.locator("#thalamus-panel-body .thalamus-v4");
const openKeys = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#thalamus-panel-body details[open]")].map((d) => d.dataset.t4),
  );

// 1. OFF: a gateway without the plugin. The card is what it was: no v4 block, and the gateway is left alone.
await post("/__mock/state", { thalamus: "absent" });
await calls();
{
  const { ctx, page } = await open("off");
  await settle(page, 2500);
  check((await v4(page).count()) === 0, "off: no Thalamus v4 block in the card");
  check(!(await body(page)).includes("thalamus-v4"), "off: no v4 markup anywhere in the card body");
  check(
    (await text(page)).includes("THALAMUS would route"),
    "off: the card itself is still drawn (the routing line is there)",
  );
  const made = (await calls()).filter((m) => m.startsWith("thalamus."));
  check(
    made.length === 1 && made[0] === "thalamus.panel",
    `off: asked once and only for thalamus.panel (asked: ${made.join(",")})`,
  );
  await settle(page, 6000);
  check(
    (await calls()).filter((m) => m.startsWith("thalamus.")).length === 0,
    "off: not asked again within six seconds (it backs off)",
  );
  await shot(page, "01-off.png", "#thalamus-panel-body");
  await ctx.close();
}

// 2. SHADOW with data, closed: one line that is always true, everything else behind it.
await post("/__mock/state", { thalamus: "ok", panel: panel() });
{
  const { ctx, page } = await open("shadow-closed");
  await page.waitForSelector("#thalamus-panel-body .thalamus-v4", { timeout: 20000 });
  const line = (await text(page, "#thalamus-panel-body .thalamus-v4 summary"))
    .replace(/\s+/g, " ")
    .trim();
  check(
    line.endsWith("Thalamus: shadow · 14 calls today · would have changed 3"),
    `shadow: the closed line reads "${line}"`,
  );
  check((await openKeys(page)).length === 0, "shadow: everything starts closed");
  const visible = await page.evaluate(() => {
    const b = document.querySelector("#thalamus-panel-body .thalamus-v4");
    const closedRows = [...b.querySelectorAll("details:not([open])")].length;
    return {
      hidden: b.querySelector("details > div")?.getBoundingClientRect().height ?? -1,
      closedRows,
    };
  });
  check(
    visible.hidden === 0 || visible.hidden === -1 || visible.closedRows > 0,
    "shadow: the detail is not on screen until asked for",
  );
  await shot(page, "02-shadow-closed.png");

  // 3. Expanded: recent calls, short lists, the plan.
  await page.locator('#thalamus-panel-body details[data-t4="t4:block"] > summary').click();
  await settle(page, 400);
  const t = await norm(page);
  const tl = t.toLowerCase();
  check(
    tl.includes("recent calls · 5 calls") &&
      tl.includes("short lists · 3 tasks") &&
      tl.includes(" plan "),
    "expanded: the three groups are there",
  );
  check(
    (await page.locator("#thalamus-panel-body details[data-t4^='t4:d:']").count()) === 5,
    "expanded: one row per recent call (5)",
  );
  check(
    t.includes("would move opus-5 → sonnet-5-5 · cache cold"),
    "expanded: a call row says what would happen and why, in a few words",
  );
  check(
    t.includes("stays on opus-5 · you picked it"),
    "expanded: a hand-picked model says it stays",
  );
  const tooltip = await page
    .locator('#thalamus-panel-body details[data-t4="t4:d:run-0:0"] > summary')
    .getAttribute("title");
  check(
    tooltip.includes(
      "would move opus-5 → sonnet-5-5 · cache cold — the old model's cache had gone cold anyway",
    ),
    "expanded: the row's tooltip carries the whole sentence",
  );
  await shot(page, "03-expanded.png");

  await page.locator('#thalamus-panel-body details[data-t4="t4:d:run-0:0"] > summary').click();
  await settle(page, 300);
  const d0 = await norm(page, '#thalamus-panel-body details[data-t4="t4:d:run-0:0"]');
  check(
    d0.includes("✓ claude-sonnet-5-5 medium chosen") && d0.includes("claude-opus-5 high now"),
    "call detail: the chosen option is marked and the current model named",
  );
  check(
    d0.includes("Ruled out: gpt-6-astra (private source)") && d0.includes("kind of work: code"),
    "call detail: vetoes and reads are in words",
  );
  await page.locator('#thalamus-panel-body details[data-t4="t4:d:run-4:0"] > summary').click();
  await settle(page, 300);
  const d4 = await text(page, '#thalamus-panel-body details[data-t4="t4:d:run-4:0"]');
  check(
    d4.includes("The reader was unsure, so it played safe.") &&
      d4.includes("A reserved model was opened: feasibility."),
    "call detail: a cautious read and a reserved model are said plainly",
  );
  await shot(page, "04-call-detail.png");

  const lists = (await norm(page)).toLowerCase();
  check(
    lists.includes("short lists · 3 tasks · recorded, not shown to the agent"),
    "short lists: shadow says the list was recorded and not shown",
  );
  await page.locator('#thalamus-panel-body details[data-t4="t4:u:t1"] > summary').click();
  await settle(page, 300);
  const u1 = await norm(page, '#thalamus-panel-body details[data-t4="t4:u:t1"]');
  check(
    u1.includes("#1 translation-checker (skill) · made for it 62%") &&
      u1.includes("#2 ✓ photo-sorter (recipe) · fits by structure 20%") &&
      u1.includes("covers part of it"),
    "short list: rank, name, fit in words, probability",
  );
  check(
    u1.includes("Used: photo-sorter, it was second on the list.") &&
      u1.includes("None of these fits: 10%."),
    "short list: what the agent used and its place; the chance none fit",
  );
  await page.locator('#thalamus-panel-body details[data-t4="t4:u:t2"] > summary').click();
  await page.locator('#thalamus-panel-body details[data-t4="t4:u:t3"] > summary').click();
  await settle(page, 300);
  const u23 = await norm(page);
  check(
    u23.includes("shown in a shuffled order") &&
      u23.includes("From a private source: ranked locally") &&
      u23.includes("It had to retry."),
    "short list: a shuffled, private, retried task says so",
  );
  check(
    u23.includes("used unlisted-helper (not on the list)") && u23.includes("You corrected it."),
    "short list: an off-list pick and a correction are said plainly",
  );
  await shot(page, "05-short-lists.png", '#thalamus-panel-body details[data-t4="t4:u:t1"]');

  await page.locator('#thalamus-panel-body details[data-t4="t4:p:contract"] > summary').click();
  await settle(page, 300);
  const p = await text(page, '#thalamus-panel-body details[data-t4="t4:p:contract"]');
  check(
    /Latest plan · \d+ steps · about 3(\.\d)? min · 1 hedge \(would send\)/.test(
      p.replace(/\s+/g, " "),
    ),
    `plan: the summary counts steps, time and the hedge it would send ("${p.split("\n")[0]}")`,
  );
  check(
    (await page
      .locator("#thalamus-panel-body details[data-t4^='t4:p:'] span[title^='on the critical path']")
      .count()) >= 4,
    "plan: critical-path steps are marked",
  );
  check(
    (await page
      .locator("#thalamus-panel-body details[data-t4^='t4:p:'] span[style*='dashed']")
      .count()) >= 1,
    "plan: the hedge copy is a dashed bar",
  );
  await shot(page, "06-plan.png", '#thalamus-panel-body details[data-t4="t4:p:contract"]');

  // 7. Open rows survive a refresh (the panel asks again every 15 seconds, and is drawn again each time).
  const before = (await openKeys(page)).toSorted();
  await post("/__mock/state", { panel: panel({ today: { calls: 15, wouldChange: 3 } }) });
  await page.waitForFunction(
    () =>
      document
        .querySelector("#thalamus-panel-body .thalamus-v4 summary")
        ?.innerText.includes("15 calls today"),
    null,
    { timeout: 40000 },
  );
  check(
    JSON.stringify((await openKeys(page)).toSorted()) === JSON.stringify(before),
    `refresh: the ${before.length} open rows are still open after the panel redraws`,
  );
  await shot(page, "07-after-refresh.png");

  // 8. A gateway error replaces the line with one quiet sentence, and it recovers.
  await post("/__mock/state", { thalamus: "error", message: "gateway timed out" });
  await page.waitForFunction(
    () =>
      document
        .querySelector("#thalamus-panel-body .thalamus-v4")
        ?.innerText.includes("not answering right now"),
    null,
    { timeout: 40000 },
  );
  check(
    !(await text(page)).includes("Recent calls"),
    "error: the detail is gone, only the quiet line is left",
  );
  await shot(page, "08-error.png");
  await post("/__mock/state", { thalamus: "ok", panel: panel() });
  await page.waitForFunction(
    () =>
      document
        .querySelector("#thalamus-panel-body .thalamus-v4")
        ?.innerText.includes("14 calls today"),
    null,
    { timeout: 40000 },
  );
  check(true, "recovery: the block comes back when the gateway answers again");
  await ctx.close();
}

// 4. EMPTY: a plugin that is running but has recorded nothing.
await post("/__mock/state", { thalamus: "ok", panel: EMPTY });
{
  const { ctx, page } = await open("empty");
  await page.waitForSelector("#thalamus-panel-body .thalamus-v4", { timeout: 20000 });
  await page.locator('#thalamus-panel-body details[data-t4="t4:block"] > summary').click();
  await settle(page, 300);
  const t = await text(page, "#thalamus-panel-body .thalamus-v4");
  check(
    t.includes("Thalamus: shadow · no calls yet today") && t.includes("Nothing recorded yet."),
    "empty: says there is nothing yet, not a blank box",
  );
  await shot(page, "09-empty.png");
  await ctx.close();
}

// 5. A gateway error from the start.
await post("/__mock/state", { thalamus: "error", message: "gateway timed out" });
{
  const { ctx, page } = await open("error");
  await page.waitForSelector("#thalamus-panel-body .thalamus-v4", { timeout: 20000 });
  check(
    (await text(page, "#thalamus-panel-body .thalamus-v4")).includes(
      "Thalamus: not answering right now",
    ),
    "error at start: one quiet line",
  );
  await page.locator('#thalamus-panel-body details[data-t4="t4:block"] > summary').click();
  await settle(page, 300);
  check(
    (await text(page, "#thalamus-panel-body .thalamus-v4")).includes(
      "It could not be read just now: gateway timed out. It will try again.",
    ),
    "error at start: the reason is one click away",
  );
  await shot(page, "10-error-open.png");
  await ctx.close();
}

// 6. ENFORCE: the list is said to be shown.
await post("/__mock/state", {
  thalamus: "ok",
  panel: panel({ mode: "enforce", uses: uses.map((u) => ({ ...u, mode: "enforce" })) }),
});
{
  const { ctx, page } = await open("enforce");
  await page.waitForSelector("#thalamus-panel-body .thalamus-v4", { timeout: 20000 });
  await page.locator('#thalamus-panel-body details[data-t4="t4:block"] > summary').click();
  await settle(page, 300);
  const t = await norm(page, "#thalamus-panel-body .thalamus-v4");
  check(
    t.includes("Thalamus: enforcing") &&
      t.toLowerCase().includes("short lists · 3 tasks · shown to the agent"),
    "enforce: the mode word changes and the lists say they were shown",
  );
  await shot(page, "11-enforce.png");
  await ctx.close();
}

// Nothing the page asked of the gateway was anything but the panel's one method.
check(
  pageErrors.length === 0,
  `no page errors (${pageErrors.length})${pageErrors.length ? `: ${pageErrors[0]}` : ""}`,
);
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASSED");
process.exit(failures.length ? 1 : 0);
