/**
 * SYNAPSE Phase 7A: Cognitive Diversity Index (CDI) measurement.
 * Measures error correlation across model providers to quantify ensemble diversity.
 * Reference: SYNAPSE §3
 */

export interface CDIMeasurement {
	modelSet: string[];
	benchmark: string;
	errorProfiles: Record<string, boolean[]>; // model → binary error vector
	pairwiseCorrelations: Record<string, number>; // "modelA-modelB" → Pearson r
	cdi: number;
	confidenceInterval: [number, number]; // 95% CI
	timestamp: string;
}

export interface ProviderProfile {
	modelId: string;
	role: string;
	strengths: string[];
	weaknesses: string[];
	avgLatencyMs: number;
	costPer1kInput: number;
	costPer1kOutput: number;
	errorProfile?: boolean[];
}

/**
 * Pearson correlation coefficient between two binary vectors.
 */
export function pearsonCorrelation(a: boolean[], b: boolean[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	const n = a.length;
	const meanA = a.filter(Boolean).length / n;
	const meanB = b.filter(Boolean).length / n;

	let num = 0;
	let denomA = 0;
	let denomB = 0;

	for (let i = 0; i < n; i++) {
		const da = (a[i] ? 1 : 0) - meanA;
		const db = (b[i] ? 1 : 0) - meanB;
		num += da * db;
		denomA += da * da;
		denomB += db * db;
	}

	const denom = Math.sqrt(denomA * denomB);
	if (denom === 0) return 0;
	return num / denom;
}

/**
 * Fisher z-transform for correlation confidence intervals.
 */
function fisherZ(r: number): number {
	const clamped = Math.max(-0.9999, Math.min(0.9999, r));
	return 0.5 * Math.log((1 + clamped) / (1 - clamped));
}

function inverseFisherZ(z: number): number {
	return (Math.exp(2 * z) - 1) / (Math.exp(2 * z) + 1);
}

/**
 * Compute 95% confidence interval for a correlation using Fisher z-transform.
 */
export function correlationCI(r: number, n: number): [number, number] {
	if (n < 4) return [-1, 1];
	const z = fisherZ(r);
	const se = 1 / Math.sqrt(n - 3);
	const z196 = 1.96;
	return [inverseFisherZ(z - z196 * se), inverseFisherZ(z + z196 * se)];
}

/**
 * Measure CDI from error profiles across models.
 * CDI = 1 - mean(pairwise correlations)
 * CDI = 0: identical errors (no diversity)
 * CDI = 1: uncorrelated errors (maximum useful diversity)
 * CDI > 1: anti-correlated errors (complementary strengths)
 */
export function measureCDI(errorProfiles: Record<string, boolean[]>, benchmark = "default"): CDIMeasurement {
	const models = Object.keys(errorProfiles);
	const n = models.length;
	const pairwiseCorrelations: Record<string, number> = {};
	let sumCorrelation = 0;
	let pairs = 0;

	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const r = pearsonCorrelation(errorProfiles[models[i]], errorProfiles[models[j]]);
			const key = `${models[i]}-${models[j]}`;
			pairwiseCorrelations[key] = r;
			sumCorrelation += r;
			pairs++;
		}
	}

	const meanCorrelation = pairs > 0 ? sumCorrelation / pairs : 0;
	const cdi = 1 - meanCorrelation;

	// Compute CI from the mean correlation's CI
	const sampleSize = errorProfiles[models[0]]?.length ?? 0;
	const [ciLow, ciHigh] = correlationCI(meanCorrelation, sampleSize);

	return {
		modelSet: models,
		benchmark,
		errorProfiles,
		pairwiseCorrelations,
		cdi,
		confidenceInterval: [1 - ciHigh, 1 - ciLow], // invert for CDI
		timestamp: new Date().toISOString(),
	};
}

/**
 * Default provider profiles with role affinities and cost data.
 */
export const DEFAULT_PROVIDER_PROFILES: ProviderProfile[] = [
	{
		modelId: "claude-opus",
		role: "architect",
		strengths: ["reasoning", "nuance", "safety"],
		weaknesses: ["speed", "cost"],
		avgLatencyMs: 8000,
		costPer1kInput: 0.015,
		costPer1kOutput: 0.075,
	},
	{
		modelId: "gpt-o3",
		role: "critic",
		strengths: ["analysis", "edge-cases", "formal-logic"],
		weaknesses: ["verbosity"],
		avgLatencyMs: 5000,
		costPer1kInput: 0.01,
		costPer1kOutput: 0.04,
	},
	{
		modelId: "gemini-pro",
		role: "pragmatist",
		strengths: ["speed", "multimodal", "cost-efficiency"],
		weaknesses: ["safety-nuance"],
		avgLatencyMs: 3000,
		costPer1kInput: 0.00125,
		costPer1kOutput: 0.005,
	},
	{
		modelId: "deepseek-r1",
		role: "researcher",
		strengths: ["math", "code", "chain-of-thought"],
		weaknesses: ["instruction-following"],
		avgLatencyMs: 6000,
		costPer1kInput: 0.0014,
		costPer1kOutput: 0.0028,
	},
	{
		modelId: "claude-sonnet",
		role: "synthesizer",
		strengths: ["balance", "synthesis", "instruction-following"],
		weaknesses: ["depth-on-niche"],
		avgLatencyMs: 3000,
		costPer1kInput: 0.003,
		costPer1kOutput: 0.015,
	},
];

/**
 * Select optimal model subset for a debate based on CDI and budget.
 */
export function selectModelsForDebate(
	profiles: ProviderProfile[],
	cdiMeasurement?: CDIMeasurement,
	budgetUsd?: number,
): ProviderProfile[] {
	if (profiles.length <= 2) return profiles;

	// Without CDI data, return top 3 by role diversity
	if (!cdiMeasurement) {
		const roles = new Set<string>();
		const selected: ProviderProfile[] = [];
		for (const p of profiles) {
			if (!roles.has(p.role)) {
				roles.add(p.role);
				selected.push(p);
				if (selected.length >= 3) break;
			}
		}
		return selected;
	}

	// With CDI data, prefer models with lowest pairwise correlation
	const sorted = [...profiles].sort((a, b) => {
		const keyA = Object.keys(cdiMeasurement.pairwiseCorrelations).filter((k) => k.includes(a.modelId));
		const keyB = Object.keys(cdiMeasurement.pairwiseCorrelations).filter((k) => k.includes(b.modelId));
		const avgA = keyA.length > 0 ? keyA.reduce((s, k) => s + cdiMeasurement.pairwiseCorrelations[k], 0) / keyA.length : 0;
		const avgB = keyB.length > 0 ? keyB.reduce((s, k) => s + cdiMeasurement.pairwiseCorrelations[k], 0) / keyB.length : 0;
		return avgA - avgB; // lower correlation = more diverse = preferred
	});

	return sorted.slice(0, Math.min(3, sorted.length));
}
