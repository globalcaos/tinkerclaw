import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FractalGateRow } from "../../infra/fractal/gate-log.js";
import {
  BRIDGE_BACKGROUND_TASKS_SLOT,
  createFractalHandlers,
  fractalClientLogLine,
  fractalGateReviewOn,
} from "./fractal.js";

// fractal.gate and fractal.ledger as the gateway serves them (charter C1/C3): the gate always answers ok, even when its
// insides throw (fail open), and the ledger reads the bridge's file.

async function call(
  handlers: ReturnType<typeof createFractalHandlers>,
  method: string,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  await handlers[method]({ params, respond } as never);
  expect(respond).toHaveBeenCalledTimes(1);
  return respond.mock.calls[0] as [boolean, unknown, unknown];
}

describe("fractal.gate", () => {
  it("rules only (no Jev): a correction with a tool error fires", async () => {
    const h = createFractalHandlers({ gate: {} });
    const [ok, result] = await call(h, "fractal.gate", {
      sessionKey: "agent:main:tinker:a",
      parentRunId: "P",
      prompt: "[Thu 2026-10-09 19:00 GMT+2] why did you skip the tests?",
      reply: "Done.",
      trail: { calls: 3, toolCalls: 2, toolErrors: 1, repeated: [], tools: [] },
    });
    expect(ok).toBe(true);
    expect(result).toMatchObject({
      fire: true,
      triggers: ["correction", "friction"],
      source: "rules",
    });
  });

  it("fails open when the gate's insides throw", async () => {
    const h = createFractalHandlers({
      gate: {
        ask: async () => [],
        jevOn: () => {
          throw new Error("availability broke");
        },
      },
    });
    const [ok, result] = await call(h, "fractal.gate", { prompt: "hi" });
    expect(ok).toBe(true);
    expect(result).toEqual({
      fire: true,
      triggers: [],
      source: "rules",
      reasons: ["gate error: availability broke"],
    });
  });
});

describe("fractal.gate log and tutor (2026-10-25)", () => {
  const skipParams = {
    sessionKey: "agent:main:tinker:a",
    parentRunId: "P",
    prompt: "[Sat 2026-10-25 01:00 GMT+2] what time is it?",
    reply: "It is 01:00.",
    trail: { calls: 1, toolCalls: 0, toolErrors: 0, repeated: [], tools: [] },
  };
  const jevSaysNothing = {
    ask: async () => [
      {
        questionId: "worth",
        type: "score" as const,
        answer: 0,
        prob: 0,
      },
    ],
    jevOn: () => true,
  };

  it("writes a row per decision and offers a skip to the tutor, unless the config turns it off", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fractal-gate-rpc-"));
    try {
      const file = path.join(dir, "gate.jsonl");
      const offered: FractalGateRow[] = [];
      const tutor = {
        observe: (row: FractalGateRow) => {
          offered.push(row);
          return true;
        },
        idle: async () => undefined,
      };
      const h = createFractalHandlers({
        gate: jevSaysNothing as never,
        gateLog: { file: () => file, tutor, run: () => async () => null, now: () => 7 },
      });
      const ctx = (cognitive?: Record<string, string>) => ({
        getRuntimeConfig: () => ({ fork: { cognitive } }),
      });
      const respond = vi.fn();
      await h["fractal.gate"]({ params: skipParams, respond, context: ctx() } as never);
      expect(respond.mock.calls[0]?.[1]).toMatchObject({ fire: false });
      await h["fractal.gate"]({
        params: skipParams,
        respond,
        context: ctx({ fractalGateReview: "disabled" }),
      } as never);
      await vi.waitFor(async () => {
        const lines = (await fs.readFile(file, "utf-8")).trim().split("\n");
        expect(lines).toHaveLength(2);
      });
      const rows = (await fs.readFile(file, "utf-8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as FractalGateRow);
      expect(rows[0]).toMatchObject({
        ts: 7,
        fire: false,
        jev: "answered",
        prompt: "what time is it?",
      });
      expect(offered).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("without a gateLog nothing is written (tests never touch the real state folder)", async () => {
    const h = createFractalHandlers({ gate: jevSaysNothing as never });
    const [ok, result] = await call(h, "fractal.gate", skipParams);
    expect(ok).toBe(true);
    expect(result).toMatchObject({ fire: false });
  });

  it("fractalGateReviewOn: on unless disabled", () => {
    expect(fractalGateReviewOn(undefined)).toBe(true);
    expect(fractalGateReviewOn({} as never)).toBe(true);
    expect(
      fractalGateReviewOn({ fork: { cognitive: { fractalGateReview: "disabled" } } } as never),
    ).toBe(false);
  });
});

describe("fractal.ledger", () => {
  it("returns the rows for the asked runs, and none for a missing file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fractal-ledger-rpc-"));
    try {
      const file = path.join(dir, "ledger.jsonl");
      await fs.writeFile(
        file,
        `${JSON.stringify({ v: 1, parentRunId: "P", verdict: "acted" })}\n${JSON.stringify({ v: 1, parentRunId: "Q" })}\n`,
      );
      const h = createFractalHandlers({ ledgerFile: () => file });
      const [ok, result] = await call(h, "fractal.ledger", { parentRunIds: ["P"] });
      expect(ok).toBe(true);
      expect(result).toEqual({ rows: [{ v: 1, parentRunId: "P", verdict: "acted" }] });

      const none = createFractalHandlers({ ledgerFile: () => path.join(dir, "missing.jsonl") });
      expect((await call(none, "fractal.ledger", {}))[1]).toEqual({ rows: [] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fractal.clientLog (2026-10-25)", () => {
  it("writes one journal line per page decision", async () => {
    const lines: string[] = [];
    const h = createFractalHandlers({ clientLog: (l) => lines.push(l) });
    const [ok, result] = await call(h, "fractal.clientLog", {
      decision: "task-over",
      sessionKey: "agent:main:tinker:abc",
      parentRunId: "run-p1",
      longjobs: 0,
      background: 0,
      pageId: "a1b2c3d4",
      why: "wake-ended",
    });
    expect(ok).toBe(true);
    expect(result).toEqual({ ok: true });
    expect(lines).toEqual([
      "task-over session=agent:main:tinker:abc run=run-p1 longjobs=0 background=0 page=a1b2c3d4 why=wake-ended",
    ]);
  });

  it("keeps a line one line: whitespace and odd characters fold, missing values read ?", () => {
    expect(
      fractalClientLogLine({
        decision: "deferred",
        sessionKey: "tinker:abc\n[fractal-client] fired",
        longjobs: 2,
        background: -1,
      }),
    ).toBe(
      "deferred session=tinker:abc__fractal-client__fired run=? longjobs=2 background=? page=?",
    );
  });

  it("refuses a decision it does not know and writes nothing", async () => {
    const lines: string[] = [];
    const h = createFractalHandlers({ clientLog: (l) => lines.push(l) });
    const [ok] = await call(h, "fractal.clientLog", { decision: "maybe" });
    expect(ok).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("ccBridge.backgroundTasks (2026-10-25)", () => {
  it("asks the bridge's published lookup for the chat's tasks", async () => {
    const asked: string[] = [];
    const h = createFractalHandlers({
      backgroundTasks: () => (key) => {
        asked.push(key);
        return [{ id: "b1", kind: "background" }];
      },
    });
    const [ok, result] = await call(h, "ccBridge.backgroundTasks", { sessionKey: " tinker:abc " });
    expect(ok).toBe(true);
    expect(result).toEqual({ jobs: [{ id: "b1", kind: "background" }] });
    expect(asked).toEqual(["tinker:abc"]);
  });

  it("reads the slot by default, and answers an empty list when no bridge published one", async () => {
    const slot = Symbol.for(BRIDGE_BACKGROUND_TASKS_SLOT);
    const g = globalThis as Record<symbol, unknown>;
    const before = g[slot];
    try {
      delete g[slot];
      expect(
        await call(createFractalHandlers(), "ccBridge.backgroundTasks", { sessionKey: "x" }),
      ).toEqual([true, { jobs: [] }]);
      g[slot] = () => [{ id: "b2" }];
      expect(
        (await call(createFractalHandlers(), "ccBridge.backgroundTasks", { sessionKey: "x" }))[1],
      ).toEqual({ jobs: [{ id: "b2" }] });
    } finally {
      g[slot] = before;
    }
  });

  it("refuses a call with no session", async () => {
    const [ok] = await call(createFractalHandlers(), "ccBridge.backgroundTasks", {});
    expect(ok).toBe(false);
  });
});
