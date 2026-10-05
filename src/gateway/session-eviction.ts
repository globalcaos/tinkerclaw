// FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 A5; findings F1, F4;
// principles P7, P8, P11) — the CONTEXT WINDOW panel's manual EVICT, as one fork-owned module.
//
// The branch body used to sit inline in src/gateway/server-methods/sessions.ts, a tier-1
// merge-driver file (.gitattributes) where every fork line is a line an upstream merge has to
// re-wire. It lives here now and sessions.ts makes one delegating call. The move also gave the
// eviction a place to own three things the inline branch never did:
//   - P8: it REFUSES, with a reason, on a lane whose runtime owns the context, and it refuses
//     BEFORE interrupting the live run, which the inline branch aborted to accomplish nothing (F1);
//   - P11 / F4: it reports tokensBefore / tokensAfter on the anatomy's own estimator, measured
//     over what the model is actually sent;
//   - P7: it emits the compaction start / end pair with trigger "evict", so the panel hears an
//     eviction the way it hears every other compaction.
//
// FORK 2026-09-24, second pass — that pair now goes through A1's owner module
// (src/infra/compaction-telemetry.ts) instead of a thin local emit. A5 landed while A1 was being
// written in a parallel group of the same wave, so its first cut published on the compaction
// stream with its own emitAgentEvent call (the literal is not quoted here: gate 7 and the
// structural test in session-eviction.test.ts scan comments too). That made this file a SECOND
// owner of a contract that has exactly one (P7) — the case frontmatter gate 7 of
// context-window-panel.md fails on by name — and it bypassed the owner's absent-not-zero pass
// (`compactionTokenCount`), forwarding whatever a call site wrote, so a figure that was not a finite
// number >= 0 would have shipped instead of being omitted. The wire payload is otherwise unchanged:
// buildCompactionEventData writes the same keys from the same values.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { estimateTokens } from "../agents/context-anatomy.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { type SessionEntry, updateSessionStore } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext } from "../infra/agent-events.js";
import { emitCompactionTelemetry } from "../infra/compaction-telemetry.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ErrorShape } from "./protocol/index.js";
import { archiveFileOnDisk, resolveSessionModelRef } from "./session-utils.js";

// FORK 2026-08-28 (the architect: the CONTEXT WINDOW panel's manual "evict" button) —
// transcript-aware EVICTION: drop the oldest turns, keep the newest, no model call.
//
// This exists instead of reusing the `maxLines` branch of sessions.compact, which does a raw
// `lines.slice(-maxLines)`. A pi transcript is NOT a flat log: line 0 is a `{type:"session"}`
// header and every later entry carries `id` + `parentId`, forming a chain that
// SessionManager.open(file).getBranch() walks (session-utils.fs.ts). A blind tail slice drops the
// header and severs that chain, so the branch walk stops at the first broken link and silently
// loses everything before it. `maxLines` is left exactly as it was — other callers depend on it —
// but it must not be what a button in the UI fires.
//
// Three rules make the rewrite safe:
//   1. EVERY non-message entry is kept regardless of position (session header, model_change,
//      thinking_level_change, custom). They are tiny, they are structural, and any of them may be
//      the parent of a kept message.
//   2. The cut is snapped FORWARD to a turn boundary: the first kept message must be a `user`
//      message carrying no tool-result blocks. Cutting mid-turn would orphan a toolResult from
//      its toolCall, which every provider rejects with an immediate 400. When no such boundary
//      exists at or after the target we keep MORE messages, never fewer.
//   3. The kept entries are re-chained — each one's `parentId` is rewritten to the previous kept
//      entry's `id` — so the walk is unbroken end to end.
export type TranscriptEvictionResult =
  | { ok: false; reason: string }
  | { ok: true; evicted: 0; evictedTokens: 0; kept: number; lines: null; reason: string }
  | {
      ok: true;
      evicted: number;
      /** ESTIMATE of what the eviction bought: the anatomy's estimator (estimateTokens,
       *  ceil(chars / 3.5)) over the DROPPED messages' content. Never a billed count: nothing
       *  re-tokenises an evicted transcript, so a real figure does not exist. */
      evictedTokens: number;
      /** ESTIMATE, same estimator, over every message's content before the rewrite. */
      tokensBefore: number;
      /** ESTIMATE, same estimator, over the surviving messages' content. */
      tokensAfter: number;
      kept: number;
      lines: string[];
      reason?: undefined;
    };

/** True when a transcript entry's message carries a tool RESULT block. */
function entryCarriesToolResult(entry: { message?: unknown }): boolean {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    const type = (block as { type?: unknown } | null)?.type;
    return type === "tool_result" || type === "toolResult";
  });
}

/** The transcript's own role for an entry, or "" when it is not a message. */
function entryRole(entry: { type?: unknown; message?: unknown }): string {
  if (entry.type !== "message") {
    return "";
  }
  const role = (entry.message as { role?: unknown } | undefined)?.role;
  return typeof role === "string" ? role : "";
}

/**
 * What the MODEL is sent for one message entry, in chars — measured exactly the way
 * context-anatomy.ts measures a message (its content: a string as-is, anything else
 * JSON-encoded), so an eviction's numbers land on the same scale as the bar they move (P11).
 * The entry's envelope (id, parentId, timestamps, the usage block, provider / model stamps) is
 * transcript bookkeeping the model never sees.
 */
function messageContentChars(entry: Record<string, unknown>): number {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (content === undefined) {
    return 0;
  }
  return (typeof content === "string" ? content : JSON.stringify(content)).length;
}

export function evictTranscriptTail(raw: string, keepFraction: number): TranscriptEvictionResult {
  const rawLines = raw.split(/\r?\n/).filter((l) => Boolean(normalizeOptionalString(l)));
  const entries: Array<Record<string, unknown>> = [];
  for (const line of rawLines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "unparsable transcript" };
      }
      entries.push(parsed as Record<string, unknown>);
    } catch {
      // Abort rather than write: a transcript we cannot fully parse is one we cannot safely
      // rewrite, and half-understanding it is how you lose a conversation.
      return { ok: false, reason: "unparsable transcript" };
    }
  }

  const messageIdx = entries.map((e, i) => (e.type === "message" ? i : -1)).filter((i) => i >= 0);
  if (messageIdx.length < 4) {
    return {
      ok: true,
      evicted: 0,
      evictedTokens: 0,
      kept: messageIdx.length,
      lines: null,
      reason: "too few messages to evict",
    };
  }

  // Target: keep the newest ceil(count * keepFraction), never fewer than 2.
  const targetKeep = Math.max(2, Math.ceil(messageIdx.length * keepFraction));
  const targetOrdinal = messageIdx.length - targetKeep;
  // Rule 2 — snap FORWARD from the target to the first safe boundary.
  let cutOrdinal = -1;
  for (let ord = targetOrdinal; ord < messageIdx.length; ord++) {
    const entry = entries[messageIdx[ord]];
    if (entryRole(entry) === "user" && !entryCarriesToolResult(entry)) {
      cutOrdinal = ord;
      break;
    }
  }
  if (cutOrdinal < 0 || cutOrdinal === 0) {
    // No safe boundary after the target (or the only one is the very first message): there is
    // nothing we can drop without risking an orphaned tool result.
    return {
      ok: true,
      evicted: 0,
      evictedTokens: 0,
      kept: messageIdx.length,
      lines: null,
      reason: "no safe turn boundary to evict at",
    };
  }

  const firstKeptIndex = messageIdx[cutOrdinal];
  const kept: Array<Record<string, unknown>> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Rule 1 — structural entries always survive; messages only from the cut onwards.
    if (entry.type !== "message" || i >= firstKeptIndex) {
      kept.push(entry);
    }
  }

  // Rule 3 — re-chain. The first kept entry keeps whatever parent link it had (it is the session
  // header in practice, which has none).
  let prevId: string | undefined;
  for (const entry of kept) {
    const id = typeof entry.id === "string" ? entry.id : undefined;
    if (prevId !== undefined && "parentId" in entry) {
      entry.parentId = prevId;
    }
    if (id !== undefined) {
      prevId = id;
    }
  }

  const keptMessages = kept.filter((e) => e.type === "message").length;
  // Estimate what the eviction bought, over MESSAGE entries only — the structural entries all
  // survive, so counting them would inflate both ends. One pass over one population, so
  // tokensBefore covers exactly kept + dropped. Each part is rounded on its own (parts, never a
  // delta — P5), so tokensBefore - tokensAfter may differ from evictedTokens by one token.
  //
  // FORK 2026-09-24 — measured on message CONTENT through the anatomy's own estimateTokens, not
  // on JSON.stringify(entry). The first cut measured the whole transcript entry while its comment
  // claimed the anatomy's scale; on a live 1,906-message transcript the entry JSON was 1.16x the
  // content, so every saving read about 16% high against the bar it sat beside.
  const keptSet = new Set(kept);
  let keptChars = 0;
  let droppedChars = 0;
  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }
    const chars = messageContentChars(entry);
    if (keptSet.has(entry)) {
      keptChars += chars;
    } else {
      droppedChars += chars;
    }
  }
  return {
    ok: true,
    evicted: messageIdx.length - keptMessages,
    evictedTokens: estimateTokens(droppedChars),
    tokensBefore: estimateTokens(keptChars + droppedChars),
    tokensAfter: estimateTokens(keptChars),
    kept: keptMessages,
    lines: kept.map((e) => JSON.stringify(e)),
  };
}

/**
 * The provider id the tinker-bridge registers for the claude-code lane
 * (extensions/tinkerclaw-tinker-bridge/src/defaults.ts `PROVIDER_ID`). Core does not import
 * extensions, so the id is named here; cli-runner.ts and cli-session-history.ts name it too.
 */
const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/**
 * P8 — the runtime that owns this provider's context when it is not the gateway transcript, or
 * undefined on an embedded lane, where rewriting the gateway transcript is what shrinks the next
 * call.
 *
 *   - claude-code: the model's context is the claude CLI's OWN transcript, resumed with
 *     `--resume` by a worker keyed on the sessionId (context-window-panel.md F1). Eviction does
 *     not change the sessionId, so the next call resumes the same untouched CLI transcript and is
 *     exactly as large as before.
 *   - a registered CLI backend (isCliProvider, the registry's own answer — claude-cli among
 *     them): cli-runner resumes the backend's session by its cliSessionId
 *     (cli-runner/execute.ts), which a rewrite of the gateway transcript does not reach either.
 */
export function resolveContextOwningRuntime(
  provider: string,
  cfg: OpenClawConfig,
): string | undefined {
  const normalized = normalizeProviderId(provider);
  if (!normalized) {
    return undefined;
  }
  if (normalized === CLAUDE_CODE_PROVIDER_ID || isCliProvider(normalized, cfg)) {
    return normalized;
  }
  return undefined;
}

/**
 * The reason EVICT cannot shrink this session's NEXT call, or undefined when it can. The lane is
 * resolved exactly as the narrative compaction branch resolves it — resolveSessionModelRef with
 * the session entry and agent — which honours the tab's model-picker override: the refusal is
 * about where the next call goes, not where the last one ran.
 */
export function resolveEvictionRefusal(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry | undefined;
  agentId: string;
}): string | undefined {
  const { provider } = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const owner = resolveContextOwningRuntime(provider, params.cfg);
  if (!owner) {
    return undefined;
  }
  return `the ${owner} runtime keeps its own copy of this session's context, so evicting the gateway transcript would not shrink the next call`;
}

/** The `sessions.compact { keepFraction }` reply body. */
export type SessionEvictionReply = {
  ok: boolean;
  key: string;
  compacted: boolean;
  reason?: string;
  kept?: number;
  evicted?: number;
  evictedTokens?: number;
  /** ESTIMATE (P11) — present only when the transcript was rewritten. */
  tokensBefore?: number;
  /** ESTIMATE (P11) — present only when the transcript was rewritten. */
  tokensAfter?: number;
  archived?: string;
};

export type SessionEvictionOutcome =
  /** The RPC itself failed — only the run interrupt produces this. */
  | { kind: "error"; error: ErrorShape }
  /** The RPC answered; `evicted` says whether the transcript changed (the caller broadcasts). */
  | { kind: "reply"; reply: SessionEvictionReply; evicted: boolean };

/**
 * The whole `sessions.compact { keepFraction }` branch. Returns what to reply; the caller owns
 * the wire (sessions.ts is tier-1 and stays a delegation).
 */
export async function evictSessionTranscript(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry | undefined;
  agentId: string;
  canonicalKey: string;
  storePath: string;
  /** The store key whose cached token counts the rewrite invalidates. */
  storeKey: string;
  /** The transcript to rewrite, already resolved and known to exist. */
  filePath: string;
  keepFraction: number;
  /** Stops a live run on the session. Injected: it lives in the RPC file and is shared there. */
  interruptRun: () => Promise<{ error?: ErrorShape }>;
}): Promise<SessionEvictionOutcome> {
  const key = params.canonicalKey;

  // P8 — refuse BEFORE the interrupt. On a lane whose runtime owns the context the eviction
  // cannot help, so it must not abort a live turn to accomplish nothing (F1's silent side
  // effect), and the transcript is not even opened.
  const refusal = resolveEvictionRefusal(params);
  if (refusal) {
    return {
      kind: "reply",
      evicted: false,
      reply: { ok: false, key, compacted: false, reason: refusal },
    };
  }

  // Rewriting a transcript under a live run is exactly the race that corrupts a session, so stop
  // the run first — the same call the narrative branch makes.
  const interrupt = await params.interruptRun();
  if (interrupt.error) {
    return { kind: "error", error: interrupt.error };
  }

  const eviction = evictTranscriptTail(
    fs.readFileSync(params.filePath, "utf-8"),
    params.keepFraction,
  );
  if (!eviction.ok) {
    return {
      kind: "reply",
      evicted: false,
      reply: { ok: false, key, compacted: false, reason: eviction.reason },
    };
  }
  if (eviction.lines === null) {
    // Nothing safely evictable — say so and leave the file byte-identical on disk.
    return {
      kind: "reply",
      evicted: false,
      reply: { ok: true, key, compacted: false, kept: eviction.kept, reason: eviction.reason },
    };
  }

  // P7 — one start / end pair per real eviction and none on a decline: everything above this
  // line is a decline, and from here the rewrite is attempted.
  //
  // An eviction has no run of its own (any live run was just interrupted), so it mints a run id
  // shared by its start / end pair and clears it afterwards, or the bus's per-run sequence map
  // keeps one entry per button press. The session key rides every event so the panel's
  // session-gated consumer hears it.
  //
  // The three constants A1's type demands of every executor, stated once for this producer:
  // trigger "evict" is the EVICT button (`sessions.compact { keepFraction }`); lane "embedded"
  // because every other lane is REFUSED above, before an eviction can start (P8), so an emit here
  // always followed a rewrite of the gateway's own transcript; provenance "estimated" because
  // nothing re-tokenises an evicted transcript, so every figure below is context-anatomy's
  // ceil(chars / 3.5) and must never read as billed (P11, F4).
  const runId = `evict:${randomUUID()}`;
  const startedAt = Date.now();
  const compactionTarget = { runId, sessionKey: key };
  emitCompactionTelemetry(compactionTarget, {
    phase: "start",
    trigger: "evict",
    lane: "embedded",
    provenance: "estimated",
  });
  let archivedTranscript: string;
  try {
    archivedTranscript = archiveFileOnDisk(params.filePath, "bak");
    fs.writeFileSync(params.filePath, `${eviction.lines.join("\n")}\n`, "utf-8");
  } catch (err) {
    // A failed rewrite still closes its pair, or the panel's busy pulse never drops.
    emitCompactionTelemetry(compactionTarget, {
      phase: "end",
      trigger: "evict",
      lane: "embedded",
      completed: false,
      durationMs: Date.now() - startedAt,
      provenance: "estimated",
    });
    clearAgentRunContext(runId);
    throw err;
  }
  // `completed` means the transcript was rewritten; the store invalidation below is bookkeeping
  // about cached counts, not part of what the next call will send.
  emitCompactionTelemetry(compactionTarget, {
    phase: "end",
    trigger: "evict",
    lane: "embedded",
    completed: true,
    tokensBefore: eviction.tokensBefore,
    tokensAfter: eviction.tokensAfter,
    tokensDropped: eviction.evictedTokens,
    durationMs: Date.now() - startedAt,
    provenance: "estimated",
  });
  clearAgentRunContext(runId);

  await updateSessionStore(params.storePath, (store) => {
    const entryToUpdate = store[params.storeKey];
    if (!entryToUpdate) {
      return;
    }
    // Same invalidation as the maxLines branch: every cached token count now describes a
    // transcript that no longer exists. The estimate is deliberately NOT banked into
    // totalTokens / totalTokensFresh the way the narrative branch banks the engine's figure: a
    // ceil(chars / 3.5) number in a field flagged Fresh would read as exact everywhere downstream.
    // It travels on the reply and on the compaction event instead, labelled estimated.
    delete entryToUpdate.inputTokens;
    delete entryToUpdate.outputTokens;
    delete entryToUpdate.totalTokens;
    delete entryToUpdate.totalTokensFresh;
    entryToUpdate.updatedAt = Date.now();
  });

  return {
    kind: "reply",
    evicted: true,
    reply: {
      ok: true,
      key,
      compacted: true,
      evicted: eviction.evicted,
      evictedTokens: eviction.evictedTokens,
      tokensBefore: eviction.tokensBefore,
      tokensAfter: eviction.tokensAfter,
      kept: eviction.kept,
      archived: archivedTranscript,
    },
  };
}
