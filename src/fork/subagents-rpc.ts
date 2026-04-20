/**
 * FORK: fork.subagents.spawn -- provider-agnostic subagent-spawn RPC.
 *
 * Why this exists
 * ---------------
 * OpenClaw's native `sessions_spawn` is an LLM-facing tool exposed by
 * pi-agent-core's tool loop. That works great when the provider is
 * anthropic / openai / google / ollama / etc, because those providers
 * drive through pi-agent-core's runAgentLoop and the tool is in the
 * inventory.
 *
 * The `tinkerclaw-cc-bridge` provider bypasses pi-agent-core's tool
 * loop entirely -- the real `claude` CLI has its own built-in tools
 * (Bash / Read / Write / Edit / Grep / Glob). Jarvis inside cc-bridge
 * cannot reach `sessions_spawn`, so the Prefrontal panel never
 * populates (no `subagent_spawned` hook ever fires).
 *
 * This RPC is a frontier-clean bridge: it wraps the existing
 * `spawnSubagentDirect` helper (same code path the native tool
 * ultimately uses) and exposes it as a WS RPC so ANY caller can spawn
 * a subagent -- a CLI on cc-bridge's $PATH, a future MCP bridge, the
 * Tinker UI, a plugin, or a test harness. When the fork later swaps
 * the cc-bridge provider out for a regular LLM, nothing here has to
 * change: the regular provider's tool loop keeps working as before,
 * and this RPC just sits idle until someone calls it.
 *
 * Security: ADMIN_SCOPE only (unlisted methods default to admin via
 * method-scopes.ts). Operator clients like Tinker UI already have
 * operator.admin.
 */
import {
  spawnSubagentDirect,
  type SpawnSubagentContext,
  type SpawnSubagentParams,
} from "../agents/subagent-spawn.js";
import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("fork-subagents");

function readStr(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function readNum(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readBool(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params[key];
  return typeof v === "boolean" ? v : undefined;
}

export const forkSubagentsHandlers: GatewayRequestHandlers = {
  "fork.subagents.spawn": async ({ params, respond }) => {
    const p = params ?? {};
    const task = readStr(p, "task");
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "fork.subagents.spawn: 'task' required (string, the instruction to hand to the subagent).",
        ),
      );
      return;
    }

    const spawnParams: SpawnSubagentParams = {
      task,
      label: readStr(p, "label"),
      agentId: readStr(p, "agentId"),
      model: readStr(p, "model"),
      thinking: readStr(p, "thinking"),
      runTimeoutSeconds: readNum(p, "runTimeoutSeconds"),
      thread: readBool(p, "thread"),
      mode: (readStr(p, "mode") as SpawnSubagentParams["mode"]) ?? undefined,
      cleanup: (readStr(p, "cleanup") as SpawnSubagentParams["cleanup"]) ?? undefined,
      sandbox: (readStr(p, "sandbox") as SpawnSubagentParams["sandbox"]) ?? undefined,
      lightContext: readBool(p, "lightContext"),
      expectsCompletionMessage: readBool(p, "expectsCompletionMessage"),
    };

    const ctx: SpawnSubagentContext = {
      // Parent session defaults to main if not provided. This is the key lever
      // for "keep it provider-agnostic": the RPC caller can be a cc-bridge CLI
      // (which knows its own sessionKey), the Tinker UI (which knows the
      // current tab), a plugin, etc. -- they all supply the requester.
      agentSessionKey: readStr(p, "parentSessionKey") ?? readStr(p, "sessionKey"),
      requesterAgentIdOverride: readStr(p, "requesterAgentId"),
      workspaceDir: readStr(p, "workspaceDir"),
    };

    try {
      const result = await spawnSubagentDirect(spawnParams, ctx);
      if (result.status !== "accepted") {
        log.warn(
          `fork.subagents.spawn rejected (${result.status}): ${result.error ?? "no reason given"}`,
        );
        respond(
          false,
          undefined,
          errorShape(
            result.status === "forbidden" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
            result.error ?? `subagent spawn rejected (${result.status})`,
          ),
        );
        return;
      }
      log.info(
        `fork.subagents.spawn ok childSessionKey=${result.childSessionKey} runId=${result.runId} task.len=${task.length}`,
      );
      respond(
        true,
        {
          ok: true,
          childSessionKey: result.childSessionKey,
          runId: result.runId,
          mode: result.mode,
          modelApplied: result.modelApplied,
          note: result.note,
        },
        undefined,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`fork.subagents.spawn threw: ${msg}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
    }
  },
};
