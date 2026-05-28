/**
 * FORK: Surface long kit-run progress + completion back into a (possibly closed)
 * parent chat turn. Reuses the EXACT re-entry primitives from
 * src/agents/main-session-restart-recovery.ts:
 *   - chat.inject __ERR_ENV__ envelope  → a non-fatal status chip (lines 131-159)
 *   - agent RPC deliver:false, lane Main, idempotencyKey → a fresh completion
 *     turn (lines 167-177)
 * The completion message carries the __KIT_DONE__ sentinel so the
 * before_prompt_build kit-matcher does NOT auto-seed a phantom plan (see
 * kit-matcher guard, Task 1.5 Step 6).
 */

import crypto from "node:crypto";
import type { StepResult } from "./kit-runner.js";

export function buildKitStatusEnvelope(p: { kitRef: string; done: number; total: number }): string {
  const now = new Date();
  const envelope = {
    kind: "error",
    id: `kit-run-${now.getTime()}`,
    fatal: false,
    category: "busy",
    headline: `Kit ${p.kitRef} running — ${p.done}/${p.total} steps done`,
    explanation: "A long orchestration kit is in flight; results will arrive when it settles.",
    icon: "🕸",
    timestamp: now.toISOString(),
  };
  return `__ERR_ENV__:${JSON.stringify(envelope)}`;
}

export function buildKitCompletionMessage(p: {
  kitRef: string;
  ok: boolean;
  results: StepResult[];
}): string {
  const lines = p.results.map(
    (r) => `  ${r.status === "done" ? "✓" : "✗"} ${r.title}: ${r.note ?? "(no note)"}`,
  );
  return (
    `__KIT_DONE__ Kit ${p.kitRef} ${p.ok ? "completed" : "aborted"}. Per-step results:\n` +
    lines.join("\n") +
    `\n\nIncorporate these results into your answer to the user.`
  );
}

export interface SurfaceDeps {
  callGateway: (args: { method: string; params: unknown; timeoutMs?: number }) => Promise<unknown>;
}

export async function surfaceKitOutcome(
  p: { sessionKey: string; kitRef: string; ok: boolean; results: StepResult[] },
  deps: SurfaceDeps,
): Promise<void> {
  const total = p.results.length;
  const done = p.results.filter((r) => r.status === "done").length;
  // 1. Status chip (best-effort).
  try {
    await deps.callGateway({
      method: "chat.inject",
      params: {
        sessionKey: p.sessionKey,
        message: buildKitStatusEnvelope({ kitRef: p.kitRef, done, total }),
        label: "system",
      },
      timeoutMs: 5_000,
    });
  } catch {
    // chip is best-effort
  }
  // 2. Completion turn — idempotent, not delivered to channels, Main lane.
  try {
    await deps.callGateway({
      method: "agent",
      params: {
        message: buildKitCompletionMessage({ kitRef: p.kitRef, ok: p.ok, results: p.results }),
        sessionKey: p.sessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: "main", // CommandLane.Main string value (confirmed: src/process/lanes.ts:2)
      },
      timeoutMs: 10_000,
    });
  } catch {
    // completion turn is best-effort; the plan board still reflects results
  }
}
