import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRpcObservabilityForTests,
  flushRpcRollup,
  formatRpcObservabilitySummary,
  formatRpcObservabilitySummaryIfChanged,
  noteRpcDispatch,
  noteRpcHandlerDuration,
  noteRpcRefusal,
  registerKnownRpcMethods,
  snapshotRpcObservability,
} from "./rpc-observability.js";

/**
 * CONTROL (logging.md §9 step 8): there are no `rpc.*` rows anywhere today, so an assertion made
 * against a real database would pass while nothing was emitted. The writer is replaced by a
 * recorder and the rows are pinned against the CATALOG's meanings (n1=calls, n2=total_ms,
 * n3=max_ms, n4=errors), not against whatever the code happens to produce.
 */
const { emitted } = vi.hoisted(() => ({
  emitted: [] as Array<{ name: string; record: Record<string, unknown> }>,
}));
vi.mock("../infra/events/emit.js", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.push({ name, record });
  },
}));

const rowsNamed = (name: string) => emitted.filter((row) => row.name === name);

describe("gateway rpc observability", () => {
  beforeEach(() => {
    // The clock is pinned mid-minute so no test can straddle a minute boundary and have the
    // rollup close underneath it; the tests that cross a boundary move the clock themselves.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T09:00:30.000Z"));
    __resetRpcObservabilityForTests();
    emitted.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a registered-but-never-called method, which is the whole point", () => {
    // The measure that matters is not the call count — it is the ABSENCE. A method that is
    // registered and never invoked is either dead code or a broken caller; nothing in the fork
    // could previously tell you either had happened.
    registerKnownRpcMethods(["sessions.get", "sessions.list", "agents.create"]);
    noteRpcDispatch("sessions.get");

    const s = snapshotRpcObservability();
    expect(s.methodsKnown).toBe(3);
    expect(s.methodsCalled).toBe(1);
    expect(s.neverCalled).toEqual(["agents.create", "sessions.list"]);
  });

  it("does NOT invent a capability from an unknown-method refusal", () => {
    // A client typo must not enter the denominator. If it did, the bogus name would be reported
    // as a never-called capability forever, and the report would slowly fill with noise that
    // looks exactly like the signal it exists to carry.
    noteRpcRefusal("sesions.get", "unknown-method");

    const s = snapshotRpcObservability();
    expect(s.methodsKnown).toBe(0);
    expect(s.neverCalled).toEqual([]);
    expect(s.totalRefused).toBe(1);
    expect(s.refusalsByReason["unknown-method"]).toBe(1);
  });

  it("keeps a refused known method in the denominator and out of the called set", () => {
    // Refused is not called. A method that only ever gets rejected on auth is still a capability
    // nobody is successfully exercising, and it must keep showing up as never-called.
    registerKnownRpcMethods(["fork.curiosity.topGaps"]);
    noteRpcRefusal("fork.curiosity.topGaps", "auth");

    const s = snapshotRpcObservability();
    expect(s.methodsCalled).toBe(0);
    expect(s.neverCalled).toEqual(["fork.curiosity.topGaps"]);
    expect(s.refusalsByReason.auth).toBe(1);
  });

  it("separates refusal reasons, because each has a different fix", () => {
    noteRpcRefusal("a.one", "auth");
    noteRpcRefusal("a.two", "rate-limit");
    noteRpcRefusal("a.three", "unavailable");
    noteRpcRefusal("a.one", "auth");

    const s = snapshotRpcObservability();
    expect(s.refusalsByReason).toEqual({ auth: 2, "rate-limit": 1, unavailable: 1 });
  });

  it("ranks the busiest methods and totals dispatches", () => {
    for (let i = 0; i < 5; i++) noteRpcDispatch("chat.send");
    noteRpcDispatch("sessions.get");

    const s = snapshotRpcObservability();
    expect(s.totalDispatched).toBe(6);
    expect(s.topMethods[0]).toEqual({ method: "chat.send", dispatched: 5 });
  });

  it("emits on a material change and stays quiet otherwise", () => {
    // Guards both halves of the bug this function was born from: logging every 60s produces 1,440
    // identical lines a day (unreadable), and logging never at all is what actually happened when
    // the first version called a `debug` method the logger does not have.
    registerKnownRpcMethods(["x.a", "x.b"]);
    expect(formatRpcObservabilitySummaryIfChanged()).toContain("never-called=2");
    // Nothing changed — a reprint would teach nothing.
    expect(formatRpcObservabilitySummaryIfChanged()).toBeNull();

    noteRpcDispatch("x.a");
    const line = formatRpcObservabilitySummaryIfChanged();
    expect(line).toContain("called=1");
    expect(line).toContain("never-called=1");
    expect(formatRpcObservabilitySummaryIfChanged()).toBeNull();

    // A repeat call to an ALREADY-called method moves only the raw dispatch total, which is
    // deliberately outside the signature — otherwise "changed" would just mean "time passed".
    noteRpcDispatch("x.a");
    expect(formatRpcObservabilitySummaryIfChanged()).toBeNull();

    // A refusal IS material.
    noteRpcRefusal("x.b", "auth");
    expect(formatRpcObservabilitySummaryIfChanged()).toContain("refused=1");
  });

  it("summarises in one line fit to sit beside the liveness report", () => {
    registerKnownRpcMethods(["x.a", "x.b"]);
    noteRpcDispatch("x.a");
    noteRpcRefusal("x.b", "auth");

    const line = formatRpcObservabilitySummary();
    expect(line).toContain("[gateway/rpc]");
    expect(line).toContain("methods=2");
    expect(line).toContain("called=1");
    expect(line).toContain("never-called=1");
    expect(line).toContain("auth=1");
  });

  it("rolls N calls of one method into ONE rpc.minute row, stamped at the minute START", () => {
    vi.setSystemTime(new Date("2026-09-25T10:00:07.000Z"));
    __resetRpcObservabilityForTests();
    emitted.length = 0;

    for (let i = 0; i < 4; i++) {
      noteRpcDispatch("chat.history");
      noteRpcHandlerDuration("chat.history", 10, false);
    }
    noteRpcDispatch("chat.history");
    noteRpcHandlerDuration("chat.history", 30, true);
    expect(rowsNamed("rpc.minute")).toHaveLength(0);

    // A call in the NEXT minute closes the window; nothing else has to run for it to land.
    vi.setSystemTime(new Date("2026-09-25T10:01:03.000Z"));
    noteRpcDispatch("chat.history");

    const rows = rowsNamed("rpc.minute");
    expect(rows).toHaveLength(1);
    expect(rows[0].record.label).toBe("chat.history");
    expect(rows[0].record.n1).toBe(5); // calls
    expect(rows[0].record.n2).toBe(70); // total_ms
    expect(rows[0].record.n3).toBe(30); // max_ms
    expect(rows[0].record.n4).toBe(1); // errors: the handler that REJECTED
    // The row covers exactly the minute it names — a window that merely started at the first call
    // would let an idle gap inflate the rate without anything in the row saying so.
    expect(rows[0].record.tsMs).toBe(Date.parse("2026-09-25T10:00:00.000Z"));
  });

  it("closes the window from the 60 s health-tick summary, so a quiet method still reports", () => {
    noteRpcDispatch("cron.list");
    noteRpcHandlerDuration("cron.list", 4, false);
    vi.setSystemTime(new Date("2026-09-25T09:01:10.000Z"));
    // No further call to ANY method: the health tick alone must close the minute.
    formatRpcObservabilitySummaryIfChanged();
    const rows = rowsNamed("rpc.minute");
    expect(rows).toHaveLength(1);
    expect(rows[0].record.label).toBe("cron.list");
    expect(rows[0].record.tsMs).toBe(Date.parse("2026-09-25T09:00:00.000Z"));
  });

  it("carries each method's own refusals in its own row", () => {
    noteRpcDispatch("config.patch");
    noteRpcHandlerDuration("config.patch", 5, false);
    noteRpcRefusal("config.patch", "rate-limit");
    noteRpcRefusal("config.patch", "rate-limit");
    noteRpcRefusal("sessions.get", "auth");

    flushRpcRollup();
    const byLabel = new Map(rowsNamed("rpc.minute").map((r) => [r.record.label, r.record]));
    const patch = byLabel.get("config.patch") as { fields: Record<string, unknown> };
    expect(patch.fields.refused).toBe(2);
    expect(patch.fields.refusal_reasons).toEqual({ "rate-limit": 2 });
    // A method refused without ever being called still gets a row: a refusal storm that emitted
    // nothing would be exactly the silence the `refused` field exists to break.
    const get = byLabel.get("sessions.get") as { n1: number; fields: Record<string, unknown> };
    expect(get.n1).toBe(0);
    expect(get.fields.refusal_reasons).toEqual({ auth: 1 });
  });

  it("fires rpc.slow above the 50 ms floor and not below it", () => {
    noteRpcDispatch("sessions.list");
    noteRpcHandlerDuration("sessions.list", 10, false);
    expect(rowsNamed("rpc.slow")).toHaveLength(0);

    noteRpcDispatch("sessions.list");
    noteRpcHandlerDuration("sessions.list", 80, false);
    const slow = rowsNamed("rpc.slow");
    expect(slow).toHaveLength(1);
    expect(slow[0].record.label).toBe("sessions.list");
    expect(slow[0].record.durMs).toBe(80);
  });

  it("derives the next window's bar from this window's p99, but only with enough samples", () => {
    // 20 calls at 200 ms: bucket [128, 256), so p99 is read as 128 and the bar becomes 256.
    for (let i = 0; i < 20; i++) {
      noteRpcDispatch("heavy.method");
      noteRpcHandlerDuration("heavy.method", 200, false);
    }
    flushRpcRollup();
    emitted.length = 0;

    noteRpcDispatch("heavy.method");
    noteRpcHandlerDuration("heavy.method", 200, false);
    expect(rowsNamed("rpc.slow")).toHaveLength(0); // normal FOR THIS METHOD
    noteRpcDispatch("heavy.method");
    noteRpcHandlerDuration("heavy.method", 400, false);
    expect(rowsNamed("rpc.slow")).toHaveLength(1);

    // A single outlier in a quiet window must NOT immunise the next one: below the sample floor
    // the "p99" is just that call, so the bar stays at the 50 ms floor.
    __resetRpcObservabilityForTests();
    emitted.length = 0;
    noteRpcDispatch("quiet.method");
    noteRpcHandlerDuration("quiet.method", 4000, false);
    flushRpcRollup();
    emitted.length = 0;
    noteRpcDispatch("quiet.method");
    noteRpcHandlerDuration("quiet.method", 60, false);
    expect(rowsNamed("rpc.slow")).toHaveLength(1);
  });

  it("bounds the counters: past the cap, client-minted names share ONE overflow bucket", () => {
    // An authenticated client can mint method names through the auth-refusal path (auth runs
    // before the handler lookup). Each name used to become its own counter forever; now each would
    // also earn a row every minute. 600 names must not become 600 rows, and the first name past
    // the cap must not recurse looking for an overflow bucket that does not exist yet.
    for (let i = 0; i < 600; i++) {
      noteRpcRefusal(`minted.${i}`, "auth");
    }
    flushRpcRollup();
    const rows = rowsNamed("rpc.minute");
    expect(rows.length).toBeLessThanOrEqual(513);
    const overflow = rows.find((r) => r.record.label === "(overflow)");
    expect(overflow).toBeDefined();
    expect((overflow?.record.fields as Record<string, unknown>).refused).toBe(600 - 512);
  });
});
