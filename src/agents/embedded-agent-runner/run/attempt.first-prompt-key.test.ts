import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPromptKeyMarker,
  PROMPT_KEY_CUSTOM_TYPE,
} from "../../../gateway/prompt-key-marker.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  type MutableSession,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

// FORK 2026-10-01 (`[chat-divergence]` cause 1): runEmbeddedAttempt keys the prompt pi is about to
// persist, so a brand-new session's first prompt is keyed in pi's first flush. The on-disk
// contract (cold session, first flush, replay, retries) is pinned against a real pi
// SessionManager in src/gateway/prompt-key-marker.test.ts. This file pins the CALL SITE: the
// marker is written after the session is created, which is after prepareSessionManagerForRun (it
// empties a pre-created transcript with no assistant row), and before activeSession.prompt().

const hoisted = getHoisted();
type SessionManagerWithEntries = typeof hoisted.sessionManager & {
  getEntries?: () => unknown[];
};

describe("runEmbeddedAttempt prompt-key marker for the turn's prompt", () => {
  const sessionKey = "agent:main:tinker:first-prompt-key";
  const tempPaths: string[] = [];
  let entries: unknown[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    entries = [];
    (hoisted.sessionManager as SessionManagerWithEntries).getEntries = () => entries;
    hoisted.sessionManager.appendCustomEntry.mockImplementation((customType, data) => {
      entries.push({ type: "custom", customType, data });
      return `entry-${entries.length}`;
    });
  });

  afterEach(async () => {
    delete (hoisted.sessionManager as SessionManagerWithEntries).getEntries;
    await cleanupTempPaths(tempPaths);
    vi.restoreAllMocks();
  });

  const promptKeyAppends = () => {
    const { calls, invocationCallOrder } = hoisted.sessionManager.appendCustomEntry.mock;
    return calls.flatMap((args, index) =>
      args[0] === PROMPT_KEY_CUSTOM_TYPE
        ? [{ data: args[1], order: invocationCallOrder[index] ?? Number.NaN }]
        : [],
    );
  };

  const answer = vi.fn(async (session: MutableSession) => {
    session.messages = [...session.messages, { role: "assistant", content: "done", timestamp: 2 }];
  });

  it("writes the marker after the session is created and before the prompt is sent", async () => {
    answer.mockClear();
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: { promptKeys: ["key-first"] },
      sessionPrompt: answer,
    });

    const appends = promptKeyAppends();
    expect(appends.map(({ data }) => data)).toEqual([
      expect.objectContaining({ idempotencyKey: "key-first", sessionKey }),
    ]);
    const createdAt = hoisted.createAgentSessionMock.mock.invocationCallOrder[0];
    const promptedAt = answer.mock.invocationCallOrder[0];
    expect(createdAt).toBeDefined();
    expect(promptedAt).toBeDefined();
    expect(appends[0]?.order).toBeGreaterThan(createdAt ?? Number.POSITIVE_INFINITY);
    expect(appends[0]?.order).toBeLessThan(promptedAt ?? Number.NEGATIVE_INFINITY);
  });

  it("adds no second marker for a key the session already holds", async () => {
    entries.push({
      type: "custom",
      customType: PROMPT_KEY_CUSTOM_TYPE,
      data: buildPromptKeyMarker({ idempotencyKey: "key-first", sessionKey, ts: 1 }),
    });
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: { promptKeys: ["key-first"] },
      sessionPrompt: answer,
    });

    expect(promptKeyAppends()).toEqual([]);
  });

  it("writes nothing for a run with no prompt keys", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionPrompt: answer,
    });

    expect(promptKeyAppends()).toEqual([]);
  });
});
