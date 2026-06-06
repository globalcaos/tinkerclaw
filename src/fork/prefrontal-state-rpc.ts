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
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { getRuntimeConfig } from "../config/io.js";
import { createConfiguredEmbeddingProvider } from "../gateway/embeddings-http.js";
import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
// FORK 2026-05-30 (J8 THALAMUS, 2e): NO-MATCH trail events feed the curiosity buffer.
import { appendGap, classifyGap, makeGap } from "./curiosity-store.js";

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
  if (!Array.isArray(v)) {
    return undefined;
  }
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
    // BROCA visibility (2026-06-06): optional per-turn id + current-step skill id.
    // Both back-compat (omitted when absent → old clients/payloads unaffected).
    const turnId = readStr(p, "turnId");
    const skillId = readStr(p, "skillId");

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
        ...(turnId ? { turnId } : {}),
        ...(skillId ? { skillId } : {}),
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
    // kind: existing callers use "dispatch" | "complete" | "note" | "transition".
    // FORK 2026-05-30 (2e): additive "NO-MATCH" kind for recipe-gap / tool-failure
    // detection — it carries a structured payload and feeds the curiosity buffer.
    const kind = readStr(p, "kind");
    const isNoMatch = kind === "NO-MATCH";
    // NO-MATCH derives a default message from its structured fields, so `message`
    // is required for the legacy kinds but optional for NO-MATCH.
    const recipeName = readStr(p, "recipeName");
    const stepName = readStr(p, "stepName");
    const toolName = readStr(p, "toolName");
    const reason = readStr(p, "reason");
    const message =
      readStr(p, "message") ??
      (isNoMatch ? `NO-MATCH: ${toolName ?? "tool"}${reason ? ` — ${reason}` : ""}` : undefined);
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
    // FORK 2026-05-31: forward an optional structured payload (recipeId, op,
    // applied, reason, …) so RPC-emitted trail events carry the same provenance
    // the in-extension emitTrail broadcasts inline. The UI reads data.payload.
    const payloadRaw = (p as { payload?: unknown }).payload;
    const payload =
      payloadRaw && typeof payloadRaw === "object"
        ? (payloadRaw as Record<string, unknown>)
        : undefined;

    // 2e: classify the gap so a transient outage is never logged as learnable.
    const resolutionType = isNoMatch ? classifyGap(toolName, reason) : undefined;

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "prefrontal-trail-event",
        kind,
        message,
        icon,
        label,
        ...(payload ? { payload } : {}),
        ...(isNoMatch
          ? {
              recipeName,
              stepName,
              toolName,
              reason,
              resolutionType,
            }
          : {}),
        ts: Date.now(),
        ...(sessionKey ? { sessionKey } : {}),
      },
      ...(sessionKey ? { sessionKey } : {}),
    });

    // 2e: only a "knowledge-gap" NO-MATCH (the agent doesn't know how to use the
    // tool) is a learnable curiosity driver. "recoverable" (permission) and
    // "external-outage" emit the trail event but write NO buffer entry.
    let bufferedGapId: string | undefined;
    if (isNoMatch && resolutionType === "knowledge-gap") {
      try {
        const gap = makeGap({
          topic: `use ${toolName ?? "tool"}`,
          source: "no-match",
          sessionKey,
          runId,
          recipeName,
          stepName,
          toolName,
          reason,
          resolutionType,
          // a knowledge-gap NO-MATCH is highly learnable + externally grounded
          learnability: 0.8,
          importance: 0.6,
        });
        appendGap(gap);
        bufferedGapId = gap.id;
      } catch (err) {
        console.error("[fork.prefrontal.trailEvent NO-MATCH] appendGap failed", err);
      }
    }

    log.info(
      `fork.prefrontal.trailEvent kind=${kind} label=${label ?? "-"} msg.len=${message.length}${isNoMatch ? ` resolutionType=${resolutionType ?? "-"} buffered=${bufferedGapId ?? "no"}` : ""}`,
    );
    respond(true, { ok: true, ...(bufferedGapId ? { gapId: bufferedGapId } : {}) }, undefined);
  },

  // FORK 2026-05-31: scoped INTERNAL embeddings RPC for the J13 semantic
  // recipe-match lane. The matcher's embedFn previously POSTed /v1/embeddings,
  // which 404s unless the openAiCompat HTTP surface is enabled. This RPC reuses
  // the SAME in-process embedding provider (ollama/mxbai via memorySearch) with
  // NO new HTTP/chat surface. Lives in core (not the bundled extension) so the
  // provider/native-dep stack is never dragged into the extension bundle. Fails
  // SAFE: any error returns empty embeddings so the matcher degrades to lexical.
  "fork.prefrontal.embed": async ({ params, respond }) => {
    const p = params ?? {};
    const rawTexts = (p as { texts?: unknown }).texts;
    const rawText = (p as { text?: unknown }).text;
    let texts: string[];
    if (Array.isArray(rawTexts)) {
      texts = rawTexts.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    } else if (typeof rawText === "string" && rawText.trim().length > 0) {
      texts = [rawText];
    } else {
      texts = [];
    }
    if (texts.length === 0) {
      respond(true, { embeddings: [], count: 0 }, undefined);
      return;
    }
    // Bound inputs (mirrors the /v1/embeddings limits) so a runaway caller can't
    // OOM the embed provider.
    const MAX_INPUTS = 128;
    const MAX_INPUT_CHARS = 8_192;
    const MAX_TOTAL_CHARS = 65_536;
    if (texts.length > MAX_INPUTS) texts = texts.slice(0, MAX_INPUTS);
    let total = 0;
    texts = texts.map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t));
    for (const t of texts) {
      total += t.length;
      if (total > MAX_TOTAL_CHARS) {
        respond(true, { embeddings: [], error: "input too large" }, undefined);
        return;
      }
    }
    try {
      const cfg = getRuntimeConfig();
      // Use the gateway's actual default agent (not a hardcoded "main") so we read
      // the right agent's memorySearch config even when agents.list renames it.
      const agentId = resolveDefaultAgentId(cfg);
      const agentDir = resolveAgentDir(cfg, agentId);
      const memorySearch = resolveMemorySearchConfig(cfg, agentId);
      if (!memorySearch || !memorySearch.provider) {
        respond(true, { embeddings: [], error: "memorySearch not configured" }, undefined);
        return;
      }
      const provider = await createConfiguredEmbeddingProvider({
        cfg,
        agentDir,
        provider: memorySearch.provider,
        model: memorySearch.model,
        // Pass only the fields the factory reads (it Picks local/remote/dims).
        memorySearch: {
          local: memorySearch.local,
          remote: memorySearch.remote,
          outputDimensionality: memorySearch.outputDimensionality,
        },
      });
      const embeddings = await provider.embedBatch(texts);
      respond(true, { embeddings, model: memorySearch.model, count: texts.length }, undefined);
    } catch (err) {
      // Soft failure → empty embeddings → matcher uses lexical-only (unchanged).
      log.info(`fork.prefrontal.embed soft-fail (lexical fallback): ${String(err)}`);
      respond(true, { embeddings: [], error: String(err) }, undefined);
    }
  },
};
