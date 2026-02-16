/**
 * ENGRAM Phase 1A: Core event store.
 * Append-only JSONL storage for memory events.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MemoryEvent, EventKind, EventMetadata } from "./event-types.js";

// ULID-like ID generator (time-sortable, monotonic within ms)
let lastTime = 0;
let lastSeq = 0;
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time: number, len: number): string {
	let str = "";
	let t = time;
	for (let i = len; i > 0; i--) {
		const mod = t % 32;
		str = ENCODING[mod] + str;
		t = Math.floor(t / 32);
	}
	return str;
}

function randomPart(len: number): string {
	let str = "";
	for (let i = 0; i < len; i++) {
		str += ENCODING[Math.floor(Math.random() * 32)];
	}
	return str;
}

export function generateULID(): string {
	const now = Date.now();
	if (now === lastTime) {
		lastSeq++;
	} else {
		lastTime = now;
		lastSeq = 0;
	}
	// 10 chars time + 2 chars seq + 4 chars random (seq before random for monotonicity)
	const timePart = encodeTime(now, 10);
	const seqPart = encodeTime(lastSeq, 4);
	const randPart = randomPart(2);
	return timePart + seqPart + randPart;
}

/**
 * Simple token estimator (~4 chars per token for English text).
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export interface EventStoreOptions {
	baseDir: string;
	sessionKey: string;
}

export interface EventStore {
	append(event: Omit<MemoryEvent, "id" | "timestamp">): MemoryEvent;
	appendRaw(event: MemoryEvent): void;
	readAll(): MemoryEvent[];
	readByKind(kind: EventKind): MemoryEvent[];
	readRange(startTurnId: number, endTurnId: number): MemoryEvent[];
	readById(id: string): MemoryEvent | undefined;
	count(): number;
	readonly filePath: string;
	readonly sessionKey: string;
}

function eventFilePath(baseDir: string, sessionKey: string): string {
	return join(baseDir, "events", `${sessionKey}.jsonl`);
}

export function createEventStore(options: EventStoreOptions): EventStore {
	const filePath = eventFilePath(options.baseDir, options.sessionKey);
	mkdirSync(dirname(filePath), { recursive: true });

	// In-memory index for fast lookups
	let cache: MemoryEvent[] | null = null;

	function loadCache(): MemoryEvent[] {
		if (cache) {return cache;}
		if (!existsSync(filePath)) {
			cache = [];
			return cache;
		}
		const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
		cache = lines.map((l) => JSON.parse(l) as MemoryEvent);
		return cache;
	}

	function invalidateCache(): void {
		cache = null;
	}

	return {
		filePath,
		sessionKey: options.sessionKey,

		append(partial: Omit<MemoryEvent, "id" | "timestamp">): MemoryEvent {
			const event: MemoryEvent = {
				id: generateULID(),
				timestamp: new Date().toISOString(),
				...partial,
			};
			appendFileSync(filePath, JSON.stringify(event) + "\n");
			if (cache) {cache.push(event);}
			return event;
		},

		appendRaw(event: MemoryEvent): void {
			appendFileSync(filePath, JSON.stringify(event) + "\n");
			if (cache) {cache.push(event);}
		},

		readAll(): MemoryEvent[] {
			return [...loadCache()];
		},

		readByKind(kind: EventKind): MemoryEvent[] {
			return loadCache().filter((e) => e.kind === kind);
		},

		readRange(startTurnId: number, endTurnId: number): MemoryEvent[] {
			return loadCache().filter((e) => e.turnId >= startTurnId && e.turnId <= endTurnId);
		},

		readById(id: string): MemoryEvent | undefined {
			return loadCache().find((e) => e.id === id);
		},

		count(): number {
			return loadCache().length;
		},
	};
}
