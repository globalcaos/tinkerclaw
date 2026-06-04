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
 * ⚠️ RESTART-UNVERIFIED: the gateway-call sequence here is unit-tested against a
 * MOCK callGateway and is type-clean, but it has NOT been run against the live
 * gateway (no restart this arc). The extraction logic + call order are verified;
 * the live spawn/wait/history contract is mirrored from reasoning-runtime.ts but
 * must be smoke-verified at the next restart window before it's trusted in prod.
 */

import { createOrchestrationRuntime, type AgentOpts } from "./orchestration-runtime.js";

/** Minimal structural type for the gateway-call function (matches src/gateway/call.js). */
export type CallGateway = <T>(args: {
  method: string;
  params?: unknown;
  timeoutMs?: number;
}) => Promise<T>;

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
  });
  if (!spawn?.ok || !spawn.childSessionKey || !spawn.runId) {
    throw new Error(`orchestration spawn failed: ${spawn?.note ?? "no childSessionKey/runId"}`);
  }
  const { childSessionKey, runId } = spawn;
  const wait = await callGateway<{ status?: "ok" | "timeout" | "error"; error?: string }>({
    method: "agent.wait",
    params: { runId, timeoutMs: runTimeoutSeconds * 1000 },
    timeoutMs: runTimeoutSeconds * 1000 + 5_000,
  });
  if (wait?.status === "error") throw new Error(`orchestration run errored: ${wait.error ?? "?"}`);
  if (wait?.status === "timeout") return "";
  const hist = await callGateway<{ messages?: unknown }>({
    method: "chat.history",
    params: { sessionKey: childSessionKey, limit: 30 },
    timeoutMs: 10_000,
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
