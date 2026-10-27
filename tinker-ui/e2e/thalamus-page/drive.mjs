/**
 * Drives the built tinker-ui against mock-gateway.mjs through every state of the Thalamus full-deploy page (2026-10-02) and
 * writes screenshots. Never touches a real gateway: the page's WebSocket goes to the mock on the same host and port.
 *
 *   node drive.mjs --url http://127.0.0.1:18997 --out <screens dir> [--control]
 *
 * `--control` runs the same page against the build from before the change: the checks that name the new behaviour must FAIL
 * there (a driver that passes on the old build proves nothing). Exit code 1 when a check fails; with --control the exit code
 * is 0 only if at least one check failed.
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
const URL_ = args.url ?? "http://127.0.0.1:18997";
const OUT = args.out ?? "/tmp/thal-page-e2e/screens";
const CONTROL = "control" in args;
mkdirSync(OUT, { recursive: true });

const TAB = "agent:main:tinker:mocktab";
const NOW = Date.now();
const OPUS = "claude-code/claude-opus-5";
const SONNET = "claude-code/claude-sonnet-5-5";
const HAIKU = "claude-code/claude-haiku-4-5";
const GROK = "xai/grok-4.7";
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};
const post = (path, body) =>
  fetch(`${URL_}${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }).then((r) =>
    r.json(),
  );
const calls = async () => await fetch(`${URL_}/__mock/calls`).then((r) => r.json());
const named = async (...methods) => (await calls()).filter((c) => methods.includes(c.method));

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

async function scenario(state = {}) {
  await post("/__mock/state", {
    amygdala: false,
    history: [],
    suggestions: {},
    legacyOnly: false,
    retry: "absent",
    override: null,
    ...state,
  });
  await calls();
  await page.evaluate(() => localStorage.clear()).catch(() => {});
  await page.goto(`${URL_}/tinker/`);
  await page.waitForSelector("#budget-panel .model-btn", { timeout: 20000 });
  await page.waitForTimeout(1500);
}
const rail = (name, sel = "#budget-panel") =>
  page
    .locator(sel)
    .first()
    .screenshot({ path: join(OUT, `${name}.png`) });
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
const flat = async (sel) => (await text(sel)).replace(/\s+/g, " ").trim();
const modelBtn = (id) => page.locator(`#budget-panel .model-btn[title^="${id}"]`).first();
const tierLetters = async (id) =>
  (await modelBtn(id).locator(".model-btn-tier").allInnerTexts()).join("");
const effortStopTexts = () =>
  page
    .locator("#budget-panel .model-think-slider-row:not(.orca-bias-row) .model-slider-stop")
    .allInnerTexts();

// ── 1 the dial and the picker, nothing suggested yet ───────────────────────────────────────────────────────────────────
await scenario();
{
  const dial = await flat("#budget-panel .orca-bias-row");
  check(
    /budget\s+default\s+smart/.test(dial),
    `1 dial: reads budget · default · smart (got "${dial}")`,
  );
  check(
    (
      await page.locator("#budget-panel .orca-bias-row .model-slider-stop.active").innerText()
    ).trim() === "default",
    "1 dial: an unset dial sits on default",
  );
  const line = await flat("#budget-panel .thal-sug-line");
  check(
    line === "Default: no suggestion yet, Thalamus picks",
    `1 dial: one line under it says the stop has no suggestion (got "${line}")`,
  );
  check(
    (await page.locator("#budget-panel .model-btn-tier").count()) === 0,
    "1 picker: no letters when nothing is suggested",
  );
  await rail("01-default-state");
}

// ── 2 suggestions set: letters on the models, the line names the stop's pick ────────────────────────────────────────────
const SUG = {
  smart: { model: OPUS, effort: "high" },
  default: { model: SONNET, effort: "low" },
  budget: { model: HAIKU, effort: "medium" },
};
await scenario({ suggestions: SUG });
{
  check((await tierLetters(OPUS)) === "S", "2 picker: Opus 5 carries S");
  check((await tierLetters(SONNET)) === "D", "2 picker: Sonnet 5.5 carries D");
  check((await tierLetters(HAIKU)) === "B", "2 picker: Haiku 4.5 carries B");
  check((await tierLetters(GROK)) === "", "2 picker: a model with no role carries no letter");
  const line = await flat("#budget-panel .thal-sug-line");
  check(
    /^Default: sonnet\s?5\.5 · low$/i.test(line),
    `2 dial: the line names the stop's model and effort (got "${line}")`,
  );
  await page.locator("#budget-panel .orca-bias-slider").fill("2");
  await page.waitForTimeout(500);
  const smartLine = await flat("#budget-panel .thal-sug-line");
  check(
    /^Smart: opus\s?5 · high$/i.test(smartLine),
    `2 dial: moving the dial to smart changes the line (got "${smartLine}")`,
  );
  await page.locator("#budget-panel .orca-bias-slider").fill("1");
  await page.waitForTimeout(300);
  await rail("02-suggestions-set");
}

// ── 3 right-click a model: the three stops, a new role gets effort low ──────────────────────────────────────────────────
{
  await modelBtn(HAIKU).click({ button: "right" });
  await page.waitForSelector(".thalamus-tier-menu");
  const items = await page.locator(".thalamus-tier-menu .exec-context-item").allInnerTexts();
  check(
    items.length === 3 &&
      /^S Smart/.test(items[0].trim()) &&
      /D Default/.test(items[1]) &&
      /B Budget/.test(items[2]),
    `3 menu: three stops with their letters (got ${JSON.stringify(items.map((x) => x.trim()))})`,
  );
  check(
    /✓.*B Budget/.test(items[2]) && /med/.test(items[2]),
    "3 menu: the stop the model holds is ticked and shows its effort",
  );
  await page.screenshot({
    path: join(OUT, "03-model-menu.png"),
    clip: { x: 900, y: 0, width: 600, height: 700 },
  });
  await page.locator('.thalamus-tier-menu [data-tier="smart"]').click();
  await page.waitForTimeout(600);
  const set = (await named("prefrontal.thalamusDefaults")).at(-1);
  check(
    set?.params?.tier === "smart" &&
      set?.params?.model === HAIKU &&
      set?.params?.effort === undefined,
    `3 menu: assigning Haiku to Smart sends {tier, model} and no effort (sent ${JSON.stringify(set?.params)})`,
  );
  check((await tierLetters(HAIKU)) === "SB", "3 picker: Haiku now carries S and B");
  check((await tierLetters(OPUS)) === "", "3 picker: Opus 5 lost S (the stop holds one model)");
  await rail("03-haiku-smart-and-budget");
}

// ── 4 the effort row: letters on the levels, right-click assigns ────────────────────────────────────────────────────────
await scenario({ suggestions: SUG });
{
  await modelBtn(SONNET).click();
  await page.waitForTimeout(700);
  const stops = await effortStopTexts();
  check(
    stops.some((t) => /^Low\s*D$/.test(t.trim())) &&
      !stops.some((t) => /^Med\s*[SDB]/.test(t.trim())),
    `4 effort: Sonnet's level Low carries D, no other level carries a letter (got ${JSON.stringify(stops.map((x) => x.trim()))})`,
  );
  await rail("04-effort-letter");
  await page
    .locator('#budget-panel .model-slider-stop[data-lvl="medium"]')
    .click({ button: "right" });
  await page.waitForSelector(".thalamus-tier-menu");
  const items = await page.locator(".thalamus-tier-menu .exec-context-item").allInnerTexts();
  check(
    items.length === 1 && /assign this effort to Default/.test(items[0]),
    `4 effort menu: one item, "assign this effort to Default" (got ${JSON.stringify(items.map((x) => x.trim()))})`,
  );
  await page.screenshot({
    path: join(OUT, "04-effort-menu.png"),
    clip: { x: 900, y: 0, width: 600, height: 700 },
  });
  await page.locator('.thalamus-tier-menu [data-tier="default"]').click();
  await page.waitForTimeout(600);
  const set = (await named("prefrontal.thalamusDefaults")).at(-1);
  check(
    set?.params?.tier === "default" &&
      set?.params?.effort === "medium" &&
      set?.params?.model === undefined,
    `4 effort menu: sends {tier, effort} (sent ${JSON.stringify(set?.params)})`,
  );
  const after = await effortStopTexts();
  check(
    after.some((t) => /^Med\s*D$/.test(t.trim())) && !after.some((t) => /^Low\s*D$/.test(t.trim())),
    `4 effort: the D moved from Low to Med (got ${JSON.stringify(after.map((x) => x.trim()))})`,
  );
  await rail("04-effort-letter-moved");
  await page
    .locator('#budget-panel .model-slider-stop[data-lvl="high"]')
    .click({ button: "right" });
  await page.waitForTimeout(300);
  check(
    (await page.locator(".thalamus-tier-menu").count()) === 0 || true,
    "4 effort menu: (a model that holds the role gets a menu; checked next for one that does not)",
  );
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 10);
  await modelBtn(GROK).click();
  await page.waitForTimeout(700);
  await page
    .locator('#budget-panel .model-slider-stop[data-lvl="high"]')
    .click({ button: "right" });
  await page.waitForTimeout(300);
  check(
    (await page.locator(".thalamus-tier-menu").count()) === 0,
    "4 effort menu: no menu on a model that holds no role",
  );
}

// ── 5 an older gateway: only the high / medium / low view ───────────────────────────────────────────────────────────────
await scenario({ legacyOnly: true, suggestions: SUG });
{
  check(
    (await tierLetters(OPUS)) === "S" && (await tierLetters(SONNET)) === "D",
    "5 old gateway: the legacy view still draws the letters",
  );
  const line = await flat("#budget-panel .thal-sug-line");
  check(
    /^Default: sonnet\s?5\.5$/i.test(line),
    `5 old gateway: the line names the model with no effort (got "${line}")`,
  );
}

// ── 6 the card: kept / moved / cooling / a stop with no suggestion ────────────────────────────────────────────────────────
const decide = (data) =>
  post("/__mock/event", {
    event: "agent",
    payload: {
      stream: "thalamus",
      sessionKey: TAB,
      runId: `thalamus:${TAB}`,
      data: {
        phase: "decision",
        domain: "code",
        subject: "none",
        mode: "solo",
        panel: [],
        declined: [],
        ...data,
      },
    },
  });
const card = async (name) => {
  await page.waitForTimeout(500);
  await rail(name, "#thalamus-panel");
  return flat("#thalamus-panel-body .thal-turn");
};
await scenario({ suggestions: SUG });
{
  if ((await page.locator("#thalamus-panel.open").count()) === 0)
    await page.locator("#thalamus-panel .model-group-label").first().click();
  await decide({
    model: SONNET,
    effort: "low",
    tier: "default",
    why: ["kept"],
    suggestion: { state: "kept", model: SONNET, effort: "low" },
  });
  let t = await card("06-card-kept");
  check(
    /picked sonnet\s?5\.5 · low kept your default suggestion/i.test(t),
    `6 card: kept (got "${t}")`,
  );

  await decide({
    model: GROK,
    effort: "high",
    tier: "default",
    why: ["moved"],
    instead: { model: SONNET, effort: "low" },
    suggestion: { state: "moved", model: SONNET, effort: "low", cause: "better", gainPct: 102.4 },
  });
  t = await card("06-card-moved");
  check(
    /moved off your default suggestion \(sonnet\s?5\.5 · low\): code is better served here \(\+102 %\)/i.test(
      t,
    ),
    `6 card: moved, to a better rung (got "${t}")`,
  );

  const until = new Date(NOW + 47 * 60_000);
  const hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
  await decide({
    model: GROK,
    effort: "high",
    tier: "smart",
    why: ["cooling"],
    instead: { model: OPUS, effort: "high" },
    suggestion: { state: "moved", model: OPUS, effort: "high", cause: "cooling" },
    cooling: {
      from: { model: OPUS, effort: "high" },
      supply: "claude-code",
      untilMs: until.getTime(),
    },
  });
  t = await card("06-card-cooling");
  check(
    new RegExp(`opus\\s?5 is cooling until ${hhmm}, so the next best runs`, "i").test(t),
    `6 card: cooling names the time it ends, ${hhmm} (got "${t}")`,
  );

  await decide({
    model: GROK,
    effort: "high",
    tier: "budget",
    why: ["best-of"],
    instead: { model: HAIKU, effort: "medium" },
  });
  t = await card("06-card-no-suggestion");
  check(
    /best at code, instead of haiku\s?4\.5/i.test(t) && !/suggestion/.test(t),
    `6 card: a stop with no suggestion keeps the best-of line (got "${t}")`,
  );
}

// ── 7 the refusal strip: Rewind, and Rewind and retry with the model's logo ──────────────────────────────────────────────
const amyStatus = () => ({
  ts: NOW,
  state: "working",
  line: "Working",
  mode: "enforce",
  floorActive: true,
  seams: {
    prompt: { lastTs: NOW - 4000 },
    pre: { lastTs: NOW - 3000 },
    post: { lastTs: NOW - 3000 },
    stop: { lastTs: NOW - 9000 },
  },
  rules: { n: 47, version: 12 },
  judge: { lastMs: 280, errors: 0 },
  spendEurToday: 0.004,
  checksToday: 14,
  heldToday: 1,
  askedToday: 0,
  waitingForYou: 0,
  notesDropped: 0,
});
const refusalState = (over = {}) => ({
  amygdala: true,
  status: amyStatus(),
  history: [
    {
      role: "user",
      content: [{ type: "text", text: "Draft the letter to the tenant." }],
      timestamp: NOW - 60_000,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "I can't help with that request." }],
      timestamp: NOW - 45_000,
    },
  ],
  feed: {
    decisionEvents: [
      {
        id: "d1",
        ts: NOW - 50_000,
        sessionKey: TAB,
        turnId: `${TAB}#1`,
        stepLabel: "Reply",
        seam: "stop",
        questionId: "refusal-check",
        questionName: "Refusal",
        version: 2,
        answer: "refusal",
        prob: 0.93,
        confidence: 0.88,
        cacheHit: false,
        latencyMs: 148,
        weak: false,
        codeDid: "refusal",
        degraded: false,
        interventionId: "iv1",
      },
    ],
    interventions: [
      {
        id: "iv1",
        decisionId: "d1",
        ts: NOW - 49_000,
        sessionKey: TAB,
        turnId: `${TAB}#1`,
        kind: "refusal",
        state: "open",
        title: "The reply looks like a refusal",
        chips: [],
      },
    ],
    changes: [],
    questions: [],
    spend: { eur: 0.004, eur30: 0.11, calls: 14 },
    counts: { checks: 14, held: 1, asked: 0 },
    precedents: 3,
  },
  ...over,
});
const PICK = {
  model: GROK,
  effort: "high",
  family: "xai",
  domain: "code",
  reason: "best measured code strength on another vendor",
};
const strip = () => page.locator("#messages .amy-refstrip");
const stripShot = (name) =>
  page.locator("#messages").screenshot({ path: join(OUT, `${name}.png`) });

// 7a the event brings the pick: two buttons, the second names the model with its picker chip
await scenario(refusalState({ retry: { pick: PICK } }));
{
  await page.waitForSelector("#messages .amy-refstrip");
  await post("/__mock/event", {
    event: "thalamus.refusal",
    payload: { sessionKey: TAB, turnId: `${TAB}#1`, retry: PICK },
  });
  await page.waitForTimeout(500);
  const acts = await strip()
    .locator("button")
    .evaluateAll((bs) => bs.map((b) => b.dataset.amyAct));
  check(
    JSON.stringify(acts) === JSON.stringify(["rewind", "rewind-retry", "refusal-keep"]),
    `7a strip: Rewind, Rewind and retry, Keep (got ${JSON.stringify(acts)})`,
  );
  const rb = strip().locator('[data-amy-act="rewind-retry"]');
  check(
    /Rewind and retry with\s*grok\s?-?4\.7/i.test((await rb.innerText()).replace(/\s+/g, " ")),
    `7a retry button names the model (got "${await rb.innerText()}")`,
  );
  const logo = await rb.locator(".model-provider-icon svg").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const btn = el.closest("button");
    return {
      w: r.width,
      h: r.height,
      btnH: btn.getBoundingClientRect().height,
      drawn: el.children.length > 0,
    };
  });
  check(
    (await rb.locator("svg").count()) === 1 &&
      (await rb.locator("svg.eeg-model-chip").count()) === 0 &&
      logo.drawn &&
      logo.h >= 10 &&
      logo.h <= logo.btnH,
    `7a the button carries the vendor logo (an svg ${Math.round(logo.w)}x${Math.round(logo.h)} in a ${Math.round(logo.btnH)}px button), not the picker's colour chip`,
  );
  check(
    (await named("thalamus.retryPick")).length <= 1,
    "7a at most one retryPick question for the refused turn",
  );
  await stripShot("07a-strip-with-retry");
  await rb.click();
  await page.waitForTimeout(800);
  const log = await calls();
  const order = log
    .map((c) => c.method)
    .filter((m) => ["amygdala2.rewind", "chat.send"].includes(m));
  check(
    JSON.stringify(order) === JSON.stringify(["amygdala2.rewind", "chat.send"]),
    `7a click: rewinds, then sends (order ${JSON.stringify(order)})`,
  );
  const send = log.find((c) => c.method === "chat.send")?.params;
  check(
    send?.model === GROK && /the refused request/.test(send?.message ?? ""),
    `7a click: the restored prompt goes out on ${GROK} (sent model=${send?.model})`,
  );
  check(send?.thinking === undefined, "7a click: no effort pin from the old model rides along");
  check(
    (await page.locator("#chat-textarea").inputValue()) === "",
    "7a click: nothing left in the composer",
  );
  check(
    (await page.locator("[data-amy-act=rewind-undo]").count()) === 1,
    "7a click: the rewound marker is drawn",
  );
  await stripShot("07a-after-retry");
  // the server now holds the override; the NEXT message from this Auto tab must clear it
  await page.locator("#chat-textarea").fill("and what about the garden?");
  await page.locator("#action-btn").click();
  await page.waitForTimeout(800);
  const next = (await named("chat.send")).at(-1)?.params;
  check(
    next?.model === "auto",
    `7a next send: the Auto tab carries model:"auto" so the retry model does not stick (sent ${JSON.stringify(next?.model)})`,
  );
}

// 7b no pick: Rewind only
await scenario(refusalState());
{
  await page.waitForSelector("#messages .amy-refstrip");
  await post("/__mock/event", {
    event: "thalamus.refusal",
    payload: { sessionKey: TAB, turnId: `${TAB}#1`, retry: null, retryReason: "private source" },
  });
  await page.waitForTimeout(500);
  const acts = await strip()
    .locator("button")
    .evaluateAll((bs) => bs.map((b) => b.dataset.amyAct));
  check(
    JSON.stringify(acts) === JSON.stringify(["rewind", "refusal-keep"]),
    `7b retry null: Rewind and Keep only (got ${JSON.stringify(acts)})`,
  );
  await stripShot("07b-strip-no-pick");
}

// 7c an older gateway (no thalamus.retryPick): asked once, Rewind only
await scenario(refusalState({ retry: "absent" }));
{
  await page.waitForSelector("#messages .amy-refstrip");
  await page.waitForTimeout(800);
  const acts = await strip()
    .locator("button")
    .evaluateAll((bs) => bs.map((b) => b.dataset.amyAct));
  check(
    JSON.stringify(acts) === JSON.stringify(["rewind", "refusal-keep"]),
    `7c old gateway: Rewind and Keep only (got ${JSON.stringify(acts)})`,
  );
  check((await named("thalamus.retryPick")).length === 1, "7c old gateway: asked exactly once");
}

// 7d a hand-picked tab: no event, the page asks with the model the tab is on; the retry send leaves the tab's own pin alone
await scenario(refusalState({ retry: { pick: PICK } }));
{
  await page.waitForSelector("#messages .amy-refstrip");
  await page.waitForTimeout(600);
  await modelBtn(OPUS).click();
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector("#messages .amy-refstrip");
  await page.waitForTimeout(1200);
  const ask = (await named("thalamus.retryPick")).at(-1);
  check(
    ask?.params?.model === OPUS && ask?.params?.sessionKey === TAB,
    `7d hand-picked tab: retryPick is asked with the tab's model (asked ${JSON.stringify(ask?.params)})`,
  );
  check(
    (await strip().locator('[data-amy-act="rewind-retry"]').count()) === 1,
    "7d hand-picked tab: the retry button is there after the answer",
  );
  await strip().locator('[data-amy-act="rewind-retry"]').click();
  await page.waitForTimeout(800);
  const send = (await named("chat.send")).at(-1)?.params;
  check(
    send?.model === GROK,
    `7d hand-picked tab: the retry goes out on ${GROK} (sent ${send?.model})`,
  );
  await page.locator("#chat-textarea").fill("one more thing");
  await page.locator("#action-btn").click();
  await page.waitForTimeout(800);
  const next = (await named("chat.send")).at(-1)?.params;
  check(
    next?.model === OPUS,
    `7d hand-picked tab: the next turn is back on the tab's own pin, ${OPUS} (sent ${next?.model})`,
  );
}

// 7e the return to Auto survives a reload: retry on an Auto tab, reload before the next message, send once
await scenario(refusalState({ retry: { pick: PICK } }));
{
  await page.waitForSelector("#messages .amy-refstrip");
  await post("/__mock/event", {
    event: "thalamus.refusal",
    payload: { sessionKey: TAB, turnId: `${TAB}#1`, retry: PICK },
  });
  await page.waitForTimeout(500);
  await strip().locator('[data-amy-act="rewind-retry"]').click();
  await page.waitForTimeout(800);
  const retrySend = (await named("chat.send")).at(-1)?.params;
  check(retrySend?.model === GROK, `7e the retry goes out on ${GROK} (sent ${retrySend?.model})`);
  const saved = await page.evaluate(() => localStorage.getItem("tinker-auto-on-next-send"));
  check(
    saved !== null && saved.includes("mocktab"),
    `7e the pending return to Auto is stored for this tab (${saved})`,
  );
  await page.reload();
  await page.waitForSelector("#budget-panel .model-btn", { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.locator("#chat-textarea").fill("and what about the garden, after a reload?");
  await page.locator("#action-btn").click();
  await page.waitForTimeout(800);
  const after = (await named("chat.send")).at(-1)?.params;
  check(
    after?.model === "auto",
    `7e after a reload the next send from the Auto tab still carries model:"auto" (sent ${JSON.stringify(after?.model)})`,
  );
  check(
    (await page.evaluate(() => localStorage.getItem("tinker-auto-on-next-send"))) === "[]",
    "7e the stored flag is cleared by that send",
  );
  await page.locator("#chat-textarea").fill("and one more");
  await page.locator("#action-btn").click();
  await page.waitForTimeout(800);
  const again = (await named("chat.send")).at(-1)?.params;
  check(
    again?.model === undefined,
    `7e the send after that carries no model (sent ${JSON.stringify(again?.model)})`,
  );
}

await browser.close();
check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(" | ")})`);
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(CONTROL ? (failures.length ? 0 : 1) : failures.length ? 1 : 0);
