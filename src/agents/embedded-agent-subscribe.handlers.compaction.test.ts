import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainSessionStoreLockQueuesForTest,
  resetSessionStoreLockRuntimeForTests,
  setSessionWriteLockAcquirerForTests,
} from "../config/sessions.js";
import { log } from "./embedded-agent-runner/logger.js";
import {
  readCompactionCount,
  seedSessionStore,
  waitForCompactionCount,
} from "./embedded-agent-subscribe.compaction-test-helpers.js";
import {
  handleCompactionEnd,
  reconcileSessionStoreCompactionCountAfterSuccess,
} from "./embedded-agent-subscribe.handlers.compaction.js";
import type { EmbeddedPiSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";

function createCompactionContext(params: {
  storePath: string;
  sessionKey: string;
  agentId?: string;
  initialCount: number;
  /** FORK 2026-07-27: lets a test observe the emitted compaction agent-events. */
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  /** FORK 2026-07-27: lets a test supply a pi-shaped session (model + settingsManager). */
  session?: unknown;
}): EmbeddedPiSubscribeContext {
  let compactionCount = params.initialCount;
  return {
    params: {
      runId: "run-test",
      session: (params.session ?? { messages: [] }) as never,
      config: { session: { store: params.storePath } } as never,
      sessionKey: params.sessionKey,
      sessionId: "session-1",
      agentId: params.agentId ?? "test-agent",
      onAgentEvent: params.onAgentEvent,
    },
    state: {
      compactionInFlight: true,
      pendingCompactionRetry: 0,
    } as never,
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    incrementCompactionCount: () => {
      compactionCount += 1;
    },
    getCompactionCount: () => compactionCount,
    noteCompactionTokensAfter: vi.fn(),
    getLastCompactionTokensAfter: vi.fn(() => undefined),
  } as unknown as EmbeddedPiSubscribeContext;
}

beforeEach(() => {
  setSessionWriteLockAcquirerForTests(async () => ({
    release: async () => {},
  }));
});

afterEach(async () => {
  resetSessionStoreLockRuntimeForTests();
  await drainSessionStoreLockQueuesForTest();
});

describe("reconcileSessionStoreCompactionCountAfterSuccess", () => {
  it("raises the stored compaction count to the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-reconcile-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(2);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });

  it("does not double count when the store is already at or above the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-idempotent-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 3,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(3);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(3);
  });
});

describe("handleCompactionEnd", () => {
  it("reconciles the session store after a successful compaction end event", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-handler-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 1,
    });

    handleCompactionEnd(ctx, {
      type: "compaction_end",
      result: { kept: 12 },
      willRetry: false,
      aborted: false,
    } as never);

    await waitForCompactionCount({
      storePath,
      sessionKey,
      expected: 2,
    });

    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
    // FORK 2026-04-28 chunk-21: noteCompactionTokensAfter dropped upstream;
    // the handler computes tokensAfter but voids it (compaction-retry signaling only).
    expect(ctx.noteCompactionTokensAfter).not.toHaveBeenCalled();
  });
});

// FORK 2026-07-27 (the architect: "instrument the compaction predicate") — gate "pi-auto".
// The fourth compaction decider is pi's own AgentSession._checkCompaction, and it is the one
// that actually fires. The numbers MUST come from `compaction_end` (pi's own `reason` +
// `result.tokensBefore`); reconstructing them at `compaction_start` yields tokens=0 because pi
// has already popped the triggering assistant message off agent.state.messages.
describe("handleCompactionEnd pi-auto diagnostics", () => {
  function captureCompactionDiagLines(run: () => void): string[] {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      run();
      return infoSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("[compaction-diag]"));
    } finally {
      infoSpy.mockRestore();
    }
  }

  async function makeCtx(overrides?: {
    onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
    session?: unknown;
  }): Promise<EmbeddedPiSubscribeContext> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-piauto-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({ storePath, sessionKey, compactionCount: 1 });
    return createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 1,
      onAgentEvent: overrides?.onAgentEvent,
      session: overrides?.session,
    });
  }

  it("emits pi's own reason and result.tokensBefore from the compaction_end event", async () => {
    const ctx = await makeCtx({
      session: {
        messages: [],
        model: { id: "claude-opus-4-8", contextWindow: 1_000_000 },
        settingsManager: {
          getCompactionSettings: () => ({
            enabled: true,
            reserveTokens: 16_384,
            keepRecentTokens: 20_000,
          }),
        },
      },
    });

    const lines = captureCompactionDiagLines(() => {
      handleCompactionEnd(ctx, {
        type: "compaction_end",
        reason: "overflow",
        result: { summary: "s", firstKeptEntryId: "entry-1", tokensBefore: 55_000 },
        willRetry: true,
        aborted: false,
      } as never);
    });

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("gate=pi-auto");
    expect(line).toContain("fires=true");
    // pi's own tokensBefore — NOT reconstructed from the (already-mutated) messages.
    expect(line).toContain("tokens=55000");
    // pi's predicate is contextTokens > contextWindow - reserveTokens.
    expect(line).toContain("threshold=983616");
    expect(line).toContain("window=1000000");
    expect(line).toContain("fill=5.5%");
    expect(line).toContain("reason=overflow");
    // willRetry=true at a low fill% is the 540s-hang signature.
    expect(line).toContain("willRetry=true");
    expect(line).toContain("aborted=false");
    expect(line).toContain("model=claude-opus-4-8");
    expect(line).toContain("sessionKey=main");
  });

  it("does not throw and still emits when pi sends no usable result", async () => {
    for (const result of [undefined, null, "not-an-object", 42, { summary: "s" }]) {
      const ctx = await makeCtx();

      const lines = captureCompactionDiagLines(() => {
        expect(() =>
          handleCompactionEnd(ctx, {
            type: "compaction_end",
            reason: "threshold",
            result,
            willRetry: false,
            aborted: false,
          } as never),
        ).not.toThrow();
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("gate=pi-auto");
      expect(lines[0]).toContain("tokens=0");
      expect(lines[0]).toContain("threshold=0");
      expect(lines[0]).toContain("window=unknown");
      expect(lines[0]).toContain("reason=threshold");
    }
  });

  // FORK 2026-07-28 — pi's _runAutoCompaction has three early returns that emit
  // {result: undefined, aborted: false, willRetry: false} WITHOUT compacting anything
  // (no model / getApiKeyAndHeaders failure / prepareCompaction returned null). Observed
  // live on a subagent holding 2 local messages. Reporting that as fires=true tokens=0
  // reads as "compacted an empty context" — the exact opposite of what happened.
  it("reports fires=false result=none when pi bailed without compacting", async () => {
    const ctx = await makeCtx();

    const lines = captureCompactionDiagLines(() => {
      handleCompactionEnd(ctx, {
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        willRetry: false,
        aborted: false,
      } as never);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("gate=pi-auto");
    expect(lines[0]).toContain("fires=false");
    expect(lines[0]).toContain("result=none");
    expect(lines[0]).toContain("reason=overflow");
  });

  it("reports fires=true result=ok when pi actually produced a compaction", async () => {
    const ctx = await makeCtx();

    const lines = captureCompactionDiagLines(() => {
      handleCompactionEnd(ctx, {
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 1_029_656 },
        willRetry: false,
        aborted: false,
      } as never);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fires=true");
    expect(lines[0]).toContain("result=ok");
    expect(lines[0]).toContain("tokens=1029656");
  });

  it("does not count an aborted compaction as fired, and surfaces pi's errorMessage", async () => {
    const ctx = await makeCtx();

    const lines = captureCompactionDiagLines(() => {
      handleCompactionEnd(ctx, {
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        willRetry: false,
        aborted: true,
        errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
      } as never);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fires=false");
    expect(lines[0]).toContain("aborted=true");
    expect(lines[0]).toContain("errorMessage=");
    expect(lines[0]).toContain("recovery failed");
  });

  it("emits reason=unknown rather than throwing when the event carries no reason", async () => {
    const ctx = await makeCtx();

    const lines = captureCompactionDiagLines(() => {
      expect(() =>
        handleCompactionEnd(ctx, {
          type: "compaction_end",
          result: { tokensBefore: 7 },
          willRetry: false,
          aborted: false,
        } as never),
      ).not.toThrow();
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=unknown");
    expect(lines[0]).toContain("tokens=7");
  });

  it("leaves the non-retry handleCompactionEnd behaviour unchanged", async () => {
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const ctx = await makeCtx({
      onAgentEvent: (evt) => {
        events.push(evt);
      },
    });

    captureCompactionDiagLines(() => {
      handleCompactionEnd(ctx, {
        type: "compaction_end",
        reason: "threshold",
        result: { tokensBefore: 10 },
        willRetry: false,
        aborted: false,
      } as never);
    });

    expect(ctx.getCompactionCount()).toBe(2);
    expect(ctx.state.compactionInFlight).toBe(false);
    expect(ctx.state.livenessState).toBe("working");
    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(ctx.noteCompactionRetry).not.toHaveBeenCalled();
    expect(ctx.resetForCompactionRetry).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        stream: "compaction",
        // FORK 2026-08-29: the end event now forwards pi's reported context size so the
        // CONTEXT WINDOW panel can show what the compaction saved. This fixture sets
        // result.tokensBefore = 10; tokensAfter is absent, and an absent number stays absent.
        data: { phase: "end", willRetry: false, completed: true, tokensBefore: 10 },
      },
    ]);
  });

  it("leaves the willRetry branch unchanged", async () => {
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const ctx = await makeCtx({
      onAgentEvent: (evt) => {
        events.push(evt);
      },
    });

    captureCompactionDiagLines(() => {
      handleCompactionEnd(ctx, {
        type: "compaction_end",
        reason: "overflow",
        result: { tokensBefore: 10 },
        willRetry: true,
        aborted: false,
      } as never);
    });

    expect(ctx.getCompactionCount()).toBe(2);
    expect(ctx.noteCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.resetForCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.maybeResolveCompactionWait).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        stream: "compaction",
        data: { phase: "end", willRetry: true, completed: true, tokensBefore: 10 },
      },
    ]);
  });

  it("emits even when compaction was aborted with no result", async () => {
    const ctx = await makeCtx();

    const lines = captureCompactionDiagLines(() => {
      handleCompactionEnd(ctx, {
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        willRetry: false,
        aborted: true,
      } as never);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("aborted=true");
    // Aborted compaction must not bump the counter — unchanged pre-existing behaviour.
    expect(ctx.getCompactionCount()).toBe(1);
  });
});
