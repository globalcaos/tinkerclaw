/**
 * FORK: fork.prefrontal.setRecipe -- orchestration observability broadcast.
 *
 * Jarvis calls this RPC (via the openclaw-recipe-state CLI or directly) to
 * publish the current recipe + step state so the Tinker UI's Prefrontal
 * panel can show what playbook is driving the subagent tree.
 *
 * The RPC does one thing: emit an agent event on the `lifecycle` stream with
 * phase="prefrontal-recipe-state" and the caller's payload. The UI subscribes
 * and re-renders the panel header. Zero persistence on the gateway side --
 * the UI holds the last-known state in memory and clears it when the current
 * run ends.
 *
 * Stays frontier-clean: no modifications to pi-agent-core, no new plugin hook
 * surface. When the fork swaps cc-bridge for a regular LLM provider, the
 * regular provider's sessions_spawn tool keeps working; this RPC just sits
 * unused until someone wires a different frontend to it.
 */
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";

const log = createSubsystemLogger("fork-prefrontal-state");

function readStr(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function readNum(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function readStrArray(p: Record<string, unknown>, k: string): string[] | undefined {
  const v = p[k];
  if (!Array.isArray(v)) {return undefined;}
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

export const forkPrefrontalStateHandlers: GatewayRequestHandlers = {
  "fork.prefrontal.setRecipe": async ({ params, respond }) => {
    const p = params ?? {};
    const recipeId = readStr(p, "recipeId");
    if (!recipeId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "fork.prefrontal.setRecipe: 'recipeId' required (e.g. 'revise-paper').",
        ),
      );
      return;
    }
    const step = readNum(p, "step");
    const totalSteps = readNum(p, "totalSteps");
    const stepName = readStr(p, "stepName");
    const sessionKey = readStr(p, "sessionKey") ?? readStr(p, "parentSessionKey");
    const runId = readStr(p, "runId") ?? "prefrontal-recipe-state";
    const parallelismCap = readNum(p, "parallelismCap");
    const inFlightLabels = readStrArray(p, "inFlightLabels");
    const note = readStr(p, "note");

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "prefrontal-recipe-state",
        recipeId,
        step,
        totalSteps,
        stepName,
        parallelismCap,
        inFlightLabels,
        note,
        ts: Date.now(),
        ...(sessionKey ? { sessionKey } : {}),
      },
      ...(sessionKey ? { sessionKey } : {}),
    });

    log.info(
      `fork.prefrontal.setRecipe recipeId=${recipeId} step=${step ?? "-"}/${totalSteps ?? "-"} stepName=${stepName ?? "-"} sessionKey=${sessionKey ?? "-"}`,
    );
    respond(true, { ok: true, recipeId, step, totalSteps, stepName }, undefined);
  },

  "fork.prefrontal.trailEvent": async ({ params, respond }) => {
    const p = params ?? {};
    const kind = readStr(p, "kind"); // e.g. "dispatch" | "complete" | "note" | "transition"
    const message = readStr(p, "message");
    if (!kind || !message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "fork.prefrontal.trailEvent: 'kind' and 'message' required.",
        ),
      );
      return;
    }
    const sessionKey = readStr(p, "sessionKey") ?? readStr(p, "parentSessionKey");
    const runId = readStr(p, "runId") ?? "prefrontal-trail";
    const icon = readStr(p, "icon");
    const label = readStr(p, "label");

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "prefrontal-trail-event",
        kind,
        message,
        icon,
        label,
        ts: Date.now(),
        ...(sessionKey ? { sessionKey } : {}),
      },
      ...(sessionKey ? { sessionKey } : {}),
    });
    log.info(`fork.prefrontal.trailEvent kind=${kind} label=${label ?? "-"} msg.len=${message.length}`);
    respond(true, { ok: true }, undefined);
  },
};
