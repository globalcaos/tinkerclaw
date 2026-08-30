import { describe, it, expect, afterEach } from "vitest";
import { setUsageSnapshot } from "../infra/usage-snapshot-store.js";
import {
  allocateEffort,
  deriveQuotaPressure,
  userTaskLength,
  type EffortCalib,
} from "./effort-allocator.js";

const calib = (count: number, perLevel: Record<string, number> = {}): EffortCalib => ({
  count,
  perLevel,
});

// Policy: `pressure` is −shouldBurn (the weekly burn-down demand). burnDemand = clamp01(−pressure)
// sets a rising effort FLOOR (round(burnDemand·5)); coarse task weight can push higher; exploration
// fills data when NOT urgent (epsilon ∝ 1−burnDemand) but never undercuts the floor. NO 5h ceiling.
describe("deriveQuotaPressure — multi-account binding constraint (§5.84b)", () => {
  afterEach(() => setUsageSnapshot(null));

  it("drives burn-down from the MAX-headroom (min-util) account, not the MAX-util one", () => {
    const now = Date.UTC(2026, 5, 19);
    const reset = now + 3 * 24 * 3600_000; // 3 days out
    setUsageSnapshot({
      lastSuccessfulFetch: now,
      providers: {
        anthropic: {
          sevenDayUtilization: 90,
          fiveHourUtilization: 50,
          sevenDayResetAt: reset,
          accounts: [
            {
              label: "cli-sv",
              sevenDayUtilization: 90,
              fiveHourUtilization: 50,
              sevenDayResetAt: reset,
            },
            {
              label: "cli-gm",
              sevenDayUtilization: 10,
              fiveHourUtilization: 5,
              sevenDayResetAt: reset,
            },
          ],
        },
      },
    });
    const qp = deriveQuotaPressure(now);
    expect(qp.bindingAccount).toBe("cli-gm"); // min util governs (last to exhaust)
    expect(qp.utilization7d).toBeCloseTo(0.1, 3); // NOT 0.90 (the old MAX collapse)
    expect(qp.pressure).toBeLessThan(0); // real headroom → real burn demand
  });

  it("falls back to the collapsed scalar when accounts[] is absent (back-compat)", () => {
    const now = Date.UTC(2026, 5, 19);
    setUsageSnapshot({
      lastSuccessfulFetch: now,
      providers: {
        anthropic: {
          sevenDayUtilization: 40,
          fiveHourUtilization: 20,
          sevenDayResetAt: now + 4 * 24 * 3600_000,
        },
      },
    });
    const qp = deriveQuotaPressure(now);
    expect(qp.utilization7d).toBeCloseTo(0.4, 3);
    expect(qp.bindingAccount).toBeUndefined();
  });
});

describe("allocateEffort — burn-down effort allocator policy (bible §5.84 / §5.84a)", () => {
  it("burns through the 5h cap (no hard utilization ceiling): full burn demand → max", () => {
    // pressure -1 → burnDemand 1 → floor idx 5; mature → no exploration → exploit the floor.
    expect(allocateEffort({ pressure: -1, calib: calib(48), taskLen: 50, tick: 1 })).toBe("max");
  });

  it("burn-down FLOOR rises with demand: floors a short prompt at high (mature, demand 0.6)", () => {
    // burnDemand 0.6 → floor round(3) = high; the short-prompt task weight (low) is lifted to the floor.
    expect(allocateEffort({ pressure: -0.6, calib: calib(48), taskLen: 50, tick: 1 })).toBe("high");
  });

  it("no burn demand (chill early week): exploits coarse task weight", () => {
    expect(allocateEffort({ pressure: 0, calib: calib(48), taskLen: 50, tick: 7 })).toBe("low");
    expect(allocateEffort({ pressure: 0, calib: calib(48), taskLen: 2000, tick: 7 })).toBe("high");
  });

  it("explores to gather data when NOT urgent (cold, low demand) — never below the burn floor", () => {
    // burnDemand 0.2 → floor idx 1; cold → epsilon high → tick 0 explores the least-sampled level ≥ floor.
    const level = allocateEffort({
      pressure: -0.2,
      calib: calib(0, { minimal: 9, low: 9, medium: 0, high: 9, xhigh: 9, max: 9 }),
      taskLen: 100,
      tick: 0,
    });
    expect(level).toBe("medium");
  });

  it("suppresses exploration near reset: high demand exploits the burn floor even when cold", () => {
    // burnDemand 0.8 → floor round(4) = xhigh; epsilon ∝ (1−demand) is low → not exploring at tick 1.
    const level = allocateEffort({
      pressure: -0.8,
      calib: calib(0, { minimal: 0, low: 0, medium: 0, high: 0, xhigh: 0, max: 0 }),
      taskLen: 50,
      tick: 1,
    });
    expect(level).toBe("xhigh");
  });
});

// FORK 2026-07-26 (the architect: "when I move the effort level it magically hops to high") — the
// UI appends a ~3,369-char FRACTAL trailer to EVERY message, which saturated the task-size
// bucket (`taskLen >= 1200 -> high`) so the allocator could never pick low or medium.
describe("userTaskLength — the size heuristic measures the USER's ask, not our envelope", () => {
  // The real trailer is ~3,369 chars; anything over the 1200 `high` cutoff reproduces the bug.
  const FRACTAL_TRAILER =
    "\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line " +
    (
      "(blank line before it). Fractal is the slow thinker: judge the finished turn, then leave " +
      "DURABLE change — write the lesson or fix to disk NOW instead of describing it. "
    ).repeat(20);

  it("strips the injected trailer so a short question stays short", () => {
    const asked = "what time is it?";
    expect(FRACTAL_TRAILER.length).toBeGreaterThan(1200); // the trailer alone saturates the bucket
    expect(userTaskLength(asked + FRACTAL_TRAILER)).toBe(asked.length);
  });

  it("keeps a genuinely long request long", () => {
    const long = "x".repeat(5000);
    expect(userTaskLength(long + FRACTAL_TRAILER)).toBe(5000);
  });

  it("a short question no longer lands in the high bucket", () => {
    const withTrailer = "hi" + FRACTAL_TRAILER;
    // pre-fix behaviour: raw length is >1200 -> taskIdx 3 (high)
    expect(withTrailer.length).toBeGreaterThanOrEqual(1200);
    // post-fix: measured length is tiny -> the low bucket
    expect(userTaskLength(withTrailer)).toBeLessThan(280);
  });

  it("handles an absent prompt and a bare marker", () => {
    expect(userTaskLength(undefined)).toBe(0);
    expect(userTaskLength("")).toBe(0);
    expect(userTaskLength("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> blah")).toBe(0);
  });
});
