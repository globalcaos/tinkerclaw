#!/usr/bin/env -S npx tsx
/**
 * Phase H live check: the four Thalamus reads against the REAL Jev, on synthetic cases only.
 *
 * What it does: builds the real `RoutingReader` (real question files, real redaction, real `JevClient`) and feeds it the
 * invented cases in `live-jev-cases.mjs`: task reads with the enhancement ranking in the same call, the fit-kind read for
 * the top entries, step reads, outcome reads, and two private-source inputs that must make no call at all. It compares
 * each answer with the expected one and reports agreement, what the router would have ACTED on (source `jev`) against
 * what it would have fallen back from, confidence against correctness, latency and spend. Nothing is persisted except the
 * results file; no store, no gateway, no config. Run it from the extension folder: `npx tsx scripts/live-jev.mjs <out dir>`.
 *
 * The key: read from `TYPESAFE_API_KEY` if set, otherwise from the gateway's systemd drop-in (the way the J11 build did).
 * It lives in this process's environment only; the script never prints it, never writes it, never puts it in the results.
 * Refuses to write under ~/.openclaw. Synthetic cases only (`sendRealSituations` stays false).
 * Spend stops the run at EUR 2, counting every dollar of the client's own cost figure as a euro (an upper bound).
 *
 * No shims since phase H2: the reader rounds scores, a missing situation field reads as empty, a true/false answer takes its
 * confidence from the probability, and the short list is ranked by the joint. The `raw*` figures (the answer before the
 * confidence floor, rounded to a level) stay beside the gated ones, which are what the code does.
 * Expectations are one person's judgment. A disagreement is data about the wording of the questions or about the case.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => import(join(root, "src", p));
const { RoutingReader, DEFAULT_READER_CONFIG } = await src("reads/routing-reader.ts");
const { loadQuestions } = await src("reads/questions.ts");
const { buildRoutingState } = await src("reads/redact.ts");
const { JevClient, jevToken, refreshJevNow } = await import("openclaw/plugin-sdk/fork-jev");
const {
  TASKS,
  STEPS,
  OUTCOMES,
  CARDS: BASE_CARDS,
  ENH_TASKS,
  padCards,
} = await import("./live-jev-cases.mjs");
// LIVE_JEV_PAD=210 pads the registry with invented off-topic cards to the size of a real one.
const CARDS = padCards(BASE_CARDS, Number(process.env.LIVE_JEV_PAD || 0));

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: live-jev.mjs <out dir made with mktemp -d>");
if (resolve(outDir).startsWith(join(homedir(), ".openclaw"))) {
  throw new Error("refusing to write under ~/.openclaw");
}
mkdirSync(outDir, { recursive: true });

if (!jevToken()) {
  const dropIn = join(homedir(), ".config/systemd/user/openclaw-gateway.service.d/typesafe.conf");
  const m = /^Environment=TYPESAFE_API_KEY=(.+)$/m.exec(readFileSync(dropIn, "utf8"));
  if (!m) throw new Error("no TYPESAFE_API_KEY in the environment or the gateway drop-in");
  process.env.TYPESAFE_API_KEY = m[1].trim();
  refreshJevNow();
}

const EUR_CAP = 2;
const BUDGET_MS = 10_000;
let spentEur = 0;
let stopped = false;
const calls = [];

const client = new JevClient({
  apiKey: jevToken,
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  buildState: (s, qs) => buildRoutingState(s, qs),
});

let lastVerdicts = [];
const ask = async (s, qs, o) => {
  if (spentEur >= EUR_CAP) {
    stopped = true;
    throw new Error("spend cap reached");
  }
  const v = await client.ask(s, qs, { ...o, budgetMs: BUDGET_MS });
  lastVerdicts = v;
  const live = v.filter((x) => !x.cacheHit && !x.skipped);
  const cost = v.reduce((a, x) => a + (x.costUsd || 0), 0);
  spentEur += cost;
  calls.push({
    kind: undefined,
    questions: qs.length,
    ms: live.length ? live[0].latencyMs : 0,
    costEur: cost,
    tokensIn: v.reduce((a, x) => a + (x.tokensIn || 0), 0),
    skipped: v.filter((x) => x.skipped).length,
  });
  return v;
};

const reader = new RoutingReader({
  ask,
  questions: loadQuestions(join(root, "questions")),
  cards: () => CARDS,
  config: {
    ...DEFAULT_READER_CONFIG,
    jevEnabled: true,
    sendRealSituations: false,
    budgetMs: BUDGET_MS,
  },
});

const T0 = Date.now();
const base = (id, text, extra = {}) => ({
  id,
  ts: T0,
  sessionKey: `agent:main:synthetic:${id}`,
  text,
  source: "synthetic",
  synthetic: true,
  ...extra,
});
const mark = (kind) => {
  const n = calls.length;
  return () => {
    for (let i = n; i < calls.length; i++) calls[i].kind = kind;
  };
};

/** Raw Jev choice for one question id, from the last call's verdicts (before the confidence floor). */
const DEPTHS = ["mechanical", "routine", "deep"];
const NORMALISE = {
  "route-difficulty": (a) => Math.round(Number(a)) + 1,
  "step-depth": (a) => DEPTHS[Math.round(Number(a))],
  "step-run-length": (a) => Math.round(Number(a)),
  "step-commits-or-claims": (a) => Number(a) > 0.5,
};
const raw = (qid) => {
  const v = lastVerdicts.find((x) => x.questionId === qid && !x.skipped);
  if (!v) return undefined;
  const norm = NORMALISE[qid];
  return { answer: norm ? norm(v.answer) : v.answer, conf: v.confidence };
};

const rows = { task: [], step: [], outcome: [], enh: [], fit: [], gate: [] };

// ── task reads (one call each, with the enhancement ranking) ─────────────────────────────────────
for (const c of TASKS) {
  if (stopped) break;
  const tag = mark("task+enhancement");
  let r;
  try {
    r = await reader.readTask(base(c.id, c.text));
  } catch {
    break;
  }
  tag();
  const fields = [
    ["kind", "route-work-kind", r.task.kind, c.kind],
    ["difficulty", "route-difficulty", r.task.difficulty, c.difficulty],
    ["topic", "route-topic-class", r.task.topic, c.topic],
    ["urgency", "route-urgency", r.task.urgency, c.urgency],
    ["shape", "route-shape", r.task.shape, c.shape],
  ];
  for (const [name, qid, got, want] of fields) {
    if (want === null || want === undefined) continue;
    const rw = raw(qid);
    rows.task.push({
      case: c.id,
      field: name,
      want,
      got: got.value,
      conf: got.conf,
      source: got.source,
      rawAnswer: rw?.answer,
      rawConf: rw?.conf,
      usedJev: r.usedJev,
    });
  }
}

// ── enhancement ranking (also one call, plus the fit read for the top entries) ───────────────────
for (const c of ENH_TASKS) {
  if (stopped) break;
  const tag = mark("task+enhancement");
  let r;
  try {
    r = await reader.readTask(base(c.id, c.text));
  } catch {
    break;
  }
  tag();
  const list = r.shortlist;
  const ids = list.entries.map((e) => e.cardId);
  const leadsNone = list.reason === "none-leads" || list.reason === "empty";
  rows.enh.push({
    case: c.id,
    best: c.best,
    shown: list.shown,
    reason: list.reason,
    source: list.source,
    listed: ids,
    top1: ids[0] ?? null,
    noneFitsProb: list.noneFitsProb,
    topProb: list.entries[0]?.prob ?? null,
    correct: c.best === "none" ? !list.shown : list.shown && ids[0] === c.best,
    inList: c.best !== "none" && ids.includes(c.best),
    falseList: c.best === "none" && list.shown,
    leadsNone,
    // What Jev itself said, before the floor and the local fallback: the family choice and each family's best member.
    family: (() => {
      const f = r.verdicts.find((v) => v.questionId === "enh-family" && !v.skipped);
      return f ? { pick: f.answer, conf: f.confidence, probs: f.probs } : null;
    })(),
    members: r.verdicts
      .filter((v) => v.questionId.startsWith("enh-in-") && !v.skipped)
      .map((v) => ({ q: v.questionId, pick: v.answer, conf: v.confidence })),
    // The flat question (one ranking over every card): Jev's own top probabilities, before the share cut.
    flat: (() => {
      const f = r.verdicts.find((v) => v.questionId === "enh-flat" && !v.skipped);
      if (!f) return null;
      const top = Object.entries(f.probs ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([id, p]) => [id, Math.round(p * 1000) / 1000]);
      return { pick: f.answer, conf: f.confidence, top };
    })(),
  });
  if (c.best !== "none" && list.shown && list.source === "jev" && !stopped) {
    const tag2 = mark("fit");
    let withFit;
    try {
      withFit = await reader.readFit(base(c.id, c.text), list);
    } catch {
      break;
    }
    tag2();
    const top = withFit.entries[0];
    if (top?.fit) {
      rows.fit.push({
        case: c.id,
        card: top.cardId,
        isBest: top.cardId === c.best,
        want: c.fit,
        got: top.fit.value,
        conf: top.fit.conf,
        source: top.fit.source,
      });
    }
  }
}

// ── step reads ───────────────────────────────────────────────────────────────────────────────────
for (const c of STEPS) {
  if (stopped) break;
  const tag = mark("step");
  let r;
  try {
    r = await reader.readStep({ ...base(c.id, c.text), callIndex: 1 });
  } catch {
    break;
  }
  tag();
  const s = r.step;
  for (const [name, qid, got, want] of [
    ["kind", "step-kind", s.kind, c.kind],
    ["depth", "step-depth", s.depth, c.depthName],
    ["needs", "step-context-need", s.needs, c.needs],
    ["runLength", "step-run-length", s.runLength, c.runLen],
    ["commits", "step-commits-or-claims", s.commitsOrClaims, c.commits],
  ]) {
    const rw = raw(qid);
    rows.step.push({
      case: c.id,
      field: name,
      want,
      got: got.value,
      conf: got.conf,
      source: got.source,
      rawAnswer: rw?.answer,
      rawConf: rw?.conf,
    });
  }
}

// ── outcome reads ────────────────────────────────────────────────────────────────────────────────
for (const c of OUTCOMES) {
  if (stopped) break;
  const tag = mark("outcome");
  let r;
  try {
    r = await reader.readOutcome({ ...base(c.id, c.text), callIndex: 1 });
  } catch {
    break;
  }
  tag();
  const rw = raw("outcome-state");
  rows.outcome.push({
    case: c.id,
    field: "state",
    want: c.state,
    got: r.outcome.state.value,
    conf: r.outcome.state.conf,
    source: r.outcome.state.source,
    rawAnswer: rw?.answer,
    rawConf: rw?.conf,
  });
}

// ── the privacy gate, live: these must make no call ──────────────────────────────────────────────
const before = calls.length;
const priv = await reader.readTask(
  base("p1", "Synthetic private chat message about a dentist appointment.", {
    source: "channel:whatsapp",
  }),
);
const real = await reader.readTask({
  ...base("p2", "Synthetic real-looking message."),
  synthetic: false,
  source: "tinker",
});
rows.gate.push({ case: "p1", why: priv.local, usedJev: priv.usedJev, private: priv.private });
rows.gate.push({ case: "p2", why: real.local, usedJev: real.usedJev, private: real.private });
const gateCalls = calls.length - before;

// ── the report ───────────────────────────────────────────────────────────────────────────────────
const pct = (n, d) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const mean = (xs) =>
  xs.length ? Math.round((1000 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 1000 : null;
const same = (a, b) => String(a) === String(b);
const BUCKETS = [
  ["<0.60", (c) => c < 0.6],
  ["0.60-0.80", (c) => c >= 0.6 && c < 0.8],
  ["0.80-0.95", (c) => c >= 0.8 && c < 0.95],
  [">=0.95", (c) => c >= 0.95],
];

function scoreRows(list) {
  const rel = list.filter((r) => r.usedJev !== false);
  const right = (r) => same(r.got, r.want);
  const rawRight = (r) => r.rawAnswer !== undefined && same(r.rawAnswer, r.want);
  const acted = rel.filter((r) => r.source === "jev");
  const out = {
    n: rel.length,
    agreeGated: pct(rel.filter(right).length, rel.length),
    agreeRaw: pct(rel.filter(rawRight).length, rel.filter((r) => r.rawAnswer !== undefined).length),
    actedOn: pct(acted.length, rel.length),
    actedWrong: pct(acted.filter((r) => !right(r)).length, rel.length),
    fellBack: pct(rel.length - acted.length, rel.length),
    confWhenRight: mean(
      rel
        .filter(rawRight)
        .map((r) => r.rawConf)
        .filter((c) => c !== undefined),
    ),
    confWhenWrong: mean(
      rel
        .filter((r) => r.rawAnswer !== undefined && !rawRight(r))
        .map((r) => r.rawConf)
        .filter((c) => c !== undefined),
    ),
    rawActed: pct(
      rel.filter((r) => r.rawConf !== undefined && r.rawConf >= 0.6).length,
      rel.length,
    ),
    rawActedWrong: pct(
      rel.filter((r) => r.rawConf !== undefined && r.rawConf >= 0.6 && !rawRight(r)).length,
      rel.length,
    ),
    byConfidence: BUCKETS.map(([label, f]) => {
      const b = rel.filter((r) => r.rawConf !== undefined && f(r.rawConf));
      return { bucket: label, n: b.length, accuracy: pct(b.filter(rawRight).length, b.length) };
    }),
  };
  return out;
}

const byField = (list, field) => list.filter((r) => r.field === field);
const summary = { task: {}, step: {}, outcome: {} };
for (const f of ["kind", "difficulty", "topic", "urgency", "shape"])
  summary.task[f] = scoreRows(byField(rows.task, f));
for (const f of ["kind", "depth", "needs", "runLength", "commits"])
  summary.step[f] = scoreRows(byField(rows.step, f));
summary.outcome.state = scoreRows(rows.outcome);
// Difficulty: Jev's score is rounded to a level and shifted to the 1..5 label; "within one" and the mean signed error use that.
{
  const d = rows.task.filter((r) => r.field === "difficulty" && r.rawAnswer !== undefined);
  summary.task.difficulty.within1 = pct(
    d.filter((r) => Math.abs(Number(r.rawAnswer) - Number(r.want)) <= 1).length,
    d.length,
  );
  summary.task.difficulty.meanSigned = mean(d.map((r) => Number(r.rawAnswer) - Number(r.want)));
  summary.task.difficulty.exact = pct(
    d.filter((r) => Number(r.rawAnswer) === Number(r.want)).length,
    d.length,
  );
}

const enh = rows.enh;
const fits = enh.filter((r) => r.best !== "none");
const nones = enh.filter((r) => r.best === "none");
const enhSummary = {
  tasksWithAFit: fits.length,
  top1Correct: pct(fits.filter((r) => r.correct).length, fits.length),
  bestInList: pct(fits.filter((r) => r.inList).length, fits.length),
  listShownForFits: pct(fits.filter((r) => r.shown).length, fits.length),
  tasksWithNoFit: nones.length,
  noneCorrect: pct(nones.filter((r) => r.correct).length, nones.length),
  falseLists: nones.filter((r) => r.falseList).length,
  listSourceJev: pct(enh.filter((r) => r.source === "jev").length, enh.length),
  meanTopProbWhenRight: mean(
    fits
      .filter((r) => r.correct)
      .map((r) => r.topProb)
      .filter((p) => p !== null),
  ),
  meanTopProbWhenWrong: mean(
    fits.filter((r) => !r.correct && r.topProb !== null).map((r) => r.topProb),
  ),
  fitKind: {
    n: rows.fit.length,
    bestEntryIsBest: pct(rows.fit.filter((r) => r.isBest).length, rows.fit.length),
    agree: pct(
      rows.fit.filter((r) => r.isBest && r.got === r.want).length,
      rows.fit.filter((r) => r.isBest).length,
    ),
    actedOn: pct(rows.fit.filter((r) => r.source === "jev").length, rows.fit.length),
  },
};

const lat = (kind) => {
  const ms = calls.filter((c) => c.kind === kind && c.ms > 0).map((c) => c.ms);
  return {
    calls: ms.length,
    p50: q(ms, 0.5),
    p95: q(ms, 0.95),
    max: ms.length ? Math.max(...ms) : null,
    over800: ms.filter((m) => m > 800).length,
    over1600: ms.filter((m) => m > 1600).length,
  };
};
const latency = {
  "task+enhancement": lat("task+enhancement"),
  fit: lat("fit"),
  step: lat("step"),
  outcome: lat("outcome"),
  all: (() => {
    const ms = calls.filter((c) => c.ms > 0).map((c) => c.ms);
    return {
      calls: ms.length,
      p50: q(ms, 0.5),
      p95: q(ms, 0.95),
      max: ms.length ? Math.max(...ms) : null,
    };
  })(),
};

const report = {
  ranAt: new Date(T0).toISOString(),
  model: "jev-latest",
  cases: {
    tasks: TASKS.length,
    steps: STEPS.length,
    outcomes: OUTCOMES.length,
    enhancementTasks: ENH_TASKS.length,
    cards: CARDS.length,
  },
  calls: calls.length,
  skippedQuestions: calls.reduce((a, c) => a + c.skipped, 0),
  spend: {
    eurUpperBound: Math.round(spentEur * 1e6) / 1e6,
    cap: EUR_CAP,
    stoppedAtCap: stopped,
    tokensIn: calls.reduce((a, c) => a + c.tokensIn, 0),
  },
  shims: [],
  privacyGate: { extraCallsMade: gateCalls, rows: rows.gate },
  task: summary.task,
  step: summary.step,
  outcome: summary.outcome,
  enhancement: enhSummary,
  latency,
  rows,
};
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
process.stdout.write(
  JSON.stringify(
    {
      calls: report.calls,
      spend: report.spend,
      shims: report.shims,
      privacyGate: report.privacyGate,
      task: report.task,
      step: report.step,
      outcome: report.outcome,
      enhancement: report.enhancement,
      latency: report.latency,
    },
    null,
    1,
  ) + "\n",
);
