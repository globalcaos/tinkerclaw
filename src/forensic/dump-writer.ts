/**
 * Builds a decomposed forensic dump of the full LLM request payload.
 * Each dump captures: system prompt (by section), tools, conversation history,
 * current prompt, and totals — so you can measure where tokens are spent.
 *
 * Dumps are stored **per-session** in memory (LRU-capped) and on disk
 * under `forensic-sessions/`.  Legacy `forensic-latest.json` is read
 * once for cold-start migration and never written to again.
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

const MAX_DUMPS_PER_RUN = 50;
const MAX_SESSIONS = 20;

// ─── Per-session in-memory store ───
const sessionRuns = new Map<string, ForensicRun>();
const sessionAccessOrder: string[] = []; // LRU tracking
let loadedFromDisk = false;

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

function loadAllSessionsFromDisk(): void {
  if (loadedFromDisk) {
    return;
  }
  loadedFromDisk = true;

  // Try loading per-session files first
  try {
    fs.mkdirSync(FORENSIC_SESSION_DIR, { recursive: true });
    const files = fs.readdirSync(FORENSIC_SESSION_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(FORENSIC_SESSION_DIR, f), "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && parsed.runId && Array.isArray(parsed.dumps)) {
          const sk =
            parsed.dumps[0]?.meta?.sessionKey ?? f.replace(/^forensic-/, "").replace(/\.json$/, "");
          sessionRuns.set(sk, parsed);
          touchSession(sk);
        }
      } catch {
        /* skip corrupt files */
      }
    }
  } catch {
    /* dir doesn't exist yet — fine */
  }

  // Cold-start migration: if no session files found, try legacy file
  if (sessionRuns.size === 0) {
    try {
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
      sessionRuns.set(sk, run);
      touchSession(sk);
      // Persist migrated data to new location
      persistSessionRun(sk);
    } catch {
      /* no legacy file — fresh install */
    }
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

export function getRunForSession(sk: string): ForensicRun | null {
  loadAllSessionsFromDisk();
  const run = sessionRuns.get(sk);
  if (run) {
    touchSession(sk);
    return run;
  }
  // Try loading from disk (may have been evicted from memory)
  try {
    const fp = sessionFilePath(sk);
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.runId) {
        sessionRuns.set(sk, parsed);
        touchSession(sk);
        return parsed;
      }
    }
  } catch {
    /* missing */
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

export function getLatestRun(): ForensicRun | null {
  loadAllSessionsFromDisk();
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

// ─── Shared append-or-replace logic, scoped to a session key ───
function upsertRun(sk: string, dump: any, runId: string): void {
  loadAllSessionsFromDisk();
  const existing = sessionRuns.get(sk);

  if (existing && existing.runId === runId) {
    if (existing.dumps.length < MAX_DUMPS_PER_RUN) {
      existing.dumps.push(dump);
    }
  } else {
    sessionRuns.set(sk, {
      runId,
      dumps: [dump],
      startedAt: dump.meta.timestamp,
    });
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
  loadAllSessionsFromDisk();
  const run = sessionRuns.get(sk);
  if (!run || run.runId !== runId) {
    return;
  }

  const numCalls = run.dumps.length;
  const responses: any[] = new Array(numCalls).fill(null);

  // Strategy: each dump[i] captures context.messages BEFORE call i.
  // So dump[i+1].conversation_history.messages contains the response to call i
  // as its last assistant message (captured before SDK redacts thinking).
  for (let i = 0; i < numCalls - 1; i++) {
    const nextDump = run.dumps[i + 1];
    const msgs = nextDump?.conversation_history?.messages;
    if (Array.isArray(msgs)) {
      // Find the last assistant message — that's the response to call i
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
        responses[numCalls - 1] = content;
      }
      break;
    }
  }

  // Filter out any null entries (shouldn't happen, but be safe)
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
