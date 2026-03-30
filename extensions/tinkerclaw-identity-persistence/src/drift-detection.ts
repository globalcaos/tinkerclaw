/**
 * FORK: Drift Score & EWMA (self-contained copy for extension).
 *
 * Two-signal drift detection: user corrections (S_u) + probe results (S_p).
 * DriftScore = w_u * S_u + w_p * S_p, smoothed with EWMA (alpha=0.3).
 * Adaptive Bayesian fallback: when user corrections are sparse, probe weight
 * increases to compensate.
 *
 * Adapted from src/memory/cortex/drift-detection.ts.
 */

import type { ProbeResult } from "./behavioral-probes.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DRIFT_CONFIG = {
  baseWeightUser: 0.7, // w_u
  baseWeightProbe: 0.3, // w_p
  ewmaAlpha: 0.3, // alpha -- smoothing factor
  sparsityThreshold: 0.05, // lambda_min -- below this, boost probe weight
  maxProbeBoost: 0.3, // delta -- max additional probe weight
  correctionWindowSize: 20, // sliding window for user correction density
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftState {
  ewmaScore: number; // current EWMA-smoothed drift score
  history: DriftScore[]; // time series of raw drift scores
  userCorrectionWindow: boolean[]; // last N turns: was there a correction?
}

export interface DriftScore {
  turnNumber: number;
  timestamp: string;
  rawScore: number; // before EWMA
  ewmaScore: number; // after EWMA
  Su: number; // user signal
  Sp: number; // probe signal
  wu: number; // effective user weight
  wp: number; // effective probe weight
  userDensity: number; // lambda_u
}

// ---------------------------------------------------------------------------
// User correction detection
// ---------------------------------------------------------------------------

const CORRECTION_PATTERNS = [
  /don'?t be so (formal|casual|verbose|brief|wordy|terse)/i,
  /you (usually|normally|always|typically) /i,
  /that'?s not (like you|how you|your style)/i,
  /stop (being|acting|sounding|talking)/i,
  /be more (like|natural|yourself|concise|detailed)/i,
  /too (formal|casual|verbose|brief|wordy|long|short)/i,
  /can you (tone down|dial back|cut|reduce|increase)/i,
  /less (formal|casual|verbose|wordy)/i,
  /more (formal|casual|concise|detailed|natural)/i,
  /that doesn'?t sound like you/i,
  /go back to (your|the) (normal|usual|regular)/i,
];

/**
 * Detect explicit user corrections in a message.
 * Returns the regex source strings of matched patterns.
 */
export function detectUserCorrections(message: string): string[] {
  return CORRECTION_PATTERNS.filter((p) => p.test(message)).map((p) => p.source);
}

// ---------------------------------------------------------------------------
// Probe signal aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate probe results into a single drift signal S_p in [0, 1].
 * 0 = perfect compliance, 1 = maximum drift.
 */
export function aggregateProbeScores(probes: ProbeResult[]): number {
  if (probes.length === 0) {
    return 0;
  }

  let totalDrift = 0;
  let count = 0;

  for (const probe of probes) {
    const scores = Object.values(probe.scores);
    for (const score of scores) {
      totalDrift += 1 - score;
      count++;
    }
    totalDrift += probe.violations.length * 0.2;
  }

  return count > 0 ? Math.min(1, totalDrift / count) : 0;
}

// ---------------------------------------------------------------------------
// Adaptive weight computation
// ---------------------------------------------------------------------------

/**
 * Compute effective weights (w_u, w_p) based on user correction density.
 */
export function computeAdaptiveWeights(userDensity: number): { wu: number; wp: number } {
  let wu = DRIFT_CONFIG.baseWeightUser;
  let wp = DRIFT_CONFIG.baseWeightProbe;

  if (userDensity < DRIFT_CONFIG.sparsityThreshold) {
    const sparsityRatio =
      DRIFT_CONFIG.sparsityThreshold > 0 ? 1.0 - userDensity / DRIFT_CONFIG.sparsityThreshold : 1.0;
    wp = wp + sparsityRatio * DRIFT_CONFIG.maxProbeBoost;
    wu = 1.0 - wp;
  }

  return { wu, wp };
}

// ---------------------------------------------------------------------------
// Core drift computation
// ---------------------------------------------------------------------------

/**
 * Create a fresh drift state.
 */
export function createDriftState(): DriftState {
  return {
    ewmaScore: 0,
    history: [],
    userCorrectionWindow: [],
  };
}

/**
 * Compute drift score for the current turn and update state.
 */
export function computeDriftScore(
  userMessage: string,
  probeResults: ProbeResult[],
  state: DriftState,
  turnNumber: number,
): DriftScore {
  const corrections = detectUserCorrections(userMessage);
  const Su = corrections.length > 0 ? 1.0 : 0.0;

  state.userCorrectionWindow.push(Su > 0);
  if (state.userCorrectionWindow.length > DRIFT_CONFIG.correctionWindowSize) {
    state.userCorrectionWindow.shift();
  }

  const userDensity =
    state.userCorrectionWindow.length > 0
      ? state.userCorrectionWindow.filter(Boolean).length / state.userCorrectionWindow.length
      : 0;

  const Sp = aggregateProbeScores(probeResults);
  const { wu, wp } = computeAdaptiveWeights(userDensity);
  const rawScore = wu * Su + wp * Sp;

  const ewmaScore =
    DRIFT_CONFIG.ewmaAlpha * rawScore + (1 - DRIFT_CONFIG.ewmaAlpha) * state.ewmaScore;

  state.ewmaScore = ewmaScore;

  const entry: DriftScore = {
    turnNumber,
    timestamp: new Date().toISOString(),
    rawScore,
    ewmaScore,
    Su,
    Sp,
    wu,
    wp,
    userDensity,
  };

  state.history.push(entry);
  return entry;
}
