/**
 * U9 A-MEM Zettelkasten auto-linking: mention parser unit tests.
 */

import { describe, it, expect } from "vitest";
import { parseMentions, normalizeMention } from "./mention-parser.js";

// ============================================================
// Wikilink detection
// ============================================================
describe("parseMentions — wikilinks", () => {
  it("parses a single [[note]] as a wikilink mention", () => {
    const out = parseMentions("see [[note]] for details");
    const wikilinks = out.filter((m) => m.kind === "wikilink");
    expect(wikilinks).toEqual([{ raw: "note", normalized: "note", kind: "wikilink" }]);
  });

  it("parses multiple wikilinks in one body", () => {
    const out = parseMentions("link to [[alpha]] and also [[beta]] here");
    const raws = out.filter((m) => m.kind === "wikilink").map((m) => m.raw);
    expect(raws).toEqual(["alpha", "beta"]);
  });

  it("normalizes [[Free Text Ref]] to 'free text ref'", () => {
    const out = parseMentions("read [[Free Text Ref]] now");
    const wl = out.find((m) => m.kind === "wikilink");
    expect(wl?.normalized).toBe("free text ref");
    expect(wl?.raw).toBe("Free Text Ref");
  });

  it("does not over-match nested brackets", () => {
    // [[ ... ]] is non-greedy on ] so the inner content stops at the first ]]
    const out = parseMentions("weird [[a]] tail ]] more");
    const raws = out.filter((m) => m.kind === "wikilink").map((m) => m.raw);
    expect(raws).toEqual(["a"]);
  });

  it("yields no wikilink for empty/whitespace [[ ]]", () => {
    const out = parseMentions("nothing here [[   ]] really");
    expect(out.filter((m) => m.kind === "wikilink")).toEqual([]);
  });

  it("returns [] for a body with no refs at all", () => {
    expect(parseMentions("just plain lowercase prose with no markers")).toEqual([]);
  });
});

// ============================================================
// Entity refs (reuse extractEntities)
// ============================================================
describe("parseMentions — entity refs", () => {
  it("surfaces entity refs from extractEntities (people + projects)", () => {
    // "project Falcon" -> projects; "with Maria Lopez" -> people (mid-sentence)
    const out = parseMentions("we shipped project Falcon with Maria Lopez today");
    const entities = out.filter((m) => m.kind === "entity");
    const normalized = entities.map((m) => m.normalized);
    expect(normalized).toContain("falcon");
    expect(normalized).toContain("maria lopez");
  });
});

// ============================================================
// Dedup
// ============================================================
describe("parseMentions — dedup by normalized", () => {
  it("collapses the same target mentioned twice (case-insensitive)", () => {
    const out = parseMentions("[[Caixa]] then again [[caixa]]");
    const caixa = out.filter((m) => m.normalized === "caixa");
    expect(caixa.length).toBe(1);
  });
});

// ============================================================
// normalize helper
// ============================================================
describe("normalizeMention", () => {
  it("lowercases and trims", () => {
    expect(normalizeMention("  MixedCase  ")).toBe("mixedcase");
  });
});
