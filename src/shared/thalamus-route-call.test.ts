import { describe, expect, it } from "vitest";
import { applyCallUsage, EMPTY_CACHE_LEDGER } from "./thalamus-cache-ledger.js";
import { cachePolicyFor } from "./thalamus-price-table.js";
import { routeCall, stepUnsure, topicUnsure } from "./thalamus-route-call.js";
import {
  answered,
  callParams,
  FABLE,
  GROK,
  HAIKU,
  NOW,
  OPUS,
  R,
  rung,
  SONNET,
  stepRead,
  supplies,
  taskRead,
} from "./thalamus-v4.test-support.js";

const warm = (key: string, tokens: number) =>
  applyCallUsage(
    EMPTY_CACHE_LEDGER,
    {
      conversationKey: "conv",
      modelKey: key,
      nowMs: NOW - 1000,
      input: 0,
      cacheRead: tokens,
      cacheWrite: 0,
    },
    cachePolicyFor(key),
  );

const keys = (d: NonNullable<ReturnType<typeof routeCall>>) => d.options.map((o) => o.rung.key);

describe("routeCall: a hand-picked model", () => {
  it("returns keep / hand-picked before anything runs", () => {
    const d = routeCall(
      callParams({
        handPicked: true,
        // Every check that could object is set up to object: a private task, no approved provider.
        task: taskRead({ private: true }),
        approvedProviders: [],
        cooling: new Set(["anthropic"]),
      }),
    )!;
    expect(d.switch).toEqual({ kind: "keep", reason: "hand-picked" });
    expect(d.options).toHaveLength(1);
    expect(d.vetoes).toEqual([]);
    expect(d.chosen.rung.key).toBe(OPUS);
    expect(d.wouldChange).toBe(false);
    expect(d.applied).toBe(false);
  });

  it("still returns a decision for a hand-picked model that is not on the board", () => {
    const d = routeCall(
      callParams({ handPicked: true, incumbentKey: "ollama/llama3", incumbentEffort: "" }),
    )!;
    expect(d.chosen.rung.key).toBe("ollama/llama3");
    expect(d.chosen.parts.moneyKnown).toBe(false);
  });
});

describe("routeCall: low confidence and a silent reader", () => {
  it("counts fallback answers and low confidence as unsure", () => {
    expect(topicUnsure(taskRead())).toBe(false);
    expect(topicUnsure(taskRead({ topic: answered("none" as const, 0.3) }))).toBe(true);
    expect(topicUnsure(taskRead({ topic: answered("none" as const, 0.99, "fallback") }))).toBe(
      true,
    );
    expect(stepUnsure(stepRead())).toBe(false);
    expect(stepUnsure(stepRead({ depth: answered("deep" as const, 0.2) }))).toBe(true);
  });

  it("drops every vendor with a topic restriction when the topic is unsure", () => {
    const d = routeCall(
      callParams({
        task: taskRead({ topic: answered("none" as const, 0.2, "fallback") }),
        policy: { xai: { medical: "deny" } },
      }),
    )!;
    expect(d.degraded).toBe(true);
    expect(keys(d)).not.toContain(GROK);
    expect(d.vetoes.find((v) => v.key === GROK)?.veto).toBe("policy");
    // The same board with a sure topic keeps the vendor.
    const sure = routeCall(callParams({ policy: { xai: { medical: "deny" } } }))!;
    expect(keys(sure)).toContain(GROK);
    expect(sure.degraded).toBe(false);
  });

  it("takes the whole thread, no switch, and never a cheaper route than a sure read would", () => {
    // Opus is warm; a sure read with a long run ahead moves to Haiku (see the N* tests below).
    const cache = warm(OPUS, 100_000);
    const sureStep = stepRead({ runLength: answered(4 as const) });
    const sure = routeCall(callParams({ cache, step: sureStep }))!;
    expect(sure.chosen.rung.key).toBe(HAIKU);

    const silent = routeCall(
      callParams({
        cache,
        step: stepRead({
          runLength: answered(4 as const),
          kind: answered("tool" as const, 0, "fallback"),
          needs: answered("item" as const, 0.9),
        }),
      }),
    )!;
    expect(silent.degraded).toBe(true);
    expect(silent.options.every((o) => o.feed === "thread")).toBe(true);
    expect(silent.switch.kind).toBe("keep");
    expect(silent.chosen.rung.key).toBe(OPUS);
    expect(silent.chosen.quality).toBeGreaterThanOrEqual(sure.chosen.quality);
  });

  it("takes the stronger of the two cheapest options that clear the bar when the incumbent is gone", () => {
    const d = routeCall(
      callParams({
        incumbentKey: "ollama/none",
        incumbentEffort: "",
        step: stepRead({ depth: answered("routine" as const, 0.2) }),
        dialBar: 40,
        rungs: [R.haiku, R.sonnet, R.opus],
      }),
    )!;
    const cheapestTwo = [...d.options].sort((a, b) => a.runPrice - b.runPrice).slice(0, 2);
    const strongest = [...cheapestTwo].sort((a, b) => b.quality - a.quality)[0];
    expect(d.pick.rung.key).toBe(strongest.rung.key);
  });
});

describe("routeCall: the reserved set", () => {
  const rungs = [R.opus, R.haiku, R.fable];

  it("is closed by default", () => {
    const d = routeCall(callParams({ rungs }))!;
    expect(keys(d)).not.toContain(FABLE);
    expect(d.reservedReason).toBeUndefined();
  });

  it("opens for a named reason and records it", () => {
    const d = routeCall(callParams({ rungs, reservedReason: "dial" }))!;
    expect(keys(d)).toContain(FABLE);
    expect(d.reservedReason).toBe("dial");
    const b = routeCall(callParams({ rungs, reservedReason: "ballistic" }))!;
    expect(b.reservedReason).toBe("ballistic");
  });

  it("opens for feasibility, and says so, when nothing else survives", () => {
    const d = routeCall(callParams({ rungs: [R.grok, R.fable], cooling: new Set(["xai"]) }))!;
    expect(keys(d)).toEqual([FABLE, FABLE].slice(0, keys(d).length));
    expect(d.reservedReason).toBe("feasibility");
    expect(d.vetoes.map((v) => v.key)).toEqual([GROK]);
  });

  it("returns nothing when nothing survives at all", () => {
    const d = routeCall(
      callParams({
        rungs: [R.opus, R.grok],
        task: taskRead({ private: true }),
        approvedProviders: [],
      }),
    );
    expect(d).toBeUndefined();
  });
});

describe("routeCall: the switch policy at work", () => {
  it("switches freely at a fresh point, with a brief", () => {
    const d = routeCall(
      callParams({
        cache: warm(OPUS, 100_000),
        freshPoint: true,
        step: stepRead({ needs: answered("item" as const) }),
      }),
    )!;
    expect(d.pick.feed).toBe("brief");
    expect(d.pick.rung.key).toBe(HAIKU);
    expect(d.switch).toEqual({ kind: "fresh", reason: "fresh-point" });
    expect(d.chosen).toBe(d.pick);
    expect(d.wouldChange).toBe(true);
  });

  it("treats a check as a fresh point", () => {
    const d = routeCall(
      callParams({
        cache: warm(OPUS, 100_000),
        step: stepRead({ kind: answered("check" as const), needs: answered("item" as const) }),
      }),
    )!;
    expect(d.switch.kind).toBe("fresh");
  });

  it("holds a running thread below N* and moves it above N*", () => {
    // Opus 5 -> Haiku 4.5 with the one-hour write: N* = 4.75. Run-length levels give N of 4 and 8.
    const cache = warm(OPUS, 100_000);
    const above = routeCall(
      callParams({ cache, step: stepRead({ runLength: answered(3 as const) }) }),
    )!;
    expect(above.pick.rung.key).toBe(HAIKU);
    expect(above.switch).toMatchObject({
      kind: "switch",
      reason: "run-exceeds-n-star",
      expectedRun: 8,
    });
    expect(above.switch.nStar).toBeCloseTo(4.75, 10);
    expect(above.chosen.rung.key).toBe(HAIKU);
    expect(above.wouldChange).toBe(true);

    // Output-heavy steps make Haiku the cheaper pick even at N = 4, but the policy still holds.
    const below = routeCall(
      callParams({
        cache,
        step: stepRead({ runLength: answered(2 as const) }),
        expectedOutputTokens: () => 3000,
      }),
    )!;
    expect(below.pick.rung.key).toBe(HAIKU);
    expect(below.switch).toMatchObject({
      kind: "keep",
      reason: "kept-below-n-star",
      expectedRun: 4,
    });
    expect(below.chosen.rung.key).toBe(OPUS);
    expect(below.wouldChange).toBe(false);
  });

  it("moves when the incumbent's cache has gone cold anyway", () => {
    const d = routeCall(callParams({ step: stepRead({ runLength: answered(1 as const) }) }))!;
    expect(d.pick.rung.key).toBe(HAIKU);
    expect(d.switch).toMatchObject({ kind: "switch", reason: "cache-cold" });
  });

  it("escalates a stuck step when a stronger model is cheaper than another failed try", () => {
    const params = callParams({
      rungs: [R.haiku, R.sonnet, R.opus, R.grok],
      incumbentKey: HAIKU,
      incumbentEffort: "",
      cache: warm(HAIKU, 1_000),
      feedTokens: { thread: 1_000 },
      expectedOutputTokens: () => 2_000,
      step: stepRead({ depth: answered("deep" as const) }),
      dialBar: 60,
    });
    const stuck = routeCall({ ...params, outcome: "stuck" })!;
    expect(stuck.switch).toEqual({ kind: "switch", reason: "stuck" });
    expect(stuck.chosen.quality).toBeGreaterThan(R.haiku.smart);
    const plain = routeCall(params)!;
    expect(plain.switch.reason).not.toBe("stuck");
    expect(plain.chosen.rung.key).toBe(HAIKU);
  });

  it("a stuck step escalates even when the step read is unsure; the same unsure call otherwise keeps the thread", () => {
    const params = callParams({
      rungs: [R.haiku, R.sonnet, R.opus, R.grok],
      incumbentKey: HAIKU,
      incumbentEffort: "",
      cache: warm(HAIKU, 1_000),
      feedTokens: { thread: 1_000 },
      expectedOutputTokens: () => 2_000,
      step: stepRead({ kind: answered("tool" as const, 0, "fallback") }),
      dialBar: 60,
    });
    const stuck = routeCall({ ...params, outcome: "stuck" })!;
    expect(stuck.degraded).toBe(true);
    expect(stuck.switch).toEqual({ kind: "switch", reason: "stuck" });
    expect(stuck.chosen.rung.key).not.toBe(HAIKU);
    const plain = routeCall(params)!;
    expect(plain.chosen.rung.key).toBe(HAIKU);
  });

  it("moves off an incumbent that the vetoes remove", () => {
    const d = routeCall(
      callParams({ cooling: new Set(["anthropic"]), cache: warm(OPUS, 100_000) }),
    )!;
    expect(d.vetoes.some((v) => v.key === OPUS)).toBe(true);
    expect(d.switch).toEqual({ kind: "switch", reason: "incumbent-vetoed" });
    expect(d.chosen.rung.key).toBe(GROK);
  });

  it("keeps the incumbent when it is also the cheapest", () => {
    const d = routeCall(callParams({ rungs: [R.opus], cache: warm(OPUS, 100_000) }))!;
    expect(d.switch).toMatchObject({ kind: "keep", reason: "no-change" });
    expect(d.wouldChange).toBe(false);
  });
});

describe("routeCall: rungs with no price row (B-review correction 1)", () => {
  const ghost = rung("openai-codex/gpt-9-unlisted", "high", 90, 0.01);

  it("prices an unknown rung on the anchor's unit, so a cheap v2 cost is not an absurdly cheap call", () => {
    const d = routeCall(callParams({ rungs: [R.opus, R.haiku, ghost], anchorKey: OPUS }))!;
    const g = d.options.find((o) => o.rung.key === ghost.key)!;
    const a = d.options.find((o) => o.rung.key === OPUS)!;
    expect(g.parts.moneyKnown).toBe(false);
    expect(g.parts.money).toBeCloseTo((a.parts.money * ghost.cost) / R.opus.cost, 8);
  });

  it("puts an unanchored rung after every anchored one that clears the bar, however cheap its v2 cost", () => {
    // No anchor on the board: every unknown-price rung is unanchored.
    const d = routeCall(
      callParams({ rungs: [R.opus, R.haiku, ghost], anchorKey: "claude-code/not-on-the-board" }),
    )!;
    const unanchored = d.options.filter((o) => o.parts.unanchored);
    expect(unanchored.map((o) => o.rung.key)).toEqual([ghost.key]);
    expect(d.pick.parts.unanchored).toBe(false);
    expect(d.pick.rung.key).not.toBe(ghost.key);
  });

  it("uses an unanchored rung when it is the only one", () => {
    const d = routeCall(
      callParams({
        rungs: [ghost],
        incumbentKey: ghost.key,
        incumbentEffort: "high",
        anchorKey: "nowhere/none",
      }),
    )!;
    expect(d.pick.rung.key).toBe(ghost.key);
  });

  it("keeps a hand-picked unknown-price model", () => {
    const d = routeCall(
      callParams({
        rungs: [ghost],
        handPicked: true,
        incumbentKey: ghost.key,
        incumbentEffort: "high",
      }),
    )!;
    expect(d.switch.reason).toBe("hand-picked");
    expect(d.chosen.rung.key).toBe(ghost.key);
  });
});

describe("routeCall: bar, ties and money basis", () => {
  it("takes the best quality that survived when nothing clears the bar", () => {
    const d = routeCall(callParams({ dialBar: 500, cache: warm(OPUS, 100_000) }))!;
    expect(d.pick.rung.key).toBe(OPUS);
  });

  it("breaks a price tie in favour of the incumbent", () => {
    const twin = { ...R.opus, key: "claude-code/claude-opus-4-8" };
    const d = routeCall(
      callParams({
        rungs: [twin, R.opus],
        cache: EMPTY_CACHE_LEDGER,
        step: stepRead({ runLength: answered(0 as const) }),
      }),
    )!;
    // Opus 4.8 and Opus 5 list the same prices, so only the incumbent rule can separate them.
    expect(d.pick.rung.key).toBe(OPUS);
  });

  it("carries the money basis of the chosen option onto the decision", () => {
    expect(routeCall(callParams())!.moneyBasis).toBe("list");
    const plan = routeCall(callParams({ planFactor: { anthropic: 0.5 } }))!;
    expect(plan.moneyBasis).toBe("plan");
    expect(plan.chosen.moneyBasis).toBe("plan");
  });

  it("gives the same answer whatever order the rungs arrive in", () => {
    const cache = warm(OPUS, 100_000);
    const step = stepRead({ runLength: answered(3 as const) });
    const a = routeCall(callParams({ cache, step, rungs: [R.opus, R.sonnet, R.haiku, R.grok] }))!;
    const b = routeCall(callParams({ cache, step, rungs: [R.grok, R.haiku, R.opus, R.sonnet] }))!;
    expect(b.chosen.rung.key).toBe(a.chosen.rung.key);
    expect(b.switch).toEqual(a.switch);
    expect(b.pick.runPrice).toBeCloseTo(a.pick.runPrice, 12);
  });

  it("records the ids, lane, mode and dial it was given", () => {
    const d = routeCall(
      callParams({ lane: "cc-bridge", mode: "shadow", dialIdx: 5, callIndex: 9 }),
    )!;
    expect(d).toMatchObject({
      id: "d1",
      runId: "run-1",
      callIndex: 9,
      lane: "cc-bridge",
      mode: "shadow",
      dialIdx: 5,
      applied: false,
    });
    expect(d.reason).toContain(d.chosen.rung.key);
  });

  it("stays inside a reasonable time for a large board", () => {
    const rungs = Array.from({ length: 200 }, (_, i) => ({
      ...R.haiku,
      key: `claude-code/claude-haiku-4-5`,
      effort: `e${i}`,
      smart: 40 + (i % 30),
    }));
    const t0 = performance.now();
    routeCall(callParams({ rungs, supplies: supplies() }));
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

// the architect, 2026-10-02 (full deploy): the per-call router reads the same suggestion rule as the per-turn router.
describe("routeCall: the architect's suggestion", () => {
  const codeTask = taskRead({ kind: answered("code" as const) });
  const strengths: Record<string, number> = {
    [HAIKU]: 0.5,
    [SONNET]: 0.8,
    [OPUS]: 0.7,
  };
  const strengthFor = (key: string) => strengths[key];

  it("makes the suggestion's thread option the pick, at the effort it asked for", () => {
    const d = routeCall(callParams({ suggestion: { key: SONNET, effort: "medium" } }))!;
    expect(d.pick.rung).toMatchObject({ key: SONNET, effort: "medium" });
    expect(d.pick.feed).toBe("thread");
    expect(d.suggestion).toEqual({ state: "kept", key: SONNET, effort: "medium" });
  });

  it("moves off it for a measured rival that clears the bar and still wins after the 10 % prior", () => {
    const d = routeCall(callParams({ task: codeTask, strengthFor, suggestion: { key: HAIKU } }))!;
    // code: haiku p0.5 x 1.1 = 0.55; sonnet p0.8 leads by 60 %
    expect(d.pick.rung.key).toBe(SONNET);
    expect(d.suggestion).toMatchObject({
      state: "moved",
      key: HAIKU,
      cause: "better",
      gainPct: 60,
    });
    expect(d.suggestion?.to).toContain(SONNET);
  });

  it("keeps a suggestion with no measured row for the task's domain, and one the domain read is unsure about", () => {
    const noRow = routeCall(
      callParams({
        task: codeTask,
        strengthFor: (k) => (k === HAIKU ? undefined : strengths[k]),
        suggestion: { key: HAIKU },
      }),
    )!;
    expect(noRow.suggestion?.state).toBe("kept");
    expect(noRow.pick.rung.key).toBe(HAIKU);

    const unsure = routeCall(
      callParams({
        task: taskRead({ kind: answered("code" as const, 0.2) }),
        strengthFor,
        suggestion: { key: HAIKU },
      }),
    )!;
    expect(unsure.suggestion?.state).toBe("kept");
    expect(unsure.pick.rung.key).toBe(HAIKU);
  });

  it("names the veto that removed the suggestion and routes as it would without one", () => {
    const base = routeCall(callParams({ cooling: new Set(["anthropic"]) }))!;
    const d = routeCall(
      callParams({
        cooling: new Set(["anthropic"]),
        suggestion: { key: SONNET, effort: "medium" },
      }),
    )!;
    expect(d.suggestion).toMatchObject({ state: "moved", key: SONNET, cause: "supply-cooling" });
    expect(d.pick.rung.key).toBe(base.pick.rung.key);
    expect(keys(d)).not.toContain(SONNET);
  });

  it("ignores a suggestion for a model that is not on the board", () => {
    const base = routeCall(callParams())!;
    const d = routeCall(callParams({ suggestion: { key: "nobody/ghost" } }))!;
    expect(d.suggestion).toMatchObject({ state: "ignored", key: "nobody/ghost" });
    expect(d.pick.rung.key).toBe(base.pick.rung.key);
  });

  it("never touches a hand-picked call", () => {
    const d = routeCall(callParams({ handPicked: true, suggestion: { key: HAIKU } }))!;
    expect(d.suggestion).toBeUndefined();
    expect(d.chosen.rung.key).toBe(OPUS);
  });

  it("follows a changed picker preference on the next call instead of keeping the incumbent", () => {
    const d = routeCall(
      callParams({
        incumbentKey: GROK,
        incumbentEffort: "high",
        suggestion: { key: SONNET, effort: "medium" },
        midThread: false,
      }),
    )!;
    expect(d.suggestion).toMatchObject({ state: "kept", key: SONNET, effort: "medium" });
    expect(d.chosen.rung).toMatchObject({ key: SONNET, effort: "medium" });
    expect(d.switch).toMatchObject({ kind: "switch", reason: "preference-changed" });
  });
});

describe("routeCall: enforce.midThread off", () => {
  const cache = warm(OPUS, 100_000);
  const longRun = stepRead({ runLength: answered(4 as const) });

  it("switches a running thread by the N* rule when the flag is not given", () => {
    const d = routeCall(callParams({ cache, step: longRun }))!;
    expect(d.chosen.rung.key).toBe(HAIKU);
    expect(d.switch.kind).toBe("switch");
  });

  it("keeps a running thread, whatever N* says, when midThread is false", () => {
    const d = routeCall(callParams({ cache, step: longRun, midThread: false }))!;
    expect(d.chosen.rung.key).toBe(OPUS);
    expect(d.switch).toMatchObject({ kind: "keep", reason: "mid-thread-off" });
    expect(d.wouldChange).toBe(false);
  });

  it("still switches at a fresh point, and still drops an incumbent a veto removed", () => {
    const fresh = routeCall(
      callParams({ cache, step: longRun, midThread: false, freshPoint: true }),
    )!;
    expect(fresh.chosen.rung.key).toBe(HAIKU);
    const gone = routeCall(
      callParams({ cache, step: longRun, midThread: false, cooling: new Set(["anthropic"]) }),
    )!;
    expect(gone.chosen.rung.key).not.toBe(OPUS);
    expect(gone.switch.reason).toBe("incumbent-vetoed");
  });
});
