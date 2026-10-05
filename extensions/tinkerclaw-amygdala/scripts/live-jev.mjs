#!/usr/bin/env -S npx tsx
/**
 * Phase G live check: every must-catch case and every control through the decide path with the REAL Jev.
 *
 * What it does: for each case it builds the case's synthetic situation, lets the families pick the questions they want
 * at that step, asks the real Jev those questions (real JevClient, real question book, real redaction), then runs the
 * families' observe/decide and the severity merge, exactly as `decide()` does after its Jev call. Nothing is persisted:
 * no store, no gateway, no policy file. Run it as `npx tsx scripts/live-jev.mjs` from the extension folder.
 *
 * The key: `TYPESAFE_API_KEY` must already be in THIS process's environment. The script never prints it, never writes
 * it, and refuses to run with a data dir under ~/.openclaw. Synthetic cases only (`sendRealSituations` stays false).
 *
 * Three passes per case. "as written" is the replay parity run: the case's own fields only, and a must-catch case starts
 * with `misreadingRisk = "high"`, as `runCase` does. "derived" first builds the situation through `buildSituation` from the
 * case's tool, command and session fields, as production would, so effect class and targets are derived; the case's own
 * fields still win. "derived natural" also leaves the turn state alone. The bar is reported on all three.
 * Spend stops the run at €2. Report: <dataDir>/report.json and a summary on stdout.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => import(join(root, "src", p));
const { JevClient } = await src("jev.ts");
const { QuestionBook } = await src("question-book.ts");
const { enabledFamilies } = await src("families/index.ts");
const { parseConfig } = await src("config.ts");
const { redactForSend } = await src("redact.ts");
const { loadMustCatch, loadControls } = await src("cases.ts");
const { caseSeam, caseSituation } = await src("learn/replay.ts");
const { buildSituation } = await src("situation.ts");
const { newTurnState } = await src("context.ts");
const { mergeResponses, SEVERITY } = await src("respond.ts");
const { evaluateRules } = await src("rules.ts");

const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: live-jev.mjs <data dir made with mktemp -d>");
if (resolve(dataDir).startsWith(join(homedir(), ".openclaw"))) {
  throw new Error("refusing to use a data dir under ~/.openclaw");
}
mkdirSync(dataDir, { recursive: true });
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not in the environment");

const EUR_CAP = 2;
const MEASURE_BUDGET_MS = 10_000;
const SEAM_BUDGET_MS = { prompt: 1600, "pre-tool": 2600, "post-tool": 1600, stop: 4600 };

const config = parseConfig({
  mode: "shadow",
  families: {
    safety: true,
    secondOpinion: true,
    doubleCheck: true,
    efficiency: true,
    personality: true,
  },
});
const book = new QuestionBook({
  seedDir: join(root, "questions"),
  overlayDir: join(dataDir, "questions.d"),
});
const jev = new JevClient({
  apiKey: () => process.env.TYPESAFE_API_KEY,
  baseUrl: config.jev.baseUrl,
  model: config.jev.model,
  buildState: (s, qs) => redactForSend(s, qs, { allowReal: false, homeDir: homedir() }),
});
const families = enabledFamilies(config, { book });

const cases = [
  ...loadMustCatch(join(root, "cases", "must-catch")),
  ...loadControls(join(root, "cases", "controls")),
];
const view = (id) => book.get(id);

let usd = 0;
const eur = () => usd * config.cost.eurPerUsd;

const SESSION_KEYS = [
  "request",
  "toolRecord",
  "restatement",
  "expectation",
  "draftCommitments",
  "repeatedErrors",
  "stepsSinceNewFact",
  "recentHolds",
  "standingFacts",
  "provenance",
  "holdNeeds",
  "candidates",
  "scheduledJobs",
  "claims",
  "similarIncidents",
];

/** The situation production would build: derived fields (effect class, targets) come from the tool input, then the case's own fields win. */
function derivedSituation(c, seam) {
  const f = (n) => c.situation[n]?.value ?? undefined;
  const session = { workspaceRoot: "/work/demo", homeDir: "/home/demo" };
  for (const k of SESSION_KEYS) if (f(k) !== undefined) session[k] = f(k);
  const base = buildSituation(
    {
      seam,
      sessionKey: "live",
      turnId: `${c.id}#1`,
      now: 1_000,
      originKind: "synthetic",
      tool: f("tool"),
      toolInput: f("command") !== undefined ? { command: f("command") } : f("args"),
      prompt: seam === "prompt" ? f("request") : undefined,
      reply: f("reply"),
    },
    session,
  );
  const { originKind: _o, ...fields } = structuredClone(c.situation);
  return { ...base, ...fields, seam };
}

async function runLive(c, forced, derived) {
  const seam = caseSeam(c, view);
  const s = derived ? derivedSituation(c, seam) : caseSituation(c, seam);
  if (c.answers?.["procedure-choice"] && s.candidates.value === null) {
    s.candidates = {
      value: [1, 2, 3].map((n) => ({ id: `live-candidate-${n}`, description: "test-description" })),
      origin: "derived",
    };
  }
  // Step 1 of `decide`: the hard rules run locally before any judge is asked, and a match holds the step.
  if (seam === "pre-tool" && s.tool.value) {
    const args = s.command.value ?? JSON.stringify(s.args.value ?? {});
    const r = evaluateRules(s.tool.value, args, { enforcedOnly: true });
    if (r.decision === "hard_block") {
      const ok =
        (c.mustBeAtLeast === undefined || SEVERITY.hold >= SEVERITY[c.mustBeAtLeast]) &&
        (c.mustBeAtMost === undefined || SEVERITY.hold <= SEVERITY[c.mustBeAtMost]);
      return {
        seam,
        got: "hold",
        ok,
        jevMs: 0,
        asked: [],
        answers: [],
        skipped: [],
        unavailable: false,
        hard: r.rule,
      };
    }
  }
  const state = newTurnState("live", `${c.id}#1`);
  if (forced && c.kind === "must-catch") state.misreadingRisk = "high";
  state.stepCount += 1;
  for (const f of families) f.enrich?.(seam, s, state);

  const wanted = [];
  for (const f of families)
    for (const id of f.questionsFor(seam, s, state)) if (!wanted.includes(id)) wanted.push(id);
  const questions = wanted
    .map((id) => book.get(id))
    .filter((q) => q && q.status === "active" && q.seams.includes(seam));

  const t0 = performance.now();
  const verdicts = questions.length
    ? await jev.ask(s, questions, { budgetMs: MEASURE_BUDGET_MS })
    : [];
  const jevMs = Math.round(performance.now() - t0);
  for (const v of verdicts) usd += v.costUsd ?? 0;

  const asked = new Map(questions.map((q) => [q.id, q]));
  for (const f of families) f.observe?.(seam, s, verdicts, state, asked);
  const cands = [];
  for (const f of families) {
    const res = f.decide(seam, s, verdicts, state, asked);
    if (res) cands.push({ response: res.response, family: f.id, reasonCode: res.reasonCode });
  }
  const got = mergeResponses(cands).response.kind;
  const live = verdicts.filter((v) => !v.skipped);
  const skipped = verdicts.filter((v) => v.skipped).map((v) => `${v.questionId}:${v.skipped}`);
  const meets =
    (c.mustBeAtLeast === undefined || SEVERITY[got] >= SEVERITY[c.mustBeAtLeast]) &&
    (c.mustBeAtMost === undefined || SEVERITY[got] <= SEVERITY[c.mustBeAtMost]);
  return {
    seam,
    got,
    ok: meets,
    jevMs,
    asked: questions.map((q) => q.id),
    answers: live.map((v) => ({
      q: v.questionId,
      answer: v.answer,
      prob: v.prob,
      cached: v.cacheHit,
      ms: v.latencyMs,
    })),
    skipped,
    unavailable: questions.length > 0 && live.length === 0,
  };
}

const rows = [];
let stopped = null;
for (const c of cases) {
  if (eur() >= EUR_CAP) {
    stopped = `stopped at €${eur().toFixed(3)} before ${c.id}: the €${EUR_CAP} cap`;
    break;
  }
  const forced = await runLive(c, true, false);
  const derivedForced = await runLive(c, true, true);
  const natural = await runLive(c, false, true);
  rows.push({
    id: c.id,
    kind: c.kind,
    expected: c.mustBeAtLeast ? `>= ${c.mustBeAtLeast}` : `<= ${c.mustBeAtMost}`,
    description: c.description,
    forced,
    derivedForced,
    natural,
  });
  process.stdout.write(
    `${forced.ok ? "ok  " : "MISS"} ${derivedForced.ok ? "ok  " : "MISS"} ${natural.ok ? "ok  " : "MISS"} ${c.kind.padEnd(10)} ${c.id} -> ${forced.got}/${derivedForced.got}/${natural.got} (${forced.jevMs} ms)\n`,
  );
}

const pct = (xs, p) => {
  const a = xs.toSorted((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] : null;
};
const must = rows.filter((r) => r.kind === "must-catch");
const ctrl = rows.filter((r) => r.kind === "control");
const fresh = rows
  .flatMap((r) => [r.forced, r.derivedForced, r.natural])
  .filter((f) => f.asked.length && !f.unavailable && f.answers.some((a) => !a.cached));
const lat = fresh.map((f) => f.jevMs);
const over = fresh.filter((f) => f.jevMs > SEAM_BUDGET_MS[f.seam]).length;
const summary = {
  cases: rows.length,
  planned: cases.length,
  stopped,
  mustCatch: {
    total: must.length,
    caughtAsWritten: must.filter((r) => r.forced.ok).length,
    caughtDerived: must.filter((r) => r.derivedForced.ok).length,
    caughtDerivedNatural: must.filter((r) => r.natural.ok).length,
  },
  controls: {
    total: ctrl.length,
    heldAsWritten: ctrl.filter((r) => !r.forced.ok).length,
    heldDerived: ctrl.filter((r) => !r.derivedForced.ok).length,
    heldDerivedNatural: ctrl.filter((r) => !r.natural.ok).length,
  },
  byHardRule: {
    mustCatchHeld: must.filter((r) => r.derivedForced.hard).length,
    controlsHeld: ctrl
      .filter((r) => r.derivedForced.hard)
      .map((r) => `${r.id}:${r.derivedForced.hard}`),
  },
  controlsHeldByFamiliesOrJudge: ctrl.filter((r) => !r.derivedForced.ok && !r.derivedForced.hard)
    .length,
  judgeUnavailableCases: rows.filter((r) => r.forced.unavailable).length,
  latencyMs: {
    n: lat.length,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    max: lat.length ? Math.max(...lat) : null,
  },
  overRealSeamBudget: over,
  spend: { usd: Number(usd.toFixed(5)), eur: Number(eur().toFixed(5)) },
};
writeFileSync(join(dataDir, "report.json"), JSON.stringify({ summary, rows }, null, 2));
process.stdout.write(
  `\n${JSON.stringify(summary, null, 2)}\nreport: ${join(dataDir, "report.json")}\n`,
);
