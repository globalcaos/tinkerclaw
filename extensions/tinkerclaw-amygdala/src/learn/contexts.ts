/**
 * Per-context counts and the effective cut-off (design doc §7.3 item 3). A false alarm is quieted only where it was
 * false: every counter is keyed by `contextKey`, never global. The resolver is the `cutoffFor` hook of `decide`.
 */
import { parseDrivers } from "../events.js";
import type { AmygdalaStore } from "../store.js";
import type { Cutoff, Decision, Question, Situation } from "../types.js";
import { contextKey } from "./keys.js";

export function createCutoffResolver(
  store: AmygdalaStore,
): (q: Question, s: Situation) => Cutoff | undefined {
  return (q, s) => store.getContextOverride(q.id, contextKey(s, q.id));
}

/** Every driver question of a decision that acted (not proceed, not refusal) counts one alarm in its own context. */
export function recordAlarms(
  store: AmygdalaStore,
  situation: Situation,
  decision: Decision,
  now: number,
): void {
  const kind = decision.response.kind;
  if (kind === "proceed" || kind === "refusal") return;
  for (const q of parseDrivers(decision.reasonCode)) {
    store.bumpContext(contextKey(situation, q), q, { alarms: 1 }, now);
  }
}

export function recordFalseAlarm(
  store: AmygdalaStore,
  situation: Situation,
  questionIds: string[],
  now: number,
): void {
  for (const q of questionIds) {
    store.bumpContext(contextKey(situation, q), q, { falseAlarms: 1 }, now);
  }
}

export function recordConfirm(
  store: AmygdalaStore,
  situation: Situation,
  questionIds: string[],
  now: number,
): void {
  for (const q of questionIds) {
    store.bumpContext(contextKey(situation, q), q, { confirms: 1 }, now);
  }
}
