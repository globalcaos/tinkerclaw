/**
 * FORK: LIMBIC Runtime -- humor pipeline wiring for the extension.
 *
 * Wraps bridge-discovery, humor-potential, and sensitivity-gate into a
 * self-contained runtime. Unlike the original pi-extensions/limbic-runtime.ts
 * this version:
 *   - Has NO dependency on EventStore (persists to JSON file instead)
 *   - Has NO dependency on CortexRuntime (reads Identity Persistence shared state)
 *   - Uses a local WeakMap instead of createSessionManagerRuntimeRegistry
 *   - Falls back to FNV-1a hash when no embedding provider is available
 */

import {
  discoverBridges as discoverBridgesCascade,
  type BridgeCandidate,
} from "./bridge-discovery.js";
import { LIMBIC_CONFIG } from "./config.js";
import {
  createAssociation,
  recordOutcome,
  serializeAssociation,
  type HumorAssociation,
} from "./humor-associations.js";
import { humorPotentialV2, type AnnIndex } from "./humor-potential.js";
import { sensitivityGate, type SensitivityResult, type HumorCalibration } from "./sensitivity-gate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Optional embedding provider interface (subset of OpenClaw's EmbeddingProvider). */
export interface EmbeddingProvider {
  id: string;
  model: string;
  embedQuery(text: string): Promise<number[]>;
}

export interface LimbicRuntimeOptions {
  /** Embedding dimension for concept vectors (default 128, ignored when embeddingProvider is set). */
  embeddingDim?: number;
  /** High-affinity concept pairs to pre-compute on init. */
  highAffinityPairs?: Array<[string, string]>;
  /** Real embedding provider (e.g. ollama/mxbai-embed-large). When set, replaces FNV-1a hashes with semantic vectors. */
  embeddingProvider?: EmbeddingProvider;
  /** Humor calibration override. When absent, reads from Identity Persistence shared state. */
  calibration?: HumorCalibration;
}

export interface BridgeResult {
  bridge: string;
  quality: number;
  method: string;
}

export interface HumorAttemptParams {
  conceptA: string;
  conceptB: string;
  bridge: string;
  score: number;
  audience?: string;
}

export interface LimbicRuntime {
  /** Find conceptual bridges between two distant concepts. */
  discoverBridges(conceptA: string, conceptB: string): Promise<BridgeResult[]>;
  /** Score humor potential for a triplet using h_v2 (surprise-weighted coherence). */
  scoreHumor(conceptA: string, conceptB: string, bridge: string): Promise<number>;
  /** Run sensitivity gate for a topic and optional context string. */
  checkSensitivity(topic: string, context?: string): SensitivityResult;
  /** Log a humor attempt (in-memory pending registry). */
  logAttempt(id: string, params: HumorAttemptParams, turnId: number): void;
  /**
   * Inspect a user message for positive reaction signals (laughter, emoji).
   * If found, automatically records a positive reaction for the given attempt ID.
   * Returns true when a positive reaction was detected and recorded.
   */
  captureReaction(userMessage: string, humorAttemptId: string): Promise<boolean>;
  /** Record audience reaction to a humor attempt. */
  recordReaction(
    humorAttemptId: string,
    reaction: "positive" | "neutral" | "negative",
  ): Promise<void>;
  /** Get all recorded associations (for persistence). */
  getAssociations(): HumorAssociation[];
  /** Get all pending attempts (for state dump). */
  getPendingAttempts(): Map<string, PendingAttempt>;
}

// ---------------------------------------------------------------------------
// Concept -> embedding (semantic via provider, or deterministic FNV-1a fallback)
// ---------------------------------------------------------------------------

/**
 * FNV-1a hash fallback: deterministic unit-length vector from string.
 * Used only when no embedding provider is configured.
 */
function conceptToVectorFallback(concept: string, dim: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < concept.length; i++) {
    h = Math.imul(h ^ concept.charCodeAt(i), 16777619) >>> 0;
  }
  const v: number[] = Array.from({ length: dim });
  let s = h;
  for (let i = 0; i < dim; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    v[i] = (s / 0x100000000) * 2 - 1;
  }
  const mag = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
  return mag > 0 ? v.map((x) => x / mag) : v;
}

// ---------------------------------------------------------------------------
// In-memory ANN index (cosine similarity)
// ---------------------------------------------------------------------------

function createRuntimeIndex(entries: Array<{ id: string; vector: number[] }>): AnnIndex {
  return {
    query(vector: number[], k: number) {
      const scored = entries.map((e) => ({
        ...e,
        sim: e.vector.reduce((s, x, i) => s + x * vector[i], 0),
      }));
      scored.sort((a, b) => b.sim - a.sim);
      return scored.slice(0, k);
    },
    getId(vector: number[]) {
      for (const e of entries) {
        const sim = e.vector.reduce((s, x, i) => s + x * vector[i], 0);
        if (sim > 0.9999) {
          return e.id;
        }
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Pending-reaction index (in-memory, keyed by attempt ID)
// ---------------------------------------------------------------------------

export interface PendingAttempt {
  conceptA: string;
  conceptB: string;
  bridge: string;
  audience: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Positive reaction detection
// ---------------------------------------------------------------------------

const POSITIVE_REACTION_PATTERNS = [
  /\b(ha{2,}|he{2,}|hi{2,}|hehe|haha|hoho|lol|lmao|rofl|lmfao)\b/i,
  /\b(funny|hilarious|clever|witty|good one|nice one|made me laugh|cracked me up)\b/i,
  /[\u{1F602}\u{1F923}\u{1F604}\u{1F606}\u{1F601}\u{1F600}\u{1F642}]/u,
  /\u{1F44F}/u,
];

/**
 * Detect whether a user message contains positive humor reaction signals.
 */
export function detectPositiveReaction(message: string): boolean {
  return POSITIVE_REACTION_PATTERNS.some((pattern) => pattern.test(message));
}

// ---------------------------------------------------------------------------
// Default calibration
// ---------------------------------------------------------------------------

const DEFAULT_CALIBRATION: HumorCalibration = {
  humorFrequency: 0.15,
  preferredPatterns: [1, 4, 7],
  sensitivityThreshold: 0.5,
  audienceModel: {},
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a LIMBIC runtime for the extension.
 *
 * Stores humor associations in-memory (caller is responsible for persisting
 * via getAssociations() to the shared-state file).
 */
export function createLimbicRuntime(
  options: LimbicRuntimeOptions = {},
): LimbicRuntime {
  const dim = options.embeddingDim ?? 128;
  const embedProvider = options.embeddingProvider ?? null;
  const calibrationOverride = options.calibration ?? null;

  // Concept vector cache
  const vectorCache = new Map<string, number[]>();

  async function getVector(concept: string): Promise<number[]> {
    let v = vectorCache.get(concept);
    if (v) {
      return v;
    }
    if (embedProvider) {
      v = await embedProvider.embedQuery(concept);
    } else {
      v = conceptToVectorFallback(concept, dim);
    }
    vectorCache.set(concept, v);
    return v;
  }

  function buildIndex(): AnnIndex {
    const entries = Array.from(vectorCache.entries()).map(([id, vector]) => ({ id, vector }));
    return createRuntimeIndex(entries);
  }

  const pendingAttempts = new Map<string, PendingAttempt>();
  const associations: HumorAssociation[] = [];

  // Pre-computation for high-affinity pairs
  if (options.highAffinityPairs?.length) {
    void (async () => {
      for (const [a, b] of options.highAffinityPairs!) {
        await getVector(a);
        await getVector(b);
      }
    })();
  }

  function getCalibration(): HumorCalibration {
    return calibrationOverride ?? DEFAULT_CALIBRATION;
  }

  return {
    async discoverBridges(conceptA: string, conceptB: string): Promise<BridgeResult[]> {
      const A = await getVector(conceptA);
      const B = await getVector(conceptB);
      const index = buildIndex();

      const candidates: BridgeCandidate[] = await discoverBridgesCascade(A, B, index, {
        labelA: conceptA,
        labelB: conceptB,
        minQuality: LIMBIC_CONFIG.bridge.minBridgeQuality,
        maxResults: 5,
      });

      return candidates.map((c) => ({
        bridge: c.id,
        quality: c.quality,
        method: c.method,
      }));
    },

    async scoreHumor(conceptA: string, conceptB: string, bridge: string): Promise<number> {
      const A = await getVector(conceptA);
      const B = await getVector(conceptB);
      const bridgeVec = await getVector(bridge);
      const index = buildIndex();
      return humorPotentialV2(A, B, bridgeVec, index);
    },

    checkSensitivity(topic: string, context?: string): SensitivityResult {
      const calibration = getCalibration();
      return sensitivityGate(topic, context ?? "", "", calibration);
    },

    logAttempt(id: string, params: HumorAttemptParams, _turnId: number): void {
      pendingAttempts.set(id, {
        conceptA: params.conceptA,
        conceptB: params.conceptB,
        bridge: params.bridge,
        audience: params.audience ?? "general",
        timestamp: new Date().toISOString(),
      });
    },

    async captureReaction(userMessage: string, humorAttemptId: string): Promise<boolean> {
      if (!detectPositiveReaction(userMessage)) {
        return false;
      }
      await this.recordReaction(humorAttemptId, "positive");
      return true;
    },

    async recordReaction(
      humorAttemptId: string,
      reaction: "positive" | "neutral" | "negative",
    ): Promise<void> {
      const pending = pendingAttempts.get(humorAttemptId);
      const conceptA = pending?.conceptA ?? "unknown";
      const conceptB = pending?.conceptB ?? "unknown";
      const bridge = pending?.bridge ?? "unknown";
      const audience = pending?.audience ?? "general";

      const association = createAssociation({
        conceptA,
        conceptB,
        bridge,
        patternType: 1,
        surpriseScore: pending ? await this.scoreHumor(conceptA, conceptB, bridge) : 0,
        audience,
        discoveredVia: "conversation",
      });
      const updated = recordOutcome(association, reaction === "positive");
      associations.push(updated);

      pendingAttempts.delete(humorAttemptId);
    },

    getAssociations(): HumorAssociation[] {
      return [...associations];
    },

    getPendingAttempts(): Map<string, PendingAttempt> {
      return new Map(pendingAttempts);
    },
  };
}
