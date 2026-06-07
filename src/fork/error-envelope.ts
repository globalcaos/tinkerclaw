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
 * Emitted by: worker streams (cc-bridge, ollama, anthropic), agent-runner
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
    explanation:
      "The provider is rate-limiting requests. The exact window (5-hour, weekly, or short-term peak) is named from the error when the provider includes it.",
    suggestedActions: [
      "Wait for the limit to reset — automatic retry is in progress",
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
  // FORK (2026-04-21): cc-bridge subprocess exit codes. Before this, any claude
  // subprocess exit got classified as generic "Provider error" which made it
  // impossible to tell a benign gateway-restart kill (SIGTERM) from a real
  // Anthropic rejection. Now we name each exit path.
  cc_bridge_sigterm: {
    category: "provider_error",
    fatal: false,
    headline: "Gateway restarted",
    explanation:
      "Your previous turn was interrupted by a gateway restart — not a provider or auth problem. I'm resuming it automatically; any partial text above is what streamed before the interruption.",
    suggestedActions: [],
    // 🔌 plug — interrupted externally
    icon: "🔌",
  },
  cc_bridge_sigkill: {
    category: "provider_error",
    fatal: false,
    headline: "Turn interrupted to free memory",
    explanation:
      "The turn was stopped to reclaim memory — not a provider or auth issue. I'm resuming it automatically. If it keeps happening, the gateway is running tight on memory.",
    suggestedActions: [],
    // 💀 skull — hard kill
    icon: "💀",
  },
  cc_bridge_silent: {
    category: "timeout",
    fatal: false,
    headline: "Turn stalled — restarting it",
    explanation:
      "The assistant stopped producing output for longer than the watchdog allows, usually a hung tool call or a slow network wait. I restarted it on a fresh worker and am continuing.",
    suggestedActions: [],
    // 🔇 muted — no output
    icon: "🔇",
  },
  cc_bridge_nonzero_exit: {
    category: "provider_error",
    fatal: true,
    headline: "The assistant process crashed",
    explanation:
      "The underlying `claude` process exited unexpectedly mid-turn. I have the error details and am retrying; if this started after a recent `claude` CLI update, rolling that update back usually fixes it.",
    suggestedActions: ["If this began after a `claude` CLI update, roll the update back"],
    // 💥 collision — process crashed
    icon: "💥",
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

/** Opportunistically classify a raw error message into one of the known codes. */
export function classifyRawErrorMessage(raw: string): string {
  const s = raw.toLowerCase();
  // FORK (2026-04-21): cc-bridge subprocess-exit patterns. Check these BEFORE
  // the generic provider patterns — a SIGTERM-killed claude CLI says nothing
  // about Anthropic, but its raw string contains words like "exit" that
  // shouldn't be miscategorised as provider_generic.
  // Shapes we see in worker.ts::onExit:
  //   "claude subprocess exited (code=143 signal=null) stderr=…"
  //   "claude subprocess exited (code=137 signal=null) stderr=…"
  //   "claude subprocess exited (code=null signal=SIGTERM) stderr=…"
  if (/claude subprocess exited/.test(s)) {
    if (/code=143\b|signal=sigterm/.test(s)) {
      return "cc_bridge_sigterm";
    }
    if (/code=137\b|signal=sigkill/.test(s)) {
      return "cc_bridge_sigkill";
    }
    return "cc_bridge_nonzero_exit";
  }
  if (/claude silent for \d+s|watchdog.*claude/.test(s)) {
    return "cc_bridge_silent";
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
  if (/rate.?limit|\b429\b|usage limits|too many requests/.test(s)) {
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
  return "provider_generic";
}

/**
 * Pin down WHICH rate limit was hit — the rolling 5-hour window, the weekly
 * window, or a short-term per-minute peak — from the raw provider message, so the
 * card states the precise cause instead of a blanket "quota exhausted". (Anthropic
 * server-side 529 limiting is handled separately as `overloaded`, not here.)
 */
export function rateLimitDetail(raw: string): {
  explanation: string;
  suggestedActions: string[];
} {
  const s = raw.toLowerCase();
  const m = raw.match(/(?:retry|try again|reset)[^0-9]{0,12}(\d+)\s*s/i);
  const when = m ? ` (provider says retry in ${m[1]}s)` : "";
  if (/weekly|per week|7[\s-]?day/.test(s)) {
    return {
      explanation: `You hit the Claude subscription's WEEKLY usage limit${when}. This is your own usage and it clears at the next weekly reset.`,
      suggestedActions: [
        "Wait for the weekly window to reset",
        "Switch to a different auth profile temporarily",
      ],
    };
  }
  if (/5[\s-]?hour|\b5h\b|five[\s-]?hour/.test(s)) {
    return {
      explanation: `You hit the Claude subscription's rolling 5-HOUR usage limit${when}. This is your own usage and it clears at the next 5-hour reset.`,
      suggestedActions: [
        "Wait for the 5-hour window to reset",
        "Switch to a different auth profile temporarily",
      ],
    };
  }
  if (/per minute|requests per|tokens per|too many requests|\b429\b/.test(s)) {
    return {
      explanation: `Short-term PEAK rate limit${when}: too many requests or tokens per minute. This is a burst limit (your peak consumption, not your overall 5-hour or weekly quota) and clears within about a minute.`,
      suggestedActions: [
        "Wait ~60s — automatic retry is in progress",
        "Reduce concurrent requests if this keeps happening",
      ],
    };
  }
  return {
    explanation: `The provider is rate-limiting requests${when}. The exact window (5-hour, weekly, or short-term peak) wasn't named in the error; it usually clears on its own.`,
    suggestedActions: [
      "Wait for the limit to reset — automatic retry is in progress",
      "Switch to a different auth profile temporarily",
    ],
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
  let explanation = input.explanation ?? entry.explanation;
  let suggestedActions = input.suggestedActions ?? entry.suggestedActions;
  if (code === "rate_limited" && input.explanation === undefined && raw) {
    const detail = rateLimitDetail(raw);
    explanation = detail.explanation;
    if (input.suggestedActions === undefined) suggestedActions = detail.suggestedActions;
  }
  return {
    kind: "error",
    id: makeId(),
    fatal: input.fatal ?? entry.fatal,
    category: entry.category,
    headline: input.headline ?? entry.headline,
    explanation,
    suggestedActions,
    icon: entry.icon,
    llm: input.llm,
    sessionKey: input.sessionKey,
    raw: raw || undefined,
    details: input.details,
    timestamp: new Date().toISOString(),
  };
}
