/**
 * TINKER_UI_DESIGN_BIBLE/logging.md §9 step 9 — the CONTROL for the `j.*` rows, which had no rows
 * at all before this change: every J-series metric was DECLARED-and-silent.
 *
 * Four gates, each aimed at a failure that would otherwise read as green:
 *  1. the slot map against the catalog — an n-slot that moves without its helper moving charts
 *     the wrong series and NOTHING at runtime can notice, because the name is still declared;
 *  2. one fixture call per helper — the declared shape is what actually reaches `emitEvent`;
 *  3. a source check per landed producer — a helper nobody calls is indistinguishable from a
 *     working one with nothing to say (L9), which is the whole argument of observability.md §1 —
 *     and its mirror for a row still owed: the named site exists and does NOT call the helper
 *     yet, so the change that wires it must also move the row to WIRED;
 *  4. a fixture call AT the producer wherever the producer can be driven with a temp dir or a
 *     stub store, so the wiring itself (which half emits, with which numbers) is proven, not
 *     only the helper. The contradiction gate is covered by gate 3 alone: driving it needs a
 *     daily log plus an FTS hit on a named entity.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLimbicRuntime } from "../../agents/pi-extensions/limbic-runtime.js";
import { appendGap, makeGap, markResolved } from "../../fork/curiosity-store.js";
import { deriveOverseerLoopBudget } from "../../fork/overseer-budget.js";
import { forkSkillHandlers } from "../../fork/skill-rpc.js";
import { createArtifactStore } from "../../memory/engram/artifact-store.js";
import { createInitialConsolidationState } from "../../memory/engram/episode-detection.js";
import { createEventStore, type EventStore } from "../../memory/engram/event-store.js";
import { recall } from "../../memory/engram/recall-tool.js";
import { createSkillLibrary } from "../../memory/engram/skill-library.js";
import { runSleepConsolidation } from "../../memory/engram/sleep-consolidation.js";
import type { FrontierRung } from "../../shared/thalamus-frontier.js";
import { CONTESTED_MARGIN, thalamusPlan } from "../../shared/thalamus-plan.js";
import {
  supplyStateFrom,
  type SupplyId,
  type SupplyState,
  type SupplyWindowInput,
} from "../../shared/thalamus-supply.js";
import { getCatalogEvent } from "./catalog.js";
import {
  emitJBoundDerived,
  emitJConsolidationRun,
  emitJCuriosityGap,
  emitJLimbicAttempt,
  emitJMnemoContradiction,
  emitJRecallResolve,
  emitJRouteDecision,
  emitJRouteDecisionFromPlan,
  emitJSkillOutcome,
  J_ROW_SPECS,
} from "./j-rows.js";

const emitEventMock = vi.hoisted(() => vi.fn());
vi.mock("./emit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./emit.js")>()),
  emitEvent: emitEventMock,
}));

type EmittedRecord = Record<string, unknown>;

function onlyRow(): { name: string; record: EmittedRecord } {
  expect(emitEventMock.mock.calls).toHaveLength(1);
  const call = emitEventMock.mock.calls[0];
  return { name: call[0] as string, record: (call[1] ?? {}) as EmittedRecord };
}

/** "outcome (hit, miss)" → ["hit","miss"]; "domain" and null → null (open or unused). */
function declaredLabelSet(label: string | null): string[] | null {
  if (label === null) {
    return null;
  }
  const parenthesised = /\(([^)]*)\)/.exec(label);
  if (!parenthesised) {
    return null;
  }
  return parenthesised[1]
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
}

/** The producers this change wires, each with the call its file must contain. */
const WIRED: Readonly<Record<string, { readonly file: string; readonly call: string }>> = {
  "j.recall.resolve": {
    file: "../../memory/engram/recall-tool.ts",
    call: "emitJRecallResolve(",
  },
  "j.consolidation.run": {
    file: "../../memory/engram/sleep-consolidation.ts",
    call: "emitJConsolidationRun(",
  },
  "j.skill.outcome": {
    file: "../../fork/skill-rpc.ts",
    call: "emitJSkillOutcome(",
  },
  "j.limbic.attempt": {
    file: "../../agents/pi-extensions/limbic-runtime.ts",
    call: "emitJLimbicAttempt(",
  },
  "j.curiosity.gap": {
    file: "../../fork/curiosity-store.ts",
    call: "emitJCuriosityGap(",
  },
  "j.mnemo.contradiction": {
    file: "../../memory/engram/contradiction-gate.ts",
    call: "emitJMnemoContradiction(",
  },
  "j.bound.derived": {
    file: "../../fork/overseer-budget.ts",
    call: "emitJBoundDerived(",
  },
  // §4.12 names `src/shared/thalamus-plan.ts`, but that module is browser-bundled (tinker-ui
  // imports `thalamusPlan`), so the row is written by its node-only caller instead.
  "j.route.decision": {
    file: "../../auto-reply/reply/model-selection.ts",
    call: "emitJRouteDecisionFromPlan(",
  },
};

/**
 * Shapes whose producer is known but does not call them yet: the site each is owed at and the call
 * it will make. Empty since 2026-09-25 (j.route.decision wired in model-selection.ts). A row added
 * here is DECLARED-and-silent; the tripwire below turns red the day its producer calls it, so the
 * row moves to WIRED in the same change.
 */
const UNWIRED: Readonly<Record<string, { readonly file: string; readonly call: string }>> = {};

describe("j.* row shapes (logging.md §4.12)", () => {
  beforeEach(() => {
    emitEventMock.mockClear();
  });

  it("fills the slots the catalog declares, for every row", () => {
    for (const [name, spec] of Object.entries(J_ROW_SPECS)) {
      const entry = getCatalogEvent(name);
      expect(entry, `${name} is not in the catalog`).toBeDefined();
      expect(entry!.retention, `${name} retention`).toBe("research");
      expect(entry!.paper, `${name} paper`).not.toBeNull();
      expect(spec.durMs, `${name} dur_ms`).toBe(entry!.durMs);
      expect(spec.n1, `${name} n1`).toBe(entry!.n1);
      expect(spec.n2, `${name} n2`).toBe(entry!.n2);
      expect(spec.n3, `${name} n3`).toBe(entry!.n3);
      expect(spec.n4, `${name} n4`).toBe(entry!.n4);
      expect([...spec.fields].toSorted(), `${name} fields`).toEqual(
        Object.keys(entry!.fields).toSorted(),
      );
    }
  });

  it("types exactly the closed label set §4.12 declares", () => {
    for (const [name, spec] of Object.entries(J_ROW_SPECS)) {
      const entry = getCatalogEvent(name)!;
      const declared = declaredLabelSet(entry.label);
      expect(spec.labels === null ? null : [...spec.labels], `${name} labels`).toEqual(declared);
    }
  });

  it("accounts for every shape: wired to a producer, or listed as unwired", () => {
    expect([...Object.keys(WIRED), ...Object.keys(UNWIRED)].toSorted()).toEqual(
      Object.keys(J_ROW_SPECS).toSorted(),
    );
  });

  it("rows a recall hit with the pointer age and the count", () => {
    emitJRecallResolve({
      outcome: "hit",
      pointerAgeMs: 7_200_000,
      eventsReturned: 4,
      sessionKey: "agent:main",
    });
    const { name, record } = onlyRow();
    expect(name).toBe("j.recall.resolve");
    expect(record.label).toBe("hit");
    expect(record.n1).toBe(7_200_000);
    expect(record.n2).toBe(4);
    expect(record.sessionKey).toBe("agent:main");
  });

  it("rows a recall miss with a null pointer age, never a zero", () => {
    emitJRecallResolve({ outcome: "miss", pointerAgeMs: null, eventsReturned: 0 });
    const { record } = onlyRow();
    expect(record.label).toBe("miss");
    expect(record.n1).toBeNull();
    expect(record.n2).toBe(0);
  });

  it("rows a consolidation cycle as a span with its three counts", () => {
    emitJConsolidationRun({
      durMs: 1_234,
      eventsScanned: 480,
      skillsExtracted: 2,
      skillsDeprecated: 0,
    });
    const { name, record } = onlyRow();
    expect(name).toBe("j.consolidation.run");
    expect(record.durMs).toBe(1_234);
    expect(record.n1).toBe(480);
    expect(record.n2).toBe(2);
    expect(record.n3).toBe(0);
    expect(record.label).toBeUndefined();
  });

  it("rows an emitted and a suppressed humor attempt", () => {
    emitJLimbicAttempt({ outcome: "emitted", humorPotential: 0.62 });
    expect(onlyRow().record).toMatchObject({ label: "emitted", n1: 0.62 });
    emitEventMock.mockClear();
    emitJLimbicAttempt({ outcome: "suppressed", humorPotential: null });
    const { record } = onlyRow();
    expect(record.label).toBe("suppressed");
    expect(record.n1).toBeNull();
  });

  it("rows a gap opening at age 0 and a resolution at its real open age", () => {
    emitJCuriosityGap({ toState: "logged", ageMs: 0, runId: "run-1" });
    expect(onlyRow().record).toMatchObject({ label: "logged", n1: 0, runId: "run-1" });
    emitEventMock.mockClear();
    emitJCuriosityGap({ toState: "resolved", ageMs: 86_400_000 });
    expect(onlyRow().record).toMatchObject({ label: "resolved", n1: 86_400_000 });
  });

  it("rows a contradiction check by outcome alone", () => {
    emitJMnemoContradiction({ outcome: "flagged" });
    const { name, record } = onlyRow();
    expect(name).toBe("j.mnemo.contradiction");
    expect(record.label).toBe("flagged");
    expect(record.n1).toBeUndefined();
  });

  it("rows a derived bound as parts: value, ceiling, fired, sample size", () => {
    emitJBoundDerived({
      bound: "overseer.loop",
      derivedValue: 3,
      ceiling: 2,
      fired: 1,
      sampleSize: 4,
    });
    const { name, record } = onlyRow();
    expect(name).toBe("j.bound.derived");
    expect(record.label).toBe("overseer.loop");
    expect(record.n1).toBe(3);
    expect(record.n2).toBe(2);
    expect(record.n3).toBe(1);
    expect(record.n4).toBe(4);
  });

  it("rows a route decision with the house, mode, score and margin as declared fields", () => {
    emitJRouteDecision({
      domain: "science",
      house: "anthropic",
      mode: "solo",
      score: 0.95,
      margin: 0.04,
    });
    const { name, record } = onlyRow();
    expect(name).toBe("j.route.decision");
    expect(record.label).toBe("science");
    expect(record.fields).toEqual({
      house: "anthropic",
      mode: "solo",
      score: 0.95,
      margin: 0.04,
    });
  });

  it("rows a skill outcome with its version as an id", () => {
    emitJSkillOutcome({ outcome: "success", skillVersion: "v3" });
    const { name, record } = onlyRow();
    expect(name).toBe("j.skill.outcome");
    expect(record.label).toBe("success");
    expect(record.fields).toEqual({ skill_version: "v3" });
  });

  it("every wired producer really calls its helper — a shipped shape nobody calls is silent", () => {
    for (const [name, { file, call }] of Object.entries(WIRED)) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, `${name}: ${file} does not import j-rows`).toContain("infra/events/j-rows.js");
      expect(source, `${name}: ${file} imports the helper but never calls it`).toContain(call);
    }
  });

  it("every unwired row's producer exists and does not call it yet — wiring it moves the row", () => {
    // The mirror of the check above. It fails the day the producer lands, on purpose: that change
    // must move the row to WIRED, where the positive source check guards it from then on, instead
    // of leaving UNWIRED claiming a silence that is no longer true.
    for (const [name, { file, call }] of Object.entries(UNWIRED)) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, `${name}: ${file} calls it now — move it to WIRED`).not.toContain(call);
    }
  });
});

describe("j.* rows at their producers (fixture calls)", () => {
  let tmp: string;

  beforeEach(() => {
    emitEventMock.mockClear();
    tmp = mkdtempSync(join(tmpdir(), "j-rows-producer-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Every emitted j.* row, in order — a producer may also emit rows this suite does not own. */
  function jRows(name: string): EmittedRecord[] {
    return emitEventMock.mock.calls
      .filter((call) => call[0] === name)
      .map((call) => (call[1] ?? {}) as EmittedRecord);
  }

  it("recall-tool rows a hit with its reach and count, and a miss with a null reach", async () => {
    const store = createEventStore({ baseDir: tmp, sessionKey: "agent:main:main" });
    const ev = store.append({
      turnId: 1,
      sessionKey: "agent:main:main",
      kind: "agent_message",
      content: "the deploy commit hash was a1b2c3d4e5f6",
      tokens: 12,
      metadata: {},
    });

    const hit = await recall({ query: "deploy commit hash" }, store);
    expect(hit.events.length).toBeGreaterThan(0);
    const [hitRow] = jRows("j.recall.resolve");
    expect(hitRow.label).toBe("hit");
    expect(hitRow.n2).toBe(hit.events.length);
    expect(typeof hitRow.n1).toBe("number");
    expect(hitRow.n1 as number).toBeGreaterThanOrEqual(0);
    expect(hitRow.sessionKey).toBe("agent:main:main");

    emitEventMock.mockClear();
    const miss = await recall({ query: "deploy commit hash" }, store, new Set([ev.id]));
    expect(miss.events).toHaveLength(0);
    expect(jRows("j.recall.resolve")).toEqual([
      expect.objectContaining({ label: "miss", n1: null, n2: 0 }),
    ]);
    // L4: the query text never reaches a row.
    expect(JSON.stringify(emitEventMock.mock.calls)).not.toContain("deploy commit");
  });

  it("sleep-consolidation rows an idle cycle as a measured zero, not silence", async () => {
    const store = createEventStore({ baseDir: tmp, sessionKey: "agent:main:main" });
    const result = await runSleepConsolidation(
      store,
      createArtifactStore({ baseDir: tmp }),
      createInitialConsolidationState(),
    );
    expect(result.eventsProcessed).toBe(0);
    const rows = jRows("j.consolidation.run");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ n1: 0, n2: 0, n3: 0, sessionKey: "agent:main:main" });
    expect(typeof rows[0].durMs).toBe("number");
  });

  it("sleep-consolidation rows a working cycle with events scanned and skills extracted", async () => {
    const store = createEventStore({ baseDir: tmp, sessionKey: "agent:main:main" });
    for (const [turnId, kind, content] of [
      [0, "user_message", "fix the merge conflict"],
      [1, "tool_call", "git checkout --ours foo.ts"],
      [2, "agent_message", "resolved; tests green"],
    ] as const) {
      store.append({
        turnId,
        sessionKey: "agent:main:main",
        kind,
        content,
        tokens: 10,
        metadata: {},
      });
    }
    const result = await runSleepConsolidation(
      store,
      createArtifactStore({ baseDir: tmp }),
      createInitialConsolidationState(),
      {
        skillExtraction: {
          library: createSkillLibrary({ baseDir: tmp }),
          extractor: () => ({
            name: "merge-conflict",
            description: "",
            prerequisites: [],
            steps: ["pick a side", "re-run tests"],
            testCases: [],
          }),
          isWorthy: () => true,
        },
      },
    );
    expect(result.skillsExtracted).toBeGreaterThan(0);
    expect(jRows("j.consolidation.run")).toEqual([
      expect.objectContaining({ n1: 3, n2: result.skillsExtracted, n3: 0 }),
    ]);
  });

  it("skill-rpc rows a recorded outcome with the skill's version as an id", async () => {
    const lib = createSkillLibrary({ baseDir: tmp });
    await lib.put({
      skillId: "sk-j5",
      version: 1,
      name: "skill-j5",
      description: "",
      prerequisites: [],
      steps: ["a"],
      testCases: [],
      successMetrics: { invocations: 0, successes: 0, successRate: 0.5, lastInvoked: null },
      sourceEpisodeIds: [],
      created: new Date().toISOString(),
      deprecated: false,
    });
    let ok = false;
    await forkSkillHandlers["fork.skill.recordOutcome"]!({
      params: { skillId: "sk-j5", success: false, baseDir: tmp },
      respond: (accepted: boolean) => {
        ok = accepted;
      },
      isWebchatConnect: () => false,
    } as never);
    expect(ok).toBe(true);
    const rows = jRows("j.skill.outcome");
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("failure");
    expect((rows[0].fields as Record<string, unknown>).skill_version).toMatch(/^v\d+$/);
    expect(JSON.stringify(rows)).not.toContain("sk-j5");
  });

  it("limbic-runtime rows an emitted attempt with its potential and a suppressed one with null", () => {
    const eventStore = { sessionKey: "agent:main:main", append: vi.fn() } as unknown as EventStore;
    const runtime = createLimbicRuntime(eventStore);

    runtime.logAttempt("a1", { conceptA: "cat", conceptB: "piano", bridge: "keys", score: 0.7 }, 1);
    expect(jRows("j.limbic.attempt")).toEqual([
      expect.objectContaining({ label: "emitted", n1: 0.7, sessionKey: "agent:main:main" }),
    ]);

    emitEventMock.mockClear();
    expect(runtime.checkSensitivity("cats and pianos").allowed).toBe(true);
    expect(jRows("j.limbic.attempt")).toHaveLength(0);

    expect(runtime.checkSensitivity("funeral grief").allowed).toBe(false);
    expect(jRows("j.limbic.attempt")).toEqual([
      expect.objectContaining({ label: "suppressed", n1: null }),
    ]);
    expect(JSON.stringify(emitEventMock.mock.calls)).not.toContain("funeral");
  });

  it("curiosity-store rows a gap opening at 0, then ONE resolution at its real open age", () => {
    const openedAt = Date.now() - 3_600_000;
    const gap = makeGap({
      topic: "free text that must not travel",
      source: "manual",
      ts: openedAt,
      sessionKey: "agent:main:main",
      runId: "run-7",
    });
    appendGap(gap, tmp);
    expect(jRows("j.curiosity.gap")).toEqual([
      expect.objectContaining({ label: "logged", n1: 0, runId: "run-7" }),
    ]);

    emitEventMock.mockClear();
    const resolved = markResolved(gap.id, "tester", "external", {
      baseDir: tmp,
      nowTs: openedAt + 3_600_000,
    });
    expect(resolved?.resolvedAt).toBe(openedAt + 3_600_000);
    // The resolution row goes through appendGap too; it must not ALSO count as a new opening.
    expect(jRows("j.curiosity.gap")).toEqual([
      expect.objectContaining({ label: "resolved", n1: 3_600_000, runId: "run-7" }),
    ]);
    expect(JSON.stringify(emitEventMock.mock.calls)).not.toContain("free text");
  });

  it("overseer-budget rows a clamped derivation as parts", () => {
    const bound = deriveOverseerLoopBudget({
      fitnessSuccessRate: 0,
      gapShrinking: true,
      remainingDispatchBudget: 2_000,
      estStepTokens: 1_000,
    });
    expect(bound).toBe(2);
    expect(jRows("j.bound.derived")).toEqual([
      expect.objectContaining({ label: "overseer.loop", n1: 4, n2: 2, n3: 1, n4: 4 }),
    ]);
  });

  it("overseer-budget rows an unclamped derivation from zero live signals as exactly that", () => {
    expect(deriveOverseerLoopBudget({})).toBe(2);
    expect(jRows("j.bound.derived")).toEqual([
      expect.objectContaining({ label: "overseer.loop", n1: 2, n2: null, n3: 0, n4: 0 }),
    ]);
  });
});

/**
 * J19 · the route row from a REAL `thalamusPlan`. The board and supplies copy
 * `src/shared/thalamus-plan.test.ts`, so the picks that file pins (Opus leads, GPT is the best
 * rival house) are the picks measured here. j-rows.ts re-derives the margin because the plan
 * keeps it private; these cases hold both derivations to the SAME contested / uncontested call.
 */
describe("j.route.decision from a real thalamus plan", () => {
  const NOW = 1_757_000_000_000;
  const OPUS = "claude-code/claude-opus-5";
  const GPT = "openai-codex/gpt-5.6";
  const rung = (key: string, effort: string, smart: number, cost: number): FrontierRung => ({
    key,
    effort,
    smart,
    cost,
    basis: "measured",
  });
  const BOARD: readonly FrontierRung[] = [
    rung("openrouter/qwen3.8-mini", "", 40, 0.01),
    rung("google/gemini-3-flash", "", 52, 0.02),
    rung("xai/grok-4.6", "low", 50, 0.04),
    rung("xai/grok-4.6", "high", 58, 0.1),
    rung(GPT, "", 61, 0.3),
    rung("github-copilot/gpt-5.6-mini", "", 55, 0.4),
    rung(OPUS, "high", 63, 0.5),
    rung("claude-code/claude-fable-5-1", "high", 66, 1.2),
  ];
  const win = (label: string, usedPercent: number): SupplyWindowInput => ({ label, usedPercent });
  const supplies = (): Map<SupplyId, SupplyState> =>
    new Map<SupplyId, SupplyState>([
      ["anthropic", supplyStateFrom("anthropic", [win("5-hour", 39), win("7-day", 71)], NOW)],
      ["xai", supplyStateFrom("xai", [win("Weekly", 28)], NOW)],
      ["openai", supplyStateFrom("openai", [win("5-hour", 40), win("Weekly", 60)], NOW)],
      ["copilot", supplyStateFrom("copilot", [win("monthly", 50)], NOW)],
      ["google", supplyStateFrom("google", [win("daily", 10)], NOW)],
    ]);

  beforeEach(() => {
    emitEventMock.mockClear();
  });

  it("rows an uncontested pick with the margin the plan read as uncontested", () => {
    const plan = thalamusPlan({
      rungs: BOARD,
      supplies: supplies(),
      biasIdx: 4,
      domain: "code",
      strengthFor: () => undefined,
      nowMs: NOW,
    })!;
    expect(plan.mode).toBe("critic"); // the plan judged the lead clear
    emitJRouteDecisionFromPlan(plan, { sessionKey: "agent:main:main", runId: "run-19" });
    const { name, record } = onlyRow();
    expect(name).toBe("j.route.decision");
    expect(record.label).toBe("code");
    expect(record.sessionKey).toBe("agent:main:main");
    expect(record.runId).toBe("run-19");
    expect(record.fields).toEqual({ house: "anthropic", mode: "critic", score: 63, margin: 2 });
    const margin = (record.fields as Record<string, number>).margin;
    expect(margin).toBeGreaterThanOrEqual(CONTESTED_MARGIN);
  });

  it("rows a contested pick with a margin inside CONTESTED_MARGIN, as the plan that chose debate", () => {
    const contested = BOARD.map((r) => (r.key === GPT ? rung(GPT, "", 62, 0.3) : r));
    const plan = thalamusPlan({
      rungs: contested,
      supplies: supplies(),
      biasIdx: 4,
      nowMs: NOW,
    })!;
    expect(plan.mode).toBe("debate");
    emitJRouteDecisionFromPlan(plan);
    const fields = onlyRow().record.fields as Record<string, unknown>;
    expect(fields).toMatchObject({ house: "anthropic", mode: "debate", score: 63, margin: 1 });
    expect(fields.margin as number).toBeLessThan(CONTESTED_MARGIN);
  });

  it("rows a one-house board with a NULL margin, never the 0 that reads as a dead heat", () => {
    const plan = thalamusPlan({
      rungs: [rung(OPUS, "high", 63, 0.5)],
      supplies: supplies(),
      biasIdx: 3,
      nowMs: NOW,
    })!;
    emitJRouteDecisionFromPlan(plan);
    const fields = onlyRow().record.fields as Record<string, unknown>;
    expect(fields).toMatchObject({ house: "anthropic", mode: "solo", score: 63 });
    expect(fields.margin).toBeNull();
  });

  it("never lets a model key, the reason line or a path reach the row (L4)", () => {
    const plan = thalamusPlan({
      rungs: BOARD,
      supplies: supplies(),
      biasIdx: 4,
      domain: "code",
      strengthFor: () => undefined,
      nowMs: NOW,
    })!;
    emitJRouteDecisionFromPlan(plan);
    const wire = JSON.stringify(emitEventMock.mock.calls);
    for (const r of BOARD) {
      expect(wire).not.toContain(r.key);
    }
    expect(wire).not.toContain(plan.reason);
    expect(wire).not.toContain("/");
  });
});
