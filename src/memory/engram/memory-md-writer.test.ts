/**
 * ENGRAM — MEMORY.md writer unit tests (Upgrade 8).
 *
 * Covers the two load-bearing properties the writer must guarantee:
 *   1. Bounded output — never exceeds opts.maxLines; over-budget facts are
 *      DEMOTED to linked detail-file references (lowest-importance first),
 *      not dropped.
 *   2. Idempotent / deterministic — same input → byte-identical output, and
 *      re-serializing the already-bounded survivor set is stable.
 *
 * The writer is SUGGEST-ONLY: it returns the bounded content string plus a list
 * of demotion suggestions. It NEVER touches disk and NEVER decides to overwrite.
 */

import { describe, it, expect } from "vitest";
import { writeMemoryMd, type MemoryMdFact } from "./memory-md-writer.js";

function makeFact(overrides: Partial<MemoryMdFact> & { key: string }): MemoryMdFact {
  return {
    key: overrides.key,
    title: overrides.title ?? overrides.key,
    summary: overrides.summary ?? `summary for ${overrides.key}`,
    importance: overrides.importance ?? 5,
    detailFile: overrides.detailFile,
  };
}

function fact(key: string, importance: number): MemoryMdFact {
  return makeFact({ key, importance });
}

describe("writeMemoryMd — bounded output", () => {
  it("emits every fact + summary as one-line entries when under the line bound", () => {
    const facts = [fact("a", 9), fact("b", 7), fact("c", 5)];
    const summaries = ["Episode: did a thing\nTurns: 2"];
    const res = writeMemoryMd(facts, summaries, { maxLines: 200 });

    const lineCount = res.content.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(200);
    expect(res.content).toContain("a");
    expect(res.content).toContain("b");
    expect(res.content).toContain("c");
    // Nothing demoted while under budget.
    expect(res.demotions).toHaveLength(0);
    expect(res.lineCount).toBe(lineCount);
    expect(res.overBudget).toBe(false);
  });

  it("never exceeds maxLines even with far more facts than the bound", () => {
    const facts = Array.from({ length: 500 }, (_, i) =>
      fact(`fact-${String(i).padStart(3, "0")}`, (i % 9) + 1),
    );
    const res = writeMemoryMd(facts, [], { maxLines: 60 });

    const lineCount = res.content.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(60);
    expect(res.overBudget).toBe(true);
    expect(res.demotions.length).toBeGreaterThan(0);
  });

  it("demotes the LOWEST-importance facts first (highest survive in the body)", () => {
    const facts = [
      fact("keep-high", 10),
      fact("keep-mid", 8),
      fact("drop-low-1", 2),
      fact("drop-low-2", 1),
    ];
    // Tight bound that forces demotion of the two low-importance facts:
    // header(2) + 2 surviving entries + 1 collapsed pointer = 5 lines.
    const res = writeMemoryMd(facts, [], { maxLines: 5 });

    const demotedKeys = res.demotions.map((d) => d.key);
    expect(demotedKeys).toContain("drop-low-1");
    expect(demotedKeys).toContain("drop-low-2");
    expect(demotedKeys).not.toContain("keep-high");
    expect(demotedKeys).not.toContain("keep-mid");
    // Surviving high-importance facts remain in the body.
    expect(res.content).toContain("keep-high");
    expect(res.content).toContain("keep-mid");
  });

  it("demoted facts carry a detail-file reference so they stay reachable", () => {
    const facts = [fact("keep", 10), fact("demoted", 1)];
    // header(2) alone + the two entries (4) exceeds 3 → forces demotion.
    const res = writeMemoryMd(facts, [], { maxLines: 3 });

    expect(res.demotions.length).toBeGreaterThan(0);
    for (const d of res.demotions) {
      expect(d.detailFile).toBeTruthy();
      // The body links to the detail file so the demoted fact is not orphaned.
      expect(res.content).toContain(d.detailFile);
    }
  });

  it("respects a pre-assigned detailFile when demoting", () => {
    const facts = [
      fact("keep", 10),
      makeFact({ key: "demoted", importance: 1, detailFile: "topics/custom-detail.md" }),
    ];
    const res = writeMemoryMd(facts, [], { maxLines: 3 });

    const demoted = res.demotions.find((d) => d.key === "demoted");
    expect(demoted?.detailFile).toBe("topics/custom-detail.md");
  });
});

describe("writeMemoryMd — determinism / idempotency", () => {
  it("produces byte-identical output for the same input", () => {
    const facts = [fact("a", 9), fact("b", 7), fact("c", 5)];
    const summaries = ["Episode X", "Episode Y"];
    const a = writeMemoryMd(facts, summaries, { maxLines: 100 });
    const b = writeMemoryMd(facts, summaries, { maxLines: 100 });
    expect(a.content).toBe(b.content);
    expect(a.demotions).toEqual(b.demotions);
  });

  it("is order-independent — shuffled input yields identical output", () => {
    const facts = [fact("a", 9), fact("b", 7), fact("c", 5), fact("d", 3)];
    const shuffled = [facts[2], facts[0], facts[3], facts[1]];
    const a = writeMemoryMd(facts, [], { maxLines: 100 });
    const b = writeMemoryMd(shuffled, [], { maxLines: 100 });
    expect(a.content).toBe(b.content);
  });

  it("stable under re-serialization of the already-bounded survivor set", () => {
    const facts = Array.from({ length: 120 }, (_, i) =>
      fact(`f${String(i).padStart(3, "0")}`, (i % 9) + 1),
    );
    const first = writeMemoryMd(facts, [], { maxLines: 40 });

    // Re-feed only the survivors (the body facts, i.e. NOT demoted) back in.
    const demotedKeys = new Set(first.demotions.map((d) => d.key));
    const survivors = facts.filter((f) => !demotedKeys.has(f.key));
    const second = writeMemoryMd(survivors, [], { maxLines: 40 });

    // The survivor set already fits → no further demotions, and the body
    // content of the survivors is unchanged (idempotent fixpoint).
    expect(second.demotions).toHaveLength(0);
    expect(second.overBudget).toBe(false);
    // Survivors that were in the first body are still present in the second.
    for (const f of survivors) {
      expect(second.content).toContain(f.key);
    }
  });

  it("breaks importance ties deterministically by key", () => {
    const facts = [fact("zzz", 5), fact("aaa", 5), fact("mmm", 5)];
    const res = writeMemoryMd(facts, [], { maxLines: 100 });
    const aaaIdx = res.content.indexOf("aaa");
    const mmmIdx = res.content.indexOf("mmm");
    const zzzIdx = res.content.indexOf("zzz");
    // Equal importance → alphabetical by key, stable across runs.
    expect(aaaIdx).toBeLessThan(mmmIdx);
    expect(mmmIdx).toBeLessThan(zzzIdx);
  });

  it("handles empty inputs without throwing and stays within bound", () => {
    const res = writeMemoryMd([], [], { maxLines: 10 });
    expect(res.content.split("\n").length).toBeLessThanOrEqual(10);
    expect(res.demotions).toHaveLength(0);
    expect(res.overBudget).toBe(false);
  });
});
