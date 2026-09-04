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
// second half of that is still true and this module does not change it — the gateway genuinely does
// not know about this window. The FIRST half is what is fixed here: keyed by session, there is
// nothing viewed-specific left, and every surface can ask about any session.
//
// THE ASYMMETRY THAT GOVERNS EVERY CHOICE BELOW. Every historical failure in this area was a
// surface that LATCHED — a glow that would not stop. So the window is bounded in time, and each of
// its three independent closing proofs is recorded for EVERY session above every viewed gate. A
// dropped clear must degrade to "the glow stops early", never to "the glow never stops".

/**
 * How long a pre-model window may plausibly last before the UI stops believing it.
 *
 * Deliberately generous against a measured 21-36s: the bound exists to cap a LOST clear, not to
 * time out a slow gateway. Set it near the real window and a genuinely slow turn loses its glow,
 * which is the bug this module exists to fix.
 */
export const PRE_MODEL_MAX_MS = 120_000;

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
 * Is this session in its pre-model window right now?
 *
 * THE ONE DERIVATION of `pending`, asked by the chat pill and the tab glow alike so the two cannot
 * drift — drift between two surfaces answering the same question their own way is the failure mode
 * behind every report in this class since 2026-07-29.
 */
export function sessionPending(
  windows: Map<string, number>,
  key: string,
  now: number,
  matches: KeyMatcher,
): boolean {
  const since = preModelSinceFor(windows, key, matches);
  return typeof since === "number" && now - since <= PRE_MODEL_MAX_MS;
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
 * FORK 2026-09-03 (the architect: "the serraclaw tab is preparing context forever").
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
