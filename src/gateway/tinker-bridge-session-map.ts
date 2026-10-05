/**
 * FORK 2026-05-21: read-only adapter for tinker-bridge's `session-map.json`.
 *
 * tinker-bridge's worker writes the live claude-cli sessionId per tinker-bridge
 * worker key (`tinker-sp-<hash>`) to `~/.openclaw/tinker-bridge/session-map.json` on
 * every spawn's init line. The gateway's `sessions.json` entry tracks
 * `sessionFile` separately and is never updated by tinker-bridge, so the two
 * stores drift after every tinker-bridge respawn. Without this fallback, every
 * `chat.history` call for a tinker-bridge-served sessionKey returns whatever the
 * stale `sessions.json.sessionFile` last pointed at — chat history appears
 * frozen on hard refresh.
 *
 * Resolver semantics mirror `extensions/tinkerclaw-tinker-bridge/src/session-map.ts`
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
  return path.join(home, ".openclaw", "tinker-bridge", "session-map.json");
}

// FORK 2026-09-21 — parsed-map cache, validated by fs.statSync mtimeMs+size (the
// src/config/sessions/store-cache.ts shadow-cache pattern). Every chat.history call for a
// tinker-bridge-served session hit readSessionMapFile — and again on the [duprep-history]
// logging branch — and the live file is 1.86 MB, so each call was a full sync read + JSON.parse
// on the gateway's event loop. The cached object is shared across calls and MUST be treated as
// READ-ONLY; this module only iterates it (any future mutator must clone first or invalidate).
// There is no write path in this module (it is a read-only adapter — the writer is the
// tinker-bridge extension in another process), so invalidation is purely the stat check: a
// cross-process rewrite changes mtime/size and forces a re-read. A write landing between our
// statSync and readFileSync is cached under the older stat and self-heals on the next call's
// stat mismatch.
type SessionMapCacheEntry = { map: SessionMap; mtimeMs: number; sizeBytes: number };
const SESSION_MAP_CACHE = new Map<string, SessionMapCacheEntry>();

/** Test seam: disk-read counter + cache reset. Never used by production code paths. */
export const __tinkerBridgeSessionMapCacheTesting = {
  diskReads: 0,
  clear(): void {
    SESSION_MAP_CACHE.clear();
    this.diskReads = 0;
  },
};

function readSessionMapFile(mapPath: string): SessionMap {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(mapPath);
  } catch {
    SESSION_MAP_CACHE.delete(mapPath);
    return {};
  }
  const cached = SESSION_MAP_CACHE.get(mapPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.sizeBytes === stat.size) {
    return cached.map;
  }
  let txt: string;
  try {
    __tinkerBridgeSessionMapCacheTesting.diskReads += 1;
    txt = fs.readFileSync(mapPath, "utf8");
  } catch {
    SESSION_MAP_CACHE.delete(mapPath);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    SESSION_MAP_CACHE.delete(mapPath);
    return {};
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const map = parsed as SessionMap;
    SESSION_MAP_CACHE.set(mapPath, { map, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    return map;
  }
  SESSION_MAP_CACHE.delete(mapPath);
  return {};
}

function loadSessionMap(homeDir: string | undefined): SessionMap {
  const map = readSessionMapFile(defaultSessionMapPath(homeDir));
  if (Object.keys(map).length > 0) {
    return map;
  }
  // FORK 2026-06-20 (cc-bridge → tinker-bridge rename): read the legacy
  // ~/.openclaw/cc-bridge/session-map.json until the tinker-bridge extension's one-time
  // migration writes the new path. Resolution is by openclawSessionId, so the rekey is irrelevant.
  const home = homeDir?.trim() || process.env.HOME || os.homedir();
  return readSessionMapFile(path.join(home, ".openclaw", "cc-bridge", "session-map.json"));
}

/**
 * FORK 2026-10-02 — EVERY claude-cli session bound to one OpenClaw session id, oldest binding
 * first. The map keeps every binding a session ever had (a rebind mid-session adds one); the live
 * read wants only the newest (resolveTinkerBridgeCliSessionIdForOpenclawSession), but a reset
 * archive is the whole span of that session, so it imports them all (chat.history resetArchive).
 */
export function listTinkerBridgeCliSessionIdsForOpenclawSession(params: {
  openclawSessionId: string | undefined;
  homeDir?: string;
}): string[] {
  const target = params.openclawSessionId?.trim();
  if (!target) {
    return [];
  }
  const firstSeen = new Map<string, number>();
  for (const entry of Object.values(loadSessionMap(params.homeDir))) {
    if (typeof entry?.openclawSessionId !== "string" || entry.openclawSessionId !== target) {
      continue;
    }
    const id = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
    if (!id) {
      continue;
    }
    const updatedAt =
      typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0;
    const seen = firstSeen.get(id);
    if (seen === undefined || updatedAt < seen) {
      firstSeen.set(id, updatedAt);
    }
  }
  return [...firstSeen.entries()].toSorted((a, b) => a[1] - b[1]).map(([id]) => id);
}

export function resolveTinkerBridgeCliSessionIdForOpenclawSession(params: {
  openclawSessionId: string | undefined;
  homeDir?: string;
}): string | undefined {
  const target = params.openclawSessionId?.trim();
  if (!target) {
    return undefined;
  }
  const map = loadSessionMap(params.homeDir);
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
