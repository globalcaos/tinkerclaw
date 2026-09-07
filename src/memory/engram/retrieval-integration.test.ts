/**
 * ENGRAM Phase 1.2: Retrieval pack assembly tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, estimateTokens } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import {
  assembleRetrievalPack,
  DEFAULT_RETRIEVAL_MAX_TOKENS,
  mmrRerank,
  type ScoredEvent,
} from "./retrieval-integration.js";

let tmpDir: string;
let store: EventStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engram-retrieval-test-"));
  store = createEventStore({ baseDir: tmpDir, sessionKey: "test-session" });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function appendUserMsg(text: string, turnId = 1) {
  store.append({
    turnId,
    sessionKey: "test-session",
    kind: "user_message",
    content: text,
    tokens: estimateTokens(text),
    metadata: { importance: 7 },
  });
}

function appendAgentMsg(text: string, turnId = 2) {
  store.append({
    turnId,
    sessionKey: "test-session",
    kind: "agent_message",
    content: text,
    tokens: estimateTokens(text),
    metadata: { importance: 5 },
  });
}

function appendToolResult(text: string, turnId = 3) {
  store.append({
    turnId,
    sessionKey: "test-session",
    kind: "tool_result",
    content: text,
    tokens: estimateTokens(text),
    metadata: { importance: 3 },
  });
}

// ─── empty store ────────────────────────────────────────────────────────────

describe("empty store", () => {
  it("returns empty string when store has no events", () => {
    const result = assembleRetrievalPack("anything", store);
    expect(result).toBe("");
  });
});

// ─── no FTS match ────────────────────────────────────────────────────────────

describe("no FTS match", () => {
  it("returns empty string when query matches nothing", () => {
    appendUserMsg("The quick brown fox jumps over the lazy dog");
    const result = assembleRetrievalPack("zzz quantum xyzzy", store);
    expect(result).toBe("");
  });
});

// ─── basic pack assembly ─────────────────────────────────────────────────────

describe("basic pack assembly", () => {
  it("returns non-empty string when query matches stored events", () => {
    appendUserMsg("How does the authentication flow work?");
    appendAgentMsg("The authentication uses JWT tokens with a refresh cycle.");
    const result = assembleRetrievalPack("authentication JWT", store);
    expect(result).not.toBe("");
  });

  it("includes a section header", () => {
    appendUserMsg("Tell me about the database schema");
    appendAgentMsg("The database uses PostgreSQL with a users table.");
    const result = assembleRetrievalPack("database PostgreSQL", store);
    expect(result).toContain("## Retrieved Context");
  });

  it("includes matching event content in output", () => {
    appendUserMsg("What is the API rate limit policy?");
    const result = assembleRetrievalPack("API rate limit", store);
    expect(result).toContain("rate limit");
  });

  it("includes event kind label in output", () => {
    appendUserMsg("How does caching work?");
    const result = assembleRetrievalPack("caching", store);
    expect(result).toContain("user_message");
  });
});

// ─── token budget ────────────────────────────────────────────────────────────

describe("token budget", () => {
  it("respects custom maxTokens and stays within budget", () => {
    // Fill store with many matching events
    for (let i = 0; i < 30; i++) {
      appendUserMsg(`Event about memory management and allocation strategy ${i}`, i + 1);
    }
    const maxTokens = 200;
    const result = assembleRetrievalPack("memory management allocation", store, {
      maxTokens,
    });
    const actualTokens = estimateTokens(result);
    expect(actualTokens).toBeLessThanOrEqual(maxTokens);
  });

  it("uses DEFAULT_RETRIEVAL_MAX_TOKENS when no maxTokens provided", () => {
    // Fill store with a large number of matching events
    for (let i = 0; i < 100; i++) {
      appendUserMsg(`Session context about the retrieval system and memory pipeline ${i}`, i + 1);
    }
    const result = assembleRetrievalPack("retrieval system memory pipeline", store);
    const actualTokens = estimateTokens(result);
    expect(actualTokens).toBeLessThanOrEqual(DEFAULT_RETRIEVAL_MAX_TOKENS);
  });

  it("returns empty string when maxTokens is too small for even one event", () => {
    appendUserMsg("database indexing strategy");
    // 5 tokens is smaller than header + any event line
    const result = assembleRetrievalPack("database indexing", store, { maxTokens: 5 });
    expect(result).toBe("");
  });

  it("does not truncate content mid-event — adds whole events or skips", () => {
    for (let i = 0; i < 10; i++) {
      appendUserMsg(`The deployment pipeline uses Docker containers for isolation ${i}`, i + 1);
    }
    const result = assembleRetrievalPack("deployment Docker containers", store, {
      maxTokens: 150,
    });
    if (result) {
      // Every line after header should be a complete formatted event
      const lines = result.split("\n").slice(1); // skip header
      for (const line of lines) {
        // Each event line starts with a timestamp bracket
        expect(line).toMatch(/^\[[\d\-T:]+\]/);
      }
    }
  });
});

// ─── scoring order ────────────────────────────────────────────────────────────

describe("scoring order", () => {
  it("places higher-relevance events before lower-relevance ones", () => {
    // One event with heavy overlap to query, one with minimal overlap
    appendUserMsg("The authentication token refresh mechanism uses sliding window expiry", 1);
    appendToolResult("file contents: some unrelated log data", 2);

    const result = assembleRetrievalPack("authentication token refresh mechanism", store);
    if (result && result.includes("authentication") && result.includes("unrelated")) {
      const authIdx = result.indexOf("authentication");
      const unrelatedIdx = result.indexOf("unrelated");
      expect(authIdx).toBeLessThan(unrelatedIdx);
    }
  });

  it("task-conditioned scoring: constraint-tagged events are boosted", () => {
    // Append a constraint-tagged event and a regular one with same query match
    store.append({
      turnId: 1,
      sessionKey: "test-session",
      kind: "system_event",
      content: "constraint: never exceed budget limit for cloud costs",
      tokens: estimateTokens("constraint: never exceed budget limit for cloud costs"),
      metadata: { importance: 5, tags: ["constraint"] },
    });
    appendAgentMsg("The budget limit was discussed briefly earlier", 2);

    const result = assembleRetrievalPack("budget limit costs", store);
    if (result && result.includes("constraint") && result.includes("discussed briefly")) {
      const constraintIdx = result.indexOf("constraint:");
      const briefIdx = result.indexOf("discussed briefly");
      expect(constraintIdx).toBeLessThan(briefIdx);
    }
  });
});

// ─── large store bounding ────────────────────────────────────────────────────

describe("large store bounding", () => {
  it("handles 200 events without error and stays within token budget", () => {
    for (let i = 0; i < 200; i++) {
      appendUserMsg(
        `Turn ${i}: working on the scalability design for the microservices architecture`,
        i,
      );
    }
    expect(() => {
      const result = assembleRetrievalPack("scalability microservices architecture design", store);
      expect(estimateTokens(result)).toBeLessThanOrEqual(DEFAULT_RETRIEVAL_MAX_TOKENS);
    }).not.toThrow();
  });

  it("returns fewer events than total store size when store is large", () => {
    for (let i = 0; i < 60; i++) {
      appendUserMsg(`Kubernetes cluster configuration and pod scheduling policy ${i}`, i);
    }
    const result = assembleRetrievalPack("Kubernetes cluster configuration", store, {
      maxTokens: 500,
    });
    const eventLines = result.split("\n").filter((l) => l.startsWith("[") && l.includes("]"));
    // Should have fewer than 60 lines due to token budget
    expect(eventLines.length).toBeLessThan(60);
  });
});

// ─── MMR rerank: equivalence with the naive implementation ───────────────────
//
// FORK 2026-08-19. `mmrRerank` used to rebuild both operands' word sets on every
// comparison: for the default 50 candidates that is 20,825 comparisons and 41,650 set
// constructions from full event text, measured at 99.3% of the whole pack build and
// ~20s of the pre-prompt wait on a real corpus. The fix builds each set once.
//
// That is an EXACT-EQUIVALENCE claim, so it needs a test that can fail. `naiveRerank`
// below is a verbatim transcription of the original algorithm; the optimised one must
// agree with it element for element, including tie-breaking.

/** The ORIGINAL implementation, kept as the oracle. Do not "optimise" this one. */
function naiveRerank(candidates: ScoredEvent[], lambda = 0.7, maxItems = 50): ScoredEvent[] {
  const wordJaccard = (a: string, b: string): number => {
    const words = (s: string): Set<string> =>
      new Set(
        s
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 2),
      );
    const setA = words(a);
    const setB = words(b);
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const w of setA) if (setB.has(w)) intersection++;
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  };

  if (candidates.length <= 1) return [...candidates];
  const selected: ScoredEvent[] = [];
  const remaining = [...candidates];
  while (remaining.length > 0 && selected.length < maxItems) {
    let bestScore = -Infinity;
    let bestIdx = 0;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let maxSim = 0;
      for (const s of selected) {
        const sim = wordJaccard(c.event.content, s.event.content);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * c.score - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}

/** Deterministic pseudo-random source — a seeded LCG, so a failure is reproducible. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeCandidates(count: number, seed: number): ScoredEvent[] {
  const rng = makeRng(seed);
  const vocab = [
    "authentication",
    "token",
    "refresh",
    "database",
    "schema",
    "migration",
    "deployment",
    "docker",
    "kubernetes",
    "latency",
    "retrieval",
    "compaction",
    "gateway",
    "session",
    "prompt",
    "cache",
    "worker",
    "spawn",
    "panel",
    "budget",
  ];
  return Array.from({ length: count }, (_, i) => {
    const len = 8 + Math.floor(rng() * 60);
    const content = Array.from({ length: len }, () => vocab[Math.floor(rng() * vocab.length)]).join(
      " ",
    );
    const event: MemoryEvent = {
      id: `evt-${i}`,
      turnId: i,
      sessionKey: "test-session",
      kind: "user_message",
      content,
      tokens: estimateTokens(content),
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      metadata: { importance: 5 },
    } as MemoryEvent;
    return { event, score: rng() };
  });
}

describe("mmrRerank equivalence with the naive original", () => {
  it("agrees element-for-element on the production shape (50 candidates)", () => {
    const candidates = makeCandidates(50, 12345);
    expect(mmrRerank(candidates).map((c) => c.event.id)).toEqual(
      naiveRerank(candidates).map((c) => c.event.id),
    );
  });

  it("agrees across many independent corpora", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const candidates = makeCandidates(30, seed);
      expect(mmrRerank(candidates).map((c) => c.event.id)).toEqual(
        naiveRerank(candidates).map((c) => c.event.id),
      );
    }
  });

  it("agrees when several candidates have identical content (tie-breaking)", () => {
    // Ties are where an index-parallel array can desync without changing any score.
    const base = makeCandidates(12, 99);
    const tied = base.map((c, i) => ({
      ...c,
      event: {
        ...c.event,
        content: i % 3 === 0 ? "identical repeated content here" : c.event.content,
      },
      score: i % 4 === 0 ? 0.5 : c.score,
    }));
    expect(mmrRerank(tied).map((c) => c.event.id)).toEqual(
      naiveRerank(tied).map((c) => c.event.id),
    );
  });

  it("agrees on the degenerate inputs", () => {
    expect(mmrRerank([])).toEqual([]);
    const one = makeCandidates(1, 7);
    expect(mmrRerank(one).map((c) => c.event.id)).toEqual(naiveRerank(one).map((c) => c.event.id));
  });

  it("selects every candidate — it is a reorder, not a filter", () => {
    // Documenting a real quirk rather than asserting it is desirable: `maxItems`
    // defaults to FTS_TOP_N (50) and the candidate list is already sliced to 50, so
    // the selection loop never binds. The token-budget loop in assembleRetrievalPack
    // is what actually drops rows. Changing this is a behaviour change, not a cleanup.
    const candidates = makeCandidates(50, 4242);
    expect(mmrRerank(candidates)).toHaveLength(50);
  });
});

// ─── taskId filtering ────────────────────────────────────────────────────────

describe("taskId filtering", () => {
  it("only returns events matching the given taskId when specified", () => {
    store.append({
      turnId: 1,
      sessionKey: "test-session",
      kind: "user_message",
      content: "GraphQL schema design for the API layer",
      tokens: estimateTokens("GraphQL schema design for the API layer"),
      metadata: { importance: 7, taskId: "task-alpha" },
    });
    store.append({
      turnId: 2,
      sessionKey: "test-session",
      kind: "user_message",
      content: "GraphQL query optimization strategies",
      tokens: estimateTokens("GraphQL query optimization strategies"),
      metadata: { importance: 7, taskId: "task-beta" },
    });

    const result = assembleRetrievalPack("GraphQL API schema", store, {
      taskId: "task-alpha",
    });

    // Should include task-alpha content
    expect(result).toContain("schema design");
    // Should NOT include task-beta content
    expect(result).not.toContain("optimization strategies");
  });
});
