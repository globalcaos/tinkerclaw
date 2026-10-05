// FORK 2026-08-17 (the architect: "when I switch tabs, the progress indicator on the tab titles that are
// not focused should not go away").
//
// THE PRE-MODEL WINDOW: prompt accepted, no model named yet. Measured at 21-36s (turn-latency.md),
// so it is a third of a minute in which a session is unambiguously working and the gateway's run
// set still says nothing — no run is open, because no model has been chosen.
//
// `pending` was the LAST piece of activity state that was still a property of THE VIEWED TAB rather
// than of a session. It lived in app.ts's `sending` boolean, so `tabsRunningNow()` could only ever
// grant the pending glow to `tab.id === activeTabId`. Send a prompt, switch away inside the window,
// and the tab you left went dark while its turn was very much alive.
//
// run-state.ts's header named this and deliberately kept `pending` out of the resolver, because it
// is "client-local knowledge about the viewed tab, not a property of the gateway's run set". The
// second half of that is still true and this module does not change it — the run set opens nothing
// until a model is named. The FIRST half is what is fixed here: keyed by session, there is nothing
// viewed-specific left, and every surface can ask about any session.
//
// FORK 2026-09-24 (prompt-queue.md §7 step U6; contradiction C9, the pill half). The gateway DOES
// now report this window, through a holder other than the run set: every `sessions.list` row
// carries a `pendingPrompts` snapshot (§6.3, gateway step G5), and an entry in state `preparing` is
// a reply operation that has not reached its model yet (phase queued, preflight_compacting or
// memory_flushing). Pre-model waits of 21-49 min were measured live on 2026-09-23, and the 120 s
// bound below blanked every one of them on a turn that was still working. So `sessionPending`
// believes a FRESH `preparing` report past PRE_MODEL_MAX_MS, and keeps the bound wherever there is
// none: an old gateway (no field), a new one with nothing pending, a row that places the prompt
// elsewhere (behind, steered, running), or a report too old to vouch for now.
//
// THE ASYMMETRY THAT GOVERNS EVERY CHOICE BELOW. Every historical failure in this area was a
// surface that LATCHED — a glow that would not stop. So the window is bounded in time, and each of
// its three independent closing proofs is recorded for EVERY session above every viewed gate. A
// dropped clear must degrade to "the glow stops early", never to "the glow never stops". The
// `preparing` report keeps that shape: it lifts only the TIME bound, never opens a window, never
// outranks a closing proof, and is believed only while its fetch is younger than
// PRE_MODEL_REPORT_FRESH_MS. A refresh that stops arriving therefore ends the glow on its own.

import type { PendingPromptPhase } from "./prompt-state.js";

/**
 * How long a pre-model window may plausibly last before the UI stops believing it.
 *
 * Deliberately generous against a measured 21-36s: the bound exists to cap a LOST clear, not to
 * time out a slow gateway. Set it near the real window and a genuinely slow turn loses its glow,
 * which is the bug this module exists to fix.
 *
 * Since step U6 it binds only a window the gateway has NOT freshly reported as `preparing` (see
 * `sessionPending`): 120 s was never long enough for the 21-49 min waits measured on 2026-09-23,
 * and only the gateway can tell a slow turn from a lost clear.
 */
export const PRE_MODEL_MAX_MS = 120_000;

/**
 * FORK 2026-09-24 (step U6) — how old a `sessions.list` fetch may be and still vouch that a prompt
 * is `preparing`. The report is a snapshot, and app.ts otherwise refreshes it only on connect, first
 * message, turn end and abort, never during a turn; believing an old one past the time bound would
 * be exactly the latch this module forbids. 150 s spans two refreshes at
 * PRE_MODEL_REPORT_REFRESH_MS, so one slow or failed fetch does not blank a live wait, and two do.
 */
export const PRE_MODEL_REPORT_FRESH_MS = 150_000;

/**
 * How often app.ts re-asks `sessions.list` while a window is past (or about to pass) the time bound
 * and still believed. `sessions.list` answers in 1.7-2.9 s, and the long waits it serves are the
 * ones where the gateway is already slow, so this is once a minute, not a poll: a 20-minute wait
 * costs about 20 calls, and a normal 21-36 s window costs none.
 */
export const PRE_MODEL_REPORT_REFRESH_MS = 60_000;

/** Start asking this long before the bound, so a fresh report is in hand when the bound passes. */
export const PRE_MODEL_REPORT_LEAD_MS = 20_000;

/** A gateway report: the `sessions.list` rows the caller holds, and when that list was fetched. */
export type GatewayPendingReport = {
  rows: readonly unknown[] | null | undefined;
  fetchedAt: number;
};

/** §6.3's `pendingPrompts[].state` for a prompt still before its model. Typed against the
 *  consumer's own union (prompt-state.ts), so a rename there cannot leave this literal behind. */
const GATEWAY_PREPARING: PendingPromptPhase = "preparing";

/** Matches a run/store key against a reference key. app.ts passes its `sessionKeyMatches`, which
 *  tolerates the canonical/short drift (`agent:main:tinker:abc` vs `tinker:abc`). */
export type KeyMatcher = (candidateKey: string, refKey: string) => boolean;

/** Record that `key` entered its pre-model window at `now`. */
export function openPreModelWindow(windows: Map<string, number>, key: string, now: number): void {
  if (!key) {
    return;
  }
  windows.set(key, now);
}

/** The stamp for a session, tolerant of key drift. Newest wins when several keys match. */
export function preModelSinceFor(
  windows: Map<string, number>,
  key: string,
  matches: KeyMatcher,
): number | undefined {
  if (!key) {
    return undefined;
  }
  const exact = windows.get(key);
  if (typeof exact === "number") {
    return exact;
  }
  let best: number | undefined;
  for (const [k, t] of windows) {
    if (matches(k, key) && (best === undefined || t > best)) {
      best = t;
    }
  }
  return best;
}

/**
 * Does the gateway report a prompt of this session as `preparing`? (step U6)
 *
 * Reads the `sessions.list` rows the caller holds (app.ts `sessions`). The row for `key` is the
 * exact-key row, else the first one `matches` accepts (the canonical/short drift every reader here
 * tolerates). True only when that row's `pendingPrompts` has an entry in state `preparing`.
 *
 * FALSE means "no report", never "not preparing": no rows, no row for this session, a row without
 * the field (an old gateway, or a new one with nothing pending, since the gateway omits the field
 * rather than send `[]`), or entries in other states. The caller then keeps the time bound. Pure
 * and total.
 */
export function gatewayReportsPreparing(
  rows: readonly unknown[] | null | undefined,
  key: string,
  matches: KeyMatcher,
): boolean {
  if (!key || !Array.isArray(rows)) {
    return false;
  }
  let row: Record<string, unknown> | undefined;
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const r = candidate as Record<string, unknown>;
    if (typeof r.key !== "string" || !r.key) {
      continue;
    }
    if (r.key === key) {
      row = r;
      break;
    }
    if (row === undefined && matches(r.key, key)) {
      row = r;
    }
  }
  const pending = row?.pendingPrompts;
  return (
    Array.isArray(pending) &&
    pending.some(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>).state === GATEWAY_PREPARING,
    )
  );
}

/** Is this report young enough to vouch for `now`? A stamp from the future, a non-number and the
 *  never-fetched 0 are all NOT fresh: absent evidence is not evidence of a live wait. */
export function gatewayReportIsFresh(
  report: GatewayPendingReport | null | undefined,
  now: number,
): report is GatewayPendingReport {
  if (!report || typeof report.fetchedAt !== "number" || !Number.isFinite(report.fetchedAt)) {
    return false;
  }
  const age = now - report.fetchedAt;
  return age >= 0 && age <= PRE_MODEL_REPORT_FRESH_MS;
}

/**
 * Is this session in its pre-model window right now?
 *
 * THE ONE DERIVATION of `pending`, asked by the chat pill and the tab glow alike so the two cannot
 * drift — drift between two surfaces answering the same question their own way is the failure mode
 * behind every report in this class since 2026-07-29.
 *
 * A window is opened only by this client (`openPreModelWindow`) and closed by any of the three
 * proofs (`clearPreModelFor`). While open it is believed for PRE_MODEL_MAX_MS, and past that only
 * while a FRESH gateway `report` says the session's prompt is `preparing` (step U6). No `report`
 * means the caller has none: the 120 s bound, exactly as before U6. The rows are scanned only once
 * a window is open AND past the bound, so the common case costs nothing.
 */
export function sessionPending(
  windows: Map<string, number>,
  key: string,
  now: number,
  matches: KeyMatcher,
  report?: GatewayPendingReport | null,
): boolean {
  const since = preModelSinceFor(windows, key, matches);
  if (typeof since !== "number") {
    return false;
  }
  if (now - since <= PRE_MODEL_MAX_MS) {
    return true;
  }
  return gatewayReportIsFresh(report, now) && gatewayReportsPreparing(report.rows, key, matches);
}

/**
 * Should app.ts re-ask `sessions.list` for a fresh gateway report now? (step U6)
 *
 * Yes when the last fetch or ask is at least PRE_MODEL_REPORT_REFRESH_MS old AND some window is
 * either about to outlive the time bound (within PRE_MODEL_REPORT_LEAD_MS of it) or has outlived it
 * and is still `believed`. A window the gateway stopped vouching for is not asked about again, so
 * the asking ends with the belief: nothing here can poll forever. `believed` is the caller's
 * `sessionPending` for one key. Pure.
 */
export function preModelReportDue(
  windows: Map<string, number>,
  now: number,
  lastAskedAt: number,
  believed: (key: string) => boolean,
): boolean {
  if (now - lastAskedAt < PRE_MODEL_REPORT_REFRESH_MS) {
    return false;
  }
  for (const [key, since] of windows) {
    const age = now - since;
    if (age < PRE_MODEL_MAX_MS - PRE_MODEL_REPORT_LEAD_MS) {
      continue;
    }
    if (age <= PRE_MODEL_MAX_MS || believed(key)) {
      return true;
    }
  }
  return false;
}

/**
 * Close the window for one session, wherever the proof arrived from.
 *
 * Three independent proofs close it, and all three are recorded for EVERY session above every
 * viewed gate: a model-bearing lifecycle event (a model was named — the definition of the window
 * ending), a chat delta (the model is already answering), and any terminal chat event (the turn is
 * over). Three because this codebase has repeatedly been observed to drop any one of them.
 * Idempotent. Returns true when something was actually removed.
 */
export function clearPreModelFor(
  windows: Map<string, number>,
  key: unknown,
  matches: KeyMatcher,
): boolean {
  if (typeof key !== "string" || !key) {
    return false;
  }
  if (windows.delete(key)) {
    return true;
  }
  let changed = false;
  for (const k of [...windows.keys()]) {
    if (matches(k, key)) {
      windows.delete(k);
      changed = true;
    }
  }
  return changed;
}

/**
 * Does this chat event end the VIEWED tab's pre-model window?
 *
 * FORK 2026-09-03 (the architect: "the work tab is preparing context forever").
 *
 * THE THIRD PROOF, WHICH THE VIEWED LANE NEVER HAD. Everything above keys the window by
 * session and is written for the tab glow. app.ts keeps a SECOND, viewed-only window in
 * `preparingSince` — the one that paints the "preparing context" pill and anchors the turn
 * timing block — and that one was closed by only two proofs, both of which require the turn
 * to get as far as a model: a model-bearing `phase:start`, or the first assistant delta.
 *
 * A turn can end before either. An Anthropic HTTP 529 is exactly that shape: the request
 * never reaches a model, so the only event the tab ever sees is the terminal one carrying
 * the error. With no terminator on that path `preparingSince` stayed set for the life of the
 * page — the pill counted up forever and `taskRunning` held the timing block open behind it.
 * The disconnect, next-send and send-failure clears could not help: the socket was healthy,
 * and the architect was waiting rather than sending again.
 *
 * That is precisely the latch this module's header forbids: a dropped clear must degrade to
 * "the glow stops early", never to "the glow never stops". This restores the symmetry — the
 * same three proofs, on both lanes.
 *
 * Gated on the session because a BACKGROUND session's turn ending must not blank the window
 * of a tab whose own prompt was accepted seconds ago; that window is 21-36s on every turn
 * (turn-latency.md), so ungating it would trade this latch for a blind spot on every send.
 *
 * Pure and total: the caller owns the state, this only reads the event.
 */
export function terminalClosesPreModelWindow(params: {
  eventSessionKey: unknown;
  viewedSessionKey: string | undefined;
  state: unknown;
  matches: KeyMatcher;
}): boolean {
  const { eventSessionKey, viewedSessionKey, state, matches } = params;
  if (state !== "final" && state !== "error" && state !== "aborted") {
    return false;
  }
  if (typeof eventSessionKey !== "string" || !eventSessionKey) {
    return false;
  }
  if (typeof viewedSessionKey !== "string" || !viewedSessionKey) {
    return false;
  }
  return matches(eventSessionKey, viewedSessionKey);
}

/**
 * How long the VIEWED tab's `sending` latch stays believable.
 *
 * FORK 2026-09-04 (the architect: "a few tabs like the amygdala get stuck 'preparing context' and
 * never do anything").
 *
 * THE LAST UNBOUNDED LATCH. This module's header states the rule every lane in this area obeys —
 * "a dropped clear must degrade to 'the glow stops early', never to 'the glow never stops'" — and
 * every neighbouring lane has a bound that enforces it: the run set expires at `RUN_STALE_MS`
 * (90s), the per-session pre-model window at `PRE_MODEL_MAX_MS` (120s). app.ts's `sending` boolean
 * never got one, and it is the term `shouldQueue()` actually reads. So a turn that died without a
 * terminal chat event for its tab — a killed cc-bridge worker, a lost lifecycle:end, a gateway
 * restart whose close frame landed on a superseded dial — left `sending: true` in that tab's saved
 * TabState with nothing in the program able to clear it. `loadTabState` then restored it verbatim
 * on every visit, `shouldQueue()` parked every later prompt behind a drain that would never
 * arrive, and the tab read "preparing context" and did nothing for the life of the page.
 *
 * WHY NOT `PRE_MODEL_MAX_MS`. This is the same window, but it is read by a different consumer with
 * a different cost of being wrong. 120s is deliberately tuned to cap a LOST tab glow, and the
 * longest pre-model wait actually observed on this gateway is ~350s (app.ts documents it beside
 * `pendingSince`). Reusing 120s here would blank the pill and un-queue the composer in the middle
 * of a wait that is genuinely still running — trading this latch for a new wrong answer on a real
 * turn. Ten minutes is comfortably past every measured window and still turns "bricked until the
 * page is reloaded" into "self-heals in ten minutes".
 *
 * A live turn is never held up by this bound: once a run exists, `shouldQueue`'s
 * `hasFreshActiveRunForSession` term carries the queueing decision and `viewedSessionBusy()`
 * hides the pill, so `sending` only has to cover the gap BEFORE any run exists.
 */
export const SENDING_STALE_MS = 600_000;

/**
 * Is the viewed tab's `sending` latch still believable?
 *
 * `undefined`/`null` is EXPIRED, not "unknown-so-assume-live", and that is the whole safety
 * property: a TabState saved before this stamp existed carries `sending: true` with no `since`,
 * which is exactly the latched shape this fix exists to break. Reading it as expired heals every
 * already-stuck tab on its next render instead of requiring a reload.
 *
 * Pure and total — the caller owns the state, this only does the arithmetic.
 */
export function sendingLatchIsLive(since: number | null | undefined, now: number): boolean {
  if (typeof since !== "number" || !Number.isFinite(since)) {
    return false;
  }
  return now - since <= SENDING_STALE_MS;
}
