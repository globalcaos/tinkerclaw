/**
 * FORK 2026-06-11 — U5-result behavioral tests (bible §5.67b two-event contract).
 * Runs in the bundled-extensions vitest lane (extensions/**\/*.test.ts).
 */

import { describe, expect, it } from "vitest";
import {
  emitFractalEvent,
  FRACTAL_LIVENESS_CEILING_MS,
  FRACTAL_STREAM,
  makePendingRow,
  StubWatchdog,
  type FractalEventEnvelope,
  type WatchdogDeath,
} from "./fractal-result.js";

// Decouple the tests from U1's types.ts (drafted in the same parallel wave):
// everything goes through the function's own parameter type.
type AnyRow = Parameters<typeof emitFractalEvent>[2];

const noSchedule = { set: () => 0, clear: () => {} };

describe("fractal-result: two-event contract (§5.67b)", () => {
  it("makePendingRow mints a pending stub carrying the docking anchor", () => {
    const row = makePendingRow("run-main-1", "agent:main:main", () => 1111) as unknown as Record<
      string,
      unknown
    >;
    expect(row.parentRunId).toBe("run-main-1");
    expect(row.status).toBe("pending");
    expect(row.sessionKey).toBe("agent:main:main");
    expect(row.ts).toBe(1111);
  });

  it("emits pending then final through the single chokepoint — main-session envelope, row payload, replacement ordering", () => {
    const events: FractalEventEnvelope[] = [];
    const emit = (e: FractalEventEnvelope) => events.push(e);
    const warned: string[] = [];
    const api = { logger: { warn: (m: string) => warned.push(m), debug: () => {} } };

    const pending = makePendingRow("run-main-2", "agent:main:main", () => 5);
    emitFractalEvent(api, "agent:main:main", pending, emit);

    const final = {
      ...(pending as unknown as Record<string, unknown>),
      status: "clean",
      verdict: "no findings",
    } as unknown as AnyRow;
    emitFractalEvent(api, "agent:main:main", final, emit);

    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.stream).toBe(FRACTAL_STREAM);
      // Envelope under the MAIN session's sessionKey — UI consumers are sessionKey-gated.
      expect(e.sessionKey).toBe("agent:main:main");
      // Docking anchor rides both the envelope runId and the row payload.
      expect(e.runId).toBe("run-main-2");
      expect((e.data as { parentRunId?: string }).parentRunId).toBe("run-main-2");
    }
    // Pending stub first; the final event replaces it (same parentRunId — later event wins).
    expect(events[0]?.data.status).toBe("pending");
    expect(events[1]?.data.status).toBe("clean");
    expect(warned).toHaveLength(0);
  });

  it("drops a row without parentRunId loudly instead of emitting an undockable event", () => {
    const events: FractalEventEnvelope[] = [];
    const warned: string[] = [];
    const api = { logger: { warn: (m: string) => warned.push(m) } };
    emitFractalEvent(api, "agent:main:main", {} as AnyRow, (e) => events.push(e));
    expect(events).toHaveLength(0);
    expect(warned).toHaveLength(1);
  });
});

describe("fractal-result: StubWatchdog (verified deadness only)", () => {
  it("fires only after the silence ceiling — run events reset the clock; wall-clock since spawn never kills", () => {
    let now = 0;
    const ctx: { registeredAt?: number; lastActiveAt?: number } = { registeredAt: 0 };
    const deaths: WatchdogDeath[] = [];
    const wd = new StubWatchdog({ now: () => now, getRunState: () => ctx, schedule: noSchedule });
    wd.track("parent-1", "lane-1", (d) => deaths.push(d));

    now = FRACTAL_LIVENESS_CEILING_MS - 10_000; // 110s of silence — under the ceiling
    wd.poll();
    expect(deaths).toHaveLength(0);

    ctx.lastActiveAt = now; // the run emitted an event — the silence clock resets
    now += FRACTAL_LIVENESS_CEILING_MS - 10_000; // way past the ceiling SINCE SPAWN, under it since the last event
    wd.poll();
    expect(deaths).toHaveLength(0); // never wall-clock since spawn (#19)

    now = (ctx.lastActiveAt ?? 0) + FRACTAL_LIVENESS_CEILING_MS + 1; // total-silence ceiling crossed
    wd.poll();
    expect(deaths).toHaveLength(1);
    expect(deaths[0]?.reason).toBe("silence-ceiling");
    expect(deaths[0]?.parentRunId).toBe("parent-1");
    expect(deaths[0]?.runId).toBe("lane-1");
    expect(deaths[0]?.silenceMs).toBeGreaterThan(FRACTAL_LIVENESS_CEILING_MS);

    wd.poll(); // entry consumed — fires exactly once
    expect(deaths).toHaveLength(1);
    expect(wd.size).toBe(0);
  });

  it("cancel() on normal completion suppresses the watchdog", () => {
    let now = 0;
    const deaths: WatchdogDeath[] = [];
    const wd = new StubWatchdog({
      now: () => now,
      getRunState: () => ({ registeredAt: 0 }),
      schedule: noSchedule,
    });
    wd.track("parent-2", "lane-2", (d) => deaths.push(d));
    wd.cancel("parent-2");
    now = FRACTAL_LIVENESS_CEILING_MS * 10;
    wd.poll();
    expect(deaths).toHaveLength(0);
    expect(wd.size).toBe(0);
  });

  it("terminal-or-gone: a previously-seen context that disappears fires after one grace poll; cancel inside the grace suppresses", () => {
    let now = 0;
    let ctx: { registeredAt?: number } | undefined = { registeredAt: 0 };
    const deaths: WatchdogDeath[] = [];
    const wd = new StubWatchdog({ now: () => now, getRunState: () => ctx, schedule: noSchedule });
    wd.track("parent-3", "lane-3", (d) => deaths.push(d));

    now = 1000;
    wd.poll(); // context seen
    ctx = undefined; // registry cleared = the run reached terminal
    now = 2000;
    wd.poll(); // grace poll — no fire yet (normal completion races cancel by an instant)
    expect(deaths).toHaveLength(0);
    now = 3000;
    wd.poll(); // still gone → verified dead
    expect(deaths).toHaveLength(1);
    expect(deaths[0]?.reason).toBe("terminal-or-gone");

    // cancel inside the grace window suppresses the conversion
    let ctx2: { registeredAt?: number } | undefined = { registeredAt: 0 };
    const deaths2: WatchdogDeath[] = [];
    const wd2 = new StubWatchdog({ now: () => now, getRunState: () => ctx2, schedule: noSchedule });
    wd2.track("parent-4", "lane-4", (d) => deaths2.push(d));
    wd2.poll(); // seen
    ctx2 = undefined;
    wd2.poll(); // grace poll
    wd2.cancel("parent-4"); // the final event landed during the grace window
    wd2.poll();
    expect(deaths2).toHaveLength(0);
  });

  it("a run that never registers at all dies via the zero-events ceiling", () => {
    let now = 0;
    const deaths: WatchdogDeath[] = [];
    const wd = new StubWatchdog({
      now: () => now,
      getRunState: () => undefined,
      schedule: noSchedule,
    });
    wd.track("parent-5", "lane-5", (d) => deaths.push(d));
    now = FRACTAL_LIVENESS_CEILING_MS; // exactly at the ceiling — not yet over
    wd.poll();
    expect(deaths).toHaveLength(0);
    now = FRACTAL_LIVENESS_CEILING_MS + 1;
    wd.poll();
    expect(deaths).toHaveLength(1);
    expect(deaths[0]?.reason).toBe("silence-ceiling");
  });
});
