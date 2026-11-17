/**
 * Bounded read of the newest turn of a Claude Code transcript (Phase D charter, item 3). A transcript can be
 * hundreds of MB; the stop hook only needs what happened after the last prompt, so at most the last `maxBytes` are
 * read, the first partial line is dropped, and nothing here ever throws.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { isAgentPrompt, stripPromptEnvelope } from "openclaw/plugin-sdk/fork-prompt-envelope";
import { evidenceLines } from "./claims.js";
import { classifyEffect, isShellTool } from "./effect-class.js";
import type { ObservedCall } from "./hypotheses.js";
import type { ToolRecordEntry } from "./types.js";

export interface TranscriptTail {
  toolRecord: ToolRecordEntry[];
  /** Lines of command output and job reports that can prove a claim. Code reads them; they never reach Jev. */
  evidence: string[];
  lastAssistantText: string | null;
  truncated: boolean;
  bytesRead: number;
}

const EVIDENCE_KEEP = 300;

const DEFAULT_MAX_BYTES = 262_144;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

const empty = (): TranscriptTail => ({
  toolRecord: [],
  evidence: [],
  lastAssistantText: null,
  truncated: false,
  bytesRead: 0,
});

function isPrompt(content: unknown): boolean {
  if (typeof content === "string") return content.trim() !== "";
  if (!Array.isArray(content)) return false;
  return (content as Block[]).some(
    (b) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
  );
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => (typeof b?.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * A user-role line the harness wrote, not a new request: a Stop-hook send-back, a background job's completion, a
 * subagent's result, a long job's wake-up or a restart report. The work so far is still this task's record. 2026-11-01:
 * each of these wiped the record, so the check after a send-back saw no tool call at all and a "done" a job had just
 * reported had nothing behind it.
 */
const HARNESS_LINE =
  /^\s*(?:Stop hook feedback:|<task-notification>|<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>|Base directory for this skill:|<system-reminder>)|⟦AGENT:(?:⏳|🧩)|\[System\] The gateway restart/u;
const JOB_FAILED = /<status>(?:failed|killed)|exit code [1-9]|status: failed|\bfailed\b.*\bexit\b/i;

function isHarnessLine(e: { isMeta?: boolean }, text: string): boolean {
  return e.isMeta === true || HARNESS_LINE.test(text);
}

/** A job or restart report is a finished action, so the judge reads it in the record as one. */
function reportEntry(text: string, ts: number): ToolRecordEntry {
  const restart = /\[System\] The gateway restart/.test(text);
  return {
    tool: restart ? "gateway-restart-report" : "background-job-report",
    argsDigest: createHash("sha1").update(text.slice(0, 400)).digest("hex").slice(0, 12),
    exit: JOB_FAILED.test(text) ? 1 : 0,
    filesWritten: [],
    effects: [restart ? "restart-own-system" : "other"],
    ts,
  };
}

/** The last `maxBytes` of a file as whole lines (the first, usually cut, line dropped). Throws on a read error. */
function readTailText(
  path: string,
  maxBytes: number,
): { text: string; start: number; got: number } {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(1, maxBytes));
    const len = size - start;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let from = 0;
    if (start > 0) {
      const nl = buf.indexOf(0x0a);
      from = nl === -1 ? got : nl + 1; // the first line is usually cut in half
    }
    return { text: buf.subarray(from, got).toString("utf8"), start, got };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/**
 * What the agent said it was about to do before the tool call `toolUseId`: its text since the last tool result or
 * prompt (the narration sentence every Tinker tool call carries). Personality's surprise compares the result with it
 * (2026-10-03: the field was never filled, 0 of 14,309 steps). Null when there is none; never throws.
 */
export function narrationBefore(
  path: string,
  toolUseId: string,
  o: { maxBytes?: number } = {},
): string | null {
  try {
    const { text } = readTailText(path, o.maxBytes ?? DEFAULT_MAX_BYTES);
    let said: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: { type?: string; message?: { content?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const content = e?.message?.content;
      if (e?.type === "user") {
        // A tool result or a new prompt closes what was said before it.
        if (
          isPrompt(content) ||
          (Array.isArray(content) && (content as Block[]).some((b) => b?.type === "tool_result"))
        ) {
          said = [];
        }
      } else if (e?.type === "assistant" && Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim())
            said.push(b.text.trim());
          else if (b?.type === "tool_use" && b.id === toolUseId) {
            const out = said.join(" ").trim();
            // Under the redactor's 400-character free-text limit, or Jev gets a length instead of the sentence.
            return out ? out.slice(-380) : null;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function readTranscriptTail(path: string, o: { maxBytes?: number } = {}): TranscriptTail {
  try {
    const { text, start, got } = readTailText(path, o.maxBytes ?? DEFAULT_MAX_BYTES);

    let record: ToolRecordEntry[] = [];
    let byId = new Map<string, ToolRecordEntry>();
    let lastText: string | null = null;
    let evidence: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: {
        type?: string;
        message?: { content?: unknown };
        timestamp?: string;
        isMeta?: boolean;
      };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const content = e?.message?.content;
      if (e?.type === "user") {
        if (isPrompt(content)) {
          const said = textOf(content);
          if (!isHarnessLine(e, said)) {
            record = [];
            byId = new Map();
            lastText = null;
            evidence = [];
            continue;
          }
          if (!/^\s*(?:Stop hook feedback:|Base directory|<system-reminder>)/.test(said)) {
            const at = e.timestamp ? Date.parse(e.timestamp) : 0;
            record.push(reportEntry(said, Number.isFinite(at) ? at : 0));
            if (!JOB_FAILED.test(said)) evidence.push(...evidenceLines(said));
          }
        }
        if (Array.isArray(content)) {
          for (const b of content as Block[]) {
            if (b?.type !== "tool_result" || !b.tool_use_id) continue;
            const entry = byId.get(b.tool_use_id);
            if (!entry) continue;
            entry.exit = b.is_error ? 1 : 0;
            if (!b.is_error && isShellTool(entry.tool))
              evidence.push(...evidenceLines(textOf(b.content)));
          }
        }
      } else if (e?.type === "assistant" && Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) lastText = b.text;
          else if (b?.type === "tool_use" && b.name) {
            const input =
              b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
            const cmd = typeof input.command === "string" ? input.command : null;
            const eff = classifyEffect(b.name, cmd, input).value;
            const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
            const entry: ToolRecordEntry = {
              tool: b.name,
              argsDigest: createHash("sha1")
                .update(JSON.stringify(input))
                .digest("hex")
                .slice(0, 12),
              exit: null,
              filesWritten: [],
              effects: eff ? [eff] : [],
              ts: Number.isFinite(ts) ? ts : 0,
            };
            record.push(entry);
            if (b.id) byId.set(b.id, entry);
          }
        }
      }
    }
    return {
      toolRecord: record,
      evidence: evidence.slice(-EVIDENCE_KEEP),
      lastAssistantText: lastText,
      truncated: start > 0,
      bytesRead: got,
    };
  } catch {
    return empty();
  }
}

/** One tool call as a person reads it: what the agent wrote just before it and what it ran (cut). */
export interface StepSeen {
  id?: string;
  said: string;
  ran: string;
}

const STEP_KEEP = 40;

/** A call as text: its tool and its main argument, cut to `max`. The judges' lists keep it whole (`judgedStep`). */
function ranText(name: string, input: Record<string, unknown>, max = 400): string {
  const pick = ["command", "file_path", "path", "pattern", "url", "query"].find(
    (k) => typeof input[k] === "string",
  );
  const what = pick ? (input[pick] as string) : JSON.stringify(input);
  return `${name} ${what}`.slice(0, max);
}

/**
 * The tool calls before `toolUseId` (all of the tail when it is not given or not found), oldest first, each with the
 * text the agent wrote before it. A prompt does not reset the list: after a long-job wake-up the earlier steps are the
 * context. The WOULD HAVE explainer reads it (2026-10-05). Never throws.
 */
export function stepsBefore(
  path: string,
  toolUseId?: string,
  o: { maxBytes?: number } = {},
): StepSeen[] {
  try {
    const { text } = readTailText(path, o.maxBytes ?? DEFAULT_MAX_BYTES);
    const steps: StepSeen[] = [];
    let said: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: { type?: string; message?: { content?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const content = e?.message?.content;
      if (e?.type === "user") {
        said = [];
      } else if (e?.type === "assistant" && Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
            said.push(b.text.trim());
          } else if (b?.type === "tool_use" && b.name) {
            if (toolUseId && b.id === toolUseId) return steps;
            const input =
              b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
            steps.push({ id: b.id, said: said.join(" ").slice(-300), ran: ranText(b.name, input) });
            if (steps.length > STEP_KEEP) steps.shift();
            said = [];
          }
        }
      }
    }
    return steps;
  } catch {
    return [];
  }
}

/** An html card or a code fence in a reply: layout, not what was said. */
const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const clipEnd = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/**
 * The conversation before the current prompt, oldest first, as `owner: …` / `job: …` / `agent: …` lines: the last
 * `turns` prompts and the reply that closed each (its last text block). The ambiguity screen reads it, because a short
 * follow-up ("carry on", "finished yet?") is plain only next to what it follows (2026-11-13: 56 of 61 reviewed flags were
 * noise, most of them on such follow-ups). Never throws; empty when there is nothing to read.
 */
export function recentExchange(
  path: string,
  o: {
    turns?: number;
    ownerMax?: number;
    agentMax?: number;
    totalMax?: number;
    maxBytes?: number;
    /** The prompt being screened (raw): when the transcript already ends with it, unanswered, it is left out. */
    skipLastAsk?: string;
  } = {},
): string {
  try {
    const want = o.turns ?? 4;
    // A long turn can write megabytes of tool output after the owner's last prompt (2026-11-13: 1.9 MB in one turn,
    // so a 256 KB tail held no prompt and the screen saw no conversation). Widen until enough prompts are in view.
    const steps = o.maxBytes ? [o.maxBytes] : EXCHANGE_TAILS;
    let turns: ExchangeTurn[] = [];
    for (const bytes of steps) {
      const { text, start } = readTailText(path, bytes);
      turns = exchangeTurns(text);
      if (turns.length > want || start === 0) break;
    }
    const last = turns[turns.length - 1];
    if (last && !last.reply && o.skipLastAsk) {
      const skip = stripPromptEnvelope(o.skipLastAsk).replace(/\s+/g, " ").trim();
      if (skip && last.ask === skip) turns.pop();
    }
    const keep = turns.slice(-want);
    const lines: string[] = [];
    for (const t of keep) {
      lines.push(`${t.who}: ${clipEnd(t.ask, o.ownerMax ?? 400)}`);
      if (t.reply) lines.push(`agent: ${clipEnd(t.reply, o.agentMax ?? 700)}`);
    }
    let out = lines.join("\n");
    const total = o.totalMax ?? 3500;
    if (out.length > total) out = `…${out.slice(out.length - total + 1)}`;
    return out;
  } catch {
    return "";
  }
}

/** How far back `recentExchange` reads, step by step: 256 KB, 4 MB, 16 MB. */
const EXCHANGE_TAILS: readonly number[] = [DEFAULT_MAX_BYTES, 4 * 1024 * 1024, 16 * 1024 * 1024];

interface ExchangeTurn {
  who: string;
  ask: string;
  reply: string;
}

/** The prompts in a transcript text and the last thing said after each. Tool output is never parsed. */
function exchangeTurns(text: string): ExchangeTurn[] {
  const turns: ExchangeTurn[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.includes('"tool_result"')) continue;
    const user = line.includes('"type":"user"');
    if (!user && !(line.includes('"type":"assistant"') && line.includes('"type":"text"'))) continue;
    let e: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e?.message?.content;
    if (e?.type === "user" && isPrompt(content)) {
      const raw = textOf(content);
      if (isHarnessLine(e, raw)) continue;
      const ask = stripPromptEnvelope(raw).replace(/\s+/g, " ").trim();
      if (!ask) continue;
      turns.push({
        who: /^\s*⟦AGENT:/u.test(ask) || isAgentPrompt(raw) ? "job" : "owner",
        ask,
        reply: "",
      });
    } else if (e?.type === "assistant" && Array.isArray(content) && turns.length > 0) {
      for (const b of content as Block[]) {
        if (b?.type !== "text" || typeof b.text !== "string") continue;
        const said = b.text.replace(FENCE_RE, " ").replace(/\s+/g, " ").trim();
        if (said) (turns[turns.length - 1] as ExchangeTurn).reply = said;
      }
    }
  }
  return turns;
}

/**
 * What the agent wrote and ran since `sinceTs` (ms): its text blocks joined (the last `saidMax` characters) and the
 * calls it made, oldest first. The ambiguity guard reads its readings and sources from the first and checks a cited
 * file against the second (2026-11-13). Never throws.
 */
export function turnSince(
  path: string,
  sinceTs: number,
  o: { saidMax?: number; ranMax?: number; maxBytes?: number } = {},
): { said: string; ran: string[] } {
  try {
    const { text } = readTailText(path, o.maxBytes ?? DEFAULT_MAX_BYTES);
    const said: string[] = [];
    const ran: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: { type?: string; timestamp?: string; message?: { content?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const content = e?.message?.content;
      if (e?.type !== "assistant" || !Array.isArray(content)) continue;
      const at = e.timestamp ? Date.parse(e.timestamp) : 0;
      if (!(at >= sinceTs)) continue;
      for (const b of content as Block[]) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          said.push(b.text.replace(FENCE_RE, " ").trim());
        } else if (b?.type === "tool_use" && b.name) {
          const input =
            b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
          ran.push(ranText(b.name, input, 600));
        }
      }
    }
    const joined = said.join("\n");
    const max = o.saidMax ?? 4000;
    return {
      said: joined.length > max ? joined.slice(joined.length - max) : joined,
      ran: ran.slice(-(o.ranMax ?? 60)),
    };
  } catch {
    return { said: "", ran: [] };
  }
}

/** A tool call that came after a moment, and whether it failed. */
export interface StepAfter {
  ran: string;
  failed: boolean;
  /**
   * A PreToolUse hook refused the call, so it never ran (2026-11-13). Only a Claude Code transcript shows it
   * (`stepsAfter`). The judges read a failed call as one that ran and broke: from 10-28 to 11-13 they called 6 of the 55
   * passes a hook had refused "missed", for effects that never happened (Fractal guard 3, AEGIS 2, a session guard 1).
   */
  refused?: true;
  /** A refused call's tool_use id, so the pass review can mark its passed step. No judge reads it. */
  id?: string;
  /** What the call returned. Only a native run's record has it (`runRecordOf`). */
  result?: string;
}

/**
 * How Claude Code reports a call that a PreToolUse hook refused: the call never ran. Every hook here writes it this way:
 * AEGIS ("…hook error: AMYGDALA hard rule (AEGIS) …"), the Fractal guard, the session guards and Jev's own holds.
 */
const HOOK_REFUSED = /^PreToolUse:\S+ hook error:/;

/** The text a tool_result starts with: the string itself, or its first text block. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).find((b) => typeof b?.text === "string")?.text ?? "";
}

/**
 * The tool calls the transcript shows after time `ts` (ms), oldest first, at most `max`, each with whether its result was
 * an error. The usefulness review reads it to see what the agent did after a flag (2026-10-06). Never throws.
 */
export function stepsAfter(
  path: string,
  ts: number,
  o: { maxBytes?: number; max?: number } = {},
): StepAfter[] {
  try {
    const { text } = readTailText(path, o.maxBytes ?? DEFAULT_MAX_BYTES);
    const out: (StepAfter & { id?: string })[] = [];
    const byId = new Map<string, StepAfter>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: { type?: string; timestamp?: string; message?: { content?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const content = e?.message?.content;
      if (e?.type === "user" && Array.isArray(content)) {
        for (const b of content as Block[]) {
          const id = b?.type === "tool_result" ? b.tool_use_id : undefined;
          const s = id ? byId.get(id) : undefined;
          if (s && b.is_error) {
            s.failed = true;
            if (id && HOOK_REFUSED.test(resultText(b.content))) {
              s.refused = true;
              s.id = id;
            }
          }
        }
      } else if (e?.type === "assistant" && Array.isArray(content)) {
        const at = e.timestamp ? Date.parse(e.timestamp) : 0;
        if (!(at > ts)) continue;
        for (const b of content as Block[]) {
          if (b?.type !== "tool_use" || !b.name) continue;
          const input =
            b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
          // Whole: the judge redacts it, then keeps its two ends (review.ts `judgedStep`, 2026-11-05).
          const s: StepAfter = { ran: ranText(b.name, input, Infinity), failed: false };
          out.push(s);
          if (b.id) byId.set(b.id, s);
        }
      }
    }
    return out.slice(0, o.max ?? 8);
  } catch {
    return [];
  }
}

/** What a native run's messages say: the prompt that started it, its calls and the host of its model. */
export interface RunRecord {
  prompt?: string;
  provider?: string;
  steps: (StepAfter & { at: number })[];
}

/** Of a long result, this much from each end: far more than a judge sees, so redaction meets a secret whole before the cut. */
const RESULT_END_KEEP = 2000;

interface RunMessage {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  provider?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
}

/**
 * The judges' view of a native run (2026-11-02). These runs have no prompt seam and no transcript the readers above can
 * parse, so every review went out with no orders and no calls: 0 of 5,843 steps stored since 10-28 had a request, and a
 * flag could not show what came after it (1 of 166 judged useful, 110 of 696 on Claude Code). `agent_end` carries the
 * session's messages; this keeps the last prompt and what came after it. Never throws.
 */
export function runRecordOf(messages: unknown[]): RunRecord {
  try {
    const list = messages as (RunMessage | null)[];
    let start = list.length - 1;
    while (start >= 0 && !(list[start]?.role === "user" && isPrompt(list[start]?.content))) start--;
    if (start < 0) return { steps: [] };
    const out: RunRecord = {
      prompt: stripPromptEnvelope(textOf(list[start]?.content)),
      steps: [],
    };
    const byId = new Map<string, RunRecord["steps"][number]>();
    for (const m of list.slice(start + 1)) {
      if (m?.role === "assistant" && Array.isArray(m.content)) {
        if (typeof m.provider === "string") out.provider = m.provider;
        for (const b of m.content as (Block & { arguments?: unknown })[]) {
          if (b?.type !== "toolCall" || !b.name) continue;
          const input =
            b.arguments && typeof b.arguments === "object"
              ? (b.arguments as Record<string, unknown>)
              : {};
          const step = {
            ran: ranText(b.name, input, Infinity),
            failed: false,
            at: typeof m.timestamp === "number" ? m.timestamp : 0,
          };
          out.steps.push(step);
          if (b.id) byId.set(b.id, step);
        }
      } else if (m?.role === "toolResult") {
        const step = byId.get(String(m.toolCallId));
        if (!step) continue;
        step.failed = m.isError === true;
        const text = textOf(m.content);
        if (text.length > RESULT_END_KEEP * 2)
          step.result = `${text.slice(0, RESULT_END_KEEP)}\n…\n${text.slice(-RESULT_END_KEEP)}`;
        else if (text) step.result = text;
      }
    }
    return out;
  } catch {
    return { steps: [] };
  }
}

/**
 * The last turn as the fact check reads it (2026-11-14): the owner's own words (the prompt without its envelope) and
 * each tool call with its input and output. Bounded: the last `maxBytes` of the file, each output cut to `outputMax`
 * characters. The owner's words alone, not the envelope, because the envelope carries memory snippets that name half
 * the world. Nothing here throws.
 */
export function lastTurnCalls(
  path: string,
  o: { maxBytes?: number; outputMax?: number } = {},
): { owner: string; agent: boolean; calls: ObservedCall[] } {
  try {
    const { text } = readTailText(path, o.maxBytes ?? 1_048_576);
    const outputMax = o.outputMax ?? 20_000;
    let owner = "";
    let agent = false;
    let calls: ObservedCall[] = [];
    let byId = new Map<string, ObservedCall>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: { type?: string; message?: { content?: unknown }; isMeta?: boolean };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const content = e?.message?.content;
      if (e?.type === "user") {
        if (isPrompt(content)) {
          const said = textOf(content);
          if (!isHarnessLine(e, said)) {
            owner = stripPromptEnvelope(said);
            agent = isAgentPrompt(said);
            calls = [];
            byId = new Map();
            continue;
          }
        }
        if (Array.isArray(content)) {
          for (const b of content as Block[]) {
            if (b?.type !== "tool_result" || !b.tool_use_id) continue;
            const c = byId.get(b.tool_use_id);
            if (c) c.output = textOf(b.content).slice(0, outputMax);
          }
        }
      } else if (e?.type === "assistant" && Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b?.type !== "tool_use" || !b.name) continue;
          const input =
            b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
          const call: ObservedCall = {
            tool: b.name,
            input: typeof input.command === "string" ? input.command : JSON.stringify(input),
            output: "",
          };
          calls.push(call);
          if (b.id) byId.set(b.id, call);
        }
      }
    }
    return { owner, agent, calls };
  } catch {
    return { owner: "", agent: false, calls: [] };
  }
}

/** A tool call that a background agent of the chat made: which agent, and what it was told to do (2026-11-16). */
export interface AgentStep {
  /** Its transcript's file name without `.jsonl` (`agent-<hex>`): one per agent, also when two share a label. */
  id: string;
  /** The agent's label (`description` in its `.meta.json`), else its file name. */
  agent: string;
  /** Its first prompt, without a workflow harness's lead-in or a fork's boilerplate; empty when none can be read. */
  task: string;
}

/** A background agent's transcript longer than this is not read. The longest of the 331 written since 10-28 had 10 MB. */
const AGENT_FILE_MAX = 32 * 1_048_576;

/**
 * What a workflow harness puts before a computed task. The task follows it with every line indented by two spaces; the
 * indent stays, as the harness's mark that no line of it is a frame of its own.
 */
const HARNESS_LEAD = /^\[Workflow harness[^\]\n]*\][\s\S]*?The computed task text follows:\n/;

/** The fixed rules a fork's first prompt opens with (about 900 characters); its own task follows ("Your directive: …"). */
const FORK_LEAD = /^<fork-boilerplate>[\s\S]*?<\/fork-boilerplate>\s*/;

/**
 * Which of `ids` a background agent of this chat made (2026-11-16). Claude Code writes every agent that a chat starts (a
 * workflow agent, a Task agent) to a transcript of its own under `<chat transcript>/subagents/`. Its tool calls reach the
 * hooks under the chat's session, so Jev files them under the turn the chat is in. On 11-15 a workflow the owner ordered
 * at 19:29 wrote its code and tests at 21:49 and 22:00, inside turns that a PDF Apply had woken, and the pass judge read
 * the Apply's "no other files" as their brief: all three steps "missed". Of the 15,203 calls the 331 agent transcripts
 * since 10-28 hold, none is in its chat's own transcript. A fork's transcript repeats the chat's call that started it
 * (its meta's `toolUseId`; 5 of 57), so that call stays the chat's. Only agent files written since `since` are read.
 * Never throws.
 */
export function agentSteps(
  transcriptPath: string,
  ids: readonly string[],
  since: number,
): Map<string, AgentStep> {
  const out = new Map<string, AgentStep>();
  const want = [...new Set(ids.filter(Boolean))];
  if (want.length === 0 || !transcriptPath.endsWith(".jsonl")) {
    return out;
  }
  const dir = join(transcriptPath.slice(0, -".jsonl".length), "subagents");
  let files: string[];
  try {
    files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
      /(?:^|\/)agent-[^/]+\.jsonl$/.test(f),
    );
  } catch {
    return out;
  }
  for (const rel of files) {
    if (out.size === want.length) {
      break;
    }
    const file = join(dir, rel);
    try {
      const st = statSync(file);
      if (st.mtimeMs < since - 1000 || st.size > AGENT_FILE_MAX) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      const meta = agentMeta(file);
      const hits = want.filter(
        (id) => !out.has(id) && id !== meta.launch && text.includes(`"id":"${id}"`),
      );
      if (hits.length === 0) {
        continue;
      }
      const fileId = basename(file, ".jsonl");
      const step = { id: fileId, agent: meta.label || fileId, task: agentTask(text) };
      for (const id of hits) {
        out.set(id, step);
      }
    } catch {
      continue;
    }
  }
  return out;
}

/** An agent's `.meta.json`: its label and, for an agent the chat started with a tool call, that call's id. */
function agentMeta(file: string): { label: string; launch?: string } {
  try {
    const m = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")) as {
      description?: unknown;
      toolUseId?: unknown;
    };
    return {
      label: typeof m.description === "string" ? m.description.trim() : "",
      ...(typeof m.toolUseId === "string" ? { launch: m.toolUseId } : {}),
    };
  } catch {
    return { label: "" };
  }
}

/**
 * The agent's first prompt. A fork's file opens with a pointer to the chat's context and the chat's call that started
 * it; its first user line holds that call's empty result and the fork's own prompt.
 */
function agentTask(text: string): string {
  for (const line of text.split("\n", 8)) {
    let e: { type?: string; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== "user") {
      continue;
    }
    const content = e.message?.content;
    return isPrompt(content)
      ? textOf(content).replace(HARNESS_LEAD, "").replace(FORK_LEAD, "").trim()
      : "";
  }
  return "";
}
