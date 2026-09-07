// Regression: the FORK 2026-08-16 memo for loadSessionCostSummary kept the file identity in
// the CACHE KEY, so every write to a live session ADDED a key instead of replacing its own, and
// the 512-entry FIFO evicted in insertion order — discarding the idle sessions the memo exists
// to serve. It also had no in-flight coalescing (concurrent panel polls each re-parsed the same
// transcripts) and used float mtimeMs with no ino (a same-millisecond same-size write, or an
// atomic rename-into-place, served a summary of bytes that no longer exist). Measured from
// journald over 240 min, twice independently: sessions.usage n=68, mean 37,681 ms, p50
// 4,582 ms, max 461,480 ms, 64/68 calls over 1s.
//
// These tests pin the four properties the fix depends on: (a) unchanged file => zero re-reads,
// (b) changed mtime/size/ino => re-read, (c) N concurrent callers => exactly one scan, and
// (d) totals identical to the uncached path — the memo removes work, never changes the answer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionCostSummary,
  resetSessionCostSummaryCacheForTest,
} from "../../infra/session-cost-usage.js";

// A pinned whole-second mtime makes mtimeNs exactly T*1e9 on ext4/tmpfs, so the ino test can
// hold mtime and size constant while only the inode changes.
const PINNED_MTIME_SEC = 1_756_000_000;

const transcriptText = (outputTokens: number, costTotal: number): string =>
  [
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-20T10:00:00.000Z",
      message: { role: "user", content: "hello" },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-20T10:00:05.000Z",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        usage: {
          input: 100,
          output: outputTokens,
          totalTokens: 100 + outputTokens,
          cost: { total: costTotal },
        },
      },
    }),
    "",
  ].join("\n");

describe("loadSessionCostSummary identity memo", () => {
  let tmpDir: string;
  const openedFiles: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-cost-cache-"));
    resetSessionCostSummaryCacheForTest();
    openedFiles.length = 0;
    const realCreateReadStream = fs.createReadStream.bind(fs);
    vi.spyOn(fs, "createReadStream").mockImplementation(((
      filePath: fs.PathLike,
      options?: Parameters<typeof fs.createReadStream>[1],
    ) => {
      openedFiles.push(String(filePath));
      return realCreateReadStream(filePath, options);
    }) as typeof fs.createReadStream);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSessionCostSummaryCacheForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const readsOf = (file: string): number => openedFiles.filter((p) => p === file).length;

  it("(a) serves an unchanged transcript from memory — zero re-reads", async () => {
    const sessionFile = path.join(tmpDir, "a.jsonl");
    fs.writeFileSync(sessionFile, transcriptText(50, 0.05));

    const first = await loadSessionCostSummary({ sessionFile });
    expect(first?.output).toBe(50);
    expect(readsOf(sessionFile)).toBe(1);

    const second = await loadSessionCostSummary({ sessionFile });
    const third = await loadSessionCostSummary({ sessionFile });

    // The whole point: the file was never opened again.
    expect(readsOf(sessionFile)).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("(b1) re-reads when the transcript grows — size and mtime change", async () => {
    const sessionFile = path.join(tmpDir, "b1.jsonl");
    fs.writeFileSync(sessionFile, transcriptText(50, 0.05));
    const before = await loadSessionCostSummary({ sessionFile });
    expect(readsOf(sessionFile)).toBe(1);

    fs.appendFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-20T10:01:00.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: { input: 10, output: 7, totalTokens: 17, cost: { total: 0.01 } },
        },
      }) + "\n",
    );

    const after = await loadSessionCostSummary({ sessionFile });
    expect(readsOf(sessionFile)).toBe(2);
    expect(after?.output).toBe((before?.output ?? 0) + 7);
  });

  it("(b2) re-reads when only mtime changes — same bytes, same inode", async () => {
    const sessionFile = path.join(tmpDir, "b2.jsonl");
    fs.writeFileSync(sessionFile, transcriptText(50, 0.05));
    fs.utimesSync(sessionFile, PINNED_MTIME_SEC, PINNED_MTIME_SEC);

    const before = await loadSessionCostSummary({ sessionFile });
    expect(readsOf(sessionFile)).toBe(1);

    fs.utimesSync(sessionFile, PINNED_MTIME_SEC + 5, PINNED_MTIME_SEC + 5);

    const after = await loadSessionCostSummary({ sessionFile });
    expect(readsOf(sessionFile)).toBe(2);
    expect(after).toEqual(before);
  });

  it("(b3) re-reads after an atomic rename that preserves mtime and size — ino changes", async () => {
    const sessionFile = path.join(tmpDir, "b3.jsonl");
    const replacement = path.join(tmpDir, "b3.jsonl.tmp");

    fs.writeFileSync(sessionFile, transcriptText(50, 0.05));
    fs.utimesSync(sessionFile, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    const originalSize = fs.statSync(sessionFile).size;

    const before = await loadSessionCostSummary({ sessionFile });
    expect(before?.output).toBe(50);
    expect(readsOf(sessionFile)).toBe(1);

    // Same byte length, same pinned mtime, different inode and content: without ino in the
    // identity this replacement is invisible and the memo would serve totals for dead bytes.
    fs.writeFileSync(replacement, transcriptText(99, 0.09));
    fs.utimesSync(replacement, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    expect(fs.statSync(replacement).size).toBe(originalSize);
    fs.renameSync(replacement, sessionFile);

    const after = await loadSessionCostSummary({ sessionFile });
    expect(readsOf(sessionFile)).toBe(2);
    expect(after?.output).toBe(99);
  });

  it("(c) coalesces N concurrent callers into exactly one scan", async () => {
    const sessionFile = path.join(tmpDir, "c.jsonl");
    fs.writeFileSync(sessionFile, transcriptText(50, 0.05));

    const results = await Promise.all(
      Array.from({ length: 8 }, () => loadSessionCostSummary({ sessionFile })),
    );

    // Eight callers, one open — the measured pile-up was concurrent panel polls each starting
    // their own scan of the same transcripts.
    expect(readsOf(sessionFile)).toBe(1);
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
  });

  it("(d) returns exactly what the uncached path returns", async () => {
    const sessionFile = path.join(tmpDir, "d.jsonl");
    fs.writeFileSync(sessionFile, transcriptText(50, 0.05));

    const cold = await loadSessionCostSummary({ sessionFile });
    resetSessionCostSummaryCacheForTest();
    const alsoCold = await loadSessionCostSummary({ sessionFile });
    const warm = await loadSessionCostSummary({ sessionFile });

    expect(readsOf(sessionFile)).toBe(2); // two cold reads; the warm call is served from memory
    expect(alsoCold).toEqual(cold);
    expect(warm).toEqual(cold);
  });

  it("keeps distinct date windows as distinct entries", async () => {
    const sessionFile = path.join(tmpDir, "e.jsonl");
    fs.writeFileSync(sessionFile, transcriptText(50, 0.05));

    const inWindow = await loadSessionCostSummary({
      sessionFile,
      startMs: Date.UTC(2026, 7, 20),
      endMs: Date.UTC(2026, 7, 21) - 1,
    });
    const outOfWindow = await loadSessionCostSummary({
      sessionFile,
      startMs: Date.UTC(2026, 0, 1),
      endMs: Date.UTC(2026, 0, 2) - 1,
    });

    // Two windows, two entries, two reads — a shared entry would have served August's totals
    // for January's window.
    expect(readsOf(sessionFile)).toBe(2);
    expect(inWindow?.output).toBe(50);
    expect(outOfWindow?.output).toBe(0);
  });
});
