import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQaManualLane, runQaSuite } = vi.hoisted(() => ({
  runQaManualLane: vi.fn(),
  runQaSuite: vi.fn(),
}));

vi.mock("./manual-lane.runtime.js", () => ({
  runQaManualLane,
}));

vi.mock("./suite.js", () => ({
  runQaSuite,
}));

import { runQaManualLaneCommand, runQaSuiteCommand } from "./cli.runtime.js";

describe("qa cli runtime", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runQaSuite.mockReset();
    runQaManualLane.mockReset();
    runQaSuite.mockResolvedValue({
      watchUrl: "http://127.0.0.1:43124",
      reportPath: "/tmp/report.md",
      summaryPath: "/tmp/summary.json",
    });
    runQaManualLane.mockResolvedValue({
      model: "openai/gpt-5.4",
      waited: { status: "ok" },
      reply: "done",
      watchUrl: "http://127.0.0.1:43124",
    });
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    vi.clearAllMocks();
  });

  it("resolves suite repo-root-relative paths before dispatching", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/frontier",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: true,
      scenarioIds: ["approval-turn-tool-followthrough"],
    });

    expect(runQaSuite).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/frontier"),
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: true,
      scenarioIds: ["approval-turn-tool-followthrough"],
    });
  });

  it("passes the explicit repo root into manual runs", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      message: "read qa kickoff and reply short",
      timeoutMs: 45_000,
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      message: "read qa kickoff and reply short",
      timeoutMs: 45_000,
    });
  });
});
