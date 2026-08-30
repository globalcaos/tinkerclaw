import { describe, it, expect } from "vitest";
import {
  QUEUED_STRANDED_MS,
  queuedBelongsToSession,
  queuedForSession,
  settleQueuedSession,
  shouldQueue,
  strandedQueuedEntries,
  type QueuedEntry,
} from "./queued-sends";

// Minimal stand-in for app.ts `sessionKeyMatches` (short "tinker:A" vs canonical
// "agent:main:tinker:A"): exact match, or one key is a suffix of the other.
const matches = (a?: string, b?: string): boolean => {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(b) || b.endsWith(a);
};

const textOf = (e: QueuedEntry): string =>
  ((e.content as Array<{ text?: string }>)?.[0]?.text as string) ?? "";

const sessOf = (e: QueuedEntry): string | undefined => e._queuedSession as string | undefined;

const q = (session: string, text: string): QueuedEntry => ({
  role: "user",
  content: [{ type: "text", text }],
  _queued: true,
  _queuedSession: session,
});

/** `q` plus the `_promptStartedAt` stamp send() puts on every outgoing user message (app.ts). The
 *  bare `q` above stays deliberately un-stamped: it is the timestamp-less fixture. */
const qAt = (session: string, text: string, at: number): QueuedEntry => ({
  ...q(session, text),
  _promptStartedAt: at,
});

describe("queued-sends tab scoping (symptom #2: queued shows in every tab)", () => {
  it("renders a queued entry ONLY in its own session's tab", () => {
    const queue = [q("tinker:A", "from A"), q("tinker:B", "from B")];
    expect(queuedForSession(queue, "tinker:A", matches).map(textOf)).toEqual(["from A"]);
    expect(queuedForSession(queue, "tinker:B", matches).map(textOf)).toEqual(["from B"]);
    // viewing an unrelated session shows NO queued bubbles (the bug rendered all of them everywhere)
    expect(queuedForSession(queue, "tinker:C", matches)).toHaveLength(0);
  });

  it("matches short vs canonical session keys", () => {
    expect(queuedBelongsToSession(q("tinker:A", "x"), "agent:main:tinker:A", matches)).toBe(true);
    expect(queuedBelongsToSession(q("tinker:A", "x"), "tinker:Z", matches)).toBe(false);
  });

  it("an untagged entry belongs to no tab (never renders)", () => {
    const untagged: QueuedEntry = { role: "user", content: [{ type: "text", text: "?" }] };
    expect(queuedBelongsToSession(untagged, "tinker:A", matches)).toBe(false);
  });
});

describe("shouldQueue gate (bug C: a send during a turn must be queued, not pushed)", () => {
  it("does NOT queue when the session is fully idle", () => {
    expect(
      shouldQueue({ hasFreshActiveRunForSession: false, streamRunId: null, sending: false }),
    ).toBe(false);
  });

  it("queues while a FRESH run is active for the session", () => {
    // Renamed field, identical behaviour. Deciding WHETHER the run is fresh is the caller's job
    // (sessionHasFreshClientRun / clientRunIsFresh, run-state.ts); all this pins is that a true
    // value still gates. See the 2026-08-26 note on shouldQueue for why the name carries the
    // contract, and `strandedQueuedEntries` below for what happens when the caller gets it wrong.
    expect(
      shouldQueue({ hasFreshActiveRunForSession: true, streamRunId: null, sending: false }),
    ).toBe(true);
  });

  it("queues while a stream is in flight", () => {
    expect(
      shouldQueue({ hasFreshActiveRunForSession: false, streamRunId: "run-1", sending: false }),
    ).toBe(true);
  });

  it("BUG REPRO (turn-start gap): queues when `sending` is set but the first run/stream has not registered yet", () => {
    // The instant a turn starts, send() sets `sending = true` BEFORE the first phase:start/delta
    // registers a run or a streamRunId. A second prompt typed in that window must still be queued,
    // or it gets pushed into messages[] and the turn's own bubbles land after it. The old gate
    // (the run + stream conditions alone) missed this window.
    expect(
      shouldQueue({ hasFreshActiveRunForSession: false, streamRunId: null, sending: true }),
    ).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FORK 2026-08-28 — THE TEST THAT WOULD HAVE CAUGHT THE LIVE BUG.
  //
  // The 2026-08-26 rename was designed as a review gate: pass the old key and the field arrives
  // `undefined`, so the gate quietly becomes `streamRunId != null || sending`. app.ts did exactly
  // that and shipped, because every case above passes the CORRECT key — the suite could not tell a
  // healthy gate from a two-thirds-dead one. tinker-ui was in no typecheck project, so nothing else
  // could either. These two cases close that hole from the test side; a tsconfig closes it from the
  // compiler side. Both, because either alone is how this happened.
  // ───────────────────────────────────────────────────────────────────────────
  it("REGRESSION: the pre-rename key is a drifted call site, and must THROW rather than degrade", () => {
    expect(() =>
      // @ts-expect-error — deliberately the OLD shape: this is the exact object app.ts passed.
      shouldQueue({ hasActiveRunForSession: true, streamRunId: null, sending: false }),
    ).toThrow(/hasFreshActiveRunForSession/);
  });

  it("REGRESSION: the degenerate gate is observably WRONG, not merely differently-spelled", () => {
    // The damage in one line: with a fresh run active and nothing else set, the correct gate queues
    // and the drifted one does not — so a mid-turn prompt was pushed straight into messages[] and
    // bug C returned by the back door. Pinning the VALUE, not just the throw, keeps this honest if
    // the guard above is ever softened.
    expect(
      shouldQueue({ hasFreshActiveRunForSession: true, streamRunId: null, sending: false }),
    ).toBe(true);
    const degenerate = (s: { streamRunId: string | null; sending: boolean }): boolean =>
      s.streamRunId != null || s.sending;
    expect(degenerate({ streamRunId: null, sending: false })).toBe(false);
  });
});

describe("queued-sends settle on turn end (symptom #1: stays queued though processed)", () => {
  it("BUG REPRO: a prompt queued in a BACKGROUND tab is dropped when its OWN turn ends", () => {
    // Queued in tab A; user switched to tab B; A's turn finalizes while B is on screen.
    // The old code only flushed via the viewed-session-gated chat-final, so A's bubble stuck forever.
    const queue = [q("tinker:A", "stuck?"), q("tinker:B", "other")];
    const { remaining, commit } = settleQueuedSession(
      queue,
      "tinker:A",
      /* isViewed */ false,
      matches,
    );
    expect(remaining.map(sessOf)).toEqual(["tinker:B"]); // A's ghost gone, B untouched
    expect(commit).toHaveLength(0); // background → NOT spliced into the live transcript
    // settled entry has its queued markers stripped
    expect(queue[0]._queued).toBeUndefined();
    expect(queue[0]._queuedSession).toBeUndefined();
  });

  it("the VIEWED session's queued prompts commit into the transcript in order", () => {
    const queue = [q("tinker:A", "first"), q("tinker:A", "second"), q("tinker:B", "elsewhere")];
    const { remaining, commit } = settleQueuedSession(
      queue,
      "tinker:A",
      /* isViewed */ true,
      matches,
    );
    expect(commit.map(textOf)).toEqual(["first", "second"]);
    expect(remaining.map(sessOf)).toEqual(["tinker:B"]);
    expect(commit[0]._queued).toBeUndefined();
  });

  it("settling one session does NOT flush another (no cross-session mis-flush)", () => {
    const queue = [q("tinker:A", "a"), q("tinker:B", "b")];
    const { remaining, commit } = settleQueuedSession(queue, "tinker:B", true, matches);
    expect(commit.map(textOf)).toEqual(["b"]);
    expect(remaining.map(sessOf)).toEqual(["tinker:A"]);
  });

  it("no endedSession → queue returned unchanged", () => {
    const queue = [q("tinker:A", "a")];
    const r = settleQueuedSession(queue, undefined, true, matches);
    expect(r.remaining).toBe(queue);
    expect(r.commit).toHaveLength(0);
  });
});

describe("strandedQueuedEntries (a GHOST run swallowed every later prompt)", () => {
  const NOW = 1_700_000_000_000;
  const MIN = 60_000;

  it("returns nothing while a FRESH run exists, however old the entry is", () => {
    // A live turn is still going to settle these, and a tool-heavy turn legitimately keeps a prompt
    // waiting for minutes. Releasing it here would re-create bug C — the prompt jumping above the
    // answer it was queued behind — so freshness is a HARD short-circuit, not a per-entry filter.
    const queue = [qAt("tinker:A", "ancient", NOW - 60 * MIN)];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, true)).toHaveLength(0);
  });

  it("BUG REPRO: a 3-minute-old entry for the viewed session with no fresh run", () => {
    // The user's actual case: a stale run object made shouldQueue say "queue it", the run never
    // terminated, and the only drain (a chat terminal for that session) never fired. `chat.send`
    // was never called and the prompt vanished with no signal at all.
    const queue = [qAt("tinker:A", "never sent", NOW - 3 * MIN)];
    const stranded = strandedQueuedEntries(queue, "tinker:A", matches, NOW, false);
    expect(stranded.map(textOf)).toEqual(["never sent"]);
    // Returned BY REFERENCE, so a caller can settle exactly these entries by identity.
    expect(stranded[0]).toBe(queue[0]);
  });

  it("does NOT strand an entry that is merely young", () => {
    const queue = [qAt("tinker:A", "just queued", NOW - 5_000)];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false)).toHaveLength(0);
  });

  it("never returns ANOTHER session's entries — but does return them in their own tab", () => {
    const queue = [
      qAt("tinker:A", "mine", NOW - 10 * MIN),
      qAt("tinker:B", "theirs", NOW - 10 * MIN),
    ];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false).map(textOf)).toEqual([
      "mine",
    ]);
    // The filter is about the KEY, not the entry: B's prompt is equally stranded in B's own tab.
    expect(strandedQueuedEntries(queue, "tinker:B", matches, NOW, false).map(textOf)).toEqual([
      "theirs",
    ]);
  });

  it("no viewed session → nothing is stranded", () => {
    const queue = [qAt("tinker:A", "orphan", NOW - 10 * MIN)];
    expect(strandedQueuedEntries(queue, undefined, matches, NOW, false)).toHaveLength(0);
  });

  it("matches short vs canonical session keys, like every other queue predicate", () => {
    const queue = [qAt("tinker:A", "mine", NOW - 3 * MIN)];
    expect(
      strandedQueuedEntries(queue, "agent:main:tinker:A", matches, NOW, false).map(textOf),
    ).toEqual(["mine"]);
  });

  it("never returns a timestamp-less entry — we do not guess an age", () => {
    // `q` carries no `_promptStartedAt`. Re-sending a prompt we cannot date risks duplicating one
    // the gateway may already be running, so an undateable entry is never stranded.
    const queue = [q("tinker:A", "undateable")];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false)).toHaveLength(0);
  });

  it("falls back to a numeric `ts` when `_promptStartedAt` is absent", () => {
    const queue: QueuedEntry[] = [{ ...q("tinker:A", "from the outbox"), ts: NOW - 5 * MIN }];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false).map(textOf)).toEqual([
      "from the outbox",
    ]);
  });

  it("a non-numeric timestamp is NOT usable (an ISO string is never an age)", () => {
    const queue: QueuedEntry[] = [{ ...q("tinker:A", "iso"), ts: "2026-08-26T10:00:00Z" }];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false)).toHaveLength(0);
  });

  it("a NUMERIC STRING timestamp is NOT usable either — the typeof guard is load-bearing", () => {
    // CONTROL for the test above, which passes even with NO type guard at all: an ISO string minus
    // a number is NaN, and `NaN > maxAgeMs` is false, so the entry is skipped by accident rather
    // than by the guard. A numeric string is the case that actually discriminates — drop the
    // `typeof v === "number"` check and JS coerces it in `now - at`, reporting this 5-minute-old
    // entry as stranded and re-sending a prompt we never legitimately dated.
    const queue: QueuedEntry[] = [
      { ...q("tinker:A", "stringly typed"), ts: String(NOW - 5 * MIN) },
    ];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false)).toHaveLength(0);
  });

  it("NaN is not an age", () => {
    const queue: QueuedEntry[] = [{ ...q("tinker:A", "nan"), _promptStartedAt: Number.NaN }];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false)).toHaveLength(0);
  });

  it("respects an explicit maxAgeMs, in both directions", () => {
    const queue = [qAt("tinker:A", "90s old", NOW - 90_000)];
    // 90s: past run-state's staleness bound, but still inside the default 120s stranded window.
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false)).toHaveLength(0);
    const tight = strandedQueuedEntries(queue, "tinker:A", matches, NOW, false, 60_000);
    expect(tight.map(textOf)).toEqual(["90s old"]);
    const loose = strandedQueuedEntries(queue, "tinker:A", matches, NOW, false, 10 * MIN);
    expect(loose).toHaveLength(0);
  });

  it("exactly at the bound is NOT stranded (strictly 'more than maxAgeMs ago')", () => {
    const queue = [qAt("tinker:A", "borderline", NOW - 30_000)];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false, 30_000)).toHaveLength(0);
    const older = strandedQueuedEntries(queue, "tinker:A", matches, NOW, false, 29_999);
    expect(older).toHaveLength(1);
  });

  it("the default bound IS the exported constant, clear of run-state's 90s staleness", () => {
    expect(QUEUED_STRANDED_MS).toBe(120_000);
    expect(QUEUED_STRANDED_MS).toBeGreaterThan(90_000);
    const queue = [qAt("tinker:A", "just over", NOW - QUEUED_STRANDED_MS - 1)];
    expect(strandedQueuedEntries(queue, "tinker:A", matches, NOW, false)).toHaveLength(1);
  });
});
