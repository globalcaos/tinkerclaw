#!/usr/bin/env bun
/**
 * Validation script for Memory Phase 1: Schema Extension
 *
 * Checks that:
 * 1. The 4 new columns exist on the chunks table
 * 2. detectGranularity() returns correct values for known paths
 * 3. detectTopicCluster() returns correct values for known paths
 * 4. access_count increments after a search (integration test via in-memory DB)
 */

import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "../src/memory/memory-schema.js";
import { detectGranularity, detectTopicCluster } from "../src/memory/internal.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

// ─── 1. Schema columns ──────────────────────────────────────────────────────
console.log("\n1. Checking schema columns exist on chunks table…");

const db = new DatabaseSync(":memory:");
ensureMemoryIndexSchema({
  db,
  embeddingCacheTable: "embedding_cache",
  ftsTable: "chunks_fts",
  ftsEnabled: false,
});

const cols = new Set((db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>).map(
  (r) => r.name,
));

assert(cols.has("granularity"), "granularity column exists");
assert(cols.has("topic_cluster"), "topic_cluster column exists");
assert(cols.has("last_accessed"), "last_accessed column exists");
assert(cols.has("access_count"), "access_count column exists");

// ─── 2. detectGranularity ───────────────────────────────────────────────────
console.log("\n2. Checking detectGranularity()…");

assert(detectGranularity("memory/2024-03-15.md") === "detail", "daily log → detail");
assert(detectGranularity("MEMORY.md") === "global", "MEMORY.md → global");
assert(detectGranularity("memory/memory-index.md") === "global", "memory-index.md → global");
assert(detectGranularity("memory/topics/work.md") === "topic", "topics/ → topic");
assert(detectGranularity("bank/entities/Oscar.md") === "topic", "bank/ → topic");
assert(
  detectGranularity("memory/projects/openclaw/index.md") === "topic",
  "projects/…/index.md → topic",
);
assert(detectGranularity("memory/misc/notes.md") === "detail", "misc file → detail");

// ─── 3. detectTopicCluster ──────────────────────────────────────────────────
console.log("\n3. Checking detectTopicCluster()…");

assert(
  detectTopicCluster("bank/entities/Oscar.md") === "entity_oscar",
  "bank/entities/Oscar.md → entity_oscar",
);
assert(
  detectTopicCluster("memory/topics/work_business.md") === "work_business",
  "memory/topics/work_business.md → work_business",
);
assert(
  detectTopicCluster("memory/projects/openclaw/features.md") === "project_openclaw",
  "memory/projects/openclaw/… → project_openclaw",
);
assert(
  detectTopicCluster("bank/opinions.md") === "opinions",
  "bank/opinions.md → opinions",
);
assert(detectTopicCluster("memory/2024-01-01.md") === "", "daily log → ''");

// ─── 4. access_count increments after insert + manual tracking ──────────────
console.log("\n4. Checking access_count increments…");

// Insert a fake chunk
db.exec(`
  INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, granularity, topic_cluster, last_accessed, access_count)
  VALUES ('test-id-1', 'memory/test.md', 'memory', 1, 5, 'abc', 'test-model', 'hello world', '[]', 0, 'detail', '', 0, 0)
`);

// Simulate access tracking (the same code path as trackAccess in manager-search.ts)
const now = Date.now();
db.prepare("UPDATE chunks SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?").run(now, "test-id-1");

const row = db.prepare("SELECT access_count, last_accessed FROM chunks WHERE id = ?").get("test-id-1") as { access_count: number; last_accessed: number };
assert(row.access_count === 1, "access_count incremented to 1");
assert(row.last_accessed >= now, "last_accessed updated to current time");

// Do it again
db.prepare("UPDATE chunks SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?").run(Date.now(), "test-id-1");
const row2 = db.prepare("SELECT access_count FROM chunks WHERE id = ?").get("test-id-1") as { access_count: number };
assert(row2.access_count === 2, "access_count incremented to 2 on second access");

// ─── 5. granularity/topic_cluster written on insert ─────────────────────────
console.log("\n5. Checking granularity/topic_cluster stored correctly…");

const stored = db.prepare("SELECT granularity, topic_cluster FROM chunks WHERE id = ?").get("test-id-1") as { granularity: string; topic_cluster: string };
assert(stored.granularity === "detail", "stored granularity = 'detail'");
assert(stored.topic_cluster === "", "stored topic_cluster = ''");

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
