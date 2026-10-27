import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import {
  drainForRestart,
  PREPARING_PARTICIPANT_ID,
  releaseRestartDrain,
  type RestartDrainReport,
} from "../../infra/restart-drain.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

// FORK 2026-10-01 — TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b; bug-log.md [chat-divergence] cause 6.
// On 2026-09-30 chat.send acked prompt a247f622 and wrote its marker, and the run was still in a
// memory-flush compaction when a staged-build restart drained (`held=1 ended=0 unfinished=0`) and
// stopped; nothing re-ran the prompt. chat.send now tracks each prompt it acks in the restart
// drain's `preparing` participant until the reply pipeline places it. Each test drives the REAL
// chat.send over the socket and drains while the mocked dispatch holds the prompt in preparation.
//
// CONTROL: on the parent tree nothing registers `preparing`, so `byParticipant.preparing` is
// undefined and the first test fails: the drain reports nothing for a prompt still preparing.

installGatewayTestHooks({ scope: "suite" });

let ws: WebSocket;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

type DispatchParams = {
  replyOptions?: {
    onAgentRunStart?: (runId: string) => void;
  };
};

const NOTHING: RestartDrainReport = { held: [], ended: [], unfinished: [] };

const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** `preparing`'s report from one drain, called off at once: a drain left on holds every new run. */
const drainPreparing = async (budgetMs: number): Promise<RestartDrainReport | undefined> => {
  try {
    return (await drainForRestart(budgetMs)).byParticipant[PREPARING_PARTICIPANT_ID];
  } finally {
    await releaseRestartDrain();
  }
};

const withMainSessionStore = async <T>(run: () => Promise<T>): Promise<T> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-restart-drain-"));
  try {
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    return await run();
  } finally {
    testState.sessionStorePath = undefined;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
};

// Each test starts listening for its terminal event only once the mocked dispatch is entered. The
// dispatch is blocked until the test lets it go, so the event cannot come earlier, and the 8 s
// window then leaves out the file's first chat.send: under a heavy machine load that send alone
// spent over 8 s in cold module loading and failed a listener that had started before it.
const chatEvent = (runId: string, state: "final" | "error") =>
  onceMessage(
    ws,
    (o) =>
      o.type === "event" &&
      o.event === "chat" &&
      o.payload?.state === state &&
      o.payload?.runId === runId,
    8000,
  );

// The file's first chat.send loads the send path cold: its ack took 6.8 to 7.9 s with a load average
// of 12 to 20 on 16 cores, and over rpcReq's default 10 s while a type-check ran beside it. That late
// send then took the next test's mocked dispatch. A send that never acks still fails, at 60 s,
// inside the suite's 120 s test timeout.
const send = async (runId: string): Promise<void> => {
  const res = await rpcReq(
    ws,
    "chat.send",
    {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: runId,
    },
    60_000,
  );
  expect(res.ok).toBe(true);
};

describe("chat.send keeps the restart drain waiting while an acked prompt prepares", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
  });

  test("CONTROL: a prompt still preparing when the budget runs out is reported unfinished, by key", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-drain-preparing";
      const entered = deferred();
      const prepared = deferred();
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        entered.resolve();
        // Stands in for the 30 s memory-flush compaction: preparation outlasts the drain's budget.
        await prepared.promise;
        return undefined;
      });
      await send(runId);
      await entered.promise;
      const final = chatEvent(runId, "final");
      try {
        expect(await drainPreparing(50)).toEqual({ held: [], ended: [], unfinished: [runId] });
      } finally {
        prepared.resolve();
        await final;
      }
      // Released when the dispatch settled: nothing is left for the next drain.
      expect(await drainPreparing(0)).toEqual(NOTHING);
    });
  });

  test("a prompt whose run starts inside the budget is reported ended, and the drain returns then", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-drain-starts";
      const entered = deferred();
      const startRun = deferred();
      const endRun = deferred();
      dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
        const [params] = args as [DispatchParams];
        entered.resolve();
        await startRun.promise;
        // The run reaches its first model call; from here the runner's own participant holds it.
        params.replyOptions?.onAgentRunStart?.(runId);
        // The run goes on after the drain has answered, so the dispatch's settle cannot be what
        // released the prompt: only onAgentRunStart can have.
        await endRun.promise;
        return undefined;
      });
      await send(runId);
      await entered.promise;
      const final = chatEvent(runId, "final");
      const startedAt = Date.now();
      const draining = drainPreparing(10_000);
      startRun.resolve();
      try {
        expect(await draining).toEqual({ held: [], ended: [runId], unfinished: [] });
        expect(Date.now() - startedAt).toBeLessThan(5_000);
      } finally {
        endRun.resolve();
        await final;
      }
    });
  });

  test("a prompt whose run fails leaves nothing preparing", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-drain-fails";
      const entered = deferred();
      const fail = deferred();
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        entered.resolve();
        await fail.promise;
        throw new Error("model unavailable");
      });
      await send(runId);
      await entered.promise;
      const errored = chatEvent(runId, "error");
      expect(await drainPreparing(0)).toEqual({ held: [], ended: [], unfinished: [runId] });
      fail.resolve();
      await errored;
      expect(await drainPreparing(0)).toEqual(NOTHING);
    });
  });

  test("chat.abort while the prompt prepares leaves nothing preparing", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-drain-abort";
      const entered = deferred();
      const finish = deferred();
      const dispatchDone = new Promise<void>((resolve) => {
        dispatchInboundMessageMock.mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
          resolve();
          return undefined;
        });
      });
      await send(runId);
      await entered.promise;
      const abort = await rpcReq(ws, "chat.abort", { sessionKey: "main", runId });
      expect(abort.ok).toBe(true);
      expect(await drainPreparing(0)).toEqual(NOTHING);
      finish.resolve();
      await dispatchDone;
    });
  });
});
