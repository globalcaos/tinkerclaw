import { describe, it, expect } from "vitest";
import { createExplorationGate, type ExplorationGateConfig } from "../exploration-gate.js";

const BASE_CONFIG: ExplorationGateConfig = {
  enabled: true,
  minReadOnlyTools: 1,
  exemptTriggers: ["heartbeat", "cron"],
  exemptSubagents: true,
};

describe("ExplorationGate", () => {
  it("blocks Edit when no prior read-only tool call in turn", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    const result = gate.checkTool("Edit");
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("Exploration required");
  });

  it("allows Edit after a Read tool call", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    gate.recordToolCall("Read");
    const result = gate.checkTool("Edit");
    expect(result.blocked).toBe(false);
  });

  it("allows Read without prior exploration", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    const result = gate.checkTool("Read");
    expect(result.blocked).toBe(false);
  });

  it("allows Grep without prior exploration", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    expect(gate.checkTool("Grep").blocked).toBe(false);
  });

  it("allows Glob without prior exploration", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    expect(gate.checkTool("Glob").blocked).toBe(false);
  });

  it("blocks Write when no prior read-only tool", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    expect(gate.checkTool("Write").blocked).toBe(true);
  });

  it("blocks Bash when no prior read-only tool", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    expect(gate.checkTool("Bash").blocked).toBe(true);
  });

  it("skips gate for heartbeat triggers", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    const result = gate.checkTool("Edit", { trigger: "heartbeat" });
    expect(result.blocked).toBe(false);
  });

  it("skips gate for cron triggers", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    expect(gate.checkTool("Edit", { trigger: "cron" }).blocked).toBe(false);
  });

  it("skips gate for subagents when exemptSubagents=true", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    expect(gate.checkTool("Edit", { isSubagent: true }).blocked).toBe(false);
  });

  it("enforces gate for subagents when exemptSubagents=false", () => {
    const gate = createExplorationGate({ ...BASE_CONFIG, exemptSubagents: false });
    expect(gate.checkTool("Edit", { isSubagent: true }).blocked).toBe(true);
  });

  it("skips gate when disabled", () => {
    const gate = createExplorationGate({ ...BASE_CONFIG, enabled: false });
    expect(gate.checkTool("Edit").blocked).toBe(false);
  });

  it("resets turn counter", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    gate.recordToolCall("Read");
    expect(gate.checkTool("Edit").blocked).toBe(false);
    gate.resetTurn();
    expect(gate.checkTool("Edit").blocked).toBe(true);
  });

  it("Grep counts as read-only", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    gate.recordToolCall("Grep");
    expect(gate.checkTool("Edit").blocked).toBe(false);
  });

  it("Glob counts as read-only", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    gate.recordToolCall("Glob");
    expect(gate.checkTool("Write").blocked).toBe(false);
  });

  it("unknown tools are treated as mutating (fail-closed)", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    expect(gate.checkTool("SomeNewTool").blocked).toBe(true);
  });

  it("respects minReadOnlyTools > 1", () => {
    const gate = createExplorationGate({ ...BASE_CONFIG, minReadOnlyTools: 2 });
    gate.recordToolCall("Read");
    expect(gate.checkTool("Edit").blocked).toBe(true);
    gate.recordToolCall("Grep");
    expect(gate.checkTool("Edit").blocked).toBe(false);
  });

  it("tracks count correctly", () => {
    const gate = createExplorationGate(BASE_CONFIG);
    expect(gate.getTurnReadOnlyCount()).toBe(0);
    gate.recordToolCall("Read");
    expect(gate.getTurnReadOnlyCount()).toBe(1);
    gate.recordToolCall("Edit"); // mutating doesn't count
    expect(gate.getTurnReadOnlyCount()).toBe(1);
    gate.recordToolCall("Grep");
    expect(gate.getTurnReadOnlyCount()).toBe(2);
  });
});
