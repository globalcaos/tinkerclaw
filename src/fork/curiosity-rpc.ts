import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";
/**
 * FORK 2026-05-30 — Curiosity / intrinsic-motivation RPC handlers (J8 THALAMUS, 2a/2b).
 *
 * Gateway RPC surface for the Consolidative Curiosity Architecture. Styled exactly
 * like src/fork/prefrontal-state-rpc.ts: same GatewayRequestHandlers shape, the same
 * readStr/readNum param guards, the same emitAgentEvent broadcast pattern. Every new
 * file here is fork-only — no upstream path is patched.
 *
 * Handlers:
 *   fork.curiosity.logGap   — 2a: record a detected knowledge gap (fire-and-forget,
 *                             persists to the episodic buffer + broadcasts
 *                             phase="curiosity-gap-detected").
 *   fork.curiosity.topGaps  — 2b: return the top-K open gaps, re-scored + deduped,
 *                             for the self-evolution cron's active-learning pass.
 *   fork.curiosity.resolveGap — 2b: stamp a gap resolved (append-only audit) +
 *                             broadcast phase="curiosity-gap-resolved".
 *
 * Stays frontier-clean: when the fork swaps cc-bridge for a regular LLM provider,
 * these RPCs just sit unused until a frontend wires them.
 */
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  appendGap,
  makeGap,
  markResolved,
  readGaps,
  topGaps as topGapsPure,
  type GapSource,
} from "./curiosity-store.js";

const log = createSubsystemLogger("fork-curiosity");

const VALID_SOURCES: ReadonlySet<string> = new Set([
  "lcm-entropy",
  "no-match",
  "retrieval-miss",
  "user-correction",
  "manual",
]);

function readStr(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function readNum(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function readBool(p: Record<string, unknown>, k: string): boolean {
  const v = p[k];
  return v === true || v === "true" || v === 1;
}

export const forkCuriosityHandlers: GatewayRequestHandlers = {
  // 2a — log a detected knowledge gap.
  "fork.curiosity.logGap": async ({ params, respond }) => {
    const p = params ?? {};
    const topic = readStr(p, "topic");
    if (!topic) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fork.curiosity.logGap: 'topic' required."),
      );
      return;
    }
    const rawSource = readStr(p, "source") ?? "manual";
    const source: GapSource = (VALID_SOURCES.has(rawSource) ? rawSource : "manual") as GapSource;
    const sessionKey = readStr(p, "sessionKey") ?? readStr(p, "parentSessionKey");
    const runId = readStr(p, "runId") ?? "curiosity-gap";

    const gap = makeGap({
      topic,
      source,
      sessionKey,
      runId,
      importance: readNum(p, "importance"),
      // accept both the plan's `knowledgeAdjacency`/`userRelevance` RPC names and the
      // internal field names.
      learnability: readNum(p, "learnability"),
      adjacency: readNum(p, "adjacency") ?? readNum(p, "knowledgeAdjacency"),
      userRelevance: readNum(p, "userRelevance"),
      recipeName: readStr(p, "recipeName"),
      stepName: readStr(p, "stepName"),
      toolName: readStr(p, "toolName"),
      reason: readStr(p, "reason"),
    });

    let persistError: string | undefined;
    try {
      appendGap(gap);
    } catch (err) {
      persistError = err instanceof Error ? err.message : String(err);
      console.error("[fork.curiosity.logGap] append failed", err);
    }

    // Fire-and-forget UI broadcast (mirrors prefrontal-state-rpc emit pattern).
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "curiosity-gap-detected",
        id: gap.id,
        topic: gap.topic,
        source: gap.source,
        importance: gap.importance,
        learnability: gap.learnability,
        adjacency: gap.adjacency,
        userRelevance: gap.userRelevance,
        ts: gap.ts,
        ...(sessionKey ? { sessionKey } : {}),
      },
      ...(sessionKey ? { sessionKey } : {}),
    });

    log.info(
      `fork.curiosity.logGap topic="${gap.topic}" source=${gap.source} sessionKey=${sessionKey ?? "-"}${persistError ? ` persistError=${persistError}` : ""}`,
    );
    respond(true, { ok: true, id: gap.id, persisted: !persistError }, undefined);
  },

  // 2b — return the prioritized open-gap queue for the active-learning pass.
  "fork.curiosity.topGaps": async ({ params, respond }) => {
    const p = params ?? {};
    const sinceDays = readNum(p, "sinceDays") ?? 7;
    const k = readNum(p, "k") ?? 5;
    let gaps;
    try {
      gaps = readGaps({ sinceDays });
    } catch (err) {
      console.error("[fork.curiosity.topGaps] read failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.curiosity.topGaps: read failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    const top = topGapsPure(gaps, { k });
    // OMNI (J8 THALAMUS): opt-in LLM interestingness re-rank of the cheap top-k shortlist.
    // Default OFF → byte-identical to the fixed linear order unless the caller sets omni:true.
    // Spawns one judge per shortlisted gap; on ANY judge failure each gap falls back to its
    // fixed score, and on any wholesale error we drop to the fixed order below — so this can
    // only ADD ranking signal, never break or empty the queue.
    if (readBool(p, "omni")) {
      try {
        const { scoreGapsWithInterestingness } = await import("./curiosity-interestingness.js");
        const reranked = await scoreGapsWithInterestingness(
          top.map((t) => t.gap),
          { blendWeight: readNum(p, "blendWeight") },
        );
        log.info(
          `fork.curiosity.topGaps OMNI re-ranked ${reranked.length} gap(s) sinceDays=${sinceDays} k=${k}`,
        );
        respond(true, { ok: true, gaps: reranked, omni: true }, undefined);
        return;
      } catch (err) {
        console.error("[fork.curiosity.topGaps] OMNI re-rank failed; using fixed order", err);
        // fall through to the fixed-order response
      }
    }
    log.info(`fork.curiosity.topGaps sinceDays=${sinceDays} k=${k} returned=${top.length}`);
    respond(true, { ok: true, gaps: top }, undefined);
  },

  // 2b — stamp a gap resolved (append-only audit row).
  "fork.curiosity.resolveGap": async ({ params, respond }) => {
    const p = params ?? {};
    const id = readStr(p, "id");
    if (!id) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fork.curiosity.resolveGap: 'id' required."),
      );
      return;
    }
    const by = readStr(p, "by") ?? readStr(p, "resolvedBy") ?? "self-evolution-cron";
    const source =
      readStr(p, "source") ?? readStr(p, "resolutionSource") ?? readStr(p, "summary") ?? "unknown";
    const sessionKey = readStr(p, "sessionKey");
    const runId = readStr(p, "runId") ?? "curiosity-resolve";

    let resolution;
    try {
      resolution = markResolved(id, by, source);
    } catch (err) {
      console.error("[fork.curiosity.resolveGap] markResolved failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.curiosity.resolveGap: failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (!resolution) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `fork.curiosity.resolveGap: gap '${id}' not found in recent buffer.`,
        ),
      );
      return;
    }

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "curiosity-gap-resolved",
        id: resolution.id,
        topic: resolution.topic,
        resolvedBy: by,
        resolutionSource: source,
        ts: resolution.resolvedAt,
        ...(sessionKey ? { sessionKey } : {}),
      },
      ...(sessionKey ? { sessionKey } : {}),
    });

    log.info(`fork.curiosity.resolveGap id=${id} by=${by} source=${source}`);
    respond(true, { ok: true, id: resolution.id }, undefined);
  },
};
