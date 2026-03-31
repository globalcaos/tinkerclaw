import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type SessionResumePayload = {
  ts: number;
  sessionKey: string;
  channel?: string;
  userMessage: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
};

export type SessionResume = {
  version: 1;
  payload: SessionResumePayload;
};

// v2: multi-session resume — array of entries, keyed by sessionKey (no overwrites)
type SessionResumeMulti = {
  version: 2;
  entries: SessionResumePayload[];
};

const RESUME_FILENAME = "session-resume.json";

// Sessions that should NOT be persisted for resume (disposable, run again on their own)
const SKIP_SESSION_PATTERNS = ["heartbeat", ":cron:"] as const;

export function resolveSessionResumePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), RESUME_FILENAME);
}

function shouldSkipSession(sessionKey: string): boolean {
  return SKIP_SESSION_PATTERNS.some((p) => sessionKey.includes(p));
}

export async function writeSessionResume(
  payload: SessionResumePayload,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Skip heartbeat and cron sessions — they're disposable
  if (shouldSkipSession(payload.sessionKey)) {
    return;
  }

  const filePath = resolveSessionResumePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Read existing entries (if any) and upsert by sessionKey
  let entries: SessionResumePayload[] = [];
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === 2 && Array.isArray(parsed.entries)) {
      entries = parsed.entries;
    } else if (parsed?.version === 1 && parsed.payload) {
      // Migrate v1 → v2
      entries = [parsed.payload];
    }
  } catch {
    // No existing file or corrupt — start fresh
  }

  // Upsert: replace existing entry for this sessionKey, or append
  const idx = entries.findIndex((e) => e.sessionKey === payload.sessionKey);
  if (idx >= 0) {
    entries[idx] = payload;
  } else {
    entries.push(payload);
  }

  const data: SessionResumeMulti = { version: 2, entries };
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export async function clearSessionResume(
  sessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveSessionResumePath(env);

  // If no sessionKey specified, remove the entire file (legacy behavior)
  if (!sessionKey) {
    await fs.unlink(filePath).catch(() => {});
    return;
  }

  // Remove only the entry for this sessionKey; keep other sessions' entries.
  // This prevents a completed session from wiping another in-flight session's resume.
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === 2 && Array.isArray(parsed.entries)) {
      const remaining = (parsed.entries as SessionResumePayload[]).filter(
        (e) => e.sessionKey !== sessionKey,
      );
      if (remaining.length === 0) {
        await fs.unlink(filePath).catch(() => {});
      } else {
        const data: SessionResumeMulti = { version: 2, entries: remaining };
        await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
      }
    } else {
      // v1 or unknown format — just remove the whole file
      await fs.unlink(filePath).catch(() => {});
    }
  } catch {
    // File doesn't exist or is corrupt — nothing to clear
  }
}

/**
 * Consume ALL session resume entries (v1 or v2).
 * Returns array of valid, non-expired entries. Deletes the file after reading.
 */
export async function consumeAllSessionResumes(
  ttlSeconds = 60,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionResume[]> {
  const filePath = resolveSessionResumePath(env);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  // Always remove the file once read
  await fs.unlink(filePath).catch(() => {});

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const now = Date.now();
  const results: SessionResume[] = [];

  if (parsed && typeof parsed === "object" && "version" in parsed) {
    const obj = parsed as Record<string, unknown>;
    if (obj.version === 2 && Array.isArray(obj.entries)) {
      for (const entry of obj.entries as SessionResumePayload[]) {
        if (entry?.sessionKey && entry?.ts && now - entry.ts <= ttlSeconds * 1000) {
          results.push({ version: 1, payload: entry });
        }
      }
    } else if (obj.version === 1 && obj.payload) {
      const payload = obj.payload as SessionResumePayload;
      if (payload?.ts && now - payload.ts <= ttlSeconds * 1000) {
        results.push({ version: 1, payload });
      }
    }
  }

  return results;
}

/** @deprecated Use consumeAllSessionResumes instead. Kept for backward compat. */
export async function consumeSessionResume(
  ttlSeconds = 60,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionResume | null> {
  const all = await consumeAllSessionResumes(ttlSeconds, env);
  return all[0] ?? null;
}
