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
): Promise<string> {
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
  const wait = await callGateway<{ status?: "ok" | "timeout" | "error"; error?: string }>({
    method: "agent.wait",
    params: { runId, timeoutMs: runTimeoutSeconds * 1000 },
    timeoutMs: runTimeoutSeconds * 1000 + 5_000,
    scopes: ADMIN_SCOPES,
  });
  if (wait?.status === "error") throw new Error(`orchestration run errored: ${wait.error ?? "?"}`);
  if (wait?.status === "timeout") return "";
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
  const runTimeoutSeconds = opts.runTimeoutSeconds ?? 60;
  const spawn = async (prompt: string, agentOpts?: AgentOpts): Promise<{ finalText: string }> => {
    const label = agentOpts?.label ?? "orchestration-agent";
    const finalText = await spawnTextVia(
      opts.callGateway,
      prompt,
      label,
      parentSessionKey,
      runTimeoutSeconds,
    );
    return { finalText };
  };
  return createOrchestrationRuntime({ spawn, onPhase: opts.onPhase });
}
