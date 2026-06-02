import { describe, it, expect, vi } from "vitest";
import type { RecipeIndexEntry, MatchResult } from "../recipe-matcher.js";
import {
  cosineSimilarity,
  recipeEmbedText,
  shouldRunSemanticLane,
  runSemanticLane,
  blendLexicalSemantic,
  smartMatch,
  makeHttpEmbedFn,
  type EmbedFn,
  type SemanticMatch,
} from "../semantic-matcher.js";

function entry(slug: string, over?: Partial<RecipeIndexEntry>): RecipeIndexEntry {
  return {
    slug,
    title: over?.title ?? slug,
    summary: over?.summary ?? "",
    tags: over?.tags ?? [],
    composes: over?.composes ?? [],
    path: over?.path ?? `/nope/${slug}`,
  };
}

const DEPLOY = entry("deploy", {
  title: "Ship to production",
  summary: "build, test, release the app to prod",
  tags: ["deploy", "ship", "release"],
});
const DEBUG = entry("debug", {
  title: "Debug & Fix",
  summary: "reproduce diagnose fix verify",
  tags: ["debug", "bug", "crash"],
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("is 0 (not NaN) for a zero vector or a length mismatch", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
  it("ranks a closer vector higher", () => {
    const q = [1, 1, 0];
    const near = cosineSimilarity(q, [1, 1, 0.1]);
    const far = cosineSimilarity(q, [1, 0, 1]);
    expect(near).toBeGreaterThan(far);
  });
});

describe("recipeEmbedText", () => {
  it("joins title, summary, and tags", () => {
    const t = recipeEmbedText(DEPLOY);
    expect(t).toContain("Ship to production");
    expect(t).toContain("deploy, ship, release");
  });
  it("drops empty parts cleanly", () => {
    const t = recipeEmbedText(entry("bare", { title: "Bare", summary: "", tags: [] }));
    expect(t).toBe("Bare");
  });
});

describe("shouldRunSemanticLane", () => {
  it("runs on none/low, short-circuits on high", () => {
    expect(shouldRunSemanticLane({ matches: [], confidence: "none" })).toBe(true);
    expect(shouldRunSemanticLane({ matches: [], confidence: "low" })).toBe(true);
    expect(shouldRunSemanticLane({ matches: [], confidence: "high" })).toBe(false);
  });
});

describe("runSemanticLane", () => {
  // A toy embedder: maps known phrases to fixed unit-ish vectors so similarity
  // is deterministic. "push live for customers" ~ the deploy recipe.
  const VECS: Record<string, number[]> = {
    "push my changes live for customers": [1, 0.9, 0],
    [recipeEmbedText(DEPLOY)]: [1, 1, 0],
    [recipeEmbedText(DEBUG)]: [0, 0, 1],
  };
  const stubEmbed: EmbedFn = async (texts) => texts.map((t) => VECS[t] ?? [0.01, 0.01, 0.01]);

  it("returns unavailable when no embed fn is given", async () => {
    const r = await runSemanticLane("anything", [DEPLOY], undefined);
    expect(r.invoked).toBe(false);
    expect(r.unavailable).toBe("no-embed-fn");
    expect(r.matches).toEqual([]);
  });

  it("recovers a paraphrase the lexical lane would miss", async () => {
    const r = await runSemanticLane(
      "push my changes live for customers",
      [DEPLOY, DEBUG],
      stubEmbed,
    );
    expect(r.invoked).toBe(true);
    expect(r.matches[0]?.entry.slug).toBe("deploy");
    expect(r.matches[0]?.similarity).toBeGreaterThan(0.9);
    // debug is well below threshold and must not appear
    expect(r.matches.map((m) => m.entry.slug)).not.toContain("debug");
  });

  it("filters by minSimilarity", async () => {
    const r = await runSemanticLane(
      "push my changes live for customers",
      [DEPLOY, DEBUG],
      stubEmbed,
      { minSimilarity: 0.99 },
    );
    // Only deploy clears the very high bar (sim ~0.998); debug (~0) drops.
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]?.entry.slug).toBe("deploy");
  });

  it("degrades gracefully when embed throws", async () => {
    const boom: EmbedFn = async () => {
      throw new Error("endpoint disabled");
    };
    const r = await runSemanticLane("x", [DEPLOY], boom);
    expect(r.invoked).toBe(true);
    expect(r.matches).toEqual([]);
    expect(r.unavailable).toContain("embed-failed");
    expect(r.unavailable).toContain("endpoint disabled");
  });

  it("degrades gracefully on a shape mismatch (wrong vector count)", async () => {
    const wrong: EmbedFn = async () => [[1, 2, 3]]; // expected texts.length vectors
    const r = await runSemanticLane("x", [DEPLOY, DEBUG], wrong);
    expect(r.invoked).toBe(true);
    expect(r.unavailable).toBe("embed-shape-mismatch");
  });

  it("skips a candidate whose vector dimension disagrees with the prompt", async () => {
    const ragged: EmbedFn = async (texts) =>
      texts.map((_, i) => (i === 0 ? [1, 1, 0] : i === 1 ? [1, 1] /* bad dim */ : [1, 1, 0]));
    const r = await runSemanticLane("q", [DEPLOY, DEBUG], ragged);
    expect(r.invoked).toBe(true);
    // first candidate skipped (bad dim), second compared
    expect(r.matches.every((m) => m.entry.slug !== "deploy")).toBe(true);
  });
});

describe("blendLexicalSemantic", () => {
  it("keeps lexical matches leading and preserves their scores", () => {
    const lexical: MatchResult = {
      matches: [{ entry: DEBUG, score: 7 }],
      confidence: "low",
    };
    const semantic: SemanticMatch[] = [{ entry: DEPLOY, similarity: 0.5 }];
    const blended = blendLexicalSemantic(lexical, semantic);
    expect(blended.matches[0]?.entry.slug).toBe("debug");
    expect(blended.matches[0]?.score).toBe(7);
    // deploy recovered as a synthetic score below the lexical leader
    expect(blended.matches.some((m) => m.entry.slug === "deploy")).toBe(true);
    expect(blended.matches.find((m) => m.entry.slug === "deploy")!.score).toBeLessThan(7);
  });

  it("recovers a semantic-only match at low confidence", () => {
    const lexical: MatchResult = { matches: [], confidence: "none" };
    const semantic: SemanticMatch[] = [{ entry: DEPLOY, similarity: 0.85 }];
    const blended = blendLexicalSemantic(lexical, semantic);
    expect(blended.matches[0]?.entry.slug).toBe("deploy");
    expect(blended.matches[0]?.score).toBeGreaterThanOrEqual(3); // clears threshold → seeds a plan
    expect(blended.confidence).toBe("low"); // softer evidence than a curated tag hit
  });

  it("maps stronger similarity to a higher synthetic score", () => {
    const lexical: MatchResult = { matches: [], confidence: "none" };
    const weak = blendLexicalSemantic(lexical, [{ entry: DEPLOY, similarity: 0.5 }]);
    const strong = blendLexicalSemantic(lexical, [{ entry: DEPLOY, similarity: 0.95 }]);
    expect(strong.matches[0]!.score).toBeGreaterThan(weak.matches[0]!.score);
  });

  it("promotes to high when both lanes agree on a clear leader", () => {
    const lexical: MatchResult = {
      matches: [
        { entry: DEPLOY, score: 6 },
        { entry: DEBUG, score: 2 },
      ],
      confidence: "low",
    };
    const semantic: SemanticMatch[] = [{ entry: DEPLOY, similarity: 0.9 }];
    const blended = blendLexicalSemantic(lexical, semantic);
    expect(blended.matches[0]?.entry.slug).toBe("deploy");
    expect(blended.matches[0]?.score).toBe(7); // 6 + agreement bonus
    expect(blended.confidence).toBe("high");
  });

  it("agreement bonus is small — it does not leapfrog a stronger lexical hit", () => {
    const lexical: MatchResult = {
      matches: [
        { entry: DEBUG, score: 9 },
        { entry: DEPLOY, score: 4 },
      ],
      confidence: "low",
    };
    // semantic likes deploy, but the +1 agreement bonus can't overtake debug's 9
    const blended = blendLexicalSemantic(lexical, [{ entry: DEPLOY, similarity: 0.99 }]);
    expect(blended.matches[0]?.entry.slug).toBe("debug");
  });

  it("respects max", () => {
    const lexical: MatchResult = {
      matches: [
        { entry: entry("a"), score: 5 },
        { entry: entry("b"), score: 4 },
      ],
      confidence: "low",
    };
    const semantic: SemanticMatch[] = [
      { entry: entry("c"), similarity: 0.9 },
      { entry: entry("d"), similarity: 0.8 },
    ];
    const blended = blendLexicalSemantic(lexical, semantic, { max: 2 });
    expect(blended.matches.length).toBe(2);
  });
});

describe("smartMatch — lexical-first / semantic-fallback orchestration", () => {
  const stubEmbed: EmbedFn = async (texts) => {
    const VECS: Record<string, number[]> = {
      "push my changes live for customers": [1, 0.95, 0],
      [recipeEmbedText(DEPLOY)]: [1, 1, 0],
      [recipeEmbedText(DEBUG)]: [0, 0, 1],
    };
    return texts.map((t) => VECS[t] ?? [0.01, 0.01, 0.01]);
  };

  it("short-circuits on lexical high — never calls embed", async () => {
    const embed = vi.fn(stubEmbed);
    const lexical: MatchResult = {
      matches: [{ entry: DEBUG, score: 9 }],
      confidence: "high",
    };
    const r = await smartMatch({ lexical, prompt: "debug the crash", index: [DEBUG], embed });
    expect(embed).not.toHaveBeenCalled();
    expect(r.semanticInvoked).toBe(false);
    expect(r.matches[0]?.entry.slug).toBe("debug");
    expect(r.recoveredBySemantic).toEqual([]);
  });

  it("recovers a paraphrase NO-MATCH via the semantic lane", async () => {
    // Lexical whiffs entirely on the paraphrase.
    const lexical: MatchResult = { matches: [], confidence: "none" };
    const r = await smartMatch({
      lexical,
      prompt: "push my changes live for customers",
      index: [DEPLOY, DEBUG],
      embed: stubEmbed,
    });
    expect(r.semanticInvoked).toBe(true);
    expect(r.matches[0]?.entry.slug).toBe("deploy");
    expect(r.recoveredBySemantic).toContain("deploy");
    expect(r.confidence).toBe("low");
    // and it cleared threshold so the caller would seed a plan
    expect(r.matches[0]!.score).toBeGreaterThanOrEqual(3);
  });

  it("falls back to lexical-only when no embed seam is wired", async () => {
    const lexical: MatchResult = { matches: [], confidence: "none" };
    const r = await smartMatch({
      lexical,
      prompt: "push my changes live for customers",
      index: [DEPLOY],
      // no embed
    });
    expect(r.semanticInvoked).toBe(false);
    expect(r.semanticUnavailable).toBe("no-embed-fn");
    expect(r.matches).toEqual([]);
    expect(r.confidence).toBe("none");
  });

  it("falls back to lexical-only when the embed seam throws (endpoint disabled)", async () => {
    const lexical: MatchResult = {
      matches: [{ entry: DEBUG, score: 3 }],
      confidence: "low",
    };
    const boom: EmbedFn = async () => {
      throw new Error("openAiCompat disabled");
    };
    const r = await smartMatch({
      lexical,
      prompt: "fix the thing",
      index: [DEBUG, DEPLOY],
      embed: boom,
    });
    expect(r.semanticInvoked).toBe(true);
    expect(r.semanticUnavailable).toContain("embed-failed");
    // graceful: original lexical result is preserved
    expect(r.matches[0]?.entry.slug).toBe("debug");
    expect(r.matches[0]?.score).toBe(3);
    expect(r.recoveredBySemantic).toEqual([]);
  });
});

describe("makeHttpEmbedFn — reference /v1/embeddings adapter", () => {
  it("POSTs the OpenAI shape and parses data[].embedding", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({
        object: "list",
        data: [
          { object: "embedding", index: 0, embedding: [0.1, 0.2] },
          { object: "embedding", index: 1, embedding: [0.3, 0.4] },
        ],
      }),
      text: async () => "",
    }));
    const embed = makeHttpEmbedFn({ baseUrl: "http://127.0.0.1:7777", fetchImpl });
    const out = await embed(["a", "b"]);
    expect(out).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/v1/embeddings");
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({
      model: "openclaw",
      input: ["a", "b"],
    });
  });

  it("reorders by the returned index field", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { index: 1, embedding: [9, 9] },
          { index: 0, embedding: [1, 1] },
        ],
      }),
      text: async () => "",
    }));
    const embed = makeHttpEmbedFn({ baseUrl: "http://x", fetchImpl });
    const out = await embed(["first", "second"]);
    expect(out[0]).toEqual([1, 1]);
    expect(out[1]).toEqual([9, 9]);
  });

  it("throws on a non-200 so the lane treats it as unavailable", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "service unavailable",
    }));
    const embed = makeHttpEmbedFn({ baseUrl: "http://x", fetchImpl });
    await expect(embed(["a"])).rejects.toThrow(/503/);
  });
});
