/**
 * Builds a decomposed forensic dump of the full LLM request payload.
 * Each dump captures: system prompt (by section), tools, conversation history,
 * current prompt, and totals — so you can measure where tokens are spent.
 *
 * Dumps are stored **per-session** in memory (LRU-capped) and on disk
 * under `forensic-sessions/`.  Disk reads are **lazy and single-key**: a
 * session is loaded only when it is asked for by key (`loadSessionFromDisk`).
 * Nothing ever enumerates `forensic-sessions/` — see the FORK 2026-08-28 note
 * below for the 11–14 s cold-start stall that rule exists to prevent.
 * Legacy `forensic-latest.json` is read once for cold-start migration and
 * never written to again.
 *
 * Writing to the forensic-dumps/ archive only happens when forensic mode
 * is enabled.
 */

import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { isForensicMode } from "./mode.js";
import { parseSystemPromptSections } from "./parse-system-prompt.js";

const DUMP_DIR = path.join(STATE_DIR, "forensic-dumps");
const FORENSIC_SESSION_DIR = path.join(STATE_DIR, "forensic-sessions");
const LEGACY_DUMP_PATH = path.join(STATE_DIR, "forensic-latest.json");

export interface ForensicDumpInput {
  runId: string;
  sessionKey: string;
  model: string;
  provider: string;
  modelApi: string;
  systemPrompt: string;
  messages: unknown[];
  tools: unknown[];
  effectivePrompt: string;
}

function charCount(v: unknown): number {
  if (typeof v === "string") {
    return v.length;
  }
  const s = safeJsonStringify(v);
  return s ? s.length : 0;
}

function sanitizeFilenameSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
}

// ─── Run container: stores ALL calls within a single run ───
export interface ForensicRun {
  runId: string;
  dumps: any[];
  startedAt: string;
  responses?: any[]; // per-call response content blocks, matched by index with dumps[]
}

const MAX_SESSIONS = 20;

// ─── Per-session in-memory store ───
const sessionRuns = new Map<string, ForensicRun>();
const sessionAccessOrder: string[] = []; // LRU tracking
// FORK 2026-08-28 — one-shot guard for the legacy `forensic-latest.json` migration.
// Replaces `loadedFromDisk`, which guarded the deleted directory-wide sweep.
let legacyMigrationAttempted = false;

// ─── Helpers ───

function sessionFilePath(sk: string): string {
  return path.join(FORENSIC_SESSION_DIR, `forensic-${sanitizeFilenameSegment(sk)}.json`);
}

function touchSession(sk: string): void {
  const idx = sessionAccessOrder.indexOf(sk);
  if (idx >= 0) {
    sessionAccessOrder.splice(idx, 1);
  }
  sessionAccessOrder.push(sk);

  // Evict oldest from memory if over limit (disk files kept)
  while (sessionAccessOrder.length > MAX_SESSIONS) {
    const evict = sessionAccessOrder.shift()!;
    sessionRuns.delete(evict);
  }
}

// FORK 2026-08-28 (R4 — no multi-second event-loop stalls): the eager sweep is GONE.
// `loadAllSessionsFromDisk()` used to `readdirSync` the whole `forensic-sessions/`
// directory on the first touch after every gateway start, then `readFileSync` +
// `JSON.parse` EVERY file. That directory is 0.97 GB / 3,269 files (individual dumps up
// to 31.8 MB) and `touchSession` immediately evicted through MAX_SESSIONS = 20 — so
// 3,249 of the 3,269 parses were discarded in the same tick. Measured cold-start cost on
// four separate gateway starts: 11,658 / 11,172 / 11,132 / 14,612 ms of synchronous
// blocking in a single tick (warm figure the same day: 309 ms).
//
// HONESTY: adversarial verification REFUTED this as the cause of the 12:39 tab freeze —
// it fires once per process and had already fired 3h20m earlier. It is removed because it
// independently violates R4 with a hard receipt, NOT because it caused that incident.
//
// Everything now goes through this: one `existsSync` + one `readFileSync`, for the ONE
// session actually asked for, by key.
function loadSessionFromDisk(sk: string): ForensicRun | null {
  try {
    const fp = sessionFilePath(sk);
    if (!fs.existsSync(fp)) {
      return null;
    }
    const raw = fs.readFileSync(fp, "utf-8");
    const parsed = JSON.parse(raw);
    // `dumps` must be an array: every consumer (`getDumpForSession`, `upsertRun`,
    // `finalizeForensicRun`) indexes into it or pushes to it. The pre-2026-08-28 lazy
    // path checked only `parsed.runId`, so a truncated file handed back a run whose
    // `.dumps` was undefined and blew up in the caller instead of reading as absent.
    if (parsed && parsed.runId && Array.isArray(parsed.dumps)) {
      return parsed as ForensicRun;
    }
  } catch {
    /* missing or corrupt — treat as absent */
  }
  return null;
}

// FORK 2026-08-28 — cold-start migration of the pre-per-session `forensic-latest.json`.
// Kept, but lazy + one-shot: it costs one `existsSync` on the first cache miss of a cold
// store and never repeats. It used to live inside the sweep, gated on "no session files
// exist on disk" — a condition that itself required the 0.97 GB `readdir` to evaluate.
// Deliberately NOT called from `getLatestRun()`: see the note there.
function migrateLegacyDumpOnce(): void {
  if (legacyMigrationAttempted || sessionRuns.size > 0) {
    return;
  }
  legacyMigrationAttempted = true;
  try {
    if (!fs.existsSync(LEGACY_DUMP_PATH)) {
      return;
    }
    const raw = fs.readFileSync(LEGACY_DUMP_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    let run: ForensicRun;
    if (parsed && !parsed.dumps) {
      // Old single-dump format
      run = {
        runId: parsed.meta?.runId ?? "unknown",
        dumps: [parsed],
        startedAt: parsed.meta?.timestamp ?? new Date().toISOString(),
      };
    } else {
      run = parsed;
    }
    const sk = run.dumps?.[0]?.meta?.sessionKey ?? "main";
    // The per-session file is authoritative: if one already exists for this key the
    // legacy blob is stale and must NOT overwrite it. The old gate was "no session files
    // on disk AT ALL", which is only evaluable with the sweep this commit deletes; one
    // stat on the ONE key the legacy run names is the cheap, equivalent guard.
    if (fs.existsSync(sessionFilePath(sk))) {
      return;
    }
    sessionRuns.set(sk, run);
    touchSession(sk);
    // Persist migrated data to new location
    persistSessionRun(sk);
  } catch {
    /* no legacy file — fresh install */
  }
}

function persistSessionRun(sk: string): void {
  try {
    const run = sessionRuns.get(sk);
    if (!run) {
      return;
    }
    fs.mkdirSync(FORENSIC_SESSION_DIR, { recursive: true });
    const json = safeJsonStringify(run) ?? JSON.stringify(run);
    fs.writeFileSync(sessionFilePath(sk), json, "utf-8");
  } catch {
    /* non-critical — in-memory still works */
  }
}

function lastAccessedSessionKey(): string | null {
  if (sessionAccessOrder.length === 0) {
    return null;
  }
  return sessionAccessOrder[sessionAccessOrder.length - 1];
}

// ─── Session-aware exports ───

// FORK 2026-08-28 — the ONE disk path into the forensic store. Memory first, then a
// single-file read for this key (a session may have been evicted past MAX_SESSIONS, or
// simply never loaded in this process), then the one-shot legacy migration.
export function getRunForSession(sk: string): ForensicRun | null {
  const cached = sessionRuns.get(sk);
  if (cached) {
    touchSession(sk);
    return cached;
  }
  const fromDisk = loadSessionFromDisk(sk);
  if (fromDisk) {
    sessionRuns.set(sk, fromDisk);
    touchSession(sk);
    return fromDisk;
  }
  migrateLegacyDumpOnce();
  const migrated = sessionRuns.get(sk);
  if (migrated) {
    touchSession(sk);
    return migrated;
  }
  return null;
}

export function getDumpForSession(sk: string): any {
  const run = getRunForSession(sk);
  if (!run || !run.dumps.length) {
    return null;
  }
  return run.dumps[run.dumps.length - 1];
}

export function getDumpByIndexForSession(sk: string, index: number): any {
  const run = getRunForSession(sk);
  if (!run || index < 0 || index >= run.dumps.length) {
    return null;
  }
  return run.dumps[index];
}

// ─── Backward-compat exports (fall back to most-recently-accessed session) ───

// FORK 2026-08-28 — deliberately does NO disk I/O, and must stay that way.
// `lastAccessedSessionKey()` means "most recently touched IN THIS PROCESS", so on a cold
// LRU the only honest answer is `null`. Re-deriving a "latest" from `readdir` + mtime
// would silently hand back a DIFFERENT session's run — a correctness regression far worse
// than the latency it would save. Every caller already handles null: `forensic.getLive`,
// `getLiveDetail`, `summarize`, `getResponseLive` and `getResponseDetail` all respond
// NO_DATA ("No context captured yet." / "No response data yet.").
export function getLatestRun(): ForensicRun | null {
  const sk = lastAccessedSessionKey();
  if (!sk) {
    return null;
  }
  return sessionRuns.get(sk) ?? null;
}

export function getLatestDump(): any {
  const run = getLatestRun();
  if (!run || !run.dumps.length) {
    return null;
  }
  return run.dumps[run.dumps.length - 1];
}

export function getDumpByIndex(index: number): any {
  const run = getLatestRun();
  if (!run || index < 0 || index >= run.dumps.length) {
    return null;
  }
  return run.dumps[index];
}

// ─── Build dump object (always stored in memory) ───
function buildDump(input: ForensicDumpInput): any {
  const now = new Date();

  const sections = parseSystemPromptSections(input.systemPrompt);
  const systemChars = input.systemPrompt.length;

  const toolDefs = (input.tools ?? []).map((t: any) => ({
    name: t?.name ?? "unknown",
    schema_chars: charCount(t),
    schema_text: safeJsonStringify(t) ?? "",
  }));
  const toolsJson = safeJsonStringify(input.tools) ?? "[]";
  const toolsChars = toolsJson.length;

  const msgs = input.messages ?? [];
  const byRole: Record<string, { count: number; chars: number }> = {};
  for (const m of msgs) {
    const role = (m as any)?.role ?? "unknown";
    const entry = (byRole[role] ??= { count: 0, chars: 0 });
    entry.count++;
    entry.chars += charCount(m);
  }
  const historyChars = charCount(msgs);
  const promptChars = input.effectivePrompt.length;
  const totalChars = systemChars + toolsChars + historyChars + promptChars;

  return {
    meta: {
      timestamp: now.toISOString(),
      runId: input.runId,
      sessionKey: input.sessionKey,
      model: input.model,
      provider: input.provider,
      modelApi: input.modelApi,
    },
    system_prompt: {
      full_text: input.systemPrompt,
      chars: systemChars,
      sections,
    },
    tools: {
      count: toolDefs.length,
      chars: toolsChars,
      definitions: toolDefs,
    },
    conversation_history: {
      message_count: msgs.length,
      chars: historyChars,
      by_role: byRole,
      messages: msgs,
    },
    current_prompt: {
      text: input.effectivePrompt,
      chars: promptChars,
    },
    totals: {
      chars: totalChars,
      estimated_tokens: Math.ceil(totalChars / 4),
    },
  };
}

// ─── Shared append logic, scoped to a session key ───
// Keeps dumps across runs so the timeline can access all historical calls.
function upsertRun(sk: string, dump: any, runId: string): void {
  // FORK 2026-08-28 — lazy single-key load (was: sweep the whole directory).
  // This also fixes a latent data-loss bug: the old sweep evicted down to
  // MAX_SESSIONS = 20, so a session whose file was on disk but outside the last 20
  // was invisible to `sessionRuns.get(sk)` here, and `persistSessionRun` below then
  // OVERWROTE that file with a brand-new one-dump run.
  const existing = getRunForSession(sk);

  if (existing) {
    if (existing.runId !== runId) {
      // New run — update tracking, clear stale response data
      existing.runId = runId;
      (existing as any)._currentRunStart = existing.dumps.length;
      existing.startedAt = dump.meta.timestamp;
      existing.responses = undefined;
    }
    existing.dumps.push(dump);
  } else {
    const run: ForensicRun = {
      runId,
      dumps: [dump],
      startedAt: dump.meta.timestamp,
    };
    (run as any)._currentRunStart = 0;
    sessionRuns.set(sk, run);
  }
  touchSession(sk);
  persistSessionRun(sk);
}

// ─── Finalize run: extract per-call responses from dump history + messagesSnapshot ───
export async function finalizeForensicRun(
  sk: string,
  runId: string,
  messagesSnapshot: unknown[],
): Promise<void> {
  // FORK 2026-08-28 — lazy single-key load. `_currentRunStart` is an own enumerable
  // property, so it survives the `safeJsonStringify` round-trip in `persistSessionRun`:
  // a run re-read from disk finalizes exactly like one still resident in memory.
  const run = getRunForSession(sk);
  if (!run || run.runId !== runId) {
    return;
  }

  const totalDumps = run.dumps.length;
  const startIdx = (run as any)._currentRunStart ?? 0;

  // Preserve existing responses from previous runs
  const responses: any[] = new Array(totalDumps).fill(null);
  if (run.responses) {
    for (let i = 0; i < run.responses.length && i < totalDumps; i++) {
      responses[i] = run.responses[i];
    }
  }

  // Strategy: each dump[i] captures context.messages BEFORE call i.
  // So dump[i+1].conversation_history.messages contains the response to call i
  // as its last assistant message (captured before SDK redacts thinking).
  // Only process dumps from the CURRENT run (startIdx onwards).
  for (let i = startIdx; i < totalDumps - 1; i++) {
    const nextDump = run.dumps[i + 1];
    const msgs = nextDump?.conversation_history?.messages;
    if (Array.isArray(msgs)) {
      for (let j = msgs.length - 1; j >= 0; j--) {
        const m = msgs[j] as any;
        if (m?.role === "assistant") {
          const content = Array.isArray(m.content) ? m.content : [];
          if (content.length > 0) {
            responses[i] = content;
          }
          break;
        }
      }
    }
  }

  // For the LAST call, extract from messagesSnapshot (has full thinking)
  for (let j = messagesSnapshot.length - 1; j >= 0; j--) {
    const m = messagesSnapshot[j] as any;
    if (m?.role === "assistant") {
      const content = Array.isArray(m.content) ? m.content : [];
      if (content.length > 0) {
        responses[totalDumps - 1] = content;
      }
      break;
    }
  }

  run.responses = responses.map((r) => r ?? []);
  persistSessionRun(sk);
}

// ─── Get response data for a session ───
export function getResponseForSession(sk: string, callIndex?: number): any {
  const run = getRunForSession(sk);
  if (!run?.responses?.length) {
    return null;
  }
  if (callIndex != null) {
    return run.responses[callIndex] ?? null;
  }
  return run.responses;
}

export function getLatestResponses(): any {
  const run = getLatestRun();
  if (!run?.responses?.length) {
    return null;
  }
  return run.responses;
}

// ─── Capture: always in memory + persisted, forensic-mode also archives ───
export async function captureForensicDump(input: ForensicDumpInput): Promise<void> {
  const dump = buildDump(input);
  const sk = input.sessionKey || "main";

  upsertRun(sk, dump, input.runId);

  if (isForensicMode()) {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "").slice(0, -1) + "Z";
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const json = safeJsonStringify(dump) ?? JSON.stringify(dump);
    const filename = `${ts}_${sanitizeFilenameSegment(input.sessionKey)}_${sanitizeFilenameSegment(input.provider)}_${sanitizeFilenameSegment(input.model)}.json`;
    fs.writeFileSync(path.join(DUMP_DIR, filename), json, "utf-8");
  }
}

// ─── Legacy: always writes to disk (kept for backwards compat) ───
export async function writeForensicDump(input: ForensicDumpInput): Promise<string> {
  const dump = buildDump(input);
  const sk = input.sessionKey || "main";

  upsertRun(sk, dump, input.runId);

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "").slice(0, -1) + "Z";
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const json = safeJsonStringify(dump) ?? JSON.stringify(dump);
  const filename = `${ts}_${sanitizeFilenameSegment(input.sessionKey)}_${sanitizeFilenameSegment(input.provider)}_${sanitizeFilenameSegment(input.model)}.json`;
  const filePath = path.join(DUMP_DIR, filename);
  fs.writeFileSync(filePath, json, "utf-8");
  return filePath;
}
