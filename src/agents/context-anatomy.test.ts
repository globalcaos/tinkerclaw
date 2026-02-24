import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import {
  buildContextAnatomy,
  estimateTokens,
  readAnatomyEvents,
  readLatestAnatomyEvent,
  writeAnatomyEvent,
  type ContextAnatomyEvent,
} from "./context-anatomy.js";

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  test("returns ceiling of chars / 3.5", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(7)).toBe(2);
    expect(estimateTokens(35)).toBe(10);
    expect(estimateTokens(100)).toBe(29);
  });
});

// ---------------------------------------------------------------------------
// buildContextAnatomy
// ---------------------------------------------------------------------------

function makeReport(overrides?: Partial<SessionSystemPromptReport>): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt: Date.now(),
    systemPrompt: {
      chars: 15000,
      projectContextChars: 5000,
      nonProjectContextChars: 10000,
    },
    injectedWorkspaceFiles: [
      { name: "MEMORY.md", path: "MEMORY.md", missing: false, rawChars: 500, injectedChars: 500, truncated: false },
      { name: "SOUL.md", path: "SOUL.md", missing: false, rawChars: 300, injectedChars: 300, truncated: false },
      { name: "AGENTS.md", path: "AGENTS.md", missing: false, rawChars: 1200, injectedChars: 1200, truncated: false },
      { name: "MISSING.md", path: "MISSING.md", missing: true, rawChars: 0, injectedChars: 0, truncated: false },
    ],
    skills: {
      promptChars: 2000,
      entries: [{ name: "coding-agent", blockChars: 1000 }, { name: "github", blockChars: 1000 }],
    },
    tools: {
      listChars: 500,
      schemaChars: 3000,
      entries: [
        { name: "exec", summaryChars: 100, schemaChars: 800, propertiesCount: 5 },
        { name: "read", summaryChars: 50, schemaChars: 300, propertiesCount: 3 },
      ],
    },
    ...overrides,
  };
}

function makeMessages(): AgentMessage[] {
  return [
    { role: "user", content: "Hello, how are you?" },
    { role: "assistant", content: "I'm doing well, thanks for asking!" },
    { role: "user", content: "Search my memory for the project plan" },
    { role: "tool", content: JSON.stringify({ results: [{ path: "memory/plans/plan.md", score: 0.9 }] }) },
    { role: "assistant", content: "I found the project plan. Here's what it says..." },
    { role: "user", content: "Great, now build the feature" },
  ];
}

describe("buildContextAnatomy", () => {
  test("produces valid anatomy event with correct structure", () => {
    const event = buildContextAnatomy({
      turn: 3,
      compactionCycle: 1,
      provider: "anthropic",
      model: "claude-opus-4-6",
      sessionKey: "agent:main:main",
      systemPromptReport: makeReport(),
      messagesSnapshot: makeMessages(),
      contextWindowTokens: 200000,
    });

    expect(event.turn).toBe(3);
    expect(event.compactionCycle).toBe(1);
    expect(event.model).toBe("claude-opus-4-6");
    expect(event.provider).toBe("anthropic");
    expect(event.sessionKey).toBe("agent:main:main");
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event.contextWindow.maxTokens).toBe(200000);
    expect(event.contextWindow.utilizationPercent).toBeGreaterThan(0);
    expect(event.contextWindow.utilizationPercent).toBeLessThan(100);
  });

  test("decomposes system prompt correctly", () => {
    const event = buildContextAnatomy({
      turn: 1,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPromptReport: makeReport(),
      messagesSnapshot: [{ role: "user", content: "hi" }],
      contextWindowTokens: 200000,
    });

    // nonProjectContextChars = 10000
    expect(event.contextSent.systemPromptChars).toBe(10000);
    expect(event.contextSent.systemPromptTokens).toBe(estimateTokens(10000));
  });

  test("counts injected files excluding missing ones", () => {
    const event = buildContextAnatomy({
      turn: 1,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPromptReport: makeReport(),
      messagesSnapshot: [{ role: "user", content: "hi" }],
      contextWindowTokens: 200000,
    });

    // 3 non-missing files: MEMORY.md (500), SOUL.md (300), AGENTS.md (1200)
    expect(event.contextSent.injectedFiles).toHaveLength(3);
    expect(event.contextSent.injectedFilesTotalChars).toBe(2000);
  });

  test("separates user message from conversation history", () => {
    const event = buildContextAnatomy({
      turn: 3,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-opus-4-6",
      systemPromptReport: makeReport(),
      messagesSnapshot: makeMessages(),
      contextWindowTokens: 200000,
    });

    // Last message is "Great, now build the feature" (28 chars)
    expect(event.contextSent.userMessageChars).toBe("Great, now build the feature".length);
    // Tool results should be counted
    expect(event.contextSent.toolResultsChars).toBeGreaterThan(0);
    // Conversation history should include earlier user + assistant messages
    expect(event.contextSent.conversationHistoryChars).toBeGreaterThan(0);
  });

  test("identifies memory files in autoRecall", () => {
    const event = buildContextAnatomy({
      turn: 1,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPromptReport: makeReport(),
      messagesSnapshot: [{ role: "user", content: "hi" }],
      contextWindowTokens: 200000,
    });

    expect(event.memoriesInjected.autoRecall).toContain("MEMORY.md");
    expect(event.memoriesInjected.autoRecall).toContain("SOUL.md");
    expect(event.memoriesInjected.autoRecall).not.toContain("AGENTS.md");
  });

  test("totalChars is sum of all components", () => {
    const event = buildContextAnatomy({
      turn: 1,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPromptReport: makeReport(),
      messagesSnapshot: [{ role: "user", content: "test" }],
      contextWindowTokens: 200000,
    });

    const expected =
      event.contextSent.systemPromptChars +
      event.contextSent.injectedFilesTotalChars +
      event.contextSent.skillsChars +
      event.contextSent.toolSchemasChars +
      event.contextSent.conversationHistoryChars +
      event.contextSent.toolResultsChars +
      event.contextSent.userMessageChars;

    expect(event.contextSent.totalChars).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------

describe("JSONL persistence", () => {
  const testDir = path.join(os.tmpdir(), `anatomy-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    process.env.HOME = testDir;
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test("write and read back events", async () => {
    const event = buildContextAnatomy({
      turn: 1,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-opus-4-6",
      systemPromptReport: makeReport(),
      messagesSnapshot: [{ role: "user", content: "hi" }],
      contextWindowTokens: 200000,
    });

    await writeAnatomyEvent("test-session", event);
    await writeAnatomyEvent("test-session", { ...event, turn: 2 });

    const events = await readAnatomyEvents("test-session");
    expect(events).toHaveLength(2);
    expect(events[0]!.turn).toBe(1);
    expect(events[1]!.turn).toBe(2);
  });

  test("readLatestAnatomyEvent returns last event", async () => {
    const event = buildContextAnatomy({
      turn: 5,
      compactionCycle: 2,
      provider: "anthropic",
      model: "claude-opus-4-6",
      systemPromptReport: makeReport(),
      messagesSnapshot: [{ role: "user", content: "hi" }],
      contextWindowTokens: 200000,
    });

    await writeAnatomyEvent("latest-test", { ...event, turn: 1 });
    await writeAnatomyEvent("latest-test", { ...event, turn: 5 });

    const latest = await readLatestAnatomyEvent("latest-test");
    expect(latest).not.toBeNull();
    expect(latest!.turn).toBe(5);
  });

  test("readAnatomyEvents returns empty for nonexistent session", async () => {
    const events = await readAnatomyEvents("nonexistent");
    expect(events).toHaveLength(0);
  });

  test("readAnatomyEvents respects limit", async () => {
    const event = buildContextAnatomy({
      turn: 1,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-opus-4-6",
      systemPromptReport: makeReport(),
      messagesSnapshot: [{ role: "user", content: "hi" }],
      contextWindowTokens: 200000,
    });

    for (let i = 0; i < 10; i++) {
      await writeAnatomyEvent("limit-test", { ...event, turn: i });
    }

    const events = await readAnatomyEvents("limit-test", 3);
    expect(events).toHaveLength(3);
    // Should return last 3
    expect(events[0]!.turn).toBe(7);
    expect(events[2]!.turn).toBe(9);
  });
});
