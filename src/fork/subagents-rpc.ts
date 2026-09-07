import { resolveHeadlessRequesterSessionKey } from "../agents/headless-requester-session-key.js";
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
 * The `tinkerclaw-tinker-bridge` provider bypasses pi-agent-core's tool
 * loop entirely -- the real `claude` CLI has its own built-in tools
 * (Bash / Read / Write / Edit / Grep / Glob). Jarvis inside tinker-bridge
 * cannot reach `sessions_spawn`, so the Prefrontal panel never
 * populates (no `subagent_spawned` hook ever fires).
 *
 * This RPC is a frontier-clean bridge: it wraps the existing
 * `spawnSubagentDirect` helper (same code path the native tool
 * ultimately uses) and exposes it as a WS RPC so ANY caller can spawn
 * a subagent -- a CLI on tinker-bridge's $PATH, a future MCP bridge, the
 * Tinker UI, a plugin, or a test harness. When the fork later swaps
 * the tinker-bridge provider out for a regular LLM, nothing here has to
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

/**
 * The requester session key for a spawn, or the headless sink when the caller
 * has no tab identity to offer.
 *
 * Exported so the boundary is directly testable: the whole point of applying the
 * default HERE rather than in the two CLIs is that it cannot be bypassed, and an
 * assertion on this function is what keeps that true.
 */
export function resolveRpcRequesterSessionKey(params: Record<string, unknown>): string {
  const supplied = readStr(params, "parentSessionKey") ?? readStr(params, "sessionKey");
  if (supplied) {
    return supplied;
  }
  return resolveHeadlessRequesterSessionKey(readStr(params, "requesterAgentId"));
}

function readNum(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readBool(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params[key];
  return typeof v === "boolean" ? v : undefined;
}

function readStrArr(params: Record<string, unknown>, key: string): string[] | undefined {
  const v = params[key];
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * SS5b-C1 spawn-budget validation at the RPC boundary.
 *
 * Rejects malformed budgets (non-integer or negative maxTokens/maxToolCalls)
 * with an INVALID_REQUEST-style error, and normalizes the allowTools allow-list
 * in place (trim already applied by readStrArr; here we lowercase + dedup so the
 * eventual tool gate matches case-insensitively against a clean set).
 *
 * Mutates spawnParams in place and returns it for convenience. Throws an Error
 * on the first validation failure; the handler maps that to ErrorCodes.INVALID_REQUEST.
 */
export function validateSpawnBudget(spawnParams: SpawnSubagentParams): SpawnSubagentParams {
  const checkBudgetNumber = (value: number | undefined, label: string): void => {
    if (value === undefined) {
      return;
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `fork.subagents.spawn: '${label}' must be a non-negative integer (got ${String(value)}).`,
      );
    }
  };
  checkBudgetNumber(spawnParams.maxTokens, "maxTokens");
  checkBudgetNumber(spawnParams.maxToolCalls, "maxToolCalls");

  if (spawnParams.allowTools !== undefined) {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const name of spawnParams.allowTools) {
      const lower = name.trim().toLowerCase();
      if (!lower || seen.has(lower)) {
        continue;
      }
      seen.add(lower);
      normalized.push(lower);
    }
    spawnParams.allowTools = normalized;
  }
  return spawnParams;
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
      allowTools: readStrArr(p, "allowTools"),
      maxTokens: readNum(p, "maxTokens"),
      maxToolCalls: readNum(p, "maxToolCalls"),
    };

    // SS5b-C1: validate + normalize the spawn budget before we spawn anything.
    // A bad budget is a client error, so it maps to INVALID_REQUEST (not the
    // generic UNAVAILABLE the spawn try/catch below would otherwise produce).
    try {
      validateSpawnBudget(spawnParams);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`fork.subagents.spawn rejected (invalid budget): ${msg}`);
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, msg));
      return;
    }

    const ctx: SpawnSubagentContext = {
      // FORK 2026-08-04. The old comment here said "Parent session defaults to
      // main if not provided ... they all supply the requester". The second half
      // was the assumption that failed: a Claude Code session driving ORCA has no
      // OpenClaw session key to supply, so it supplied nothing -- and "defaults to
      // main" was not a harmless lane. `agent:main:main` is a LIVE Tinker UI
      // webchat tab (sessions.json origin.label "Tinker UI"). Subagent completion
      // announcements are delivered to `requesterSessionKey`, so every unattended
      // spawn's announcement was injected into the human's Main tab as a user
      // turn: 64 of them in one 6-day session, each minting a model turn on a
      // single serialized lane and starving the announce deadline.
      //
      // Fixing only the two CLI literals was NOT enough -- with them removed this
      // forwarded `undefined` and `subagent-spawn.ts` independently fell back to
      // `alias` (= "main"), which the UI matches as the protected Main tab just as
      // readily (`keySuffix === "main"` beside `endsWith(":main")`). Two
      // independent defaults, so the sink has to be applied HERE, at the boundary
      // every caller crosses. A CLI literal can be reintroduced by anyone; this
      // cannot be silently bypassed.
      //
      // An explicitly supplied key always wins untouched.
      agentSessionKey: resolveRpcRequesterSessionKey(p),
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
      // SS5b-C1: the budget is validated + normalized above and now FORWARDED to
      // the child run via the agent call inside spawnSubagentDirect
      // (allowTools/maxTokens/maxToolCalls), where it is enforced child-side in
      // attempt.ts. Keep the observability log so the requested budget stays
      // visible alongside the spawn result.
      log.info(
        `fork.subagents.spawn budget (forwarded) allowTools=${
          spawnParams.allowTools ? spawnParams.allowTools.join(",") : "<none>"
        } maxTokens=${spawnParams.maxTokens ?? "<none>"} maxToolCalls=${
          spawnParams.maxToolCalls ?? "<none>"
        }`,
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
