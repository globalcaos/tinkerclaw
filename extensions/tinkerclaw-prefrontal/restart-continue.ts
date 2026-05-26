import fs from "node:fs/promises";
import type { Plan } from "../../src/gateway/protocol/schema/prefrontal-plan.js";
import type { PlanStore } from "./plan-store.js";

export interface RestartContinueDeps {
  store: PlanStore;
  gatewayCall: (method: string, params: unknown) => Promise<{ runId: string }>;
  systemKind?: string; // default "plan-resume"
  debounceMs?: number; // default 30000
  now?: () => number;
}

const lastFireAt = new Map<string, number>();

export function _resetDebounceForTests() {
  lastFireAt.clear();
}

export async function runRestartContinue(deps: RestartContinueDeps): Promise<{ fired: string[] }> {
  const rootDir = deps.store.rootDirPublic();
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch {
    return { fired: [] };
  }
  const fired: string[] = [];
  const now = (deps.now ?? Date.now)();
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (entry.includes(".broken-")) continue;
    const sessionKey = entry.slice(0, -3).replace(/__/g, ":");
    // FORK 2026-05-16: only real agent sessions are resumable. Hand smoke
    // tests of prefrontal.plan.set leave fixtures with sessionKey
    // `test:plan:<ts>` (intent "verify", steps a/b) in the LIVE plans dir;
    // they were never closed, so this scanner "resumed" one on EVERY
    // gateway restart — dispatching a bogus [System] continue for work
    // that never existed. Never resume a non-agent session key.
    if (!sessionKey.startsWith("agent:")) continue;
    const plan = await deps.store.get(sessionKey);
    if (!plan || plan.status !== "in_progress") continue;
    // Resume any in_progress plan that still has unfinished work. The old
    // guard required a step to be literally `in_progress`, which skipped
    // freshly-seeded plans (kit-matcher seeds all steps `pending`,
    // currentStep:0) — exactly the seed→first-action window where a restart
    // is most likely to lose the turn. Resume if ANY step is not done; skip
    // only when every step is done (plan complete but not yet closed).
    // FORK 2026-05-16: this is the "working recovery system against restart"
    // closure — see subagents-and-kits.md "Recovery contract".
    if (plan.steps.length > 0 && plan.steps.every((s) => s.status === "done")) continue;

    const last = lastFireAt.get(sessionKey) ?? 0;
    if (now - last < (deps.debounceMs ?? 30_000)) continue;
    lastFireAt.set(sessionKey, now);

    await deps.gatewayCall(
      "chat.send",
      buildContinueParams({ plan, sessionKey, systemKind: deps.systemKind ?? "plan-resume" }),
    );
    // FORK 2026-05-13 (Task 3.3): inject a visible grey chip so the user sees plan-resume in TUI.
    // chat.send has deliver:false so it's invisible; chat.inject pushes an assistant-labelled
    // message that the TUI __SYS_PLAN_RESUME__: sentinel detection renders as a grey chip.
    try {
      await deps.gatewayCall("chat.inject", buildPlanResumeChipParams({ plan, sessionKey }));
    } catch {
      // Best-effort — don't block resume if inject fails.
    }
    fired.push(sessionKey);
  }
  return { fired };
}

/** Sentinel prefix the TUI uses to render the grey plan-resume chip (Task 3.3). */
export const SYS_PLAN_RESUME_PREFIX = "__SYS_PLAN_RESUME__:";

/** Build the visible label injected into TUI when restart-continue fires. */
export function buildPlanResumeChipLabel(plan: Plan): string {
  const step = plan.steps[plan.currentStep];
  return `Resuming step ${plan.currentStep}: ${step?.title ?? "(unknown)"}`;
}

/** Build the chat.inject payload (visible chip pushed to TUI). */
function buildPlanResumeChipParams(opts: { plan: Plan; sessionKey: string }) {
  return {
    sessionKey: opts.sessionKey,
    message: `${SYS_PLAN_RESUME_PREFIX}${buildPlanResumeChipLabel(opts.plan)}`,
    label: "system",
  };
}

function buildContinueParams(opts: { plan: Plan; sessionKey: string; systemKind: string }) {
  const hh = new Date().toISOString().slice(11, 19);
  // FORK 2026-05-26 (task-mpi990vu-ixgc3 "Gateway Restart"): the persisted
  // restart-continue chip used to be a 4-line paragraph carrying the plan
  // intent, the active step title + note, the plan-file path, and the
  // instructions to update the plan. That's the visible bubble the user saw
  // bloating his chat after every restart. The model has all that context
  // already (it can call prefrontal.plan.get whenever it needs it), so the
  // persisted message is now a one-liner. The HH:MM:SS timestamp keeps the
  // text unique per restart so the long-text dedup (>=50 chars) catches
  // intra-restart double-writes without collapsing two distinct restart
  // chips minutes apart. Detailed step + plan context is no longer in the
  // chat row — it lives in the plan file the model can read on demand.
  const message = `[System] Gateway restarted at ${hh} — resume from your current plan state.`;
  return {
    sessionKey: opts.sessionKey,
    message,
    deliver: false,
    dispatchAgent: true,
    idempotencyKey: `plan-resume-${opts.plan.runId}-${Date.now()}`,
    systemInputProvenance: {
      kind: "internal_system",
      sourceSessionKey: opts.sessionKey,
      sourceTool: opts.systemKind ?? "plan-resume",
    },
  };
}
