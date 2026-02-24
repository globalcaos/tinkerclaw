/**
 * Tests for Phase 2.3 (EpisodicBuffer expiry) and Phase 2.4 (runHippocampusRebuild).
 * Run: pnpm test -- src/memory/engram/hippocampus
 */

import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EpisodicBuffer,
  EPISODIC_TTL_MS,
  sharedEpisodicBuffer,
  type EpisodicEvent,
} from "./hippocampus-enhancement.js";
import { runHippocampusRebuild } from "./hippocampus-rebuild.js";
import type { MemoryEvent } from "./event-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `hippo-rebuild-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeMemoryEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: `EVT-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowIso(),
    turnId: 1,
    sessionKey: "test",
    kind: "user_message",
    content: "hippocampus memory recall engram test content",
    tokens: 10,
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section A: EpisodicBuffer — 24 h TTL / expiry
// ---------------------------------------------------------------------------

describe("EpisodicBuffer — expire()", () => {
  it("removes events older than TTL", () => {
    const ttl = 60_000; // 1 min
    const buf = new EpisodicBuffer(ttl);
    const old = nowIso(-(ttl + 1000)); // 1 s past TTL
    buf.add({ id: "old", timestamp: old, content: "old event content" });
    buf.add({ id: "new", timestamp: nowIso(), content: "fresh event content" });

    buf.expire();
    expect(buf.size()).toBe(1);
    // Only the fresh event survives
    expect(buf.recentEvents().map((e) => e.id)).toEqual(["new"]);
  });

  it("clears all events when every entry is expired", () => {
    const ttl = 1_000;
    const buf = new EpisodicBuffer(ttl);
    buf.add({ id: "a", timestamp: nowIso(-(ttl + 500)), content: "old" });
    buf.add({ id: "b", timestamp: nowIso(-(ttl + 200)), content: "also old" });

    buf.expire();
    expect(buf.size()).toBe(0);
  });

  it("leaves buffer untouched when all events are within TTL", () => {
    const buf = new EpisodicBuffer(60_000);
    buf.add({ id: "a", timestamp: nowIso(-1000), content: "recent event" });
    buf.add({ id: "b", timestamp: nowIso(-2000), content: "also recent" });

    buf.expire();
    expect(buf.size()).toBe(2);
  });

  it("is idempotent — calling expire() twice is safe", () => {
    const ttl = 60_000;
    const buf = new EpisodicBuffer(ttl);
    buf.add({ id: "old", timestamp: nowIso(-(ttl + 5000)), content: "gone" });
    buf.add({ id: "new", timestamp: nowIso(), content: "kept" });

    buf.expire();
    buf.expire();
    expect(buf.size()).toBe(1);
  });
});

describe("EpisodicBuffer — recentEvents()", () => {
  it("returns only events within TTL window", () => {
    const ttl = 60_000;
    const buf = new EpisodicBuffer(ttl);
    buf.add({ id: "old", timestamp: nowIso(-(ttl + 1000)), content: "stale" });
    buf.add({ id: "new", timestamp: nowIso(-500), content: "fresh" });

    const recent = buf.recentEvents();
    expect(recent.map((e) => e.id)).toEqual(["new"]);
  });

  it("returns a copy — mutations do not affect buffer", () => {
    const buf = new EpisodicBuffer();
    buf.add({ id: "x", timestamp: nowIso(), content: "event" });
    const copy = buf.recentEvents();
    copy.length = 0;
    expect(buf.size()).toBe(1);
  });
});

describe("EpisodicBuffer — search() with 24 h TTL", () => {
  it("excludes expired events from keyword search", () => {
    const ttl = 60_000;
    const buf = new EpisodicBuffer(ttl);
    buf.add({
      id: "old",
      timestamp: nowIso(-(ttl + 5000)),
      content: "memory recall hippocampus engram",
    });
    const results = buf.search("memory recall");
    expect(results.find((r) => r.event.id === "old")).toBeUndefined();
  });

  it("includes events just within TTL window", () => {
    const ttl = 60_000;
    const buf = new EpisodicBuffer(ttl);
    buf.add({
      id: "recent",
      timestamp: nowIso(-(ttl - 5000)), // 5 s inside the window
      content: "memory recall hippocampus engram",
    });
    const results = buf.search("memory recall");
    expect(results.some((r) => r.event.id === "recent")).toBe(true);
  });
});

describe("EPISODIC_TTL_MS constant", () => {
  it("equals exactly 24 h in milliseconds", () => {
    expect(EPISODIC_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("sharedEpisodicBuffer singleton", () => {
  it("is an EpisodicBuffer instance", () => {
    expect(sharedEpisodicBuffer).toBeInstanceOf(EpisodicBuffer);
  });

  it("accepts events and searches them", () => {
    sharedEpisodicBuffer.clear();
    sharedEpisodicBuffer.add({
      id: "shared-1",
      timestamp: nowIso(),
      content: "singleton buffer engram query",
    });
    const results = sharedEpisodicBuffer.search("engram query");
    expect(results.length).toBeGreaterThan(0);
    sharedEpisodicBuffer.clear(); // clean up for other tests
  });
});

// ---------------------------------------------------------------------------
// Section B: runHippocampusRebuild — event-driven index rebuild
// ---------------------------------------------------------------------------

describe("runHippocampusRebuild()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it("creates hippocampus-index.json when none exists", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const events = [
      makeMemoryEvent({ content: "typescript engram memory hippocampus recall session" }),
    ];

    const result = await runHippocampusRebuild({ indexPath, events });

    expect(existsSync(indexPath)).toBe(true);
    expect(result.anchors).toBeGreaterThan(0);
    expect(result.indexed).toBe(1);
  });

  it("ingests multiple events and creates anchors for each", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const events = [
      makeMemoryEvent({ id: "e1", content: "docker build failed port error container" }),
      makeMemoryEvent({ id: "e2", content: "typescript compiler strict mode error types" }),
      makeMemoryEvent({ id: "e3", content: "nginx reverse proxy config ssl certificate" }),
    ];

    const result = await runHippocampusRebuild({ indexPath, events });

    expect(result.indexed).toBe(3);
    expect(result.anchors).toBeGreaterThan(0);

    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    // Each event content should produce at least one anchor entry
    const allChunks = Object.values(index).flat() as Array<{ path: string }>;
    const paths = allChunks.map((c) => c.path);
    expect(paths.some((p) => p.includes("e1"))).toBe(true);
    expect(paths.some((p) => p.includes("e2"))).toBe(true);
    expect(paths.some((p) => p.includes("e3"))).toBe(true);
  });

  it("filters out events older than maxAgeMs", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const events = [
      makeMemoryEvent({ id: "fresh", content: "recent memory recall session hippocampus" }),
      makeMemoryEvent({
        id: "stale",
        // 2 h ago, but we'll set maxAgeMs to 1 h so it's excluded
        timestamp: nowIso(-2 * 60 * 60 * 1000),
        content: "stale memory recall hippocampus session",
      }),
    ];

    const result = await runHippocampusRebuild({
      indexPath,
      events,
      maxAgeMs: 60 * 60 * 1000, // 1 h window
    });

    // Only the fresh event should be indexed
    expect(result.indexed).toBe(1);
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    const allChunks = Object.values(index).flat() as Array<{ path: string }>;
    const paths = allChunks.map((c) => c.path);
    expect(paths.some((p) => p.includes("fresh"))).toBe(true);
    expect(paths.some((p) => p.includes("stale"))).toBe(false);
  });

  it("is idempotent — re-running with same events does not duplicate chunks", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const events = [
      makeMemoryEvent({ id: "evt-uniq", content: "unique memory recall engram event" }),
    ];

    const first = await runHippocampusRebuild({ indexPath, events });
    const second = await runHippocampusRebuild({ indexPath, events });

    // Second run should add 0 new chunks (already present by id path)
    expect(second.indexed).toBe(0);
    // Anchor count should be the same
    expect(second.anchors).toBe(first.anchors);
  });

  it("merges into existing index without destroying prior anchors", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");

    // Pre-populate index with an existing anchor
    const existing = {
      "prior anchor": [
        {
          path: "workspace/notes.md",
          line: 1,
          score: 0.6,
          source: "workspace",
          preview: "some prior content in the workspace index",
        },
      ],
    };
    writeFileSync(indexPath, JSON.stringify(existing, null, 2));

    const events = [
      makeMemoryEvent({ id: "new-evt", content: "new memory engram hippocampus ingestion" }),
    ];

    await runHippocampusRebuild({ indexPath, events });

    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    // Prior anchor must survive
    expect(Object.keys(index)).toContain("prior anchor");
    // New anchor(s) must also be present
    expect(Object.keys(index).length).toBeGreaterThan(1);
  });

  it("applies importance scoring from event metadata", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const events = [
      makeMemoryEvent({
        id: "imp-high",
        content: "critical system alert memory hippocampus recall",
        metadata: { importance: 9 },
      }),
      makeMemoryEvent({
        id: "imp-low",
        content: "minor log entry memory hippocampus recall info",
        metadata: { importance: 2 },
      }),
    ];

    await runHippocampusRebuild({ indexPath, events });

    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    const allChunks = Object.values(index).flat() as Array<{
      path: string;
      importance?: number;
      score: number;
    }>;

    const high = allChunks.find((c) => c.path.includes("imp-high"));
    const low = allChunks.find((c) => c.path.includes("imp-low"));

    expect(high).toBeDefined();
    expect(low).toBeDefined();
    // After enhancement, higher importance should yield higher weighted score
    expect(high!.score).toBeGreaterThan(low!.score);
  });

  it("loads events from a JSONL file when eventsFilePath is provided", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");
    const eventsPath = join(tmpDir, "events.jsonl");

    const event = makeMemoryEvent({
      id: "file-evt",
      content: "memory event loaded from jsonl file hippocampus",
    });
    writeFileSync(eventsPath, JSON.stringify(event) + "\n");

    const result = await runHippocampusRebuild({ indexPath, eventsFilePath: eventsPath });

    expect(result.indexed).toBe(1);
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    const allPaths = (Object.values(index).flat() as Array<{ path: string }>).map(
      (c) => c.path,
    );
    expect(allPaths.some((p) => p.includes("file-evt"))).toBe(true);
  });

  it("handles empty events gracefully — produces a valid (possibly empty) index", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");

    const result = await runHippocampusRebuild({ indexPath, events: [] });

    expect(existsSync(indexPath)).toBe(true);
    expect(result.indexed).toBe(0);
    expect(result.anchors).toBeGreaterThanOrEqual(0);
  });

  it("handles a missing eventsFilePath gracefully", async () => {
    const indexPath = join(tmpDir, "hippocampus-index.json");

    const result = await runHippocampusRebuild({
      indexPath,
      eventsFilePath: join(tmpDir, "nonexistent.jsonl"),
    });

    expect(result.indexed).toBe(0);
  });
});
