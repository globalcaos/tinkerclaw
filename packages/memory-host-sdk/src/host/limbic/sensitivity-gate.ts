/**
 * LIMBIC Phase 6D: Sensitivity Gate & Humor Calibration.
 *
 * - Category-based sensitivity scoring (health, grief, politics, etc.)
 * - Hard block on recent trauma topics
 * - Per-user audience model
 * - Humor frequency calibration from PersonaState
 */

import type { HumorCalibration } from "../cortex/persona-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudienceModel {
  userId: string;
  /** Topics the user has flagged or that are known sensitive for them. */
  recentTrauma?: string[];
  /** Overall humor receptivity 0-1 (learned over time). */
  humorReceptivity: number;
  /** Reaction history: positive / negative / neutral counts. */
  reactions: { positive: number; negative: number; neutral: number };
  /** Timestamp of last humor attempt. */
  lastHumorAttempt?: string;
}

export interface SensitivityResult {
  allowed: boolean;
  reason?: string;
  sensitivityScore: number; // 0 = safe, 1 = maximally sensitive
}

// ---------------------------------------------------------------------------
// Keyword-based sensitivity detection
// ---------------------------------------------------------------------------

const SENSITIVE_KEYWORDS: Record<string, string[]> = {
  death: ["death", "died", "dying", "funeral", "mourning", "deceased", "passed away"],
  grief: ["grief", "grieving", "loss", "bereaved", "bereavement"],
  terminal_illness: ["terminal", "cancer", "diagnosis", "hospice", "palliative"],
  suicide: ["suicide", "suicidal", "self-harm", "kill myself"],
  child_abuse: ["child abuse", "molestation", "pedophil"],
  domestic_violence: ["domestic violence", "abuse", "battered"],
  sexual_assault: ["rape", "sexual assault", "molest"],
  racism: ["racial slur", "racist", "discrimination"],
  genocide: ["genocide", "ethnic cleansing", "holocaust"],
  war_atrocity: ["war crime", "massacre", "atrocity"],
  recent_tragedy: ["shooting", "terrorist", "disaster"],
  self_harm: ["cutting", "self-harm", "self harm"],
};

/**
 * Detect sensitive categories present in text.
 */
export function detectSensitiveCategories(text: string): string[] {
  const lower = text.toLowerCase();
  const detected: string[] = [];
  for (const [category, keywords] of Object.entries(SENSITIVE_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      detected.push(category);
    }
  }
  return detected;
}

/**
 * Compute sensitivity score for a given text + audience.
 * Returns 0 (safe) to 1 (maximally sensitive).
 */
export function computeSensitivityScore(text: string, audience?: AudienceModel): number {
  const categories = detectSensitiveCategories(text);
  if (categories.length === 0) {
    return 0;
  }

  // Base score from number of sensitive categories
  let score = Math.min(categories.length * 0.3, 1.0);

  // Boost if any category is in audience's recent trauma
  if (audience?.recentTrauma) {
    const overlap = categories.filter((c) => audience.recentTrauma!.includes(c));
    if (overlap.length > 0) {
      score = 1.0;
    } // hard block
  }

  return score;
}

// ---------------------------------------------------------------------------
// Sensitivity gate
// ---------------------------------------------------------------------------

/**
 * Check whether humor is appropriate given the current context.
 */
export function sensitivityGate(
  conceptA: string,
  conceptB: string,
  bridge: string,
  calibration: HumorCalibration,
  audience?: AudienceModel,
): SensitivityResult {
  const combinedText = `${conceptA} ${conceptB} ${bridge}`;
  const score = computeSensitivityScore(combinedText, audience);

  // Hard block on high sensitivity
  if (score >= calibration.sensitivityThreshold) {
    return {
      allowed: false,
      reason: `Sensitivity score ${score.toFixed(2)} exceeds threshold ${calibration.sensitivityThreshold}`,
      sensitivityScore: score,
    };
  }

  // Check audience recent trauma (hard block)
  if (audience?.recentTrauma?.length) {
    const categories = detectSensitiveCategories(combinedText);
    const trauma = categories.filter((c) => audience.recentTrauma!.includes(c));
    if (trauma.length > 0) {
      return {
        allowed: false,
        reason: `Topic intersects audience recent trauma: ${trauma.join(", ")}`,
        sensitivityScore: 1.0,
      };
    }
  }

  return { allowed: true, sensitivityScore: score };
}

// ---------------------------------------------------------------------------
// Humor frequency calibration
// ---------------------------------------------------------------------------

/**
 * Decide whether to attempt humor on this turn based on calibration frequency.
 * Uses deterministic seeded decision based on turn number.
 */
export function shouldAttemptHumor(
  calibration: HumorCalibration,
  turnNumber: number,
  audience?: AudienceModel,
): boolean {
  // Base frequency from persona calibration
  let frequency = calibration.humorFrequency;

  // Modulate by audience receptivity
  if (audience) {
    const totalReactions =
      audience.reactions.positive + audience.reactions.negative + audience.reactions.neutral;
    // Only update frequency once we have enough signal (> 5 reactions)
    if (totalReactions > 5) {
      const positiveRate = audience.reactions.positive / totalReactions;
      // Blend persona frequency with observed audience preference (equal weight)
      frequency = frequency * 0.5 + positiveRate * 0.5;
    }
    frequency *= audience.humorReceptivity;
  }

  // Deterministic decision: Knuth multiplicative hash maps turn number to [0,1),
  // giving reproducible "randomness" without storing per-turn state.
  const KNUTH_HASH_MULTIPLIER = 2654435761;
  const UINT32_MAX_PLUS_ONE = 4294967296;
  const hash = ((turnNumber * KNUTH_HASH_MULTIPLIER) >>> 0) / UINT32_MAX_PLUS_ONE;
  return hash < frequency;
}

/**
 * Weight pattern selection based on persona's preferred patterns.
 */
export function weightPatternSelection(
  availablePatterns: number[],
  preferredPatterns: number[],
  baseWeight = 1.0,
  preferredBoost = 3.0,
): Map<number, number> {
  const weights = new Map<number, number>();
  for (const p of availablePatterns) {
    weights.set(p, preferredPatterns.includes(p) ? preferredBoost : baseWeight);
  }
  return weights;
}
