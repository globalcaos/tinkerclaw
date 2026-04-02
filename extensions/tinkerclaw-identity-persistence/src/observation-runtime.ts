/**
 * FORK: Observation extractor (self-contained copy for extension).
 *
 * Extracts facts, preferences, and beliefs from conversations via lightweight
 * pattern matching. Batch extraction fires when accumulated token count crosses
 * a 30K threshold -- not per-turn -- to avoid noise.
 *
 * Adapted from src/agents/pi-extensions/observation-runtime.ts.
 * EventStore dependency replaced with an optional minimal interface parameter.
 * Uses local estimateTokens instead of importing from engram.
 */

import { estimateTokens } from "./persona-state.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default token accumulation threshold before a batch extraction fires. */
export const DEFAULT_OBSERVATION_THRESHOLD = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObservationType = "fact" | "preference" | "belief";

export interface Observation {
  type: ObservationType;
  content: string;
  /** Confidence estimate in [0, 1]. */
  confidence: number;
  /** Source messages that yielded this observation. */
  sourceMessages: string[];
}

/**
 * Minimal event store interface for observation persistence.
 * Avoids importing the full ENGRAM EventStore.
 */
export interface ObservationEventStore {
  readonly sessionKey: string;
  append(event: {
    turnId: number;
    sessionKey: string;
    kind: string;
    content: string;
    tokens: number;
    metadata: { tags: string[]; importance?: number };
  }): void;
}

export interface ObservationExtractor {
  /**
   * Extract observations from `messages` when the accumulated token count
   * crosses `threshold` (default: 30K). Returns extracted observations;
   * returns an empty array if the threshold is not yet reached.
   */
  extractObservations(messages: string[], threshold?: number): Observation[];
  /** Accumulated token count since the last successful extraction. */
  readonly tokensSinceLastExtraction: number;
  /** Total observations extracted across all batches. */
  readonly totalExtracted: number;
}

// ---------------------------------------------------------------------------
// Pattern-based sentence classifier (no LLM call required)
// ---------------------------------------------------------------------------

/** Patterns that indicate factual statements about the user or environment. */
const FACT_PATTERNS: RegExp[] = [
  /\bI (?:am|work|live|have|use|own|know|went|studied)\b/i,
  /\bmy (?:name|job|role|company|project|team|language|stack|preference)\b/i,
  /\bwe (?:use|build|deploy|run|manage)\b/i,
];

/** Patterns that indicate user preferences or intent. */
const PREFERENCE_PATTERNS: RegExp[] = [
  /\bI (?:prefer|like|love|hate|dislike|want|need|always|never)\b/i,
  /\bI(?:'d| would) (?:rather|prefer|like)\b/i,
  /\bmake sure (?:to|you)\b/i,
  /\bplease (?:don'?t|always|never|make)\b/i,
];

/** Patterns that indicate beliefs or opinions held by the user. */
const BELIEF_PATTERNS: RegExp[] = [
  /\bI (?:think|believe|feel|suspect|assume|expect)\b/i,
  /\bin my (?:opinion|view|experience)\b/i,
  /\bI(?:'m| am) (?:convinced|sure|confident|worried|concerned)\b/i,
];

/** Classify a single sentence and return its type + confidence, or null. */
function classifySentence(sentence: string): Pick<Observation, "type" | "confidence"> | null {
  if (PREFERENCE_PATTERNS.some((p) => p.test(sentence))) {
    return { type: "preference", confidence: 0.8 };
  }
  if (BELIEF_PATTERNS.some((p) => p.test(sentence))) {
    return { type: "belief", confidence: 0.75 };
  }
  if (FACT_PATTERNS.some((p) => p.test(sentence))) {
    return { type: "fact", confidence: 0.85 };
  }
  return null;
}

/** Extract all classifiable observations from a single message string. */
export function extractFromMessage(message: string): Observation[] {
  const sentences = message.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10);

  const observations: Observation[] = [];
  for (const sentence of sentences) {
    const classified = classifySentence(sentence);
    if (classified) {
      observations.push({
        ...classified,
        content: sentence.trim(),
        sourceMessages: [message],
      });
    }
  }
  return observations;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ObservationExtractor, optionally backed by an event store.
 *
 * Call `extractObservations(messages)` after each batch of messages.
 * When the accumulated token count crosses the threshold, observations are
 * extracted and optionally persisted as `system_event` entries.
 */
export function createObservationExtractor(
  eventStore?: ObservationEventStore,
): ObservationExtractor {
  let tokensSinceLastExtraction = 0;
  let totalExtracted = 0;

  return {
    get tokensSinceLastExtraction() {
      return tokensSinceLastExtraction;
    },

    get totalExtracted() {
      return totalExtracted;
    },

    extractObservations(
      messages: string[],
      threshold = DEFAULT_OBSERVATION_THRESHOLD,
    ): Observation[] {
      const batchTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
      tokensSinceLastExtraction += batchTokens;

      if (tokensSinceLastExtraction < threshold) {
        return [];
      }

      tokensSinceLastExtraction = 0;

      const observations: Observation[] = [];
      for (const message of messages) {
        observations.push(...extractFromMessage(message));
      }

      if (observations.length === 0) {
        return [];
      }

      // Persist each observation if an event store is provided
      if (eventStore) {
        for (const obs of observations) {
          const content = JSON.stringify({
            type: obs.type,
            content: obs.content,
            confidence: obs.confidence,
          });

          eventStore.append({
            turnId: 0,
            sessionKey: eventStore.sessionKey,
            kind: "system_event",
            content,
            tokens: estimateTokens(content),
            metadata: {
              tags: ["observation", obs.type],
              importance: Math.max(1, Math.round(obs.confidence * 10)),
            },
          });
        }
      }

      totalExtracted += observations.length;
      return observations;
    },
  };
}

// ---------------------------------------------------------------------------
// Registry (local WeakMap, replaces session-manager-runtime-registry import)
// ---------------------------------------------------------------------------

const observationRegistry = new WeakMap<object, ObservationExtractor>();

/** Store an ObservationExtractor for a given session manager instance. */
export function setObservationRuntime(
  sessionManager: unknown,
  value: ObservationExtractor | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }
  if (value === null) {
    observationRegistry.delete(sessionManager);
    return;
  }
  observationRegistry.set(sessionManager, value);
}

/** Retrieve the ObservationExtractor for a given session manager instance, or null. */
export function getObservationRuntime(sessionManager: unknown): ObservationExtractor | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }
  return observationRegistry.get(sessionManager) ?? null;
}
