/**
 * FORK 2026-09-22: how the bridge's claude child receives the moral code (ethical rules,
 * objectives, starter kit) — once per conversation instead of in every spawn's system
 * prompt.
 *
 * - New conversations and compactions: the `tinkerclaw-core` Claude Code plugin's
 *   SessionStart hook injects the pack (loaded here with --plugin-dir).
 * - Conversations that predate this (resumed, transcript without the pack): the pack
 *   prefixes the next user message once; from then on the transcript carries it.
 * - Plugin not found: fall back to appending the pack to the system prompt, as before.
 *
 * FORK 2026-09-23 — this module decides nothing about the CONTENT and owns no copy of the
 * contract. TinkerClaw publishes the pack (tinkerclaw-moral-code plugin) and owns the marker,
 * the file and the transcript test (src/moral-code/contract.ts, via plugin-sdk/state-paths);
 * the bridge only knows WHEN its claude child's context starts over. When TinkerClaw's moral
 * code is off, the published file is withdrawn and every read here returns "" — the bridge then
 * delivers nothing, exactly like every other model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MORAL_CODE_MARKER,
  readPublishedMoralCode,
  resolveStateDir,
  transcriptHasMoralCode,
} from "openclaw/plugin-sdk/state-paths";

export { MORAL_CODE_MARKER, transcriptHasMoralCode };

export function resolveCorePluginDir(moduleDir: string = __dirname): string | undefined {
  const candidates = [
    process.env.TINKERCLAW_CC_CORE_PLUGIN_DIR?.trim(),
    path.join(moduleDir, "..", "..", "..", "claude-plugins", "tinkerclaw-core"),
    path.join(moduleDir, "..", "..", "..", "..", "claude-plugins", "tinkerclaw-core"),
    path.join(os.homedir(), "src", "tinkerclaw", "claude-plugins", "tinkerclaw-core"),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((dir) => fs.existsSync(path.join(dir, "hooks", "hooks.json")));
}

/** The pack TinkerClaw published, or "" when it has not (feature off). */
export function readMaterializedMoralCode(stateDir: string = resolveStateDir()): string {
  return readPublishedMoralCode(stateDir);
}
