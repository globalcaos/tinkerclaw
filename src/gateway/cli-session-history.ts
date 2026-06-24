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

  let merged = params.localMessages;
  for (const id of cliSessionIds) {
    const importedMessages = readClaudeCliSessionMessages({
      cliSessionId: id,
      homeDir: params.homeDir,
    });
    if (importedMessages.length === 0) {
      continue;
    }
    merged = mergeImportedChatHistoryMessages({
      localMessages: merged,
      importedMessages,
    });
  }
  return merged;
}
