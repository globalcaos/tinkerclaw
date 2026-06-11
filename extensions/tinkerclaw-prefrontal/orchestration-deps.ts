/**
 * SS0 / capability-parity A1 (2026-06-04): PRODUCTION deps for the native
 * orchestration runtime.
 *
 * createOrchestrationRuntime() takes an injected `spawn`. In tests that's a mock;
 * in production it must drive a real subagent. This factory builds the production
 * `spawn` by MIRRORING the proven `spawnText` sequence in
 * `src/fork/reasoning-runtime.ts` (the same fork.subagents.spawn → agent.wait →
 * chat.history path the round-table + overseer already use — no new transport,
 * shares the cc-bridge billing harness + fan-out budget).
 *
 * Live-verify (2026-06-04): the no-spawn orchestrate path was confirmed live; the
 * agent()-spawn path initially failed with `missing scope: operator.admin` — the
 * loopback `callGateway` was requesting least-privilege `[]` scopes, but
 * fork.subagents.spawn is admin-only. Fixed by pinning `scopes:["operator.admin"]`
 * on the loopback calls (see ADMIN_SCOPES below). reasoning-runtime.ts /
 * overseer-runtime.ts / curiosity-interestingness.ts carry the SAME latent bug
 * (bare callGateway spawn with no scopes) — they just haven't been exercised yet.
 */

import { createOrchestrationRuntime, type AgentOpts } from "./orchestration-runtime.js";
import { classifyError } from "./recipe-types.js";

/** Minimal structural type for the gateway-call function (matches src/gateway/call.js). */
export type CallGateway = <T>(args: {
  method: string;
  params?: unknown;
  timeoutMs?: number;
  /**
   * Operator scopes the loopback should request at its connect handshake. A
   * loopback `callGateway` opens a FRESH connection that negotiates its own
   * scopes — the outer caller's scope does NOT propagate. fork.subagents.spawn
   * is admin-only (unclassified → default-deny → ADMIN_SCOPE), so the spawn
   * loopback must request operator.admin explicitly (mirrors how
   * scripts/openclaw-spawn-subagent.mjs authorizes its spawn).
   */
  scopes?: string[];
}) => Promise<T>;

const ADMIN_SCOPES = ["operator.admin"];

/**
 * Default leaf model for orchestration fan-out. MUST be a `claude-code/*` model so
 * every spawned unit is a subscription-billed cc-sp-* worker — the entire reason
 * ultracode-style workflows route through the gateway instead of native forked
 * `claude` processes (which trip Anthropic's overage classifier and bill metered).
 * opus-4-8 is a stable catalog id; a script may override per-unit via agent({model}),
 * but only with another claude-code/* model (see coerceClaudeCodeModel).
 */
const DEFAULT_LEAF_MODEL = "claude-code/claude-opus-4-8";

/**
 * BILLING GUARD: force a `claude-code/*` leaf model. A claude-code/* request is
 * honoured; ANY other value (or none) falls back to DEFAULT_LEAF_MODEL. This makes
 * subscription billing a STRUCTURAL property of the fan-out rather than a lucky
 * default — a stray metered/raw model id can never reach fork.subagents.spawn from
 * here, so a leaf can't silently spill onto the €/token API.
 */
function coerceClaudeCodeModel(requested: string | undefined): string {
  return typeof requested === "string" && requested.startsWith("claude-code/")
    ? requested
    : DEFAULT_LEAF_MODEL;
}

interface HistoryMessage {
  role?: string;
  content?: unknown;
}

/**
 * Extract the last assistant message's text from a chat.history `messages` array.
 * Handles both string content and the array-of-blocks (`{text}`) shape. Pure +
 * testable — the load-bearing parse of the spawn result. Returns "" if none.
 */
export function extractLastAssistantText(messages: unknown): string {
  const arr = Array.isArray(messages) ? (messages as HistoryMessage[]) : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]?.role !== "assistant") continue;
    const c = arr[i].content;
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c
              .map((b) =>
                typeof (b as { text?: unknown })?.text === "string"
                  ? (b as { text: string }).text
                  : "",
              )
              .join("")
          : "";
    if (text.trim()) return text.trim();
    break; // last assistant msg had no text — stop (mirrors reasoning-runtime.ts)
  }
  return "";
}

export interface ProductionRuntimeOpts {
  /** The gateway-call function (src/gateway/call.js `callGateway`). Injected for testability. */
  callGateway: CallGateway;
  /** Parent session key for spawned agents. Default "agent:main:main". */
  parentSessionKey?: string;
  /** Per-agent wall-clock budget. Default 60s. */
  runTimeoutSeconds?: number;
  /** Phase sink (wire to fork.prefrontal.setRecipe at the call site for the panel). */
  onPhase?: (title: string) => void;
  /**
   * Default leaf model for spawned units. COERCED to claude-code/* (see
   * coerceClaudeCodeModel) so billing safety holds regardless of value. Default
   * DEFAULT_LEAF_MODEL. Per-unit override via agent({model}).
   */
  leafModel?: string;
  /**
   * SS5b: remaining per-run token allowance threaded down to a spawn. STRUCTURALLY
   * DERIVED BUT INERT until agent.wait carries the reason — the budget arm in
   * spawnTextVia keys off the wait response's `status:'exhausted'` /
   * `stopReason:'budget-exhausted'`, not this number; this field is the declared
   * threading point for when that signal lands (mirrors recovery-budget.ts's
   * "structurally-derived-but-inert until wired" gap).
   */
  remainingTokenBudget?: number;
}

/**
 * Spawn a one-shot subagent with `task`, wait for it, and return its final
 * assistant text. Mirrors `spawnText` in src/fork/reasoning-runtime.ts.
 */
export async function spawnTextVia(
  callGateway: CallGateway,
  task: string,
  label: string,
  parentSessionKey: string,
  runTimeoutSeconds: number,
  model?: string,
): Promise<string> {
  // Pin a claude-code/* model on EVERY spawn here (the billing guard is centralized
  // so no caller can bypass it). Omitted/non-claude-code → DEFAULT_LEAF_MODEL.
  const leafModel = coerceClaudeCodeModel(model);
  const spawn = await callGateway<{
    ok?: boolean;
    childSessionKey?: string;
    runId?: string;
    note?: string;
  }>({
    method: "fork.subagents.spawn",
    params: {
      task,
      label,
      model: leafModel,
      parentSessionKey,
      runTimeoutSeconds,
      expectsCompletionMessage: false,
    },
    timeoutMs: (runTimeoutSeconds + 10) * 1000,
    scopes: ADMIN_SCOPES, // fork.subagents.spawn is admin-only; the loopback must request it
  });
  if (!spawn?.ok || !spawn.childSessionKey || !spawn.runId) {
    throw new Error(`orchestration spawn failed: ${spawn?.note ?? "no childSessionKey/runId"}`);
  }
  const { childSessionKey, runId } = spawn;
  const wait = await callGateway<{
    status?: "ok" | "timeout" | "error" | "exhausted";
    error?: string;
    stopReason?: string;
  }>({
    method: "agent.wait",
    params: { runId, timeoutMs: runTimeoutSeconds * 1000 },
    timeoutMs: runTimeoutSeconds * 1000 + 5_000,
    scopes: ADMIN_SCOPES,
  });
  if (wait?.status === "error") throw new Error(`orchestration run errored: ${wait.error ?? "?"}`);
  // A timeout must NOT silently return '' — chaining that empty string into a
  // downstream agent(prev) call would spawn a taskless orphan subagent. Throw so
  // parallel/pipeline null-isolation drops this leg to null instead of poisoning
  // the next stage with an empty task.
  if (wait?.status === "timeout")
    throw new Error(`orchestration run timed out after ${runTimeoutSeconds}s`);
  // SS5b budget arm: a subagent that exhausted its token/dispatch budget must
  // surface as a CLASSIFIED 'budget-exceeded' (a hard, non-recoverable limit —
  // retry has zero expected value), so parallel/pipeline null-isolation drops the
  // leg rather than poisoning the next stage. STRUCTURALLY DERIVED BUT INERT until
  // agent.wait carries the reason: the gateway does not yet emit
  // status:'exhausted' / stopReason:'budget-exhausted', so this arm never fires in
  // production today — it is wired ahead of that signal (mirrors recovery-budget.ts).
  if (wait && (wait.status === "exhausted" || wait.stopReason === "budget-exhausted"))
    throw classifyError("budget-exceeded", "subagent exhausted its budget");
  const hist = await callGateway<{ messages?: unknown }>({
    method: "chat.history",
    params: { sessionKey: childSessionKey, limit: 30 },
    timeoutMs: 10_000,
    scopes: ADMIN_SCOPES,
  });
  return extractLastAssistantText(hist?.messages);
}

/**
 * Build a native orchestration runtime wired to the real gateway. The runtime's
 * `agent/parallel/pipeline/phase` (+ typed-schema self-correction) then run over
 * real subagents. See the RESTART-UNVERIFIED caveat at the top of this file.
 */
export function createProductionOrchestrationRuntime(opts: ProductionRuntimeOpts) {
  const parentSessionKey = opts.parentSessionKey ?? "agent:main:main";
  // 60s starved real fan-out units: a leaf doing actual work (not a one-word reply)
  // routinely needs minutes, and the 60s default silently timed them out mid-task
  // (confirmed in the first orchestrate smoke). 300s is the per-unit wall-clock
  // budget; a unit that still overruns fails cleanly (parallel/pipeline
  // null-isolation drops the leg). Callers may lower it via runTimeoutSeconds.
  const runTimeoutSeconds = opts.runTimeoutSeconds ?? 300;
  const defaultLeafModel = coerceClaudeCodeModel(opts.leafModel);
  const spawn = async (prompt: string, agentOpts?: AgentOpts): Promise<{ finalText: string }> => {
    const label = agentOpts?.label ?? "orchestration-agent";
    // Per-unit model override (agent({model})) is coerced; otherwise the (already
    // coerced) default leaf model. Either way the spawn is claude-code/* = cc-sp-*.
    const model = agentOpts?.model ? coerceClaudeCodeModel(agentOpts.model) : defaultLeafModel;
    const finalText = await spawnTextVia(
      opts.callGateway,
      prompt,
      label,
      parentSessionKey,
      runTimeoutSeconds,
      model,
    );
    return { finalText };
  };
  return createOrchestrationRuntime({ spawn, onPhase: opts.onPhase });
}
