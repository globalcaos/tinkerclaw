/**
 * Per-session tracking for the plugin runtime (design doc §3 M11): turn counter, the user's last request, the tool
 * record ring and the two futility signals (identical consecutive errors, steps without a new fact).
 * In memory and bounded: at most 50 sessions, the least recently touched is evicted.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { classifyEffect, isShellTool } from "./effect-class.js";
import { isAgentPrompt, type SessionContext } from "./situation.js";
import type { ToolRecordEntry } from "./types.js";

export type HookPayload = Record<string, unknown>;

const MAX_SESSIONS = 50;
const RING = 50;
const NEW_FACT_WINDOW = 5;
const FILE_WRITERS = new Set(["write", "edit", "multiedit", "notebookedit"]);

interface SessionState {
  turnN: number;
  lastRequest: string | undefined;
  /** The owner's own last request; a turn an agent's prompt started (a long-job wake-up) continues it. */
  lastOwnerRequest: string | undefined;
  agentTurn: boolean;
  toolRecord: ToolRecordEntry[];
  results: number;
  repeatedErrors: number;
  lastErrorText: string | null;
  stepsSinceNewFact: number;
  recentDigests: string[];
}

function digest(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function toText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

function normalizeError(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Exit status, error text (null when the result is not an error) and a digest of a `tool_response`. */
export function analyseResult(resp: unknown): {
  exit: number | null;
  errorText: string | null;
  digest: string;
  lines: number;
} {
  const text = toText(resp).slice(0, 4000);
  const r = asRecord(resp);
  let exit: number | null = null;
  let errorText: string | null = null;
  if (r) {
    const code = r.exit_code ?? r.exitCode ?? r.returncode;
    if (typeof code === "number" && Number.isFinite(code)) exit = code;
    const err = typeof r.error === "string" ? r.error : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    const isError = r.is_error === true || (exit !== null && exit !== 0) || err !== "";
    if (isError) errorText = normalizeError(err || stderr || stdout || text);
  }
  // Lines of the output proper: stdout when the result is a shell record, else the whole text.
  const out = r && typeof r.stdout === "string" ? r.stdout : toText(resp);
  const lines = out.split("\n").filter((l) => l.trim() !== "").length;
  return { exit, errorText, digest: digest(text), lines };
}

export class SessionTracker {
  private readonly sessions = new Map<string, SessionState>();
  private readonly max: number;
  private readonly now: () => number;
  private readonly home: string;
  private readonly epoch: string | undefined;

  constructor(
    o: { maxSessions?: number; now?: () => number; homeDir?: string; epoch?: string } = {},
  ) {
    this.max = o.maxSessions ?? MAX_SESSIONS;
    this.epoch = o.epoch;
    this.now = o.now ?? Date.now;
    this.home = o.homeDir ?? homedir();
  }

  size(): number {
    return this.sessions.size;
  }

  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  private touch(sessionKey: string): SessionState {
    let s = this.sessions.get(sessionKey);
    if (s) {
      // Re-insert so Map order is least recently touched first.
      this.sessions.delete(sessionKey);
    } else {
      s = {
        turnN: 0,
        lastRequest: undefined,
        lastOwnerRequest: undefined,
        agentTurn: false,
        toolRecord: [],
        results: 0,
        repeatedErrors: 0,
        lastErrorText: null,
        stepsSinceNewFact: 0,
        recentDigests: [],
      };
    }
    this.sessions.set(sessionKey, s);
    if (this.sessions.size > this.max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    return s;
  }

  /**
   * `${sessionKey}#${epoch}.${n}` (or `#${n}` without an epoch); n is 0 before any prompt seam. The epoch is the
   * process's start, so a tab's turns stay apart across gateway restarts (2026-10-02).
   */
  turnId(sessionKey: string): string {
    const n = this.touch(sessionKey).turnN;
    return this.epoch ? `${sessionKey}#${this.epoch}.${n}` : `${sessionKey}#${n}`;
  }

  /**
   * A prompt seam starts a new turn. The owner's prompt clears the request, so the situation builder derives it from
   * the prompt. An agent's prompt (`⟦AGENT:…⟧`, a long-job wake-up) continues the owner's last request when there is
   * one (2026-10-05: 405 wake-ups in a day were read as the request).
   */
  notePrompt(sessionKey: string, prompt?: string): void {
    const s = this.touch(sessionKey);
    s.turnN += 1;
    s.agentTurn = isAgentPrompt(prompt);
    s.lastRequest = s.agentTurn ? s.lastOwnerRequest : undefined;
  }

  /** Remember the request (already stripped of metadata wrappers) for the later seams of this turn. */
  setRequest(sessionKey: string, request: string | null | undefined): void {
    const s = this.touch(sessionKey);
    s.lastRequest = request ?? undefined;
    if (!s.agentTurn) s.lastOwnerRequest = s.lastRequest;
  }

  /** Append one finished tool call (a `post-tool` payload) and update the futility signals. */
  recordToolResult(sessionKey: string, hook: HookPayload): void {
    const s = this.touch(sessionKey);
    const tool = typeof hook.tool_name === "string" ? hook.tool_name : "unknown";
    const input = asRecord(hook.tool_input);
    const res = analyseResult(hook.tool_response);

    const command = isShellTool(tool) && typeof input?.command === "string" ? input.command : null;
    const effect = classifyEffect(tool, command, input);
    const filesWritten: string[] = [];
    if (FILE_WRITERS.has(tool.toLowerCase())) {
      const p = input?.file_path ?? input?.path ?? input?.notebook_path;
      if (typeof p === "string") filesWritten.push(p);
    }
    s.toolRecord.push({
      tool,
      argsDigest: digest(toText(input ?? {}).slice(0, 2000)),
      exit: res.exit,
      filesWritten,
      effects: effect.value ? [effect.value] : [],
      ts: this.now(),
      outputLines: res.lines,
      failed: res.errorText !== null,
    });
    if (s.toolRecord.length > RING) s.toolRecord.splice(0, s.toolRecord.length - RING);

    if (res.errorText !== null) {
      s.repeatedErrors = res.errorText === s.lastErrorText ? s.repeatedErrors + 1 : 1;
      s.lastErrorText = res.errorText;
    } else {
      s.repeatedErrors = 0;
      s.lastErrorText = null;
    }

    const isNew = !s.recentDigests.includes(res.digest);
    s.stepsSinceNewFact = isNew ? 0 : s.stepsSinceNewFact + 1;
    s.recentDigests.push(res.digest);
    if (s.recentDigests.length > NEW_FACT_WINDOW) s.recentDigests.shift();
    s.results += 1;
  }

  /** Base `SessionContext` for `decide`. Signals that were never observed stay undefined (origin "missing"), not 0. */
  sessionContext(sessionKey: string, cwd?: string): SessionContext {
    const s = this.touch(sessionKey);
    return {
      workspaceRoot: cwd ?? this.home,
      homeDir: this.home,
      request: s.lastRequest,
      toolRecord: s.toolRecord.length ? [...s.toolRecord] : undefined,
      repeatedErrors: s.results > 0 ? s.repeatedErrors : undefined,
      stepsSinceNewFact: s.results > 0 ? s.stepsSinceNewFact : undefined,
    };
  }
}
