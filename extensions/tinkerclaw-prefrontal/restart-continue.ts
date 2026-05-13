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
    const plan = await deps.store.get(sessionKey);
    if (!plan || plan.status !== "in_progress") continue;
    // Only dispatch if a step is actually in_progress (plan status stays "in_progress" until close())
    if (!plan.steps.some((s) => s.status === "in_progress")) continue;

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
  const step = opts.plan.steps[opts.plan.currentStep];
  const hh = new Date().toISOString().slice(11, 19);
  const planFsPath = `~/.openclaw/workspace/state/prefrontal/plans/${opts.sessionKey.replace(/:/g, "__")}.md`;
  const noteSuffix = step?.note ? ` (your last note: "${step.note}")` : "";
  const message =
    `[System] Gateway restarted at ${hh}. You were working on plan "${opts.plan.intent}". ` +
    `Step ${opts.plan.currentStep}: ${step?.title ?? "(unknown)"} was in progress${noteSuffix}. ` +
    `Read ${planFsPath} for your full checklist, then continue. ` +
    `Update the plan as you go (prefrontal.plan.step status:"done" / "in_progress").`;
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
