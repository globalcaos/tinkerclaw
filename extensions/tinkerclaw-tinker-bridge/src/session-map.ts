/**
 * FORK (2026-04-22): persist the sessionKey → claude CLI sessionId map to
 * disk so that when the gateway restarts, new worker spawns can pass
 * `--resume <sessionId>` and pick up the running claude CLI conversation
 * state. Without this file the in-memory worker pool is empty at boot and
 * every spawned claude subprocess starts fresh, giving Jarvis amnesia for
 * anything that wasn't already in SOUL.md / MEMORY.md / bootstrap files.
 *
 * Layout: `~/.openclaw/tinker-bridge/session-map.json`
 *   {
 *     "tinker-sp-XXXXXXXX": { "sessionId": "...", "updatedAt": 1234567890 },
 *     "agent:main:main": { "sessionId": "...", "updatedAt": 1234567890 }
 *   }
 *
 * Keys are the same sessionKey strings the worker-pool uses. Values are the
 * claude CLI session-id strings (UUIDs) and the timestamp of the last update.
 * Updates are best-effort async writes; read on gateway startup.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAP_PATH = path.join(os.homedir(), ".openclaw", "tinker-bridge", "session-map.json");
// FORK 2026-06-20 (cc-bridge → tinker-bridge rename): the pre-rename state dir + worker-pool
// prefix. loadSessionMap() runs a ONE-TIME migration that copies the legacy map to MAP_PATH and
// rekeys cc-sp- → tinker-sp-, so existing claude-cli --resume bindings survive the rename
// (no amnesia for in-flight conversations).
const LEGACY_MAP_PATH = path.join(os.homedir(), ".openclaw", "cc-bridge", "session-map.json");
const LEGACY_KEY_PREFIX = "cc-sp-";
const KEY_PREFIX = "tinker-sp-";

interface MapEntry {
  sessionId: string;
  updatedAt: number;
  /**
   * FORK 2026-05-10: openclaw-side session id (the agent session UUID, e.g.
   * `adf1152b-…`). Recorded so we can find the latest tinker-bridge claude-cli
   * session for a given agent across tinker-bridge sessionKey hash drift. The
   * tinker-bridge sessionKey embeds the systemPrompt hash, which can change
   * across an interrupted-then-resumed turn (resume injects a [System]
   * message into the prefix). Without this fallback index, the resume
   * starts a fresh claude-cli session and Jarvis appears to forget the
   * task that was just interrupted.
   */
  openclawSessionId?: string;
}

type SessionMap = Record<string, MapEntry>;

let cache: SessionMap | null = null;

function ensureDir(): void {
  try {
    fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
  } catch {
    // swallow
  }
}

export function loadSessionMap(): SessionMap {
  if (cache) {
    return cache;
  }
  try {
    const txt = fs.readFileSync(MAP_PATH, "utf8");
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cache = parsed as SessionMap;
      return cache;
    }
  } catch {
    // new file missing or corrupt — try the one-time cc-bridge → tinker-bridge migration first
    const migrated = migrateLegacyMap();
    if (migrated) {
      cache = migrated;
      return cache;
    }
  }
  cache = {};
  return cache;
}

// FORK 2026-06-20: one-time migration of the pre-rename ~/.openclaw/cc-bridge/session-map.json.
// Copies it to MAP_PATH, rekeying the worker-pool prefix cc-sp- → tinker-sp- so live claude-cli
// --resume bindings are preserved across the rename. Best-effort: returns null when there is no
// legacy file (a genuinely fresh install) or it is unreadable.
function migrateLegacyMap(): SessionMap | null {
  let txt: string;
  try {
    txt = fs.readFileSync(LEGACY_MAP_PATH, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const migrated: SessionMap = {};
  for (const [k, v] of Object.entries(parsed as SessionMap)) {
    const nk = k.startsWith(LEGACY_KEY_PREFIX) ? KEY_PREFIX + k.slice(LEGACY_KEY_PREFIX.length) : k;
    migrated[nk] = v;
  }
  ensureDir();
  try {
    fs.writeFileSync(MAP_PATH, JSON.stringify(migrated, null, 2), "utf8");
  } catch {
    // even if the write fails, return the in-memory migrated map so THIS boot resumes correctly
  }
  return migrated;
}

export function getResumeSessionId(sessionKey: string): string | undefined {
  const map = loadSessionMap();
  return map[sessionKey]?.sessionId;
}

/**
 * FORK 2026-05-10 — fallback resume lookup by openclaw agent sessionId.
 *
 * Use case: a turn was interrupted by a gateway restart. On resume the
 * agent dispatches `[System] continue ...` with the same openclaw sessionId
 * but a slightly different systemPrompt prefix (the [System] message
 * itself), which produces a different tinker-bridge sessionKey hash. The new
 * sessionKey has no entry in the map, so the worker would spawn claude-cli
 * fresh and lose the prior conversation. This helper scans the map for the
 * most recently updated entry with a matching `openclawSessionId` and
 * returns its `sessionId` so the new worker can `--resume` it.
 *
 * Returns undefined when there's no prior entry to recover (e.g. first
 * turn of a session, or session-map was cleared).
 */
export function getLatestResumeSessionIdByOpenclawSessionId(
  openclawSessionId: string,
): string | undefined {
  if (!openclawSessionId) {
    return undefined;
  }
  const map = loadSessionMap();
  let bestSessionId: string | undefined;
  let bestUpdatedAt = -1;
  for (const entry of Object.values(map)) {
    if (entry.openclawSessionId !== openclawSessionId) {
      continue;
    }
    if (entry.updatedAt > bestUpdatedAt) {
      bestUpdatedAt = entry.updatedAt;
      bestSessionId = entry.sessionId;
    }
  }
  return bestSessionId;
}

export function setResumeSessionId(
  sessionKey: string,
  sessionId: string,
  openclawSessionId?: string,
): void {
  const map = loadSessionMap();
  const existing = map[sessionKey];
  if (existing?.sessionId === sessionId && existing.openclawSessionId === openclawSessionId) {
    return;
  }
  map[sessionKey] = {
    sessionId,
    updatedAt: Date.now(),
    ...(openclawSessionId ? { openclawSessionId } : {}),
  };
  ensureDir();
  try {
    fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2), "utf8");
  } catch {
    // swallow — a failed write just means we'll start fresh next restart
  }
}

export function clearSessionMap(): void {
  cache = {};
  try {
    fs.unlinkSync(MAP_PATH);
  } catch {
    // fine if missing
  }
}
