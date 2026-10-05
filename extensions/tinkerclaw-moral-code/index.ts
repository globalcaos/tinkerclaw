/**
 * FORK 2026-09-22: tinkerclaw-moral-code — the moral code (ethical rules, objectives,
 * starter-kit doctrine) enters every conversation ONCE: at its start, and again right
 * after a compaction. Same content for every model the UI can pick.
 *
 * - Non-Claude providers (Sol, Grok, Gemini…): `before_prompt_build` prepends the pack to
 *   the turn's user message whenever the session's messages don't carry it yet. That is
 *   stateless and covers the first turn, the first turn after a compaction (the summary
 *   replaces the messages that carried it) and sessions that predate this plugin.
 * - Claude Code (native chats and the Tinker bridge): its own `SessionStart` hook
 *   (claude-plugins/tinkerclaw-core) delivers the same pack on startup/clear/compact, so
 *   this plugin skips `claude-code` turns — Claude Code compacts internally, where the
 *   gateway cannot see it.
 *
 * The pack is materialized to <stateDir>/moral-code/moral-code.md: the one file every
 * consumer reads (the Claude Code hook, the bridge, any other harness).
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  buildMoralCodePack,
  defaultBundledDirs,
  materializeMoralCodePack,
  messagesContainMoralCode,
  SELF_DELIVERING_PROVIDERS,
  type MoralCodePack,
} from "./src/pack.js";

const REFRESH_MS = 60_000;

export default function register(api: OpenClawPluginApi) {
  const stateDir = resolveStateDir();
  const paths = {
    stateDir,
    bundledDirs: defaultBundledDirs(dirname(fileURLToPath(import.meta.url))),
  };

  let pack: MoralCodePack = { text: "", sources: [], missing: [] };
  const refresh = () => {
    try {
      pack = buildMoralCodePack(paths);
      if (pack.missing.length > 0) {
        api.logger.warn(`[moral-code] no file found for: ${pack.missing.join(", ")}`);
      }
      if (pack.text && materializeMoralCodePack(pack, stateDir)) {
        api.logger.info(
          `[moral-code] pack written (${pack.text.length} chars, ${pack.sources.length} sources)`,
        );
      }
    } catch (err) {
      api.logger.warn(`[moral-code] refresh failed: ${String(err)}`);
    }
  };
  refresh();
  // Edits to the workspace files reach the pack within a minute, for every consumer.
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref?.();

  api.on(
    "before_prompt_build",
    async (
      payload: { prompt: string; messages?: unknown[] },
      context: { sessionKey?: string; modelProviderId?: string },
    ) => {
      if (!pack.text) {
        return;
      }
      if (context.modelProviderId && SELF_DELIVERING_PROVIDERS.has(context.modelProviderId)) {
        return;
      }
      if (messagesContainMoralCode(payload.messages ?? [])) {
        return;
      }
      api.logger.info(`[moral-code] delivered to ${context.sessionKey ?? "?"}`);
      return { prependContext: pack.text };
    },
    // Highest priority: prependContext segments concatenate in priority order, so the
    // moral code opens the turn ahead of any other plugin's context.
    { priority: 1000 },
  );
}
