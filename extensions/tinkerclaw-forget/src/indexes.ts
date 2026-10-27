/**
 * The search indexes: each one is rebuilt by its owner from the redacted files, then checked.
 *
 * - The engram transcript index (total-recall's `recall`): every redacted transcript it holds is
 *   dropped with SQLite's secure_delete and read again from byte 0, then the full-text index is
 *   merged and the WAL truncated (engram's forgetFile/compact seam).
 * - The memory search index (memory-core's `memory_search`, when a memory plugin serves one): it
 *   re-syncs the changed files; if a search for the fact still returns a chunk holding it, it is
 *   rebuilt from scratch. A rebuild writes a fresh database, so no freed page keeps the old bytes.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { openTranscriptIndex } from "openclaw/plugin-sdk/memory-engram";
import type { FactMatcher } from "./matcher.js";

export type IndexItem = {
  path: string;
  status: "done" | "found" | "not_present" | "failed";
  detail: string;
};

const TRANSCRIPT_INDEX_RE = /^transcripts-.+\.sqlite$/;
const RESYNC_DEADLINE_MS = 10_000;

/**
 * Drop and re-read every redacted transcript in each engram transcript index. A dry run opens no
 * database (opening one runs its schema statements): the byte scan reports the index file instead.
 */
export async function purgeTranscriptIndexes(args: {
  engramBaseDir: string;
  redacted: readonly string[];
  dryRun: boolean;
}): Promise<IndexItem[]> {
  if (args.dryRun) {
    return [];
  }
  let names: string[];
  try {
    names = (await readdir(args.engramBaseDir)).filter((n) => TRANSCRIPT_INDEX_RE.test(n));
  } catch {
    return [];
  }
  const items: IndexItem[] = [];
  for (const name of names.toSorted()) {
    const path = join(args.engramBaseDir, name);
    const index = openTranscriptIndex(path);
    try {
      const indexed = new Set(index.indexedPaths());
      const hit = args.redacted.filter((p) => indexed.has(p));
      if (hit.length === 0) {
        items.push({
          path,
          status: "not_present",
          detail: "indexes none of the files that held it",
        });
        continue;
      }
      for (const p of hit) {
        index.forgetFile(p);
        index.syncFile(p, Date.now() + RESYNC_DEADLINE_MS);
      }
      index.compact();
      items.push({
        path,
        status: "done",
        detail: `${hit.length} transcript(s) dropped, scrubbed and read again from the redacted files`,
      });
    } catch (err) {
      items.push({ path, status: "failed", detail: `could not rebuild: ${String(err)}` });
    } finally {
      index.close();
    }
  }
  return items;
}

/** The slice of memory-core's MemorySearchManager this module uses. */
export type MemoryIndexManager = {
  search(
    query: string,
    opts?: { maxResults?: number },
  ): Promise<Array<{ path: string; snippet: string }>>;
  sync?(params?: { reason?: string; force?: boolean; sessionFiles?: string[] }): Promise<void>;
};

export type GetMemoryManager = (
  agentId: string,
) => Promise<{ manager: MemoryIndexManager | null; error?: string }>;

async function chunksHolding(
  manager: MemoryIndexManager,
  fact: string,
  matcher: FactMatcher,
): Promise<number> {
  const hits = await manager.search(fact, { maxResults: 25 });
  return hits.filter((h) => {
    matcher.replace.lastIndex = 0;
    const holds = matcher.replace.test(h.snippet ?? "");
    matcher.replace.lastIndex = 0;
    return holds;
  }).length;
}

/** Re-sync each agent's memory search index and check that a search no longer returns the fact. */
export async function resyncMemoryIndexes(args: {
  agentIds: readonly string[];
  getManager: GetMemoryManager;
  fact: string;
  matcher: FactMatcher;
  /** Redacted gateway transcripts, by agent id (memory-core can index session transcripts). */
  sessionFilesByAgent: ReadonlyMap<string, string[]>;
  dryRun: boolean;
}): Promise<IndexItem[]> {
  const items: IndexItem[] = [];
  for (const agentId of args.agentIds) {
    const label = `memory search index (agent ${agentId})`;
    let got: Awaited<ReturnType<GetMemoryManager>>;
    try {
      got = await args.getManager(agentId);
    } catch (err) {
      got = { manager: null, error: String(err) };
    }
    const manager = got.manager;
    if (!manager) {
      items.push({
        path: label,
        status: "not_present",
        detail: `no memory search index is served here (${got.error ?? "no memory plugin"})`,
      });
      continue;
    }
    try {
      const before = await chunksHolding(manager, args.fact, args.matcher);
      if (args.dryRun) {
        items.push({
          path: label,
          status: before > 0 ? "found" : "not_present",
          detail:
            before > 0
              ? `${before} indexed chunk(s) returned by a search hold it; the changed files are re-indexed`
              : "a search for it returns no chunk holding it; the changed files are re-indexed anyway",
        });
        continue;
      }
      const sessionFiles = args.sessionFilesByAgent.get(agentId) ?? [];
      if (sessionFiles.length > 0) {
        await manager.sync?.({ reason: "forget", sessionFiles });
      }
      await manager.sync?.({ reason: "forget" });
      let left = await chunksHolding(manager, args.fact, args.matcher);
      let rebuilt = false;
      if (left > 0) {
        await manager.sync?.({ reason: "forget", force: true });
        rebuilt = true;
        left = await chunksHolding(manager, args.fact, args.matcher);
      }
      items.push({
        path: label,
        status: left > 0 ? "failed" : "done",
        detail:
          left > 0
            ? `${left} chunk(s) still hold it after a full rebuild`
            : `re-synced${rebuilt ? " and rebuilt from scratch" : ""}; a search for it returns no chunk holding it`,
      });
    } catch (err) {
      items.push({ path: label, status: "failed", detail: `could not re-sync: ${String(err)}` });
    }
  }
  return items;
}
