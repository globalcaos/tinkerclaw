/**
 * LIMBIC configuration constants — all tunable parameters from the plan.
 */

export const LIMBIC_CONFIG = {
	humorZone: {
		distanceMin: 0.6, // δ_min
		distanceMax: 0.95, // δ_max
		validityThreshold: 0.15, // τ_v
		surpriseThreshold: 0.3, // τ_σ
	},
	bridge: {
		surpriseK: 100, // k for reciprocal rank surprise
		candidateCount: 50, // LLM generation count
		minBridgeQuality: 0.1, // q_min for fallback trigger
	},
	staleness: {
		lambda: 0.3,
		mu: 0.001, // per hour
	},
	callback: {
		decayOnsetHours: 2160, // 3 months
		floorHours: 8760, // 1 year
		floorValue: 0.1,
	},
	sensitiveCategories: [
		"death",
		"grief",
		"terminal_illness",
		"suicide",
		"self_harm",
		"sexual_assault",
		"child_abuse",
		"domestic_violence",
		"racism",
		"genocide",
		"war_atrocity",
		"recent_tragedy",
	] as readonly string[],
} as const;
