/**
 * Per-session tracking for the plugin runtime (design doc §3 M11): turn counter, the user's last request, the tool
 * record ring and the two futility signals (identical consecutive errors, steps without a new fact).
 * In memory and bounded: at most 50 sessions, the least recently touched is evicted.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { isAgentPrompt } from "openclaw/plugin-sdk/fork-prompt-envelope";
import { classifyEffect, isShellTool, writtenByCommand } from "./effect-class.js";
import { turnKindOf, type SessionContext } from "./situation.js";
import type { ToolRecordEntry, TurnKind } from "./types.js";

export type HookPayload = Record<string, unknown>;

const MAX_SESSIONS = 50;
const RING = 50;
const NEW_FACT_WINDOW = 5;
const FILE_WRITERS = new Set(["write", "edit", "multiedit", "notebookedit"]);
/** Paths the agent created or edited this session, newest last; enough for a long turn, bounded for a long session. */
const MAX_WRITTEN = 200;
/** Tool calls between their pre-tool and post-tool seams (normally one). */
const MAX_PENDING = 20;
/**
 * The agent's scratch folders: the workspace rule puts every task's scratch under `/tmp/jarvis/<task>/` (AGENTS.md, Red
 * Lines). Until 2026-10-25 nothing passed scratch folders in, so `scratch` was false on every step.
 */
export const DEFAULT_SCRATCH_DIRS: readonly string[] = ["/tmp/jarvis"];

interface SessionState {
  turnN: number;
  lastRequest: string | undefined;
  /** The owner's own last request; a turn an agent's prompt started (a long-job wake-up) continues it. */
  lastOwnerRequest: string | undefined;
  agentTurn: boolean;
  /** Who started the current turn (owner, agent, reflection); undefined before any prompt seam. */
  turnKind: TurnKind | undefined;
  toolRecord: ToolRecordEntry[];
  /** Absolute paths a successful tool call created this session: they did not exist before the call. */
  created: string[];
  /** Absolute paths a successful tool call changed this session that existed before it. */
  edited: string[];
  /** Per tool call (its tool_use_id), the paths it will write that did not exist at its pre-tool seam. */
  pending: Map<string, string[]>;
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

/** Move `p` to the newest end of `list`, keeping at most MAX_WRITTEN entries. */
function bump(list: string[], p: string): void {
  const at = list.indexOf(p);
  if (at >= 0) list.splice(at, 1);
  list.push(p);
  if (list.length > MAX_WRITTEN) list.splice(0, list.length - MAX_WRITTEN);
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
  private readonly scratchDirs: string[];

  constructor(
    o: {
      maxSessions?: number;
      now?: () => number;
      homeDir?: string;
      epoch?: string;
      scratchDirs?: readonly string[];
    } = {},
  ) {
    this.max = o.maxSessions ?? MAX_SESSIONS;
    this.scratchDirs = [...(o.scratchDirs ?? DEFAULT_SCRATCH_DIRS)];
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
        turnKind: undefined,
        toolRecord: [],
        created: [],
        edited: [],
        pending: new Map(),
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
    s.turnKind = turnKindOf(sessionKey, prompt);
    s.lastRequest = s.agentTurn ? s.lastOwnerRequest : undefined;
  }

  /** Remember the request (already stripped of metadata wrappers) for the later seams of this turn. */
  setRequest(sessionKey: string, request: string | null | undefined): void {
    const s = this.touch(sessionKey);
    s.lastRequest = request ?? undefined;
    if (!s.agentTurn) s.lastOwnerRequest = s.lastRequest;
  }

  /** The absolute paths a tool call writes, as its input shows (Write/Edit paths, shell redirects and the like). */
  private writeTargets(
    tool: string,
    input: Record<string, unknown> | undefined,
    cwdRaw: unknown,
  ): string[] {
    const cwd = typeof cwdRaw === "string" && cwdRaw ? cwdRaw : this.home;
    if (FILE_WRITERS.has(tool.toLowerCase())) {
      const p = input?.file_path ?? input?.path ?? input?.notebook_path;
      return typeof p === "string" ? [path.resolve(cwd, p)] : [];
    }
    const command = isShellTool(tool) && typeof input?.command === "string" ? input.command : null;
    return command !== null ? writtenByCommand(command, cwd, this.home) : [];
  }

  /**
   * Before a tool call: which of the paths it will write do not exist yet (2026-10-25). Only those become the agent's
   * own once the call succeeds; a file that was there before stays the owner's, however often the agent edits it.
   */
  notePreTool(sessionKey: string, hook: HookPayload): void {
    const s = this.touch(sessionKey);
    const tool = typeof hook.tool_name === "string" ? hook.tool_name : "unknown";
    const fresh = this.writeTargets(tool, asRecord(hook.tool_input), hook.cwd).filter((p) => {
      try {
        return !existsSync(p);
      } catch {
        return false;
      }
    });
    const callId = typeof hook.tool_use_id === "string" ? hook.tool_use_id : "";
    s.pending.set(callId, fresh);
    while (s.pending.size > MAX_PENDING) {
      const oldest = s.pending.keys().next().value;
      if (oldest === undefined) break;
      s.pending.delete(oldest);
    }
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
    const callId = typeof hook.tool_use_id === "string" ? hook.tool_use_id : "";
    const fresh = new Set(s.pending.get(callId) ?? []);
    s.pending.delete(callId);
    if (res.errorText === null) {
      for (const p of this.writeTargets(tool, input, hook.cwd)) {
        if (s.created.includes(p)) continue;
        bump(fresh.has(p) ? s.created : s.edited, p);
      }
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
      turnKind: s.turnKind ?? turnKindOf(sessionKey),
      createdPaths: s.created.length ? [...s.created] : undefined,
      editedPaths: s.edited.length ? [...s.edited] : undefined,
      scratchDirs: this.scratchDirs,
    };
  }
}
