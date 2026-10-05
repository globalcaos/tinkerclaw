// THALAMUS v4 — stuck escalation (paper J19 v4.1 §5.4 rule 3, §8 step 7).
//
// WHAT THIS IS FOR. "Stuck" is the same failure twice. The harness counts it, so no model call is needed to know.
// This file normalises a failure into a signature, counts consecutive repeats per run, and asks `routeCall` again with
// the bar raised just above the incumbent, so its OWN stuck rule (a stronger model is cheaper than another failed
// try) decides whether escalating pays. It never decides that itself.
//
// HOW IT WAS DERIVED. `STUCK_AFTER_ERRORS` (2) is B's constant. The signature drops what varies between two runs of
// the same failure (numbers, hashes, paths, quoted values) and keeps the words, so "ENOENT /tmp/a17" and
// "ENOENT /tmp/b22" are one failure and "ENOENT" and "EACCES" are two.
//
// WHAT WOULD CHANGE IT. `STUCK_BAR_STEP` is a starting value; the ledger's stuck-then-fixed record tunes it.
//
// PURE. No clock, no I/O.

import { STUCK_AFTER_ERRORS } from "./thalamus-reads.js";
import { routeCall, type RouteCallParams } from "./thalamus-route-call.js";
import type { CallDecision } from "./thalamus-v4-types.js";

/** How far above the incumbent's quality the bar is raised for a stuck step: strictly stronger, by a real margin. */
export const STUCK_BAR_STEP = 1;

/** A failure reduced to what stays the same between two occurrences of it. */
export function failureSignature(p: { toolName?: string; error: string }): string {
  const text = p.error
    .toLowerCase()
    .replace(/\/[^\s'"`:)]+/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/["'`][^"'`]{0,80}["'`]/g, "<q>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${(p.toolName ?? "").toLowerCase()}|${text}`;
}

export type StuckTracker = {
  /** A failure happened (a signature), or the step went well (undefined). */
  note(runId: string, signature: string | undefined): { repeated: number; stuck: boolean };
  repeated(runId: string): number;
  forget(runId: string): void;
  size(): number;
};

export function createStuckTracker(
  o: { stuckAfter?: number; maxRuns?: number } = {},
): StuckTracker {
  const after = o.stuckAfter ?? STUCK_AFTER_ERRORS;
  const max = o.maxRuns ?? 256;
  const runs = new Map<string, { sig: string; count: number }>();
  return {
    note(runId, signature) {
      if (signature === undefined) {
        runs.delete(runId);
        return { repeated: 0, stuck: false };
      }
      const prev = runs.get(runId);
      const count = prev && prev.sig === signature ? prev.count + 1 : 1;
      runs.delete(runId);
      runs.set(runId, { sig: signature, count });
      if (runs.size > max) runs.delete(runs.keys().next().value as string);
      return { repeated: count, stuck: count >= after };
    },
    repeated: (runId) => runs.get(runId)?.count ?? 0,
    forget: (runId) => void runs.delete(runId),
    size: () => runs.size,
  };
}

/**
 * `routeCall`, with the stuck rule given a stronger option to weigh. Not stuck: exactly `routeCall`. Stuck: ask once to
 * learn the incumbent's quality, then ask again with the bar just above it and the step treated as deep (no relief); `routeCall`'s stuck rule then keeps the
 * incumbent unless the stronger option costs no more than another failed try's expected price.
 */
export function routeCallWithStuck(p: RouteCallParams, stuck: boolean): CallDecision | undefined {
  if (!stuck) return routeCall(p);
  const first = routeCall({ ...p, outcome: "stuck" });
  if (!first) return undefined;
  const incumbent =
    first.options.find(
      (o) =>
        o.rung.key === p.incumbentKey &&
        o.feed === "thread" &&
        o.rung.effort === (p.incumbentEffort ?? o.rung.effort),
    ) ?? first.options.find((o) => o.rung.key === p.incumbentKey && o.feed === "thread");
  if (!incumbent) return first;
  // A step that has failed the same way twice is not mechanical, whatever the read said: it gets no depth relief, so
  // the raised bar is really the bar.
  return (
    routeCall({
      ...p,
      outcome: "stuck",
      dialBar: Math.max(p.dialBar, incumbent.quality + STUCK_BAR_STEP),
      step: { ...p.step, depth: { value: "deep", conf: 1, source: "local" } },
    }) ?? first
  );
}
