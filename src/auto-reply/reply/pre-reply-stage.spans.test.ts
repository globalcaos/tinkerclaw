import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../agents/embedded-agent-runner/logger.js";
import { markSpan, TURN_STAGE_STREAM } from "../../agents/embedded-agent-runner/run/turn-span.js";
import {
  emitAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../../infra/agent-events.js";
import { EVENT_CATALOG } from "../../infra/events/catalog.js";
import {
  clearPreReplyStage,
  notePreReplyAck,
  notePreReplyPlaced,
  notePreReplyStage,
  preReplyStageFor,
  resetPreReplyStagesForTest,
} from "./pre-reply-stage.js";

/**
 * turn-latency.md §9 (2026-10-29): the steps between chat.send's ack and the run's first runner span, written as
 * `pre:*` turn.span rows. The events writer is replaced by a recorder and only the Date clock is faked, so every
 * duration below is exact. CONTROL: before this change the window wrote no row, so every `pre:*` row is new.
 */
const { emitted, writer } = vi.hoisted(() => ({
  emitted: [] as Array<{ name: string; record: Record<string, unknown> }>,
  writer: { down: false },
}));
vi.mock("../../infra/events/emit.js", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    if (writer.down) {
      throw new Error("events writer down");
    }
    emitted.push({ name, record });
  },
}));

const SESSION = "agent:main:tinker:fixture";
const RUN = "prompt-key-fixture-1";
const T0 = Date.parse("2026-10-29T09:00:00.000Z");

let lines: string[] = [];

/** Moves the faked clock to T0 + ms and returns that instant. */
function at(ms: number): number {
  vi.setSystemTime(T0 + ms);
  return T0 + ms;
}

/** What get-reply.ts's stage() does when a prompt enters a step. */
function step(name: string, ms: number, runId: string | undefined): void {
  notePreReplyStage(SESSION, name, at(ms), runId);
}

/** The pre-reply rows as [label, durMs], without the runner's own rows (sandbox, ...). */
function preRows(): Array<[unknown, unknown]> {
  return emitted
    .filter((row) => String(row.record.label).startsWith("pre:"))
    .map((row) => [row.record.label, row.record.durMs]);
}

function spanLines(): string[] {
  return lines.filter((line) => line.startsWith("[turn-span] ") && line.includes(" stage=pre:"));
}

function dropLines(): string[] {
  return lines.filter((line) => line.startsWith("[pre-reply-span] DROPPED "));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  resetPreReplyStagesForTest();
  emitted.length = 0;
  writer.down = false;
  lines = [];
  vi.spyOn(log, "info").mockImplementation((message: string) => {
    lines.push(message);
  });
});

afterEach(() => {
  resetPreReplyStagesForTest();
  resetAgentRunContextForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pre-reply spans (turn-latency.md §9)", () => {
  it("writes one span per step: the ack to the first step, each to the next, the last at the reply operation", () => {
    at(1_000);
    notePreReplyAck(RUN, SESSION);
    step("config", 1_250, RUN);
    step("workspace", 1_400, RUN);
    step("session-init", 4_400, RUN);
    step("prepare-run", 4_500, RUN);
    expect(preRows()).toEqual([
      ["pre:ack", 250],
      ["pre:config", 150],
      ["pre:workspace", 3_000],
      ["pre:session-init", 100],
    ]);

    at(6_000);
    notePreReplyPlaced(RUN);

    expect(preRows().at(-1)).toEqual(["pre:prepare-run", 1_500]);
    for (const row of emitted) {
      expect(row.name).toBe("turn.span");
      expect(row.record).toMatchObject({ runId: RUN, sessionKey: SESSION });
    }
    // The runner's own line shape, one line per row.
    expect(spanLines()).toEqual([
      `[turn-span] runId=${RUN} stage=pre:ack ms=250`,
      `[turn-span] runId=${RUN} stage=pre:config ms=150`,
      `[turn-span] runId=${RUN} stage=pre:workspace ms=3000`,
      `[turn-span] runId=${RUN} stage=pre:session-init ms=100`,
      `[turn-span] runId=${RUN} stage=pre:prepare-run ms=1500`,
    ]);
    // The stuck-session line reads the step until the reply ends, as before.
    expect(preReplyStageFor(SESSION, at(8_500))).toBe("pre:prepare-run:4s");
  });

  it("times the placement to where the run's first runner span began, and writes it once", () => {
    step("config", 1_000, RUN);
    step("prepare-run", 1_200, RUN);
    at(2_000);
    notePreReplyPlaced(RUN);
    // The run registers its context (agent-runner-execution.ts), then the runner's spans begin.
    registerAgentRunContext(RUN, { sessionKey: SESSION });
    registerAgentRunContext("another-run", { sessionKey: SESSION });

    // Another run's span, and this run's gap before a span, close nothing.
    at(2_400);
    markSpan("another-run", "sandbox", 1);
    emitAgentEvent({
      runId: RUN,
      stream: TURN_STAGE_STREAM,
      data: { stage: "before:sandbox", ms: 300 },
    });
    expect(preRows().map(([label]) => label)).not.toContain("pre:placement");

    at(5_001);
    markSpan(RUN, "sandbox", 1); // the first runner span: it ended at 5_001, so it began at 5_000
    at(5_200);
    markSpan(RUN, "skills-load", 3);
    at(9_000);
    notePreReplyPlaced(RUN);
    clearPreReplyStage(SESSION, RUN);

    expect(preRows()).toEqual([
      ["pre:config", 200],
      ["pre:prepare-run", 800],
      ["pre:placement", 3_000],
    ]);
    expect(dropLines()).toEqual([]);
  });

  it("closes nothing at the reply's end: an unclosed step or placement logs one DROPPED line", () => {
    // Steered, or answered by a command: the reply ends inside a step, with no reply operation.
    step("config", 1_000, "steered-prompt");
    step("prepare-run", 1_100, "steered-prompt");
    at(1_400);
    clearPreReplyStage(SESSION, "steered-prompt");
    // Placed, but its run emits no runner span before the reply ends (a CLI-backend run).
    step("prepare-run", 2_000, RUN);
    at(2_500);
    notePreReplyPlaced(RUN);
    at(60_000);
    clearPreReplyStage(SESSION, RUN);

    expect(preRows()).toEqual([
      ["pre:config", 100],
      ["pre:prepare-run", 500],
    ]);
    expect(dropLines()).toEqual([
      "[pre-reply-span] DROPPED runId=steered-prompt stage=pre:prepare-run reason=no-reply-operation",
      `[pre-reply-span] DROPPED runId=${RUN} stage=pre:placement reason=no-runner-span`,
    ]);
  });

  it("writes nothing for a prompt with no run id, and the stuck-session line still names its step", () => {
    step("config", 1_000, undefined);
    step("directives", 1_300, undefined);
    notePreReplyPlaced(undefined);
    expect(preReplyStageFor(SESSION, at(3_300))).toBe("pre:directives:2s");
    clearPreReplyStage(SESSION, undefined);
    expect(emitted).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("never throws into the reply path, and a row lost to a failed write is not written later in its place", () => {
    step("config", 1_000, RUN);
    writer.down = true;
    expect(() => step("session-init", 1_500, RUN)).not.toThrow();
    writer.down = false;
    step("prepare-run", 1_700, RUN);
    at(2_000);
    expect(() => notePreReplyPlaced(RUN)).not.toThrow();
    expect(preRows()).toEqual([
      ["pre:session-init", 200],
      ["pre:prepare-run", 300],
    ]);
    expect(preReplyStageFor(SESSION, at(2_000))).toBe("pre:prepare-run:0s");
  });

  it("writes the catalog's turn.span slots and no other: label and durMs, keyed by run and session", () => {
    const entry = EVENT_CATALOG.find((event) => event.name === "turn.span");
    expect(entry?.label).toBeTruthy();
    expect(entry?.durMs).toBeTruthy();
    expect([entry?.n1, entry?.n2, entry?.n3, entry?.n4]).toEqual([null, null, null, null]);
    expect(entry?.fields).toEqual({});
    at(1_000);
    notePreReplyAck(RUN, SESSION);
    step("config", 1_010, RUN);
    expect(emitted).toEqual([
      {
        name: "turn.span",
        record: { runId: RUN, sessionKey: SESSION, label: "pre:ack", durMs: 10 },
      },
    ]);
  });
});
