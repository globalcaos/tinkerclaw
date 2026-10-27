/**
 * What "the same event" means in an engram store, and an index of a store file by it.
 *
 * FORK 2026-10-11 — two writers append to engram stores and must agree on identity: the ingestion
 * pipeline (one per chat store) and the compaction archive writer (compaction-engram.ts, the shared
 * `compaction` store). An event is keyed on its kind plus a hash of its content. An externalised
 * tool result is keyed on its raw output instead (metadata.rawKey), because its reference carries a
 * fresh artifact id every time and so never repeats.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { MemoryEvent } from "./event-types.js";

export function eventContentKey(kind: string, content: string): string {
  return `${kind}\u0000${createHash("sha256").update(content).digest("base64")}`;
}

/** The key of an event already in a store. */
export function storedEventKey(e: MemoryEvent): string {
  return typeof e.metadata?.rawKey === "string"
    ? e.metadata.rawKey
    : eventContentKey(e.kind, e.content);
}

interface FileIndex {
  dev: number;
  ino: number;
  /** Bytes consumed: the end of the last complete line. */
  offset: number;
  byKey: Map<string, MemoryEvent>;
}

const indexes = new Map<string, FileIndex>();

/**
 * Content key → the FIRST event in the store file with that key.
 *
 * Kept per process and caught up from the last byte read on every call, so a long archive is
 * parsed once rather than once per compaction. A file that shrank or was replaced (a cleanup
 * rewrites a store by rename) is read again from the start. A last line without its newline is a
 * write still in progress and is left for the next call. A caller that appends should `set` the
 * event it wrote; the next catch-up then sees that line and keeps the entry already there.
 */
export function storeContentIndex(filePath: string): Map<string, MemoryEvent> {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    const empty: FileIndex = { dev: -1, ino: -1, offset: 0, byKey: new Map() };
    indexes.set(filePath, empty);
    return empty.byKey;
  }
  try {
    const st = fstatSync(fd);
    let index = indexes.get(filePath);
    if (!index || index.dev !== st.dev || index.ino !== st.ino || st.size < index.offset) {
      index = { dev: st.dev, ino: st.ino, offset: 0, byKey: new Map() };
      indexes.set(filePath, index);
    }
    if (st.size > index.offset) {
      const tail = Buffer.alloc(st.size - index.offset);
      let got = 0;
      while (got < tail.length) {
        const n = readSync(fd, tail, got, tail.length - got, index.offset + got);
        if (n === 0) {
          break;
        }
        got += n;
      }
      const end = tail.lastIndexOf(0x0a, got - 1);
      if (end >= 0) {
        for (const line of tail.subarray(0, end).toString("utf-8").split("\n")) {
          if (!line) {
            continue;
          }
          let e: MemoryEvent;
          try {
            e = JSON.parse(line) as MemoryEvent;
          } catch {
            continue;
          }
          if (typeof e?.content !== "string" || typeof e.kind !== "string") {
            continue;
          }
          const key = storedEventKey(e);
          if (!index.byKey.has(key)) {
            index.byKey.set(key, e);
          }
        }
        index.offset += end + 1;
      }
    }
    return index.byKey;
  } finally {
    closeSync(fd);
  }
}
