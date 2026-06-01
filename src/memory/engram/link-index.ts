/**
 * U9 A-MEM Zettelkasten auto-linking: bidirectional link index.
 *
 * Built on the SAME JSONL-append + in-memory-cache pattern as event-store.ts.
 * A LinkRecord is appended to links/<sessionKey>.jsonl. In memory the index
 * maintains two Map<string, LinkRecord[]> indexes — `forward` (sourceId →
 * records) and `backward` (targetKey → records) — rebuilt from the JSONL on
 * first read (loadCache() analog).
 *
 * Resolution of a targetKey to a concrete event id is DEFERRED (a target may be
 * mentioned before the note it names exists), so the index keys on the
 * normalized string and exposes resolveTargets(eventStore) to late-bind keys to
 * event ids.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { EventStore } from "./event-store.js";
import { generateULID } from "./event-store.js";
import type { Mention } from "./mention-parser.js";
import { normalizeMention } from "./mention-parser.js";

export interface LinkRecord {
  id: string;
  /** Event id that authored the mention (the "from" side of the edge). */
  sourceId: string;
  /** Normalized mention target (lowercased + trimmed) — the "to" side. */
  targetKey: string;
  /** The raw mention surface form as written. */
  mentionText: string;
  kind: Mention["kind"];
  createdAt: string;
}

export interface LinkIndexOptions {
  baseDir: string;
  sessionKey: string;
}

export interface LinkIndex {
  /** Append a link record for `sourceId` mentioning `mention`. */
  append(sourceId: string, mention: Mention): LinkRecord;
  /** Forward edges: records authored by `sourceId`. Empty array if none. */
  getLinks(sourceId: string): LinkRecord[];
  /** Reverse edges: records pointing at `targetKey` (case-insensitive). */
  getBacklinks(targetKey: string): LinkRecord[];
  /** Number of records pointing at `targetKey` (importance weight). */
  backlinkCount(targetKey: string): number;
  /**
   * Late-bind every targetKey to the ids of events whose content contains the
   * target string (case-insensitive substring). Conservative by design; a
   * target with no matching event resolves to an empty array.
   */
  resolveTargets(eventStore: EventStore): Map<string, string[]>;
  readonly filePath: string;
  readonly sessionKey: string;
}

function linkFilePath(baseDir: string, sessionKey: string): string {
  return join(baseDir, "links", `${sessionKey}.jsonl`);
}

export function createLinkIndex(options: LinkIndexOptions): LinkIndex {
  const filePath = linkFilePath(options.baseDir, options.sessionKey);
  mkdirSync(dirname(filePath), { recursive: true });

  let forward: Map<string, LinkRecord[]> | null = null;
  let backward: Map<string, LinkRecord[]> | null = null;

  function indexRecord(rec: LinkRecord): void {
    const fwd = forward!;
    const bwd = backward!;
    const fwdList = fwd.get(rec.sourceId);
    if (fwdList) {
      fwdList.push(rec);
    } else {
      fwd.set(rec.sourceId, [rec]);
    }
    const bwdList = bwd.get(rec.targetKey);
    if (bwdList) {
      bwdList.push(rec);
    } else {
      bwd.set(rec.targetKey, [rec]);
    }
  }

  function loadCache(): void {
    if (forward && backward) {
      return;
    }
    forward = new Map();
    backward = new Map();
    if (!existsSync(filePath)) {
      return;
    }
    const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      indexRecord(JSON.parse(line) as LinkRecord);
    }
  }

  return {
    filePath,
    sessionKey: options.sessionKey,

    append(sourceId: string, mention: Mention): LinkRecord {
      loadCache();
      const rec: LinkRecord = {
        id: generateULID(),
        sourceId,
        targetKey: mention.normalized,
        mentionText: mention.raw,
        kind: mention.kind,
        createdAt: new Date().toISOString(),
      };
      appendFileSync(filePath, JSON.stringify(rec) + "\n");
      indexRecord(rec);
      return rec;
    },

    getLinks(sourceId: string): LinkRecord[] {
      loadCache();
      return forward!.get(sourceId) ?? [];
    },

    getBacklinks(targetKey: string): LinkRecord[] {
      loadCache();
      return backward!.get(normalizeMention(targetKey)) ?? [];
    },

    backlinkCount(targetKey: string): number {
      loadCache();
      return (backward!.get(normalizeMention(targetKey)) ?? []).length;
    },

    resolveTargets(eventStore: EventStore): Map<string, string[]> {
      loadCache();
      const events = eventStore.readAll();
      const resolved = new Map<string, string[]>();
      for (const targetKey of backward!.keys()) {
        const matches: string[] = [];
        for (const event of events) {
          if (event.content.toLowerCase().includes(targetKey)) {
            matches.push(event.id);
          }
        }
        resolved.set(targetKey, matches);
      }
      return resolved;
    },
  };
}
