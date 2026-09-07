import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../../test-helpers/pi-coding-agent-token-mock.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";

let PREEMPTIVE_OVERFLOW_ERROR_TEXT: typeof import("./preemptive-compaction.js").PREEMPTIVE_OVERFLOW_ERROR_TEXT;
let estimatePrePromptTokens: typeof import("./preemptive-compaction.js").estimatePrePromptTokens;
let shouldPreemptivelyCompactBeforePrompt: typeof import("./preemptive-compaction.js").shouldPreemptivelyCompactBeforePrompt;
// Imported dynamically (not statically) so these resolve to the SAME mocked
// instances the module under test sees, after vi.resetModules().
let piEstimateTokens: typeof import("@mariozechner/pi-coding-agent").estimateTokens;
let estimateMessagesTokens: typeof import("../../compaction.js").estimateMessagesTokens;
let SAFETY_MARGIN: number;

beforeAll(async () => {
  vi.resetModules();
  ({
    PREEMPTIVE_OVERFLOW_ERROR_TEXT,
    estimatePrePromptTokens,
    shouldPreemptivelyCompactBeforePrompt,
  } = await import("./preemptive-compaction.js"));
  ({ estimateTokens: piEstimateTokens } = await import("@mariozechner/pi-coding-agent"));
  ({ SAFETY_MARGIN, estimateMessagesTokens } = await import("../../compaction.js"));
});

let timestamp = 1;

function makeAssistantHistory(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeToolResultMessage(...texts: string[]): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "read",
    content: texts.map((text) => ({ type: "text", text })),
    isError: false,
    timestamp: timestamp++,
  } as AgentMessage;
}

describe("preemptive-compaction", () => {
  const verboseHistory =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(40);
  const verboseSystem =
    "system guidance with multiple distinct words to avoid tokenizer overcompression ".repeat(25);
  const verbosePrompt =
    "user request with distinct content asking for a detailed answer and more context ".repeat(25);

  it("exports a context-overflow-compatible precheck error text", () => {
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("Context overflow:");
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("(precheck)");
  });

  it("raises the estimate as prompt-side content grows", () => {
    const smaller = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: "sys",
      prompt: "hello",
    });
    const larger = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
    });

    expect(larger).toBeGreaterThan(smaller);
  });

  it("requests preemptive compaction when the reserve-based prompt budget would be exceeded", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("does not request preemptive compaction when the reserve-based prompt budget still fits", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
    expect(result.estimatedPromptTokens).toBeLessThan(result.promptBudgetBeforeReserve);
  });

  it("uses the larger unwindowed message estimate when context engine assembly windows history", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("small assembled window")],
      unwindowedMessages: [makeAssistantHistory(verboseHistory.repeat(4))],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("caps reserve tokens so small context models keep usable prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 16_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(8_000);
    expect(result.promptBudgetBeforeReserve).toBe(8_000);
    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
  });

  it("keeps the requested reserve when it leaves enough prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 32_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(20_000);
    expect(result.promptBudgetBeforeReserve).toBe(12_000);
    expect(result.shouldCompact).toBe(false);
  });

  it("routes to direct tool-result truncation when recent tool tails can clearly absorb the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(2200);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(medium, medium, medium, medium),
    ];
    const reserveTokens = 2_000;
    const contextTokenBudget = 26_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const desiredOverflowTokens = 200;
    const adjustedContextTokenBudget =
      estimatedPromptTokens - desiredOverflowTokens + reserveTokens;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: Math.max(contextTokenBudget, adjustedContextTokenBudget),
      reserveTokens,
    });

    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("routes to compact then truncate when recent tool tails help but cannot fully cover the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(220);
    const longHistory = "old discussion with substantial retained context and decisions ".repeat(
      5000,
    );
    const messages = [
      makeAssistantHistory(longHistory),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 500;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 12_000,
      reserveTokens,
    });

    expect(result.route).toBe("compact_then_truncate");
    expect(result.shouldCompact).toBe(true);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("treats mixed oversized-plus-aggregate tool tails as cumulative recovery potential", () => {
    const oversized = "x".repeat(45_000);
    const medium = "alpha beta gamma delta epsilon ".repeat(500);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(oversized),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 2_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const potential = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 128_000,
    });
    const desiredOverflowTokens = 2_000;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: estimatedPromptTokens - desiredOverflowTokens + reserveTokens,
      reserveTokens,
    });

    expect(potential.oversizedReducibleChars).toBeGreaterThan(0);
    expect(potential.aggregateReducibleChars).toBeGreaterThan(0);
    expect(potential.oversizedReducibleChars).toBeLessThan(potential.maxReducibleChars);
    expect(potential.maxReducibleChars).toBeGreaterThan(desiredOverflowTokens * 4);
    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
  });

  it("counts the system prompt itself instead of handing it to pi (pi scores it 0)", () => {
    // REGRESSION (2026-07-27): estimatePrePromptTokens used to wrap the system
    // prompt in a synthetic {role:"system"} AgentMessage and call pi's
    // estimateTokens(). That function switches on role, has NO `system` case, and
    // returns 0 — a ~15k-token system prompt was scored as ZERO in production.
    // NOTE: this repo's pi-coding-agent token mock counts ANY message's content,
    // which is exactly what masked the bug, so a "the total went up" assertion
    // passes both before and after the fix. Assert on the CALL SHAPE instead.
    const systemPrompt = "s".repeat(40_000);
    const spy = vi.mocked(piEstimateTokens);
    spy.mockClear();
    const withSystem = estimatePrePromptTokens({ messages: [], systemPrompt, prompt: "hello" });
    const rolesHandedToPi = spy.mock.calls.map(([message]) =>
      String((message as unknown as { role?: unknown })?.role),
    );
    expect(rolesHandedToPi).not.toContain("system");
    expect(rolesHandedToPi).toContain("user");

    const withoutSystem = estimatePrePromptTokens({ messages: [], prompt: "hello" });
    const expectedDelta = Math.ceil(systemPrompt.length / 4) * SAFETY_MARGIN;
    expect(withSystem - withoutSystem).toBeGreaterThanOrEqual(Math.floor(expectedDelta) - 2);
    expect(withSystem - withoutSystem).toBeLessThanOrEqual(Math.ceil(expectedDelta) + 2);
  });

  it("accepts systemPromptChars when the caller only holds a size, preferring the string", () => {
    const chars = 40_000;
    const viaString = estimatePrePromptTokens({
      messages: [],
      systemPrompt: "s".repeat(chars),
      prompt: "hello",
    });
    const viaChars = estimatePrePromptTokens({
      messages: [],
      systemPromptChars: chars,
      prompt: "hello",
    });
    const bothSupplied = estimatePrePromptTokens({
      messages: [],
      systemPrompt: "s".repeat(chars),
      systemPromptChars: 4_000_000,
      prompt: "hello",
    });

    expect(viaChars).toBe(viaString);
    expect(bothSupplied).toBe(viaString);
  });

  it("counts tool schema chars, which pi never sees at all", () => {
    const base = estimatePrePromptTokens({ messages: [], prompt: "hello" });
    const withTools = estimatePrePromptTokens({
      messages: [],
      prompt: "hello",
      toolSchemaChars: 40_000,
    });
    const expectedDelta = Math.ceil(40_000 / 4) * SAFETY_MARGIN;
    expect(withTools - base).toBeGreaterThanOrEqual(Math.floor(expectedDelta) - 2);
    expect(withTools - base).toBeLessThanOrEqual(Math.ceil(expectedDelta) + 2);
  });

  it("lets the system prompt and tool schemas alone push the gate over budget", () => {
    const messages = [makeAssistantHistory("short history")];
    const withoutPrePrompt = shouldPreemptivelyCompactBeforePrompt({
      messages,
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });
    const withPrePrompt = shouldPreemptivelyCompactBeforePrompt({
      messages,
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
      systemPromptChars: 60_000,
      toolSchemaChars: 80_000,
    });

    expect(withoutPrePrompt.route).toBe("fits");
    expect(withoutPrePrompt.shouldCompact).toBe(false);
    expect(withPrePrompt.route).toBe("compact_only");
    expect(withPrePrompt.shouldCompact).toBe(true);
    expect(withPrePrompt.estimatedPromptTokens).toBeGreaterThan(
      withoutPrePrompt.estimatedPromptTokens,
    );
  });

  it("is unchanged from the previous estimate when no pre-prompt sizes are supplied", () => {
    const messages = [makeAssistantHistory(verboseHistory)];
    const expected = Math.max(
      0,
      Math.ceil(
        (estimateMessagesTokens(messages) +
          piEstimateTokens({
            role: "user",
            content: verbosePrompt,
            timestamp: 0,
          } as AgentMessage)) *
          SAFETY_MARGIN,
      ),
    );

    expect(estimatePrePromptTokens({ messages, prompt: verbosePrompt })).toBe(expected);
    expect(
      estimatePrePromptTokens({
        messages,
        prompt: verbosePrompt,
        systemPrompt: "   ",
        systemPromptChars: 0,
        toolSchemaChars: 0,
      }),
    ).toBe(expected);
  });
});
