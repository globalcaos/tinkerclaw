import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRpcObservabilityForTests,
  formatRpcObservabilitySummary,
  formatRpcObservabilitySummaryIfChanged,
  noteRpcDispatch,
  noteRpcRefusal,
  registerKnownRpcMethods,
  snapshotRpcObservability,
} from "./rpc-observability.js";

describe("gateway rpc observability", () => {
  beforeEach(() => {
    __resetRpcObservabilityForTests();
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
});
