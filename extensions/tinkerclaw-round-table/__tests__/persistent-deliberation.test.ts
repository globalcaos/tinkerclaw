/**
 * Tests for JSONL-based persistent deliberation (extension copy).
 */

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { createPersistentDeliberation } from "../src/persistent-deliberation.js";

// -- Temp dir helpers --

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "round-table-test-"));
  return () => rmSync(tempDir, { recursive: true, force: true });
});

function makePd() {
  return createPersistentDeliberation({
    tracesPath: join(tempDir, "traces.jsonl"),
    conclusionsPath: join(tempDir, "conclusions.jsonl"),
  });
}

// -- Tests --

describe("Persistent Deliberation: persists trace as JSONL", () => {
  it("stores debate traces and writes JSONL lines to disk", () => {
    const pd = makePd();
    const round = {
      roundNumber: 1,
      proposals: { "claude-opus": "Use Redis", "gpt-o3": "Use Memcached" },
      challenges: {
        "claude-opus": { "gpt-o3": "Memcached lacks persistence" },
        "gpt-o3": { "claude-opus": "Redis is complex" },
      },
      defenses: { "claude-opus": "Redis Cluster handles it", "gpt-o3": "Memcached is simpler" },
      synthesis: "Use Redis with Memcached as L1",
      ratification: { "claude-opus": "accept" as const, "gpt-o3": "accept" as const },
      converged: false,
      costs: [],
    };

    pd.storeDebateTraces("debate-001", round);

    // Verify JSONL file exists and has lines
    const tracesPath = join(tempDir, "traces.jsonl");
    const content = readFileSync(tracesPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // 2 proposals + 2 challenges + 2 defenses + 1 synthesis + 1 ratification = 8
    expect(lines.length).toBe(8);

    // Each line is valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("Persistent Deliberation: appends multiple traces", () => {
  it("appending traces from two rounds produces combined JSONL", () => {
    const pd = makePd();

    const round1 = {
      roundNumber: 1,
      proposals: { a: "Proposal A" },
      challenges: {},
      defenses: { a: "Defense A" },
      synthesis: "Synthesis 1",
      ratification: { a: "accept" as const },
      converged: false,
      costs: [],
    };

    const round2 = {
      roundNumber: 2,
      proposals: { a: "Proposal A v2" },
      challenges: {},
      defenses: { a: "Defense A v2" },
      synthesis: "Synthesis 2",
      ratification: { a: "accept" as const },
      converged: true,
      costs: [],
    };

    pd.storeDebateTraces("debate-002", round1);
    pd.storeDebateTraces("debate-002", round2);

    const content = readFileSync(join(tempDir, "traces.jsonl"), "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // round1: 1 proposal + 0 challenges + 1 defense + 1 synthesis + 1 ratification = 4
    // round2: same = 4
    expect(lines.length).toBe(8);
  });
});

describe("Persistent Deliberation: loads traces from JSONL (conclusions)", () => {
  it("stores and recalls a debate conclusion", () => {
    const pd = makePd();

    const conclusion = {
      debateId: "debate-003",
      task: "Cache design",
      architecture: "full-synapse" as const,
      finalSynthesis: "Use Redis with write-through caching",
      participantModels: ["claude-opus", "gpt-o3"],
      rounds: 3,
      converged: true,
      totalCost: 0.55,
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    pd.storeConclusion(conclusion);
    const recalled = pd.recallConclusion("debate-003");
    expect(recalled).toBeDefined();
    expect(recalled!.finalSynthesis).toBe("Use Redis with write-through caching");
    expect(recalled!.converged).toBe(true);
  });

  it("recallAllConclusions returns all stored conclusions", () => {
    const pd = makePd();

    pd.storeConclusion({
      debateId: "d1",
      task: "Task 1",
      architecture: "fan-out",
      finalSynthesis: "Conclusion 1",
      participantModels: ["a"],
      rounds: 1,
      converged: true,
      totalCost: 0.1,
      timestamp: new Date().toISOString(),
      metadata: {},
    });

    pd.storeConclusion({
      debateId: "d2",
      task: "Task 2",
      architecture: "sequential",
      finalSynthesis: "Conclusion 2",
      participantModels: ["b"],
      rounds: 2,
      converged: false,
      totalCost: 0.3,
      timestamp: new Date().toISOString(),
      metadata: {},
    });

    const all = pd.recallAllConclusions();
    expect(all.length).toBe(2);
    expect(all[0].debateId).toBe("d1");
    expect(all[1].debateId).toBe("d2");
  });
});

describe("Persistent Deliberation: returns empty array for missing file", () => {
  it("recallAllConclusions returns [] when no file exists", () => {
    const pd = createPersistentDeliberation({
      tracesPath: join(tempDir, "nonexistent", "traces.jsonl"),
      conclusionsPath: join(tempDir, "nonexistent", "conclusions.jsonl"),
    });
    expect(pd.recallAllConclusions()).toEqual([]);
  });

  it("recallConclusion returns undefined when no file exists", () => {
    const pd = createPersistentDeliberation({
      tracesPath: join(tempDir, "missing", "traces.jsonl"),
      conclusionsPath: join(tempDir, "missing", "conclusions.jsonl"),
    });
    expect(pd.recallConclusion("nonexistent-id")).toBeUndefined();
  });
});

describe("Persistent Deliberation: deliberation memory", () => {
  it("empty memory returns zero defaults", () => {
    const pd = makePd();
    const memory = pd.getDeliberationMemory();
    expect(memory.totalDebates).toBe(0);
    expect(memory.convergenceRate).toBe(0);
    expect(memory.avgCostPerDebate).toBe(0);
  });

  it("accumulates across multiple debates via updateDeliberationMemory", () => {
    const pd = makePd();

    const makeResult = (converged: boolean, rounds: number, cost: number) => ({
      task: "Task",
      rounds: Array.from({ length: rounds }, (_, i) => ({
        roundNumber: i + 1,
        proposals: { a: "p" },
        challenges: {},
        defenses: { a: "d" },
        synthesis: "s",
        ratification: { a: "accept" as const },
        converged: i === rounds - 1 && converged,
        costs: [
          {
            phase: "propose",
            model: "a",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCost: cost / rounds,
          },
        ],
      })),
      finalSynthesis: "Final",
      totalCosts: [
        { phase: "total", model: "a", inputTokens: 100, outputTokens: 50, estimatedCost: cost },
      ],
      totalEstimatedCost: cost,
      converged,
      convergenceRound: converged ? rounds : null,
    });

    pd.updateDeliberationMemory(makeResult(true, 2, 0.3), "fan-out");
    pd.updateDeliberationMemory(makeResult(true, 3, 0.5), "full-synapse");
    pd.updateDeliberationMemory(makeResult(false, 5, 1.0), "full-synapse");

    const memory = pd.getDeliberationMemory();
    expect(memory.totalDebates).toBe(3);
    expect(memory.convergenceRate).toBeCloseTo(2 / 3, 1);
    expect(memory.architectureUsage["fan-out"]).toBe(1);
    expect(memory.architectureUsage["full-synapse"]).toBe(2);
    expect(memory.avgCostPerDebate).toBeCloseTo(0.6, 1);
  });
});
