import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  resetCliCompactionTestDeps,
  runCliTurnCompactionLifecycle,
  setCliCompactionTestDeps,
} from "./cli-compaction.js";

function buildContextEngine(params: {
  compactCalls: Array<Parameters<ContextEngine["compact"]>[0]>;
}): ContextEngine {
  return {
    info: {
      id: "legacy",
      name: "Legacy Context Engine",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(assembleParams) {
      return { messages: assembleParams.messages, estimatedTokens: 0 };
    },
    async compact(compactParams) {
      params.compactCalls.push(compactParams);
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensBefore: compactParams.currentTokenCount ?? 0,
          tokensAfter: 100,
        },
      };
    },
  };
}

async function writeSessionFile(params: { sessionFile: string; sessionId: string }) {
  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  await fs.writeFile(
    params.sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: path.dirname(params.sessionFile),
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "old ask", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          timestamp: 2,
        },
      }),
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("runCliTurnCompactionLifecycle", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-compaction-"));
  });

  afterEach(async () => {
    resetCliCompactionTestDeps();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("compacts over-budget CLI transcripts and clears external CLI resume state", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli";
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const storePath = path.join(tmpDir, "sessions.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
      },
      cliSessionIds: {
        "claude-cli": "claude-session",
      },
      claudeCliSessionId: "claude-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: maintenance,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toMatchObject({
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget: 1_000,
      currentTokenCount: 950,
      force: true,
      compactionTarget: "budget",
    });
    expect(maintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "compaction",
        sessionId,
        sessionKey,
        sessionFile,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
    expect(updatedEntry?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("ignores implausible token snapshots larger than the context window", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli-implausible";
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const storePath = path.join(tmpDir, "sessions.json");
    await writeSessionFile({ sessionFile, sessionId });

    // Turn-AGGREGATE usage pollution: totalTokens is 7.5× the window — a value
    // that cannot be a real context snapshot and must not trip compaction.
    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 7_570_221,
      totalTokensFresh: true,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: vi.fn(async () => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      })),
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    // Real transcript estimate (600) is under budget-before-reserve (800):
    // no compaction, entry returned untouched.
    expect(compactCalls).toHaveLength(0);
    expect(updatedEntry).toBe(sessionEntry);
  });
});
