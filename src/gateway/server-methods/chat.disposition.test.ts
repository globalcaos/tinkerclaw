import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

// TINKER_UI_DESIGN_BIBLE/prompt-queue.md §6.3 wire contract + §7 step G2.
//
// The gateway must REPORT what it did with an accepted prompt (PQ-8) on the early `final` that
// chat.send broadcasts when no agent run started. The CONTROL case pins the pre-G2 behaviour that
// must survive: an idle send's final carries NO `disposition` key at all.

installGatewayTestHooks({ scope: "suite" });

let ws: WebSocket;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

type DispatchParams = {
  replyOptions?: {
    onAgentRunStart?: (runId: string) => void;
    onPromptDisposition?: (disposition: "steered" | "backlogged" | "dropped") => void;
  };
};

const withMainSessionStore = async <T>(run: () => Promise<T>): Promise<T> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-disposition-"));
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

const sendAndReadFinal = async (
  idempotencyKey: string,
  behaviour: {
    report?: "steered" | "backlogged" | "dropped";
    startAgentRun?: boolean;
  } = {},
): Promise<Record<string, unknown>> => {
  dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
    const [params] = args as [DispatchParams];
    if (behaviour.startAgentRun) {
      params.replyOptions?.onAgentRunStart?.(idempotencyKey);
    }
    if (behaviour.report) {
      params.replyOptions?.onPromptDisposition?.(behaviour.report);
    }
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
  const event = (await finalPromise) as { payload?: Record<string, unknown> };
  return event.payload ?? {};
};

describe("chat.send reports the prompt disposition on its early final", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
  });

  test("a steered prompt's early final carries disposition 'steered'", async () => {
    await withMainSessionStore(async () => {
      const payload = await sendAndReadFinal("idem-disposition-steered", { report: "steered" });
      expect(payload.disposition).toBe("steered");
    });
  });

  test("a backlogged prompt's early final carries disposition 'backlogged'", async () => {
    await withMainSessionStore(async () => {
      const payload = await sendAndReadFinal("idem-disposition-backlogged", {
        report: "backlogged",
      });
      expect(payload.disposition).toBe("backlogged");
    });
  });

  test("CONTROL: an idle send's early final carries no disposition key at all", async () => {
    await withMainSessionStore(async () => {
      const payload = await sendAndReadFinal("idem-disposition-none");
      // Absent, not null/undefined-valued: absence is exactly what a pre-G2 gateway looks like.
      expect(Object.keys(payload)).not.toContain("disposition");
    });
  });

  test("the backstop final of a prompt whose agent run started carries no disposition", async () => {
    await withMainSessionStore(async () => {
      // Pins the invariant that today holds only by the ABSENCE of a call: the follow-up drain never
      // re-enters the reply pipeline with these reply options, so a dispatch that started a run must
      // never be able to stamp a queue placement on its backstop final.
      const payload = await sendAndReadFinal("idem-disposition-agent-run", {
        startAgentRun: true,
        report: "steered",
      });
      expect(Object.keys(payload)).not.toContain("disposition");
    });
  });
});
