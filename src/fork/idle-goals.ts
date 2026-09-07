/**
 * FORK 2026-05-31: Idle goal-generation trigger (J8 sub-part 2d — proactive curiosity).
 *
 * The deterministic goal core already exists (curiosity-store/topGaps + self-evolution-cron
 * propose next-goals nightly). The missing piece was the IDLE TRIGGER: when a session goes
 * quiet mid-day, surface "while you were away I noticed X — want me to dig in?" instead of
 * waiting for the nightly cron. This wires it.
 *
 * Mechanism: onTurnComplete re-arms a per-session idle timer (debounce). If a session stays
 * quiet past CURIOSITY_IDLE_MS, we fetch the top open curiosity gaps and emit a NON-INTRUSIVE
 * `curiosity-goal-proposal` lifecycle event (a dismissable suggestion) — deliberately NOT a
 * sessions.send, so it never triggers a Jarvis turn or interrupts the user. Rate-limited so it
 * never pesters. Skips automated/subagent sessions. The proposal logic is dependency-injected
 * so it is unit-testable without a live gateway.
 */

import { isOperatorScopeDenial } from "../gateway/method-scopes.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("fork-idle-goals");

/** Idle threshold before a proposal. Env-overridable (CURIOSITY_IDLE_MS) so it can be
 *  soak-tested with a short value instead of waiting the 30-minute default. */
function idleMs(): number {
  const env = Number(process.env.CURIOSITY_IDLE_MS);
  return Number.isFinite(env) && env > 0 ? env : 30 * 60 * 1000;
}

/** Never propose more than ~once every 2h per session, so it suggests, never pesters. */
const MIN_PROPOSAL_INTERVAL_MS = 2 * 60 * 60 * 1000;

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastProposalAt = new Map<string, number>();

function isAutomatedSession(sessionKey: string): boolean {
  return /:subagent:|:cron:|:heartbeat|:isolated:|^cron:|^heartbeat/.test(sessionKey);
}

export interface ProposedGoal {
  topic: string;
}

/**
 * FORK 2026-08-04: the outcome tags of one proposal cycle, as a CLOSED union.
 *
 * This used to be a bare `string`, and that was the actual bug behind the months-long
 * silence: a gateway REFUSAL (`missing scope: operator.admin` on fork.curiosity.topGaps)
 * came back as "fetch-error", which at the caller is indistinguishable from the healthy
 * "no-gaps" / "rate-limited" no-ops. Naming the failures in the type makes the difference
 * checkable rather than a log-reading exercise.
 *
 * FAILURES (the cycle could not read the gaps at all): "scope-denied" | "fetch-error".
 * HEALTHY no-ops (the cycle ran and legitimately declined): everything else.
 */
export type IdleGoalReason =
  | "proposed"
  | "no-gaps"
  | "rate-limited"
  | "automated"
  | "fetch-error"
  | "scope-denied";

/** True when the cycle FAILED (could not read the gaps) rather than legitimately declining. */
export function isIdleGoalFailure(reason: IdleGoalReason): boolean {
  return reason === "scope-denied" || reason === "fetch-error";
}

export interface IdleGoalDeps {
  /** Fetch the top open curiosity gaps (real impl: fork.curiosity.topGaps). */
  fetchTopGaps: () => Promise<ProposedGoal[]>;
  /** Surface the proposal (real impl: emitAgentEvent lifecycle, NON-triggering). */
  emit: (sessionKey: string, goals: ProposedGoal[]) => void;
  now?: () => number;
}

/** Rate-limit gate — pure, testable. A never-proposed session is always allowed (a
 *  missing timestamp must NOT be treated as "proposed at epoch 0", which would wrongly
 *  gate a fresh session whenever now < the interval). */
export function shouldProposeNow(sessionKey: string, now: number): boolean {
  const last = lastProposalAt.get(sessionKey);
  return last === undefined || now - last >= MIN_PROPOSAL_INTERVAL_MS;
}

/**
 * Run one idle goal-proposal cycle. Testable with mock deps. Returns what happened. Never
 * throws. Skips automated sessions + rate-limited windows + empty gap sets.
 *
 * The `reason` distinguishes a FAILURE ("scope-denied" / "fetch-error" -- see
 * isIdleGoalFailure) from a healthy decline; do not collapse the two at a call site.
 */
export async function proposeIdleGoals(
  sessionKey: string,
  deps: IdleGoalDeps,
): Promise<{ proposed: boolean; reason: IdleGoalReason }> {
  const now = (deps.now ?? Date.now)();
  if (isAutomatedSession(sessionKey)) return { proposed: false, reason: "automated" };
  if (!shouldProposeNow(sessionKey, now)) return { proposed: false, reason: "rate-limited" };
  let gaps: ProposedGoal[];
  try {
    gaps = await deps.fetchTopGaps();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // FORK 2026-08-04: a gateway scope REFUSAL is a permanent wiring bug, not a transient
    // fetch failure -- it will fail identically forever. Give it its own reason and its own
    // log level so it can never again be mistaken for "ran and had nothing to say".
    if (isOperatorScopeDenial(err)) {
      log.error(
        `[idle-goals] REFUSED by gateway: fork.curiosity.topGaps denied (${msg}). ` +
          `Curiosity proposals are DEAD, not idle -- fix the method scope classification.`,
      );
      return { proposed: false, reason: "scope-denied" };
    }
    log.warn(`[idle-goals] fetch failed: ${msg}`);
    return { proposed: false, reason: "fetch-error" };
  }
  if (!gaps || gaps.length === 0) return { proposed: false, reason: "no-gaps" };
  lastProposalAt.set(sessionKey, now);
  deps.emit(sessionKey, gaps);
  return { proposed: true, reason: "proposed" };
}

function realDeps(): IdleGoalDeps {
  return {
    fetchTopGaps: async () => {
      const { callGateway } = await import("../gateway/call.js");
      const res = await callGateway<{
        ok?: boolean;
        // topGaps returns scored items shaped { gap: { topic }, priority } (and OMNI's
        // ScoredGap is also { gap, ... }), so the topic lives at g.gap.topic — read that
        // first, with a flat g.topic fallback for forward-compat.
        gaps?: Array<{ topic?: string; gap?: { topic?: string } }>;
      }>({
        method: "fork.curiosity.topGaps",
        params: { k: 3 },
        timeoutMs: 8000,
      });
      return (res?.gaps ?? [])
        .map((g) => {
          const topic = g?.gap?.topic ?? g?.topic;
          return { topic: typeof topic === "string" ? topic : "" };
        })
        .filter((g) => g.topic);
    },
    emit: (sessionKey, goals) => {
      // Lifecycle event only — the UI can render a dismissable "Suggested next:" chip.
      // NOT a sessions.send: a proposal must never trigger a Jarvis turn or interrupt.
      emitAgentEvent({
        runId: "curiosity-goal-proposal",
        stream: "lifecycle",
        data: { phase: "curiosity-goal-proposal", goals, ts: Date.now(), sessionKey },
        sessionKey,
      });
      log.info(`[idle-goals] proposed ${goals.length} goal(s) for ${sessionKey}`);
    },
  };
}

/**
 * Re-arm the per-session idle timer. Called from onTurnComplete after every turn; if the
 * session then stays quiet past the idle threshold, a proposal fires once. Skips automated
 * sessions; the timer is unref'd so it never keeps the process alive on its own.
 */
export function noteTurnActivity(sessionKey: string | undefined): void {
  if (!sessionKey || isAutomatedSession(sessionKey)) return;
  const existing = idleTimers.get(sessionKey);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    idleTimers.delete(sessionKey);
    void proposeIdleGoals(sessionKey, realDeps())
      .then((out) => {
        // FORK 2026-08-04: proposeIdleGoals swallows fetch/refusal errors and returns them
        // as a reason, so this .then() is the ONLY place a failure can surface -- the old
        // .catch()-only wiring discarded the reason entirely, which meant a dead curiosity
        // path and a healthy quiet one produced byte-identical logs (i.e. nothing).
        if (isIdleGoalFailure(out.reason)) {
          log.warn(
            `[idle-goals] cycle FAILED for ${sessionKey}: ${out.reason} -- no proposal was ` +
              `possible; this is not a healthy no-op`,
          );
        }
      })
      .catch((err) => log.warn(`[idle-goals] cycle failed (non-fatal): ${String(err)}`));
  }, idleMs());
  if (typeof t.unref === "function") t.unref();
  idleTimers.set(sessionKey, t);
}

/** Test reset. */
export function _resetIdleGoalsState(): void {
  for (const t of idleTimers.values()) clearTimeout(t);
  idleTimers.clear();
  lastProposalAt.clear();
}
