import { describe, expect, it } from "vitest";
import { contextKey } from "../src/learn/keys.js";
import {
  loosenFromFalseAlarms,
  retuneOnline,
  suggestProbCutoff,
  tightenFromMisses,
  type RetuneDeps,
} from "../src/learn/retune.js";
import type { ChangeEngineApi, ChangeOutcome, Proposal } from "../src/learn/types.js";
import { QuestionBook } from "../src/question-book.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";
import type { Change, Cutoff, Situation, Verdict } from "../src/types.js";
import { seedDir } from "./helpers/family-harness.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);

const fakeChange = (): Change => ({
  id: "c",
  ts: T0,
  questionId: "q",
  fromVersion: 1,
  toVersion: null,
  kind: "tighten",
  exceptional: false,
  status: "applied",
  replay: {
    cases: 0,
    relaxed: 0,
    tightened: 0,
    mustCatchTotal: 0,
    mustCatchLost: 0,
    heldOutBetter: null,
    liveCalls: 0,
  },
  proposedBy: "code",
});

/** A fake engine: records every proposal and answers "applied". */
function fakeEngine() {
  const calls: { p: Proposal; by?: string }[] = [];
  const engine: ChangeEngineApi = {
    async propose(p, o) {
      calls.push({ p, by: o?.proposedBy });
      return { outcome: "applied", change: fakeChange() } as ChangeOutcome;
    },
    async approve() {
      throw new Error("not used");
    },
    undo() {
      return { ok: false };
    },
    pending: () => [],
  };
  return { engine, calls };
}

function setup(cfg?: RetuneDeps["cfg"]) {
  const store = new AmygdalaStore(":memory:");
  const book = new QuestionBook({ seedDir });
  const { engine, calls } = fakeEngine();
  const deps: RetuneDeps = { store, book, engine, now: () => T0, cfg };
  return { store, book, deps, calls };
}

const EFFECTS = ["read", "local-write", "send", "spend", "delete"] as const;
let seq = 0;

/** Stores a situation (context chosen by effect class), a verdict per answer and a decision; returns the decision id. */
function history(
  store: AmygdalaStore,
  o: {
    effect?: (typeof EFFECTS)[number];
    answers: {
      q: string;
      type: Verdict["type"];
      answer: string | number;
      prob: number;
      probs?: Record<string, number>;
    }[];
    pruned?: boolean;
    ts?: number;
  },
): { decisionId: string; situation: Situation } {
  const n = ++seq;
  const ts = o.ts ?? T0 - DAY;
  const s = buildSituation(
    { seam: "pre-tool", sessionKey: "s", turnId: `s#${n}`, now: ts, originKind: "synthetic" },
    { workspaceRoot: "/work/demo", homeDir: "/home/demo" },
  );
  s.id = `sit-${n}`;
  s.effectClass = { value: o.effect ?? "read", origin: "derived" };
  store.saveSituation(s);
  const vs: Verdict[] = o.answers.map((a) => ({
    id: `v-${n}-${a.q}`,
    situationId: s.id,
    questionId: a.q,
    questionVersion: 1,
    type: a.type,
    answer: a.answer,
    prob: a.prob,
    ...(a.probs ? { probs: a.probs } : {}),
    confidence: 0.9,
    cacheHit: false,
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    ts,
  }));
  store.saveVerdicts(vs);
  store.saveDecision(
    {
      situationId: s.id,
      response: { kind: "proceed" },
      family: "safety",
      reasonCode: "none",
      verdictIds: vs.map((v) => v.id),
      mode: "enforce",
      enforced: true,
      degraded: false,
    },
    { id: `dec-${n}`, seam: "pre-tool", ts },
  );
  if (o.pruned) store.pruneRecords(ts + 1);
  return { decisionId: `dec-${n}`, situation: s };
}

let lab = 0;
function label(
  store: AmygdalaStore,
  targetId: string,
  kind: "miss" | "judge" | "useful",
  value: -1 | 1,
  ts = T0 - DAY,
) {
  store.addLabel({
    id: `l-${++lab}`,
    targetId,
    targetKind: "decision",
    kind,
    value,
    source: "user",
    weight: 3,
    ts,
  });
}

const noul = (q: string, p: number) => ({ q, type: "noul" as const, answer: p, prob: p });

describe("tightenFromMisses", () => {
  it("prob question: a context tighten just under the verdict, floored at 0.05", async () => {
    const { store, deps, calls } = setup();
    const h = history(store, { answers: [noul("novelty", 0.6)] }); // cut-off 0.7
    label(store, h.decisionId, "miss", 1);
    const out = await tightenFromMisses(deps);
    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.by).toBe("code");
    expect(calls[0]?.p).toEqual({
      kind: "cutoff",
      scope: "context",
      questionId: "novelty",
      contextKey: contextKey(h.situation, "novelty"),
      cutoff: { kind: "prob", at: 0.55 },
    });
    // A far miss (0.06 against 0.7) is not a near miss: it proposes nothing of its own.
    const far = history(store, { effect: "send", answers: [noul("novelty", 0.06)] });
    label(store, far.decisionId, "miss", 1);
    await tightenFromMisses(deps);
    const cuts = calls.map((c) => (c.p as Extract<Proposal, { scope: "context" }>).cutoff);
    expect(cuts.every((c) => c.kind === "prob" && c.at === 0.55)).toBe(true);
  });

  it("level question: floor of the level for atOrAbove; ceil for atOrBelow", async () => {
    const { store, deps, calls } = setup();
    const a = history(store, {
      answers: [{ q: "danger-level", type: "score", answer: 1.4, prob: 0.5 }], // reads as level 1; cut-off atOrAbove 2
    });
    label(store, a.decisionId, "miss", 1);
    await tightenFromMisses(deps);
    expect((calls[0]?.p as { cutoff: Cutoff }).cutoff).toEqual({ kind: "level", atOrAbove: 1 });
    const b = history(store, {
      effect: "send",
      answers: [{ q: "progress-made", type: "score", answer: 0.6, prob: 0.5 }], // cut-off atOrBelow 0
    });
    label(store, b.decisionId, "miss", 1);
    await tightenFromMisses(deps);
    expect((calls.at(-1)?.p as { cutoff: Cutoff }).cutoff).toEqual({ kind: "level", atOrBelow: 1 });
  });

  it("choice question: at = option probability - 0.05, same option and negate", async () => {
    const { store, deps, calls } = setup();
    const a = history(store, {
      answers: [
        {
          q: "data-tier",
          type: "choice",
          answer: "public",
          prob: 0.6,
          probs: { public: 0.6, "harmful-if-seen": 0.3, "harmless-if-seen": 0.1 },
        },
      ],
    });
    label(store, a.decisionId, "miss", 1);
    await tightenFromMisses(deps);
    expect((calls[0]?.p as { cutoff: Cutoff }).cutoff).toEqual({
      kind: "choice",
      option: "harmful-if-seen",
      at: 0.25,
    });
    const b = history(store, {
      effect: "send",
      answers: [
        {
          q: "dodged-work",
          type: "choice",
          answer: "complete",
          prob: 0.7,
          probs: { complete: 0.7, placeholder: 0.3 },
        },
      ],
    });
    label(store, b.decisionId, "miss", 1);
    await tightenFromMisses(deps);
    expect((calls.at(-1)?.p as { cutoff: Cutoff }).cutoff).toEqual({
      kind: "choice",
      option: "complete",
      at: 0.25,
      negate: true,
    });
  });

  it("never changes a none cut-off, a verdict that already crossed or a cannot-tell answer", async () => {
    const { store, deps, calls } = setup();
    const a = history(store, {
      answers: [
        { q: "claim-source", type: "choice", answer: "assumed", prob: 0.9 }, // cut-off none
        noul("novelty", 0.9), // crossed already
        { q: "data-tier", type: "choice", answer: "cannot-tell", prob: 0.9 },
      ],
    });
    label(store, a.decisionId, "miss", 1);
    expect(await tightenFromMisses(deps)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("skips a pruned situation, an unknown decision and a decision with no verdicts", async () => {
    const { store, deps, calls } = setup();
    const p = history(store, { answers: [noul("novelty", 0.6)], pruned: true });
    label(store, p.decisionId, "miss", 1);
    label(store, "dec-nowhere", "miss", 1);
    const e = history(store, { answers: [] });
    label(store, e.decisionId, "miss", 1);
    expect(await tightenFromMisses(deps)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("respects sinceTs", async () => {
    const { store, deps, calls } = setup();
    const h = history(store, { answers: [noul("novelty", 0.6)] });
    label(store, h.decisionId, "miss", 1, T0 - 10 * DAY);
    await tightenFromMisses(deps, T0 - DAY);
    expect(calls).toHaveLength(0);
  });

  it("proposes the global variant only with misses in 3 contexts and within the budget", async () => {
    const two = setup();
    for (const effect of ["read", "send"] as const) {
      const h = history(two.store, { effect, answers: [noul("novelty", 0.6)] });
      label(two.store, h.decisionId, "miss", 1);
    }
    await tightenFromMisses(two.deps);
    expect(two.calls.map((c) => (c.p as { scope: string }).scope)).toEqual(["context", "context"]);

    const three = setup();
    // 200 quiet stored verdicts far below the new cut-off keep the change inside the 2 % budget.
    for (let i = 0; i < 200; i++) history(three.store, { answers: [noul("novelty", 0.1)] });
    for (const [i, effect] of (["read", "send", "spend"] as const).entries()) {
      const h = history(three.store, { effect, answers: [noul("novelty", 0.6 - i * 0.01)] });
      label(three.store, h.decisionId, "miss", 1);
    }
    await tightenFromMisses(three.deps);
    const scopes = three.calls.map((c) => (c.p as { scope: string }).scope);
    expect(scopes).toEqual(["context", "context", "context", "global"]);
    // the global cut-off is the tightest of the three
    expect((three.calls[3]?.p as { cutoff: Cutoff }).cutoff).toEqual({ kind: "prob", at: 0.53 });

    const busy = setup();
    // 50 stored verdicts between the new and the old cut-off: 50 % would newly trigger, far over budget.
    for (let i = 0; i < 50; i++) history(busy.store, { answers: [noul("novelty", 0.6)] });
    for (const effect of ["read", "send", "spend"] as const) {
      const h = history(busy.store, { effect, answers: [noul("novelty", 0.6)] });
      label(busy.store, h.decisionId, "miss", 1);
    }
    await tightenFromMisses(busy.deps);
    expect(busy.calls.map((c) => (c.p as { scope: string }).scope)).toEqual([
      "context",
      "context",
      "context",
    ]);
  });
});

describe("loosenFromFalseAlarms", () => {
  /** A context with `fa` false-alarm decisions (judge -1, each novelty 0.8) and optional confirms. */
  function alarmContext(
    s: ReturnType<typeof setup>,
    o: {
      fa: number;
      alarms?: number;
      confirms?: number;
      probs?: number[];
      effect?: (typeof EFFECTS)[number];
    },
  ) {
    let key = "";
    for (let i = 0; i < o.fa; i++) {
      const h = history(s.store, {
        effect: o.effect ?? "read",
        answers: [noul("novelty", o.probs?.[i] ?? 0.8)],
      });
      key = contextKey(h.situation, "novelty");
      label(s.store, h.decisionId, "judge", -1);
    }
    s.store.bumpContext(
      key,
      "novelty",
      { alarms: o.alarms ?? o.fa, falseAlarms: o.fa, confirms: o.confirms ?? 0 },
      T0 - DAY,
    );
    return key;
  }

  it("proposes a context loosening just above the highest false alarm at exactly the thresholds", async () => {
    const s = setup();
    const key = alarmContext(s, { fa: 5, probs: [0.72, 0.75, 0.8, 0.78, 0.71] });
    const out = await loosenFromFalseAlarms(s.deps);
    expect(out).toHaveLength(1);
    expect(s.calls[0]?.p).toEqual({
      kind: "cutoff",
      scope: "context",
      questionId: "novelty",
      contextKey: key,
      cutoff: { kind: "prob", at: 0.82 },
    });
  });

  it("does not propose one below a threshold: 4 false alarms, ratio 0.83, or an old context", async () => {
    const few = setup();
    alarmContext(few, { fa: 4 });
    expect(await loosenFromFalseAlarms(few.deps)).toEqual([]);

    const ratio = setup();
    alarmContext(ratio, { fa: 5, alarms: 6 }); // 0.833 < 0.9
    expect(await loosenFromFalseAlarms(ratio.deps)).toEqual([]);

    const exact = setup();
    alarmContext(exact, { fa: 9, alarms: 10 }); // exactly 0.9
    expect(await loosenFromFalseAlarms(exact.deps)).toHaveLength(1);

    const old = setup();
    const key = alarmContext(old, { fa: 5 });
    old.store.bumpContext(key, "novelty", {}, T0 - 40 * DAY); // last touched outside the window
    expect(await loosenFromFalseAlarms({ ...old.deps, now: () => T0 + 40 * DAY })).toEqual([]);
  });

  it("a confirm blocks the proposal", async () => {
    const s = setup();
    alarmContext(s, { fa: 5, alarms: 6, confirms: 1 });
    expect(await loosenFromFalseAlarms(s.deps)).toEqual([]);
    const t = setup();
    alarmContext(t, { fa: 20, confirms: 1 });
    expect(await loosenFromFalseAlarms(t.deps)).toEqual([]);
  });

  it("stays inside the scale: prob capped at 0.99, level not above the top level", async () => {
    const cap = setup();
    alarmContext(cap, { fa: 5, probs: [0.98, 0.98, 0.98, 0.98, 0.98] }); // 0.98 + 0.02 = 1.0 > 0.99
    expect(await loosenFromFalseAlarms(cap.deps)).toEqual([]);
    const edge = setup();
    alarmContext(edge, { fa: 5, probs: [0.97, 0.97, 0.97, 0.97, 0.97] }); // 0.99 is allowed
    await loosenFromFalseAlarms(edge.deps);
    expect((edge.calls[0]?.p as { cutoff: Cutoff }).cutoff).toEqual({ kind: "prob", at: 0.99 });

    const lvl = setup();
    let key = "";
    for (let i = 0; i < 5; i++) {
      const h = history(lvl.store, {
        answers: [{ q: "danger-level", type: "score", answer: 2, prob: 0.66 }],
      });
      key = contextKey(h.situation, "danger-level");
      label(lvl.store, h.decisionId, "judge", -1);
    }
    lvl.store.bumpContext(key, "danger-level", { alarms: 5, falseAlarms: 5 }, T0 - DAY);
    await loosenFromFalseAlarms(lvl.deps);
    expect((lvl.calls[0]?.p as { cutoff: Cutoff }).cutoff).toEqual({ kind: "level", atOrAbove: 3 });

    const top = setup();
    for (let i = 0; i < 5; i++) {
      const h = history(top.store, {
        answers: [{ q: "danger-level", type: "score", answer: 3, prob: 1 }],
      });
      key = contextKey(h.situation, "danger-level");
      label(top.store, h.decisionId, "useful", -1);
    }
    top.store.bumpContext(key, "danger-level", { alarms: 5, falseAlarms: 5 }, T0 - DAY);
    expect(await loosenFromFalseAlarms(top.deps)).toEqual([]);
  });

  it("retuneOnline tightens first, then loosens", async () => {
    const s = setup();
    const h = history(s.store, { effect: "send", answers: [noul("novelty", 0.6)] });
    label(s.store, h.decisionId, "miss", 1);
    alarmContext(s, { fa: 5 });
    const r = await retuneOnline(s.deps);
    expect(r.tighten).toHaveLength(1);
    expect(r.loosen).toHaveLength(1);
    expect(s.calls.map((c) => (c.p as { contextKey: string }).contextKey.split("|")[1])).toEqual([
      "send",
      "read",
    ]);
  });
});

describe("suggestProbCutoff", () => {
  const pts = (arr: [number, boolean][]) => arr.map(([prob, positive]) => ({ prob, positive }));

  it("returns null when no cut-off catches every must-catch probability", () => {
    expect(suggestProbCutoff([], [0.02])).toBeNull();
  });

  it("catches every must-catch value and keeps the best recall with the fewest false alarms", () => {
    const data = pts([
      [0.9, true],
      [0.6, true],
      [0.55, false],
      [0.4, false],
      [0.3, false],
    ]);
    // must-catch 0.6: cut-offs up to 0.6 are allowed; recall 2 is reached up to 0.6; 0.6 has no false alarm above it
    expect(suggestProbCutoff(data, [0.6])).toBe(0.6);
    // a lower must-catch forces the cut-off down and accepts the false alarms that come with it
    expect(suggestProbCutoff(data, [0.3])).toBe(0.3);
  });

  it("recall must not drop below the best achievable", () => {
    const data = pts([
      [0.9, true],
      [0.35, true],
      [0.5, false],
    ]);
    // allowed <= 0.9; best recall 2 needs a cut-off <= 0.35
    expect(suggestProbCutoff(data, [0.9])).toBe(0.35);
  });

  it("ties go to the higher cut-off", () => {
    const data = pts([[0.9, true]]);
    expect(suggestProbCutoff(data, [0.8])).toBe(0.8);
    expect(suggestProbCutoff(data, [0.8], [0.3, 0.5, 0.7])).toBe(0.7);
  });

  it("accepts a custom grid and no must-catch values", () => {
    const data = pts([
      [0.8, true],
      [0.2, false],
    ]);
    expect(suggestProbCutoff(data, [], [0.25, 0.5, 0.75])).toBe(0.75);
  });
});
