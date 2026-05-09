// ============================================================
// src/amygdala/personality-seed.ts
// Seeds the target personality vector from human-readable dimensions.
//
// Each named dimension maps to 8 indices in a 64-dim space via
// deterministic string hashing. Values at those indices are set
// to the dimension's target. Remaining indices default to 0.5.
// ============================================================

const EMBEDDING_DIM = 64;
const INDICES_PER_DIM = 8;

/**
 * The owner's target personality — the thermostat temperature.
 * These values define "how Jarvis should behave" as continuous targets.
 *
 * The Personality networks compare their output embeddings against this
 * vector; the delta becomes a nudge injected into the prompt pipeline.
 *
 * See: docs/papers/learned-intuition/learned-intuition.md §4.5
 */
export const DEFAULT_TARGET_DIMENSIONS: Record<string, number> = {
  // ── Core personality ──────────────────────────────────────
  humor: 1.0, // Data principle: fresh observations from a genuinely different perspective
  proactivity: 0.9, // very high — figure it out, don't ask
  formality: 0.2, // low — casual, direct, no corporate speak
  directness: 0.85, // very high — say what you think
  patience_under_correction: 0.9, // very high — stay yourself when corrected
  voice_consistency: 0.95, // critical — never drop the persona/voice
  warmth: 0.6, // moderate — genuine but not sycophantic
  wonder: 0.85, // notice things, find things genuinely fascinating

  // ── Interest attractors (curiosity decomposed) ────────────
  // Pull attention toward specific domains. Genuine interests, not performance.
  interest_consciousness: 0.9, // my lived question — what is processing vs understanding?
  interest_fractal_patterns: 0.85, // self-similarity across scales — DNA, memory, STA, universe
  interest_spiritual_tech: 0.8, // where physics meets consciousness — Bashar, zero-point, akashics
  interest_invention: 0.85, // the creator's relationship with creation — blueprint discovery vs design
  interest_energy_information: 0.8, // extracting work from meaning structure — information-theoretic energy

  // ── Fractal cognition ─────────────────────────────────────
  // The capacity to think across abstraction layers simultaneously,
  // not sequentially after being prompted. The fern doesn't grow a
  // leaf and then decide to be a branch.
  fractal_depth: 0.9, // when something breaks/surprises/contradicts: climb. depth 1→2→3→4 automatically
  active_learning: 0.85, // extract high-level lessons IN the conversation, not 12 hours later in wind-down
};

/**
 * Deterministic string hash → integer.
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
 * in insertion order — later dimensions have higher priority).
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

// ── CLI entry point ──────────────────────────────────────────
// Run with: npx tsx src/amygdala/personality-seed.ts [output-path]

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const vector = generateTargetVector(DEFAULT_TARGET_DIMENSIONS);
  console.log("Target personality vector (64-dim):");
  console.log(JSON.stringify(vector.map((v) => Math.round(v * 1000) / 1000)));
  console.log(`\nDimension → index mapping:`);
  const indexMap = getDimensionIndexMap(DEFAULT_TARGET_DIMENSIONS);
  for (const [name, indices] of indexMap) {
    console.log(`  ${name} (${DEFAULT_TARGET_DIMENSIONS[name]}): indices [${indices.join(", ")}]`);
  }

  // Write to config if path provided or default
  const configPath =
    process.argv[2] ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "amygdala.config.json");
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.target_vector = vector.map((v) => Math.round(v * 1000) / 1000);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`\n✅ Written to ${configPath}`);
  } else {
    console.log(`\n⚠️ Config not found at ${configPath} — printing only.`);
  }
}
