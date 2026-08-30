import { describe, expect, it } from "vitest";
import {
  dropBackgroundRunsForSession,
  noteBackgroundRunEvent,
  touchBackgroundRuns,
  type BackgroundRun,
} from "./background-runs.js";
import {
  clientRunIsFresh,
  liveRunCountsByModel,
  resolveSessionRunState,
  RUN_STALE_MS,
} from "./run-state.js";

const NOW = 1_786_913_000_000;
const VIEWED = "agent:main:tinker:msok52zc";
const BACKGROUND = "agent:main:tinker:msricppx"; // the real NeuroCoin key, 2026-08-16

// The real predicate from app.ts, inlined so these tests exercise the same matching semantics as
// run-state.test.ts does.
const matches = (runKey: string, refKey: string): boolean =>
  runKey === refKey || runKey.endsWith(":" + refKey) || refKey.endsWith(":" + runKey);

const providerOf = (model: string): string => (model.startsWith("claude") ? "claude-code" : "");

const start = (over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  sessionKey: BACKGROUND,
  phase: "start",
  model: "claude-opus-5",
  ...over,
});

const empty = () => new Map<string, BackgroundRun>();

describe("noteBackgroundRunEvent", () => {
  it("records a run for a session this tab is not viewing", () => {
    const runs = empty();
    expect(noteBackgroundRunEvent(runs, start(), NOW, providerOf)).toBe(true);
    expect(runs.get("run-1")).toEqual({
      sessionKey: BACKGROUND,
      model: "claude-opus-5",
      provider: "claude-code",
      startedAt: NOW,
      lastEventAt: NOW,
    });
  });

  it("prefers the event's own provider over one inferred from the model id", () => {
    const runs = empty();
    noteBackgroundRunEvent(runs, start({ modelProvider: "openrouter" }), NOW, providerOf);
    expect(runs.get("run-1")?.provider).toBe("openrouter");
  });

  it("removes the run on end and on error", () => {
    for (const phase of ["end", "error"]) {
      const runs = empty();
      noteBackgroundRunEvent(runs, start(), NOW, providerOf);
      expect(noteBackgroundRunEvent(runs, start({ phase }), NOW + 1_000, providerOf)).toBe(true);
      expect(runs.size).toBe(0);
    }
  });

  it("refreshes an existing run instead of restarting its clock", () => {
    const runs = empty();
    noteBackgroundRunEvent(runs, start(), NOW, providerOf);
    // A mid-turn phase that happens to name a model must not look like a NEW run, or the elapsed
    // time every surface derives from startedAt would reset on every tool call.
    noteBackgroundRunEvent(runs, start({ phase: "round-start" }), NOW + 30_000, providerOf);
    expect(runs.size).toBe(1);
    expect(runs.get("run-1")?.startedAt).toBe(NOW);
    expect(runs.get("run-1")?.lastEventAt).toBe(NOW + 30_000);
  });

  it("ignores an event it cannot key or attribute", () => {
    const runs = empty();
    expect(noteBackgroundRunEvent(runs, start({ runId: undefined }), NOW, providerOf)).toBe(false);
    expect(noteBackgroundRunEvent(runs, start({ sessionKey: "" }), NOW, providerOf)).toBe(false);
    expect(runs.size).toBe(0);
  });

  it("keeps concurrent runs in different sessions apart", () => {
    const runs = empty();
    noteBackgroundRunEvent(runs, start(), NOW, providerOf);
    noteBackgroundRunEvent(runs, start({ runId: "run-2", sessionKey: VIEWED }), NOW, providerOf);
    expect(runs.size).toBe(2);
    dropBackgroundRunsForSession(runs, BACKGROUND, matches);
    expect([...runs.keys()]).toEqual(["run-2"]);
  });
});

describe("touchBackgroundRuns", () => {
  it("keeps a long background turn alive past the freshness bound", () => {
    const runs = empty();
    noteBackgroundRunEvent(runs, start(), NOW, providerOf);
    const late = NOW + RUN_STALE_MS + 60_000;
    // Without the bump the run is stale and its tab would go dark mid-turn.
    expect(clientRunIsFresh(runs.get("run-1")!, late)).toBe(false);
    touchBackgroundRuns(runs, BACKGROUND, late, matches);
    expect(clientRunIsFresh(runs.get("run-1")!, late)).toBe(true);
  });

  it("matches the short tab key against the canonical store key", () => {
    const runs = empty();
    noteBackgroundRunEvent(runs, start(), NOW, providerOf);
    touchBackgroundRuns(runs, "tinker:msricppx", NOW + 5_000, matches);
    expect(runs.get("run-1")?.lastEventAt).toBe(NOW + 5_000);
  });

  it("leaves other sessions' runs untouched", () => {
    const runs = empty();
    noteBackgroundRunEvent(runs, start(), NOW, providerOf);
    touchBackgroundRuns(runs, VIEWED, NOW + 5_000, matches);
    expect(runs.get("run-1")?.lastEventAt).toBe(NOW);
  });
});

// The point of the whole module: what the ONE resolver answers once these entries reach it.
describe("the out-of-focus tab, end to end through run-state", () => {
  // The exact state the architect hit: the gateway knows the run is live, but the UI's snapshot was taken
  // at the END of the previous turn, so `row.run.live` is false and no viewed-gated client entry
  // exists. Before this module the resolver returned run-set-idle and the tab stayed dark.
  const staleIdleRow = { key: BACKGROUND, run: { live: false, count: 0 } };
  const rowsFetchedAt = NOW - 120_000; // last loadSessions(): the previous turn's end

  it("was dark with no client evidence at all", () => {
    expect(
      resolveSessionRunState({
        sessionKey: BACKGROUND,
        row: staleIdleRow,
        runs: [],
        matches,
        now: NOW,
        rowsFetchedAt,
      }).live,
    ).toBe(false);
  });

  it("lights up once the background run is recorded", () => {
    const runs = empty();
    noteBackgroundRunEvent(runs, start(), NOW - 10_000, providerOf);
    const state = resolveSessionRunState({
      sessionKey: BACKGROUND,
      row: staleIdleRow,
      runs: runs.values(),
      matches,
      now: NOW,
      rowsFetchedAt,
    });
    expect(state.live).toBe(true);
    // Named, not a bare "working" — the indicator must identify the model (the architect, 2026-08-06).
    expect(state.model).toBe("claude-opus-5");
    expect(state.provider).toBe("claude-code");
  });

  it("goes dark again the moment the run ends, without waiting for the freshness bound", () => {
    const runs = empty();
    noteBackgroundRunEvent(runs, start(), NOW - 10_000, providerOf);
    noteBackgroundRunEvent(runs, start({ phase: "end" }), NOW, providerOf);
    expect(
      resolveSessionRunState({
        sessionKey: BACKGROUND,
        row: staleIdleRow,
        runs: runs.values(),
        matches,
        now: NOW,
        rowsFetchedAt,
      }).live,
    ).toBe(false);
  });

  it("does not resurrect a run the user has just stopped", () => {
    // Stop is newer evidence than anything this module holds. The abort path clears the entry and
    // refetches; if a straggling event were to re-add one, the end-stamp veto must still win.
    const runs = empty();
    noteBackgroundRunEvent(runs, start(), NOW - 10_000, providerOf);
    dropBackgroundRunsForSession(runs, BACKGROUND, matches);
    expect(
      resolveSessionRunState({
        sessionKey: BACKGROUND,
        row: staleIdleRow,
        runs: runs.values(),
        matches,
        now: NOW,
        rowsFetchedAt,
        endedAt: NOW - 1_000,
      }).live,
    ).toBe(false);
  });

  // FORK 2026-08-16 — why clientRunEvidence() returns an ARRAY and not `map.values()`.
  // `liveRunCountsByModel` walks `runs` once PER ROW and then once more at the end. A Map iterator
  // is single-use, so the first row consumed it and every later row saw an EMPTY client lane. With
  // ~900 rows in the live store that made the client lane effectively dead for the models count —
  // a silent degradation that compounded the stale-snapshot blindness this module fixes, because
  // the client lane is exactly what is supposed to cover a stale row.
  it("survives being read once per row (an iterator would not)", () => {
    const runs = empty();
    noteBackgroundRunEvent(runs, start(), NOW, providerOf);
    const rows = [
      { key: "agent:main:other", run: { live: false, count: 0 } },
      { key: BACKGROUND, run: { live: false, count: 0 } },
    ];
    const args = {
      rows,
      matches,
      now: NOW,
      rowsFetchedAt: NOW - 120_000,
    };
    // The background session is the SECOND row, so it only counts if the run set was re-readable.
    const fromArray = liveRunCountsByModel({ ...args, runs: [...runs.values()] });
    expect(fromArray.get("claude-code/claude-opus-5")).toBe(1);
    // Same inputs, single-use iterator: the row is reached after the lane has been drained.
    const fromIterator = liveRunCountsByModel({ ...args, runs: runs.values() });
    expect(fromIterator.get("claude-code/claude-opus-5")).toBeUndefined();
  });

  it("still defers to the server when the run set says live", () => {
    // The server lane keeps its authority: nothing here weakens it, so a turn started before this
    // browser connected (cron, WhatsApp, an orchestrator leg) still lights from the row alone.
    expect(
      resolveSessionRunState({
        sessionKey: BACKGROUND,
        row: { key: BACKGROUND, run: { live: true, count: 1 } },
        runs: [],
        matches,
        now: NOW,
        rowsFetchedAt: NOW - 1_000,
      }).live,
    ).toBe(true);
  });
});
