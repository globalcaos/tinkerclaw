// FORK 2026-07-26 — regression guard for the six-day silent cron blackout.
//
// Every job enqueued its brief onto the main session queue, the wake landed on
// a different session, the woken turn peeked an empty queue and answered a bare
// heartbeat poll in ~8s, and the run log recorded status "ok". The fleet looked
// green while producing nothing. These tests pin the rule that makes that
// impossible: a run whose payload is still queued after the wake is a FAILURE.

import { beforeEach, describe, expect, it } from "vitest";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../infra/system-events.js";
import { isCronPayloadStillQueued, resolveCronWakeOutcome } from "./server-cron.js";

const SESSION = "agent:main:main";

describe("resolveCronWakeOutcome", () => {
  it("reports a failure when the payload is still queued after a 'ran' wake", () => {
    const outcome = resolveCronWakeOutcome({
      result: { status: "ran", durationMs: 8_461 },
      payloadStillQueued: true,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome).toHaveProperty("reason");
    expect((outcome as { reason: string }).reason).toMatch(/phantom run/i);
  });

  it("passes a genuine run through untouched", () => {
    const result = { status: "ran", durationMs: 117_448 } as const;
    expect(resolveCronWakeOutcome({ result, payloadStillQueued: false })).toEqual(result);
  });

  it("never upgrades or masks a non-'ran' result", () => {
    const skipped = { status: "skipped", reason: "requests-in-flight" } as const;
    const failed = { status: "failed", reason: "boom" } as const;
    // A skipped wake legitimately leaves the payload queued for the next wake —
    // that must stay "skipped", not become a phantom failure.
    expect(resolveCronWakeOutcome({ result: skipped, payloadStillQueued: true })).toEqual(skipped);
    expect(resolveCronWakeOutcome({ result: failed, payloadStillQueued: true })).toEqual(failed);
  });
});

describe("isCronPayloadStillQueued", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("detects this job's own undelivered payload", () => {
    enqueueSystemEvent("[Life Butler] Cron fired.", {
      sessionKey: SESSION,
      contextKey: "cron:life-butler",
    });
    expect(isCronPayloadStillQueued(SESSION, "cron:life-butler")).toBe(true);
  });

  it("returns false once the queue is empty (payload delivered)", () => {
    expect(isCronPayloadStillQueued(SESSION, "cron:life-butler")).toBe(false);
  });

  it("does not mistake ANOTHER job's event for its own", () => {
    // A second cron firing during a long-running turn must not turn a healthy
    // run red — the guard matches on this job's contextKey, not queue depth.
    enqueueSystemEvent("[Model Rank Refresh] Cron fired.", {
      sessionKey: SESSION,
      contextKey: "cron:model-rank-refresh",
    });
    expect(isCronPayloadStillQueued(SESSION, "cron:life-butler")).toBe(false);
  });

  it("ignores non-cron wake reasons", () => {
    enqueueSystemEvent("something", { sessionKey: SESSION, contextKey: "cron:life-butler" });
    expect(isCronPayloadStillQueued(SESSION, "wake")).toBe(false);
    expect(isCronPayloadStillQueued(SESSION, undefined)).toBe(false);
  });

  it("is scoped to the session the payload was queued on", () => {
    enqueueSystemEvent("[Life Butler] Cron fired.", {
      sessionKey: SESSION,
      contextKey: "cron:life-butler",
    });
    expect(isCronPayloadStillQueued("agent:main:heartbeat", "cron:life-butler")).toBe(false);
  });
});
