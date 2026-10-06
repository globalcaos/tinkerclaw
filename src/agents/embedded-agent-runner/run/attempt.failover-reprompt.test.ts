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

// FORK 2026-10-05 (bug-log `failover-reprompt`): a run can make several attempts (a provider
// failover, run.ts's thinking-level retry), and every attempt used to end in
// activeSession.prompt(), which wrote the prompt again, unkeyed, after the failed attempt's rows.
// An attempt that finds the row its run's marker claims on the branch continues from it instead.
// The claim's walk is unit-tested in src/gateway/prompt-key-marker.test.ts; this file pins the CALL
// SITE in runEmbeddedAttempt.

const hoisted = getHoisted();
type SessionManagerWithBranch = typeof hoisted.sessionManager & {
  getEntries?: () => unknown[];
  getBranch?: () => unknown[];
};

describe("a later attempt of a run continues from the prompt row an earlier attempt wrote", () => {
  const sessionKey = "agent:main:tinker:failover";
  const tempPaths: string[] = [];
  let branch: unknown[] = [];
  const manager = () => hoisted.sessionManager as SessionManagerWithBranch;

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    branch = [];
    manager().getEntries = () => branch;
    manager().getBranch = () => branch;
    hoisted.sessionManager.appendCustomEntry.mockImplementation((customType, data) => {
      branch.push({ type: "custom", customType, data });
      return `entry-${branch.length}`;
    });
  });

  afterEach(async () => {
    delete manager().getEntries;
    delete manager().getBranch;
    await cleanupTempPaths(tempPaths);
    vi.restoreAllMocks();
  });

  const marker = (key: string) => ({
    type: "custom",
    customType: PROMPT_KEY_CUSTOM_TYPE,
    data: buildPromptKeyMarker({ idempotencyKey: key, sessionKey, ts: 1 }),
  });
  const promptRow = { type: "message", id: "u1", message: { role: "user", content: "hello" } };
  // What attempt 1 left in the context: the prompt, the turn's runtime context, and the empty stub
  // of the call that failed over (muth719u 10-04 shape, without the tool steps).
  const failedAttempt = [
    { role: "user", content: "hello", timestamp: 1 },
    { role: "custom", customType: "openclaw.runtime-context", content: "ctx", timestamp: 1 },
    { role: "assistant", content: [], stopReason: "error", timestamp: 2 },
  ];
  const prompt = vi.fn(async (session: MutableSession) => {
    session.messages = [...session.messages, { role: "assistant", content: "done", timestamp: 2 }];
  });
  const sessionOf = async () => {
    const created = (await hoisted.createAgentSessionMock.mock.results[0]?.value) as {
      session: MutableSession;
    };
    return created.session;
  };
  const markerWrites = () =>
    hoisted.sessionManager.appendCustomEntry.mock.calls.filter(
      ([customType]) => customType === PROMPT_KEY_CUSTOM_TYPE,
    );
  const run = (overrides: Record<string, unknown> = {}) =>
    createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionMessages: failedAttempt as never,
      attemptOverrides: { promptKeys: ["key-first"], ...overrides },
      sessionPrompt: prompt,
    });

  it("continues: no second prompt, no marker, and the continued answer is this attempt's", async () => {
    prompt.mockClear();
    branch.push(marker("key-first"), promptRow);
    const result = await run();

    expect(prompt).not.toHaveBeenCalled();
    expect((await sessionOf()).agent.continue).toHaveBeenCalledTimes(1);
    expect(markerWrites()).toEqual([]);
    expect(result.currentAttemptAssistant).toMatchObject({ content: "continued" });
  });

  it("a first attempt (marker, no row yet) sends the prompt", async () => {
    prompt.mockClear();
    branch.push(marker("key-first"));
    await run();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect((await sessionOf()).agent.continue).not.toHaveBeenCalled();
  });

  it("a failover INTO claude-code keeps the prompt: its CLI session never received it", async () => {
    prompt.mockClear();
    branch.push(marker("key-first"), promptRow);
    await run({ provider: "claude-code" });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect((await sessionOf()).agent.continue).not.toHaveBeenCalled();
  });

  it("a row another prompt's marker claims is not this run's", async () => {
    prompt.mockClear();
    branch.push(marker("key-other"), promptRow);
    await run();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect((await sessionOf()).agent.continue).not.toHaveBeenCalled();
  });
});
