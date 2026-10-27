/**
 * J3 `j.fractal.run` for the background Fractal turn. CONTROL: before this change the name had 0
 * rows (09-25 → 10-09) while 49 `fractal-*` runs wrote `run.done` and `turn.span` rows: the only
 * emitter sat in the triage lane, off since 09-19.
 *
 * The tool events go through the real agent-events bus, the way the tinker-bridge (Claude Code
 * names, `file_path`) and the embedded runner (gateway names, `path`) send them; the row is written
 * by recordRunDone, beside `run.done`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../agent-events.js";
import { resetFractalRunTallyForTest, startFractalRunTally } from "./fractal-run-tally.js";
import { recordRunDone } from "./turn-events.js";

const emitEventMock = vi.hoisted(() => vi.fn());
vi.mock("./emit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./emit.js")>()),
  emitEvent: emitEventMock,
}));

const RUN = "fractal-2b6c0e1a-0000-4000-8000-000000000001";
const SESSION = "agent:main:fractal:2b6c0e1a";

function toolStart(runId: string, id: string, name: string, args: Record<string, unknown>): void {
  emitAgentEvent({ runId, stream: "tool", data: { phase: "start", name, toolCallId: id, args } });
}

function toolResult(runId: string, id: string, isError = false): void {
  emitAgentEvent({ runId, stream: "tool", data: { phase: "result", toolCallId: id, isError } });
}

function fractalRows(): Array<Record<string, unknown>> {
  return emitEventMock.mock.calls
    .filter((call) => call[0] === "j.fractal.run")
    .map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  emitEventMock.mockClear();
  resetAgentEventsForTest();
  resetFractalRunTallyForTest();
});

afterEach(() => {
  resetFractalRunTallyForTest();
  resetAgentEventsForTest();
});

describe("j.fractal.run: one row per fractal-* run, beside run.done", () => {
  it("durable: a successful write counts once per file; a failed write does not count", () => {
    startFractalRunTally();
    toolStart(RUN, "t1", "Write", { file_path: "/m/a.md", content: "x" });
    toolResult(RUN, "t1");
    toolStart(RUN, "t2", "Edit", { file_path: "/m/a.md" });
    toolResult(RUN, "t2");
    toolStart(RUN, "t3", "Bash", { command: "ls" });
    toolResult(RUN, "t3");
    toolStart(RUN, "t4", "Write", { file_path: "/m/b.md" });
    toolResult(RUN, "t4", true);

    recordRunDone({ runId: RUN, sessionKey: SESSION }, Date.now() - 1_000, "completed");

    expect(fractalRows()).toEqual([
      {
        runId: RUN,
        sessionKey: SESSION,
        label: "durable",
        durMs: expect.any(Number),
        n1: 1,
        n2: 4,
      },
    ]);
    // run.done itself is unchanged.
    expect(emitEventMock.mock.calls.map((call) => call[0])).toEqual(["run.done", "j.fractal.run"]);
  });

  it("clean: tools ran, nothing was written", () => {
    startFractalRunTally();
    toolStart(RUN, "t1", "Read", { file_path: "/m/a.md" });
    toolResult(RUN, "t1");
    toolStart(RUN, "t2", "Grep", { pattern: "x" });
    toolResult(RUN, "t2");

    recordRunDone({ runId: RUN, sessionKey: SESSION }, Date.now(), "completed");

    expect(fractalRows()).toMatchObject([{ label: "clean", n1: 0, n2: 2 }]);
  });

  it("gateway tool names count too: `write`/`edit` by path, `apply_patch` once per call", () => {
    startFractalRunTally();
    toolStart(RUN, "g1", "write", { path: "memory/x.md" });
    toolResult(RUN, "g1");
    toolStart(RUN, "g2", "apply_patch", { input: "*** Begin Patch" });
    toolResult(RUN, "g2");
    toolStart(RUN, "g3", "exec", { command: "true" });
    toolResult(RUN, "g3");

    recordRunDone({ runId: RUN }, Date.now(), "completed");

    expect(fractalRows()).toMatchObject([{ label: "durable", n1: 2, n2: 3 }]);
  });

  it("failed: an aborted or erroring run is failed whatever it wrote", () => {
    startFractalRunTally();
    toolStart(RUN, "t1", "Write", { file_path: "/m/a.md" });
    toolResult(RUN, "t1");

    recordRunDone({ runId: RUN }, Date.now(), "error", new Error("boom"));

    expect(fractalRows()).toMatchObject([{ label: "failed", n1: 1, n2: 1 }]);
  });

  it("each run keeps its own tally, and a run's tally is spent by its row", () => {
    startFractalRunTally();
    const other = "fractal-2b6c0e1a-0000-4000-8000-000000000002";
    toolStart(RUN, "t1", "Read", {});
    toolStart(other, "u1", "Write", { file_path: "/m/c.md" });
    toolResult(other, "u1");

    recordRunDone({ runId: RUN }, Date.now(), "completed");
    recordRunDone({ runId: other }, Date.now(), "completed");
    recordRunDone({ runId: RUN }, Date.now(), "completed");

    expect(fractalRows()).toMatchObject([
      { runId: RUN, label: "clean", n1: 0, n2: 1 },
      { runId: other, label: "durable", n1: 1, n2: 1 },
      { runId: RUN, label: "clean", n1: 0, n2: 0 },
    ]);
  });

  it("no row for a run that is not a Fractal run, and none while the tally is not listening", () => {
    startFractalRunTally();
    toolStart("run-plain", "t1", "Write", { file_path: "/m/a.md" });
    recordRunDone({ runId: "run-plain" }, Date.now(), "completed");
    resetFractalRunTallyForTest();
    recordRunDone({ runId: RUN }, Date.now(), "completed");

    expect(fractalRows()).toEqual([]);
  });

  it("starting twice registers one listener, so a tool is counted once", () => {
    startFractalRunTally();
    startFractalRunTally();
    toolStart(RUN, "t1", "Read", {});

    recordRunDone({ runId: RUN }, Date.now(), "completed");

    expect(fractalRows()).toMatchObject([{ n2: 1 }]);
  });
});
