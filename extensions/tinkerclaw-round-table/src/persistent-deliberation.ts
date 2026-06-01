/**
 * SYNAPSE Phase 7D: Persistent Deliberation.
 * Stores debate traces and conclusions as JSONL, manages eviction markers,
 * enables cross-session debate resumption, and tracks meta-patterns.
 *
 * Self-contained copy for the tinkerclaw-round-table extension.
 * Original: src/memory/synapse/persistent-deliberation.ts
 *
 * Adapted: Replaces EventStore/MetricsCollector dependencies with a simple
 * JSONL file writer that can operate standalone or be backed by an external
 * store passed at construction time.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ArchitectureType } from "./debate-architectures.js";
import type { DebateRound, DebateResult } from "./raac-protocol.js";

// -- Types --

export interface DebateTrace {
  debateId: string;
  roundNumber: number;
  phase: "propose" | "challenge" | "defend" | "synthesize" | "ratify";
  modelId: string;
  content: string;
  timestamp: string;
}

export interface DebateConclusion {
  debateId: string;
  task: string;
  architecture: ArchitectureType;
  finalSynthesis: string;
  participantModels: string[];
  rounds: number;
  converged: boolean;
  totalCost: number;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface DeliberationMemory {
  totalDebates: number;
  avgRoundsToConverge: number;
  avgCostPerDebate: number;
  architectureUsage: Record<string, number>;
  modelParticipation: Record<string, number>;
  convergenceRate: number;
  topicHistory: string[];
  lastUpdated: string;
}

// -- 7F: Multi-turn speaker memory --

/**
 * 7F: one resumed turn of a debate keyed by `memoryId`. Captures the model
 * responses, the synthesis, and the ratification of a single debate so a later
 * `synapse_debate` call with the same `memoryId` can resume from the last synthesis
 * instead of re-running all five phases from zero.
 */
export interface SpeakerTurn {
  roundNum: number;
  modelResponses: Record<string, string>;
  synthesis: string;
  ratification: Record<string, "accept" | "reject" | "amend">;
}

/**
 * 7F: the accumulated multi-turn history for one debate thread. Keyed on an
 * explicit `memoryId` (caller-provided or hashed) rather than the raw topic so
 * unrelated debates with similar phrasing do not collide. `turns` is retained
 * last-K to bound growth (mirrors the ENGRAM compaction cross-reference).
 */
export interface SpeakerMemory {
  debateTopic: string;
  memoryId: string;
  turns: SpeakerTurn[];
  lastUpdated: string;
}

/** 7F: cap retained turns so speaker memory cannot grow unbounded. */
export const MAX_RETAINED_TURNS = 10;

// -- JSONL Store (replaces EventStore dependency) --

export interface JsonlStoreOptions {
  /** Path to the JSONL file for traces. */
  tracesPath: string;
  /** Path to the JSONL file for conclusions. */
  conclusionsPath: string;
}

interface StoredEntry {
  kind: "debate_trace" | "debate_synthesis" | "speaker_memory";
  content: string;
  tags: string[];
  turnId: number;
  supersededBy?: string;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function appendJsonl(filePath: string, entry: StoredEntry): void {
  ensureDir(filePath);
  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

function readJsonl(filePath: string): StoredEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const entries: StoredEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as StoredEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// -- Persistent Deliberation Store --

export interface PersistentDeliberation {
  /** Store all traces from a debate round. */
  storeDebateTraces(debateId: string, round: DebateRound): void;
  /** Store the final conclusion as a durable entry. */
  storeConclusion(conclusion: DebateConclusion): void;
  /** Retrieve a prior debate conclusion by debateId. */
  recallConclusion(debateId: string): DebateConclusion | undefined;
  /** Retrieve all conclusions (for meta-pattern tracking). */
  recallAllConclusions(): DebateConclusion[];
  /** Get or create the deliberation memory (meta-patterns). */
  getDeliberationMemory(): DeliberationMemory;
  /** Update deliberation memory after a debate completes. */
  updateDeliberationMemory(result: DebateResult, architecture: ArchitectureType): void;
  /** 7F: recall multi-turn speaker memory for a debate thread, or undefined. */
  recallSpeakerMemory(memoryId: string): SpeakerMemory | undefined;
  /** 7F: persist (last-K-truncated) multi-turn speaker memory for a thread. */
  storeSpeakerMemory(memory: SpeakerMemory): void;
}

export function createPersistentDeliberation(options: JsonlStoreOptions): PersistentDeliberation {
  const { tracesPath, conclusionsPath } = options;

  function storeDebateTraces(debateId: string, round: DebateRound): void {
    const tags = ["synapse", "debate-trace", debateId, `round-${round.roundNumber}`];

    for (const [modelId, proposal] of Object.entries(round.proposals)) {
      appendJsonl(tracesPath, {
        kind: "debate_trace",
        content: JSON.stringify({ debateId, phase: "propose", modelId, text: proposal }),
        tags,
        turnId: round.roundNumber,
      });
    }

    for (const [attackerId, targets] of Object.entries(round.challenges)) {
      for (const [targetId, challenge] of Object.entries(targets)) {
        appendJsonl(tracesPath, {
          kind: "debate_trace",
          content: JSON.stringify({
            debateId,
            phase: "challenge",
            modelId: attackerId,
            targetId,
            text: challenge,
          }),
          tags,
          turnId: round.roundNumber,
        });
      }
    }

    for (const [modelId, defense] of Object.entries(round.defenses)) {
      appendJsonl(tracesPath, {
        kind: "debate_trace",
        content: JSON.stringify({ debateId, phase: "defend", modelId, text: defense }),
        tags,
        turnId: round.roundNumber,
      });
    }

    appendJsonl(tracesPath, {
      kind: "debate_trace",
      content: JSON.stringify({ debateId, phase: "synthesize", text: round.synthesis }),
      tags,
      turnId: round.roundNumber,
    });

    appendJsonl(tracesPath, {
      kind: "debate_trace",
      content: JSON.stringify({ debateId, phase: "ratify", votes: round.ratification }),
      tags,
      turnId: round.roundNumber,
    });
  }

  function storeConclusion(conclusion: DebateConclusion): void {
    appendJsonl(conclusionsPath, {
      kind: "debate_synthesis",
      content: JSON.stringify(conclusion),
      tags: ["synapse", "debate-conclusion", conclusion.debateId],
      turnId: 0,
    });
  }

  function recallConclusion(debateId: string): DebateConclusion | undefined {
    const entries = readJsonl(conclusionsPath);
    for (const entry of entries) {
      if (entry.kind === "debate_synthesis" && entry.tags?.includes(debateId)) {
        try {
          return JSON.parse(entry.content) as DebateConclusion;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }

  function recallAllConclusions(): DebateConclusion[] {
    const entries = readJsonl(conclusionsPath);
    const conclusions: DebateConclusion[] = [];
    for (const entry of entries) {
      if (entry.kind === "debate_synthesis") {
        try {
          conclusions.push(JSON.parse(entry.content) as DebateConclusion);
        } catch {
          // skip malformed
        }
      }
    }
    return conclusions;
  }

  function getDeliberationMemory(): DeliberationMemory {
    const conclusions = recallAllConclusions();
    if (conclusions.length === 0) {
      return {
        totalDebates: 0,
        avgRoundsToConverge: 0,
        avgCostPerDebate: 0,
        architectureUsage: {},
        modelParticipation: {},
        convergenceRate: 0,
        topicHistory: [],
        lastUpdated: new Date().toISOString(),
      };
    }

    const convergedDebates = conclusions.filter((c) => c.converged);
    const architectureUsageCounts: Record<string, number> = {};
    const modelParticipationCounts: Record<string, number> = {};

    for (const c of conclusions) {
      architectureUsageCounts[c.architecture] = (architectureUsageCounts[c.architecture] ?? 0) + 1;
      for (const modelId of c.participantModels) {
        modelParticipationCounts[modelId] = (modelParticipationCounts[modelId] ?? 0) + 1;
      }
    }

    return {
      totalDebates: conclusions.length,
      avgRoundsToConverge:
        convergedDebates.length > 0
          ? convergedDebates.reduce((s, c) => s + c.rounds, 0) / convergedDebates.length
          : 0,
      avgCostPerDebate: conclusions.reduce((s, c) => s + c.totalCost, 0) / conclusions.length,
      architectureUsage: architectureUsageCounts,
      modelParticipation: modelParticipationCounts,
      convergenceRate: convergedDebates.length / conclusions.length,
      topicHistory: conclusions.map((c) => c.task).slice(-20),
      lastUpdated: new Date().toISOString(),
    };
  }

  function updateDeliberationMemory(result: DebateResult, architecture: ArchitectureType): void {
    const debateId = `debate-${Date.now()}`;
    storeConclusion({
      debateId,
      task: result.task,
      architecture,
      finalSynthesis: result.finalSynthesis,
      participantModels: [...new Set(result.totalCosts.map((c) => c.model))],
      rounds: result.rounds.length,
      converged: result.converged,
      totalCost: result.totalEstimatedCost,
      timestamp: new Date().toISOString(),
      metadata: { convergenceRound: result.convergenceRound },
    });

    for (const round of result.rounds) {
      storeDebateTraces(debateId, round);
    }
  }

  // 7F: speaker memory is appended to the conclusions JSONL as a distinct kind so it
  // shares the existing append/read plumbing. Each store appends the latest full
  // snapshot (truncated to MAX_RETAINED_TURNS); recall returns the LAST snapshot for
  // a given memoryId (newest wins — append-only supersede, no rewrite).
  function storeSpeakerMemory(memory: SpeakerMemory): void {
    const truncated: SpeakerMemory = {
      ...memory,
      turns: memory.turns.slice(-MAX_RETAINED_TURNS),
      lastUpdated: new Date().toISOString(),
    };
    appendJsonl(conclusionsPath, {
      kind: "speaker_memory",
      content: JSON.stringify(truncated),
      tags: ["synapse", "speaker-memory", memory.memoryId],
      turnId: truncated.turns.length,
    });
  }

  function recallSpeakerMemory(memoryId: string): SpeakerMemory | undefined {
    const entries = readJsonl(conclusionsPath);
    let latest: SpeakerMemory | undefined;
    for (const entry of entries) {
      if (entry.kind !== "speaker_memory" || !entry.tags?.includes(memoryId)) continue;
      try {
        const parsed = JSON.parse(entry.content) as SpeakerMemory;
        if (parsed.memoryId === memoryId) latest = parsed;
      } catch {
        // skip malformed
      }
    }
    return latest;
  }

  return {
    storeDebateTraces,
    storeConclusion,
    recallConclusion,
    recallAllConclusions,
    getDeliberationMemory,
    updateDeliberationMemory,
    recallSpeakerMemory,
    storeSpeakerMemory,
  };
}
