// The shadow router (design doc section 11.2; charter phase D1).
//
// WHAT THIS IS FOR. For every model call of an embedded run, compute the decision `routeCall` would take on the real
// path, work out the ladder it would fall back on, and write both down. Then change nothing. Shadow is only worth
// running if it costs the run nothing and can break nothing, so:
//   - it OBSERVES: `observe()` returns nothing, and the wrapper hands the original arguments on untouched;
//   - it FAILS OPEN: any error is counted and swallowed, never raised into the runner;
//   - it NEVER WAITS: the decision is computed synchronously from data already in memory (a cached board, the
//     in-memory cache ledger, a walk over the messages), and the write and the broadcast are deferred off the call's
//     path with `setImmediate`;
//   - it is HONEST about being local: reads come from local rules (`localTaskRead`, `localStepRead`), so every read
//     is marked unsure and the decision is the cautious one. That is what a real conversation gets until Jev is
//     switched on for real content (`jev.sendRealSituations`, the architect's call).
// Enforcement of a per-call model change is not built in D1: the router has no way to return a replacement model.

import {
  isPrivateSource,
  ladderFor,
  localStepRead,
  localTaskRead,
  routeCallWithStuck,
  STUCK_AFTER_ERRORS,
  thalamusRoute,
  type CallDecision,
  type CallRouter,
  type CallRouteCall,
  type TaskRead,
  type RouteCallParams,
  type StuckTracker,
  type ThalamusBoardLike,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { CacheFeed, LedgerHolder } from "./cache-feed.js";
import type { ThalamusConfig } from "./config.js";
import { sourceOfSessionKey, viewContext } from "./context-view.js";
import type { RunStates } from "./run-state.js";
import type { ThalamusStore } from "./store.js";

/** A model call's expected output, until measured time and length per rung exist (phase F). */
export const EXPECTED_OUTPUT_TOKENS = 600;
/** A decision that takes longer than this to compute is counted as slow. */
export const SLOW_MS = 5;
/** How long a board or a hand-picked answer is reused. */
export const BOARD_TTL_MS = 30_000;

export type ShadowStats = {
  calls: number;
  decisions: number;
  noBoard: number;
  noOption: number;
  errors: number;
  slow: number;
  maxMs: number;
};

export type ShadowDeps = {
  cfg: () => ThalamusConfig;
  board: (nowMs: number) => ThalamusBoardLike | undefined;
  handPicked: (sessionKey: string | undefined, agentId: string | undefined) => boolean;
  holder: LedgerHolder;
  feed: CacheFeed;
  store: () => ThalamusStore | undefined;
  broadcast: (name: string, payload: unknown) => void;
  now: () => number;
  /** Runs a function off the call's path. Default: `setImmediate`. */
  defer?: (fn: () => void) => void;
  /** Milliseconds, for measuring the router's own cost. */
  clock?: () => number;
  onError?: (err: unknown) => void;
  /** Where the run's latest `routeCall` parameters go for the digest, check and finish services. */
  runs?: RunStates;
  /** Counts the same failure repeating; at `STUCK_AFTER_ERRORS` the call is routed with the stuck rule. */
  stuck?: StuckTracker;
  /**
   * What the ledger taught the router (phase F), each only when `learning.apply` is on and there is something learned.
   * Absent or undefined: the router reads the public map alone and knows no refusal, exactly as before.
   */
  learned?: () => {
    strengthFor?: RouteCallParams["strengthFor"];
    refusals?: RouteCallParams["refusals"];
  };
};

type RunState = { task: TaskRead; source: string; private: boolean };

/** What the panel and the feed method show for one decision. Route keys are fine on a gateway event. */
export function decisionEvent(d: CallDecision) {
  const incumbent = d.options.find((o) => o.rung.key === d.incumbent && o.feed === "thread");
  return {
    decisionId: d.id,
    runId: d.runId,
    callIndex: d.callIndex,
    lane: d.lane,
    mode: d.mode,
    pick: `${d.pick.rung.key}${d.pick.rung.effort ? `@${d.pick.rung.effort}` : ""}`,
    chosen: `${d.chosen.rung.key}${d.chosen.rung.effort ? `@${d.chosen.rung.effort}` : ""}`,
    incumbent: d.incumbent,
    switch: d.switch,
    wouldChange: d.wouldChange,
    degraded: d.degraded,
    price: d.chosen.price,
    incumbentPrice: incumbent?.price,
    moneyBasis: d.moneyBasis,
    reason: d.reason,
    ...(d.suggestion ? { suggestion: d.suggestion } : {}),
  };
}

export function createShadowRouter(d: ShadowDeps): {
  router: CallRouter;
  stats: () => ShadowStats;
} {
  const stats: ShadowStats = {
    calls: 0,
    decisions: 0,
    noBoard: 0,
    noOption: 0,
    errors: 0,
    slow: 0,
    maxMs: 0,
  };
  const runs = new Map<string, RunState>();
  const picked = new Map<string, { at: number; value: boolean }>();
  let board: { at: number; value: ThalamusBoardLike | undefined } | undefined;
  const defer = d.defer ?? ((fn) => void setImmediate(fn));
  const clock = d.clock ?? (() => performance.now());

  const boardNow = (nowMs: number): ThalamusBoardLike | undefined => {
    if (!board || nowMs - board.at > BOARD_TTL_MS) board = { at: nowMs, value: d.board(nowMs) };
    return board.value;
  };

  const isPicked = (
    sessionKey: string | undefined,
    agentId: string | undefined,
    nowMs: number,
  ): boolean => {
    const k = sessionKey ?? "";
    const hit = picked.get(k);
    if (hit && nowMs - hit.at < BOARD_TTL_MS) return hit.value;
    const value = d.handPicked(sessionKey, agentId);
    picked.set(k, { at: nowMs, value });
    if (picked.size > 512) picked.delete(picked.keys().next().value as string);
    return value;
  };

  const observe = (call: CallRouteCall): void => {
    const t0 = clock();
    stats.calls += 1;
    try {
      const cfg = d.cfg();
      if (cfg.mode === "off") return;
      const nowMs = d.now();
      const meta = call.meta;
      const b = boardNow(nowMs);
      if (!b) {
        stats.noBoard += 1;
        return;
      }
      const view = viewContext(call.context);
      const source = sourceOfSessionKey(meta.sessionKey);
      const isPriv = isPrivateSource(source, cfg.privacy.privateSources);
      const floor = cfg.reads.confidenceFloor;

      let run = runs.get(meta.runId);
      if (!run) {
        run = {
          source,
          private: isPriv,
          task: localTaskRead({
            id: `task:${meta.runId}`,
            ts: nowMs,
            sessionKey: meta.sessionKey ?? meta.runId,
            text: view.firstUserText,
            trigger: meta.trigger,
            private: isPriv,
            floor,
          }),
        };
        runs.set(meta.runId, run);
        if (runs.size > 256) runs.delete(runs.keys().next().value as string);
      }
      const step = localStepRead({
        id: `step:${meta.runId}:${call.callIndex}`,
        ts: nowMs,
        sessionKey: meta.sessionKey ?? meta.runId,
        callIndex: call.callIndex,
        toolName: view.lastToolName,
        floor,
      });

      const incumbentKey = `${meta.provider}/${meta.model}`;
      const incumbentEffort =
        b.rungs.find((r) => r.key === incumbentKey && r.effort === meta.thinkLevel)?.effort ??
        b.rungs.find((r) => r.key === incumbentKey)?.effort ??
        "";
      const incumbentRung = b.rungs.find(
        (r) => r.key === incumbentKey && r.effort === incumbentEffort,
      );
      const conversationKey = meta.sessionKey ?? meta.runId;
      const threadTokens = Math.max(1, view.estimatedTokens);
      const handPicked = isPicked(meta.sessionKey, meta.agentId, nowMs);
      const dialBar =
        thalamusRoute({ rungs: b.rungs, biasIdx: b.dialIdx, domain: run.task.kind.value })
          ?.target ??
        incumbentRung?.smart ??
        0;

      // The cache feed must know which model this run is on before the call's usage arrives.
      d.feed.noteRun(meta.runId, { conversationKey, modelKey: incumbentKey });

      const learnedNow = d.learned?.();
      const params: RouteCallParams = {
        id: `${meta.runId}:${call.callIndex}`,
        ts: nowMs,
        runId: meta.runId,
        callIndex: call.callIndex,
        lane: "embedded",
        mode: cfg.mode === "enforce" ? "enforce" : "shadow",
        rungs: b.rungs,
        supplies: b.supplies,
        cache: d.holder.ledger,
        conversationKey,
        task: run.task,
        step,
        incumbentKey,
        incumbentEffort,
        handPicked,
        dialIdx: b.dialIdx,
        dialBar,
        feedTokens: { thread: threadTokens, brief: Math.min(4000, threadTokens) },
        expectedOutputTokens: () => EXPECTED_OUTPUT_TOKENS,
        approvedProviders: cfg.privacy.approvedProviders,
        policy: cfg.policy.table,
        contextWindowFor: b.contextWindowFor,
        confidenceFloor: floor,
        ...(learnedNow?.strengthFor ? { strengthFor: learnedNow.strengthFor } : {}),
        ...(learnedNow?.refusals ? { refusals: learnedNow.refusals } : {}),
        // The same suggestion and the same cooling store the per-turn router reads (the architect, 2026-10-02).
        ...(b.suggestion ? { suggestion: b.suggestion } : {}),
        ...(b.cooling ? { cooling: b.cooling } : {}),
        // `enforce.midThread` off: only fresh points may switch a running thread. Shadow keeps the switch policy as
        // it was, so its record is what the policy alone would do.
        ...(cfg.mode === "enforce" ? { midThread: cfg.enforce.midThread } : {}),
      };
      d.runs?.setBase(meta.runId, params, { sessionKey: meta.sessionKey, aim: view.firstUserText });
      const repeated = d.stuck?.repeated(meta.runId) ?? 0;
      const isStuck = repeated >= STUCK_AFTER_ERRORS;
      const decision = routeCallWithStuck(params, isStuck);
      if (!decision) {
        stats.noOption += 1;
        return;
      }
      const ladder = ladderFor({
        options: decision.options,
        chosen: decision.chosen,
        handPicked,
        contextWindowFor: b.contextWindowFor,
        threadTokens,
      });
      const computeMs = clock() - t0;
      stats.decisions += 1;
      const stuckRow = isStuck
        ? {
            id: `${meta.runId}:${call.callIndex}:stuck`,
            repeated,
            escalated: decision.switch.reason === "stuck",
            to: decision.chosen.rung.key,
            price: decision.chosen.price,
          }
        : undefined;
      // The whole cost of the router is the time to here. Writing and broadcasting happen after the call is on its way.
      defer(() => {
        try {
          d.store()?.insertDecision(decision, {
            ladder,
            computeMs,
            sessionKey: meta.sessionKey,
            privateTask: run!.private,
            domain: run!.task.kind.value,
            topic: run!.task.topic.value,
            stepKind: step.kind.value,
          });
          if (stuckRow) {
            d.store()?.insertFreshPoint({
              id: stuckRow.id,
              ts: nowMs,
              ...(meta.sessionKey ? { session: meta.sessionKey } : {}),
              runId: meta.runId,
              callIndex: call.callIndex,
              kind: "stuck",
              mode: cfg.mode,
              // Escalating the model of a running call is not built (D2 records it); nothing is acted on.
              acted: false,
              reason: stuckRow.escalated ? "would-escalate" : "kept",
              model: stuckRow.to,
              detail: {
                repeated: stuckRow.repeated,
                incumbent: incumbentKey,
                price: stuckRow.price,
              },
            });
          }
          d.broadcast("thalamus.call", decisionEvent(decision));
        } catch (err) {
          stats.errors += 1;
          d.onError?.(err);
        }
      });
    } catch (err) {
      stats.errors += 1;
      d.onError?.(err);
    } finally {
      const ms = clock() - t0;
      if (ms > stats.maxMs) stats.maxMs = ms;
      if (ms > SLOW_MS) stats.slow += 1;
    }
  };

  return { router: { observe }, stats: () => ({ ...stats }) };
}
