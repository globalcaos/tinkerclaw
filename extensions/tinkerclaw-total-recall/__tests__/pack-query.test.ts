/**
 * FORK 2026-10-09 — `packQuery`: what a background pack refresh searches with.
 *
 * The refresh used to search with the whole prompt, and the full-text search costs more the more
 * distinct terms the query has. Measured on the 93 MB shared bank: ~1K chars of query took ~3 s,
 * 4K 11 s, 12K 32 s and 45K 71-85 s. These pin the cut (the TAIL, at most PACK_QUERY_MAX_CHARS,
 * starting on a whole word) and that the refresh really searches with it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACK_QUERY_MAX_CHARS, packQuery } from "../index.js";

describe("packQuery", () => {
  it("passes a prompt within the cap through, trimmed", () => {
    expect(packQuery("  what did we decide about the cache?\n")).toBe(
      "what did we decide about the cache?",
    );
  });

  it("is empty for a blank prompt", () => {
    expect(packQuery(" \n\t ")).toBe("");
  });

  it("keeps a prompt of exactly the cap whole", () => {
    const prompt = "a".repeat(PACK_QUERY_MAX_CHARS);
    expect(packQuery(prompt)).toBe(prompt);
  });

  it("keeps the TAIL of a long prompt, where the newest message is", () => {
    const prompt = `${"preamble ".repeat(5_000)}\n\nUser: why does the engram search come back empty?`;
    const query = packQuery(prompt);

    expect(query.length).toBeLessThanOrEqual(PACK_QUERY_MAX_CHARS);
    expect(query.endsWith("why does the engram search come back empty?")).toBe(true);
    expect(prompt.endsWith(query)).toBe(true);
  });

  it("starts on a whole word when the cut lands inside one", () => {
    // 1,000 nine-char units ("word0000 "), so the cut 2,000 chars from the end lands mid-word.
    const words = Array.from({ length: 1_000 }, (_, i) => `word${String(i).padStart(4, "0")}`);
    const query = packQuery(words.join(" "));

    expect(query.split(" ").every((t) => /^word\d{4}$/u.test(t))).toBe(true);
    expect(query.endsWith("word0999")).toBe(true);
    expect(query.length).toBeGreaterThan(PACK_QUERY_MAX_CHARS - 9);
    expect(query.length).toBeLessThanOrEqual(PACK_QUERY_MAX_CHARS);
  });

  it("keeps the first word when the cut lands exactly on a word boundary", () => {
    const window = `${"w".repeat(10)} ${"v".repeat(PACK_QUERY_MAX_CHARS - 11)}`;
    expect(packQuery(`${"z".repeat(50)} ${window}`)).toBe(window);
  });

  it("does not move the cut to a whitespace far into the window", () => {
    // A 1,499-char run opens the window: skipping to the space after it would drop most of it.
    const prompt = `${"x".repeat(4_000)} ${"y".repeat(500)}`;
    expect(packQuery(prompt)).toBe(prompt.slice(-PACK_QUERY_MAX_CHARS));
  });

  it("keeps the cut as it is when there is no whitespace at all", () => {
    expect(packQuery("x".repeat(5_000))).toBe("x".repeat(PACK_QUERY_MAX_CHARS));
  });
});

// The cases above prove packQuery; this proves the refresh uses it. A refresh that searched with
// `args.query` again would keep every case above green and put the 45K-char query back.
describe("refreshPackInBackground searches with packQuery (wiring)", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
  const start = source.indexOf("async function refreshPackInBackground(");
  const end = source.indexOf("const packRefreshScheduler = createPackRefreshScheduler");
  const body = source.slice(start, end);

  it("cuts the query once, before either search, and never searches with the raw prompt", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const cutAt = body.indexOf("const query = packQuery(args.query);");
    expect(cutAt).toBeGreaterThan(0);
    expect(cutAt).toBeLessThan(body.indexOf("assembleRetrievalPackAsync(query, store"));
    expect(cutAt).toBeLessThan(body.indexOf("assembleRetrievalPackAsync(query, ccStore"));
    expect(body.match(/args\.query/gu)).toHaveLength(1);
  });
});
