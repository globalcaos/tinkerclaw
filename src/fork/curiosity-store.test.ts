/**
 * FORK 2026-05-30 — tests for the curiosity episodic-buffer store (J8 THALAMUS, 2a/2b/2e).
 *
 * Test target: src/fork/curiosity-store.ts
 * Pure functions (rescore, dedupe, classifyGap, uncertainty heuristic) run with no I/O.
 * I/O functions (appendGap/readGaps/markResolved) run against a temp dir.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendGap,
  classifyGap,
  dedupeGaps,
  dedupeKey,
  detectUncertaintySpans,
  extractTopic,
  makeGap,
  markResolved,
  readGaps,
  recencyFactor,
  rescore,
  topGaps,
  DEFAULT_WEIGHTS,
  type Gap,
} from "./curiosity-store.js";

const DAY = 24 * 60 * 60 * 1000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "curiosity-store-"));
}

describe("makeGap", () => {
  it("clamps scoring inputs to [0,1] and defaults missing ones to 0.5", () => {
    const g = makeGap({ topic: " x ", source: "manual", importance: 5, learnability: -3 });
    expect(g.importance).toBe(1);
    expect(g.learnability).toBe(0);
    expect(g.adjacency).toBe(0.5);
    expect(g.userRelevance).toBe(0.5);
    expect(g.topic).toBe("x"); // trimmed
    expect(g.frequency).toBe(1);
    expect(g.id).toMatch(/^gap_/);
  });

  it("generates unique ids", () => {
    const ids = new Set(
      Array.from({ length: 500 }, () => makeGap({ topic: "t", source: "manual" }).id),
    );
    expect(ids.size).toBe(500);
  });
});

describe("rescore", () => {
  const base: Gap = makeGap({
    topic: "t",
    source: "manual",
    ts: 1_000_000,
    importance: 0.5,
    learnability: 0.5,
    adjacency: 0.5,
    userRelevance: 0.5,
  });

  it("is monotone non-decreasing in each scoring input", () => {
    const now = 1_000_000; // same ts -> recency held at 1
    const lowImp = rescore({ ...base, importance: 0.1 }, DEFAULT_WEIGHTS, now);
    const hiImp = rescore({ ...base, importance: 0.9 }, DEFAULT_WEIGHTS, now);
    expect(hiImp).toBeGreaterThan(lowImp);

    const lowLearn = rescore({ ...base, learnability: 0.1 }, DEFAULT_WEIGHTS, now);
    const hiLearn = rescore({ ...base, learnability: 0.9 }, DEFAULT_WEIGHTS, now);
    expect(hiLearn).toBeGreaterThan(lowLearn);

    const lowUR = rescore({ ...base, userRelevance: 0.1 }, DEFAULT_WEIGHTS, now);
    const hiUR = rescore({ ...base, userRelevance: 0.9 }, DEFAULT_WEIGHTS, now);
    expect(hiUR).toBeGreaterThan(lowUR);
  });

  it("weights recency: a recent high-importance gap outranks an old one of equal importance", () => {
    const now = 100 * DAY;
    const recent: Gap = { ...base, importance: 0.8, ts: now - 1 * DAY };
    const old: Gap = { ...base, importance: 0.8, ts: now - 20 * DAY };
    expect(rescore(recent, DEFAULT_WEIGHTS, now)).toBeGreaterThan(
      rescore(old, DEFAULT_WEIGHTS, now),
    );
  });

  it("stays in [0,1] for inputs in [0,1]", () => {
    const s = rescore(
      { ...base, importance: 1, learnability: 1, adjacency: 1, userRelevance: 1 },
      DEFAULT_WEIGHTS,
      base.ts,
    );
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

describe("recencyFactor", () => {
  it("is 1 at age 0 and halves at the half-life", () => {
    const now = 100 * DAY;
    expect(recencyFactor(now, now)).toBeCloseTo(1, 5);
    expect(recencyFactor(now - 14 * DAY, now)).toBeCloseTo(0.5, 5);
  });
});

describe("dedupeKey", () => {
  it("collapses NO-MATCH by (recipe|tool|reason), case-insensitive on reason", () => {
    const a = {
      source: "no-match" as const,
      topic: "x",
      recipeName: "r",
      toolName: "t",
      reason: "API DOWN",
    };
    const b = {
      source: "no-match" as const,
      topic: "y",
      recipeName: "r",
      toolName: "t",
      reason: "api down",
    };
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it("collapses non-NO-MATCH by (source|topic)", () => {
    const a = { source: "lcm-entropy" as const, topic: "Quantum Computing" };
    const b = { source: "lcm-entropy" as const, topic: "quantum computing" };
    expect(dedupeKey(a)).toBe(dedupeKey(b));
    const c = { source: "manual" as const, topic: "quantum computing" };
    expect(dedupeKey(a)).not.toBe(dedupeKey(c)); // different source
  });
});

describe("dedupeGaps", () => {
  it("collapses N phrasings of one logical NO-MATCH into a single entry with frequency=N", () => {
    const mk = (ts: number): Gap =>
      makeGap({
        source: "no-match",
        topic: "use foo",
        recipeName: "r",
        toolName: "foo",
        reason: "unknown tool",
        ts,
      });
    const gaps = [mk(1000), mk(2000), mk(3000)];
    const deduped = dedupeGaps(gaps);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.frequency).toBe(3);
    expect(deduped[0]!.ts).toBe(3000); // bumped to latest sighting
  });

  it("folds a resolution row back onto the original logical gap", () => {
    const g = makeGap({ source: "manual", topic: "tax law", ts: 1000 });
    const resolution: Gap = {
      ...g,
      id: "other",
      ts: 2000,
      resolvedAt: 2000,
      resolvedBy: "cron",
      resolutionSource: "web",
    };
    const deduped = dedupeGaps([g, resolution]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.resolvedAt).toBe(2000);
  });
});

describe("topGaps", () => {
  it("returns only unresolved gaps, sorted desc, capped at k, merged across days", () => {
    const now = 100 * DAY;
    const open1 = makeGap({ source: "manual", topic: "a", importance: 0.9, ts: now - 1 * DAY });
    const open2 = makeGap({ source: "manual", topic: "b", importance: 0.2, ts: now - 1 * DAY });
    const open3 = makeGap({ source: "manual", topic: "c", importance: 0.5, ts: now - 1 * DAY });
    const resolved = makeGap({ source: "manual", topic: "d", importance: 1.0, ts: now - 1 * DAY });
    resolved.resolvedAt = now;
    const top = topGaps([open1, open2, open3, resolved], { k: 2, nowTs: now });
    expect(top).toHaveLength(2);
    expect(top[0]!.gap.topic).toBe("a"); // highest importance among open
    expect(top.map((t) => t.gap.topic)).not.toContain("d"); // resolved excluded
  });

  it("returns empty for an empty buffer (no spurious goal)", () => {
    expect(topGaps([], {})).toEqual([]);
  });
});

describe("classifyGap (2e)", () => {
  it("permission-denied -> recoverable", () => {
    expect(classifyGap("calendar.write", "permission denied")).toBe("recoverable");
    expect(classifyGap("api", "403 Forbidden")).toBe("recoverable");
    expect(classifyGap("x", "not allowed to access")).toBe("recoverable");
  });
  it("network/5xx/timeout -> external-outage", () => {
    expect(classifyGap("fetch", "connection timed out")).toBe("external-outage");
    expect(classifyGap("api", "502 Bad Gateway")).toBe("external-outage");
    expect(classifyGap("svc", "service unavailable")).toBe("external-outage");
    expect(classifyGap("api", "rate-limit 429")).toBe("external-outage");
  });
  it("unknown tool / bad args -> knowledge-gap", () => {
    expect(classifyGap("frobnicate", "unknown tool")).toBe("knowledge-gap");
    expect(classifyGap("foo", "no such command")).toBe("knowledge-gap");
  });
});

describe("detectUncertaintySpans (2a heuristic)", () => {
  it("fires on hedged text", () => {
    expect(detectUncertaintySpans("I'm not sure about the tax rate.").length).toBeGreaterThan(0);
    expect(
      detectUncertaintySpans("I don't know the capital of that region.").length,
    ).toBeGreaterThan(0);
    expect(
      detectUncertaintySpans("As of my knowledge cutoff, that may be outdated.").length,
    ).toBeGreaterThan(0);
  });
  it("is silent on confident text", () => {
    expect(detectUncertaintySpans("The capital of France is Paris.")).toEqual([]);
    expect(detectUncertaintySpans("Here is the answer: 42.")).toEqual([]);
  });
  it("ignores hedges inside quoted / code / blockquote content (false-positive guard)", () => {
    expect(
      detectUncertaintySpans('The user wrote "I am not sure" but the answer is clear.'),
    ).toEqual([]);
    expect(detectUncertaintySpans("Run `echo I am not sure` to test.")).toEqual([]);
    expect(detectUncertaintySpans("> I don't know\n\nThe documented answer is X.")).toEqual([]);
  });
  it("returns empty on empty input", () => {
    expect(detectUncertaintySpans("")).toEqual([]);
    expect(detectUncertaintySpans("   ")).toEqual([]);
  });
});

describe("extractTopic (2a)", () => {
  it("picks salient noun terms from the user message, never a stopword", () => {
    const topic = extractTopic(["I'm not sure"], "What is the corporate tax rate in Spain?");
    expect(topic).not.toMatch(/\b(the|is|what|in|a)\b/);
    expect(topic.toLowerCase()).toContain("corporate");
  });
  it("falls back to the hedge span when no user message", () => {
    const topic = extractTopic(["beyond my knowledge"]);
    expect(topic).toBeTruthy();
    expect(topic).not.toBe("unspecified");
  });
  it("returns 'unspecified' when nothing salient", () => {
    expect(extractTopic([], "the a is of to")).toBe("unspecified");
  });
});

describe("appendGap / readGaps (JSONL I/O)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSONL line per gap and reads them back", () => {
    const g1 = makeGap({ source: "manual", topic: "alpha", ts: Date.now() });
    const g2 = makeGap({ source: "no-match", topic: "use beta", toolName: "beta", ts: Date.now() });
    appendGap(g1, dir);
    appendGap(g2, dir);
    const read = readGaps({ sinceDays: 1, baseDir: dir });
    expect(read).toHaveLength(2);
    expect(read.map((g) => g.id).sort()).toEqual([g1.id, g2.id].sort());
  });

  it("merges across multiple daily files within the window", () => {
    const now = Date.now();
    const today = makeGap({ source: "manual", topic: "today", ts: now });
    const threeDaysAgo = makeGap({ source: "manual", topic: "old", ts: now - 3 * DAY });
    appendGap(today, dir);
    appendGap(threeDaysAgo, dir);
    // window of 2 days excludes the 3-day-old one
    expect(readGaps({ sinceDays: 2, baseDir: dir, nowTs: now }).map((g) => g.topic)).toEqual([
      "today",
    ]);
    // window of 5 days includes both
    const wide = readGaps({ sinceDays: 5, baseDir: dir, nowTs: now })
      .map((g) => g.topic)
      .sort();
    expect(wide).toEqual(["old", "today"]);
  });

  it("skips malformed JSONL lines without throwing", () => {
    const g = makeGap({ source: "manual", topic: "ok", ts: Date.now() });
    const file = appendGap(g, dir);
    fs.appendFileSync(file, "{ this is not json\n", "utf8");
    const read = readGaps({ sinceDays: 1, baseDir: dir });
    expect(read).toHaveLength(1);
    expect(read[0]!.topic).toBe("ok");
  });
});

describe("markResolved", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stamps resolution and the gap drops out of the next topGaps call", () => {
    const now = Date.now();
    const g = makeGap({ source: "manual", topic: "vat rules", importance: 0.9, ts: now });
    appendGap(g, dir);
    // before resolution: present in topGaps
    let gaps = readGaps({ sinceDays: 1, baseDir: dir, nowTs: now });
    expect(topGaps(gaps, { nowTs: now }).some((t) => t.gap.topic === "vat rules")).toBe(true);

    const res = markResolved(g.id, "self-evolution-cron", "web-search", {
      baseDir: dir,
      nowTs: now,
    });
    expect(res).toBeDefined();
    expect(res!.resolvedAt).toBe(now);
    expect(res!.resolvedBy).toBe("self-evolution-cron");

    // after resolution: dedupeGaps folds the resolution row, dropping it from topGaps
    gaps = readGaps({ sinceDays: 1, baseDir: dir, nowTs: now });
    expect(topGaps(gaps, { nowTs: now }).some((t) => t.gap.topic === "vat rules")).toBe(false);
  });

  it("returns undefined for an unknown id", () => {
    expect(markResolved("nope", "x", "y", { baseDir: dir })).toBeUndefined();
  });
});
