import type { SessionEntry } from "../config/sessions.js";
import { logWarn } from "../logger.js";
import {
  type ClaudeCliFallbackSeed,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";
import { resolveTinkerBridgeCliSessionIdForOpenclawSession } from "./tinker-bridge-session-map.js";

/**
 * FORK 2026-05-21, SUPERSEDED 2026-08-05: tinker-bridge's provider id ("claude-code")
 * is a distinct launching path that still wraps the same claude-cli engine and writes
 * to the same `~/.claude/projects/<cwd>/<sessionId>.jsonl` transcript layout. That fact
 * used to be encoded here as a PROVIDER GATE — the import ran only when the session's
 * currently-resolved provider was "claude-cli" or "claude-code".
 *
 * The gate was a defect. `provider` comes from `resolveSessionModelRef(...)`, which
 * honours the tab's MODEL-PICKER override. Switching a tab to grok/qwen flipped
 * `providerOverride`, the gate short-circuited, and hundreds of already-rendered
 * messages disappeared on the next reconcile; switching the picker back resurrected
 * them. Chat history is not allowed to be a function of the model picker — a config
 * toggle must never look like a deletion. What decides now is PROVENANCE: see
 * resolveClaudeCliProvenanceSessionIds below.
 */

export {
  mergeImportedChatHistoryMessages,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
  resolveClaudeCliSessionFilePath,
};
export type { ClaudeCliFallbackSeed };

// FORK 2026-06-25 (Mechanism A — deterministic answer/thinking split for tinker-bridge turns):
// the tinker-bridge persists each turn as ONE coalesced assistant text blob (it cannot emit native
// tool_use blocks without triggering pi-agent-core re-execution — stream.ts:502-511), while the
// cc-bridge claude-cli transcript stores the SAME turn in NATIVE per-step form (text segment,
// tool_use, tool_result, …, answer) — exactly the multi-message shape the UI run-grouping
// (narrationIndices) needs to fold pre-tool working-notes into Reasoning and show only the
// post-last-tool text as the answer. The merge normally KEEPS the local coalesced blob and
// suppresses the import's segments, so the answer renders as one long block. The fix: BEFORE
// merging, drop the local coalesced assistant blobs that an import assistant COVERS (same ~5-min
// slot) so the import's segmented assistants win. Conservative: user prompts and any turn the import
// does NOT cover are kept from local (nothing lost); only the assistant-TEXT source changes for
// covered turns. No re-execution, no read-side slicing, no persistence change.
const IMPORT_ASSISTANT_SLOT_COVER_MS = 5 * 60 * 1000;

// FORK 2026-08-26 — IMPORT FLOOD SAFETY VALVE (mirrors the layer-1 safety valve in
// cli-session-history.merge.ts). This file already argues twice that a config toggle must never
// look like a deletion; the same principle says a tool loop must never look like a corruption.
// A cc-bridge tool loop appends one JSONL entry per step, so a single long run can mint hundreds
// of importable messages in minutes (observed live: 457 imports against 46 local messages), and
// merging them all is what drove chat.history serves to 18.5-41.5 s — past the client timeout,
// which renders as "my chat is gone". When the import payload exceeds this many times the local
// message count, the payload is TRUNCATED to that many records and the merge proceeds normally.
//
// FORK 2026-08-27 — the valve now BOUNDS the flood instead of deleting it. The first cut returned
// `params.localMessages` outright, and that was the wrong action for a file whose whole argument is
// that a size problem must never be answered with a deletion:
//   * the newest imports are the ones a turn IN FLIGHT is currently emitting, and a turn that a
//     gateway restart interrupted may have its only surviving text there — the coalesced local
//     record for an interrupted turn is never written. Dropping the whole payload hides exactly
//     the tail the user is waiting on. (2026-08-27 07:31 restart interrupted several live turns.)
//   * returning early also skipped dropImportCoveredLocalAssistants and the merge, so every
//     tripping tab silently lost per-step thinking/toolcall segmentation on reload.
// Truncating to the newest `ratio * localCount` records keeps the cost bound that motivated the
// valve (the debris is ancient, the value is recent) while leaving the tail — and the merge —
// intact. Measured on the live store, this drops ~70% of SerraVision's payload (632 -> 189).
const IMPORT_FLOOD_MAX_RATIO = 3;

// Escape hatch: a subtractive valve with no runtime override means a misfire costs a rebuild
// instead of a restart. Read per call — the gateway is long-lived and this must be changeable
// without one. Invalid / absent / non-positive values fall back to the compiled default.
function resolveImportFloodMaxRatio(): number {
  const raw = process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return IMPORT_FLOOD_MAX_RATIO;
}

/**
 * Keep the newest `budget` imported records across every candidate transcript, preserving each
 * transcript's own ordering. Selection is by TIMESTAMP across the combined set (not per-list
 * proportion) because the lists are different claude-cli spawns of the same tab and only a real
 * clock orders them against each other. Records carrying no usable timestamp sort oldest, so a
 * malformed record is dropped before a good one — but they are still kept when the budget allows.
 */
function truncateImportsToNewest(allImports: unknown[][], budget: number): unknown[][] {
  if (budget <= 0) {
    return allImports.map(() => []);
  }
  const flat: { list: number; index: number; ts: number }[] = [];
  for (let list = 0; list < allImports.length; list++) {
    const messages = allImports[list];
    for (let index = 0; index < messages.length; index++) {
      flat.push({
        list,
        index,
        ts: cliMsgTimestamp(messages[index]) ?? Number.NEGATIVE_INFINITY,
      });
    }
  }
  if (flat.length <= budget) {
    return allImports;
  }
  // Newest first, ties broken by original position so the order is total and stable.
  flat.sort((a, b) => b.ts - a.ts || b.list - a.list || b.index - a.index);
  const keep = new Set<string>();
  for (let i = 0; i < budget; i++) {
    keep.add(`${flat[i].list}:${flat[i].index}`);
  }
  return allImports.map((messages, list) =>
    messages.filter((_message, index) => keep.has(`${list}:${index}`)),
  );
}

function cliMsgRole(m: unknown): string | undefined {
  const r = (m as { role?: unknown } | null)?.role;
  return typeof r === "string" ? r : undefined;
}
function cliMsgTimestamp(m: unknown): number | undefined {
  const t = (m as { timestamp?: unknown } | null)?.timestamp;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const p = Date.parse(t);
    return Number.isFinite(p) ? p : undefined;
  }
  return undefined;
}
function cliMsgHasText(m: unknown): boolean {
  const c = (m as { content?: unknown } | null)?.content;
  if (typeof c === "string") return c.trim().length > 0;
  if (Array.isArray(c)) {
    return c.some(
      (b) =>
        b != null &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string" &&
        (b as { text: string }).text.trim().length > 0,
    );
  }
  return false;
}

/**
 * Drop local coalesced assistant-TEXT blobs that an imported assistant message covers (within
 * IMPORT_ASSISTANT_SLOT_COVER_MS) so the import's native per-step segments win the subsequent merge.
 * Conservative: keeps user/tool/empty messages, keeps assistants with no resolvable timestamp, and
 * keeps any local assistant the import does NOT cover (never loses a turn the import lacks).
 */
export function dropImportCoveredLocalAssistants(
  localMessages: unknown[],
  importAssistantTimestamps: number[],
  /**
   * FORK 2026-08-27 — oldest timestamp still present in the import payload we will actually merge.
   * A local assistant OLDER than this is never dropped.
   *
   * Coverage is a symmetric ±5-minute window, so once the flood valve truncates the payload to its
   * newest records a survivor belonging to a LATER turn can still "cover" a local answer whose own
   * re-providing segments were truncated away — deleting an answer that then appears in neither
   * store's output. The rule that closes it: a local answer at t >= floor always has its own newest
   * segment among the survivors, and one older than the floor never does. Optional so the two
   * non-truncating callers keep the historical behaviour unchanged.
   *
   * Reproduced before fixing (A/B, same fixture): with truncation effectively disabled
   * (OPENCLAW_IMPORT_FLOOD_MAX_RATIO=100) the answer is served; at the shipped ratio of 3 it is not.
   */
  coveredFloorTs?: number,
): unknown[] {
  if (importAssistantTimestamps.length === 0) {
    return localMessages;
  }
  return localMessages.filter((m) => {
    if (cliMsgRole(m) !== "assistant" || !cliMsgHasText(m)) {
      return true;
    }
    const t = cliMsgTimestamp(m);
    if (t === undefined) {
      return true;
    }
    if (coveredFloorTs !== undefined && t < coveredFloorTs) {
      return true;
    }
    return !importAssistantTimestamps.some(
      (it) => Math.abs(it - t) <= IMPORT_ASSISTANT_SLOT_COVER_MS,
    );
  });
}

/**
 * PROVENANCE — the honest answer to "does this OpenClaw session actually have a
 * claude-cli transcript behind it?". Two recorded sources, both written by whatever
 * really SERVED the session, neither of them derived from the model picker:
 *
 *  1. `entry.cliSessionBindings["claude-cli"].sessionId` (plus the legacy
 *     `cliSessionIds["claude-cli"]` / `claudeCliSessionId` fields) — persisted into
 *     sessions.json by the claude-cli launch path.
 *  2. `~/.openclaw/tinker-bridge/session-map.json`, keyed by this OpenClaw sessionId —
 *     tinker-bridge does not feed back into session-store, so for bridge-served tabs
 *     that map is the only record there is.
 *
 * FORK 2026-05-21a: chain BOTH. A sessionKey can be served across multiple claude-cli
 * sessions over time (every tinker-bridge respawn mints a new sessionId), and any one
 * of them may carry context the user expects to keep seeing. Returning the first match
 * alone made hard-refresh show either the current spawn OR the prior spawn, but never
 * both. We collect every distinct candidate and let the merge sort them into one
 * timeline.
 *
 * What REVOKES provenance is a reset, not a model switch: session-reset-service nulls
 * cliSessionBindings / cliSessionIds / claudeCliSessionId and mints a fresh OpenClaw
 * sessionId (so the session-map lookup misses too). That is why "/clear means cleared"
 * still holds now that the provider gate is gone.
 */
export function resolveClaudeCliProvenanceSessionIds(params: {
  entry: SessionEntry | undefined;
  homeDir?: string;
}): string[] {
  const cliSessionIds: string[] = [];
  const seen = new Set<string>();
  const bindingSessionId = resolveClaudeCliBindingSessionId(params.entry);
  if (bindingSessionId) {
    cliSessionIds.push(bindingSessionId);
    seen.add(bindingSessionId);
  }
  const mapSessionId = resolveTinkerBridgeCliSessionIdForOpenclawSession({
    openclawSessionId: params.entry?.sessionId,
    homeDir: params.homeDir,
  });
  if (mapSessionId && !seen.has(mapSessionId)) {
    cliSessionIds.push(mapSessionId);
    seen.add(mapSessionId);
  }
  return cliSessionIds;
}

export function augmentChatHistoryWithCliSessionImports(params: {
  entry: SessionEntry | undefined;
  /**
   * Optional caller-side session key, used ONLY to attribute the flood-valve warn log.
   * Falls back to entry.sessionId when absent; never affects what is served.
   */
  sessionKey?: string;
  /**
   * IGNORED since FORK 2026-08-05; kept only so existing call sites keep compiling.
   * Reading it is exactly what made chat history a function of the model picker. Do
   * not reintroduce a read — gate on provenance, never on the selected model.
   */
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
}): unknown[] {
  // GATE 1 of 2 — is there a recorded claude-cli session id for THIS session at all?
  const cliSessionIds = resolveClaudeCliProvenanceSessionIds({
    entry: params.entry,
    homeDir: params.homeDir,
  });
  if (cliSessionIds.length === 0) {
    return params.localMessages;
  }

  // Read all candidate imports up front so the local coalesced assistant blobs an import covers can
  // be dropped BEFORE merging (Mechanism A — see dropImportCoveredLocalAssistants above).
  const allImports: unknown[][] = [];
  for (const id of cliSessionIds) {
    const importedMessages = readClaudeCliSessionMessages({
      cliSessionId: id,
      homeDir: params.homeDir,
    });
    if (importedMessages.length === 0) {
      continue;
    }
    allImports.push(importedMessages);
  }
  // GATE 2 of 2 — does a recorded id actually resolve to a real transcript with content?
  // Together with GATE 1 that is the whole PROVENANCE condition: presence-of-transcript
  // (the flood valve below can additionally refuse an OUTSIZED payload, but that is a size
  // judgment about an already-proven transcript, not a provenance question). Note what is
  // deliberately NOT part of it — `params.localMessages.length`. "This session has a
  // claude-cli transcript" and "this session's local store happens to be empty right now"
  // are different questions, and the old gate conflated them in BOTH directions: a tab on a
  // non-claude model kept its imported history only while its local store was EMPTY, so a
  // fresh sessionFile / a reset / the 4am wipe got the entire stale JSONL injected, while a
  // tab that had genuinely accumulated local messages had its imported history deleted.
  if (allImports.length === 0) {
    return params.localMessages;
  }

  // IMPORT FLOOD SAFETY VALVE (FORK 2026-08-26) — see IMPORT_FLOOD_MAX_RATIO above. Fires only
  // when the LOCAL store is non-empty: after a reset / fresh sessionFile / the 4am wipe the local
  // store is empty and the import IS the history, so suppressing it then would be exactly the
  // "config deleted my history" deletion this file exists to prevent — the merge layer's own
  // valve applies the same guard via `params.localMessages.length > 0`. A valve may bound a
  // flood; it must never delete the only record.
  const importCount = allImports.reduce((count, list) => count + list.length, 0);
  const localCount = params.localMessages.length;
  const floodRatio = resolveImportFloodMaxRatio();
  let effectiveImports = allImports;
  let truncated = false;
  if (localCount > 0 && importCount > localCount * floodRatio) {
    truncated = true;
    const budget = Math.max(1, Math.floor(localCount * floodRatio));
    effectiveImports = truncateImportsToNewest(allImports, budget);
    const kept = effectiveImports.reduce((count, list) => count + list.length, 0);
    const sessionLabel = params.sessionKey ?? params.entry?.sessionId ?? "<unknown>";
    logWarn(
      `cli-history: import flood valve tripped (sessionKey=${sessionLabel}, ` +
        `cliSessionId=${cliSessionIds.join(",")}): ${localCount} local messages, ` +
        `truncating ${importCount} imported messages to the newest ${kept} ` +
        `(cap ${floodRatio}x local); ${importCount - kept} dropped`,
    );
  }

  // Only a tinker-bridge / claude-cli session's local store holds the coalesced blob the import
  // re-provides natively; for those, let the import's segments win the covered turns. Reaching
  // this line already PROVES that: allImports is non-empty, so a real claude-cli transcript
  // backs this session, and the turns an import assistant covers were produced by that bridge.
  // This used to be gated on the resolved provider as well — the same model-picker dependency,
  // which made a covered answer render as one coalesced block or as native per-step segments
  // purely according to which model the tab happened to have selected at read time.
  // COVERAGE MUST BE COMPUTED FROM WHAT WE ACTUALLY SERVE (FORK 2026-08-27). These timestamps are
  // what dropImportCoveredLocalAssistants uses to DELETE local coalesced answers, on the promise
  // that an import re-provides them in segmented form. Derived from the full pre-truncation set,
  // a record the valve just discarded would still "cover" — and therefore delete — a local answer
  // that nothing then re-provides, silently destroying the only copy. Deriving them from
  // `effectiveImports` keeps the promise honest: only an import that survives to the merge may
  // displace a local answer.
  //
  // FORK 2026-08-26 — SYMMETRY HARDENING (merge.ts B043, other direction): only a TEXT-BEARING
  // import assistant may cover a local coalesced answer. A text-less import (a tool_use-only step,
  // or a turn that died before emitting text) provides nothing to render, so letting it cover would
  // delete the only copy of the answer. cliMsgHasText is already the local side's rule
  // (dropImportCoveredLocalAssistants keeps no-text locals); the two sides of "covers" must agree.
  const importAssistantTimestamps: number[] = [];
  for (const importedMessages of effectiveImports) {
    for (const m of importedMessages) {
      if (cliMsgRole(m) === "assistant" && cliMsgHasText(m)) {
        const t = cliMsgTimestamp(m);
        if (t !== undefined) {
          importAssistantTimestamps.push(t);
        }
      }
    }
  }

  // ...and coverage must ALSO not reach BELOW the surviving payload (FORK 2026-08-27, second half
  // of the same defect). Deriving the timestamps from `effectiveImports` stops a DISCARDED import
  // from covering, but a SURVIVING import can still cover a turn it cannot re-provide: the cover
  // window is symmetric ±5 min while truncation keeps only the newest records, so a local answer
  // sitting just below the boundary is deleted by a survivor belonging to a LATER turn while its
  // own segments were truncated away — an answer present in both stores and served by neither.
  // The floor is only meaningful when we actually truncated; an untruncated payload keeps the
  // historical behaviour exactly.
  const coveredFloorTs = truncated
    ? effectiveImports.reduce((floor: number | undefined, list) => {
        for (const m of list) {
          const t = cliMsgTimestamp(m);
          if (t !== undefined && (floor === undefined || t < floor)) {
            floor = t;
          }
        }
        return floor;
      }, undefined)
    : undefined;

  let merged = dropImportCoveredLocalAssistants(
    params.localMessages,
    importAssistantTimestamps,
    coveredFloorTs,
  );
  for (const importedMessages of effectiveImports) {
    merged = mergeImportedChatHistoryMessages({
      localMessages: merged,
      importedMessages,
    });
  }
  return merged;
}
