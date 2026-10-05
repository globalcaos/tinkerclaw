/**
 * The Gantt tab end to end in Chromium (FORK 2026-10-05, the architect: "a dedicated tab to visualize [the
 * gantt] … a slither tab (only a graph icon) between master and slave … attached to the master …
 * connected in real time to the ongoing process").
 *
 * Touches nothing live. It builds a temporary HOME holding a synthetic build plan, a synthetic
 * Claude Code workflow journal (one finished unit, one still running) and the board that attaches
 * the plan to a chat; starts the chat-viewport mock gateway; starts THIS checkout's tinker-prod-ui
 * on a spare port with that HOME, pointed at the mock; and drives the built page.
 *
 *  1. The master of a chain gets an icon-only tab right after it, before its slave; it is not a chat
 *     tab (no data-tab-id).
 *  2. Clicking it covers the chat with the chart; the icon tab is the active one, the master is not.
 *  3. The chart: the finished phase starts folded, the running one open, and "Running now" names
 *     the running unit.
 *  4. Unfolding a phase shows its lanes; clicking a lane opens the drawer with what the unit was
 *     asked and what it reported.
 *  5. Real time: when the running unit reports, the chart redraws within one refresh, keeping the
 *     phase the user unfolded and the open drawer.
 *  6. Clicking the master goes back to the chat and unloads the chart.
 *  7. Deleting the master session drops its board, and the Gantt tab goes with it.
 *  8. The machines panel (the architect, 2026-10-05: "a little section where I can see the available
 *     machines for this project … if we have a healthy connection to them … the resources used by
 *     us"): under the chart, one row per machine through a fake ssh; ours counted (a busy process
 *     in a runner folder, its disk); an unreachable machine red with ssh's reason, one behind it
 *     blamed on it; the top-bar chip names it and scrolls to the panel; a plan that uses only this
 *     machine shows no panel.
 *
 * Usage: (cd tinker-ui && npx vite build) && node tinker-ui/e2e/gantt-tab/drive.mjs [--shots DIR]
 * Exit code 1 when an assertion fails.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const SHOTS = args.shots ?? null;
const GW_PORT = 18991;
const UI_PORT = 18992;
const MASTER = "agent:main:tinker:mockb";
const SLAVE = "agent:main:tinker:mockc";
const WF = "wf_e2e-gantt";

const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(what);
};

// ─── Fixture: a plan with a finished phase, a running phase and a planned one ───
const home = mkdtempSync(join(tmpdir(), "gantt-e2e-"));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const min = 60_000;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
/** One Claude Code workflow folder: a journal plus one transcript and meta file per unit. */
const workflow = (wf, units) => {
  const dir = join(home, ".claude/projects/p/s/subagents/workflows", wf);
  mkdirSync(dir, { recursive: true });
  const journal = [{ type: "launched" }];
  for (const u of units) {
    const task = `[Workflow harness — computed task] … The computed task text follows:\n  \n  ${u.task}`;
    writeFileSync(
      join(dir, `agent-${u.id}.jsonl`),
      jsonl([
        { type: "user", timestamp: iso(u.from), message: { content: task } },
        { type: "assistant", timestamp: iso((u.from + u.to) / 2), message: { content: "working" } },
        { type: "assistant", timestamp: iso(u.to), message: { content: "done" } },
      ]),
    );
    writeFileSync(
      join(dir, `agent-${u.id}.meta.json`),
      JSON.stringify({ model: "claude-code/claude-sonnet-5-5" }),
    );
    journal.push({ type: "started", agentId: u.id, label: u.label });
    if (u.result) journal.push({ type: "result", agentId: u.id, result: u.result });
  }
  writeFileSync(join(dir, "journal.jsonl"), jsonl(journal));
  return join(dir, "journal.jsonl");
};
workflow(`${WF}-a`, [
  {
    id: "a1",
    label: "build A1 parser",
    from: 300 * min,
    to: 240 * min,
    task: "Write the A1 parser and its tests.",
    result: { unit: "A1", head: "abc1234", summary: "Parser written; 12 tests green." },
  },
  {
    id: "a1r",
    label: "review A1 parser",
    from: 235 * min,
    to: 220 * min,
    task: "Review the A1 parser.",
    result: { verdict: "pass" },
  },
]);
// B1 started three minutes ago, wrote a line twelve seconds ago, and has not reported: running.
const journalB = workflow(`${WF}-b`, [
  {
    id: "b1",
    label: "build B1 exporter",
    from: 3 * min,
    to: 0.2 * min,
    task: "Write the B1 exporter.",
  },
]);
// Machines: a fake ssh runs the probe here for "runner1", fails like a dead lab host for "gone",
// and puts "behind" behind "gone" (ssh -G says so), so its error must blame the gateway.
const runnerDir = join(home, "runner");
mkdirSync(join(runnerDir, "slot"), { recursive: true });
writeFileSync(join(runnerDir, "slot", "data.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
const fakeSsh = join(home, "bin", "fake-ssh");
mkdirSync(dirname(fakeSsh), { recursive: true });
writeFileSync(
  fakeSsh,
  `#!/bin/sh
if [ "$1" = "-G" ]; then [ "$2" = behind ] && echo "proxyjump gone" || echo "proxyjump none"; exit 0; fi
while [ "$1" = "-o" ]; do shift 2; done
host="$1"; shift
case "$host" in gone|behind) echo "ssh: connect to host $host port 22: No route to host" >&2; exit 255 ;; esac
exec "$@"
`,
);
chmodSync(fakeSsh, 0o755);
const machines = [
  { name: "This one", host: "local", role: "the worker", dirs: [join(home, "plan")] },
  { name: "Runner", host: "runner1", role: "test runner", dirs: [runnerDir] },
  { name: "Gone", host: "gone", role: "the lab gateway" },
  { name: "Behind", host: "behind", role: "a runner behind the gateway", dirs: [runnerDir] },
];

const plan = join(home, "plan", "gantt.json");
mkdirSync(dirname(plan), { recursive: true });
writeFileSync(
  plan,
  JSON.stringify({
    machines,
    title: "E2E build",
    phases: [
      { id: "A", label: "A · Parser", kind: "build", workflows: [`${WF}-a`] },
      { id: "B", label: "B · Export", kind: "build", workflows: [`${WF}-b`] },
      {
        id: "C",
        label: "C · Manual",
        kind: "manual",
        status: "planned",
        tasks: [{ label: "C1 write the manual", est_hours: 2 }],
      },
    ],
  }),
);
const planBefore = readFileSync(plan, "utf8");

const boards = join(home, ".openclaw/data/gantt-boards.json");
mkdirSync(dirname(boards), { recursive: true });
writeFileSync(boards, JSON.stringify({ boards: { [MASTER]: { plan, title: "E2E build" } } }));
const tabsSeed = [
  { id: "tab-main", sessionKey: "agent:main:main", title: "🏠 Main", isAttached: true },
  { id: "tab-m", sessionKey: MASTER, title: "Master", isAttached: true },
  { id: "tab-s", sessionKey: SLAVE, title: "Worker", isAttached: true },
];
const choices = {
  "tab:active": "tab-m",
  "loop:chains": JSON.stringify([
    { master: "tab-m", slave: "tab-s", color: 1, masterKey: MASTER, slaveKey: SLAVE },
  ]),
};
writeFileSync(
  join(home, ".openclaw/data/tinker-ui-state.json"),
  JSON.stringify({ tabs: tabsSeed, choices, flags: {}, collapsed: {}, closedTabs: {} }),
);

// ─── Servers ───
const procs = [];
const start = (cmd, argv, env, ready) =>
  new Promise((ok, fail) => {
    const child = spawn(cmd, argv, {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(child);
    let out = "";
    const t = setTimeout(() => fail(new Error(`${argv[0]} did not start: ${out}`)), 15_000);
    const on = (d) => {
      out += d;
      if (ready.test(out)) {
        clearTimeout(t);
        ok();
      }
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
  });
const cleanup = () => {
  for (const c of procs) c.kill();
  rmSync(home, { recursive: true, force: true });
};
process.on("exit", cleanup);

await start(
  "node",
  [
    "tinker-ui/e2e/chat-viewport/mock-gateway.mjs",
    "--port",
    String(GW_PORT),
    "--dist",
    "tinker-ui/dist",
  ],
  {},
  /127\.0\.0\.1|listening|mock/i,
);
await start(
  "node",
  ["scripts/tinker-prod-ui.mjs"],
  {
    HOME: home,
    TINKER_PROD_PORT: String(UI_PORT),
    TINKER_GATEWAY_PORT: String(GW_PORT),
    OPENCLAW_GATEWAY_TOKEN: "mock",
    GANTT_SSH: fakeSsh,
  },
  /production Tinker/,
);
// A process of ours on "Runner": it works inside the runner folder and keeps one core busy.
const busy = spawn("node", ["-e", "for(;;){}"], { cwd: join(runnerDir, "slot"), stdio: "ignore" });
procs.push(busy);

// ─── Drive ───
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
await ctx.addInitScript(
  ([tabs, ch]) => {
    if (!localStorage.getItem("tinker-tabs")) {
      localStorage.setItem("tinker-tabs", JSON.stringify(tabs));
      localStorage.setItem("tinker.uiChoices", JSON.stringify(ch));
    }
  },
  [tabsSeed, choices],
);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(`http://127.0.0.1:${UI_PORT}/tinker/?token=mock`);
await page.waitForSelector('[data-tab-id="tab-m"]', { timeout: 20_000 });

// 1
const gantt = page.locator('[data-gantt-for="tab-m"]');
await gantt.waitFor({ timeout: 25_000 }).catch(() => {});
const order = await page.evaluate(() =>
  [...document.querySelectorAll("#tab-bar-scroll > *")].map(
    (el) => el.getAttribute("data-tab-id") ?? `gantt:${el.getAttribute("data-gantt-for")}`,
  ),
);
check(
  order.join(",") === "tab-main,tab-m,gantt:tab-m,tab-s",
  "1. the Gantt tab sits between the master and its slave",
  order.join(","),
);
const box = await gantt.boundingBox();
check(
  !!box && box.width >= 24 && box.width <= 40,
  "1. it is a sliver, icon only, wide enough to hit",
  box ? `${Math.round(box.width)} px wide` : "missing",
);
check(
  (await gantt.getAttribute("data-tab-id")) === null,
  "1. it is not a chat tab (no data-tab-id)",
);
if (SHOTS)
  await page.locator("#tab-bar-scroll").screenshot({ path: join(SHOTS, "gantt-tabbar.png") });

// 2
await gantt.click();
await page.waitForSelector("#gantt-view:not([hidden])", { timeout: 5_000 }).catch(() => {});
const pane = await page.evaluate(() => {
  const v = document.getElementById("gantt-view");
  const r = v?.getBoundingClientRect();
  // The pane fills the chat area inside its border (inset: 0 is the padding box).
  const chat = document.querySelector(".chat-area");
  return {
    hidden: v?.hidden,
    w: r?.width,
    h: r?.height,
    cw: chat?.clientWidth,
    ch: chat?.clientHeight,
    src: v?.querySelector("iframe")?.getAttribute("src"),
  };
});
check(
  pane.hidden === false &&
    Math.round(pane.w) === pane.cw &&
    Math.round(pane.h) === Math.round(pane.ch),
  "2. the chart covers the chat area",
  JSON.stringify(pane),
);
check(
  String(pane.src).includes(encodeURIComponent(MASTER)),
  "2. it loads the master's own chart",
  pane.src,
);
const actives = await page.evaluate(() =>
  [...document.querySelectorAll("#tab-bar-scroll .tab-active")].map(
    (e) => e.getAttribute("data-tab-id") ?? "gantt",
  ),
);
check(
  actives.join(",") === "gantt",
  "2. the Gantt tab is active, the master is not",
  actives.join(","),
);

// 3
const frame = page.frameLocator("#gantt-view iframe");
await frame.locator(".bg h1").waitFor({ timeout: 20_000 });
check(
  (await frame.locator(".bg h1").textContent()) === "E2E build",
  "3. the chart is the attached plan",
);
const hidA = await frame
  .locator('.lab.ln[data-in="A"]')
  .evaluateAll((els) => els.map((e) => e.classList.contains("hid")));
const hidB = await frame
  .locator('.lab.ln[data-in="B"]')
  .evaluateAll((els) => els.map((e) => e.classList.contains("hid")));
check(
  hidA.length > 0 && hidA.every(Boolean),
  "3. the finished phase starts folded",
  JSON.stringify(hidA),
);
check(
  hidB.length > 0 && hidB.every((h) => !h),
  "3. the running phase starts open",
  JSON.stringify(hidB),
);
const chip = await frame.locator("#now .c").allTextContents();
check(
  chip.length === 1 && chip[0].includes("B1"),
  "3. Running now names the running unit",
  chip.join(" | "),
);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "gantt-chart.png") });

// 4
await frame.locator('.lab.tg[data-ph="A"]').click();
const hidA2 = await frame
  .locator('.lab.ln[data-in="A"]')
  .evaluateAll((els) => els.map((e) => e.classList.contains("hid")));
check(
  hidA2.every((h) => !h),
  "4. a click unfolds the finished phase",
);
await frame.locator('.lab.ln[data-in="A"]').first().click();
await frame
  .locator("#drawer.open .unit .sum")
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => {});
const drawer = await frame.locator("#drawer").textContent();
check(
  drawer.includes("Parser written; 12 tests green."),
  "4. the drawer shows what the unit reported",
);
check(drawer.includes("Write the A1 parser and its tests."), "4. and what it was asked to do");
check(
  drawer.includes("claude-sonnet-5-5") && drawer.includes("abc1234"),
  "4. with its model and commit",
);
if (SHOTS) await page.screenshot({ path: join(SHOTS, "gantt-drawer.png") });

// 5 — the running unit reports; the next refresh (15 s, server cache 8 s) must show it
appendFileSync(
  journalB,
  JSON.stringify({ type: "result", agentId: "b1", result: { summary: "Exporter done." } }) + "\n",
);
let gone = false;
for (let i = 0; i < 40 && !gone; i++) {
  await page.waitForTimeout(1000);
  gone = (await frame.locator("#now .c").count()) === 0;
}
check(gone, "5. the chart follows the work in real time (the unit's report ends its running bar)");
const keptOpen = await frame
  .locator('.lab.ln[data-in="A"]')
  .evaluateAll((els) => els.every((e) => !e.classList.contains("hid")));
check(keptOpen, "5. a refresh keeps the phase the user unfolded");
check((await frame.locator("#drawer.open").count()) === 1, "5. and keeps the drawer open");
check(readFileSync(plan, "utf8") === planBefore, "5. the plan file is never written by the tab");

// 8 — the machines panel, under the chart
await frame
  .locator('#machines .mrow[data-host="runner1"]')
  .waitFor({ timeout: 30_000 })
  .catch(() => {});
const layout = await frame.locator("body").evaluate(() => {
  const m = document.getElementById("machines");
  const c = document.getElementById("chart");
  return {
    shown: !!m && !m.hidden,
    after: !!(m && c && c.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING),
    rows: [...document.querySelectorAll("#machines .mrow")].map((r) => r.dataset.host),
  };
});
check(
  layout.shown && layout.after,
  "8. the machines panel shows at the end, under the chart",
  JSON.stringify(layout),
);
check(
  layout.rows.join(",") === "local,runner1,gone,behind",
  "8. one row per machine, in the plan's order",
  layout.rows.join(","),
);
const runner = frame.locator('#machines .mrow[data-host="runner1"]');
const runnerText = await runner.textContent();
check(
  (await runner.locator(".dot.ok").count()) === 1 && /connected · \d+ ms/.test(runnerText),
  "8. a reachable machine is green, with its round trip",
  runnerText.slice(0, 120),
);
const cells = await runner.locator(".mc").evaluateAll((els) => els.map((e) => e.dataset.m));
check(
  cells.join(",") === "CPU,RAM,GPU,Disk",
  "8. CPU, RAM, GPU and disk for each machine",
  cells.join(","),
);
// Our CPU: the busy loop is one core of this machine; our disk: the 3 MB file, measured in the background.
let usCpu = 0;
let usDisk = "";
for (let i = 0; i < 45 && !(usCpu > 0 && /us \d/.test(usDisk)); i++) {
  usCpu = Number(
    ((await runner.locator('[data-m="CPU"] .ms').textContent()) ?? "").match(/us (\d+)%/)?.[1] ?? 0,
  );
  usDisk = (await runner.locator('[data-m="Disk"] .ms').textContent()) ?? "";
  if (!(usCpu > 0 && /us \d/.test(usDisk))) await page.waitForTimeout(1000);
}
check(usCpu > 0, "8. our CPU counts the process working in our folder", `us ${usCpu}%`);
check(/us 3(\.\d)? MB/.test(usDisk), "8. our disk is the size of our folders", usDisk);
const usBar = await runner
  .locator('[data-m="CPU"] .mb .us')
  .evaluate((e) => parseFloat(e.style.width));
check(usBar > 0, "8. and the bar draws our share", `${usBar}%`);
const goneRow = frame.locator('#machines .mrow[data-host="gone"]');
const goneText = await goneRow.textContent();
check(
  (await goneRow.locator(".dot.down").count()) === 1 &&
    goneText.includes("No route to host") &&
    goneText.includes("never reached"),
  "8. an unreachable machine is red, with ssh's reason",
  goneText.slice(0, 160),
);
const behindText = await frame.locator('#machines .mrow[data-host="behind"]').textContent();
check(
  behindText.includes("through Gone, which is down too"),
  "8. a machine behind a dead gateway blames the gateway",
  behindText.slice(0, 160),
);
const mchip = frame.locator("#mchip");
check(
  (await mchip.getAttribute("class")) === "bad" &&
    (await mchip.textContent()).includes("Gone, Behind unreachable"),
  "8. the top-bar chip names the unreachable machines",
  await mchip.textContent(),
);
// The unit drawer from step 4 covers the right of the top bar; Esc closes it, as a person would.
await page.keyboard.press("Escape");
await frame.locator("body").evaluate(() => scrollTo(0, 0));
await mchip.click();
await page.waitForTimeout(1200);
const inView = await frame.locator("#machines").evaluate((m) => {
  const r = m.getBoundingClientRect();
  return r.top < innerHeight && r.bottom > 0;
});
check(inView, "8. clicking the chip scrolls to the machines");
if (SHOTS) await frame.locator("#machines").screenshot({ path: join(SHOTS, "gantt-machines.png") });
const showFor = (list) => {
  const p = join(home, "plan", `m-${list.length}.json`);
  writeFileSync(p, JSON.stringify({ title: "x", phases: [], ...(list ? { machines: list } : {}) }));
  const r = spawnSync("python3", ["skills/build-gantt/scripts/machines.py", p], {
    cwd: repo,
    env: { ...process.env, HOME: home, GANTT_SSH: fakeSsh },
    encoding: "utf8",
  });
  return JSON.parse(r.stdout || "{}").show;
};
check(
  showFor([machines[0]]) === false && showFor([]) === false,
  "8. a build that uses only this machine shows no panel",
);
check(readFileSync(plan, "utf8") === planBefore, "8. the panel never writes the plan file");

// 6
await page.locator('[data-tab-id="tab-m"]').click();
const back = await page.evaluate(() => ({
  hidden: document.getElementById("gantt-view")?.hidden,
  src: document.querySelector("#gantt-view iframe")?.getAttribute("src"),
  active: [...document.querySelectorAll("#tab-bar-scroll .tab-active")]
    .map((e) => e.getAttribute("data-tab-id") ?? "gantt")
    .join(","),
}));
check(
  back.hidden === true && back.src === "about:blank" && back.active === "tab-m",
  "6. clicking the master goes back to its chat",
  JSON.stringify(back),
);

// 7
await gantt.click();
await page.locator('[data-tab-id="tab-m"]').click({ button: "right" });
await page.locator('[data-tab-action="delete"]').click();
let dropped = false;
for (let i = 0; i < 20 && !dropped; i++) {
  await page.waitForTimeout(500);
  dropped = !readFileSync(boards, "utf8").includes(MASTER);
}
check(dropped, "7. deleting the master session drops its board");
check((await page.locator("[data-gantt-for]").count()) === 0, "7. and the Gantt tab with it");
check(
  await page.evaluate(() => document.getElementById("gantt-view")?.hidden === true),
  "7. and closes the chart",
);

check(pageErrors.length === 0, "no page errors", pageErrors.join(" | "));
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
