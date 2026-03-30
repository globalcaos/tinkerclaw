/**
 * FORK: Convergence Monitoring (self-contained copy for extension).
 *
 * Tracks theta_t (persona parameter vector) per turn.
 * Monitors variance of recent theta values and alerts when instability detected.
 *
 * Adapted from src/memory/cortex/convergence-monitor.ts -- no external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThetaEntry {
  turnNumber: number;
  timestamp: string;
  driftScore: number; // EWMA drift score at this turn
  consistency: number; // C metric at this turn
  ePhiDistance: number; // distance from baseline E_phi
  theta: number; // combined theta_t = (1 - driftScore) * consistency * (1 - ePhiDistance)
}

export interface ConvergenceState {
  entries: ThetaEntry[];
  alerts: ConvergenceAlert[];
}

export interface ConvergenceAlert {
  turnNumber: number;
  timestamp: string;
  type: "high_variance" | "diverging" | "oscillating";
  message: string;
  variance: number;
  thetaMean: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const CONVERGENCE_CONFIG = {
  /** Window size for variance computation. */
  windowSize: 10,
  /** Variance threshold for alert. */
  varianceThreshold: 0.02,
  /** Minimum entries before alerting. */
  minEntries: 5,
  /** Max entries to retain (older entries pruned). */
  maxHistory: 200,
  /** Divergence: theta drops below this for 3+ consecutive turns. */
  divergenceThreshold: 0.5,
  /** Divergence: consecutive turns below threshold to trigger. */
  divergenceConsecutive: 3,
} as const;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Create a fresh convergence state.
 */
export function createConvergenceState(): ConvergenceState {
  return { entries: [], alerts: [] };
}

/**
 * Compute theta_t from its components.
 * theta_t = (1 - driftScore) * consistency * (1 - ePhiDistance)
 * Range: [0, 1] where 1 = perfect persona alignment.
 */
export function computeTheta(
  driftScore: number,
  consistency: number,
  ePhiDistance: number,
): number {
  return Math.max(0, Math.min(1, (1 - driftScore) * consistency * (1 - ePhiDistance)));
}

/**
 * Record a new theta_t entry and check for convergence issues.
 */
export function recordTheta(
  state: ConvergenceState,
  turnNumber: number,
  driftScore: number,
  consistency: number,
  ePhiDist: number,
): ThetaEntry {
  const theta = computeTheta(driftScore, consistency, ePhiDist);
  const entry: ThetaEntry = {
    turnNumber,
    timestamp: new Date().toISOString(),
    driftScore,
    consistency,
    ePhiDistance: ePhiDist,
    theta,
  };

  state.entries.push(entry);

  if (state.entries.length > CONVERGENCE_CONFIG.maxHistory) {
    state.entries = state.entries.slice(-CONVERGENCE_CONFIG.maxHistory);
  }

  checkConvergence(state);

  return entry;
}

/**
 * Compute variance of theta over the recent window.
 */
export function computeThetaVariance(entries: ThetaEntry[]): number {
  if (entries.length < 2) {
    return 0;
  }
  const window = entries.slice(-CONVERGENCE_CONFIG.windowSize);
  const thetas = window.map((e) => e.theta);
  const mean = thetas.reduce((a, b) => a + b, 0) / thetas.length;
  return thetas.reduce((sum, v) => sum + (v - mean) ** 2, 0) / thetas.length;
}

/**
 * Compute mean theta over the recent window.
 */
export function computeThetaMean(entries: ThetaEntry[]): number {
  if (entries.length === 0) {
    return 1;
  }
  const window = entries.slice(-CONVERGENCE_CONFIG.windowSize);
  return window.reduce((s, e) => s + e.theta, 0) / window.length;
}

/**
 * Check convergence and add alerts if issues detected.
 */
function checkConvergence(state: ConvergenceState): void {
  if (state.entries.length < CONVERGENCE_CONFIG.minEntries) {
    return;
  }

  const thetaVariance = computeThetaVariance(state.entries);
  const thetaMean = computeThetaMean(state.entries);
  const lastTurn = state.entries[state.entries.length - 1].turnNumber;
  const now = new Date().toISOString();

  if (thetaVariance > CONVERGENCE_CONFIG.varianceThreshold) {
    const recent = state.entries.slice(-6).map((e) => e.theta);
    const isOscillating =
      recent.length >= 4 &&
      recent.every(
        (v, i) => i === 0 || (v - recent[i - 1]) * (recent[i - 1] - (recent[i - 2] ?? v) || 1) < 0,
      );

    state.alerts.push({
      turnNumber: lastTurn,
      timestamp: now,
      type: isOscillating ? "oscillating" : "high_variance",
      message: isOscillating
        ? `theta oscillating (var=${thetaVariance.toFixed(4)}, mean=${thetaMean.toFixed(3)})`
        : `theta variance ${thetaVariance.toFixed(4)} exceeds threshold ${CONVERGENCE_CONFIG.varianceThreshold}`,
      variance: thetaVariance,
      thetaMean,
    });
  }

  const tail = state.entries.slice(-CONVERGENCE_CONFIG.divergenceConsecutive);
  if (
    tail.length >= CONVERGENCE_CONFIG.divergenceConsecutive &&
    tail.every((e) => e.theta < CONVERGENCE_CONFIG.divergenceThreshold)
  ) {
    const lastAlert = state.alerts.findLast((a) => a.type === "diverging");
    if (!lastAlert || lastAlert.turnNumber < tail[0].turnNumber) {
      state.alerts.push({
        turnNumber: lastTurn,
        timestamp: now,
        type: "diverging",
        message: `theta below ${CONVERGENCE_CONFIG.divergenceThreshold} for ${CONVERGENCE_CONFIG.divergenceConsecutive}+ turns (mean=${thetaMean.toFixed(3)})`,
        variance: thetaVariance,
        thetaMean,
      });
    }
  }
}

/**
 * Get recent alerts (last N).
 */
export function getRecentAlerts(state: ConvergenceState, limit = 10): ConvergenceAlert[] {
  return state.alerts.slice(-limit);
}

/**
 * Get the latest theta value, or 1.0 if no entries.
 */
export function getLatestTheta(state: ConvergenceState): number {
  if (state.entries.length === 0) {
    return 1.0;
  }
  return state.entries[state.entries.length - 1].theta;
}
