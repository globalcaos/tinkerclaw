import { describe, it, expect } from "vitest";
import { derivePromptState, type PromptStateInputs } from "./prompt-state";
import {
  FOLLOWUP_LINKS_MAX,
  FOLLOWUP_STARTED_FACTS,
  FOLLOWUP_STREAM,
  QUEUED_STRANDED_MS,
  addSessionPromptKey,
  chatTerminalScope,
  followupRunLink,
  ownRunTerminal,
  ownRunTerminalRecorded,
  queuedBelongsToSession,
  queuedForSession,
  rememberFollowupLink,
  settleQueuedSession,
  shouldQueue,
  strandedQueuedEntries,
  takeSessionPromptKeys,
  terminalPromptFacts,
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
    // settled entry has its queued marker stripped
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
    expect(commit[0]._queuedSession).toBeUndefined();
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

// ───────────────────────────────────────────────────────────────────────────
// FORK 2026-09-24 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 step U3: TERMINALS KEYED BY PROMPT
// (PQ-7; contradiction C2). A prompt typed while tinker:A's turn R runs is steered into R or
// backlogged behind it, and its own chat.send broadcasts an early `final` for the prompt's key at
// once. Before U3 that final settled the WHOLE session's queue while R was still running.
// ───────────────────────────────────────────────────────────────────────────

/** A deferred entry carrying the key send() mints: the bubble's `_clientMsgId`, which is also the
 *  gateway idempotencyKey and so the runId of that prompt's early `final` (PQ-1). */
const qk = (session: string, text: string, key: string): QueuedEntry => ({
  ...q(session, text),
  _clientMsgId: key,
});

const NO_LINKS: ReadonlyMap<string, readonly string[]> = new Map();

/** Three prompts deferred behind tinker:A's running turn, plus one in another tab. */
const deferredBehindR = (): QueuedEntry[] => [
  qk("tinker:A", "first", "k1"),
  qk("tinker:A", "second", "k2"),
  qk("tinker:A", "third", "k3"),
  qk("tinker:B", "elsewhere", "kb"),
];

describe("U3 — a disposition final names ONE prompt (PQ-7, C2)", () => {
  it("CONTROL: the same early final WITHOUT a disposition (old gateway) releases every entry of the session", () => {
    // Today's rule, kept for an old gateway: k2's own final flushes k1 and k3 too, mid-turn. That is
    // what EVERY early final did before U3, so the two keyed tests below fail on the pre-U3 tree.
    const scope = chatTerminalScope({ state: "final", runId: "k2" }, NO_LINKS);
    expect(scope).toEqual({ kind: "session" });
    const { remaining, commit } = settleQueuedSession(
      deferredBehindR(),
      "tinker:A",
      true,
      matches,
      scope ?? undefined,
    );
    expect(commit.map(textOf)).toEqual(["first", "second", "third"]);
    expect(remaining.map(textOf)).toEqual(["elsewhere"]);
  });

  it("a `steered` final releases ONLY its own entry, committed in place", () => {
    const scope = chatTerminalScope(
      { state: "final", runId: "k2", disposition: "steered" },
      NO_LINKS,
    );
    expect(scope).toEqual({ kind: "prompt", key: "k2", disposition: "steered" });
    const { remaining, commit } = settleQueuedSession(
      deferredBehindR(),
      "tinker:A",
      true,
      matches,
      scope ?? undefined,
    );
    expect(commit.map(textOf)).toEqual(["second"]);
    expect(commit[0]._queuedSession).toBeUndefined();
    // k1 and k3 are still deferred behind R, with their session tag intact.
    expect(remaining.map(textOf)).toEqual(["first", "third", "elsewhere"]);
    expect(remaining.map(sessOf)).toEqual(["tinker:A", "tinker:A", "tinker:B"]);
  });

  it("in a BACKGROUND tab a `steered` final drops only its own entry", () => {
    const scope = chatTerminalScope(
      { state: "final", runId: "k2", disposition: "steered" },
      NO_LINKS,
    );
    const { remaining, commit } = settleQueuedSession(
      deferredBehindR(),
      "agent:main:tinker:A",
      false,
      matches,
      scope ?? undefined,
    );
    expect(commit).toHaveLength(0);
    expect(remaining.map(textOf)).toEqual(["first", "third", "elsewhere"]);
  });

  it("a `backlogged` final releases NOTHING: BEHIND stays trailing until its follow-up starts", () => {
    const scope = chatTerminalScope(
      { state: "final", runId: "k2", disposition: "backlogged" },
      NO_LINKS,
    );
    expect(scope).toEqual({ kind: "prompt", key: "k2", disposition: "backlogged" });
    const queue = deferredBehindR();
    const { remaining, commit } = settleQueuedSession(
      queue,
      "tinker:A",
      true,
      matches,
      scope ?? undefined,
    );
    expect(commit).toHaveLength(0);
    expect(remaining.map(textOf)).toEqual(["first", "second", "third", "elsewhere"]);
    expect(queue[1]._queuedSession).toBe("tinker:A");
  });

  it("a disposition final with no runId names nothing, and is still not a session terminal", () => {
    const scope = chatTerminalScope({ state: "final", disposition: "steered" }, NO_LINKS);
    expect(scope?.kind).toBe("prompt");
    const { remaining, commit } = settleQueuedSession(
      deferredBehindR(),
      "tinker:A",
      true,
      matches,
      scope ?? undefined,
    );
    expect(commit).toHaveLength(0);
    expect(remaining).toHaveLength(4);
  });

  it("`dropped`, an unknown value, or a disposition on an error/aborted keep today's session path", () => {
    for (const event of [
      { state: "final", runId: "k2", disposition: "dropped" },
      { state: "final", runId: "k2", disposition: "later" },
      { state: "aborted", runId: "k2", disposition: "steered" },
      { state: "error", runId: "k2", disposition: "backlogged" },
    ]) {
      expect(chatTerminalScope(event, NO_LINKS)).toEqual({ kind: "session" });
    }
  });

  it("a delta, or no event at all, is not a terminal", () => {
    expect(chatTerminalScope({ state: "delta", runId: "k2" }, NO_LINKS)).toBeNull();
    expect(chatTerminalScope(undefined, NO_LINKS)).toBeNull();
  });
});

describe("U3 — a linked follow-up run settles exactly its keys (gateway G3)", () => {
  const followupStart = (runId: string, promptKeys: unknown) => ({
    stream: FOLLOWUP_STREAM,
    runId,
    sessionKey: "agent:main:tinker:A",
    data: { phase: "start", promptKeys },
  });

  it("a followup start + its terminal settles exactly its keys", () => {
    const links = new Map<string, readonly string[]>();
    const link = followupRunLink(followupStart("run-f2", ["k2"]));
    expect(link).toEqual({ runId: "run-f2", keys: ["k2"] });
    if (link) {
      rememberFollowupLink(links, link.runId, link.keys);
    }
    const scope = chatTerminalScope({ state: "final", runId: "run-f2" }, links);
    expect(scope).toEqual({ kind: "linked", keys: ["k2"] });
    const { remaining, commit } = settleQueuedSession(
      deferredBehindR(),
      "tinker:A",
      true,
      matches,
      scope ?? undefined,
    );
    expect(commit.map(textOf)).toEqual(["second"]);
    expect(remaining.map(textOf)).toEqual(["first", "third", "elsewhere"]);
  });

  it("CONTROL: without the followup event the same run's terminal is session-wide", () => {
    const scope = chatTerminalScope({ state: "final", runId: "run-f2" }, NO_LINKS);
    expect(scope).toEqual({ kind: "session" });
    const { commit } = settleQueuedSession(
      deferredBehindR(),
      "tinker:A",
      true,
      matches,
      scope ?? undefined,
    );
    expect(commit.map(textOf)).toEqual(["first", "second", "third"]);
  });

  it("the START releases the linked prompt first, so the terminal after it moves nothing", () => {
    // app.ts settles the start with the same linked scope: the run's answer is about to stream and
    // must land UNDER its prompt, not above a prompt that is still trailing.
    const linked = { kind: "linked" as const, keys: ["k2"] };
    const started = settleQueuedSession(deferredBehindR(), "tinker:A", true, matches, linked);
    expect(started.commit.map(textOf)).toEqual(["second"]);
    const ended = settleQueuedSession(started.remaining, "tinker:A", true, matches, linked);
    expect(ended.commit).toHaveLength(0);
    expect(ended.remaining.map(textOf)).toEqual(["first", "third", "elsewhere"]);
  });

  it("followupRunLink reads only a followup START with at least one usable key", () => {
    expect(followupRunLink(followupStart("r", [" k2 ", "k2", "", 7, "k3"]))).toEqual({
      runId: "r",
      keys: ["k2", "k3"],
    });
    expect(followupRunLink(followupStart("r", []))).toBeNull();
    expect(followupRunLink(followupStart("r", "k2"))).toBeNull();
    expect(followupRunLink(followupStart("", ["k2"]))).toBeNull();
    expect(followupRunLink({ ...followupStart("r", ["k2"]), stream: "lifecycle" })).toBeNull();
    expect(
      followupRunLink({
        ...followupStart("r", ["k2"]),
        data: { phase: "end", promptKeys: ["k2"] },
      }),
    ).toBeNull();
    expect(followupRunLink(undefined)).toBeNull();
  });

  it("the link map is bounded, oldest out first, and a re-announced run moves to the newest slot", () => {
    const links = new Map<string, readonly string[]>();
    rememberFollowupLink(links, "a", ["ka"], 2);
    rememberFollowupLink(links, "b", ["kb"], 2);
    rememberFollowupLink(links, "a", ["ka"], 2);
    rememberFollowupLink(links, "c", ["kc"], 2);
    expect([...links.keys()]).toEqual(["a", "c"]);
    expect(FOLLOWUP_LINKS_MAX).toBe(256);
  });
});

describe("U3 — the facts a prompt collects on the way (prompt-state.ts derives the state)", () => {
  it("steered keys are drained per session, short and canonical forms alike", () => {
    const map = new Map<string, string[]>();
    addSessionPromptKey(map, "agent:main:tinker:A", "k1");
    addSessionPromptKey(map, "agent:main:tinker:A", "k1");
    addSessionPromptKey(map, "agent:main:tinker:A", "k2");
    addSessionPromptKey(map, "tinker:B", "kb");
    addSessionPromptKey(map, undefined, "orphan");
    expect(takeSessionPromptKeys(map, "tinker:A", matches)).toEqual(["k1", "k2"]);
    expect(takeSessionPromptKeys(map, "tinker:A", matches)).toEqual([]);
    expect([...map.keys()]).toEqual(["tinker:B"]);
    expect(takeSessionPromptKeys(map, undefined, matches)).toEqual([]);
  });

  it("each run terminal records one fact, and a delta records none", () => {
    expect(terminalPromptFacts("final")).toEqual({ answered: true });
    expect(terminalPromptFacts("error")).toEqual({ failed: true });
    expect(terminalPromptFacts("aborted")).toEqual({ cancelled: true });
    expect(terminalPromptFacts("delta")).toBeNull();
  });

  it("a backlogged prompt walks ACCEPTED → BEHIND → PREPARING → ANSWERED", () => {
    const facts: PromptStateInputs = { transport: "acked", deferred: true };
    expect(derivePromptState(facts)).toBe("ACCEPTED"); // no report yet: the old-gateway state
    Object.assign(facts, { disposition: "backlogged" });
    expect(derivePromptState(facts)).toBe("BEHIND");
    Object.assign(facts, FOLLOWUP_STARTED_FACTS);
    expect(derivePromptState(facts)).toBe("PREPARING");
    Object.assign(facts, terminalPromptFacts("final"));
    expect(derivePromptState(facts)).toBe("ANSWERED");
  });

  it("a steered prompt reads STEERED until its host turn's terminal", () => {
    const facts: PromptStateInputs = { transport: "acked", deferred: true, disposition: "steered" };
    expect(derivePromptState(facts)).toBe("STEERED");
    Object.assign(facts, terminalPromptFacts("final"));
    expect(derivePromptState(facts)).toBe("ANSWERED");
  });

  it("the follow-up start un-LOSTs a prompt re-drawn LOST after a reload (a holder now exists)", () => {
    const facts: PromptStateInputs = { transport: "acked", noGatewayHolder: true };
    expect(derivePromptState(facts)).toBe("LOST");
    Object.assign(facts, FOLLOWUP_STARTED_FACTS);
    expect(derivePromptState(facts)).toBe("PREPARING");
  });
});

describe("U3 known limit — a run's OWN terminal ends its OWN prompt (ownRunTerminal)", () => {
  it("final → answered and aborted → cancelled, keyed by the runId (the prompt's key)", () => {
    expect(ownRunTerminal({ state: "final", runId: "p-1" })).toStrictEqual({
      key: "p-1",
      facts: { answered: true },
    });
    expect(ownRunTerminal({ state: "aborted", runId: "p-1" })).toStrictEqual({
      key: "p-1",
      facts: { cancelled: true },
    });
  });

  it("an error records nothing: a fallback model can still carry the run", () => {
    expect(ownRunTerminal({ state: "error", runId: "p-1" })).toBeNull();
  });

  it("a disposition final records nothing: it PLACED the prompt (U3's chatTerminalScope)", () => {
    for (const disposition of ["steered", "backlogged", "dropped"]) {
      expect(ownRunTerminal({ state: "final", runId: "p-1", disposition })).toBeNull();
    }
    // An old gateway's early final carries no field: read as the answer, as before.
    expect(ownRunTerminal({ state: "final", runId: "p-1", disposition: null })).toStrictEqual({
      key: "p-1",
      facts: { answered: true },
    });
  });

  it("no runId, or no terminal, names nothing", () => {
    expect(ownRunTerminal({ state: "aborted" })).toBeNull();
    expect(ownRunTerminal({ state: "aborted", runId: "" })).toBeNull();
    expect(ownRunTerminal({ state: "delta", runId: "p-1" })).toBeNull();
    expect(ownRunTerminal(null)).toBeNull();
    expect(ownRunTerminal(undefined)).toBeNull();
  });

  it("PQ-6: the first own-run terminal stands (answered or cancelled); failed is not one", () => {
    expect(ownRunTerminalRecorded({ answered: true })).toBe(true);
    expect(ownRunTerminalRecorded({ cancelled: true })).toBe(true);
    expect(ownRunTerminalRecorded({ failed: true })).toBe(false);
    expect(ownRunTerminalRecorded({ transport: "acked" })).toBe(false);
    expect(ownRunTerminalRecorded(null)).toBe(false);
    expect(ownRunTerminalRecorded(undefined)).toBe(false);
  });

  it("a stopped prompt derives CANCELLED where it would otherwise be LOST", () => {
    const facts: PromptStateInputs = { transport: "acked", noGatewayHolder: true };
    // CONTROL — no terminal fact: an acked prompt no holder has is LOST, with Resend.
    expect(derivePromptState(facts)).toBe("LOST");
    Object.assign(facts, ownRunTerminal({ state: "aborted", runId: "p-1" })?.facts);
    expect(derivePromptState(facts)).toBe("CANCELLED");
  });
});
