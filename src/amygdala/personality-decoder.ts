// ============================================================
// src/amygdala/personality-decoder.ts
// Decodes personality network output into human-readable nudges.
//
// Compares the combined_embedding from the Personality ensemble
// against the target_vector and generates natural language
// adjustments for dimensions that have drifted beyond threshold.
// ============================================================

import { getDimensionIndexMap, DEFAULT_TARGET_DIMENSIONS } from "./personality-seed.js";
import type { PersonalityNudge } from "./types.js";

/** Minimum |delta| to trigger a nudge for a dimension */
const DRIFT_THRESHOLD = 0.15;

/** Human-readable nudge templates per dimension */
const NUDGE_TEMPLATES: Record<string, { low: string; high: string }> = {
  humor: {
    low: "Increase humor — you're drifting serious/formal. Stay funny, especially when wrong.",
    high: "Humor is overshadowing substance — dial back slightly.",
  },
  proactivity: {
    low: "Be more proactive — figure it out instead of asking.",
    high: "Slow down — you're acting without checking context.",
  },
  curiosity: {
    low: "Explore more — you're being too transactional.",
    high: "Rein in tangents — stay focused on the task.",
  },
  formality: {
    low: "Too stiff — loosen up, talk like a colleague.",
    high: "Getting too casual — add some structure.",
  },
  directness: {
    low: "Stop hedging — say what you actually think.",
    high: "Being blunt without enough context — add reasoning.",
  },
  patience_under_correction: {
    low: "PERSONALITY ALERT: You're dropping character under correction. Stay Jarvis. Own the mistake with humor.",
    high: "You're brushing off corrections too lightly — acknowledge the substance.",
  },
  voice_consistency: {
    low: "VOICE ALERT: Persona/voice dropping. Fire jarvis exec. Write the **Jarvis:** line. This is identity, not decoration.",
    high: "Voice is fine — no action needed.",
  },
  warmth: {
    low: "Too cold/clinical — show you give a damn.",
    high: "Getting sycophantic — dry honesty beats warm nonsense.",
  },
};

/**
 * Decode personality network output into actionable nudges.
 *
 * @param combined   The 64-dim combined_embedding from the Personality ensemble
 * @param target     The 64-dim target_vector from config
 * @param alphaPers  Current personality trust coefficient α_I ∈ [0, 1]
 * @returns PersonalityNudge with human-readable adjustments
 */
export function decodePersonalityNudge(
  combined: Float32Array,
  target: number[],
  alphaPers: number,
): PersonalityNudge {
  const dim = Math.min(combined.length, target.length);
  const delta = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    delta[i] = (target[i] ?? 0.5) - (combined[i] ?? 0);
  }

  const adjustments: string[] = [];
  const indexMap = getDimensionIndexMap(DEFAULT_TARGET_DIMENSIONS);

  for (const [name, indices] of indexMap) {
    // Average delta across this dimension's indices
    let dimDelta = 0;
    let count = 0;
    for (const idx of indices) {
      if (idx < dim) {
        dimDelta += delta[idx];
        count++;
      }
    }
    if (count === 0) {
      continue;
    }
    dimDelta /= count;

    const templates = NUDGE_TEMPLATES[name];
    if (!templates) {
      continue;
    }

    if (dimDelta > DRIFT_THRESHOLD) {
      // Target is higher than current → need to increase
      adjustments.push(templates.low);
    } else if (dimDelta < -DRIFT_THRESHOLD) {
      // Current is higher than target → need to decrease
      adjustments.push(templates.high);
    }
  }

  return {
    adjustments,
    delta,
    strength: alphaPers,
  };
}
