// The cache ledger's feed (design doc section 8; paper P§3 "cache state").
//
// WHAT THIS IS FOR. The router can only price a switch honestly if it knows how much of each conversation is warm on
// each model. The counts come from the agent-event bus: every model call publishes `stream: "call"` events with the
// provider's own `input`, `cacheRead` and `cacheWrite` (`src/infra/call-telemetry.ts`). This turns those counts into
// the pure cache ledger of `thalamus-cache-ledger.ts`, from counts and never from guesses.
//
// WHICH RUNS. A call event does not say which model made it, so a run is registered first (`noteRun`) by whoever
// knows: the shadow router for embedded runs. Claude Code turns are not registered in D1 (design doc 3.1: that lane's
// calls are seen from the bridge in D2), so their events are ignored here rather than guessed at.

import {
  applyCallUsage,
  cachePolicyFor,
  EMPTY_CACHE_LEDGER,
  pruneLedger,
  type CacheLedger,
} from "openclaw/plugin-sdk/fork-thalamus";

export type LedgerHolder = { ledger: CacheLedger };
export const newLedgerHolder = (): LedgerHolder => ({ ledger: EMPTY_CACHE_LEDGER });

export type RunModel = { conversationKey: string; modelKey: string };

export type AgentEventLike = {
  runId: string;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
};

export type CallEnd = {
  runId: string;
  callIndex: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  stopReason?: string;
  modelKey: string;
};

const MAX_RUNS = 256;

const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

export function createCacheFeed(o: { holder: LedgerHolder; onCallEnd?: (e: CallEnd) => void }) {
  const runs = new Map<string, RunModel>();

  return {
    noteRun(runId: string, m: RunModel): void {
      runs.delete(runId);
      runs.set(runId, m);
      while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string);
    },

    forgetRun(runId: string): void {
      runs.delete(runId);
    },

    /** Fold one agent event into the ledger. Anything that is not a call event with counts is ignored. */
    handle(evt: AgentEventLike): void {
      if (evt.stream !== "call") return;
      const phase = evt.data.phase;
      if (phase !== "usage" && phase !== "end") return;
      const run = runs.get(evt.runId);
      if (!run) return;
      const input = count(evt.data.input);
      const cacheRead = count(evt.data.cacheRead);
      const cacheWrite = count(evt.data.cacheWrite);
      if (input === undefined && cacheRead === undefined && cacheWrite === undefined) return;
      o.holder.ledger = applyCallUsage(
        o.holder.ledger,
        {
          conversationKey: run.conversationKey,
          modelKey: run.modelKey,
          nowMs: evt.ts,
          input: input ?? 0,
          cacheRead: cacheRead ?? 0,
          cacheWrite: cacheWrite ?? 0,
        },
        cachePolicyFor(run.modelKey),
      );
      if (phase === "end") {
        o.onCallEnd?.({
          runId: evt.runId,
          callIndex: count(evt.data.callIndex) ?? -1,
          input: input ?? 0,
          cacheRead: cacheRead ?? 0,
          cacheWrite: cacheWrite ?? 0,
          output: count(evt.data.output) ?? 0,
          ...(typeof evt.data.stopReason === "string" ? { stopReason: evt.data.stopReason } : {}),
          modelKey: run.modelKey,
        });
      }
    },

    prune(nowMs: number): void {
      o.holder.ledger = pruneLedger(o.holder.ledger, nowMs);
    },

    runCount: (): number => runs.size,
  };
}

export type CacheFeed = ReturnType<typeof createCacheFeed>;
