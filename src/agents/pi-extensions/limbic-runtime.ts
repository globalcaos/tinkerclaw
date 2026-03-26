/**
 * LIMBIC Phase 4 Runtime: Humor pipeline wiring.
 *
 * Wraps bridge-discovery.ts, humor-potential.ts, and sensitivity-gate.ts
 * into a session-scoped runtime with event-store persistence for reactions.
 *
 * Registry pattern mirrors cortex-runtime.ts / ingestion-runtime.ts.
 */

import type { EmbeddingProvider } from "../../memory/embeddings.js";
import type { EventStore } from "../../memory/engram/event-store.js";
import {
  discoverBridges as discoverBridgesCascade,
  type BridgeCandidate,
} from "../../memory/limbic/bridge-discovery.js";
import { LIMBIC_CONFIG } from "../../memory/limbic/config.js";
import {
  createAssociation,
  recordOutcome,
  serializeAssociation,
} from "../../memory/limbic/humor-associations.js";
import { humorPotentialV2, type AnnIndex } from "../../memory/limbic/humor-potential.js";
import { sensitivityGate, type SensitivityResult } from "../../memory/limbic/sensitivity-gate.js";
import type { CortexRuntime } from "./cortex-runtime.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LimbicRuntimeOptions {
  /** Embedding dimension for concept vectors (default 128, ignored when embeddingProvider is set). */
  embeddingDim?: number;
  /** High-affinity concept pairs to pre-compute on init. */
  highAffinityPairs?: Array<[string, string]>;
  /** Real embedding provider (e.g. ollama/mxbai-embed-large). When set, replaces FNV-1a hashes with semantic vectors. */
  embeddingProvider?: EmbeddingProvider;
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
  /**
   * Log a humor attempt to the ENGRAM event store (kind: "humor_attempt").
   * Returns the attempt ID for later reaction correlation via recordReaction().
   */
  logAttempt(id: string, params: HumorAttemptParams, turnId: number): void;
  /**
   * Inspect a user message for positive reaction signals (laughter, emoji).
   * If found, automatically records a positive reaction for the given attempt ID.
   * Returns true when a positive reaction was detected and recorded.
   */
  captureReaction(userMessage: string, humorAttemptId: string): Promise<boolean>;
  /** Persist audience reaction to a humor attempt in the event store. */
  recordReaction(
    humorAttemptId: string,
    reaction: "positive" | "neutral" | "negative",
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Concept → embedding (semantic via provider, or deterministic FNV-1a fallback)
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
        sim: e.vector.reduce((s, x, i) => s + x * vector[i], 0), // dot product of unit vectors = cos sim
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

interface PendingAttempt {
  conceptA: string;
  conceptB: string;
  bridge: string;
  audience: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Positive reaction detection
// ---------------------------------------------------------------------------

/**
 * Text patterns that indicate a positive humor reaction.
 * Matches laughter text, positive emoji, and common affirmation phrases.
 */
const POSITIVE_REACTION_PATTERNS = [
  // Laugh text
  /\b(ha{2,}|he{2,}|hi{2,}|hehe|haha|hoho|lol|lmao|rofl|lmfao)\b/i,
  // Positive humor words
  /\b(funny|hilarious|clever|witty|good one|nice one|made me laugh|cracked me up)\b/i,
  // Laugh emoji (Unicode ranges for 😂🤣😄😆😁😀🙂)
  /[\u{1F602}\u{1F923}\u{1F604}\u{1F606}\u{1F601}\u{1F600}\u{1F642}]/u,
  // Clap emoji: 👏
  /\u{1F44F}/u,
];

/**
 * Detect whether a user message contains positive humor reaction signals.
 */
function detectPositiveReaction(message: string): boolean {
  return POSITIVE_REACTION_PATTERNS.some((pattern) => pattern.test(message));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a LIMBIC runtime backed by an ENGRAM event store.
 *
 * On construction, the runtime pre-computes bridge candidates for any
 * `highAffinityPairs` supplied in options.
 */
export function createLimbicRuntime(
  eventStore: EventStore,
  options: LimbicRuntimeOptions = {},
  cortexRuntime?: CortexRuntime,
): LimbicRuntime {
  const dim = options.embeddingDim ?? 128;
  const embedProvider = options.embeddingProvider ?? null;

  if (embedProvider) {
    console.log(
      `[limbic] Semantic embeddings active via ${embedProvider.id}/${embedProvider.model}`,
    );
  }

  // Concept vector cache — reuse vectors across calls for the same label.
  const vectorCache = new Map<string, number[]>();

  /** Embed a concept using the provider (semantic) or FNV-1a fallback (deterministic). */
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

  // Build a shared ANN index from all cached concepts (grows over time).
  function buildIndex(): AnnIndex {
    const entries = Array.from(vectorCache.entries()).map(([id, vector]) => ({ id, vector }));
    return createRuntimeIndex(entries);
  }

  // In-memory pending-attempt registry (keyed by humorAttemptId).
  const pendingAttempts = new Map<string, PendingAttempt>();

  // ---------- Pre-computation for high-affinity pairs ----------
  if (options.highAffinityPairs?.length) {
    // Eagerly populate vector cache so the index is richer from the start.
    // Fire-and-forget: does not block construction.
    void (async () => {
      for (const [a, b] of options.highAffinityPairs!) {
        await getVector(a);
        await getVector(b);
      }
    })();
  }

  // ---------- Humor calibration from CORTEX (or defaults) ----------
  function getCalibration() {
    return (
      cortexRuntime?.persona.humor ?? {
        humorFrequency: 0.15,
        preferredPatterns: [1, 4, 7],
        sensitivityThreshold: 0.5,
        audienceModel: {},
      }
    );
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
      // sensitivityGate needs conceptA/conceptB/bridge breakdown; map topic to those roles.
      return sensitivityGate(topic, context ?? "", "", calibration);
    },

    logAttempt(id: string, params: HumorAttemptParams, turnId: number): void {
      // Register in pending-attempt registry for later reaction correlation.
      pendingAttempts.set(id, {
        conceptA: params.conceptA,
        conceptB: params.conceptB,
        bridge: params.bridge,
        audience: params.audience ?? eventStore.sessionKey,
        timestamp: new Date().toISOString(),
      });

      // Persist a humor_attempt event so the attempt is durable.
      eventStore.append({
        turnId,
        sessionKey: eventStore.sessionKey,
        kind: "humor_attempt",
        content: JSON.stringify({
          id,
          conceptA: params.conceptA,
          conceptB: params.conceptB,
          bridge: params.bridge,
          score: params.score,
          audience: params.audience ?? eventStore.sessionKey,
        }),
        tokens: Math.ceil(JSON.stringify(params).length / 4),
        metadata: {
          tags: ["limbic", "humor_attempt"],
          importance: 5,
        },
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
      const audience = pending?.audience ?? eventStore.sessionKey;

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

      eventStore.append({
        turnId: 0,
        sessionKey: eventStore.sessionKey,
        kind: "humor_association",
        content: serializeAssociation(updated),
        tokens: Math.ceil(serializeAssociation(updated).length / 4),
        metadata: {
          tags: ["limbic", "humor_reaction", reaction],
          importance: reaction === "positive" ? 7 : reaction === "negative" ? 4 : 5,
        },
      });

      pendingAttempts.delete(humorAttemptId);
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = createSessionManagerRuntimeRegistry<LimbicRuntime>();

/** Store a LimbicRuntime for a given session manager instance. */
export const setLimbicRuntime = registry.set;

/** Retrieve the LimbicRuntime for a given session manager instance, or null. */
export const getLimbicRuntime = registry.get;
