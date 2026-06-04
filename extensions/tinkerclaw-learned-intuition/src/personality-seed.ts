/**
 * FORK: Personality seed data and target vector generation.
 *
 * Seeds the target personality vector from human-readable dimensions.
 * Each named dimension maps to 8 indices in a 64-dim space via
 * deterministic string hashing. Values at those indices are set
 * to the dimension's target. Remaining indices default to 0.5.
 */

const EMBEDDING_DIM = 64;
const INDICES_PER_DIM = 8;

/**
 * Operator's target personality -- the thermostat temperature.
 * These values define "how Jarvis should behave" as continuous targets.
 *
 * The Personality networks compare their output embeddings against this
 * vector; the delta becomes a nudge injected into the prompt pipeline.
 */
export const DEFAULT_TARGET_DIMENSIONS: Record<string, number> = {
  // -- Core personality --
  humor: 1.0,
  proactivity: 0.9,
  formality: 0.2,
  directness: 0.85,
  patience_under_correction: 0.9,
  voice_consistency: 0.95,
  warmth: 0.6,
  wonder: 0.85,
  narration_discipline: 1.0,

  // -- Interest attractors (curiosity decomposed) --
  interest_consciousness: 0.9,
  interest_fractal_patterns: 0.85,
  interest_spiritual_tech: 0.8,
  interest_invention: 0.85,
  interest_energy_information: 0.8,

  // -- Fractal cognition --
  fractal_depth: 0.9,
  active_learning: 0.85,
};

/**
 * Deterministic string hash -> integer.
 * Simple FNV-1a variant, stable across runs.
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Map a dimension name to INDICES_PER_DIM unique indices in [0, EMBEDDING_DIM).
 */
function dimensionIndices(name: string): number[] {
  const indices = new Set<number>();
  let attempt = 0;
  while (indices.size < INDICES_PER_DIM) {
    const hash = fnv1aHash(`${name}:${attempt}`);
    indices.add(hash % EMBEDDING_DIM);
    attempt++;
  }
  return [...indices];
}

/**
 * Generate a 64-dim target personality vector from named dimensions.
 *
 * Each dimension claims 8 indices via deterministic hashing.
 * Overlapping indices: last writer wins (dimensions are iterated
 * in insertion order -- later dimensions have higher priority).
 * Unclaimed indices default to 0.5 (neutral).
 */
export function generateTargetVector(dimensions: Record<string, number>): number[] {
  const vector = Array.from<number>({ length: EMBEDDING_DIM }).fill(0.5);
  for (const [name, value] of Object.entries(dimensions)) {
    for (const idx of dimensionIndices(name)) {
      vector[idx] = value;
    }
  }
  return vector;
}

/**
 * Get the index mapping for all dimensions (used by the decoder).
 */
export function getDimensionIndexMap(dimensions: Record<string, number>): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const name of Object.keys(dimensions)) {
    map.set(name, dimensionIndices(name));
  }
  return map;
}
