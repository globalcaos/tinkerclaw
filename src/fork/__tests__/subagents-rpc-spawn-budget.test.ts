import { describe, it, expect } from "vitest";
import type { SpawnSubagentParams } from "../../agents/subagent-spawn.js";
import { validateSpawnBudget } from "../subagents-rpc.js";

function baseParams(overrides: Partial<SpawnSubagentParams> = {}): SpawnSubagentParams {
  return { task: "do a thing", ...overrides };
}

describe("validateSpawnBudget", () => {
  it("rejects a negative maxTokens", () => {
    expect(() => validateSpawnBudget(baseParams({ maxTokens: -1 }))).toThrow(/maxTokens/);
  });

  it("rejects a negative maxToolCalls", () => {
    expect(() => validateSpawnBudget(baseParams({ maxToolCalls: -5 }))).toThrow(/maxToolCalls/);
  });

  it("rejects a non-integer maxTokens", () => {
    expect(() => validateSpawnBudget(baseParams({ maxTokens: 1.5 }))).toThrow(/maxTokens/);
  });

  it("dedups and lowercases the allowTools names", () => {
    const params = baseParams({ allowTools: ["Read", "read", "BASH", " Grep ", "grep"] });
    const result = validateSpawnBudget(params);
    expect(result.allowTools).toEqual(["read", "bash", "grep"]);
    // mutates in place
    expect(params.allowTools).toEqual(["read", "bash", "grep"]);
  });

  it("passes valid input through to SpawnSubagentParams unchanged (other than allowTools normalization)", () => {
    const params = baseParams({
      maxTokens: 0,
      maxToolCalls: 12,
      allowTools: ["Read"],
      label: "worker",
    });
    const result = validateSpawnBudget(params);
    expect(result).toBe(params);
    expect(result.maxTokens).toBe(0);
    expect(result.maxToolCalls).toBe(12);
    expect(result.allowTools).toEqual(["read"]);
    expect(result.task).toBe("do a thing");
    expect(result.label).toBe("worker");
  });

  it("leaves an undefined budget untouched", () => {
    const params = baseParams();
    const result = validateSpawnBudget(params);
    expect(result.maxTokens).toBeUndefined();
    expect(result.maxToolCalls).toBeUndefined();
    expect(result.allowTools).toBeUndefined();
  });
});
