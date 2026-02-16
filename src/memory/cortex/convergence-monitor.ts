/**
 * CORTEX Phase 5D: Convergence Monitoring
 *
 * Tracks θ_t (persona parameter vector) per turn.
 * Monitors variance of recent θ values and alerts when instability detected.
 *
 * θ_t represents the effective persona state at turn t, captured as a
 * combination of drift score, consistency metric, and E_φ distance.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThetaEntry {
	turnNumber: number;
	timestamp: string;
	driftScore: number; // EWMA drift score at this turn
	consistency: number; // C metric at this turn
	ePhiDistance: number; // distance from baseline E_φ
	theta: number; // combined θ_t = (1 - driftScore) * consistency * (1 - ePhiDistance)
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
	/** Divergence: θ drops below this for 3+ consecutive turns. */
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
 * Compute θ_t from its components.
 * θ_t = (1 - driftScore) * consistency * (1 - ePhiDistance)
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
 * Record a new θ_t entry and check for convergence issues.
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

	// Prune old entries
	if (state.entries.length > CONVERGENCE_CONFIG.maxHistory) {
		state.entries = state.entries.slice(-CONVERGENCE_CONFIG.maxHistory);
	}

	// Check for alerts
	checkConvergence(state);

	return entry;
}

/**
 * Compute variance of θ over the recent window.
 */
export function computeThetaVariance(entries: ThetaEntry[]): number {
	if (entries.length < 2) return 0;
	const window = entries.slice(-CONVERGENCE_CONFIG.windowSize);
	const thetas = window.map((e) => e.theta);
	const mean = thetas.reduce((a, b) => a + b, 0) / thetas.length;
	return thetas.reduce((sum, v) => sum + (v - mean) ** 2, 0) / thetas.length;
}

/**
 * Compute mean θ over the recent window.
 */
export function computeThetaMean(entries: ThetaEntry[]): number {
	if (entries.length === 0) return 1;
	const window = entries.slice(-CONVERGENCE_CONFIG.windowSize);
	return window.reduce((s, e) => s + e.theta, 0) / window.length;
}

/**
 * Check convergence and add alerts if issues detected.
 */
function checkConvergence(state: ConvergenceState): void {
	if (state.entries.length < CONVERGENCE_CONFIG.minEntries) return;

	const variance = computeThetaVariance(state.entries);
	const mean = computeThetaMean(state.entries);
	const lastTurn = state.entries[state.entries.length - 1].turnNumber;
	const now = new Date().toISOString();

	// High variance alert
	if (variance > CONVERGENCE_CONFIG.varianceThreshold) {
		// Check for oscillation: alternating high/low θ
		const recent = state.entries.slice(-6).map((e) => e.theta);
		const isOscillating =
			recent.length >= 4 &&
			recent.every(
				(v, i) => i === 0 || (v - recent[i - 1]) * ((recent[i - 1] - (recent[i - 2] ?? v)) || 1) < 0,
			);

		state.alerts.push({
			turnNumber: lastTurn,
			timestamp: now,
			type: isOscillating ? "oscillating" : "high_variance",
			message: isOscillating
				? `θ oscillating (var=${variance.toFixed(4)}, mean=${mean.toFixed(3)})`
				: `θ variance ${variance.toFixed(4)} exceeds threshold ${CONVERGENCE_CONFIG.varianceThreshold}`,
			variance,
			thetaMean: mean,
		});
	}

	// Divergence alert: θ below threshold for consecutive turns
	const tail = state.entries.slice(-CONVERGENCE_CONFIG.divergenceConsecutive);
	if (
		tail.length >= CONVERGENCE_CONFIG.divergenceConsecutive &&
		tail.every((e) => e.theta < CONVERGENCE_CONFIG.divergenceThreshold)
	) {
		// Only alert once per divergence episode
		const lastAlert = state.alerts.findLast((a) => a.type === "diverging");
		if (!lastAlert || lastAlert.turnNumber < tail[0].turnNumber) {
			state.alerts.push({
				turnNumber: lastTurn,
				timestamp: now,
				type: "diverging",
				message: `θ below ${CONVERGENCE_CONFIG.divergenceThreshold} for ${CONVERGENCE_CONFIG.divergenceConsecutive}+ turns (mean=${mean.toFixed(3)})`,
				variance,
				thetaMean: mean,
			});
		}
	}
}

/**
 * Get recent alerts (last N).
 */
export function getRecentAlerts(
	state: ConvergenceState,
	limit = 10,
): ConvergenceAlert[] {
	return state.alerts.slice(-limit);
}

/**
 * Get the latest θ value, or 1.0 if no entries.
 */
export function getLatestTheta(state: ConvergenceState): number {
	if (state.entries.length === 0) return 1.0;
	return state.entries[state.entries.length - 1].theta;
}
