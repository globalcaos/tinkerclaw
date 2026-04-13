import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CongestionController } from "./congestion.js";

describe("CongestionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 delay for single agent", () => {
    const ctrl = new CongestionController();
    const delay = ctrl.computeDelay("chat1", "mia", 1);
    expect(delay).toBe(0);
  });

  it("returns 0 delay when disabled", () => {
    const ctrl = new CongestionController({ enabled: false });
    const delay = ctrl.computeDelay("chat1", "mia", 5);
    expect(delay).toBe(0);
  });

  it("computes quadratic delay for multiple agents", () => {
    const ctrl = new CongestionController({ baseDelayFactor: 100 });
    // Mock Math.random to return 0 (no jitter)
    vi.spyOn(Math, "random").mockReturnValue(0);

    const delay = ctrl.computeDelay("chat1", "mia", 3);
    // baseDelay = 100 * 9 = 900, jitter = 0, backpressure = 1.0
    expect(delay).toBe(900);
  });

  it("caps delay at maxDelay", () => {
    const ctrl = new CongestionController({ baseDelayFactor: 500, maxDelay: 5000 });
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const delay = ctrl.computeDelay("chat1", "mia", 10);
    // baseDelay = 500 * 100 = 50000, jitter = 25000, total = 75000 → capped at 5000
    expect(delay).toBe(5000);
  });

  it("applies backpressure when agent talks too much", () => {
    const ctrl = new CongestionController({ baseDelayFactor: 100 });
    vi.spyOn(Math, "random").mockReturnValue(0);

    // Mia sends 5 messages, Luna sends 1
    for (let i = 0; i < 5; i++) {
      ctrl.recordMessage("chat1", "mia");
    }
    ctrl.recordMessage("chat1", "luna");

    // Mia: 5 messages, fair share = 6/2 = 3, 5 > 3 * 1.5 = 4.5 → backpressure 2x
    const miaDelay = ctrl.computeDelay("chat1", "mia", 2);
    const lunaDelay = ctrl.computeDelay("chat1", "luna", 2);

    expect(miaDelay).toBeGreaterThan(lunaDelay);
  });

  it("tracks recent messages correctly", () => {
    const ctrl = new CongestionController();
    ctrl.recordMessage("chat1", "mia");
    ctrl.recordMessage("chat1", "luna");
    ctrl.recordMessage("chat1", "mia");

    expect(ctrl.getRecentCount("chat1")).toBe(3);
    expect(ctrl.getAgentCount("chat1", "mia")).toBe(2);
    expect(ctrl.getAgentCount("chat1", "luna")).toBe(1);
  });

  it("prunes messages outside window", () => {
    const ctrl = new CongestionController({ windowMs: 10_000 });
    ctrl.recordMessage("chat1", "mia");

    vi.advanceTimersByTime(15_000);

    expect(ctrl.getRecentCount("chat1")).toBe(0);
  });

  it("detects yield condition", () => {
    const ctrl = new CongestionController();
    const before = Date.now();

    vi.advanceTimersByTime(100);
    ctrl.recordMessage("chat1", "luna");

    expect(ctrl.shouldYield("chat1", before)).toBe(true);
    expect(ctrl.shouldYield("chat1", Date.now())).toBe(false);
  });
});
