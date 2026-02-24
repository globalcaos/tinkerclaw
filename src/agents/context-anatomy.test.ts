import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import {
  buildContextAnatomy,
  estimateTokens,
  extractTopics,
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
// extractTopics
// ---------------------------------------------------------------------------

describe("extractTopics", () => {
  test("extracts keywords from last user message", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Sure, I can help." },
      { role: "user", content: "Please refactor the authentication middleware module" },
    ];
    const topics = extractTopics(messages);
    // "refactor", "authentication", "middleware", "module" should appear
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.length).toBeLessThanOrEqual(5);
    // At least one meaningful keyword from the last user message
    const lowerTopics = topics.map((t) => t.toLowerCase());
    const hasKeyword =
      lowerTopics.some((t) => ["refactor", "authentication", "middleware", "module"].includes(t));
    expect(hasKeyword).toBe(true);
  });

  test("includes tool names from assistant tool_use blocks", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Read the config file" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "config.json" } },
        ],
      },
      { role: "tool", content: '{"content":"..."}' },
    ];
    const topics = extractTopics(messages);
    expect(topics).toContain("read_file");
  });

  test("includes file paths from tool result messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Check the memory plans" },
      {
        role: "tool",
        content: JSON.stringify({
          results: [{ path: "memory/plans/roadmap.md", score: 0.95 }],
        }),
      },
    ];
    const topics = extractTopics(messages);
    expect(topics.some((t) => t.includes("memory/plans/roadmap.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Topic transition tracking
// ---------------------------------------------------------------------------

describe("topic transitions", () => {
  test("first call has no topicTransition, second call has transition info", () => {
    const uniqueKey = `topic-transition-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const report = makeReport();

    const first = buildContextAnatomy({
      turn: 1,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionKey: uniqueKey,
      systemPromptReport: report,
      messagesSnapshot: [{ role: "user", content: "Deploy the database migration scripts" }],
      contextWindowTokens: 200000,
    });

    // First turn: topics populated, no transition yet
    expect(first.topics).toBeDefined();
    expect(Array.isArray(first.topics)).toBe(true);
    expect(first.topicTransition).toBeUndefined();

    const second = buildContextAnatomy({
      turn: 2,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionKey: uniqueKey,
      systemPromptReport: report,
      messagesSnapshot: [{ role: "user", content: "What is the weather forecast tomorrow?" }],
      contextWindowTokens: 200000,
    });

    // Second turn: transition from first topics to new topics
    expect(second.topics).toBeDefined();
    expect(second.topicTransition).toBeDefined();
    expect(second.topicTransition).toHaveProperty("from");
    expect(second.topicTransition).toHaveProperty("to");
    expect(second.topicTransition).toHaveProperty("changed");
    // Topics changed significantly (database/migration → weather/forecast)
    expect(second.topicTransition!.changed).toBe(true);
  });

  test("similar topics across turns yield changed: false", () => {
    const uniqueKey = `topic-stable-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const report = makeReport();

    const msgs1: AgentMessage[] = [
      { role: "user", content: "Refactor the authentication module please" },
    ];
    const msgs2: AgentMessage[] = [
      { role: "user", content: "Refactor the authentication middleware module" },
    ];

    buildContextAnatomy({
      turn: 1,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionKey: uniqueKey,
      systemPromptReport: report,
      messagesSnapshot: msgs1,
      contextWindowTokens: 200000,
    });

    const second = buildContextAnatomy({
      turn: 2,
      compactionCycle: 0,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionKey: uniqueKey,
      systemPromptReport: report,
      messagesSnapshot: msgs2,
      contextWindowTokens: 200000,
    });

    expect(second.topicTransition).toBeDefined();
    // Overlapping keywords ("refactor", "authentication", "module") → not changed
    expect(second.topicTransition!.changed).toBe(false);
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
