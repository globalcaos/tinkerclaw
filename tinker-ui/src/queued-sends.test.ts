import { describe, it, expect } from "vitest";
import {
  queuedBelongsToSession,
  queuedForSession,
  settleQueuedSession,
  shouldQueue,
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
    expect(shouldQueue({ hasActiveRunForSession: false, streamRunId: null, sending: false })).toBe(
      false,
    );
  });

  it("queues while a run is active for the session", () => {
    expect(shouldQueue({ hasActiveRunForSession: true, streamRunId: null, sending: false })).toBe(
      true,
    );
  });

  it("queues while a stream is in flight", () => {
    expect(
      shouldQueue({ hasActiveRunForSession: false, streamRunId: "run-1", sending: false }),
    ).toBe(true);
  });

  it("BUG REPRO (turn-start gap): queues when `sending` is set but the first run/stream has not registered yet", () => {
    // The instant a turn starts, send() sets `sending = true` BEFORE the first phase:start/delta
    // registers a run or a streamRunId. A second prompt typed in that window must still be queued,
    // or it gets pushed into messages[] and the turn's own bubbles land after it. The old gate
    // (hasActiveRunForSession || streamRunId != null) missed this window.
    expect(shouldQueue({ hasActiveRunForSession: false, streamRunId: null, sending: true })).toBe(
      true,
    );
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
