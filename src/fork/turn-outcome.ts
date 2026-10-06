/**
 * FORK 2026-09-29 — typed turn outcomes.
 *
 * Plan: jarvis-icu docs/superpowers/plans/2026-09-29-chat-usage-chips-and-typed-outcomes.md.
 * Turns any failed assistant message into a `TurnOutcome` so the gateway
 * classifies ONCE and the UI renders from the typed field instead of
 * regexing the model's prose. Structured signals only: stop reasons, error
 * fields, `__ERR_ENV__` envelopes, and first-line gateway wording on flagged
 * or short unflagged rows — never mid-prose keywords.
 *
 * Pure by contract: no fs, no gateway imports. The runtime imports are the
 * existing reset parser (src/agents/rate-limit-reset.ts) and the pure
 * usage-window reader (src/shared/usage-window.ts); envelope types are
 * type-only. Every entry point is total over `unknown` and never throws.
 *
 * FORK 2026-10-05 — a rate or usage limit whose window resets in hours or days
 * (weekly, rolling 5-hour, Claude's "session" limit) is NOT recoverable: the
 * client ladder tops out at 15 minutes, so retrying only re-sends the prompt
 * into the same wall (169 copies of one prompt on 2026-10-03).
 *
 * Deliberately NOT reused here: `classifyRawErrorMessage` / `rateLimitDetail`
 * from error-envelope.ts. Their taxonomy serves envelope cards and diverges
 * from this table (e.g. "usage limit" → `rate_limited` there, `quota` here per
 * the plan), and `detail` is contract-fixed to the raw text. One of their
 * hard-won ordering guards IS carried over: the Anthropic 529 copy contains
 * "usage limit" inside its negation and must classify as overload.
 */

import { resolveRetryAfterSeconds } from "../agents/rate-limit-reset.js";
import { isLongUsageWindow } from "../shared/usage-window.js";
import type { ErrorCategory, ErrorEnvelope } from "./error-envelope.js";

/** A rate or usage limit no retry can outlast (see the header): the window, not the kind, decides. */
function isLongLimit(kind: TurnOutcomeKind, raw: string): boolean {
  return (kind === "rate_limit" || kind === "quota") && isLongUsageWindow(raw);
}

export type TurnOutcomeKind =
  | "rate_limit"
  | "quota"
  | "overload"
  | "network"
  | "timeout"
  | "auth"
  | "billing"
  | "context_overflow"
  | "refusal"
  | "aborted"
  | "empty"
  | "error";

export type TurnOutcomeSource =
  | "stop-reason"
  | "envelope"
  | "cli"
  | "injected"
  | "prompt-error"
  | "empty";

export interface TurnOutcome {
  kind: TurnOutcomeKind;
  /** true → orange + client retry ladder (§5.8j); false → red / grey. */
  recoverable: boolean;
  /** Short: "Rate limited", "Usage limit reached", … */
  headline: string;
  /** Raw provider / CLI / gateway text, ≤ 2000 chars. */
  detail?: string;
  /** Seconds, when the text states a reset (existing reset parsers). */
  retryAfter?: number;
  source: TurnOutcomeSource;
  /** Present when it came from `__ERR_ENV__` (icon, explanation, actions). */
  envelope?: ErrorEnvelope;
}

export const ERROR_ENVELOPE_MARKER = "__ERR_ENV__:";

const KINDS: ReadonlySet<string> = new Set([
  "rate_limit",
  "quota",
  "overload",
  "network",
  "timeout",
  "auth",
  "billing",
  "context_overflow",
  "refusal",
  "aborted",
  "empty",
  "error",
]);

const SOURCES: ReadonlySet<string> = new Set([
  "stop-reason",
  "envelope",
  "cli",
  "injected",
  "prompt-error",
  "empty",
]);

const RECOVERABLE: Record<TurnOutcomeKind, boolean> = {
  rate_limit: true,
  quota: true,
  overload: true,
  network: true,
  timeout: true,
  auth: false,
  billing: false,
  context_overflow: false,
  refusal: false,
  aborted: false,
  empty: false,
  error: false,
};

const HEADLINES: Record<TurnOutcomeKind, string> = {
  rate_limit: "Rate limited",
  quota: "Usage limit reached",
  overload: "Provider overloaded",
  network: "Network error",
  timeout: "Timed out",
  auth: "Authentication failed",
  billing: "Billing problem",
  context_overflow: "Prompt too long for the model",
  refusal: "The model refused to answer",
  aborted: "Stopped",
  empty: "No answer — the model returned nothing",
  error: "The turn failed",
};

const MAX_DETAIL_CHARS = 2000;

function truncateDetail(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) {
    return undefined;
  }
  return t.length > MAX_DETAIL_CHARS ? `${t.slice(0, MAX_DETAIL_CHARS - 1)}…` : t;
}

/**
 * The plan's mapping table, in the plan's order. First match wins. The
 * refusal row is word-bounded so "connection refused" / ECONNREFUSED cannot
 * land on it (they belong to the network row).
 */
const TEXT_RULES: ReadonlyArray<{ kind: TurnOutcomeKind; re: RegExp }> = [
  {
    kind: "refusal",
    re: /safeguard|\brefusal\b|(?<!connection )\brefus(?:ed|es|ing)\b|\bflagged\b|content (?:filter|policy)/i,
  },
  { kind: "aborted", re: /operation was aborted|\baborted\b/i },
  {
    kind: "quota",
    re: /usage limit|exceeded (?:your )?(?:current )?quota|quota exceeded|insufficient[_ ]quota/i,
  },
  { kind: "billing", re: /credit balance|\b402\b|payment/i },
  { kind: "rate_limit", re: /\b429\b|rate.?limit|\btpm\b|\brpm\b|too many requests/i },
  {
    kind: "overload",
    re: /overload|\b529\b|at capacity|capacity|high demand|\b50[23]\b|temporarily unavailable|internal error during token generation/i,
  },
  {
    kind: "network",
    re: /fetch failed|connection (?:error|refused)|\bterminated\b|econnreset|econnrefused|socket|network error/i,
  },
  { kind: "timeout", re: /idle timeout|timed?[\s-]?out|timeout/i },
  {
    kind: "auth",
    re: /\b401\b|\b403\b|\bauth(?:entication|orization)?\b|unauthorized|forbidden|requires you to complete/i,
  },
  {
    kind: "context_overflow",
    re: /maximum prompt length|context length|prompt (?:is )?too long|context window/i,
  },
];

/**
 * Anthropic 529 copy ("Server is temporarily limiting requests (not your
 * usage limit) · Rate limited") contains "usage limit" inside its NEGATION
 * and would hit the quota row first. Same ordering guard as
 * `classifyRawErrorMessage` in error-envelope.ts.
 */
const OVERLOAD_NEGATION_RE = /not your usage limit|server is temporarily limiting/i;

/** Classify raw error text per the plan table. Never null, never throws. */
export function classifyErrorText(raw: string, opts?: { source?: TurnOutcomeSource }): TurnOutcome {
  const source: TurnOutcomeSource =
    opts?.source && SOURCES.has(opts.source) ? opts.source : "injected";
  let text = "";
  try {
    text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  } catch {
    text = "";
  }
  const trimmed = text.trim();
  let kind: TurnOutcomeKind = "error";
  if (trimmed) {
    if (OVERLOAD_NEGATION_RE.test(trimmed)) {
      kind = "overload";
    } else {
      for (const rule of TEXT_RULES) {
        if (rule.re.test(trimmed)) {
          kind = rule.kind;
          break;
        }
      }
    }
  }
  const recoverable = RECOVERABLE[kind] && !isLongLimit(kind, trimmed);
  let retryAfter: number | undefined;
  if (recoverable && trimmed) {
    try {
      retryAfter = resolveRetryAfterSeconds(trimmed, Date.now());
    } catch {
      retryAfter = undefined;
    }
  }
  const detail = truncateDetail(trimmed);
  return {
    kind,
    recoverable,
    headline: HEADLINES[kind],
    ...(detail !== undefined ? { detail } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    source,
  };
}

/**
 * End index (exclusive) of the JSON object starting at `start` (a `{`),
 * respecting string literals and escapes. -1 when unbalanced.
 */
function scanJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/**
 * Split text around a `__ERR_ENV__:` envelope. `before` keeps any partial
 * answer (or `[system]` / `Model set to …` preamble) that streamed before the
 * marker; `after` is anything past the JSON. No marker, or an unparseable
 * payload, yields `envelope: null` — never a throw.
 */
export function splitErrorEnvelope(text: string): {
  before: string;
  envelope: ErrorEnvelope | null;
  after: string;
} {
  if (typeof text !== "string" || text.length === 0) {
    return { before: typeof text === "string" ? text : "", envelope: null, after: "" };
  }
  const idx = text.indexOf(ERROR_ENVELOPE_MARKER);
  if (idx === -1) {
    return { before: text, envelope: null, after: "" };
  }
  const before = text.slice(0, idx).replace(/\s+$/, "");
  const payloadStart = idx + ERROR_ENVELOPE_MARKER.length;
  const braceStart = text.indexOf("{", payloadStart);
  if (braceStart === -1 || text.slice(payloadStart, braceStart).trim() !== "") {
    return { before, envelope: null, after: text.slice(payloadStart).replace(/^\s+/, "") };
  }
  const end = scanJsonObjectEnd(text, braceStart);
  if (end === -1) {
    return { before, envelope: null, after: text.slice(payloadStart).replace(/^\s+/, "") };
  }
  let envelope: ErrorEnvelope | null = null;
  try {
    const parsed: unknown = JSON.parse(text.slice(braceStart, end));
    if (parsed && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === "error") {
      envelope = parsed as ErrorEnvelope;
    }
  } catch {
    envelope = null;
  }
  return { before, envelope, after: text.slice(end).replace(/^\s+/, "") };
}

/**
 * ErrorCategory → TurnOutcomeKind. The envelope's own `fatal`, headline and
 * raw are authoritative for envelope-sourced outcomes; `interrupted` renders
 * as the grey stopped bubble, and `busy`/`tool`/`compaction`/`provider_error`
 * have no kind of their own (recoverability still comes from `fatal`).
 */
const CATEGORY_TO_KIND: Record<ErrorCategory, TurnOutcomeKind> = {
  auth: "auth",
  billing: "billing",
  rate_limit: "rate_limit",
  overload: "overload",
  network: "network",
  timeout: "timeout",
  provider_error: "error",
  tool: "error",
  compaction: "error",
  busy: "error",
  interrupted: "aborted",
  generic: "error",
};

export function outcomeFromEnvelope(env: ErrorEnvelope): TurnOutcome {
  try {
    const e = env && typeof env === "object" ? env : ({} as ErrorEnvelope);
    const kind: TurnOutcomeKind =
      (typeof e.category === "string" && CATEGORY_TO_KIND[e.category as ErrorCategory]) || "error";
    const headline =
      typeof e.headline === "string" && e.headline.trim() ? e.headline.trim() : HEADLINES[kind];
    const rawText =
      typeof e.raw === "string" && e.raw.trim()
        ? e.raw
        : typeof e.explanation === "string"
          ? e.explanation
          : "";
    // An envelope built before 2026-10-05 marks a weekly limit non-fatal: read the window too.
    const recoverable =
      kind === "aborted" ? false : e.fatal !== true && !isLongLimit(kind, rawText);
    let retryAfter: number | undefined;
    if (recoverable && rawText) {
      try {
        retryAfter = resolveRetryAfterSeconds(rawText, Date.now());
      } catch {
        retryAfter = undefined;
      }
    }
    const detail = truncateDetail(rawText);
    return {
      kind,
      recoverable,
      headline,
      ...(detail !== undefined ? { detail } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      source: "envelope",
      envelope: e,
    };
  } catch {
    return { kind: "error", recoverable: false, headline: HEADLINES.error, source: "envelope" };
  }
}

export function isTurnOutcome(v: unknown): v is TurnOutcome {
  if (!v || typeof v !== "object") {
    return false;
  }
  const o = v as Partial<TurnOutcome>;
  return (
    typeof o.kind === "string" &&
    KINDS.has(o.kind) &&
    typeof o.recoverable === "boolean" &&
    typeof o.headline === "string" &&
    o.headline.length > 0 &&
    typeof o.source === "string" &&
    SOURCES.has(o.source) &&
    (o.detail === undefined || typeof o.detail === "string") &&
    (o.retryAfter === undefined ||
      (typeof o.retryAfter === "number" && Number.isFinite(o.retryAfter))) &&
    (o.envelope === undefined || (typeof o.envelope === "object" && o.envelope !== null))
  );
}

// ---------------------------------------------------------------------------
// classifyAssistantOutcome — plan rules 1-9, in order.
// ---------------------------------------------------------------------------

interface AssistantLike {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  isError?: unknown;
  outcome?: unknown;
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object");
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const b of contentBlocks(content)) {
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/** Both the runtime block type and the display-projected one count. */
function hasToolBlocks(content: unknown): boolean {
  return contentBlocks(content).some((b) => b.type === "toolCall" || b.type === "tool_use");
}

function hasErrorFlag(m: AssistantLike): boolean {
  if (m.isError === true) {
    return true;
  }
  return contentBlocks(m.content).some((b) => b.isError === true);
}

/** Lines skipped when locating the first meaningful line (plan rule 6). */
const SKIP_LINE_RE = /^(?:\[system\]|model set to\b)/i;

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || SKIP_LINE_RE.test(t)) {
      continue;
    }
    return t;
  }
  return "";
}

/** Text from the first meaningful line onward — the classifiable tail. */
function meaningfulTail(text: string): string {
  const lines = text.split(/\r?\n/);
  let start = 0;
  while (start < lines.length) {
    const t = lines[start].trim();
    if (!t || SKIP_LINE_RE.test(t)) {
      start++;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n").trim();
}

/** Rule 6: error-shaped first line, on a flagged message. */
const ERROR_SHAPED_LINE_RE =
  /^(?:⚠️|⚠|🛑|❌|api error|error:|claude ai usage limit|you have hit your|all models are temporarily)/i;

function stripLeadingWarning(line: string): string {
  return line.replace(/^[\s⚠🛑❌️]+/u, "").trim();
}

/** Rule 7: the gateway's own error wording, matched at line start only. */
const GATEWAY_WORDING_RE =
  /^(?:agent failed before reply|all models are temporarily rate-limited|rate-?limited\b|overloaded\b|the model is currently at capacity|anthropic (?:is )?temporarily limiting|server is temporarily limiting|402\b|credit balance is too low|api error:|claude ai usage limit reached|you have hit your .{0,60}usage limit)/i;

/** Max text length for the unflagged gateway-wording rule (plan rule 7). */
const MAX_UNFLAGGED_ERROR_TEXT_CHARS = 1200;

/**
 * Classify an assistant display message into a `TurnOutcome`, or null when it
 * is a normal answer (or not an assistant message at all). Plan rules 1-9 in
 * order. Never throws.
 */
export function classifyAssistantOutcome(msg: unknown): TurnOutcome | null {
  try {
    if (!msg || typeof msg !== "object") {
      return null; // rule 9 for garbage input
    }
    const m = msg as AssistantLike;
    // Rule 1: a valid existing outcome is returned unchanged.
    if (isTurnOutcome(m.outcome)) {
      return m.outcome;
    }
    // Rule 2: non-assistant messages return null.
    if (m.role !== "assistant") {
      return null;
    }
    const text = extractText(m.content);
    const stopReason = typeof m.stopReason === "string" ? m.stopReason : undefined;
    // Rule 3: stopReason error. `errorMessage` beats the generic placeholder
    // text; an envelope inside the chosen raw routes through outcomeFromEnvelope.
    if (stopReason === "error") {
      const errMsg = typeof m.errorMessage === "string" ? m.errorMessage.trim() : "";
      const raw = errMsg || text.trim();
      if (raw.includes(ERROR_ENVELOPE_MARKER)) {
        const { envelope } = splitErrorEnvelope(raw);
        if (envelope) {
          return outcomeFromEnvelope(envelope);
        }
      }
      return classifyErrorText(raw, { source: "stop-reason" });
    }
    // Rule 4: aborted.
    if (stopReason === "aborted") {
      const errMsg = typeof m.errorMessage === "string" ? m.errorMessage.trim() : "";
      const detail = errMsg ? truncateDetail(errMsg) : undefined;
      return {
        kind: "aborted",
        recoverable: false,
        headline: HEADLINES.aborted,
        ...(detail !== undefined ? { detail } : {}),
        source: "stop-reason",
      };
    }
    // Rule 5: an envelope anywhere in the text (alone, after [system] /
    // Model set to …, or after a streamed partial answer — splitErrorEnvelope
    // keeps the partial answer for the caller).
    if (text.includes(ERROR_ENVELOPE_MARKER)) {
      const { envelope } = splitErrorEnvelope(text);
      if (envelope) {
        return outcomeFromEnvelope(envelope);
      }
      return classifyErrorText(meaningfulTail(text), { source: "envelope" });
    }
    const flagged = hasErrorFlag(m);
    const line = firstMeaningfulLine(text);
    if (flagged) {
      // Rule 6: flagged AND the FIRST meaningful line is error-shaped. An
      // answer followed by a trailing flagged error line is NOT an outcome.
      if (line && ERROR_SHAPED_LINE_RE.test(line)) {
        return classifyErrorText(meaningfulTail(text), { source: "injected" });
      }
    } else if (
      // Rule 7: no flags — only the gateway's own wording, first-line, with
      // no tool calls and short text (review focus 1: a real answer that
      // mentions "rate limit" mid-prose must stay an answer).
      line &&
      !hasToolBlocks(m.content) &&
      text.length < MAX_UNFLAGGED_ERROR_TEXT_CHARS &&
      GATEWAY_WORDING_RE.test(stripLeadingWarning(line))
    ) {
      return classifyErrorText(meaningfulTail(text), { source: "injected" });
    }
    // Rule 8: empty stop — no tool blocks, no non-empty text (thinking-only
    // included), stopReason "stop" or missing.
    if (
      !hasToolBlocks(m.content) &&
      !text.trim() &&
      (stopReason === undefined || stopReason === "stop")
    ) {
      return {
        kind: "empty",
        recoverable: false,
        headline: HEADLINES.empty,
        source: "empty",
      };
    }
    // Rule 9.
    return null;
  } catch {
    return null;
  }
}
