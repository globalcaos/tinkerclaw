import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAttachment } from "../../sessions/session-attachments.js";
import {
  createSessionAttachmentsHandlers,
  type AttachmentKiller,
  type AttachmentStopResult,
  type ListSessionAttachmentsFn,
  type SignalOutcome,
} from "./session-attachments.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const hoisted = vi.hoisted(() => ({
  abortCalls: [] as Array<Record<string, unknown>>,
  abortResult: {
    ok: true,
    payload: { ok: true, aborted: true, runIds: ["run-1"] } as unknown,
  },
}));

// Stub chat.js entirely: we assert DELEGATION happened, and loading the real module would
// drag the whole agent runtime into a unit test.
vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.abort": (opts: {
      params: Record<string, unknown>;
      respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
    }) => {
      hoisted.abortCalls.push(opts.params);
      opts.respond(hoisted.abortResult.ok, hoisted.abortResult.payload, undefined);
    },
  },
}));

// The real lister is exercised by its own suite; here it only has to resolve.
vi.mock("../../sessions/session-attachments.js", () => ({
  listSessionAttachments: () => [],
}));

type FakeKiller = AttachmentKiller & {
  sent: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }>;
};

/** A process that dies on `dieOn` (or never, when null). Signals ONLY this fake. */
function fakeKiller(dieOn: "SIGTERM" | "SIGKILL" | null): FakeKiller {
  const sent: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }> = [];
  let alive = true;
  return {
    sent,
    send: (pid, signal): SignalOutcome => {
      sent.push({ pid, signal });
      if (dieOn === signal) {
        alive = false;
      }
      return "sent";
    },
    isAlive: () => alive,
  };
}

function processAttachment(over: Partial<SessionAttachment> = {}): SessionAttachment {
  return {
    id: "proc-1",
    kind: "process",
    label: "ffmpeg",
    ageMs: 1_000,
    pid: 4242,
    stoppable: true,
    ...over,
  } as SessionAttachment;
}

function runAttachment(over: Partial<SessionAttachment> = {}): SessionAttachment {
  return {
    id: "run-1",
    kind: "run",
    label: "assistant turn",
    ageMs: 2_000,
    stoppable: true,
    ...over,
  } as SessionAttachment;
}

function harness(params: { attachments: SessionAttachment[]; killer?: AttachmentKiller }) {
  const listCalls: Array<Record<string, unknown>> = [];
  const listAttachments: ListSessionAttachmentsFn = (input) => {
    listCalls.push(input as Record<string, unknown>);
    return params.attachments;
  };
  const handlers = createSessionAttachmentsHandlers({
    listAttachments,
    killer: params.killer,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
  });
  return { handlers, listCalls };
}

async function call(
  handlers: ReturnType<typeof createSessionAttachmentsHandlers>,
  method: "sessions.attachments" | "sessions.attachmentStop",
  requestParams: Record<string, unknown>,
) {
  const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const handler = handlers[method];
  expect(handler, `${method} must be registered`).toBeTypeOf("function");
  await handler!({
    req: { id: "1", type: "req", method, params: requestParams },
    params: requestParams,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      responses.push({ ok, payload, error });
    },
    context: { chatAbortControllers: new Map() },
  } as unknown as GatewayRequestHandlerOptions);
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

function stopPayload(res: { payload?: unknown }): AttachmentStopResult {
  return res.payload as AttachmentStopResult;
}

beforeEach(() => {
  hoisted.abortCalls.length = 0;
  hoisted.abortResult.ok = true;
  hoisted.abortResult.payload = { ok: true, aborted: true, runIds: ["run-1"] };
});

describe("sessions.attachments", () => {
  it("refuses a call with neither sessionKey nor sessionId", async () => {
    const { handlers } = harness({ attachments: [] });
    const res = await call(handlers, "sessions.attachments", {});
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it("returns the attachments alongside the clock they were aged against", async () => {
    const attachment = processAttachment();
    const { handlers, listCalls } = harness({ attachments: [attachment] });
    const res = await call(handlers, "sessions.attachments", { sessionKey: "agent:main:main" });
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ attachments: [attachment], now: 1_700_000_000_000 });
    expect(listCalls[0]).toEqual({ sessionKey: "agent:main:main", now: 1_700_000_000_000 });
  });
});

describe("sessions.attachmentStop", () => {
  it("treats an unknown attachmentId as success — it already finished", async () => {
    const { handlers } = harness({ attachments: [processAttachment()] });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "s",
      attachmentId: "nope",
    });
    expect(res.ok).toBe(true);
    expect(stopPayload(res)).toEqual({ stopped: true, action: "gone" });
  });

  it("refuses a non-stoppable attachment without signalling anything", async () => {
    const killer = fakeKiller("SIGTERM");
    const { handlers } = harness({
      attachments: [processAttachment({ stoppable: false })],
      killer,
    });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "s",
      attachmentId: "proc-1",
    });
    expect(stopPayload(res).stopped).toBe(false);
    expect(stopPayload(res).action).toBe("refused");
    expect(killer.sent).toEqual([]);
  });

  it("reports terminated when the process exits on SIGTERM", async () => {
    const killer = fakeKiller("SIGTERM");
    const { handlers } = harness({ attachments: [processAttachment()], killer });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "s",
      attachmentId: "proc-1",
    });
    expect(stopPayload(res)).toEqual({ stopped: true, action: "terminated" });
    expect(killer.sent).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("escalates to SIGKILL and reports killed when SIGTERM is ignored", async () => {
    const killer = fakeKiller("SIGKILL");
    const { handlers } = harness({ attachments: [processAttachment()], killer });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "s",
      attachmentId: "proc-1",
    });
    expect(stopPayload(res)).toEqual({ stopped: true, action: "killed" });
    expect(killer.sent).toEqual([
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  it("refuses when the process survives both signals", async () => {
    const killer = fakeKiller(null);
    const { handlers } = harness({ attachments: [processAttachment()], killer });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "s",
      attachmentId: "proc-1",
    });
    expect(stopPayload(res)).toEqual({
      stopped: false,
      action: "refused",
      detail: "process survived SIGKILL",
    });
    expect(killer.sent.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("escalate:false stops at refused and never sends SIGKILL", async () => {
    const killer = fakeKiller(null);
    const { handlers } = harness({ attachments: [processAttachment()], killer });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "s",
      attachmentId: "proc-1",
      escalate: false,
    });
    expect(stopPayload(res).stopped).toBe(false);
    expect(stopPayload(res).action).toBe("refused");
    expect(killer.sent.map((s) => s.signal)).toEqual(["SIGTERM"]);
  });

  it("never signals a pid supplied in params — only one from the snapshot", async () => {
    const killer = fakeKiller("SIGTERM");
    const { handlers } = harness({ attachments: [processAttachment({ pid: 4242 })], killer });
    await call(handlers, "sessions.attachmentStop", {
      sessionKey: "s",
      attachmentId: "proc-1",
      pid: 1,
    });
    expect(killer.sent).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("refuses an attachment whose pid is absent or a process group", async () => {
    const killer = fakeKiller("SIGTERM");
    const { handlers } = harness({
      attachments: [processAttachment({ pid: -4242 })],
      killer,
    });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "s",
      attachmentId: "proc-1",
    });
    expect(stopPayload(res).action).toBe("refused");
    expect(killer.sent).toEqual([]);
  });

  it("delegates a run attachment to chat.abort instead of signalling", async () => {
    const killer = fakeKiller("SIGTERM");
    const { handlers } = harness({ attachments: [runAttachment()], killer });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "agent:main:main",
      attachmentId: "run-1",
    });
    expect(stopPayload(res)).toEqual({ stopped: true, action: "aborted" });
    expect(hoisted.abortCalls).toEqual([{ sessionKey: "agent:main:main" }]);
    expect(killer.sent).toEqual([]);
  });

  it("reports gone when chat.abort finds the run already finished", async () => {
    hoisted.abortResult.payload = { ok: true, aborted: false, runIds: [] };
    const { handlers } = harness({ attachments: [runAttachment({ kind: "queued" })] });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "agent:main:main",
      attachmentId: "run-1",
    });
    expect(stopPayload(res).stopped).toBe(true);
    expect(stopPayload(res).action).toBe("gone");
  });

  it("surfaces a chat.abort refusal as refused rather than as success", async () => {
    hoisted.abortResult.ok = false;
    hoisted.abortResult.payload = undefined;
    const { handlers } = harness({ attachments: [runAttachment()] });
    const res = await call(handlers, "sessions.attachmentStop", {
      sessionKey: "agent:main:main",
      attachmentId: "run-1",
    });
    expect(stopPayload(res).stopped).toBe(false);
    expect(stopPayload(res).action).toBe("refused");
  });

  it("requires an attachmentId", async () => {
    const { handlers } = harness({ attachments: [] });
    const res = await call(handlers, "sessions.attachmentStop", { sessionKey: "s" });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });
});
