import { beforeEach, describe, expect, it } from "vitest";
import {
  declareInstrument,
  DEFAULT_ENUMERATE_INTERVAL_MS,
  DEFAULT_EXPECT_FIRE_WITHIN_MS,
  logInstrumentLivenessSummary,
  noteInstrumentFired,
  reportInstrumentLiveness,
  resetInstrumentLivenessForTest,
} from "./instrument-liveness.js";

// FORK 2026-07-28 — the invariant these tests exist to protect:
// A DECLARED INSTRUMENT THAT HAS NEVER FIRED IS A DEFECT, NOT A QUIET SUCCESS.
//
// Six components on this deployment were installed, enabled and registered while doing
// nothing (a compression proxy at 6 requests lifetime, a cache producer bound to an
// unconfigured backend, a compaction safeguard dead under the live mode, an orphaned EEG
// hook, an inert ORCA lease hook, an inert amygdala injection). Every one passed a
// registration check. The tests below encode the distinction those checks lacked.
describe("instrument liveness registry", () => {
  beforeEach(() => {
    resetInstrumentLivenessForTest();
  });

  // FORK 2026-07-29 — the registry MUST live on globalThis, not in a module-level const.
  //
  // Measured on the liveness deploy: `tinkerclaw-learned-intuition` is bundled SELF-CONTAINED
  // (dist/extensions/<id>/index.js inlines everything it imports from src/infra/), so its
  // module-scope declareInstrument ran against its OWN Map and `amygdala:nudge-write` never
  // appeared in the gateway's report. Invisible is worse than silent: `neverFired` is a defect
  // the report NAMES, whereas an instrument in a second Map produces no row at all — the report
  // then reads as complete while a component goes unobserved. That is this module's own failure
  // mode turned on itself.
  //
  // These two tests pin the fix by writing through the globalThis slot DIRECTLY, which is what a
  // separately-bundled copy of this module effectively does.
  it("shares its registry through globalThis so a separately-bundled copy converges", () => {
    declareInstrument({ id: "from-core", kind: "producer", description: "declared by core" });

    const slot = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.instrumentLiveness.registry")
    ] as Map<string, { id: string; fireCount: number }> | undefined;

    expect(slot, "registry must be reachable on globalThis, not module-private").toBeInstanceOf(
      Map,
    );
    expect(slot?.has("from-core")).toBe(true);
  });

  it("reports an instrument declared by another bundle's copy of this module", () => {
    // Stand-in for extensions/<id>/index.js, whose inlined copy owns a different module scope
    // but the same globalThis.
    const slot = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.instrumentLiveness.registry")
    ] as Map<string, unknown>;
    slot.set("amygdala:nudge-write", {
      id: "amygdala:nudge-write",
      kind: "extension",
      description: "declared from a separately-bundled extension",
      declaredAtMs: Date.now(),
      fireCount: 0,
    });

    const row = reportInstrumentLiveness().find((r) => r.id === "amygdala:nudge-write");
    expect(row, "an extension-declared instrument must appear in the core report").toBeDefined();
    expect(row?.neverFired).toBe(true);
  });

  it("reports a declared-but-never-fired instrument as neverFired", () => {
    declareInstrument({ id: "a", kind: "producer", description: "never runs" });

    const [row] = reportInstrumentLiveness();
    expect(row.id).toBe("a");
    expect(row.fireCount).toBe(0);
    expect(row.neverFired).toBe(true);
  });

  it("does NOT treat declaration as evidence of liveness", () => {
    // The entire bug class in one assertion: registering must not mark anything as working.
    declareInstrument({ id: "registered-only", kind: "extension", description: "registered" });
    declareInstrument({ id: "actually-runs", kind: "producer", description: "runs" });
    noteInstrumentFired("actually-runs");

    const rows = reportInstrumentLiveness();
    const registered = rows.find((r) => r.id === "registered-only");
    const running = rows.find((r) => r.id === "actually-runs");

    expect(registered?.neverFired).toBe(true);
    expect(running?.neverFired).toBe(false);
    expect(running?.fireCount).toBe(1);
  });

  it("marks an instrument overdue once silence exceeds its own tolerance", () => {
    const t0 = 1_000_000;
    declareInstrument({
      id: "rare",
      kind: "gate",
      description: "fires rarely",
      expectFireWithinMs: 60_000,
    });
    noteInstrumentFired("rare");

    const soon = reportInstrumentLiveness(Date.now() + 10_000).find((r) => r.id === "rare");
    expect(soon?.overdue).toBe(false);

    const later = reportInstrumentLiveness(Date.now() + 120_000).find((r) => r.id === "rare");
    expect(later?.overdue).toBe(true);
    void t0;
  });

  it("separates silent-by-configuration from broken", () => {
    // The CLI cache producer is silent because no cliBackend is configured — a config
    // consequence, not a defect. It must still be TRACKED, because for months its own comment
    // claimed it served the main pipe while never firing once.
    declareInstrument({
      id: "cache-telemetry:cli-pipe",
      kind: "producer",
      description: "cli pipe",
      conditional: "no cliBackends configured",
    });
    declareInstrument({ id: "broken", kind: "producer", description: "should have fired" });

    const rows = reportInstrumentLiveness();
    const cli = rows.find((r) => r.id === "cache-telemetry:cli-pipe");
    const broken = rows.find((r) => r.id === "broken");

    expect(cli?.neverFired).toBe(true);
    expect(cli?.conditional).toBe("no cliBackends configured");
    expect(broken?.neverFired).toBe(true);
    expect(broken?.conditional).toBeUndefined();
  });

  it("keeps counters across re-declaration, so a reload cannot hide a dead instrument", () => {
    declareInstrument({ id: "b", kind: "hook", description: "v1" });
    noteInstrumentFired("b");
    declareInstrument({ id: "b", kind: "hook", description: "v2 after reload" });

    const row = reportInstrumentLiveness().find((r) => r.id === "b");
    expect(row?.fireCount).toBe(1);
    expect(row?.description).toBe("v2 after reload");
  });

  it("surfaces a fire-without-declaration rather than dropping it", () => {
    noteInstrumentFired("undeclared", "detail");
    const row = reportInstrumentLiveness().find((r) => r.id === "undeclared");
    expect(row?.fireCount).toBe(1);
    expect(row?.description).toContain("without declaration");
  });

  it("sorts never-fired instruments first — the report leads with the defects", () => {
    declareInstrument({ id: "healthy", kind: "producer", description: "ok" });
    noteInstrumentFired("healthy");
    declareInstrument({ id: "dead", kind: "producer", description: "dead" });

    expect(reportInstrumentLiveness()[0].id).toBe("dead");
  });

  it("never throws, whatever it is handed", () => {
    expect(() => noteInstrumentFired("nope")).not.toThrow();
    expect(() => declareInstrument({ id: "", kind: "gate", description: "" })).not.toThrow();
    expect(() => reportInstrumentLiveness()).not.toThrow();
    expect(DEFAULT_EXPECT_FIRE_WITHIN_MS).toBeGreaterThan(0);
    expect(DEFAULT_ENUMERATE_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });
});

// FORK 2026-08-03 — the SECOND defect in this module: the alarm worked and nobody could read it.
// `journalctl -u openclaw-gateway --since '7 days ago' | grep instrument-liveness` returned 86,386
// lines, because the maintenance tick re-printed every declared-but-silent instrument once a minute
// AND called a merely-quiet one a DEFECT. The real line was
// `prefrontal:effort-route — ...; silent for 6492s. Declared-but-silent is a DEFECT`, emitted while
// the gateway had simply had no traffic for 108 minutes; the six instruments that have GENUINELY
// never fired were indistinguishable from that wallpaper.
//
// These tests assert on the emitted TEXT (`outcome.lines`) rather than on a logger mock, because
// the defect was a WORDING defect: the rows were already right and the sentences were already
// wrong. `logInstrumentLivenessSummary` returns exactly what it handed the logger.
describe("instrument liveness — signal to noise", () => {
  beforeEach(() => {
    resetInstrumentLivenessForTest();
  });

  /** Stand-in for wall-clock travel: rewrite a stamp the way an earlier real firing would have. */
  function backdateLastFire(id: string, atMs: number): void {
    const slot = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.instrumentLiveness.registry")
    ] as Map<string, { lastFiredAtMs?: number }>;
    const rec = slot.get(id);
    if (rec) {
      rec.lastFiredAtMs = atMs;
    }
  }

  it("reports a never-fired instrument past its own tolerance, escalating the wording with age", () => {
    const t0 = Date.now();
    declareInstrument({
      id: "engram:retrieval-pack-inject",
      kind: "hook",
      description: "inject the retrieval pack",
      expectFireWithinMs: 60_000,
    });

    const out = logInstrumentLivenessSummary(t0 + 10 * 60_000);

    expect(out.defects).toEqual(["engram:retrieval-pack-inject"]);
    expect(out.enumerated).toBe(true);
    expect(out.lines.join("\n")).toContain("has NEVER fired");
    // Ten times its own declared tolerance: "verify it" is no longer the honest sentence.
    expect(out.lines.join("\n")).toContain("DEAD CODE");
  });

  it("does not accuse a just-declared instrument inside its own tolerance (the boot window)", () => {
    // Every instrument is never-fired one second after the gateway starts. Warning about all of
    // them on the first tick is precisely how an alarm teaches people to skip it.
    declareInstrument({
      id: "booting",
      kind: "hook",
      description: "declared a moment ago",
      expectFireWithinMs: 60 * 60_000,
    });

    const out = logInstrumentLivenessSummary();

    expect(out.counts.pending).toBe(1);
    expect(out.defects).toEqual([]);
    expect(out.enumerated).toBe(false);
    expect(out.lines.join("\n")).not.toContain("DEFECT");
  });

  it("does NOT call a fired-then-quiet instrument a defect while the process itself is idle", () => {
    const t0 = Date.now();
    declareInstrument({
      id: "prefrontal:effort-route",
      kind: "hook",
      description: "route by effort",
      expectFireWithinMs: 60_000,
    });
    noteInstrumentFired("prefrontal:effort-route");

    // 6_492_000 ms — the exact silence from the journal line that motivated this change.
    const later = t0 + 6_492_000;
    const row = reportInstrumentLiveness(later).find((r) => r.id === "prefrontal:effort-route");
    expect(row?.overdue).toBe(true); // the raw timing fact is unchanged...
    expect(row?.state).toBe("idle"); // ...but it is no longer a verdict.

    logInstrumentLivenessSummary(t0); // establishes the activity watermark
    const out = logInstrumentLivenessSummary(later);

    expect(out.processIdle).toBe(true);
    expect(out.defects).toEqual([]);
    expect(out.suspects).toEqual([]);
    expect(out.idle).toEqual(["prefrontal:effort-route"]);
    expect(out.lines.join("\n")).not.toContain("DEFECT");
    expect(out.lines.join("\n")).toContain("process is IDLE");
  });

  it("DOES report a quiet instrument when several peers kept firing well past its tolerance", () => {
    const t0 = Date.now();
    declareInstrument({
      id: "router:model-fallback",
      kind: "gate",
      description: "fallback gate",
      expectFireWithinMs: 60_000,
    });
    for (const id of ["peer-a", "peer-b", "peer-c"]) {
      declareInstrument({ id, kind: "producer", description: `peer ${id}` });
    }
    noteInstrumentFired("router:model-fallback");
    backdateLastFire("router:model-fallback", t0 - 3 * 60 * 60_000);
    for (const id of ["peer-a", "peer-b", "peer-c"]) {
      noteInstrumentFired(id);
    }

    logInstrumentLivenessSummary(t0 - 60_000); // activity watermark
    noteInstrumentFired("peer-a"); // the process is demonstrably still working
    const out = logInstrumentLivenessSummary(t0, { enumerateIntervalMs: 0 });

    expect(out.processIdle).toBe(false);
    expect(out.suspects).toEqual(["router:model-fallback"]);
    expect(out.defects).toEqual([]);
    // Suspect is a weaker claim than defect and must not borrow its sentence.
    expect(out.lines.join("\n")).toContain("SUSPECT, not proven");
    expect(out.lines.join("\n")).not.toContain("NEVER fired");
  });

  it("does not re-enumerate an unchanged set, and re-asserts it once the interval elapses", () => {
    const t0 = Date.now();
    declareInstrument({
      id: "compaction:engram-executor",
      kind: "extension",
      description: "engram executor",
      expectFireWithinMs: 1_000,
    });

    const first = logInstrumentLivenessSummary(t0 + 60_000);
    expect(first.enumerated).toBe(true);
    expect(first.lines.some((l) => l.includes("compaction:engram-executor"))).toBe(true);

    const second = logInstrumentLivenessSummary(t0 + 120_000);
    expect(second.enumerated).toBe(false);
    expect(second.lines.some((l) => l.includes("compaction:engram-executor"))).toBe(false);
    // Suppressed, NOT forgotten — the counts still carry it on every tick.
    expect(second.counts.never).toBe(1);

    const hourly = logInstrumentLivenessSummary(t0 + 60_000 + DEFAULT_ENUMERATE_INTERVAL_MS);
    expect(hourly.enumerated).toBe(true);
    expect(hourly.lines.some((l) => l.includes("compaction:engram-executor"))).toBe(true);
  });

  it("collapses the volume: ticks of an unchanged fleet cost one line each, not one list each", () => {
    const t0 = Date.now();
    for (const id of [
      "engram:embedding-cache",
      "router:model-fallback",
      "amygdala:nudge-injection",
    ]) {
      declareInstrument({ id, kind: "producer", description: id, expectFireWithinMs: 1_000 });
    }

    const first = logInstrumentLivenessSummary(t0 + 60_000);
    expect(first.enumerated).toBe(true);
    expect(first.lines).toHaveLength(4); // head + one line per dead instrument

    const ticks = 50;
    let emitted = 0;
    for (let tick = 1; tick <= ticks; tick++) {
      const out = logInstrumentLivenessSummary(t0 + 60_000 + tick * 60_000);
      expect(out.enumerated).toBe(false);
      emitted += out.lines.length;
    }
    // One summary line per tick. The shipped version emitted four per tick, forever.
    expect(emitted).toBe(ticks);
  });

  it("keeps a configuration-explained silence out of the defect list and prints its reason", () => {
    const t0 = Date.now();
    declareInstrument({
      id: "cache-telemetry:cli-pipe",
      kind: "producer",
      description: "cli pipe",
      conditional: "no cliBackends are configured, so this producer cannot fire",
      expectFireWithinMs: 1_000,
    });
    declareInstrument({
      id: "compaction-gate:tool-loop-guard",
      kind: "gate",
      description: "tool-loop guard",
      expectFireWithinMs: 1_000,
    });

    const out = logInstrumentLivenessSummary(t0 + 60_000);

    expect(out.defects).toEqual(["compaction-gate:tool-loop-guard"]);
    expect(out.byConfig).toEqual(["cache-telemetry:cli-pipe"]);
    expect(out.counts.never).toBe(1);

    // The reason is printed, and it is printed OUTSIDE every accusing line.
    const accusations = out.lines.filter(
      (l) => l.includes("DEFECT") || l.includes("DEAD CODE") || l.includes("SUSPECT"),
    );
    expect(accusations.join("\n")).not.toContain("cache-telemetry:cli-pipe");
    expect(out.lines.join("\n")).toContain("silent BY CONFIGURATION");
    expect(out.lines.join("\n")).toContain("no cliBackends are configured");
  });

  it("says so when a previously-reported instrument comes back to life", () => {
    const t0 = Date.now();
    declareInstrument({
      id: "amygdala:nudge-injection",
      kind: "extension",
      description: "per-prompt nudge",
      expectFireWithinMs: 1_000,
    });

    expect(logInstrumentLivenessSummary(t0 + 60_000).defects).toEqual(["amygdala:nudge-injection"]);

    noteInstrumentFired("amygdala:nudge-injection");
    const out = logInstrumentLivenessSummary(Date.now());

    expect(out.defects).toEqual([]);
    // An alarm that never says it cleared is indistinguishable from one that was muted.
    expect(out.lines.join("\n")).toContain("accounted for again");
  });
});
