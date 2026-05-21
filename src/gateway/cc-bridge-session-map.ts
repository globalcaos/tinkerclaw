/**
 * FORK 2026-05-21: read-only adapter for cc-bridge's `session-map.json`.
 *
 * cc-bridge's worker writes the live claude-cli sessionId per cc-bridge
 * worker key (`cc-sp-<hash>`) to `~/.openclaw/cc-bridge/session-map.json` on
 * every spawn's init line. The gateway's `sessions.json` entry tracks
 * `sessionFile` separately and is never updated by cc-bridge, so the two
 * stores drift after every cc-bridge respawn. Without this fallback, every
 * `chat.history` call for a cc-bridge-served sessionKey returns whatever the
 * stale `sessions.json.sessionFile` last pointed at — chat history appears
 * frozen on hard refresh.
 *
 * Resolver semantics mirror `extensions/tinkerclaw-cc-bridge/src/session-map.ts`
 * `getLatestResumeSessionIdByOpenclawSessionId`: scan by `openclawSessionId`
 * (the OpenClaw-side session UUID kept in `sessions.json.sessionId`) and
 * return the most-recently-updated claude-cli sessionId. We re-implement here
 * to keep the gateway free of an import-edge into the plugin package.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type SessionMapEntry = {
  sessionId?: unknown;
  updatedAt?: unknown;
  openclawSessionId?: unknown;
};

type SessionMap = Record<string, SessionMapEntry>;

function defaultSessionMapPath(homeDir?: string): string {
  const home = homeDir?.trim() || process.env.HOME || os.homedir();
  return path.join(home, ".openclaw", "cc-bridge", "session-map.json");
}

function readSessionMapFile(mapPath: string): SessionMap {
  let txt: string;
  try {
    txt = fs.readFileSync(mapPath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return {};
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as SessionMap;
  }
  return {};
}

export function resolveCcBridgeCliSessionIdForOpenclawSession(params: {
  openclawSessionId: string | undefined;
  homeDir?: string;
}): string | undefined {
  const target = params.openclawSessionId?.trim();
  if (!target) {
    return undefined;
  }
  const map = readSessionMapFile(defaultSessionMapPath(params.homeDir));
  let bestSessionId: string | undefined;
  let bestUpdatedAt = -1;
  for (const entry of Object.values(map)) {
    if (typeof entry?.openclawSessionId !== "string" || entry.openclawSessionId !== target) {
      continue;
    }
    if (typeof entry.sessionId !== "string" || !entry.sessionId.trim()) {
      continue;
    }
    const updatedAt =
      typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0;
    if (updatedAt > bestUpdatedAt) {
      bestUpdatedAt = updatedAt;
      bestSessionId = entry.sessionId;
    }
  }
  return bestSessionId;
}
