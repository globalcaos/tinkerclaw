import { describe, expect, it } from "vitest";
import { evaluateSpawnBudget } from "../spawn-budget.js";

describe("evaluateSpawnBudget", () => {
  it.each([
    ["over the token budget", { total: 101, toolCalls: 0, maxTokens: 100, maxToolCalls: 50 }, true],
    [
      "over the tool-call budget",
      { total: 0, toolCalls: 51, maxTokens: 100, maxToolCalls: 50 },
      true,
    ],
    ["under both budgets", { total: 99, toolCalls: 49, maxTokens: 100, maxToolCalls: 50 }, false],
    ["both caps undefined (no limits)", { total: 1_000_000, toolCalls: 1_000_000 }, false],
    [
      "token cap undefined but tool-call cap exceeded",
      { total: 1_000_000, toolCalls: 5, maxToolCalls: 4 },
      true,
    ],
    [
      "tool-call cap undefined but token cap exceeded",
      { total: 200, toolCalls: 1_000_000, maxTokens: 100 },
      true,
    ],
    [
      "exactly equal to the token budget triggers",
      { total: 100, toolCalls: 0, maxTokens: 100 },
      true,
    ],
    [
      "exactly equal to the tool-call budget triggers",
      { total: 0, toolCalls: 50, maxToolCalls: 50 },
      true,
    ],
  ])("%s => %s", (_label, input, expected) => {
    expect(evaluateSpawnBudget(input)).toBe(expected);
  });
});
