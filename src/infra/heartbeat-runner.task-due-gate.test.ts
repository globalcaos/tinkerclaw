// FORK (2026-06-04): regression suite for the heartbeat token-leak fix.
// The hourly interval poll must NOT invoke the LLM when HEARTBEAT.md declares
// scheduled `tasks:` but none are currently due. Previously the task-due gate
// was dead (resolveHeartbeatRunPrompt never returned null), so every interval
// tick fired Opus against a non-empty HEARTBEAT.md producing content nobody
// consumes. These tests assert prompt:null short-circuits to a cheap skip.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

const TASKS_HEARTBEAT = `# HEARTBEAT.md

tasks:
  - name: email-check
    interval: 30m
    prompt: Check for urgent unread emails
`;

const buildConfig = (tmpDir: string, storePath: string): OpenClawConfig => ({
  agents: {
    defaults: {
      workspace: tmpDir,
      heartbeat: {
        every: "5m",
        target: "none",
      },
    },
  },
  channels: { telegram: { allowFrom: ["*"] } },
  session: { store: storePath },
});

describe("heartbeat task-due gate (token-leak fix)", () => {
  it("skips the LLM on an interval tick when tasks exist but none are due", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), TASKS_HEARTBEAT, "utf-8");
      const cfg = buildConfig(tmpDir, storePath);
      const sessionKey = resolveMainSessionKey(cfg);
      const now = Date.now();
      // Seed a recent last-run for the only task so its 30m interval is NOT due.
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: now,
            heartbeatTaskState: { "email-check": now - 60_000 },
          },
        }),
      );

      const getReplySpy = vi.fn().mockResolvedValue({ text: "HEARTBEAT_OK" });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: { getReplyFromConfig: getReplySpy, nowMs: () => now },
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("no-tasks-due");
      // The gate must short-circuit BEFORE any LLM dispatch.
      expect(getReplySpy).not.toHaveBeenCalled();
    });
  });

  it("still invokes the LLM on an interval tick when a task IS due", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), TASKS_HEARTBEAT, "utf-8");
      const cfg = buildConfig(tmpDir, storePath);
      const sessionKey = resolveMainSessionKey(cfg);
      const now = Date.now();
      // Seed a stale last-run so the 30m interval IS due.
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: now,
            heartbeatTaskState: { "email-check": now - 60 * 60_000 },
          },
        }),
      );

      const getReplySpy = vi.fn().mockResolvedValue({ text: "HEARTBEAT_OK" });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: { getReplyFromConfig: getReplySpy, nowMs: () => now },
      });

      expect(result.status).toBe("ran");
      expect(getReplySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("skips the LLM when HEARTBEAT.md is the link-only '## Related' footer template", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const footerOnly = [
        "```markdown",
        "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
        "",
        "# Add tasks below when you want the agent to check something periodically.",
        "```",
        "",
        "## Related",
        "",
        "- [Heartbeat config](/gateway/config-agents)",
        "",
      ].join("\n");
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), footerOnly, "utf-8");
      const cfg = buildConfig(tmpDir, storePath);
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({ [sessionKey]: { sessionId: "sid", updatedAt: Date.now() } }),
      );

      const getReplySpy = vi.fn().mockResolvedValue({ text: "HEARTBEAT_OK" });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: { getReplyFromConfig: getReplySpy },
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("empty-heartbeat-file");
      expect(getReplySpy).not.toHaveBeenCalled();
    });
  });
});
