// Test fixtures shared by the THALAMUS v4 unit tests. Not imported by any shipped code.

import { EMPTY_CACHE_LEDGER } from "./thalamus-cache-ledger.js";
import type { FrontierRung } from "./thalamus-frontier.js";
import type { RouteCallParams } from "./thalamus-route-call.js";
import { supplyStateFrom, type SupplyId, type SupplyState } from "./thalamus-supply.js";
import type { Answered, ReadSource, StepRead, TaskRead } from "./thalamus-v4-types.js";

export const NOW = 1_800_000_000_000;

export const OPUS = "claude-code/claude-opus-5";
export const SONNET = "claude-code/claude-sonnet-5-5";
export const HAIKU = "claude-code/claude-haiku-4-5";
export const FABLE = "claude-code/claude-fable-5-1";
export const GROK = "xai/grok-4.7";

export const rung = (
  key: string,
  effort: string,
  smart: number,
  cost: number,
  basis: FrontierRung["basis"] = "measured",
): FrontierRung => ({ key, effort, smart, cost, basis });

export const R = {
  opus: rung(OPUS, "high", 70, 5),
  sonnet: rung(SONNET, "medium", 64, 2),
  haiku: rung(HAIKU, "", 52, 1),
  fable: rung(FABLE, "max", 82, 10),
  grok: rung(GROK, "high", 62, 2),
};

export const answered = <T>(value: T, conf = 0.9, source: ReadSource = "jev"): Answered<T> => ({
  value,
  conf,
  source,
});

export function taskRead(over: Partial<TaskRead> = {}): TaskRead {
  return {
    id: "task-1",
    ts: NOW,
    sessionKey: "s",
    kind: answered("general" as const),
    difficulty: answered(3 as const),
    topic: answered("none" as const),
    urgency: answered("whenever" as const),
    shape: answered("chain" as const),
    private: false,
    ...over,
  };
}

export function stepRead(over: Partial<StepRead> = {}): StepRead {
  return {
    id: "step-1",
    ts: NOW,
    sessionKey: "s",
    callIndex: 3,
    kind: answered("tool" as const),
    depth: answered("mechanical" as const),
    needs: answered("all" as const),
    runLength: answered(0 as const),
    parallelOk: {},
    commitsOrClaims: answered(false),
    ...over,
  };
}

export function supplies(
  over: Partial<Record<SupplyId, Partial<SupplyState>>> = {},
): Map<SupplyId, SupplyState> {
  const ids: SupplyId[] = ["anthropic", "xai"];
  return new Map(
    ids.map((id) => [id, { ...supplyStateFrom(id, [], NOW), ...over[id] } as SupplyState]),
  );
}

export function callParams(over: Partial<RouteCallParams> = {}): RouteCallParams {
  return {
    id: "d1",
    ts: NOW,
    runId: "run-1",
    callIndex: 3,
    lane: "embedded",
    mode: "shadow",
    rungs: [R.opus, R.sonnet, R.haiku, R.grok],
    supplies: supplies(),
    cache: EMPTY_CACHE_LEDGER,
    conversationKey: "conv",
    task: taskRead(),
    step: stepRead(),
    incumbentKey: OPUS,
    incumbentEffort: "high",
    handPicked: false,
    dialIdx: 3,
    dialBar: 50,
    feedTokens: { thread: 100_000, brief: 3_000 },
    expectedOutputTokens: () => 100,
    approvedProviders: ["claude-code"],
    strengthFor: () => undefined,
    ...over,
  };
}
