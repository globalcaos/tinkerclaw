// FORK 2026-09-29 — typed turn outcomes, UI half (plan U9:
// jarvis-icu docs/superpowers/plans/2026-09-29-chat-usage-chips-and-typed-outcomes.md).
//
// The gateway classifies a failed turn ONCE (src/fork/turn-outcome.ts) and ships the verdict as
// `message.outcome`. This module is the renderer's side of that contract: it decides whether a
// message IS an outcome row, and turns the verdict into the bubble's HTML. Pure and DOM-free on
// purpose (sibling of retry-policy.ts / retry-lifecycle.ts / error-bubble.ts) so both of app.ts's
// assistant render chains AND the retry lifecycle share one rule — the drift that produced the
// 529-as-an-answer bug (see error-bubble.ts) came from exactly two hand-maintained copies.
//
// Measured 2026-09-29: 334 failed turns rendered as plain answers after a reload because renderMsg
// read neither `stopReason` nor `errorMessage`, and 63 more because the text-match list did not
// carry the gateway's own wording.
//
// WHY A STRUCTURAL MIRROR of TurnOutcome instead of importing it. tinker-ui CAN reach `src/` today
// (app.ts imports `../../src/shared/*`) and turn-outcome.ts's own dependencies are import-free, so
// the import would build. But `src/shared/` is browser-safe by convention while `src/fork/` is
// gateway territory: one future node import there (fs, a config read) would silently break the UI
// bundle. A mirror's real cost is DRIFT, so outcome-bubble.test.ts reads turn-outcome.ts off disk
// and fails when the kind list, the source list or the headline table disagree.
//
// WHAT THIS MODULE DOES NOT DO. It never regexes the model's prose (plan global constraint). A
// DERIVED outcome — the fallback for rows served before the gateway restart — reads `stopReason`,
// `errorMessage`, `reason` and the SHAPE of the content, nothing else. Whether the text above the
// bubble is a real answer is decided by comparing against the outcome's OWN `detail`, not a keyword
// list, which is why review focus 1 (an answer that merely mentions "rate limit") cannot be hurt
// from here: no text ever becomes an outcome on this side.

import { classifyRecoverable, formatWait, type RetryKind } from "./retry-policy.js";

export type OutcomeKind =
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

export type OutcomeSource =
  | "stop-reason"
  | "envelope"
  | "cli"
  | "injected"
  | "prompt-error"
  | "empty";

/** Structural mirror of `TurnOutcome` (src/fork/turn-outcome.ts). Kept in step by a disk-read test. */
export interface TurnOutcomeLike {
  kind: OutcomeKind;
  /** true → orange + the §5.8j retry ladder owns it; false → red, or grey for the quiet kinds. */
  recoverable: boolean;
  headline: string;
  detail?: string;
  /** Seconds. Supplied by the gateway only — the UI never parses a reset out of prose. */
  retryAfter?: number;
  source: OutcomeSource;
  /** Present when it came from an `__ERR_ENV__` envelope; only its icon is used here. */
  envelope?: { icon?: unknown; explanation?: unknown; [k: string]: unknown };
}

const KINDS: ReadonlySet<string> = new Set<OutcomeKind>([
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

const SOURCES: ReadonlySet<string> = new Set<OutcomeSource>([
  "stop-reason",
  "envelope",
  "cli",
  "injected",
  "prompt-error",
  "empty",
]);

/** Mirror of turn-outcome.ts HEADLINES — for DERIVED outcomes only (a typed one brings its own). */
const HEADLINES: Record<OutcomeKind, string> = {
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

/**
 * The two QUIET kinds get the plan's own short copy rather than the gateway headline: the bubble is
 * a one-glance grey note ("⏹ Stopped", "∅ No answer"), and "No answer — the model returned nothing"
 * is a sentence, not a chip. The full wording is still what the gateway logged.
 */
const QUIET_LABEL: Partial<Record<OutcomeKind, string>> = {
  aborted: "Stopped",
  empty: "No answer",
};

export const ENVELOPE_MARKER = "__ERR_ENV__:";

/** The gateway's placeholder for a turn that died before writing anything: scaffolding, never prose. */
const FAILED_BEFORE_CONTENT = "[assistant turn failed before producing content]";

/**
 * Client-minted lifecycle bubbles. Each already has a dedicated renderer further down both chains
 * (`renderRetryWarningBubble`, `renderPhaseGroup`, the overload/exhausted bubbles, the live
 * reasoning bubble) and a gateway `outcome` never rides on one. Without this guard a derived
 * `empty` would repaint a half-arrived reasoning stream as "∅ No answer", and the exhausted
 * "🛑 Gave up after 6 retries" bubble would be re-classified into a promise of a retry that is by
 * definition never coming — the same trap error-bubble.ts documents for `_isError`.
 */
const CLIENT_MINTED_FLAGS = [
  "_isRetryWarning",
  "_isOverloadRetry",
  "_isPhaseTiming",
  "_isExhausted",
  "_isWarning",
  "_isReasoning",
] as const;

/** RetryKind (retry-policy.ts) → OutcomeKind. "unavailable" folds into overload, per the plan's table. */
const FROM_RETRY_KIND: Record<RetryKind, OutcomeKind> = {
  rate_limit: "rate_limit",
  quota: "quota",
  overloaded: "overload",
  unavailable: "overload",
};

/** OutcomeKind → RetryKind, for handing a typed outcome to the §5.8j ladder. Null = not retryable. */
export function retryKindForOutcome(kind: unknown): RetryKind | null {
  switch (kind) {
    case "rate_limit":
      return "rate_limit";
    case "quota":
      return "quota";
    case "overload":
      return "overloaded";
    case "network":
    case "timeout":
      return "unavailable";
    default:
      return null;
  }
}

export function isTurnOutcome(v: unknown): v is TurnOutcomeLike {
  if (!v || typeof v !== "object") {
    return false;
  }
  const o = v as Partial<TurnOutcomeLike>;
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

type Blocks = Array<{ type?: unknown; text?: unknown }>;

function blocksOf(m: Record<string, unknown>): Blocks {
  return Array.isArray(m.content) ? (m.content as Blocks) : [];
}

/** All assistant TEXT of a message, both content shapes (the two that grew the divergent chains). */
function textOf(m: Record<string, unknown>): string {
  if (typeof m.content === "string") {
    return m.content;
  }
  return blocksOf(m)
    .filter((b) => b?.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

function hasToolBlocks(m: Record<string, unknown>): boolean {
  return blocksOf(m).some((b) => b?.type === "tool_use" || b?.type === "tool_result");
}

function hasThinkingBlocks(m: Record<string, unknown>): boolean {
  return blocksOf(m).some((b) => b?.type === "thinking" || b?.type === "redacted_thinking");
}

/**
 * Derive an outcome from STRUCTURED fields only — the fallback for assistant rows served by a build
 * that predates the gateway's own classification.
 *
 * Deliberately NARROWER than the gateway's rules 1-9:
 * - rule 8 (`empty`) also fires there on a MISSING stopReason; here it requires an explicit
 *   `"stop"`, because a live half-arrived bubble has no stopReason at all and turning those grey
 *   would be a visible regression on every streaming turn (review focus 4);
 * - thinking-only messages are excluded for the same reason (the gateway sees the finished turn,
 *   this renderer sees frames of it);
 * - rules 5-7 (envelope text, `isError` first-line shapes, gateway wording) are NOT derived here.
 *   They are prose rules, they stay where the plan put them — the gateway — and app.ts's existing
 *   `extractEnvelope` / `classifyErrorBubble` remain the fallback for those rows, untouched.
 */
export function deriveOutcome(msg: unknown): TurnOutcomeLike | null {
  if (!msg || typeof msg !== "object") {
    return null;
  }
  const m = msg as Record<string, unknown>;
  if (String(m.role ?? "").toLowerCase() !== "assistant") {
    return null;
  }
  const stop = typeof m.stopReason === "string" ? m.stopReason : "";
  const errorMessage = typeof m.errorMessage === "string" ? m.errorMessage : "";

  if (stop === "error") {
    const raw = (errorMessage || textOf(m)).trim();
    // A structured `reason` outranks the text, exactly as it does for the retry ladder.
    const cls = classifyRecoverable(typeof m.reason === "string" ? m.reason : undefined, raw);
    const kind: OutcomeKind = cls.recoverable && cls.kind ? FROM_RETRY_KIND[cls.kind] : "error";
    return {
      kind,
      recoverable: cls.recoverable,
      headline: HEADLINES[kind],
      ...(raw ? { detail: raw.slice(0, 2000) } : {}),
      source: "stop-reason",
    };
  }
  if (stop === "aborted") {
    return {
      kind: "aborted",
      recoverable: false,
      headline: HEADLINES.aborted,
      source: "stop-reason",
    };
  }
  if (stop === "stop" && !textOf(m).trim() && !hasToolBlocks(m) && !hasThinkingBlocks(m)) {
    return { kind: "empty", recoverable: false, headline: HEADLINES.empty, source: "empty" };
  }
  return null;
}

/**
 * THE question both render chains ask: is this message an outcome row, and which?
 * A valid typed `outcome` wins; otherwise the narrow derivation above; otherwise null, and the
 * message renders exactly as it does today.
 */
export function outcomeOf(msg: unknown): TurnOutcomeLike | null {
  if (!msg || typeof msg !== "object") {
    return null;
  }
  const m = msg as Record<string, unknown>;
  for (const flag of CLIENT_MINTED_FLAGS) {
    if (m[flag]) {
      return null;
    }
  }
  if (isTurnOutcome(m.outcome)) {
    return m.outcome;
  }
  return deriveOutcome(m);
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * The part of an outcome row's text that is a REAL ANSWER and belongs above the bubble.
 *
 * Three structural subtractions, no keyword matching:
 * 1. everything from `__ERR_ENV__:` on is the envelope, never prose (U2 strips it server-side; this
 *    covers a derived outcome on an older row that still carries it);
 * 2. the gateway's `[assistant turn failed before producing content]` placeholder is scaffolding;
 * 3. text that IS the outcome's own `detail` is the error, not an answer. Compared whitespace-
 *    insensitively, and by prefix in both directions with a 24-char floor so the two known
 *    shapings of one string — chat.ts's `Logs:` trim and turn-outcome.ts's 2000-char cap — cannot
 *    slip an error line in as prose, while a real answer that happens to start with a short detail
 *    ("Error") is kept.
 *
 * What survives is a genuine partial answer, which is the point: a turn that answered and THEN
 * failed keeps its answer, with the bubble under it.
 */
export function answerTextOf(text: unknown, outcome: TurnOutcomeLike): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  const cut = text.indexOf(ENVELOPE_MARKER);
  const head = (cut >= 0 ? text.slice(0, cut) : text).trim();
  if (!head || head === FAILED_BEFORE_CONTENT) {
    return "";
  }
  const detail = typeof outcome.detail === "string" ? collapse(outcome.detail) : "";
  if (!detail) {
    return head;
  }
  const h = collapse(head);
  if (h === detail) {
    return "";
  }
  if (detail.length >= 24 && h.startsWith(detail)) {
    return "";
  }
  if (h.length >= 24 && detail.startsWith(h)) {
    return "";
  }
  return head;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function iconFor(outcome: TurnOutcomeLike): string {
  const envIcon = outcome.envelope?.icon;
  if (typeof envIcon === "string" && envIcon.trim()) {
    return envIcon.trim();
  }
  if (outcome.kind === "aborted") {
    return "⏹";
  }
  if (outcome.kind === "empty") {
    return "∅";
  }
  return outcome.recoverable ? "⚠️" : "🛑";
}

/**
 * The bubble. One `<div>`, DETERMINISTIC for a given outcome — §5.8X reuses a row's node when its
 * HTML string is unchanged, so nothing here may carry a clock, a counter or a random id. That is
 * also what lets the `<details>` stay open across a re-render without a fold key, the same way
 * `renderEnvelope` already relies on.
 *
 * Colour comes from the EXISTING bubble vocabulary rather than a new palette:
 * `.msg-overload-bubble` is the orange, `+ .exhausted` the red. Only the grey quiet variant is new.
 *
 * FORK 2026-10-02 — reuse alone does not keep it open: the row's unit re-renders whenever anything
 * else in it changes (the answer rail recolours it) and a tab switch rebuilds it. `foldAttr` is the
 * caller's keyed-fold attribute (app.ts foldAttrs, ` data-fold-key="…"` plus ` open`), "" for none.
 */
export function renderOutcomeBubble(outcome: TurnOutcomeLike, foldAttr = ""): string {
  const quiet = outcome.kind === "aborted" || outcome.kind === "empty";
  const classes = ["msg-overload-bubble", "msg-outcome-bubble", `outcome-${outcome.kind}`];
  if (quiet) {
    classes.push("quiet");
  } else if (!outcome.recoverable) {
    classes.push("exhausted");
  }
  const label = (quiet ? QUIET_LABEL[outcome.kind] : "") || outcome.headline;
  const wait =
    typeof outcome.retryAfter === "number" &&
    Number.isFinite(outcome.retryAfter) &&
    outcome.retryAfter > 0
      ? ` · retry after ${formatWait(outcome.retryAfter * 1000)}`
      : "";
  const detail = typeof outcome.detail === "string" ? outcome.detail.trim() : "";
  const expander = detail
    ? `<details class="msg-outcome-detail"${foldAttr}><summary>details</summary><pre>${escHtml(detail)}</pre></details>`
    : "";
  return (
    `<div class="${classes.join(" ")}" data-outcome-kind="${escHtml(outcome.kind)}">` +
    `<span class="msg-outcome-head">${escHtml(iconFor(outcome))} ${escHtml(label)}${escHtml(wait)}</span>` +
    `${expander}</div>`
  );
}
