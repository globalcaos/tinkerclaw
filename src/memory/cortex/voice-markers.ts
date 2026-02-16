/**
 * CORTEX Phase 4C: Voice markers & E_φ computation.
 *
 * TypeScript port of CORTEX Appendix B.
 * E_φ = [Component A (8 linguistic features) ‖ Component B (128-dim style embedding)]
 * Total: 136-dimensional persona fingerprint vector.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const E_PHI_DIMENSIONS = 136;
export const LINGUISTIC_FEATURES = 8;
export const STYLE_EMBEDDING_DIM = 128;

/** Hedging markers (CORTEX Appendix B, Table 3). */
export const HEDGING_MARKERS = new Set([
	"perhaps",
	"maybe",
	"i think",
	"arguably",
	"it seems",
	"might",
	"could be",
	"not entirely sure",
	"possibly",
	"i believe",
	"in my opinion",
	"it appears",
	"seemingly",
]);

/** First-person pronouns. */
const FIRST_PERSON = new Set(["i", "my", "me", "mine", "myself"]);

/**
 * Formal POS proxies — Heylighen-Dewaele F-score approximation.
 * Formal: nouns, adjectives, prepositions, articles.
 * Informal: pronouns, verbs, adverbs, interjections.
 * We approximate with word lists since we don't have a POS tagger.
 */
const FORMAL_MARKERS = new Set([
	// common prepositions
	"of", "in", "to", "for", "with", "on", "at", "by", "from", "about",
	"between", "through", "during", "regarding", "concerning", "upon",
	// articles
	"the", "a", "an",
	// formal conjunctions
	"however", "therefore", "furthermore", "moreover", "nevertheless",
	"consequently", "accordingly", "hence", "thus", "whereas",
]);

const INFORMAL_MARKERS = new Set([
	// interjections
	"oh", "wow", "haha", "lol", "heh", "hmm", "ugh", "yep", "nope",
	"yeah", "okay", "ok", "sure", "hey", "hi", "yo", "well",
	// contractions (detected separately)
	"gonna", "wanna", "gotta", "kinda", "sorta", "dunno",
]);

/**
 * Technical density markers — domain-specific or technical vocabulary.
 */
const TECHNICAL_MARKERS = new Set([
	"algorithm", "function", "parameter", "variable", "array", "object",
	"interface", "implementation", "configuration", "dependency", "module",
	"component", "instance", "abstract", "protocol", "schema", "query",
	"mutation", "endpoint", "middleware", "async", "await", "callback",
	"iterator", "recursive", "polymorphism", "encapsulation", "api",
	"database", "server", "client", "request", "response", "pipeline",
	"optimization", "latency", "throughput", "bandwidth", "cache",
	"framework", "library", "runtime", "compiler", "parser", "token",
	"embedding", "vector", "matrix", "tensor", "gradient", "hypothesis",
	"coefficient", "regression", "variance", "correlation", "distribution",
]);

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Split text into sentences (period, !, ?, or newlines followed by caps). */
export function splitSentences(text: string): string[] {
	if (!text.trim()) return [];
	// Split on sentence-ending punctuation followed by space or end
	const raw = text.split(/(?<=[.!?])\s+|(?<=\n)\s*/);
	return raw.filter((s) => s.trim().length > 0);
}

/** Arithmetic mean. */
function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Standard deviation (population). */
function std(values: number[]): number {
	if (values.length <= 1) return 0;
	const m = mean(values);
	const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
	return Math.sqrt(variance);
}

/** L2 normalize a vector. Returns zero vector if norm is 0. */
function l2Normalize(vec: Float64Array): Float64Array {
	let norm = 0;
	for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
	norm = Math.sqrt(norm);
	if (norm === 0) return new Float64Array(vec.length);
	const result = new Float64Array(vec.length);
	for (let i = 0; i < vec.length; i++) result[i] = vec[i] / norm;
	return result;
}

// ---------------------------------------------------------------------------
// Feature computation
// ---------------------------------------------------------------------------

/**
 * Compute Heylighen-Dewaele formality score approximation.
 * F = (formal_count - informal_count + n) / (2n) * 100
 * Range: 0–100, higher = more formal.
 */
export function computeFormality(words: string[]): number {
	if (words.length === 0) return 50;
	let formal = 0;
	let informal = 0;
	for (const w of words) {
		if (FORMAL_MARKERS.has(w)) formal++;
		if (INFORMAL_MARKERS.has(w)) informal++;
	}
	// Also count contractions as informal
	for (const w of words) {
		if (w.includes("'") && w.length > 2) informal++;
	}
	const n = words.length;
	return ((formal - informal + n) / (2 * n)) * 100;
}

/**
 * Compute technical vocabulary density.
 * Fraction of words that are technical terms.
 */
export function computeTechnicalDensity(words: string[]): number {
	if (words.length === 0) return 0;
	let count = 0;
	for (const w of words) {
		if (TECHNICAL_MARKERS.has(w)) count++;
	}
	return count / words.length;
}

/**
 * Count hedging markers in text (phrase-level matching).
 * Returns count of hedge instances found.
 */
export function countHedges(text: string): number {
	const lower = text.toLowerCase();
	let count = 0;
	for (const marker of HEDGING_MARKERS) {
		// Count non-overlapping occurrences
		let idx = 0;
		while (true) {
			const found = lower.indexOf(marker, idx);
			if (found === -1) break;
			count++;
			idx = found + marker.length;
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Component A: 8 linguistic features
// ---------------------------------------------------------------------------

export interface LinguisticFeatures {
	meanSentenceLength: number;
	sentenceLengthStd: number;
	typeTokenRatio: number;
	hedgingFrequency: number;
	formality: number;
	firstPersonRate: number;
	questionFrequency: number;
	technicalDensity: number;
}

/**
 * Extract 8 measurable linguistic features from text.
 */
export function extractLinguisticFeatures(text: string): LinguisticFeatures {
	const sentences = splitSentences(text);
	const words = text.toLowerCase().split(/\s+/).filter(Boolean);
	const nWords = words.length || 1;
	const nSentences = sentences.length || 1;

	const sentLengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);

	return {
		meanSentenceLength: mean(sentLengths),
		sentenceLengthStd: std(sentLengths),
		typeTokenRatio: new Set(words).size / nWords,
		hedgingFrequency: countHedges(text) / nSentences,
		formality: computeFormality(words),
		firstPersonRate: words.filter((w) => FIRST_PERSON.has(w)).length / nWords,
		questionFrequency:
			sentences.filter((s) => s.trim().endsWith("?")).length / nSentences,
		technicalDensity: computeTechnicalDensity(words),
	};
}

/**
 * Pack linguistic features into a Float64Array (Component A of E_φ).
 */
export function linguisticFeaturesToVector(features: LinguisticFeatures): Float64Array {
	return new Float64Array([
		features.meanSentenceLength,
		features.sentenceLengthStd,
		features.typeTokenRatio,
		features.hedgingFrequency,
		features.formality,
		features.firstPersonRate,
		features.questionFrequency,
		features.technicalDensity,
	]);
}

// ---------------------------------------------------------------------------
// Component B: 128-dim style embedding (placeholder using ENGRAM embedding cache)
// ---------------------------------------------------------------------------

export type EmbedFn = (text: string) => number[] | Float32Array;

/**
 * Compute Component B — style embedding projection.
 *
 * Takes the opening + closing sentences, embeds them, and projects to 128 dims.
 * If no embed function provided, returns zero vector (placeholder).
 */
export function computeStyleEmbedding(
	text: string,
	embedFn?: EmbedFn,
): Float64Array {
	if (!embedFn) {
		return new Float64Array(STYLE_EMBEDDING_DIM);
	}

	const sentences = splitSentences(text);
	const openingClosing =
		sentences.length > 1
			? `${sentences[0]} ${sentences[sentences.length - 1]}`
			: sentences[0] || text;

	const rawEmb = embedFn(openingClosing);
	const arr = rawEmb instanceof Float32Array ? Array.from(rawEmb) : rawEmb;

	// Project to 128 dims (truncate or pad)
	const result = new Float64Array(STYLE_EMBEDDING_DIM);
	for (let i = 0; i < Math.min(arr.length, STYLE_EMBEDDING_DIM); i++) {
		result[i] = arr[i];
	}
	return result;
}

// ---------------------------------------------------------------------------
// Combined E_φ
// ---------------------------------------------------------------------------

/**
 * Compute E_φ — the full 136-dimensional persona fingerprint.
 *
 * E_φ = [normalize(Component A) ‖ normalize(Component B)]
 *
 * @param text - Text to analyze (typically an agent response)
 * @param embedFn - Optional embedding function (from ENGRAM embedding cache)
 * @returns 136-dimensional Float64Array
 */
export function computeEPhi(text: string, embedFn?: EmbedFn): Float64Array {
	const features = extractLinguisticFeatures(text);
	const componentA = linguisticFeaturesToVector(features);
	const componentB = computeStyleEmbedding(text, embedFn);

	const normA = l2Normalize(componentA);
	const normB = l2Normalize(componentB);

	const result = new Float64Array(E_PHI_DIMENSIONS);
	result.set(normA, 0);
	result.set(normB, LINGUISTIC_FEATURES);
	return result;
}

// ---------------------------------------------------------------------------
// Distance / similarity
// ---------------------------------------------------------------------------

/** Cosine distance between two E_φ vectors. Range [0, 2]. */
export function ePhiDistance(a: Float64Array, b: Float64Array): number {
	if (a.length !== b.length || a.length !== E_PHI_DIMENSIONS) {
		throw new Error(`E_φ dimension mismatch: expected ${E_PHI_DIMENSIONS}, got ${a.length}, ${b.length}`);
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) return 1; // orthogonal if either is zero
	return 1 - dot / denom;
}

/**
 * Compute E_φ baseline fingerprint from multiple text samples.
 * Returns the mean E_φ vector.
 */
export function computeBaselineEPhi(
	samples: string[],
	embedFn?: EmbedFn,
): Float64Array {
	if (samples.length === 0) return new Float64Array(E_PHI_DIMENSIONS);

	const vectors = samples.map((s) => computeEPhi(s, embedFn));
	const result = new Float64Array(E_PHI_DIMENSIONS);

	for (const vec of vectors) {
		for (let i = 0; i < E_PHI_DIMENSIONS; i++) {
			result[i] += vec[i];
		}
	}

	for (let i = 0; i < E_PHI_DIMENSIONS; i++) {
		result[i] /= samples.length;
	}

	return result;
}
