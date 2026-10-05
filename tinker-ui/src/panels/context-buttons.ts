// FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.2 step B4; principle P8;
// findings F10, F11) — the availability model of the CONTEXT WINDOW panel's two manual buttons,
// EVICT and COMPACT, as pure functions that the painter AND the click handler in app.ts both ask.
// FORK 2026-09-25 (§6.2 B3 unit) — and the busy PULSE's transition on one A1 compaction event
// (compactionPulseStep), for the same reason: the shapes the bridge's A3 sends (an `end` with no
// `start`, an `end` with completed:false) are pinned in context-buttons.test.ts, not in app.ts.
// FORK 2026-09-25 (§6.1 A6, the owner's decision: option (i)) — and COMPACT's route on a lane that
// owns its context (cacheActRoute): the claude CLI's own `/compact`, sent as a TURN and only
// between turns, with its result toast read off the CLI's A1 `end` (cliCompactionToast), since that
// route has no RPC reply to read.
//
// WHY A MODULE. F10: the buttons were always enabled — whatever the lane (a gateway-side evict or
// compact does not shrink a claude-code session's next call, F1 / F2), whether a run was live (the
// RPC interrupts it, silently), whether anything was evictable, whether a session was attached.
// P8: a button acts on what the model actually sees, and SAYS when it cannot. That is a decision
// with a handful of inputs and one answer, and app.ts has no unit harness, so the rule lives here,
// where context-buttons.test.ts pins every branch; app.ts only gathers the inputs and paints.
//
// MECHANISM: CODE (design-principles #22). Every input has a structural producer (the session row,
// the model pin, the run set, the A1 compaction stream, the RPC reply) and the want is consistency:
// the same facts give the same button, every time.
//
// NOT HERE, on purpose: the DOM, the clock, app.ts state. Every input is a parameter, `now`
// included, so the tests need no fake timers.

/**
 * The two manual actions — the values of the buttons' `data-cache-act` attribute.
 *
 * FORK 2026-09-24 (logging.md §4.7 `ui.context.action`) — also that row's closed `label` set, so
 * the type is DERIVED from the list: a third action cannot join the type and be missing from the
 * set event-ingest.ts accepts (which would refuse every row it produced, silently).
 */
export const CACHE_ACTS = Object.freeze(["evict", "compact"] as const);
export type CacheAct = (typeof CACHE_ACTS)[number];

/**
 * What each button does: the first paragraph of its tooltip in every state. The static markup in
 * app.ts interpolates it too, so the text has one owner.
 */
export const CACHE_ACT_DESCRIPTION: Readonly<Record<CacheAct, string>> = {
  evict:
    "Drop the oldest turns from this session transcript. No model call; the previous transcript is archived as a .bak first.",
  compact: "Summarise the conversation into a shorter prefix. Costs a model call.",
};

/**
 * FORK 2026-09-25 (§6.1 A6) — COMPACT's first paragraph on a lane that owns its context, where a
 * press is the CLI's own `/compact` rather than the gateway's summary. It lives beside
 * CACHE_ACT_DESCRIPTION so the button's copy keeps one owner.
 */
export const CLI_COMPACT_DESCRIPTION =
  "Send /compact to the CLI, which summarises its own conversation into a shorter prefix. Runs as a turn and costs a model call.";

/**
 * FORK 2026-09-25 (§6.1 A6) — the turn a COMPACT press sends on that lane: the claude CLI's own
 * command, BARE. Whatever follows `/compact` is read as the compaction's instructions (by the CLI,
 * and by the gateway's extractCompactInstructions), so no per-turn suffix may follow it: see
 * isCompactCommand.
 */
export const CLI_COMPACT_COMMAND = "/compact";

/**
 * FORK 2026-09-25 (§6.1 A6) — why COMPACT is off on that lane while a turn runs: the CLI compacts
 * between turns, and a mid-turn `/compact` is not a command (the owner's decision). So there is no
 * counterpart to the RPC branches' two-press confirm, which exists because they interrupt the turn.
 */
export const CLI_COMPACT_BUSY_REASON =
  "wait for the turn to finish — the CLI compacts between turns";

/**
 * FORK 2026-09-25 (§6.1 A6) — is this prompt the compaction command: `/compact` alone, or followed
 * by its instructions? Such a prompt goes out with no per-turn suffix (app.ts buildInjectedPrompt),
 * typed or pressed, on every lane, because the suffix would become the instructions. "/compactor",
 * or a `/compact` that does not start the text, is an ordinary prompt.
 */
export function isCompactCommand(text: string): boolean {
  return /^\/compact(?=$|[\s:])/i.test(nonBlank(text));
}

/**
 * Providers whose runtime keeps its OWN copy of the session's context, so rewriting the gateway
 * transcript cannot shrink the next call (context-window-panel.md F1 / F2).
 *
 * This mirrors the one id the gateway's resolveContextOwningRuntime (src/gateway/session-eviction.ts)
 * names statically. The gateway ALSO refuses every registered CLI backend, through isCliProvider
 * over the live config, which the UI does not have. Such a press still reaches the gateway, is
 * refused there BEFORE any run is interrupted, and the refusal comes back in the result toast.
 * Listing guessed CLI ids here instead would be a guessed predicate standing in for a checkable one.
 */
export const CONTEXT_OWNING_PROVIDERS: ReadonlySet<string> = new Set(["claude-code"]);

/**
 * The longest a compaction `start` is believed without its `end`. Past it the panel stops pulsing
 * and re-enables the buttons: a lost `end` (a gateway restart mid-compaction, a dropped socket) must
 * not pulse, nor lock the buttons, forever. It clears the longest compaction measured on this
 * deployment — the claude CLI's own, 121–217 s (context-window-panel.md §3) — and the COMPACT
 * RPC's 180 s timeout, with room to spare.
 */
export const COMPACTION_LIVE_MAX_MS = 10 * 60_000;

/** How long a first press on a busy session stays armed, waiting for the confirming second one. */
export const CACHE_ACT_CONFIRM_WINDOW_MS = 4_000;

function nonBlank(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The context-owning runtime a provider id names, or undefined on a lane where the gateway's
 * transcript IS the model's context (and on an unknown lane: unknown is not a verdict, P10).
 */
export function contextOwningLane(provider: string | undefined): string | undefined {
  const id = nonBlank(provider).toLowerCase();
  return id && CONTEXT_OWNING_PROVIDERS.has(id) ? id : undefined;
}

/** Where a FIRED press goes: the gateway's sessions.compact, or a `/compact` turn to the CLI. */
export type CacheActRoute = "rpc" | "cli-turn";

/**
 * FORK 2026-09-25 (§6.1 A6, the owner's decision: option (i)) — the route a press takes. COMPACT on
 * a lane that owns its context is a "cli-turn": the CLI's own `/compact` (CLI_COMPACT_COMMAND),
 * sent through the prompt path, because sessions.compact would compact the gateway's mirror, which
 * that runtime never reads (F2). Everything else is the sessions.compact "rpc", EVICT on that lane
 * included: buttonState keeps it disabled there, and the gateway refuses it (session-eviction.ts).
 * buttonState and the click handler both ask this, so the lane that enabled the button is the
 * route the press takes.
 */
export function cacheActRoute(act: CacheAct, provider: string | undefined): CacheActRoute {
  return act === "compact" && contextOwningLane(provider) ? "cli-turn" : "rpc";
}

export type NextCallProviderInputs = {
  /** The tab's client-side model pin: a provider-qualified catalog id ("claude-code/claude-opus-5"). */
  clientPin?: string;
  /** The session row's DURABLE pin provider (serverPinOf(...).provider in session-model-pin.ts). */
  durablePinProvider?: string;
  /** The provider that served the session's last call (the row's, else the panel's measured one). */
  servedProvider?: string;
};

/**
 * The provider the viewed session's NEXT call goes to, as far as the UI can tell — P8's question,
 * which is not "where did the last call run".
 *
 * Order: the tab's client pin (its provider is the segment before the FIRST slash, the split
 * renderCachePanel uses), then the row's durable pin, then the provider that served last. The last
 * two are the order the gateway's resolveSessionModelRef applies (override, then runtime), which is
 * what decides whether the gateway refuses an eviction. Nothing known returns undefined.
 */
export function resolveNextCallProvider(inputs: NextCallProviderInputs): string | undefined {
  const pin = nonBlank(inputs.clientPin);
  const slash = pin.indexOf("/");
  if (slash > 0) {
    return pin.slice(0, slash);
  }
  return nonBlank(inputs.durablePinProvider) || nonBlank(inputs.servedProvider) || undefined;
}

export type CacheButtonInputs = {
  act: CacheAct;
  /** The viewed session's key; empty or absent when no session is attached to the tab. */
  sessionKey?: string | null;
  /** resolveNextCallProvider's answer for the viewed session. */
  provider?: string;
  /** A button RPC already in flight on the viewed session, and which one. */
  inFlight?: CacheAct;
  /** A compaction the A1 stream reports running on the viewed session (start seen, no end, not stale). */
  compactionLive?: { trigger?: string };
  /**
   * The gateway's own answer, on this session's last press of THIS button, that there was nothing
   * to do. The host clears it on the session's next run.
   */
  nothingToDo?: string;
  /**
   * The viewed session has a turn in flight. Both RPC branches interrupt it; the CLI route waits
   * for it to end.
   */
  busy: boolean;
  /** A first press on this button is armed and still inside its confirm window. */
  armed?: boolean;
};

export type CacheButtonState = {
  act: CacheAct;
  disabled: boolean;
  /** Why the button is disabled. Present exactly when it is disabled. */
  reason?: string;
  /** Enabled, but the session is busy: the first press arms, a second inside the window fires. */
  confirm: boolean;
  /** The button's text. */
  label: string;
  /** The whole tooltip: what the button does, then why it is off or what a press will do. */
  title: string;
};

function disabledState(
  act: CacheAct,
  reason: string,
  description = CACHE_ACT_DESCRIPTION[act],
): CacheButtonState {
  return {
    act,
    disabled: true,
    reason,
    confirm: false,
    label: act,
    title: `${description}\n\nUnavailable: ${reason}.`,
  };
}

/**
 * P8 — may this button act on the viewed session, and if not, why. Pure; the first match wins,
 * most fundamental first:
 *   1. no session attached — nothing to act on;
 *   2. the lane owns its context (claude-code). EVICT is off: it would not shrink the next call,
 *      and the gateway refuses it there (session-eviction.ts). COMPACT takes the CLI route
 *      (cacheActRoute; A6, the owner's decision 2026-09-25, option (i)): the CLI's own `/compact`,
 *      sent as a turn, since the gateway's compaction would compact its mirror (F2). Rules 3 and 4
 *      still apply to it; after them it is OFF while a turn runs (CLI_COMPACT_BUSY_REASON) rather
 *      than behind the two-press confirm, and enabled when the session is idle. Rule 5 does not
 *      apply to it: a "nothing to do" was the gateway's answer about the gateway's transcript;
 *   3. a button RPC is already in flight on this session — a second one would race the first over
 *      one transcript, so BOTH buttons go off, not just the pressed one;
 *   4. the A1 stream reports a compaction running on this session — the same race, with an
 *      executor the UI did not start;
 *   5. the gateway said, on this button's last press, there was nothing to do. Measured, not
 *      guessed: the UI holds no reliable message count (the chat window is bounded), so it asks the
 *      one producer that knows, and the answer holds until the next run changes the transcript.
 * Otherwise enabled, with `confirm` when the session is busy, because both RPC branches interrupt
 * the running turn (F1's silent side effect). The confirm is non-blocking: see cacheActPress.
 */
export function buttonState(inputs: CacheButtonInputs): CacheButtonState {
  const { act } = inputs;
  if (!nonBlank(inputs.sessionKey)) {
    return disabledState(act, "no session is attached to this tab");
  }
  const lane = contextOwningLane(inputs.provider);
  if (lane && act === "evict") {
    return disabledState(
      act,
      `the ${lane} runtime keeps its own copy of this session's context, so evicting the gateway transcript would not shrink the next call`,
    );
  }
  // Rule 2's other half: on that lane COMPACT is the CLI's own `/compact`, and its tooltip says so.
  const cliTurn = cacheActRoute(act, inputs.provider) === "cli-turn";
  const description = cliTurn ? CLI_COMPACT_DESCRIPTION : CACHE_ACT_DESCRIPTION[act];
  if (inputs.inFlight) {
    return disabledState(
      act,
      `${inputs.inFlight === "evict" ? "an eviction" : "a compaction"} is already running on this session`,
      description,
    );
  }
  if (inputs.compactionLive) {
    const trigger = nonBlank(inputs.compactionLive.trigger);
    return disabledState(
      act,
      `a compaction is running on this session${trigger ? ` (trigger: ${trigger})` : ""}`,
      description,
    );
  }
  if (cliTurn) {
    return inputs.busy
      ? disabledState(act, CLI_COMPACT_BUSY_REASON, description)
      : { act, disabled: false, confirm: false, label: act, title: description };
  }
  const nothing = nonBlank(inputs.nothingToDo);
  if (nothing) {
    return disabledState(
      act,
      `the last ${act} found nothing to do (${nothing}); checked again after the next model call`,
    );
  }
  if (!inputs.busy) {
    return { act, disabled: false, confirm: false, label: act, title: description };
  }
  if (inputs.armed) {
    return {
      act,
      disabled: false,
      confirm: true,
      label: "sure?",
      title: `${description}\n\nPress again now to ${act}: the turn running on this session will be interrupted.`,
    };
  }
  return {
    act,
    disabled: false,
    confirm: true,
    label: act,
    title: `${description}\n\nThis session is busy and ${act} interrupts the running turn: the first press asks for confirmation, a second within ${CACHE_ACT_CONFIRM_WINDOW_MS / 1000} s goes ahead.`,
  };
}

/** True while a first press made at `armedAt` still waits for its confirming second press. */
export function cacheActArmed(armedAt: number | undefined, now: number): boolean {
  if (armedAt === undefined || !Number.isFinite(armedAt)) {
    return false;
  }
  const age = now - armedAt;
  return age >= 0 && age <= CACHE_ACT_CONFIRM_WINDOW_MS;
}

export type CacheActPress = "fire" | "arm" | "ignore";

/**
 * What a press does — the NON-BLOCKING confirm. On a busy session the first press only ARMS the
 * button (its label becomes "sure?" and a toast says why) and a second press inside the window
 * fires. Nothing modal: window.confirm would freeze every stream handler on the page, including
 * the one that could report the turn ending and make the question moot. "ignore" is a press on a
 * button whose state changed after it was painted (the host re-paints and says why).
 */
export function cacheActPress(
  state: CacheButtonState,
  armedAt: number | undefined,
  now: number,
): CacheActPress {
  if (state.disabled) {
    return "ignore";
  }
  if (!state.confirm) {
    return "fire";
  }
  return cacheActArmed(armedAt, now) ? "fire" : "arm";
}

/** Is a compaction whose `start` arrived at `startedAt` still running, as far as the UI may believe? */
export function compactionIsLive(startedAt: number | undefined, now: number): boolean {
  if (startedAt === undefined || !Number.isFinite(startedAt)) {
    return false;
  }
  return now - startedAt < COMPACTION_LIVE_MAX_MS;
}

/** A compaction `start` the panel believes is running on one session: when it arrived, who ran it. */
export type CompactionLiveMark = { at: number; trigger?: string };

/** What one A1 compaction event does to its session's busy PULSE. */
export type CompactionPulseStep =
  | { kind: "start"; next: CompactionLiveMark }
  | { kind: "end" }
  | { kind: "ignore" };

/**
 * The PULSE's transition on one A1 `stream:"compaction"` payload (B4, F11), given the session's
 * current mark. Pure, so every shape the producers send is pinned by context-buttons.test.ts:
 *   - `start` keeps the FIRST stamp of a compaction still believed live, so an executor that
 *     repeats its start cannot extend its life; a stale mark (compactionIsLive) is replaced.
 *   - `end` ENDS the pulse, whatever else it says. With no `start` before it (a CLI boundary with
 *     no `compacting` line before it, or a start this page never saw) it ends nothing and is not
 *     an error. With completed:false (a failed CLI compaction, which the bridge's A3 reports from a
 *     status line rather than a boundary; pi's retry; a refused eviction) the compaction is over
 *     all the same. Whether an `end` COUNTS is not this function's question:
 *     context-counters.ts compactionDrop answers that.
 *   - anything else is not the contract, so it may neither start nor stop the pulse.
 */
export function compactionPulseStep(
  prev: CompactionLiveMark | undefined,
  data: unknown,
  now: number,
): CompactionPulseStep {
  const d = (data && typeof data === "object" ? data : {}) as {
    phase?: unknown;
    trigger?: unknown;
  };
  if (d.phase === "start") {
    if (prev && compactionIsLive(prev.at, now)) {
      return { kind: "start", next: prev };
    }
    const trigger = nonBlank(d.trigger);
    return { kind: "start", next: trigger ? { at: now, trigger } : { at: now } };
  }
  if (d.phase === "end") {
    return { kind: "end" };
  }
  return { kind: "ignore" };
}

/**
 * The fields of a `sessions.compact` reply this panel reads: SessionEvictionReply
 * (src/gateway/session-eviction.ts) for EVICT, the narrative branch of sessions.ts for COMPACT.
 */
export type CacheActReply = {
  ok?: unknown;
  compacted?: unknown;
  reason?: unknown;
  evictedTokens?: unknown;
  tokensBefore?: unknown;
  tokensAfter?: unknown;
};

export type CacheActToast = {
  text: string;
  isError: boolean;
  /** Set when the gateway answered "nothing to do": the reason, for buttonState's `nothingToDo`. */
  nothingToDo?: string;
};

/** A finite count >= 0, else undefined: absent is not zero (P10), a measured 0 is a real 0. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * FORK 2026-09-24 (logging.md §4.7 `ui.context.action`) — what a FIRED press came to: that row's
 * `result`, a closed set.
 */
export const CACHE_ACT_OUTCOMES = Object.freeze(["ok", "error", "noop"] as const);
export type CacheActOutcome = (typeof CACHE_ACT_OUTCOMES)[number];

/**
 * A reply's result class — the ONE classification the toast below and the recorded row both read,
 * so the two cannot disagree:
 *   error  the gateway refused or failed (`ok: false`). A call that REJECTED (timeout, closed
 *          socket) is "error" too, decided by the caller, the only one that sees the rejection;
 *   noop   it answered that there was nothing to do (`compacted` falsy), or said nothing at all;
 *   ok     it evicted or compacted.
 */
export function cacheActOutcome(reply: unknown): CacheActOutcome {
  const r = (reply && typeof reply === "object" ? reply : {}) as CacheActReply;
  if (r.ok === false) {
    return "error";
  }
  return r.compacted ? "ok" : "noop";
}

/**
 * The result toast, from the reply alone (P8: the result reports the before → after of the
 * model-visible context).
 *
 * EVICT replies carry tokensBefore / tokensAfter, both ESTIMATES on the anatomy's estimator over
 * what the model is sent (session-eviction.ts, P11), so the toast says "estimated". COMPACT replies
 * carry tokensAfter and the engine's own evictedTokens, and no top-level tokensBefore. The nested
 * `result.tokensBefore` is deliberately NOT read: sessions.ts measured it as a store-wide running
 * total, not this session's prefix, so a before → after built from it would be a lie. What
 * tokensAfter measures on that branch is still open (context-window-panel.md U4).
 */
export function cacheActResultToast(act: CacheAct, reply: unknown): CacheActToast {
  const r = (reply && typeof reply === "object" ? reply : {}) as CacheActReply;
  const reason = nonBlank(r.reason);
  const outcome = cacheActOutcome(r);
  if (outcome === "error") {
    // A refusal or a failure — never remembered as "nothing to do": the next press may succeed.
    return {
      text: `Could not ${act}: ${reason || "the gateway declined without a reason"}`,
      isError: true,
    };
  }
  if (outcome === "noop") {
    return {
      text: `Nothing to ${act}${reason ? `: ${reason}` : ""}`,
      isError: false,
      nothingToDo: reason || "the gateway reported nothing to do",
    };
  }
  const verb = act === "evict" ? "Evicted" : "Compacted";
  const provenance = act === "evict" ? " (estimated)" : "";
  const before = tokenCount(r.tokensBefore);
  const after = tokenCount(r.tokensAfter);
  const freed = tokenCount(r.evictedTokens);
  const freedText = freed !== undefined && freed > 0 ? `, ${fmtTokens(freed)} freed` : "";
  if (before !== undefined && after !== undefined) {
    return {
      text: `${verb}: ${fmtTokens(before)} → ${fmtTokens(after)} tokens${provenance}${freedText}`,
      isError: false,
    };
  }
  if (after !== undefined) {
    return {
      text: `${verb}: now ${fmtTokens(after)} tokens${provenance}${freedText}`,
      isError: false,
    };
  }
  if (freed !== undefined && freed > 0) {
    return { text: `${verb} — ${fmtTokens(freed)} tokens freed${provenance}`, isError: false };
  }
  return { text: `${verb} — context window refreshed`, isError: false };
}

/**
 * FORK 2026-09-25 (§6.1 A6) — the result toast of a compaction the claude CLI ran, read off its A1
 * `end` (the bridge's A3: trigger "cli-internal", provenance "exact", tokensBefore / tokensAfter
 * from compact_boundary's pre_tokens / post_tokens). On the claude-code lane a COMPACT press is a
 * `/compact` TURN, so no RPC reply comes back to toast from: this `end` is the result.
 *
 * Null for anything else: a `start`, another executor's `end` (a press on an embedded lane toasts
 * from its reply, cacheActResultToast), an `end` whose `completed` is not a boolean, or a shape
 * outside the contract. Every CLI `end` of the viewed session toasts, the CLI's automatic ones
 * included: the pulse already shows each one running, and its end is the same news whoever asked.
 * Figures are shown only under provenance "exact", context-counters.ts rule 4's bar.
 */
export function cliCompactionToast(data: unknown): CacheActToast | null {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (d.phase !== "end" || d.trigger !== "cli-internal") {
    return null;
  }
  if (d.completed === false) {
    return {
      text: "CLI compaction failed: the CLI gave it up and wrote no compaction boundary",
      isError: true,
    };
  }
  if (d.completed !== true) {
    return null;
  }
  const exact = d.provenance === "exact";
  const before = exact ? tokenCount(d.tokensBefore) : undefined;
  const after = exact ? tokenCount(d.tokensAfter) : undefined;
  if (before !== undefined && after !== undefined) {
    return {
      text: `CLI compacted: ${fmtTokens(before)} → ${fmtTokens(after)} tokens`,
      isError: false,
    };
  }
  if (before !== undefined) {
    return { text: `CLI compacted: from ${fmtTokens(before)} tokens`, isError: false };
  }
  return { text: "CLI compacted — no token figures reported", isError: false };
}
