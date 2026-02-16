/**
 * Vector math utilities for LIMBIC humor computations.
 * Cosine similarity/distance, vector mean, normalization.
 */

export function dotProduct(a: number[], b: number[]): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

export function magnitude(v: number[]): number {
	let sum = 0;
	for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
	return Math.sqrt(sum);
}

export function cosineSimilarity(a: number[], b: number[]): number {
	const magA = magnitude(a);
	const magB = magnitude(b);
	if (magA === 0 || magB === 0) return 0;
	return dotProduct(a, b) / (magA * magB);
}

export function cosineDistance(a: number[], b: number[]): number {
	return 1 - cosineSimilarity(a, b);
}

export function vectorMean(a: number[], b: number[]): number[] {
	const result: number[] = new Array(a.length);
	for (let i = 0; i < a.length; i++) result[i] = (a[i] + b[i]) / 2;
	return result;
}

export function vectorAdd(a: number[], b: number[]): number[] {
	const result: number[] = new Array(a.length);
	for (let i = 0; i < a.length; i++) result[i] = a[i] + b[i];
	return result;
}

export function vectorSub(a: number[], b: number[]): number[] {
	const result: number[] = new Array(a.length);
	for (let i = 0; i < a.length; i++) result[i] = a[i] - b[i];
	return result;
}

export function normalize(v: number[]): number[] {
	const mag = magnitude(v);
	if (mag === 0) return v.slice();
	return v.map((x) => x / mag);
}
