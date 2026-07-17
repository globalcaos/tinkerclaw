import { normalizeProviderId } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  type ClaudeCliFallbackSeed,
  CLAUDE_CLI_PROVIDER,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";
import { resolveTinkerBridgeCliSessionIdForOpenclawSession } from "./tinker-bridge-session-map.js";

/**
 * FORK 2026-05-21: tinker-bridge's provider id ("claude-code") is a distinct
 * launching path that still wraps the same claude-cli engine and writes to
 * the same `~/.claude/projects/<cwd>/<sessionId>.jsonl` transcript layout, so
 * its sessions are also valid sources for the augment-from-claude-cli import.
 * The provider gate below treats both as cli-like.
 */
const TINKER_BRIDGE_PROVIDER = "claude-code";

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
    return !importAssistantTimestamps.some(
      (it) => Math.abs(it - t) <= IMPORT_ASSISTANT_SLOT_COVER_MS,
    );
  });
}

export function augmentChatHistoryWithCliSessionImports(params: {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
}): unknown[] {
  // FORK 2026-05-21a: chain BOTH the explicit binding AND the tinker-bridge
  // session-map fallback as imports. A sessionKey can be served across
  // multiple claude-cli sessions over time (every tinker-bridge respawn mints a
  // new sessionId), and any one of them may carry context the user expects
  // to keep seeing. Returning the first match alone made hard-refresh show
  // either the current spawn OR the prior spawn, but never both. Now we
  // import each distinct candidate and let the merge sort by timestamp.
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
  if (cliSessionIds.length === 0) {
    return params.localMessages;
  }

  const normalizedProvider = normalizeProviderId(params.provider ?? "");
  if (
    normalizedProvider &&
    normalizedProvider !== CLAUDE_CLI_PROVIDER &&
    normalizedProvider !== TINKER_BRIDGE_PROVIDER &&
    params.localMessages.length > 0
  ) {
    return params.localMessages;
  }

  // Read all candidate imports up front so the local coalesced assistant blobs an import covers can
  // be dropped BEFORE merging (Mechanism A — see dropImportCoveredLocalAssistants above).
  const allImports: unknown[][] = [];
  const importAssistantTimestamps: number[] = [];
  for (const id of cliSessionIds) {
    const importedMessages = readClaudeCliSessionMessages({
      cliSessionId: id,
      homeDir: params.homeDir,
    });
    if (importedMessages.length === 0) {
      continue;
    }
    allImports.push(importedMessages);
    for (const m of importedMessages) {
      if (cliMsgRole(m) === "assistant") {
        const t = cliMsgTimestamp(m);
        if (t !== undefined) {
          importAssistantTimestamps.push(t);
        }
      }
    }
  }
  if (allImports.length === 0) {
    return params.localMessages;
  }

  // Only a tinker-bridge / claude-cli session's local store holds the coalesced blob the import
  // re-provides natively; for those, let the import's segments win the covered turns.
  const isTinkerBridgeLike =
    normalizedProvider === CLAUDE_CLI_PROVIDER || normalizedProvider === TINKER_BRIDGE_PROVIDER;
  let merged = isTinkerBridgeLike
    ? dropImportCoveredLocalAssistants(params.localMessages, importAssistantTimestamps)
    : params.localMessages;
  for (const importedMessages of allImports) {
    merged = mergeImportedChatHistoryMessages({
      localMessages: merged,
      importedMessages,
    });
  }
  return merged;
}
