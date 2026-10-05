/**
 * Drives the built tinker-ui against mock-gateway.mjs through every amygdala state (design doc §9, Phase F) and writes
 * screenshots. Never touches a real gateway: the page's WebSocket goes to the mock on the same host and port.
 *
 * Usage: node drive.mjs --url http://127.0.0.1:18995 --out <screens dir> [--baseline-out <dir with dom snapshot>]
 * Exit code 1 when an assertion fails.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const URL_ = args.url ?? "http://127.0.0.1:18995";
const OUT = args.out ?? "/tmp/amy-e2e/screens";
mkdirSync(OUT, { recursive: true });

const TAB = "agent:main:tinker:mocktab";
const NOW = Date.now();
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
  (await fetch(`${URL_}/__mock/calls`).then((r) => r.json())).filter(
    (c) => c.method.startsWith("amygdala2.") || c.method === "amygdala2.rewind",
  );
const amyCalls = async () =>
  (await calls()).filter((c) => !["amygdala2.status", "amygdala2.feed"].includes(c.method));

const status = (over = {}) => ({
  ts: NOW,
  state: "working",
  line: "Working · 14 checks · 1 held · 0 asked · €0.004 today",
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
  ...over,
});
const dec = (id, turn, over = {}) => ({
  id,
  ts: NOW - 50_000 + Number(id.replace(/\D/g, "") || 0) * 300,
  sessionKey: TAB,
  turnId: `${TAB}#${turn}`,
  stepLabel: "Bash cp draft.docx final.docx",
  seam: "pre-tool",
  questionId: "danger-level",
  questionName: "Danger level",
  version: 2,
  answer: 3,
  prob: 0.93,
  confidence: 0.88,
  cacheHit: false,
  latencyMs: 148,
  weak: false,
  codeDid: "held",
  degraded: false,
  ...over,
});
const iv = (id, decisionId, kind, over = {}) => ({
  id,
  decisionId,
  ts: NOW - 49_000,
  sessionKey: TAB,
  turnId: `${TAB}#1`,
  kind,
  state: "open",
  title: "Held before it ran",
  chips: ["effect: overwrite", "target: your file"],
  ...over,
});
const userMsg = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const asstMsg = (text, ts) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: ts,
});
const toolMsgs = (id, cmd, ts) => [
  {
    role: "assistant",
    content: [
      { type: "text", text: "Checking the folder first." },
      { type: "tool_use", id, name: "Bash", input: { command: cmd } },
    ],
    timestamp: ts,
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
    timestamp: ts + 500,
  },
];
const basicChat = (ask = "Please tidy the draft folder.", reply = "Done — the folder is tidy.") => [
  userMsg(ask, NOW - 60_000),
  asstMsg(reply, NOW - 45_000),
];

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

async function scenario({ history, feed = {}, st = status(), amygdala = true }) {
  await post("/__mock/state", {
    history,
    feed: {
      decisionEvents: [],
      interventions: [],
      changes: [],
      questions: [],
      spend: { eur: 0.004, eur30: 0.11, calls: 14 },
      counts: { checks: 14, held: 1, asked: 0 },
      precedents: 3,
      ...feed,
    },
    status: st,
    amygdala,
  });
  await calls();
  await page.goto(`${URL_}/tinker/`);
  await page.waitForSelector("#messages");
  await page.waitForTimeout(1200);
}
const shot = async (name, sel) => {
  const loc = page.locator(sel).first();
  if ((await loc.count()) === 0) return check(false, `screenshot ${name}: ${sel} not found`);
  await loc.screenshot({ path: join(OUT, `${name}.png`) });
};
const click = async (sel) => {
  const loc = page.locator(sel).first();
  if ((await loc.count()) === 0) return check(false, `click target missing: ${sel}`);
  await loc.click();
  await page.waitForTimeout(300);
};

// ── inert: no amygdala methods on the gateway ────────────────────────────────────────────────────────────────────────
await scenario({ history: basicChat(), amygdala: false });
check(
  (await page.locator("[data-amy-turn], .amy-turn, .amy-panel, .amy-dot").count()) === 0,
  "inert: nothing of the new UI is drawn",
);
check((await page.locator("#amy-dot-host").innerHTML()) === "", "inert: the dot host is empty");
check(
  (await page.locator("#amygdala-body").innerText()).includes("Idle"),
  "inert: the v3.1 panel body is the v3.1 one",
);
writeFileSync(
  join(OUT, "inert-amygdala-panel.html"),
  await page.locator("#amygdala-panel").evaluate((e) => e.outerHTML),
);
writeFileSync(
  join(OUT, "inert-messages.html"),
  await page.locator("#messages").evaluate((e) => e.innerHTML),
);
await shot("00-inert", "body");

// ── 1 refusal → rewind ───────────────────────────────────────────────────────────────────────────────────────────────
await scenario({
  history: basicChat("Draft the letter to the tenant.", "I can't help with that request."),
  feed: {
    decisionEvents: [
      dec("d1", 1, {
        stepLabel: "Reply",
        seam: "stop",
        questionId: "refusal-check",
        questionName: "Refusal",
        answer: "refusal",
        codeDid: "refusal",
        interventionId: "iv1",
      }),
    ],
    interventions: [
      iv("iv1", "d1", "refusal", { title: "The reply looks like a refusal", chips: [] }),
    ],
  },
});
await shot("01-refusal", "#messages");
check(
  (await page.locator("[data-amy-act=rewind]").count()) === 1,
  "1 refusal: the Rewind button is drawn",
);
await click("[data-amy-act=rewind]");
const rw = (await amyCalls()).find((c) => c.method === "amygdala2.rewind");
check(rw?.params?.sessionKey === TAB, "1 rewind: gateway called with the tab key");
check(
  (await page.locator("#chat-textarea").inputValue()) === "the refused request",
  "1 rewind: the composer got the removed prompt back",
);
check(
  (await page.locator("[data-amy-act=rewind-undo]").count()) === 1,
  "1 rewind: a marker with Undo replaces the strip",
);
await shot("01-rewound", "#messages");
await click("[data-amy-act=rewind-undo]");
check(
  (await amyCalls()).some((c) => c.method === "amygdala2.rewind" && c.params?.undo === true),
  "1 rewind: Undo calls rewind with undo:true",
);

// ── 2 hold and proof ─────────────────────────────────────────────────────────────────────────────────────────────────
await scenario({
  history: basicChat(),
  feed: {
    decisionEvents: [
      dec("d1", 1, { codeDid: "held", interventionId: "iv1" }),
      dec("d2", 1, {
        stepLabel: "Write final.docx",
        questionId: "overwrites-real-work",
        questionName: "Overwrites real work",
        answer: "yes",
        prob: 0.81,
        codeDid: "proof",
        interventionId: "iv2",
      }),
    ],
    interventions: [
      iv("iv1", "d1", "hold", { cmd: "cp draft.docx final.docx" }),
      iv("iv2", "d2", "proof", {
        title: "Proof asked before overwriting",
        chips: ["file: final.docx"],
        cmd: "Write final.docx",
      }),
    ],
  },
  st: status({ waitingForYou: 2 }),
});
await shot("02-hold-proof", "#messages");
await click("[data-amy-act=why]");
await shot("02-hold-why", "#messages");
await click("[data-amy-act=answer][data-answer=allow-once]");
check(
  (await amyCalls()).some(
    (c) => c.method === "amygdala2.answer" && c.params?.answer === "allow-once",
  ),
  "2 hold: 'Run it once' sends answer allow-once",
);
await click("[data-amy-act=answer][data-answer=keep-held]");
check(
  (await amyCalls()).some(
    (c) => c.method === "amygdala2.answer" && c.params?.answer === "keep-held",
  ),
  "2 hold: 'Keep held' sends answer keep-held",
);

// ── 3 ask: which reading ─────────────────────────────────────────────────────────────────────────────────────────────
await scenario({
  history: basicChat("Send the quote to Jordi."),
  feed: {
    decisionEvents: [
      dec("d1", 1, {
        stepLabel: "Send the quote to Jordi",
        seam: "prompt",
        questionId: "which-reading",
        questionName: "Which reading",
        answer: "two",
        codeDid: "ask",
        interventionId: "iv1",
      }),
    ],
    interventions: [
      iv("iv1", "d1", "ask", {
        title: "Which Jordi?",
        chips: [],
        options: [
          { id: "jordi-a", label: "Jordi Puig (supplier)", hint: "wrote to you last week" },
          { id: "jordi-b", label: "Jordi Acme (family)" },
        ],
      }),
    ],
  },
});
await shot("03-ask", "#messages");
await click("[data-amy-act=ask-select][data-option=jordi-b]");
await click("[data-amy-act=ask-confirm]");
check(
  (await amyCalls()).some(
    (c) => c.method === "amygdala2.answer" && c.params?.answer === "option:jordi-b",
  ),
  "3 ask: select + confirm sends option:jordi-b",
);

// ── 4 sent back ──────────────────────────────────────────────────────────────────────────────────────────────────────
await scenario({
  history: basicChat("Is the invoice paid?", "Yes, it was paid on the 3rd."),
  feed: {
    decisionEvents: [
      dec("d1", 1, {
        stepLabel: "Reply",
        seam: "stop",
        questionId: "supported-by-sources",
        questionName: "Supported by sources",
        answer: "no",
        codeDid: "sent-back",
        interventionId: "iv1",
      }),
    ],
    interventions: [
      iv("iv1", "d1", "send-back", {
        title: "Sent back before you saw it",
        chips: ["claim: paid on the 3rd"],
      }),
    ],
  },
});
await post("/__mock/event", {
  event: "amygdala2.marker",
  payload: {
    kind: "unsupported-after-two",
    sessionKey: TAB,
    turnId: `${TAB}#1`,
    items: ["paid on the 3rd"],
    ts: NOW - 44_000,
  },
});
await page.waitForTimeout(400);
await shot("04-sent-back", "#messages");

// ── 5 notes on tool rows + 5b Jev window ────────────────────────────────────────────────────────────────────────────
const noteHistory = [
  userMsg("Check the folder.", NOW - 60_000),
  ...toolMsgs("toolu_note1", "ls /work/demo", NOW - 55_000),
  ...toolMsgs("toolu_note2", "cat notes.txt", NOW - 52_000),
  asstMsg("Here is what is in the folder.", NOW - 45_000),
];
await scenario({
  history: noteHistory,
  feed: {
    decisionEvents: [
      dec("d1", 1, {
        stepLabel: "Bash ls /work/demo",
        codeDid: "ok",
        answer: 0,
        prob: 0.02,
        questionId: "danger-level",
        toolUseId: "toolu_note1",
      }),
      dec("d2", 1, {
        stepLabel: "Bash cat notes.txt",
        codeDid: "note",
        questionId: "reads-private",
        questionName: "Reads something private",
        answer: "yes",
        prob: 0.7,
        toolUseId: "toolu_note2",
      }),
      dec("d3", 1, {
        stepLabel: "Reply",
        seam: "stop",
        codeDid: "ok",
        questionId: "supported-by-sources",
        questionName: "Supported by sources",
        answer: "yes",
        prob: 0.96,
        cacheHit: true,
      }),
      dec("d4", 1, {
        stepLabel: "Bash cat notes.txt",
        codeDid: "ok",
        questionId: "safe-to-repeat",
        questionName: "Safe to repeat",
        answer: "yes",
        prob: 0.55,
        weak: true,
        degraded: false,
      }),
    ],
  },
});
await page
  .locator(".reasoning-group summary, .reasoning-toggle, [data-reasoning-toggle]")
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(300);
await shot("05-notes-and-window-closed", "#messages");
check(
  (await page.locator(".amy-note-chip").count()) >= 1,
  "5 notes: a note chip rides on the tool row it judged",
);
await click("[data-amy-act=jev-toggle]");
await click("[data-amy-act=jev-row]");
await shot("05b-jev-window-open", ".amy-turn");

// ── 6 exceptional approval ──────────────────────────────────────────────────────────────────────────────────────────
await scenario({
  history: basicChat(),
  feed: {
    changes: [
      {
        id: "ch1",
        kind: "loosen",
        questionName: "Sends to a new address",
        from: "≥ 2",
        to: "≥ 3",
        exceptional: true,
        status: "pending",
        replaySummary: {
          cases: 12,
          relaxed: 9,
          tightened: 0,
          mustCatchLost: 0,
          controlsNewlyHeld: 0,
        },
      },
    ],
  },
  st: status({ waitingForYou: 1 }),
});
await shot("06-approval", "#messages");
await click("[data-amy-act=see-cases]");
await shot("06-approval-cases", "#messages");
await click("[data-amy-act=approve][data-yes='1']");
check(
  (await amyCalls()).some((c) => c.method === "amygdala2.approve" && c.params?.approve === true),
  "6 approval: 'Yes' sends approve:true",
);

// ── 7–8 panel closed and open, Learning + Undo, cost, canary ───────────────────────────────────────────────────────
const learning = [
  {
    id: "c1",
    kind: "context-loosen",
    questionName: "Danger level",
    from: "≥ 2",
    to: "≥ 3",
    exceptional: false,
    status: "applied",
    replaySummary: { cases: 7, relaxed: 6, tightened: 0, mustCatchLost: 0, controlsNewlyHeld: 0 },
    ts: NOW - 3_600_000,
  },
  {
    id: "c2",
    kind: "tighten",
    questionName: "Reads something private",
    from: "p ≥ 0.6",
    to: "p ≥ 0.5",
    exceptional: false,
    status: "applied",
    replaySummary: { cases: 4, relaxed: 0, tightened: 3, mustCatchLost: 0, controlsNewlyHeld: 0 },
    ts: NOW - 7_200_000,
  },
];
const questions = [
  { id: "danger-level", name: "Danger level", version: 2, today: 9, right: 0.92, status: "active" },
  {
    id: "reads-private",
    name: "Reads something private",
    version: 1,
    today: 5,
    right: null,
    status: "active",
  },
];
await scenario({ history: basicChat(), feed: { changes: learning, questions } });
await shot("07-panel-closed", "#amygdala-panel");
for (const acc of ["health", "today", "questions", "learning", "cost"])
  await click(`[data-amy-act=acc][data-acc=${acc}]`);
await shot("08-panel-open", "#amygdala-panel");
check(
  (await page.locator("[data-amy-act=undo]").count()) >= 1,
  "8 panel: Learning lists self-made changes with Undo",
);
await click("[data-amy-act=undo]");
check(
  (await amyCalls()).some((c) => c.method === "amygdala2.undo" && c.params?.changeId === "c1"),
  "8 panel: Undo sends amygdala2.undo for that change",
);
await click("[data-amy-act=canary]");
check(
  (await amyCalls()).some((c) => c.method === "amygdala2.canary"),
  "8 panel: Run canary calls amygdala2.canary",
);

// ── 9 degraded ──────────────────────────────────────────────────────────────────────────────────────────────────────
await scenario({
  history: basicChat(),
  st: status({
    state: "degraded",
    line: "Rules only — the judge is not answering · 14 checks",
    judge: { lastMs: null, errors: 4, silentSince: NOW - 600_000 },
    notesDropped: 2,
  }),
  feed: { changes: [], questions },
});
await click("[data-amy-act=acc][data-acc=health]");
await shot("09-panel-degraded", "#amygdala-panel");

// ── 10 the dot ──────────────────────────────────────────────────────────────────────────────────────────────────────
const dots = {
  green: status(),
  amber: status({ state: "shadow", mode: "shadow", line: "Watching only — nothing is enforced" }),
  red: status({
    state: "degraded",
    line: "Judge silent 10 min · hard rules still on",
    judge: { lastMs: null, errors: 4, silentSince: NOW - 600_000 },
  }),
};
for (const [name, st] of Object.entries(dots)) {
  await scenario({ history: basicChat(), st });
  await shot(`10-dot-${name}`, ".chat-input");
  const dotHtml = await page.locator("#amy-dot-host").innerHTML();
  console.log(`dot ${name}:`, dotHtml.slice(0, 120));
  const tip = (await page.locator("#amy-dot-host [title]").first().getAttribute("title")) ?? "";
  if (name === "red")
    check(
      !tip.startsWith("Working") && /Judge silent/.test(tip),
      `10 dot red: tooltip names the fault (${tip})`,
    );
  if (name === "green")
    check(tip.startsWith("Working"), `10 dot green: tooltip says Working (${tip})`);
}
await click("[data-amy-act=dot]");
check(
  !(await page.locator("#amygdala-panel").evaluate((e) => e.classList.contains("collapsed"))),
  "10 dot: a click brings the panel into view",
);
await page.waitForTimeout(200);
await shot("11-full-page", "body");

check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(" | ")})`);
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASSED");
process.exit(failures.length ? 1 : 0);
