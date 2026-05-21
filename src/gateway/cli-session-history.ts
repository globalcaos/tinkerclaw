import { normalizeProviderId } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveCcBridgeCliSessionIdForOpenclawSession } from "./cc-bridge-session-map.js";
import {
  type ClaudeCliFallbackSeed,
  CLAUDE_CLI_PROVIDER,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

/**
 * FORK 2026-05-21: cc-bridge's provider id ("claude-code") is a distinct
 * launching path that still wraps the same claude-cli engine and writes to
 * the same `~/.claude/projects/<cwd>/<sessionId>.jsonl` transcript layout, so
 * its sessions are also valid sources for the augment-from-claude-cli import.
 * The provider gate below treats both as cli-like.
 */
const CC_BRIDGE_PROVIDER = "claude-code";

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
  // FORK 2026-05-21: when sessions.json carries no cliSessionBinding (the
  // common case for cc-bridge-served sessions — see header note in
  // `cc-bridge-session-map.ts`), fall back to the cc-bridge session map keyed
  // on the OpenClaw-side sessionId. Without this fallback hard-refresh of any
  // cc-bridge tab shows only whatever stale sessionFile sessions.json last
  // pointed at, regardless of how many turns happened afterwards.
  const cliSessionId =
    resolveClaudeCliBindingSessionId(params.entry) ??
    resolveCcBridgeCliSessionIdForOpenclawSession({
      openclawSessionId: params.entry?.sessionId,
      homeDir: params.homeDir,
    });
  if (!cliSessionId) {
    return params.localMessages;
  }

  const normalizedProvider = normalizeProviderId(params.provider ?? "");
  if (
    normalizedProvider &&
    normalizedProvider !== CLAUDE_CLI_PROVIDER &&
    normalizedProvider !== CC_BRIDGE_PROVIDER &&
    params.localMessages.length > 0
  ) {
    return params.localMessages;
  }

  const importedMessages = readClaudeCliSessionMessages({
    cliSessionId,
    homeDir: params.homeDir,
  });
  return mergeImportedChatHistoryMessages({
    localMessages: params.localMessages,
    importedMessages,
  });
}
