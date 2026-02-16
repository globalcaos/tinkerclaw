/**
 * ENGRAM Phase 2A: Async embedding pipeline.
 * Background worker that batches events for embedding generation.
 */

import type { MemoryEvent } from "./event-types.js";
import type { EventStore } from "./event-store.js";
import type { EmbeddingCache } from "./embedding-cache.js";

/** Function signature for the embedding API call. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface EmbeddingWorkerOptions {
	embedFn: EmbedFn;
	cache: EmbeddingCache;
	batchSize?: number;
	batchTimeoutMs?: number;
	onError?: (error: Error, eventIds: string[]) => void;
}

export interface EmbeddingWorker {
	/** Queue an event for embedding. */
	enqueue(event: MemoryEvent): void;
	/** Queue multiple events. */
	enqueueMany(events: MemoryEvent[]): void;
	/** Flush the current batch immediately. */
	flush(): Promise<void>;
	/** Stop the worker and flush remaining. */
	stop(): Promise<void>;
	/** Number of events waiting in queue. */
	pendingCount(): number;
	/** Total events processed. */
	processedCount(): number;
	/** Total API calls made. */
	batchCallCount(): number;
}

export function createEmbeddingWorker(options: EmbeddingWorkerOptions): EmbeddingWorker {
	const {
		embedFn,
		cache,
		batchSize = 32,
		batchTimeoutMs = 5000,
		onError,
	} = options;

	const queue: MemoryEvent[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	let processing = false;
	let processed = 0;
	let batchCalls = 0;
	let stopped = false;
	let flushResolvers: Array<() => void> = [];

	async function processBatch(): Promise<void> {
		if (processing || queue.length === 0) return;
		processing = true;

		// Take up to batchSize from queue
		const batch = queue.splice(0, batchSize);
		// Filter already-cached
		const toEmbed = batch.filter((e) => !cache.has(e.id));

		if (toEmbed.length > 0) {
			try {
				const texts = toEmbed.map((e) => e.content);
				const embeddings = await embedFn(texts);
				batchCalls++;

				for (let i = 0; i < toEmbed.length; i++) {
					cache.set(toEmbed[i].id, embeddings[i]);
				}
				processed += toEmbed.length;
			} catch (err) {
				onError?.(err as Error, toEmbed.map((e) => e.id));
			}
		} else {
			processed += batch.length; // all were cached
		}

		processing = false;

		// Resolve any pending flush promises
		const resolvers = flushResolvers;
		flushResolvers = [];
		for (const r of resolvers) r();

		// Continue if more in queue
		if (queue.length >= batchSize) {
			void processBatch();
		} else if (queue.length > 0 && !stopped) {
			scheduleFlush();
		}
	}

	function scheduleFlush(): void {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void processBatch();
		}, batchTimeoutMs);
	}

	return {
		enqueue(event: MemoryEvent): void {
			if (stopped) return;
			if (cache.has(event.id)) return; // skip already embedded
			queue.push(event);
			if (queue.length >= batchSize) {
				void processBatch();
			} else if (!timer) {
				scheduleFlush();
			}
		},

		enqueueMany(events: MemoryEvent[]): void {
			for (const e of events) this.enqueue(e);
		},

		async flush(): Promise<void> {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (queue.length === 0 && !processing) return;
			// If currently processing, wait for it
			if (processing) {
				await new Promise<void>((resolve) => flushResolvers.push(resolve));
			}
			// Process remaining
			while (queue.length > 0) {
				await processBatch();
				if (processing) {
					await new Promise<void>((resolve) => flushResolvers.push(resolve));
				}
			}
		},

		async stop(): Promise<void> {
			stopped = true;
			await this.flush();
		},

		pendingCount(): number {
			return queue.length;
		},

		processedCount(): number {
			return processed;
		},

		batchCallCount(): number {
			return batchCalls;
		},
	};
}
