import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQaManualLane, runQaSuite, startQaLabServer } = vi.hoisted(() => ({
  runQaManualLane: vi.fn(),
  runQaSuite: vi.fn(),
  startQaLabServer: vi.fn(),
}));

vi.mock("./manual-lane.runtime.js", () => ({
  runQaManualLane,
}));

vi.mock("./suite.js", () => ({
  runQaSuite,
}));

vi.mock("./lab-server.js", () => ({
  startQaLabServer,
}));

import {
  runQaLabSelfCheckCommand,
  runQaManualLaneCommand,
  runQaSuiteCommand,
} from "./cli.runtime.js";

describe("qa cli runtime", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runQaSuite.mockReset();
    runQaManualLane.mockReset();
    startQaLabServer.mockReset();
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
    startQaLabServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:58000",
      runSelfCheck: vi.fn().mockResolvedValue({
        outputPath: "/tmp/report.md",
      }),
      stop: vi.fn(),
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

  it("normalizes legacy live-openai suite runs onto the frontier provider mode", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-openai",
      scenarioIds: ["approval-turn-tool-followthrough"],
    });

    expect(runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        providerMode: "live-frontier",
      }),
    );
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

  it("defaults manual mock runs onto the mock-openai model lane", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      message: "read qa kickoff and reply short",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.4",
      alternateModel: "mock-openai/gpt-5.4-alt",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      timeoutMs: undefined,
    });
  });

  it("defaults manual frontier runs onto the frontier model lane", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      message: "read qa kickoff and reply short",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      timeoutMs: undefined,
    });
  });

  it("keeps an explicit manual primary model as the alternate default", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-frontier",
      primaryModel: "anthropic/claude-sonnet-4-6",
      message: "read qa kickoff and reply short",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      providerMode: "live-frontier",
      primaryModel: "anthropic/claude-sonnet-4-6",
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      timeoutMs: undefined,
    });
  });

  it("normalizes legacy live-openai manual runs onto the frontier provider mode", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-openai",
      message: "read qa kickoff and reply short",
    });

    expect(runQaManualLane).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.4",
        alternateModel: "openai/gpt-5.4",
      }),
    );
  });

  it("resolves self-check repo-root-relative paths before starting the lab server", async () => {
    await runQaLabSelfCheckCommand({
      repoRoot: "/tmp/openclaw-repo",
      output: ".artifacts/qa/self-check.md",
    });

    expect(startQaLabServer).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputPath: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/self-check.md"),
    });
  });
});
