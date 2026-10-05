import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { deriveSessionPendingPrompts } from "../session-utils.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

// FORK 2026-09-25 — TINKER_UI_DESIGN_BIBLE/prompt-queue.md §2 ACCEPTED, §4 holder C, §7 G5.
// chat.send marks a prompt from right after its ack until the reply pipeline places it
// (session-utils.ts trackAcceptedChatSend), so sessions.list reports it PREPARING in the span where
// only the chat abort controller holds it. Each test drives the REAL chat.send over the socket and
// reads the row derivation from inside the mocked dispatch, i.e. while that span is open.
//
// CONTROL: on the parent tree chat.send marks nothing, so the first reading inside every dispatch
// is `undefined` and the PREPARING assertions fail; the release assertions pass there vacuously,
// which is why each test first proves the mark exists.

installGatewayTestHooks({ scope: "suite" });

let ws: WebSocket;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

/** The store key chat.send loads for `main` (loadSessionEntry's canonicalKey). */
const STORE_KEY = "agent:main:main";

type DispatchParams = {
  replyOptions?: {
    onAgentRunStart?: (runId: string) => void;
    onPromptDisposition?: (disposition: "steered" | "backlogged" | "dropped") => void;
  };
};

type Reading = ReturnType<typeof deriveSessionPendingPrompts>;

const pending = (): Reading => deriveSessionPendingPrompts(STORE_KEY);

const preparing = (key: string) => [{ key, state: "preparing", since: expect.any(Number) }];

const withMainSessionStore = async <T>(run: () => Promise<T>): Promise<T> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-accepted-prompt-"));
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

/** Sends `idempotencyKey` on `main`, runs `during` inside the dispatch, and waits for its final. */
const sendAndAwaitFinal = async (
  idempotencyKey: string,
  during: (params: DispatchParams) => void,
): Promise<void> => {
  dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
    const [params] = args as [DispatchParams];
    during(params);
    return undefined;
  });
  const finalPromise = onceMessage(
    ws,
    (o) =>
      o.type === "event" &&
      o.event === "chat" &&
      o.payload?.state === "final" &&
      o.payload?.runId === idempotencyKey,
    8000,
  );
  const res = await rpcReq(ws, "chat.send", {
    sessionKey: "main",
    message: "hello",
    idempotencyKey,
  });
  expect(res.ok).toBe(true);
  await finalPromise;
};

describe("chat.send marks an accepted prompt PREPARING until the reply pipeline places it", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
  });

  test("CONTROL: marked before placement, released when the prompt is backlogged", async () => {
    await withMainSessionStore(async () => {
      const readings: Reading[] = [];
      await sendAndAwaitFinal("idem-accepted-backlogged", (params) => {
        readings.push(pending());
        params.replyOptions?.onPromptDisposition?.("backlogged");
        readings.push(pending());
      });
      expect(readings).toEqual([preparing("idem-accepted-backlogged"), undefined]);
      expect(pending()).toBeUndefined();
    });
  });

  test("released when the prompt's agent run starts", async () => {
    await withMainSessionStore(async () => {
      const readings: Reading[] = [];
      await sendAndAwaitFinal("idem-accepted-run", (params) => {
        readings.push(pending());
        params.replyOptions?.onAgentRunStart?.("idem-accepted-run");
        readings.push(pending());
      });
      expect(readings).toEqual([preparing("idem-accepted-run"), undefined]);
      expect(pending()).toBeUndefined();
    });
  });

  test("released when a dispatch that never placed the prompt settles", async () => {
    await withMainSessionStore(async () => {
      const readings: Reading[] = [];
      // A command answered inside get-reply: no run, no disposition.
      await sendAndAwaitFinal("idem-accepted-unplaced", () => {
        readings.push(pending());
      });
      expect(readings).toEqual([preparing("idem-accepted-unplaced")]);
      expect(pending()).toBeUndefined();
    });
  });

  test("released by chat.abort while the dispatch is still pending", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-accepted-abort";
      let finishDispatch: () => void = () => {};
      const dispatchHeld = new Promise<void>((resolve) => {
        finishDispatch = resolve;
      });
      let dispatchEntered: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        dispatchEntered = resolve;
      });
      const dispatchDone = new Promise<void>((resolve) => {
        dispatchInboundMessageMock.mockImplementationOnce(async () => {
          dispatchEntered();
          await dispatchHeld;
          resolve();
          return undefined;
        });
      });
      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: runId,
      });
      expect(res.ok).toBe(true);
      await entered;
      expect(pending()).toEqual(preparing(runId));

      const abort = await rpcReq(ws, "chat.abort", { sessionKey: "main", runId });
      expect(abort.ok).toBe(true);
      expect(pending()).toBeUndefined();

      finishDispatch();
      await dispatchDone;
    });
  });
});
