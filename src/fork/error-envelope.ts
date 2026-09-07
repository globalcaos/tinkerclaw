/**
 * FORK: unified error envelope for Tinker UI.
 *
 * An `ErrorEnvelope` replaces the current pattern of "isError:true + raw text"
 * with a structured object carrying everything the UI needs to render a rich,
 * actionable error bubble: the fatal/recoverable flag (red vs orange per the
 * Design Bible), provider/model when the error came from an LLM call, the raw
 * HTTP status and provider error code, a human-readable explanation, a list of
 * suggested actions, and the original request id for bug reports.
 *
 * Conventions:
 *   - `kind: "error"` — discriminator so UI can route envelopes through the
 *     error renderer instead of the normal assistant-text renderer.
 *   - `fatal: true`  — red, blocks conversation until user acts.
 *   - `fatal: false` — orange, auto-recovering (overload retry, fallback, etc).
 *   - `icon` — emoji for variety; picked at build time from a small pool keyed
 *     on the error type.
 *   - `details` — a free-form record so sites can stuff in whatever extra
 *     context they have (cooldown remaining, attempt number, fallback chain...).
 *
 * Emitted by: worker streams (tinker-bridge, ollama, anthropic), agent-runner
 * banners, get-reply-run-queue busy banners.
 * Rendered by: tinker-ui/src/app.ts.
 */

export type MessageKind = "jarvis" | "user" | "error";

export type ErrorCategory =
  | "auth"
  | "billing"
  | "rate_limit"
  | "overload"
  | "network"
  | "timeout"
  | "provider_error"
  | "tool"
  | "compaction"
  | "busy"
  // FORK 2026-09-03: a turn that was CUT — a user Stop, a deliberate
  // sessions_yield, a budget stop, or an interruption whose cause was not
  // recorded. These were filed as `provider_error`, which re-commits the very
  // lie this fork removes one field lower: the headline stops blaming the
  // gateway while the machine-readable field starts blaming the provider.
  // `category` ships to the DOM as `data-env-category` (tinker-ui app.ts) with
  // no exhaustive switch and no CSS keyed on its value, so a new member is
  // purely additive.
  | "interrupted"
  | "generic";

export interface LlmCallMeta {
  provider: string;
  model: string;
  authProfileId?: string;
  requestId?: string;
  httpStatus?: number;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  durationMs?: number;
}

export interface ErrorEnvelope {
  kind: "error";
  /** Stable ID for deduplication and retry targeting. */
  id: string;
  /** UX-critical: red vs orange. True = user action required. */
  fatal: boolean;
  /** One of the known categories; used to pick icon + explanation. */
  category: ErrorCategory;
  /** Short headline shown prominently. */
  headline: string;
  /** Longer human-readable paragraph. Markdown allowed. */
  explanation?: string;
  /** Ordered list of things the user can do. First one gets rendered as a button-ish hint. */
  suggestedActions?: string[];
  /** Icon (emoji). Chosen from a pool for variety. */
  icon: string;
  /** LLM-call context, present when the error came from a provider call. */
  llm?: LlmCallMeta;
  /** Session key where this surfaced. */
  sessionKey?: string;
  /** Raw original message (for debugging / copy-paste to bug reports). */
  raw?: string;
  /** Free-form extra context. */
  details?: Record<string, unknown>;
  /** ISO timestamp. */
  timestamp: string;
}

interface ErrorLookupEntry {
  category: ErrorCategory;
  fatal: boolean;
  headline: string;
  explanation: string;
  suggestedActions: string[];
  /** Single fixed icon that conveys the error (or its remedy) at a glance.
   *  Convention: pick the one icon that best signals the solution space, not
   *  a randomised pool — users should learn "credit-card → billing" etc. */
  icon: string;
}

const GENERIC: ErrorLookupEntry = {
  category: "generic",
  fatal: true,
  headline: "Something went wrong",
  explanation: "An unexpected error occurred. Expand for the raw message.",
  suggestedActions: [],
  icon: "⚠️",
};

/**
 * Error lookup table. Keyed by a canonical short code that sites pass in.
 * The table exists so that every emission site gets: the right fatal flag,
 * a consistent headline, plain-English explanation, and suggested actions —
 * regardless of where in the code the error bubbled from.
 */
const ERROR_LOOKUP: Record<string, ErrorLookupEntry> = {
  auth_401_invalid_credentials: {
    category: "auth",
    fatal: true,
    headline: "Claude Code authentication failed",
    explanation:
      "Anthropic rejected the OAuth token at `~/.claude/.credentials.json` with HTTP 401. " +
      "This usually means the subscription token was revoked, expired without refresh, or the account was flagged. " +
      "OpenClaw cannot recover on its own: a fresh login is required.",
    suggestedActions: [
      "Run `claude` in a terminal to re-login to Claude Code",
      "If Anthropic keeps rejecting, check https://www.anthropic.com/status",
    ],
    // 🔐 padlock — credentials / unlock-this-to-fix
    icon: "🔐",
  },
  auth_expired: {
    category: "auth",
    fatal: true,
    headline: "Auth credentials expired",
    explanation: "The stored credentials are past their expiry window.",
    suggestedActions: ["Re-authenticate the relevant profile"],
    // ⏰ clock — expired-in-time, refresh-required
    icon: "⏰",
  },
  auth_missing: {
    category: "auth",
    fatal: true,
    headline: "No auth credentials found",
    explanation:
      "The provider needs a login but `~/.claude/.credentials.json` is missing or unreadable.",
    suggestedActions: ["Run `claude` once to create the credential file"],
    // 🗝️ key — login missing entirely
    icon: "🗝️",
  },
  billing_insufficient: {
    category: "billing",
    fatal: true,
    headline: "Credit balance too low",
    explanation:
      "The API key tied to this provider is out of credits. The subscription-OAuth path should be preferred; check which profile was selected.",
    suggestedActions: [
      "Top up the provider's API key, or",
      "Switch to a subscription-OAuth profile (claude-code:oauth)",
    ],
    // 💸 money-with-wings — wallet drained
    icon: "💸",
  },
  subscription_usage_exhausted: {
    category: "billing",
    fatal: true,
    headline: "Claude Max subscription usage exhausted",
    explanation:
      "Your Claude Max subscription hit its usage cap. The flat-rate window is closed until the next reset, or you can add extra usage credit.",
    suggestedActions: [
      "Add extra usage at claude.ai/settings/usage",
      "Wait for the 5-hour or weekly quota to reset",
      "Temporarily switch to a paid API key via a different auth profile",
    ],
    // 💳 credit-card — the user confirmed this as the right symbol for subscription-exhausted
    icon: "💳",
  },
  rate_limited: {
    category: "rate_limit",
    fatal: false,
    headline: "Rate limited",
    // NOTE: when `raw` is available, buildErrorEnvelope() replaces this with the
    // precise window (5-hour / weekly / short-term peak) via rateLimitDetail().
    // This static text is only the fallback when the cause can't be pinned down.
    //
    // FORK 2026-09-03: the action used to read "automatic retry is in progress".
    // Nothing on this path schedules a retry, so that was a promise the system
    // could not keep — the user waits for a resumption that never comes.
    // buildErrorEnvelope prepends "Retrying automatically at HH:MM" if and only
    // if the caller supplies `retryScheduledAt`.
    explanation:
      "The provider is rate-limiting requests. The exact window (5-hour, weekly, or short-term peak) is named from the error when the provider includes it.",
    suggestedActions: [
      "Wait for the limit to reset, then send your message again",
      "Switch to a different auth profile temporarily",
    ],
    // 🚦 traffic-light — slow down, auto-recovers
    icon: "🚦",
  },
  overloaded: {
    category: "overload",
    fatal: false,
    headline: "Anthropic temporarily limiting requests (not your usage)",
    explanation:
      "Anthropic returned HTTP 529 — its own servers are temporarily overloaded or rate-limiting on their side. This is NOT your 5-hour or weekly usage limit and does not count against your quota; it clears on its own, usually within a few minutes. Automatic retry is in progress.",
    suggestedActions: [
      "Wait — automatic retry is in progress",
      "If it persists for many minutes, check https://status.anthropic.com",
    ],
    // 🌊 wave — too much traffic, will drain
    icon: "🌊",
  },
  network_error: {
    category: "network",
    fatal: false,
    headline: "Network error",
    explanation: "Lost connection to the provider. Will retry.",
    suggestedActions: ["Check your internet connection"],
    // 📡 satellite-antenna — connectivity
    icon: "📡",
  },
  timeout: {
    category: "timeout",
    fatal: false,
    headline: "Request timed out",
    explanation:
      "The provider did not reply within the configured timeout window. I'm retrying automatically.",
    suggestedActions: ["If timeouts are frequent, raise `agents.defaults.timeoutSeconds`"],
    // ⏱️ stopwatch — deadline exceeded
    icon: "⏱️",
  },
  provider_generic: {
    category: "provider_error",
    fatal: true,
    headline: "Provider error",
    explanation:
      "The provider returned an error but did not specify a known failure mode. I'm retrying; expand for the raw message.",
    suggestedActions: [],
    // ⚠️ warning — generic unclassified fault
    icon: "⚠️",
  },
  lane_busy: {
    category: "busy",
    fatal: false,
    headline: "Previous run still shutting down",
    explanation:
      "A prior turn has not fully released the session lane. This clears within a few seconds on its own.",
    suggestedActions: [],
    // 🔄 cyclic-arrow — cycle still draining
    icon: "🔄",
  },
  queued_behind_turn: {
    category: "busy",
    fatal: false,
    headline: "Message queued behind the current turn",
    explanation:
      "A previous turn is still running in this session. Your message is queued and will start automatically when it ends (even if it ends in an error).",
    suggestedActions: [],
    // ⏳ hourglass — parked until the running turn releases the lane
    icon: "⏳",
  },
  reply_run_already_active: {
    category: "busy",
    fatal: false,
    headline: "Another reply is already running",
    explanation:
      "The gateway still holds an active reply operation for this session. It clears on its own.",
    suggestedActions: [],
    // ⏳ hourglass — still processing, just wait
    icon: "⏳",
  },
  incomplete_turn: {
    category: "provider_error",
    fatal: true,
    headline: "Turn ended without a response",
    explanation:
      "The provider closed the stream without producing any output — usually a silent provider failure. I'm retrying automatically.",
    suggestedActions: [],
    // 🫥 dotted-line-face — the model went silent
    icon: "🫥",
  },
  tool_error: {
    category: "tool",
    fatal: false,
    headline: "Tool call failed",
    explanation: "A tool invocation returned an error. The reasoning can continue.",
    suggestedActions: ["Check the tool's raw output below"],
    // 🔧 wrench — tool failed
    icon: "🔧",
  },
  compaction_error: {
    category: "compaction",
    fatal: false,
    headline: "Compaction failed",
    explanation: "Memory compaction hit an error. The current turn may still complete.",
    suggestedActions: ["Continue — the next turn will retry compaction"],
    // 🧹 broom — compaction sweep failed
    icon: "🧹",
  },
  // FORK (2026-04-21): tinker-bridge subprocess exit codes. Before this, any claude
  // subprocess exit got classified as generic "Provider error" which made it
  // impossible to tell a benign gateway-restart kill (SIGTERM) from a real
  // Anthropic rejection. Now we name each exit path.
  //
  // FORK (2026-09-03) — SIGTERM CAUSE ATTRIBUTION. `signal=SIGTERM` on its own
  // says NOTHING about why a turn ended: at least seven unrelated causes produce
  // the identical signal (see SIGTERM_CAUSE_CODES for the verified producer
  // strings). Until today ALL of them rendered as "Gateway restarted … I'm
  // resuming it automatically", and for every one but the restart BOTH halves
  // are false — nothing restarted, nothing resumes, and the user types "keep
  // going". The entries below are selected by the cause the worker stamps into
  // its exit message.
  //
  // INVARIANT: exactly ONE entry — `tinker_bridge_sigterm`, the real restart,
  // whose resume is the M17 recovery path in failures.md — may promise a resume.
  // An unknown or absent cause MUST land on `tinker_bridge_interrupted`, which
  // promises nothing. Adding a "we'll retry" line to any other entry here
  // reintroduces the exact defect this block exists to remove.
  tinker_bridge_sigterm: {
    category: "provider_error",
    fatal: false,
    headline: "Gateway restarted",
    explanation:
      "Your previous turn was interrupted by a gateway restart — not a provider or auth problem. I'm resuming it automatically; any partial text above is what streamed before the interruption.",
    suggestedActions: [],
    // 🔌 plug — interrupted externally
    icon: "🔌",
  },
  tinker_bridge_stopped: {
    category: "interrupted",
    fatal: false,
    headline: "Stopped.",
    explanation:
      "You stopped this turn. Nothing failed and nothing is retrying — send a new message whenever you are ready. Any partial text above is what streamed before you stopped it.",
    suggestedActions: [],
    // ✋ raised-hand — you asked for this one
    icon: "✋",
  },
  tinker_bridge_idle_timeout: {
    category: "timeout",
    fatal: false,
    headline: "No response from the model — the turn was cut",
    explanation:
      "The model produced nothing for longer than the idle window allows, so the turn was cut. Nothing restarted and nothing is resuming on its own — send the message again, or ask me to keep going.",
    suggestedActions: [],
    // ⏱️ stopwatch — the idle clock ran out
    icon: "⏱️",
  },
  tinker_bridge_run_deadline: {
    category: "timeout",
    fatal: false,
    headline: "The turn hit its time limit",
    explanation:
      "The turn ran past the wall-clock deadline configured for a run and was cut. Nothing restarted and nothing is resuming on its own — send the message again.",
    suggestedActions: ["Raise `agents.defaults.timeoutSeconds` if long turns are normal here"],
    // ⌛ hourglass-done — the whole budget of time is spent
    icon: "⌛",
  },
  tinker_bridge_budget_exhausted: {
    category: "interrupted",
    fatal: false,
    headline: "The run hit its budget",
    explanation:
      "The turn was stopped because the run reached the budget it was given (tokens or tool calls), not because anything failed. Nothing restarted and nothing is resuming on its own.",
    suggestedActions: [],
    // 🧮 abacus — a count ran out
    icon: "🧮",
  },
  tinker_bridge_yielded: {
    category: "interrupted",
    fatal: false,
    headline: "Turn paused to wait for a subagent",
    explanation:
      "This turn ended on purpose (`sessions_yield`) while waiting for a subagent — not a failure and not an interruption. Any partial text above is what streamed before the pause.",
    suggestedActions: [],
    // ⏸️ pause — deliberate, not a fault
    icon: "⏸️",
  },
  tinker_bridge_fast_fail_init: {
    category: "timeout",
    fatal: false,
    headline: "The model never started replying (gateway busy)",
    explanation:
      "The turn was cut during start-up: no text, no thinking and almost no protocol traffic inside the init window — the signature of a wedged or contended start rather than a provider fault. Nothing is resuming on its own; sending the message again usually works.",
    suggestedActions: [],
    // 🐌 snail — it never got moving
    icon: "🐌",
  },
  tinker_bridge_interrupted: {
    category: "interrupted",
    fatal: false,
    headline: "The turn was interrupted",
    explanation:
      "The turn ended early and the cause was not recorded. Nothing restarted and nothing is resuming on its own — send the message again, or ask me to keep going.",
    suggestedActions: [],
    // ⏹️ stop-button — ended early, cause unrecorded
    icon: "⏹️",
  },
  tinker_bridge_sigkill: {
    category: "provider_error",
    fatal: false,
    headline: "Turn interrupted to free memory",
    explanation:
      "The turn was stopped to reclaim memory — not a provider or auth issue. I'm resuming it automatically. If it keeps happening, the gateway is running tight on memory.",
    suggestedActions: [],
    // 💀 skull — hard kill
    icon: "💀",
  },
  tinker_bridge_silent: {
    category: "timeout",
    fatal: false,
    headline: "Turn stalled — restarting it",
    explanation:
      "The assistant stopped producing output for longer than the watchdog allows, usually a hung tool call or a slow network wait. I restarted it on a fresh worker and am continuing.",
    suggestedActions: [],
    // 🔇 muted — no output
    icon: "🔇",
  },
  tinker_bridge_nonzero_exit: {
    category: "provider_error",
    fatal: true,
    headline: "The assistant process crashed",
    explanation:
      "The underlying `claude` process exited unexpectedly mid-turn. I have the error details and am retrying; if this started after a recent `claude` CLI update, rolling that update back usually fixes it.",
    suggestedActions: ["If this began after a `claude` CLI update, roll the update back"],
    // 💥 collision — process crashed
    icon: "💥",
  },
  spawn_e2big: {
    category: "provider_error",
    fatal: true,
    headline: "The Overseer briefing was too large to start",
    explanation:
      "Linux refused to start the child (`spawn E2BIG`): one argument exceeded the 128 KB argv cap. This is not a provider outage and retrying the same payload cannot succeed. The briefing now goes by file, not on the command line — if you still see this, the spawn path is stuffing a transcript into argv again.",
    suggestedActions: [],
    // 📦 package — payload too big for the slot it was put in
    icon: "📦",
  },
};

/** Generate a short stable id. */
function makeId(): string {
  return `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Look up a known error code. Unknown codes fall back to a generic-fatal entry
 * with the provided headline/explanation overrides (so we never throw here).
 */
function lookup(code: string): ErrorLookupEntry {
  return ERROR_LOOKUP[code] ?? GENERIC;
}

/**
 * FORK 2026-09-03 — the causes of a tinker-bridge SIGTERM, and the envelope each
 * one gets. This module is the SINGLE owner of the taxonomy:
 * `extensions/tinkerclaw-tinker-bridge/src/worker.ts` transports the cause text
 * verbatim inside `reason=[…]` and classifies nothing, so there is no duplicate
 * enum across the extension boundary to drift.
 *
 * The patterns below are matched against the REAL producer strings, read off
 * disk on 2026-09-03. This matters: an earlier draft of this change invented the
 * strings, and three of its five classifications were unreachable while its
 * tests stayed green (they fed the parser hand-written tokens and never
 * exercised the mapping).
 *
 *   user Stop      `AbortError: Reply operation aborted by user`
 *                  src/auto-reply/reply/reply-run-registry.ts:107-111, :373
 *   gateway drain  `Reply operation aborted for restart`            …:382-386
 *   run deadline   `TimeoutError: request timed out`
 *                  src/agents/embedded-agent-runner/run/attempt.ts:2170-2174
 *   idle timeout   `LLM idle timeout (300s): no response from model`
 *                  src/agents/embedded-agent-runner/run/llm-idle-timeout.ts:107
 *   budget         `budget-exhausted`                        attempt.ts:2175
 *   yield          `sessions_yield` (a bare string)          attempt.ts:795
 *   fast-fail      `fast-fail-init-stall` (literal at the call site)
 *                  extensions/tinkerclaw-tinker-bridge/src/stream.ts
 *
 * Reword one of those upstream and the table test in error-envelope.test.ts
 * fails — which is the whole point of testing the strings and not the parser.
 */
export type SigtermCause =
  | "gateway-shutdown"
  | "user-abort"
  | "idle-timeout"
  | "run-deadline"
  | "budget-exhausted"
  | "session-yield"
  | "fast-fail-init-stall"
  | "unknown";

const SIGTERM_CAUSE_CODES: Record<SigtermCause, string> = {
  "gateway-shutdown": "tinker_bridge_sigterm",
  "user-abort": "tinker_bridge_stopped",
  "idle-timeout": "tinker_bridge_idle_timeout",
  "run-deadline": "tinker_bridge_run_deadline",
  "budget-exhausted": "tinker_bridge_budget_exhausted",
  "session-yield": "tinker_bridge_yielded",
  "fast-fail-init-stall": "tinker_bridge_fast_fail_init",
  unknown: "tinker_bridge_interrupted",
};

/** Classify a raw abort-cause string into one of the known causes. */
export function classifyAbortCause(cause: string): SigtermCause {
  const s = cause.toLowerCase();
  if (!s.trim()) {
    return "unknown";
  }
  // "aborted for restart" FIRST: it also contains "abort", which the user-stop
  // pattern below would otherwise claim.
  if (/aborted for restart|gateway[-\s]?(?:shutdown|restart|drain)|shutting down/.test(s)) {
    return "gateway-shutdown";
  }
  if (/aborted by user|user[-\s]?abort|stopped by (?:the )?user/.test(s)) {
    return "user-abort";
  }
  // idle BEFORE the deadline patterns: the idle message also says "timeout".
  if (/idle timeout|no response from model/.test(s)) {
    return "idle-timeout";
  }
  if (/request timed out|timeouterror|run[-\s]?deadline|deadline exceeded/.test(s)) {
    return "run-deadline";
  }
  if (/budget[-\s]?exhausted/.test(s)) {
    return "budget-exhausted";
  }
  if (/sessions?_yield/.test(s)) {
    return "session-yield";
  }
  if (/fast[-\s]?fail|init[-\s]?stall/.test(s)) {
    return "fast-fail-init-stall";
  }
  return "unknown";
}

/**
 * Read the abort cause out of a worker exit message. Anchored on the
 * `reason=[…]` delimiter, which worker.ts emits BEFORE the `stderr=` tail; `exec`
 * returns the FIRST match, so a `reason=[…]` printed by the child into its own
 * stderr can never hijack the classification. An exit message with no
 * `reason=[…]` at all (an older bundle, a replayed transcript) is "unknown" —
 * the honest answer, not a licence to claim a gateway restart.
 */
export function killCauseFromRaw(raw: string): { cause: SigtermCause; text: string } {
  const m = /\breason=\[([^\]]*)\]/.exec(raw);
  const text = m?.[1] ?? "";
  return { cause: classifyAbortCause(text), text };
}

/**
 * Seconds of silence named by an idle-timeout cause ("LLM idle timeout (300s):
 * no response from model"). The number exists ONLY in that string, which is why
 * the cause text is carried verbatim instead of being collapsed to an enum at
 * the worker.
 */
function idleSecondsFromCause(cause: string): number | null {
  const secs = /idle timeout \((\d+)\s*s\)/i.exec(cause);
  if (secs) {
    return Number(secs[1]);
  }
  const ms = /\bidle_?ms=(\d+)/i.exec(cause);
  return ms ? Math.round(Number(ms[1]) / 1000) : null;
}

/** Local wall-clock HH:MM for an epoch-ms instant. */
function hhmm(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Opportunistically classify a raw error message into one of the known codes. */
export function classifyRawErrorMessage(raw: string): string {
  const s = raw.toLowerCase();
  // FORK (2026-04-21): tinker-bridge subprocess-exit patterns. Check these BEFORE
  // the generic provider patterns — a SIGTERM-killed claude CLI says nothing
  // about Anthropic, but its raw string contains words like "exit" that
  // shouldn't be miscategorised as provider_generic.
  // Shapes we see in worker.ts::onExit:
  //   "claude subprocess exited (code=143 signal=null reason=[…]) stderr=…"
  //   "claude subprocess exited (code=137 signal=null reason=[…]) stderr=…"
  //   "claude subprocess exited (code=null signal=SIGTERM reason=[…]) stderr=…"
  if (/claude subprocess exited/.test(s)) {
    if (/code=143\b|signal=sigterm/.test(s)) {
      // FORK 2026-09-03: classify BY CAUSE, never by the signal alone.
      return SIGTERM_CAUSE_CODES[killCauseFromRaw(s).cause];
    }
    if (/code=137\b|signal=sigkill/.test(s)) {
      return "tinker_bridge_sigkill";
    }
    return "tinker_bridge_nonzero_exit";
  }
  if (/claude silent for \d+s|watchdog.*claude/.test(s)) {
    return "tinker_bridge_silent";
  }
  if (/401|authentication_error|invalid authentication credentials/.test(s)) {
    return "auth_401_invalid_credentials";
  }
  if (/out of extra usage|claude\.ai\/settings\/usage|subscription.*exhausted/.test(s)) {
    return "subscription_usage_exhausted";
  }
  if (/credit balance is too low|insufficient.*balance|quota.*exhausted/.test(s)) {
    return "billing_insufficient";
  }
  // Anthropic server-side limiting (HTTP 529) — explicitly NOT the user's quota.
  // This MUST be checked BEFORE the rate-limit branch: the raw string often ALSO
  // contains the words "rate limited" (e.g. "Server is temporarily limiting
  // requests (not your usage limit) · Rate limited"), which would otherwise
  // mis-route to rate_limited and falsely claim the user's quota is exhausted.
  if (
    /not your usage limit|server is temporarily limiting|overloaded|\b529\b|temporarily unavailable/.test(
      s,
    )
  ) {
    return "overloaded";
  }
  // "session limit" is Claude Code's name for the rolling 5-hour usage window; it
  // arrives as e.g. "You've hit your session limit · resets 12pm (Europe/Madrid)"
  // with no "rate limit" wording, so match it (and the generic "hit your … limit")
  // explicitly or it falls through to provider_generic.
  if (
    /rate.?limit|\b429\b|usage limits?|too many requests|session limit|hit your (?:session|usage|weekly|5-?hour)|you'?ve hit your .{0,24}\blimit\b/.test(
      s,
    )
  ) {
    return "rate_limited";
  }
  if (/timed out|timeout/.test(s)) {
    return "timeout";
  }
  if (/reply run already active/.test(s)) {
    return "reply_run_already_active";
  }
  if (/previous run is still shutting down/.test(s)) {
    return "lane_busy";
  }
  if (/incomplete turn|turn ended without/.test(s)) {
    return "incomplete_turn";
  }
  if (/\be2big\b/.test(s)) {
    return "spawn_e2big";
  }
  return "provider_generic";
}

/** Minutes from now until the next occurrence of wall-clock h:m in IANA `tz`. */
function minutesUntilLocalTime(h: number, m: number, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date());
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "NaN", 10);
    const curH = get("hour") % 24; // some engines render midnight as "24"
    const curM = get("minute");
    if (Number.isNaN(curH) || Number.isNaN(curM)) return null;
    let diff = h * 60 + m - (curH * 60 + curM);
    if (diff <= 0) diff += 24 * 60; // reset already passed today → next day
    return diff;
  } catch {
    return null;
  }
}

/**
 * Parse a provider-supplied reset time ("resets 12pm (Europe/Madrid)", "resets in
 * 2h", …) into a hint that tells the user WHEN they can prompt again — the absolute
 * reset plus, when a timezone is given, an approximate countdown computed at the
 * moment the error is built. Returns "" when no reset is present.
 */
function resetHint(raw: string): string {
  // Clock form: "resets [at] 12[:30][pm] [(Europe/Madrid)]"
  const clk = raw.match(
    /reset(?:s|ting|ted)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([^)]+)\))?/i,
  );
  if (clk) {
    let h = parseInt(clk[1], 10);
    const min = clk[2] ? parseInt(clk[2], 10) : 0;
    const ap = clk[3] ? clk[3].toLowerCase().replace(/\./g, "") : "";
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const tz = clk[4]?.trim() ?? "";
    const clock = `${clk[1]}${clk[2] ? `:${clk[2]}` : ""}${ap}`;
    const remaining = tz ? minutesUntilLocalTime(h, min, tz) : null;
    const rel =
      remaining !== null
        ? ` (about ${
            remaining >= 60 ? `${Math.floor(remaining / 60)}h ${remaining % 60}m` : `${remaining}m`
          } from when this happened)`
        : "";
    return ` You can prompt again when it resets at ${clock}${tz ? ` ${tz}` : ""}.${rel}`;
  }
  // Relative form: "resets in 2h 30m" / "try again in 45 minutes"
  const rel = raw.match(
    /(?:reset|try again|retry)\w*\s+in\s+(\d+)\s*(h|hours?|m|mins?|minutes?|s|secs?|seconds?)/i,
  );
  if (rel) {
    const unit = /^h/i.test(rel[2]) ? "hour" : /^m/i.test(rel[2]) ? "minute" : "second";
    return ` You can prompt again in about ${rel[1]} ${unit}${rel[1] === "1" ? "" : "s"}.`;
  }
  return "";
}

/**
 * Pin down WHICH rate limit was hit — Claude Code's "session" (rolling 5-hour)
 * limit, the weekly window, or a short-term per-minute peak — from the raw provider
 * message, so the card states the precise cause AND when the user can prompt again
 * (parsed from any "resets …" the provider includes). Anthropic server-side 529
 * limiting is handled separately as `overloaded`, not here.
 */
export function rateLimitDetail(raw: string): {
  explanation: string;
  suggestedActions: string[];
} {
  const s = raw.toLowerCase();
  const reset = resetHint(raw);
  // Fallback only when there's no parsed reset: surface a bare "retry in Ns".
  const retrySecs = !reset
    ? (raw.match(/(?:retry|try again)[^0-9]{0,12}(\d+)\s*s/i)?.[1] ?? "")
    : "";
  const when = reset || (retrySecs ? ` (provider says retry in ${retrySecs}s)` : "");
  // FORK 2026-09-03: no retry PROMISE here. Nothing on this path schedules a
  // retry, so "automatic retry is in progress" was a claim the system could not
  // keep. buildErrorEnvelope prepends "Retrying automatically at HH:MM" if and
  // only if the caller supplies `retryScheduledAt`.
  const waitAction = reset
    ? "Wait until the reset time shown above, then send your message again"
    : "Wait for the window to reset, then send your message again";

  // Claude Code surfaces the rolling 5-hour window as a "session limit".
  if (/session limit|hit your session/.test(s)) {
    return {
      explanation: `You hit your Claude session limit — the rolling 5-hour usage window. This is your own usage, not a provider fault.${when}`,
      suggestedActions: [waitAction, "Switch to a different auth profile temporarily"],
    };
  }
  if (/weekly|per week|7[\s-]?day/.test(s)) {
    return {
      explanation: `You hit the Claude subscription's WEEKLY usage limit. This is your own usage and it clears at the next weekly reset.${when}`,
      suggestedActions: [waitAction, "Switch to a different auth profile temporarily"],
    };
  }
  if (/5[\s-]?hour|\b5h\b|five[\s-]?hour/.test(s)) {
    return {
      explanation: `You hit the Claude subscription's rolling 5-HOUR usage limit. This is your own usage and it clears at the next 5-hour reset.${when}`,
      suggestedActions: [waitAction, "Switch to a different auth profile temporarily"],
    };
  }
  if (/per minute|requests per|tokens per|too many requests|\b429\b/.test(s)) {
    return {
      explanation: `Short-term PEAK rate limit: too many requests or tokens per minute. This is a burst limit (your peak consumption, not your overall 5-hour or weekly quota) and clears within about a minute.${when}`,
      suggestedActions: [
        "Wait ~60s, then send your message again",
        "Reduce concurrent requests if this keeps happening",
      ],
    };
  }
  return {
    explanation: `The provider is rate-limiting requests. The exact window (5-hour, weekly, or short-term peak) wasn't named in the error; it usually clears on its own.${when}`,
    suggestedActions: [waitAction, "Switch to a different auth profile temporarily"],
  };
}

export interface BuildEnvelopeInput {
  /** Known error code, or leave undefined to auto-classify from `raw`. */
  code?: string;
  /** Raw error message; used for auto-classification and attached to `raw`. */
  raw?: string;
  /** Overrides any headline from the lookup table. */
  headline?: string;
  /** Overrides any explanation from the lookup table. */
  explanation?: string;
  /** Overrides any suggestedActions from the lookup table. */
  suggestedActions?: string[];
  /** Overrides the fatal flag from the lookup table. */
  fatal?: boolean;
  /** Optional LLM metadata. */
  llm?: LlmCallMeta;
  /** Session key for persistence / retry targeting. */
  sessionKey?: string;
  /**
   * FORK 2026-09-03 — a "retrying automatically" line is a PROMISE, and several
   * entries used to make it unconditionally while nothing anywhere scheduled a
   * retry. Set this to the epoch-ms instant at which a retry is ACTUALLY
   * scheduled and the envelope renders "Retrying automatically at HH:MM" as its
   * first suggested action. Leave it undefined (the default) and the envelope
   * promises nothing. A sibling change supplies it at the sites that really do
   * schedule one; until then the correct rendering is silence, not a guess.
   */
  retryScheduledAt?: number;
  /** As `retryScheduledAt`, when a retry is scheduled but its time is unknown. */
  retryScheduled?: boolean;
  /** Free-form extra context. */
  details?: Record<string, unknown>;
}

/**
 * Build an `ErrorEnvelope` from raw inputs. Either pass `code` directly, or pass
 * `raw` and let `classifyRawErrorMessage` infer one. Any field from the lookup
 * entry can be overridden per-call.
 */
export function buildErrorEnvelope(input: BuildEnvelopeInput): ErrorEnvelope {
  const raw = input.raw?.trim() ?? "";
  const code = input.code ?? classifyRawErrorMessage(raw);
  const entry = lookup(code);
  // For a genuine user rate-limit, name the precise window (5-hour / weekly /
  // peak) from the raw message rather than the generic static text. Skipped when
  // the caller supplied its own explanation.
  let headline = input.headline ?? entry.headline;
  let explanation = input.explanation ?? entry.explanation;
  let suggestedActions = input.suggestedActions ?? entry.suggestedActions;
  if (code === "rate_limited" && input.explanation === undefined && raw) {
    const detail = rateLimitDetail(raw);
    explanation = detail.explanation;
    if (input.suggestedActions === undefined) suggestedActions = detail.suggestedActions;
  }
  // FORK 2026-09-03: surface the parsed SIGTERM cause. MERGED into any caller
  // `details` (real callers pass `source`, `code`, `laneDepth`, `runId`), and
  // only when a cause was actually stamped — never invent a `details` object.
  let details = input.details;
  const killed =
    raw !== "" && /claude subprocess exited/i.test(raw) && /\breason=\[/.test(raw)
      ? killCauseFromRaw(raw)
      : null;
  if (killed) {
    details = { ...(details ?? {}), killCause: killed.cause, killCauseText: killed.text };
    // Name the silence the producer measured: "for 300 s" is what turns a vague
    // cut into something the user can act on. The number lives only in the
    // cause text, which is why worker.ts forwards it verbatim.
    if (code === "tinker_bridge_idle_timeout" && input.headline === undefined) {
      const secs = idleSecondsFromCause(killed.text);
      if (secs !== null) {
        headline = `No response from the model for ${secs} s — the turn was cut`;
      }
    }
  }
  // FORK 2026-09-03: the ONLY place a "retrying automatically" promise may be
  // made, and only because the caller passed evidence that a retry exists.
  // Default (no flag) = no promise. Do not move this into the lookup table.
  if (
    input.suggestedActions === undefined &&
    !suggestedActions.some((a) => /^retrying automatically/i.test(a))
  ) {
    const retryAction =
      typeof input.retryScheduledAt === "number" && Number.isFinite(input.retryScheduledAt)
        ? `Retrying automatically at ${hhmm(input.retryScheduledAt)}`
        : input.retryScheduled === true
          ? "Retrying automatically"
          : null;
    if (retryAction) {
      suggestedActions = [retryAction, ...suggestedActions];
    }
  }
  return {
    kind: "error",
    id: makeId(),
    fatal: input.fatal ?? entry.fatal,
    category: entry.category,
    headline,
    explanation,
    suggestedActions,
    icon: entry.icon,
    llm: input.llm,
    sessionKey: input.sessionKey,
    raw: raw || undefined,
    details,
    timestamp: new Date().toISOString(),
  };
}
