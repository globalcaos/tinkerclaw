// FORK 2026-07-29 (the architect: "I see the tab glowing, the session row glowing and the model glowing
// with one concurrency — but when I jump into the tab there is no thinking indicator. These
// mechanisms should all be governed by the same trigger").
//
// THE LANES, as measured on the live gateway before this module existed:
//
//   A. server session-store `status`  — sessions.list -> the UI's `sessions[]`. Authoritative
//      WHEN PRESENT, but measured 2026-07-29: {running:1, done:250, failed:4, undefined:61}.
//      61 of 315 rows carry NO status at all.
//   B. server run-queue state         — the `[diagnostic] stuck session ... state=processing`
//      log. Observed disagreeing with lane A on the SAME session: store said status="done"
//      with endedAt set, while the queue still reported state=processing 2441s later.
//   C. client `activeRuns` map        — every write is viewed-gated, and an entry is orphaned
//      whenever a lifecycle:end is dropped by that same gate. Only `sweepDeadEegBranches`
//      ever removes stale entries, and only for SUBAGENT runs, and only while the EEG panel
//      renders. Main-run ghosts are never swept.
//
// Four surfaces then combined those lanes THREE different ways, using TWO different membership
// predicates — which is exactly why they could disagree:
//
//   chat thinking indicator  -> C only, predicate runBelongsToViewedSession
//   sessions-panel row glow  -> A if `typeof status === "string"`, else C, predicate sessionKeyMatches
//   tab title glow           -> same as the row glow
//   models-panel count       -> max(A, C) — a third rule, so one stale C entry pinned it at 1
//
// This module is the SINGLE REFERENCE POINT. One precedence rule, one membership predicate, one
// freshness bound, one model-count derivation. Surfaces must not re-derive any of it.
//
// FORK 2026-08-15 — ONE ORACLE IS NOT ENOUGH. Every surface governed by this module must also
// REPAINT ON THE SAME TRIGGER. A surface that reads the server lane but is repainted only by
// client-lane events holds a stale answer indefinitely — which is indistinguishable, from the
// outside, from disagreeing with the other surfaces. It is not late; nothing will ever correct
// it. That is exactly what happened to the chat thinking indicator: the 2026-07-29 unification
// fixed the PREDICATE and left the TRIGGER, so the tab glowed on a 5s clock while the chat,
// which has no clock, stayed blank for turns it did not originate (cron, WhatsApp, another tab,
// an orchestrator leg). Analysis: docs/2026-08-15-chat-thinking-indicator-missing-while-tab-
// glows.md. Fixed by putting the chat in the same funnel (repaintThinkingIndicator() on
// startLivenessRepaint + loadSessions) and by deleting a duplicated `activeRuns.size > 0`
// gate in app.ts that made the server lane unreachable in the very case it was written for.
//
// FORK 2026-08-15, SAME DAY, THIRD REPORT — ONE ORACLE AND ONE CLOCK ARE STILL NOT ENOUGH.
// the architect: "now I have the opposite problem, the chat one is showing but the rest are mute. Again,
// this all has to be gated from the same structure, they need to be synchronized."
//
// Two more gaps, both of which let a surface answer a question this module never asked:
//
//   1. A SECOND OPINION. renderThinkingIndicator's rich-row branch opened with
//      `if (activeRuns.size > 0)` and rendered from the client map WITHOUT calling this module.
//      So the chat asked "does this client hold a fresh entry?" while the other three asked
//      "does the gateway say this session is running?". Those disagree in BOTH directions, and
//      both directions were reported on 2026-08-15: the server lane unreachable in the morning,
//      the chat lighting alone in the evening. Fixing one direction at a time is what produced
//      the second report. The chat now resolves ONE verdict at the top and every branch below
//      only decorates it.
//
//   2. A SECOND ACTIVITY STATE. `live` is not the whole of "this session is working". The
//      pre-model window — turn accepted, prompt being assembled, no model call open yet — is
//      21-36s (turn-latency.md) and was known ONLY to the chat, as an inline `sending &&
//      !viewedSessionBusy()`. This module correctly says "not live" for it, so the tab and row
//      stayed dark while the chat showed a pill. Now consumed by the chat, the tab glow and the
//      row glow alike. It is deliberately NOT in this module: the gateway's run set genuinely
//      does not know about this window, and putting it here would make this resolver answer for
//      a lane it cannot see.
//
//      FORK 2026-08-17 — but it is no longer VIEWED-scoped. This note used to justify its
//      exclusion as "client-local knowledge about the viewed tab", and app.ts took that
//      literally: `pending` lived in the `sending` boolean and `tabsRunningNow()` granted the
//      glow only to `tab.id === activeTabId`, so sending a prompt and switching away blanked
//      the tab you left for the whole 21-36s window (the architect: "when I switch tabs, the progress
//      indicator on the tab titles that are not focused should not go away"). It is now keyed by
//      SESSION in pre-model-window.ts, exactly like `sessionEndedAt`, so every surface can ask
//      about every session. Client-local, yes; viewed-local, no — those are different claims and
//      conflating them cost a sixth report.
//
// THE RULE, in three parts. All three are required; each has now shipped alone and been wrong:
//   ONE PREDICATE — every surface asks resolveSessionRunState. No surface re-derives liveness.
//   ONE TRIGGER   — every surface repaints from repaintActivitySurfaces() (app.ts). A shared
//                   predicate on four schedules desyncs exactly as badly as four predicates.
//   ONE STATE SET — {live, pending}. A surface that knows only `live` is dark for the whole
//                   pre-model window while a surface that knows both is lit.
//
// The four governed surfaces, all of which must repaint from repaintActivitySurfaces():
//   chat thinking indicator · tab-bar glow · sessions-panel row glow · models-panel count
// (The models-panel count is per-MODEL, so it cannot show `pending`: no model has been chosen
//  yet. That asymmetry is honest and irreducible — do not "fix" it by inventing a model.)

/** A row as `sessions.list` returns it (only the fields liveness depends on). */
export type SessionRow = {
  key?: string;
  status?: string;
  hasActiveSubagentRun?: boolean;
  model?: string | null;
  modelProvider?: string | null;
  /** When the run this row describes began. Lets a claim about a NEW turn outrank an end stamp
   *  from the PREVIOUS one. Legacy path only. */
  startedAt?: number;
  /**
   * THE RUN SET as observed by the gateway PROCESS when this row was built
   * (src/infra/agent-events.ts getSessionRunLiveness, published at session-utils.ts).
   * Authoritative and total: present ⇒ this field alone decides, and `status` is history.
   */
  run?: {
    live: boolean;
    count?: number;
    heartbeatCount?: number;
    since?: number;
    lastActiveAt?: number;
  };
};

/** An `activeRuns` entry (only the fields liveness depends on). */
export type ClientRun = {
  sessionKey?: string;
  provider?: string;
  model?: string;
  startedAt?: number;
  lastEventAt?: number;
};

export type RunStateSource =
  /** the gateway's live run set says a run is open — the authoritative answer */
  | "run-set"
  /** the run set says idle, and no newer client evidence contradicts it */
  | "run-set-idle"
  /** legacy paths below, reachable only against a gateway that does not publish `run` */
  | "server-running"
  | "server-terminal"
  | "client"
  | "unknown";

export type SessionRunState = {
  live: boolean;
  provider?: string;
  model?: string;
  /** Which lane decided. Exposed so a surface can be debugged without guessing. */
  source: RunStateSource;
};

/**
 * How long a client entry may go silent before it stops counting as evidence of life.
 *
 * Same 90s bound `sweepDeadEegBranches` already used for subagent branches — lifted here so it
 * governs every surface instead of only the EEG panel. A legitimately long turn keeps emitting
 * events (deltas, tool frames) and so keeps refreshing `lastEventAt`; a turn whose end event was
 * dropped goes silent immediately, which is precisely the ghost we are killing.
 */
export const RUN_STALE_MS = 90_000;

/** Terminal server statuses — the gateway's SessionRunStatus minus "running". */
const TERMINAL = new Set(["done", "failed", "killed", "timeout"]);

/** Model ids arrive BARE ("claude-opus-4-8") from cc-bridge effort events and provider-PREFIXED
 *  ("claude-code/claude-opus-4-8") from the catalog. Compare on the bare tail wherever they meet. */
export const bareModelTail = (m?: string | null): string | undefined => {
  if (typeof m !== "string" || m.length === 0) {
    return undefined;
  }
  return m.includes("/") ? m.split("/").slice(1).join("/") : m;
};

/**
 * The key a live run is COUNTED under — and the key a catalog row is LOOKED UP by.
 *
 * FORK 2026-08-04 (the architect: one run on `google/gemini-3.1-pro-preview` also lit the zero-traffic
 * `github-copilot/gemini-3.1-pro-preview` row). The models panel deliberately renders ONE ROW PER
 * PROVIDER for the same base model, so the bare tail is not a model identity — it is a whole
 * COLUMN of twins, and keying the count map by it made every twin share a single bucket. Confirmed
 * collisions in the live catalog: gemini-3.1-pro-preview, gemini-3-pro-preview, gemini-2.5-pro,
 * gpt-5.5 (openai-codex + github-copilot), gpt-5.4, gpt-4o.
 *
 * Measured 2026-08-04: `modelProvider` is populated on 258 of 312 live session rows, and every
 * provider string seen in the wild (`claude-code`, `xai`, `codex`, `openai-codex`, `openrouter`,
 * `google`) matches a configured catalog PREFIX exactly. There is no provider aliasing, so exact
 * qualification is safe — a qualified key never has to be matched fuzzily.
 *
 * THE MODEL HALF IS NOT A SINGLE SEGMENT, which is why this does NOT run the id through
 * `bareModelTail` before re-attaching the provider. The gateway parses a ref by splitting at the
 * FIRST slash only (`resolveExactConfiguredProviderRef`, src/agents/model-selection-shared.ts), so
 * `openrouter/moonshotai/kimi-k3` resolves to provider `openrouter` + model `moonshotai/kimi-k3` —
 * a BARE model name that itself contains a slash. Stripping a tail off that would yield the
 * fictional key `openrouter/kimi-k3` and the real row would never light. So:
 *   • the id already begins with `<provider>/` -> it is qualified; keep every remaining segment;
 *   • otherwise -> it is a bare name (of any arity); qualify the WHOLE string.
 * The residual ambiguity is an id carrying a prefix that DISAGREES with its own provider field
 * (`codex/gpt-5.5` alongside provider `openai-codex`). That is a self-inconsistent row, it is not
 * observed in the measured data, and it degrades to "this row does not light" — never to "the
 * wrong row lights", which is the bug being fixed here.
 */
export const modelCountKey = (
  model?: string | null,
  provider?: string | null,
): string | undefined => {
  const id = typeof model === "string" ? model.trim() : "";
  if (!id) {
    return undefined;
  }
  const prov = typeof provider === "string" ? provider.trim() : "";
  if (!prov) {
    // THE IRREDUCIBLE RESIDUE, stated plainly so nobody "finishes the job" by deleting this branch.
    // An event carrying NO provider contains nothing that could tell two twins apart — cc-bridge
    // effort events are exactly that shape (bare `claude-opus-4-8`, no provider at all). Such a run
    // is counted under the bare tail and `liveCountForModel` lets EVERY candidate row claim it, so
    // in this one case the twins still light together. The case is NARROWED (it used to cover all
    // runs; it now covers only the provider-less ones) but NOT CLOSED, and it cannot be closed from
    // here: closing it requires the event itself to carry a provider.
    return bareModelTail(id);
  }
  return id === prov || id.startsWith(`${prov}/`) ? id : `${prov}/${id}`;
};

/** Has this client run emitted anything recently enough to still be believed? */
export function clientRunIsFresh(run: ClientRun | undefined | null, now: number): boolean {
  if (!run) {
    return false;
  }
  // No timestamp at all ⇒ written by an older build; assume just-active rather than sweep it.
  const last = run.lastEventAt ?? run.startedAt;
  if (typeof last !== "number") {
    return true;
  }
  return now - last <= RUN_STALE_MS;
}

/** The ONE membership predicate. Takes the reference key explicitly — the old code had one caller
 *  passing it and another relying on an implicit module-global, which is how two surfaces ended up
 *  asking different questions about the same map. */
export type KeyMatcher = (runKey: string, refKey: string) => boolean;

function runsForSession(
  runs: Iterable<ClientRun>,
  sessionKey: string,
  matches: KeyMatcher,
  now: number,
): ClientRun[] {
  const out: ClientRun[] = [];
  for (const run of runs) {
    if (!run?.sessionKey || !matches(run.sessionKey, sessionKey)) {
      continue;
    }
    if (clientRunIsFresh(run, now)) {
      out.push(run);
    }
  }
  return out;
}

/**
 * Does this session hold at least one client run that is still worth believing?
 *
 * THE ONE QUESTION a surface may ask of the raw run map. Every hand-rolled walk of `activeRuns`
 * re-stepped in one of that map's two traps:
 *
 *   1. THE MEMBERSHIP TRAP. A walk written at the call site compares keys its own way — the "one
 *      concept, four derivations" trap (design principle #18). app.ts's `runBelongsToViewedSession`
 *      carries the receipt: the subagent prefix was once derived a second, wrong way, so the Models
 *      badge counted every OTHER tab's subagents on Main and read zero on every other tab.
 *      Ownership is `matches`' job, applied here through `runsForSession` — the single membership
 *      predicate — and it is NOT re-derived in this module, because the subagent half needs the
 *      tab-attribution state (subagent-attribution.ts) run-state.ts deliberately cannot see.
 *   2. THE FRESHNESS TRAP. A bare `runs.size > 0` believes an orphan forever. The live case this
 *      was written for: `hasActiveRunForSession` in the send path (the input to `shouldQueue`) was
 *      a raw `Array.from(activeRuns.values()).some(...)` with no freshness bound at all, so one run
 *      whose `lifecycle:end` was dropped queued every later prompt behind a turn that had already
 *      finished — exactly the ghost `RUN_STALE_MS` exists to kill ("a turn whose end event was
 *      dropped goes silent immediately", in its note above).
 *
 * This is intentionally NOT a liveness verdict. It reports the CLIENT lane only and takes no server
 * row, so it can never contradict `resolveSessionRunState` — but it also cannot replace it. A
 * surface asking "is this session running?" still asks the resolver, which arbitrates every lane.
 * This answers the narrower "does this client hold fresh evidence of its own?", so that asking it no
 * longer means walking the map by hand.
 *
 * Takes the map ENTRIES (a `Map` is one) OR the bare values — both, on purpose. The entry key is the
 * runId and is irrelevant to the question; ownership lives on `run.sessionKey`.
 *
 * FORK 2026-08-28 — WHY THIS ACCEPTS BOTH SHAPES (bug "my prompt vanishes from the box and only
 * shows up seconds later"). The first version took entries only and array-destructured every item:
 * `for (const [, clientRun] of runs)`. Both call sites in app.ts pass `activeRuns.values()`, which
 * yields bare `ActiveRunInfo` OBJECTS — and destructuring an object as an array throws
 * `TypeError: … is not iterable`. The throw landed at the TOP of send() (app.ts, before the bubble
 * push and before `chat.send`), and the composer's keydown handler does not await send(), so it
 * blanked the textarea anyway: the prompt was neither drawn NOR delivered, and only reappeared when
 * the 5 s outbox backstop re-injected it from disk. That is the multi-second delay, and it was a
 * genuinely lost send.
 *
 * It only fired when `activeRuns` was NON-EMPTY — i.e. exactly mid-turn, or whenever one orphaned
 * ghost run lingered (the very ghost this module's freshness bound exists to survive). An idle first
 * prompt iterated zero times and worked, which is why it read as intermittent.
 *
 * The signature was correct and the call sites were wrong, but a helper whose contract is "the shape
 * callers hold" must not be the thing that decides a prompt is lost. `ClientRun` is an object type
 * and is never an array, so an entry and a bare run are unambiguously distinguishable — normalise per
 * item and neither call site can be wrong again. This is tolerance at ONE boundary, not a second
 * derivation: the freshness question is still answered only by `runsForSession`.
 */
export function sessionHasFreshClientRun(params: {
  runs: Iterable<[string, ClientRun]> | Iterable<ClientRun> | Map<string, ClientRun>;
  refKey: string | undefined;
  matches: KeyMatcher;
  now: number;
}): boolean {
  const { runs, refKey, matches, now } = params;
  // No session in view owns nothing — and that includes "". An empty reference key must never
  // degrade into match-all; a matcher built from `endsWith(":" + ref)` answers unpredictably for it.
  if (!refKey) {
    return false;
  }
  const values: ClientRun[] = [];
  for (const item of runs as Iterable<[string, ClientRun] | ClientRun>) {
    // An entry is `[runId, run]`; a bare value is the run itself. ClientRun is never an array.
    values.push(Array.isArray(item) ? item[1] : item);
  }
  // Deliberately delegated rather than early-exited: `runsForSession` IS the derivation, and a
  // private loop here re-testing its two conditions is the second copy this module exists to
  // forbid. The client map holds in-flight runs — tens of entries, not thousands.
  return runsForSession(values, refKey, matches, now).length > 0;
}

/**
 * Is this session running right now? The single answer every surface must use.
 *
 * Precedence, in order:
 *   1. Server says a TERMINAL status  -> not live. This is what unsticks an orphaned client
 *      entry, and it is why the ghost tab/row/count go dark.
 *   2. Server says running (or has an active subagent run) -> live. The client map is consulted
 *      ONLY to colour the glow, never to veto the server.
 *   3. Server said nothing usable (the 61 undefined rows) -> fall back to the client map, but
 *      only to entries that are still FRESH. Previously this branch trusted the map
 *      unconditionally, which is where the ghosts lived.
 */
export function resolveSessionRunState(params: {
  sessionKey: string;
  row?: SessionRow | undefined;
  runs: Iterable<ClientRun>;
  matches: KeyMatcher;
  now: number;
  /** When `row` was fetched (`sessions.list` reply time). A snapshot has no idea what happened
   *  after it was taken. */
  rowsFetchedAt?: number;
  /** When THIS client last saw a terminal chat/lifecycle event for this session. */
  endedAt?: number;
}): SessionRunState {
  const { sessionKey, row, runs, matches, now, rowsFetchedAt, endedAt } = params;
  const status = typeof row?.status === "string" ? row.status : undefined;
  const mine = runsForSession(runs, sessionKey, matches, now);
  // FORK 2026-07-29 (the architect: "the indicator says 'working' without specifying the model").
  // The client map is only ONE place a model can come from, and it is the place most likely to be
  // empty: `activeRuns` entries are created with model:"" and filled later by a lifecycle event,
  // and on the run-set path there is often no client entry at all. The session row already carries
  // the model the gateway is actually using, so fall back to it rather than render "working".
  const decorate = (source: RunStateSource): SessionRunState => ({
    live: true,
    provider: mine[0]?.provider || row?.modelProvider || undefined,
    model: mine[0]?.model || row?.model || undefined,
    source,
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE RUN SET (stage 3). When the gateway publishes `row.run`, it answers TOTALLY — live or
  // idle, never absent — so everything below this block becomes dead weight and is kept only for
  // a gateway too old to send the field.
  //
  // Why this ends the inversions: `status` describes the ARCHIVE (it latches, and was absent on
  // 61 of 348 rows, which is what forced 17.5% of verdicts down into the viewed-gated client map).
  // `run` describes the PROCESS. There is nothing to arbitrate, so every precedence rule that
  // existed to arbitrate — the end-stamp veto, the row-started-after-end guard, the terminal
  // escape hatch, the no-status fallback — is simply not consulted.
  //
  // ONE comparison survives, and it is not arbitration: a row is a snapshot, so a turn that began
  // after it was taken cannot be in it. A client run whose last event is newer than the snapshot
  // is strictly later information about the same session.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  if (row?.run && typeof row.run.live === "boolean") {
    // A row is a snapshot, so a turn that began after it was taken cannot be in it. A client run
    // whose last event is newer than the snapshot is strictly later information about the same
    // session. Computed FIRST because both halves of the branch need it.
    const clientNewerThanSnapshot =
      typeof rowsFetchedAt === "number" &&
      mine.some((r) => typeof r.lastEventAt === "number" && r.lastEventAt > rowsFetchedAt);
    if (row.run.live) {
      // FORK 2026-08-06 (the architect: "qwen 3.8 keeps thinking and Stop does nothing" — recurrence of
      // the 2026-08-05 Grok report, which only patched the LEGACY branches below). The run set
      // is authoritative about the gateway PROCESS, but `row` is still a SNAPSHOT of it taken
      // when sessions.list built the row. A Stop pressed AFTER that moment — the client's
      // sessionEndedAt stamp — is strictly newer evidence, exactly the rule the legacy lane
      // already applies ("a server claim is only believed while it is at least as recent as the
      // client's own knowledge that the session ended"). Before this veto, the branch returned
      // before ANY end-stamp was consulted, so a snapshot still claiming live re-lit the
      // indicator after every Stop for as long as sessions.list lagged the abort — which, during
      // the 2026-08-06 gateway flakiness (abort RPC timing out), meant "forever".
      // The veto lifts by itself: any non-terminal event clears the stamp (a genuinely surviving
      // run re-lights honestly), a successful abort makes the next snapshot say idle, and a NEW
      // turn's client run is newer than the snapshot and passes the guard below.
      const stoppedAfterSnapshot =
        typeof endedAt === "number" && typeof rowsFetchedAt === "number" && endedAt > rowsFetchedAt;
      // FORK 2026-08-20 (the architect: Stop Grok, it spins again). The dying run is
      // still in the process map for hundreds of ms after Stop (Grok stream +
      // a process.poll that ignored abort). sessions.list taken AFTER Stop
      // therefore still says live, and the snapshot-vs-stamp test lifts the
      // veto. A run that BEGAN before Stop is the dying one; a run that began
      // after it is a real new turn.
      const runBeganBeforeStop =
        typeof endedAt === "number" && typeof row.run.since === "number" && row.run.since < endedAt;
      if ((stoppedAfterSnapshot || runBeganBeforeStop) && !clientNewerThanSnapshot) {
        return { live: false, source: "run-set-idle" };
      }
      return decorate("run-set");
    }
    if (clientNewerThanSnapshot) {
      return decorate("client");
    }
    return { live: false, source: "run-set-idle" };
  }

  // FORK 2026-07-29 (the architect: "Main shows a thinking indicator saying working, but the answer
  // finished, even Fractal delivered"). NEWEST EVIDENCE WINS. `sessions[]` is a SNAPSHOT with no
  // fetch time and no automatic refresh at turn end, so a row captured mid-turn keeps claiming
  // "running" long after this client watched the turn finish. Trusting it unconditionally is what
  // pinned a "working" row on a finished chat. A server claim is only believed while it is at
  // least as recent as the client's own knowledge that the session ended.
  //
  // FORK 2026-07-29 (second pass — the architect: "chat thinking indicators but no tab nor sessions
  // highlighting"). The first version compared ONLY `endedAt > rowsFetchedAt`, and an end stamp is
  // never cleared while `rowsFetchedAt` moves only on loadSessions(). So once a session had ended
  // since the last fetch, EVERY later server claim was vetoed — across new turns, indefinitely —
  // and non-viewed tabs went dark while the chat (which reads the client map directly) still lit.
  // A veto must not outlive the turn it refers to: if the row's run began after the end this
  // client saw, the claim is about a NEWER turn and stands.
  const rowStartedAfterEnd =
    typeof row?.startedAt === "number" && typeof endedAt === "number" && row.startedAt > endedAt;
  const serverClaimPredatesEnd =
    typeof endedAt === "number" &&
    typeof rowsFetchedAt === "number" &&
    endedAt > rowsFetchedAt &&
    !rowStartedAfterEnd;

  // FORK 2026-07-29 (third pass — the architect: "no thinking indicator in the chat but yet the llm is
  // spitting out responses"). This branch used to be UNCONDITIONAL, so a terminal status from an
  // arbitrarily old snapshot silenced a client that was streaming deltas right now. That is the
  // same mistake as the veto in the second pass, with the lanes swapped — I guarded one direction
  // and left the other. The principle is symmetric: NEWEST EVIDENCE WINS, whichever lane holds it.
  // A client run whose last event landed AFTER the snapshot was taken is strictly newer than the
  // snapshot's verdict. An orphaned ghost cannot qualify: it went silent by definition, so its
  // lastEventAt predates the fetch (and it is dropped by the freshness bound anyway).
  const clientSeenSinceFetch =
    typeof rowsFetchedAt === "number" &&
    mine.some((r) => typeof r.lastEventAt === "number" && r.lastEventAt > rowsFetchedAt);

  if (status && TERMINAL.has(status) && !clientSeenSinceFetch) {
    return { live: false, source: "server-terminal" };
  }
  if (!serverClaimPredatesEnd && (status === "running" || row?.hasActiveSubagentRun === true)) {
    return decorate("server-running");
  }
  if (serverClaimPredatesEnd && mine.length === 0) {
    // The client watched it end and has no live run of its own: it is over, whatever the stale
    // snapshot says. A fresh client run still wins below (the next turn may already have started).
    return { live: false, source: "server-terminal" };
  }
  if (mine.length > 0) {
    return decorate("client");
  }
  return { live: false, source: status ? "server-terminal" : "unknown" };
}

/**
 * Concurrent live runs per model, keyed by PROVIDER-QUALIFIED model id, across EVERY session.
 *
 * Derived from the same resolver so the models panel cannot disagree with a tab or a row. A
 * session contributes one count under the model that its own lane reports: the server row's model
 * when the server decided, otherwise the client run's. Subagents are not folded into their parent
 * — they carry their own row and their own model.
 *
 * FORK 2026-08-04: the key is `provider/model` (`modelCountKey`), NOT the bare tail. A bare-tail key
 * is shared by every provider serving the same base model, which is how one real run on
 * `google/gemini-3.1-pro-preview` lit the idle `github-copilot/…` row too. Provider-less events
 * still land on the bare tail — see `modelCountKey` for why that residue cannot be removed, and
 * `liveCountForModel` for what it costs at lookup time.
 */
export function liveRunCountsByModel(params: {
  rows: readonly SessionRow[] | null | undefined;
  runs: Iterable<ClientRun>;
  matches: KeyMatcher;
  now: number;
  rowsFetchedAt?: number;
  /** sessionKey -> when this client last saw that session end. */
  endedAt?: Map<string, number>;
}): Map<string, number> {
  const { rows, runs, matches, now, rowsFetchedAt, endedAt } = params;
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const add = (model?: string | null, provider?: string | null) => {
    const key = modelCountKey(model, provider);
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.key !== "string") {
      continue;
    }
    seen.add(row.key);
    const state = resolveSessionRunState({
      sessionKey: row.key,
      row,
      runs,
      matches,
      now,
      rowsFetchedAt,
      endedAt: endedAt?.get(row.key),
    });
    if (state.live) {
      // Pair the model with the provider from the SAME lane. `decorate` resolves the two fields
      // with INDEPENDENT fallbacks (client run first, session row second), and an `activeRuns`
      // entry is born with a provider but an empty model (see the note in `decorate`) — so taking
      // the provider from the client while the model came from the row would key the count under a
      // `provider/model` pair that exists in no catalog, and the row would never light at all.
      const model = state.model || row.model;
      const provider = model === row.model ? row.modelProvider || state.provider : state.provider;
      add(model, provider);
    }
  }

  // A fresh client run whose session the server has not described yet (a turn that started
  // between two sessions.list refreshes) still counts — otherwise the badge would blink off
  // for a beat at the very moment a run begins.
  for (const run of runs) {
    const key = run?.sessionKey;
    if (!key || seen.has(key) || !clientRunIsFresh(run, now)) {
      continue;
    }
    if (![...seen].some((k) => matches(key, k))) {
      // A client entry always carries its own provider — `providerOf(modelPin)` at send time, or the
      // provider on lifecycle:start — so this lane can qualify itself without consulting a row.
      add(run.model, run.provider);
    }
  }
  return counts;
}

/**
 * Live count for one catalog model id (`provider/model`, the shape the models panel holds).
 *
 * TWO STEPS, in this order and for a reason:
 *   1. the PROVIDER-QUALIFIED key — the real answer, and it wins outright. This is what stops one
 *      provider's run from lighting another provider's row for the same base model.
 *   2. the BARE TAIL — consulted ONLY as the documented fallback for provider-less events (see
 *      `modelCountKey`). It is why a cc-bridge effort event, which reports a bare `claude-opus-4-8`
 *      with no provider, still lights the row; it is equally why such an event lights every twin.
 *      That is the irreducible residue, and it is now the ONLY path by which one provider's row can
 *      be lit by another provider's run.
 */
export function liveCountForModel(
  counts: Map<string, number>,
  modelId: string | undefined,
): number {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return 0;
  }
  const exact = counts.get(modelId);
  if (typeof exact === "number") {
    return exact;
  }
  const tail = bareModelTail(modelId);
  return tail ? (counts.get(tail) ?? 0) : 0;
}
