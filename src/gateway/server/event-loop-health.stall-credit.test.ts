import { describe, expect, it } from "vitest";
import {
  createStallClock,
  stallAwareDeadlineMs,
  startStallAwareDeadline,
} from "./event-loop-health.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < until) {
    await sleep(10);
  }
}

// A synchronous busy-wait: exactly the kind of stall the gateway suffered on
// 2026-08-28 when it killed pre-auth peers for its own blockage.
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy-wait
  }
}

describe("gateway stall clock", () => {
  it("accrues credit while the event loop is blocked", async () => {
    const clock = createStallClock({ tickMs: 10 });
    try {
      await sleep(50);
      const beforeBlock = Date.now();
      blockEventLoop(200);
      await sleep(30);
      const credit = clock.stallCreditSince(beforeBlock);
      // The 200 ms block must be visible (generous slack for scheduler noise).
      expect(credit).toBeGreaterThanOrEqual(120);
    } finally {
      clock.stop();
    }
  });

  it("stallCreditSince is monotonic and unaffected by concurrent readers", async () => {
    const clock = createStallClock({ tickMs: 10 });
    try {
      const origin = Date.now();
      await sleep(30);
      blockEventLoop(120);
      await sleep(30);
      const first = clock.stallCreditSince(origin);
      // A concurrent windowed reader (the readiness snapshot path) must not
      // reset anything the credit depends on - the replaced histograms did.
      clock.createReader().read();
      const second = clock.stallCreditSince(origin);
      expect(second).toBeGreaterThanOrEqual(first);
      blockEventLoop(80);
      await sleep(30);
      const third = clock.stallCreditSince(origin);
      expect(third).toBeGreaterThanOrEqual(second + 40);
    } finally {
      clock.stop();
    }
  });

  it("gives independent windows to independent readers (no destructive reset)", async () => {
    const clock = createStallClock({ tickMs: 10 });
    try {
      const readerA = clock.createReader();
      const readerB = clock.createReader();
      blockEventLoop(100);
      await sleep(30);
      const windowA = readerA.read();
      const windowB = readerB.read();
      // Under the replaced monitorEventLoopDelay design, the first read() reset
      // the histogram and the second saw nothing.
      expect(windowA.latenessMaxMs).toBeGreaterThanOrEqual(50);
      expect(windowB.latenessMaxMs).toBeGreaterThanOrEqual(50);
    } finally {
      clock.stop();
    }
  });
});

describe("stallAwareDeadlineMs", () => {
  it("caps the credit at 1x the budget", () => {
    expect(stallAwareDeadlineMs(10_000, 0)).toBe(10_000);
    expect(stallAwareDeadlineMs(10_000, 4_000)).toBe(14_000);
    expect(stallAwareDeadlineMs(10_000, 10_000)).toBe(20_000);
    expect(stallAwareDeadlineMs(10_000, 25_000)).toBe(20_000);
    expect(stallAwareDeadlineMs(10_000, -50)).toBe(10_000);
    expect(stallAwareDeadlineMs(0, 500)).toBe(0);
  });
});

describe("startStallAwareDeadline", () => {
  it("expires a dead peer at the budget when no stall accrued", async () => {
    const expiries: Array<{ elapsedMs: number; stallCreditMs: number }> = [];
    const deadline = startStallAwareDeadline({
      budgetMs: 40,
      startedAtMs: Date.now(),
      stallCreditSince: () => 0,
      onExpire: (info) => expiries.push(info),
    });
    try {
      await waitFor(() => expiries.length === 1, 1_000);
      expect(expiries).toHaveLength(1);
      expect(expiries[0].stallCreditMs).toBe(0);
      expect(expiries[0].elapsedMs).toBeGreaterThanOrEqual(38);
    } finally {
      deadline.clear();
    }
  });

  it("still expires within budget + 1x cap of real time under unbounded credit", async () => {
    const expiries: Array<{ elapsedMs: number; stallCreditMs: number }> = [];
    const deadline = startStallAwareDeadline({
      budgetMs: 40,
      startedAtMs: Date.now(),
      // Credit far above the cap: uncapped, this deadline would never fire and
      // a dead peer would never be detected.
      stallCreditSince: () => 1_000_000,
      onExpire: (info) => expiries.push(info),
    });
    try {
      await waitFor(() => expiries.length === 1, 2_000);
      expect(expiries).toHaveLength(1);
      // Capped at 1x budget, so it fired at ~budget + cap (= 2x budget).
      expect(expiries[0].stallCreditMs).toBe(40);
      expect(expiries[0].elapsedMs).toBeGreaterThanOrEqual(75);
    } finally {
      deadline.clear();
    }
  });

  it("re-arms for the remainder when credit accrues mid-window", async () => {
    const expiries: Array<{ elapsedMs: number; stallCreditMs: number }> = [];
    let credit = 0;
    const deadline = startStallAwareDeadline({
      budgetMs: 40,
      startedAtMs: Date.now(),
      stallCreditSince: () => credit,
      onExpire: (info) => expiries.push(info),
    });
    try {
      credit = 30; // a stall consumed 30 ms of the 40 ms budget
      await waitFor(() => expiries.length === 1, 2_000);
      expect(expiries).toHaveLength(1);
      expect(expiries[0].stallCreditMs).toBe(30);
      expect(expiries[0].elapsedMs).toBeGreaterThanOrEqual(65);
    } finally {
      deadline.clear();
    }
  });

  // The regression this whole unit exists for, with its CONTROL: run the OLD
  // naive wall-clock deadline and the NEW stall-aware one side by side over the
  // same event-loop stall. The naive one must fire (it really does kill a live
  // peer for the gateway's own blockage) while the stall-aware one must not -
  // an assertion with no control would pass equally against a deadline that
  // simply never fires, which is why the third leg re-checks that the peer
  // still dies once real time exceeds budget + cap.
  it("naive wall clock kills the peer on our own stall; stall-aware does not", async () => {
    const budgetMs = 200;
    const clock = createStallClock({ tickMs: 10 });
    let naiveFired = false;
    let stallAwareFired = false;
    let naiveTimer: NodeJS.Timeout | undefined;
    let deadline: ReturnType<typeof startStallAwareDeadline> | undefined;
    try {
      await sleep(30); // prime the clock so a pre-stall baseline sample exists
      const startedAtMs = Date.now();
      naiveTimer = setTimeout(() => {
        naiveFired = true;
      }, budgetMs);
      deadline = startStallAwareDeadline({
        budgetMs,
        startedAtMs,
        stallCreditSince: (tsMs) => clock.stallCreditSince(tsMs),
        onExpire: () => {
          stallAwareFired = true;
        },
      });
      // The gateway blocks its own loop for longer than the whole budget: the
      // peer is perfectly alive, it just never got scheduled.
      blockEventLoop(260);
      await sleep(20); // drain the overdue timers queued behind the block

      expect(naiveFired).toBe(true); // CONTROL: the shipped behaviour today
      expect(stallAwareFired).toBe(false); // the fix

      // ...and the deadline is still a deadline: a peer that never completes
      // the handshake dies once real time passes budget + the 1x cap.
      await waitFor(() => stallAwareFired, 2_000);
      expect(stallAwareFired).toBe(true);
      expect(Date.now() - startedAtMs).toBeGreaterThanOrEqual(budgetMs);
    } finally {
      if (naiveTimer !== undefined) {
        clearTimeout(naiveTimer);
      }
      deadline?.clear();
      clock.stop();
    }
  });
});
