import { describe, expect, it } from "vitest";
import {
  BREAKER_OPEN_MS,
  BREAKER_TRIP_THRESHOLD,
  FractalGovernor,
  HARD_UTILIZATION_CEILING,
  QUOTA_WINDOW_MS,
  SPAWN_TOKEN_CEILING_PER_HOUR,
  USAGE_MEMO_TTL_MS,
  type UsageSnapshot,
} from "./governor.js";

const MINUTE = 60_000;

function makeClock(startMs = 10_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeGovernor(
  usage: UsageSnapshot | null | (() => UsageSnapshot | null),
  clock = makeClock(),
) {
  let reads = 0;
  const governor = new FractalGovernor({
    now: clock.now,
    readUsage: async () => {
      reads += 1;
      return typeof usage === "function" ? usage() : usage;
    },
  });
  return { governor, clock, readCount: () => reads };
}

describe("governor derived pressure", () => {
  it("pressure is strictly monotonic in utilization at fixed time-to-reset", async () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const u of [0, 0.2, 0.4, 0.6, 0.8]) {
      const clock = makeClock();
      const { governor } = makeGovernor(
        { utilization5h: u, resetsAtMs: clock.now() + QUOTA_WINDOW_MS / 2 },
        clock,
      );
      const decision = await governor.mode("triage");
      expect(decision.pressure).toBeGreaterThan(previous);
      previous = decision.pressure;
    }
  });

  it("near-reset low utilization is spendable surplus: pressure drops BELOW the neutral baseline", async () => {
    const clockNear = makeClock();
    const { governor: nearReset } = makeGovernor(
      { utilization5h: 0.3, resetsAtMs: clockNear.now() + 5 * MINUTE },
      clockNear,
    );
    const clockMid = makeClock();
    const { governor: midWindow } = makeGovernor(
      { utilization5h: 0.3, resetsAtMs: clockMid.now() + QUOTA_WINDOW_MS / 2 },
      clockMid,
    );

    const near = await nearReset.mode("triage");
    const mid = await midWindow.mode("triage");

    // Bidirectional score: surplus goes below 0, and nearer reset = lower pressure.
    expect(near.pressure).toBeLessThan(0);
    expect(near.pressure).toBeLessThan(mid.pressure);
    expect(near.mode).toBe("full");
    expect(near.reason).toContain("surplus");
  });

  it("evidence-backed work tolerates higher pressure than speculative triage", async () => {
    // utilization 0.95-capped? keep under the hard ceiling: 0.8 utilization,
    // early in the window -> high positive pressure.
    const clock = makeClock();
    const { governor } = makeGovernor(
      { utilization5h: 0.8, resetsAtMs: clock.now() + QUOTA_WINDOW_MS * 0.8 },
      clock,
    );
    // pressure = 0.8 - 0.2 = 0.6 -> triage effective 0.6 (skip), fix effective 0.4 (also skip)
    const triage = await governor.mode("triage");
    expect(triage.mode).toBe("skip");

    const clock2 = makeClock();
    const { governor: governor2 } = makeGovernor(
      { utilization5h: 0.8, resetsAtMs: clock2.now() + QUOTA_WINDOW_MS * 0.6 },
      clock2,
    );
    // pressure = 0.8 - 0.4 = 0.4 -> triage effective 0.4 > 0.35 (skip);
    // fix effective 0.2 <= 0.35 (NOT skip).
    const triage2 = await governor2.mode("triage");
    const fix2 = await governor2.mode("evidence-backed-fix");
    expect(triage2.mode).toBe("skip");
    expect(fix2.mode).not.toBe("skip");
  });

  it("hard utilization ceiling skips regardless of surplus pressure", async () => {
    const clock = makeClock();
    const { governor } = makeGovernor(
      // Minutes before reset: pressure is NEGATIVE here, but the 0.85 ceiling rules.
      { utilization5h: 0.9, resetsAtMs: clock.now() + 5 * MINUTE },
      clock,
    );
    const triage = await governor.mode("triage");
    const fix = await governor.mode("evidence-backed-fix");
    expect(triage.pressure).toBeLessThan(0);
    expect(triage.mode).toBe("skip");
    expect(fix.mode).toBe("skip");
    expect(triage.reason).toContain(`hard ceiling ${HARD_UTILIZATION_CEILING}`);
  });

  it("null usage fails to NEUTRAL: triage and fix allowed, pressure 0, reason says bucket-governed", async () => {
    const { governor } = makeGovernor(null);
    const triage = await governor.mode("triage");
    const fix = await governor.mode("evidence-backed-fix");
    expect(triage.mode).toBe("full");
    expect(triage.pressure).toBe(0);
    expect(triage.reason).toContain("fail-to-neutral");
    expect(triage.reason).toContain("spawn bucket");
    expect(fix.mode).toBe("full");
  });

  it("a throwing usage reader also fails to neutral", async () => {
    const clock = makeClock();
    const governor = new FractalGovernor({
      now: clock.now,
      readUsage: async () => {
        throw new Error("usage endpoint 403");
      },
    });
    const decision = await governor.mode("triage");
    expect(decision.mode).toBe("full");
    expect(decision.pressure).toBe(0);
  });

  it("a reset timestamp in the past is STALE and fails to neutral", async () => {
    const clock = makeClock();
    const { governor } = makeGovernor(
      { utilization5h: 0.99, resetsAtMs: clock.now() - MINUTE },
      clock,
    );
    const decision = await governor.mode("triage");
    expect(decision.mode).toBe("full");
    expect(decision.pressure).toBe(0);
    expect(decision.reason).toContain("stale");
  });

  it("memoizes usage reads inside the TTL ceiling and re-reads after it", async () => {
    const clock = makeClock();
    const { governor, readCount } = makeGovernor(
      { utilization5h: 0.1, resetsAtMs: clock.now() + QUOTA_WINDOW_MS },
      clock,
    );
    await governor.mode("triage");
    await governor.mode("evidence-backed-fix");
    expect(readCount()).toBe(1);

    clock.advance(USAGE_MEMO_TTL_MS + 1);
    await governor.mode("triage");
    expect(readCount()).toBe(2);
  });
});

describe("governor spawn token bucket", () => {
  it("exhausts at the hourly ceiling and refills continuously on the fake clock", () => {
    const { governor, clock } = makeGovernor(null);

    for (let i = 0; i < SPAWN_TOKEN_CEILING_PER_HOUR; i++) {
      expect(governor.tryTakeSpawnToken()).toBe(true);
    }
    expect(governor.tryTakeSpawnToken()).toBe(false);

    // Continuous refill: one token per (1h / ceiling) = 2 minutes at 30/h.
    clock.advance(3_600_000 / SPAWN_TOKEN_CEILING_PER_HOUR);
    expect(governor.tryTakeSpawnToken()).toBe(true);
    expect(governor.tryTakeSpawnToken()).toBe(false);

    // A long idle refills to the ceiling, never past it.
    clock.advance(10 * 3_600_000);
    for (let i = 0; i < SPAWN_TOKEN_CEILING_PER_HOUR; i++) {
      expect(governor.tryTakeSpawnToken()).toBe(true);
    }
    expect(governor.tryTakeSpawnToken()).toBe(false);
  });
});

describe("governor circuit breaker", () => {
  it("opens after 3 consecutive crash failures, half-opens after the window, closes on probe success", () => {
    const { governor, clock } = makeGovernor(null);

    expect(governor.breakerState().state).toBe("closed");
    for (let i = 0; i < BREAKER_TRIP_THRESHOLD; i++) {
      governor.recordOutcome(false, "crash");
    }
    const open = governor.breakerState();
    expect(open.state).toBe("open");
    expect(open.opensAtMs).toBe(clock.now() + BREAKER_OPEN_MS);

    clock.advance(BREAKER_OPEN_MS);
    expect(governor.breakerState().state).toBe("half-open");

    governor.recordOutcome(true);
    expect(governor.breakerState().state).toBe("closed");
  });

  it("a failed half-open probe re-opens for another full window", () => {
    const { governor, clock } = makeGovernor(null);
    for (let i = 0; i < BREAKER_TRIP_THRESHOLD; i++) {
      governor.recordOutcome(false, "crash");
    }
    clock.advance(BREAKER_OPEN_MS);
    expect(governor.breakerState().state).toBe("half-open");

    governor.recordOutcome(false, "crash");
    const reopened = governor.breakerState();
    expect(reopened.state).toBe("open");
    expect(reopened.opensAtMs).toBe(clock.now() + BREAKER_OPEN_MS);
  });

  it("budget-exhausted failures do NOT count toward the breaker", () => {
    const { governor } = makeGovernor(null);
    for (let i = 0; i < BREAKER_TRIP_THRESHOLD + 2; i++) {
      governor.recordOutcome(false, "budget-exhausted");
    }
    expect(governor.breakerState().state).toBe("closed");
  });

  it("budget-exhausted is transparent: it does not break a crash streak either", () => {
    const { governor } = makeGovernor(null);
    governor.recordOutcome(false, "crash");
    governor.recordOutcome(false, "crash");
    governor.recordOutcome(false, "budget-exhausted");
    governor.recordOutcome(false, "crash");
    expect(governor.breakerState().state).toBe("open");
  });

  it("a success resets the consecutive-failure streak", () => {
    const { governor } = makeGovernor(null);
    governor.recordOutcome(false, "crash");
    governor.recordOutcome(false, "crash");
    governor.recordOutcome(true);
    governor.recordOutcome(false, "crash");
    governor.recordOutcome(false, "crash");
    expect(governor.breakerState().state).toBe("closed");
    governor.recordOutcome(false, "crash");
    expect(governor.breakerState().state).toBe("open");
  });
});

describe("governor adaptive-pressure warns (~80% of any ceiling)", () => {
  it("warns in the reason when utilization approaches the hard ceiling", async () => {
    const clock = makeClock();
    const { governor } = makeGovernor(
      // 0.7 >= 0.8 * 0.85 = 0.68 -> warn; still below the 0.85 cliff.
      { utilization5h: 0.7, resetsAtMs: clock.now() + QUOTA_WINDOW_MS / 2 },
      clock,
    );
    const decision = await governor.mode("triage");
    expect(decision.mode).not.toBe("skip");
    expect(decision.reason).toContain("WARN");
    expect(decision.reason).toContain("hard ceiling");
  });

  it("warns in the reason when the spawn bucket is mostly consumed", async () => {
    const { governor } = makeGovernor(null);
    const toConsume = Math.ceil(SPAWN_TOKEN_CEILING_PER_HOUR * 0.8);
    for (let i = 0; i < toConsume; i++) {
      expect(governor.tryTakeSpawnToken()).toBe(true);
    }
    const decision = await governor.mode("triage");
    expect(decision.reason).toContain("spawn token bucket");
  });

  it("warns in the reason one failure before the breaker trips", async () => {
    const { governor } = makeGovernor(null);
    governor.recordOutcome(false, "crash");
    governor.recordOutcome(false, "crash");
    const decision = await governor.mode("triage");
    expect(decision.reason).toContain("breaker failure streak");
    expect(governor.breakerState().state).toBe("closed");
  });
});
