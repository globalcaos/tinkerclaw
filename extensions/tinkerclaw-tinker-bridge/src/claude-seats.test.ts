import { describe, expect, it } from "vitest";
import {
  chooseSeat,
  seatBlockedUntil,
  seatStateFromEvent,
  type SeatState,
} from "./claude-seats.js";

const H = 3_600_000;
const NOW = Date.parse("2026-11-03T18:00:00Z");
// Seat A's week resets Thursday, seat B's Saturday: A is the one to spend first.
const A_WEEK = Date.parse("2026-11-05T16:00:00Z");
const B_WEEK = Date.parse("2026-11-07T06:00:00Z");
const SEATS = ["primary", "anthropic:seat-b"];

function state(p: {
  five?: number;
  fiveReset?: number;
  week?: number;
  weekReset?: number;
  rejected?: "five" | "week";
}): SeatState {
  return {
    at: NOW,
    ...(p.five != null || p.rejected === "five"
      ? {
          fiveHour: {
            utilization: p.five ?? 1,
            resetsAt: p.fiveReset,
            status: p.rejected === "five" ? "rejected" : "allowed",
          },
        }
      : {}),
    sevenDay: {
      utilization: p.week ?? 0,
      resetsAt: p.weekReset,
      status: p.rejected === "week" ? "rejected" : "allowed",
    },
  };
}

describe("chooseSeat", () => {
  it("with one seat there is nothing to choose", () => {
    expect(chooseSeat(["primary"], {}, NOW)).toBe("primary");
  });

  it("spends the seat whose weekly reset comes first", () => {
    const states = {
      primary: state({ week: 0.67, weekReset: A_WEEK }),
      "anthropic:seat-b": state({ week: 0, weekReset: B_WEEK }),
    };
    expect(chooseSeat(SEATS, states, NOW)).toBe("primary");
    // The order of the list does not matter, only the reset.
    expect(chooseSeat([...SEATS].reverse(), states, NOW)).toBe("primary");
  });

  it("moves to the other seat when the 5h window is spent, and back once it resets", () => {
    const fiveReset = NOW + 2 * H;
    const states = {
      primary: state({ five: 1, fiveReset, week: 0.7, weekReset: A_WEEK }),
      "anthropic:seat-b": state({ week: 0.1, weekReset: B_WEEK }),
    };
    expect(chooseSeat(SEATS, states, NOW)).toBe("anthropic:seat-b");
    expect(chooseSeat(SEATS, states, fiveReset + 1)).toBe("primary");
  });

  it("treats a rejected window as spent even below 100%", () => {
    const states = {
      primary: state({ rejected: "five", five: 0.97, fiveReset: NOW + H, weekReset: A_WEEK }),
      "anthropic:seat-b": state({ weekReset: B_WEEK }),
    };
    expect(chooseSeat(SEATS, states, NOW)).toBe("anthropic:seat-b");
  });

  it("moves for the rest of the week when the weekly window is spent", () => {
    const states = {
      primary: state({ week: 1, weekReset: A_WEEK }),
      "anthropic:seat-b": state({ week: 0.2, weekReset: B_WEEK }),
    };
    expect(chooseSeat(SEATS, states, NOW)).toBe("anthropic:seat-b");
    // After A's weekly reset, B's Saturday reset is the nearest one: B is spent first.
    expect(chooseSeat(SEATS, states, A_WEEK + H)).toBe("anthropic:seat-b");
    // After B's reset too, A's next Thursday comes first again.
    expect(chooseSeat(SEATS, states, B_WEEK + H)).toBe("primary");
  });

  it("uses a seat nobody has measured only when every measured seat is blocked", () => {
    expect(chooseSeat(SEATS, { primary: state({ weekReset: A_WEEK }) }, NOW)).toBe("primary");
    expect(
      chooseSeat(
        SEATS,
        { primary: state({ five: 1, fiveReset: NOW + H, weekReset: A_WEEK }) },
        NOW,
      ),
    ).toBe("anthropic:seat-b");
  });

  it("with every seat blocked, picks the one that frees up first", () => {
    const states = {
      primary: state({ week: 1, weekReset: A_WEEK }),
      "anthropic:seat-b": state({ five: 1, fiveReset: NOW + H, weekReset: B_WEEK }),
    };
    expect(chooseSeat(SEATS, states, NOW)).toBe("anthropic:seat-b");
  });
});

describe("seatBlockedUntil", () => {
  it("is undefined for a seat with room or no data, and the latest reset when blocked", () => {
    expect(seatBlockedUntil(undefined, NOW)).toBeUndefined();
    expect(seatBlockedUntil(state({ five: 0.5, fiveReset: NOW + H }), NOW)).toBeUndefined();
    expect(
      seatBlockedUntil(state({ five: 1, fiveReset: NOW + H, week: 1, weekReset: A_WEEK }), NOW),
    ).toBe(A_WEEK);
  });

  it("assumes the window's length when a spent window carries no reset", () => {
    expect(seatBlockedUntil(state({ five: 1 }), NOW)).toBe(NOW + 5 * H);
  });
});

describe("seatStateFromEvent", () => {
  it("reads the line Claude Code prints, with only a weekly window (no 5h limit open)", () => {
    const line = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1793894400,
        rateLimitType: "seven_day",
        unifiedWindows: {
          seven_day: { utilization: 0.67, resetsAt: 1793894400, status: "allowed" },
        },
      },
    };
    expect(seatStateFromEvent(line, NOW)).toEqual({
      at: NOW,
      fiveHour: undefined,
      sevenDay: { utilization: 0.67, resetsAt: 1793894400_000, status: "allowed" },
    });
  });

  it("reads a rejected 5h window", () => {
    const line = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1793800000,
        unifiedWindows: {
          five_hour: { utilization: 1, resetsAt: 1793800000, status: "rejected" },
          seven_day: { utilization: 0.4, resetsAt: 1793894400, status: "allowed" },
        },
      },
    };
    const s = seatStateFromEvent(line, NOW);
    expect(s?.fiveHour).toEqual({ utilization: 1, resetsAt: 1793800000_000, status: "rejected" });
    expect(seatBlockedUntil(s, NOW)).toBe(1793800000_000);
  });

  it("falls back to the single window when unifiedWindows is missing", () => {
    const s = seatStateFromEvent(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1793800000 },
      },
      NOW,
    );
    expect(s).toEqual({ at: NOW, fiveHour: { status: "rejected", resetsAt: 1793800000_000 } });
  });

  it("ignores every other line", () => {
    expect(seatStateFromEvent({ type: "result" }, NOW)).toBeUndefined();
    expect(seatStateFromEvent(null, NOW)).toBeUndefined();
  });
});
