import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

// FORK 2026-10-09 (effort slider): a live probe after deploy saw the bridge apply the right level for
// a Thalamus max + ultracode turn, but with `source=default` and no ultracode. The reply runner set
// both; runEmbeddedPiAgent's attempt object did not forward them. This pins that hop.
describe("runEmbeddedPiAgent forwards the effort provenance to the attempt", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("passes Thalamus's source and ultracode call through with the level", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["ok"] }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-effort-provenance-thalamus",
      thinkLevel: "high",
      thinkSource: "thalamus",
      ultracode: true,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toMatchObject({
      thinkLevel: "high",
      thinkSource: "thalamus",
      ultracode: true,
    });
  });

  it("leaves a run without provenance at no source and no ultracode", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["ok"] }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-effort-provenance-none",
      thinkLevel: "low",
    });

    const attempt = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as {
      thinkSource?: string;
      ultracode?: boolean;
    };
    expect(attempt.thinkSource).toBeUndefined();
    expect(attempt.ultracode).toBe(false);
  });
});
