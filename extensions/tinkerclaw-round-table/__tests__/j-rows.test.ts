/**
 * J6 `j.synapse.debate` — TINKER_UI_DESIGN_BIBLE/logging.md §4.12 (§9 step 9): one span row per
 * debate — participants, distinct providers, rounds and position changes.
 *
 * CONTROL: before this change `emitSynapseDebate` does not exist, so every test below fails.
 *
 * `emitEvent` is mocked at the plugin-sdk subpath (no writer, no database). The one production
 * caller is the round_table tool in index.ts, right after `orchestrator.runDebate` settles; the
 * producer is tested here directly because the tool path needs live model calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitSynapseDebate, raacOrchestrator } from "../src/orchestrator-api.js";
import { runDebate, type DebateResult, type DebateRound } from "../src/raac-protocol.js";

type EmittedRow = { name: string; record: Record<string, unknown> };

const emitted = vi.hoisted(() => ({ rows: [] as EmittedRow[] }));

vi.mock("openclaw/plugin-sdk/fork-telemetry", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.rows.push({ name, record });
  },
}));

const rows = (): EmittedRow[] => emitted.rows.filter((r) => r.name === "j.synapse.debate");

beforeEach(() => {
  emitted.rows.length = 0;
});

function round(roundNumber: number, ratification: DebateRound["ratification"]): DebateRound {
  return {
    roundNumber,
    proposals: {},
    challenges: {},
    defenses: {},
    synthesis: "",
    ratification,
    converged: false,
    costs: [],
  } as unknown as DebateRound;
}

function debate(rounds: DebateRound[]): DebateResult {
  return { task: "t", rounds, finalSynthesis: "", converged: true } as unknown as DebateResult;
}

describe("J6 j.synapse.debate", () => {
  it("counts a participant whose vote differs from its own previous-round vote as a position change", () => {
    emitSynapseDebate({
      result: debate([
        round(1, { a: "reject", b: "accept", c: "amend" }),
        round(2, { a: "accept", b: "accept", c: "amend" }),
        round(3, { a: "accept", b: "reject", c: "accept" }),
      ]),
      durMs: 1234,
      participantCount: 3,
      refs: ["anthropic/claude-x", "openai/gpt-y", "google/gemini-z"],
    });

    expect(rows()).toHaveLength(1);
    // round 1→2: a changed; round 2→3: b and c changed.
    expect(rows()[0].record).toEqual({ durMs: 1234, n1: 3, n2: 3, n3: 3, n4: 3 });
  });

  it("counts PROVIDERS from the resolved refs, not participants", () => {
    emitSynapseDebate({
      result: debate([round(1, {})]),
      durMs: 1,
      participantCount: 3,
      refs: ["anthropic/claude-x", "anthropic/claude-y", "openai/gpt-y"],
    });
    expect(rows()[0].record).toMatchObject({ n1: 3, n2: 2 });
  });

  it("a one-round debate has zero position changes — an honest 0, not a missing number", () => {
    emitSynapseDebate({
      result: debate([round(1, { a: "accept", b: "reject" })]),
      durMs: 1,
      participantCount: 2,
      refs: ["anthropic/claude-x", "openai/gpt-y"],
    });
    expect(rows()[0].record).toMatchObject({ n3: 1, n4: 0 });
  });

  it("a participant that joins mid-debate (a promoted backup) is not a position change", () => {
    emitSynapseDebate({
      result: debate([round(1, { a: "accept" }), round(2, { a: "accept", backup: "reject" })]),
      durMs: 1,
      participantCount: 2,
      refs: ["anthropic/claude-x", "openai/gpt-y"],
    });
    expect(rows()[0].record.n4).toBe(0);
  });

  it("leaves the RAAC orchestrator's identity guard intact (no wrapper was introduced)", () => {
    expect(raacOrchestrator.runDebate).toBe(runDebate);
  });
});
