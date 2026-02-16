/**
 * ENGRAM Phase 2A: Embedding cache.
 * Persists embeddings alongside events as Float32Array binary files.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface EmbeddingCache {
	get(eventId: string): Float32Array | null;
	set(eventId: string, embedding: Float32Array): void;
	has(eventId: string): boolean;
	readonly dimensions: number;
}

function embeddingPath(baseDir: string, eventId: string): string {
	return join(baseDir, "embeddings", `${eventId}.vec`);
}

export function createEmbeddingCache(baseDir: string, dimensions: number = 768): EmbeddingCache {
	const embDir = join(baseDir, "embeddings");
	mkdirSync(embDir, { recursive: true });

	// In-memory LRU to avoid repeated disk reads
	const memCache = new Map<string, Float32Array>();
	const MAX_MEM_CACHE = 2000;

	return {
		dimensions,

		get(eventId: string): Float32Array | null {
			const cached = memCache.get(eventId);
			if (cached) return cached;

			const path = embeddingPath(baseDir, eventId);
			if (!existsSync(path)) return null;

			const buf = readFileSync(path);
			const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
			if (arr.length !== dimensions) return null;

			// Add to mem cache
			if (memCache.size >= MAX_MEM_CACHE) {
				const first = memCache.keys().next().value;
				if (first) memCache.delete(first);
			}
			memCache.set(eventId, arr);
			return arr;
		},

		set(eventId: string, embedding: Float32Array): void {
			if (embedding.length !== dimensions) {
				throw new Error(`Embedding dimension mismatch: expected ${dimensions}, got ${embedding.length}`);
			}
			const path = embeddingPath(baseDir, eventId);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));

			if (memCache.size >= MAX_MEM_CACHE) {
				const first = memCache.keys().next().value;
				if (first) memCache.delete(first);
			}
			memCache.set(eventId, embedding);
		},

		has(eventId: string): boolean {
			if (memCache.has(eventId)) return true;
			return existsSync(embeddingPath(baseDir, eventId));
		},
	};
}
