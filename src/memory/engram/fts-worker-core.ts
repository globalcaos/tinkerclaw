/**
 * FORK 2026-09-23 (plan task 16) — the worker-thread half of the off-thread FTS, and the protocol
 * both halves speak.
 *
 * After task 14 one background pack refresh still cost 3.6-7.1 s of main-thread CPU on a copy of
 * the live cc-experience store, all of it in the FTS scan. The scan is pure CPU over data that
 * already sits in a file, so the worker reads that file ITSELF instead of receiving the events
 * over postMessage (~70M chars for cc-experience), and keeps them parsed between requests.
 *
 * EXACT PARITY WITH THE IN-THREAD SEARCH. The scan below is `ftsSearch` itself, imported, not a
 * copy. The worker searches exactly the first `count` events of the file — the main store's
 * snapshot length — and only after checking that those events are the main store's events, via
 * a fingerprint over (id, content length) of each. An event store is append-only (`append` writes
 * the line, THEN pushes to the cache), so the main snapshot is a prefix of the file's complete
 * lines; if it is not, the file is read once more from byte 0, and if it still is not, the
 * request is refused with `kind: "view"` and the caller searches in-thread. Lines are parsed
 * exactly as `createEventStore`'s `loadCache` parses them.
 *
 * This module holds no worker plumbing, so the tests can drive it in-thread.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { EventStore } from "./event-store.js";
import type { EventKind, MemoryEvent } from "./event-types.js";
import { ftsSearch, type SearchFilters } from "./search-index.js";

// ─── protocol ────────────────────────────────────────────────────────────────

/** Everything is structured-cloneable: no event objects cross the port in either direction. */
export interface FtsWorkerRequest {
  id: number;
  filePath: string;
  query: string;
  topN: number;
  filters?: SearchFilters;
  /** The main store's snapshot length: the worker searches exactly this prefix of the file. */
  count: number;
  /** `fingerprintEvents(mainSnapshot)`, checked against the same prefix of the file. */
  fingerprint: number;
}

/** A ranked hit: `pos` indexes the main snapshot; `id` lets the main thread verify the mapping. */
export interface FtsWorkerHit {
  pos: number;
  id: string;
  score: number;
}

export interface FtsWorkerCorpusStats {
  /** Complete lines parsed from the file so far. */
  events: number;
  /** How many times this worker has read the file from byte 0 (1 = only ever tail-read since). */
  loads: number;
}

export type FtsWorkerResponse =
  | { id: number; ok: true; hits: FtsWorkerHit[]; corpus: FtsWorkerCorpusStats }
  | {
      id: number;
      ok: false;
      /** view: the file's events are not the main snapshot. request: the search itself threw. */
      kind: "view" | "request";
      message: string;
    };

// ─── fingerprint ─────────────────────────────────────────────────────────────

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function mix(h: number, value: number): number {
  return Math.imul(h ^ value, FNV_PRIME);
}

/** FNV-1a over one event's id and content length, folded onto `h`. */
export function extendFingerprint(h: number, event: MemoryEvent): number {
  const id = String(event.id);
  let out = mix(h, id.length);
  for (let i = 0; i < id.length; i++) {
    out = mix(out, id.charCodeAt(i));
  }
  const length = typeof event.content === "string" ? event.content.length : -1;
  out = mix(out, length & 0xffff);
  out = mix(out, length >>> 16);
  return out >>> 0;
}

/** The fingerprint of an event sequence; order-sensitive. */
export function fingerprintEvents(events: readonly MemoryEvent[]): number {
  let h = FNV_OFFSET;
  for (const event of events) {
    h = extendFingerprint(h, event);
  }
  return h;
}

// ─── per-file corpus ─────────────────────────────────────────────────────────

/** Files kept parsed at once; least recently searched is dropped first. */
export const FTS_WORKER_MAX_FILES = 8;

interface FileCorpus {
  readonly filePath: string;
  readonly dev: number;
  readonly ino: number;
  /** Bytes consumed: the end of the last complete line. */
  offset: number;
  readonly events: MemoryEvent[];
  readonly positions: Map<MemoryEvent, number>;
  /** `prefixFingerprints[i]` is the fingerprint of `events[0..i)`. */
  readonly prefixFingerprints: number[];
  /** How many leading events `view.readAll()` returns — the current request's `count`. */
  limit: number;
  /**
   * The store `ftsSearch` scans. ONE object per corpus, so task 14's trigram index (a WeakMap
   * keyed on the store) persists across requests and is extended, not rebuilt, as lines append.
   */
  readonly view: EventStore;
}

function createCorpus(filePath: string, dev: number, ino: number): FileCorpus {
  const events: MemoryEvent[] = [];
  const corpus: FileCorpus = {
    filePath,
    dev,
    ino,
    offset: 0,
    events,
    positions: new Map(),
    prefixFingerprints: [FNV_OFFSET],
    limit: 0,
    view: {
      filePath,
      sessionKey: basename(filePath, ".jsonl"),
      append: () => {
        throw new Error("fts worker corpus is read-only");
      },
      appendRaw: () => {
        throw new Error("fts worker corpus is read-only");
      },
      readAll: () => events.slice(0, corpus.limit),
      readByKind: (kind: EventKind) => corpus.view.readAll().filter((e) => e.kind === kind),
      readRange: (startTurnId: number, endTurnId: number) =>
        corpus.view.readAll().filter((e) => e.turnId >= startTurnId && e.turnId <= endTurnId),
      readById: (id: string) => corpus.view.readAll().find((e) => e.id === id),
      count: () => corpus.limit,
    },
  };
  return corpus;
}

function readRange(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, start + read);
    if (n === 0) {
      break;
    }
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/**
 * Parse the complete lines in `buf` exactly as `loadCache` would: split on "\n", drop empty
 * lines, JSON.parse each. `loadCache` also trims the WHOLE file, which only reaches its first
 * line's leading whitespace (a BOM, say) and its last line's trailing whitespace; the first is
 * replicated at offset 0, and JSON.parse ignores the second except for non-JSON whitespace, where
 * the parse throws and the caller searches in-thread instead.
 *
 * All-or-nothing: returns the parsed events, or throws before anything is committed.
 */
function parseCompleteLines(
  buf: Buffer,
  atFileStart: boolean,
): { events: MemoryEvent[]; bytes: number } {
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return { events: [], bytes: 0 };
  }
  // "\n" never occurs inside a multi-byte UTF-8 sequence, so cutting there decodes exactly as
  // decoding the whole file would.
  let text = buf.toString("utf8", 0, lastNewline);
  if (atFileStart) {
    text = text.trimStart();
  }
  const events: MemoryEvent[] = [];
  for (const line of text.split("\n")) {
    if (line) {
      events.push(JSON.parse(line) as MemoryEvent);
    }
  }
  return { events, bytes: lastNewline + 1 };
}

export interface FtsWorkerHandlerOptions {
  maxFiles?: number;
}

/** The worker's request handler, with its own corpus cache. One per worker thread. */
export function createFtsWorkerHandler(
  options: FtsWorkerHandlerOptions = {},
): (request: FtsWorkerRequest) => FtsWorkerResponse {
  const maxFiles = options.maxFiles ?? FTS_WORKER_MAX_FILES;
  /** Insertion order = recency order (touched entries are re-inserted). */
  const corpora = new Map<string, FileCorpus>();
  /** Full reads per path, kept across evictions (one number per path ever searched). */
  const loads = new Map<string, number>();

  function newCorpus(filePath: string, dev: number, ino: number): FileCorpus {
    loads.set(filePath, (loads.get(filePath) ?? 0) + 1);
    return createCorpus(filePath, dev, ino);
  }

  /** Bring the file's corpus up to date; undefined when the file does not exist. */
  function syncCorpus(filePath: string): FileCorpus | undefined {
    let fd: number;
    try {
      fd = openSync(filePath, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        corpora.delete(filePath);
        return undefined;
      }
      throw err;
    }
    try {
      // fstat on the open descriptor: the identity and size belong to the file actually read.
      const st = fstatSync(fd);
      let corpus = corpora.get(filePath);
      corpora.delete(filePath);
      if (corpus && (corpus.dev !== st.dev || corpus.ino !== st.ino || st.size < corpus.offset)) {
        // Replaced or truncated: not an append, so nothing parsed so far can be trusted.
        corpus = undefined;
      }
      corpus ??= newCorpus(filePath, st.dev, st.ino);
      if (st.size > corpus.offset) {
        const tail = readRange(fd, corpus.offset, st.size - corpus.offset);
        // A trailing line without its "\n" is still being written: leave it for a later request.
        const parsed = parseCompleteLines(tail, corpus.offset === 0);
        for (const event of parsed.events) {
          corpus.positions.set(event, corpus.events.length);
          corpus.events.push(event);
          corpus.prefixFingerprints.push(
            extendFingerprint(corpus.prefixFingerprints[corpus.events.length - 1], event),
          );
        }
        corpus.offset += parsed.bytes;
      }
      corpora.set(filePath, corpus);
      while (corpora.size > maxFiles) {
        const oldest = corpora.keys().next().value as string;
        corpora.delete(oldest);
      }
      return corpus;
    } finally {
      closeSync(fd);
    }
  }

  /** Why `corpus` cannot answer for the request's snapshot, or null when it can. */
  function mismatch(corpus: FileCorpus, request: FtsWorkerRequest): string | null {
    if (corpus.events.length < request.count) {
      return `file holds ${corpus.events.length} complete events, main snapshot ${request.count}`;
    }
    if (corpus.prefixFingerprints[request.count] !== request.fingerprint) {
      return `first ${request.count} events of the file are not the main snapshot`;
    }
    return null;
  }

  return (request) => {
    const { id } = request;
    const filePath = resolve(request.filePath);
    try {
      const loadsBefore = loads.get(filePath) ?? 0;
      let corpus = syncCorpus(filePath);
      let refused = corpus ? mismatch(corpus, request) : null;
      // FORK 2026-09-24 (final whole-branch review item 5, ruling R34) — a corpus parsed from an
      // earlier read may no longer be the file: a rewrite in place keeps the inode and need not
      // shrink, so syncCorpus kept it, and the refusal repeated on every request until the corpus
      // was evicted — that file searched in-thread meanwhile. Drop it and read the file ONCE more
      // before refusing (not when this request already read it from byte 0).
      if (corpus && refused !== null && (loads.get(filePath) ?? 0) === loadsBefore) {
        corpora.delete(filePath);
        corpus = syncCorpus(filePath);
        refused = corpus ? mismatch(corpus, request) : null;
      }
      if (!corpus) {
        return { id, ok: false, kind: "view", message: "event file does not exist" };
      }
      if (refused !== null) {
        return { id, ok: false, kind: "view", message: refused };
      }
      corpus.limit = request.count;
      const results = ftsSearch(corpus.view, request.query, request.topN, request.filters);
      const hits = results.map((r) => ({
        pos: corpus.positions.get(r.event) as number,
        id: r.event.id,
        score: r.score,
      }));
      return {
        id,
        ok: true,
        hits,
        corpus: { events: corpus.events.length, loads: loads.get(corpus.filePath) ?? 0 },
      };
    } catch (err) {
      // A line that does not parse, say. Drop what this file had so the next request starts over.
      corpora.delete(filePath);
      return { id, ok: false, kind: "request", message: String(err) };
    }
  };
}
