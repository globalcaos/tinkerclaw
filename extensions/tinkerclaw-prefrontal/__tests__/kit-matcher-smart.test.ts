import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  tokenMatches,
  matchKitsDetailed,
  buildMergedPlan,
  loadKitIndex,
  invalidateKitIndexCache,
  scoreKit,
  seedPlanFromPrompt,
  fitnessFeedbackDelta,
  ratingScoreDelta,
  RATING_CLAMP,
  type KitIndexEntry,
} from "../kit-matcher.js";

describe("tokenMatches — fuzzy/stemmed matching", () => {
  it("matches inflections and typos", () => {
    expect(tokenMatches("debugging", "debug")).toBe(true);
    expect(tokenMatches("tests", "test")).toBe(true);
    expect(tokenMatches("crashes", "crash")).toBe(true);
    expect(tokenMatches("optimize", "optimise")).toBe(true);
  });
  it("does not over-match unrelated short tokens", () => {
    expect(tokenMatches("cat", "dog")).toBe(false);
    expect(tokenMatches("hello", "help")).toBe(false);
  });
});

describe("matchKitsDetailed — scoring + confidence", () => {
  const index: KitIndexEntry[] = [
    {
      slug: "debug",
      title: "Debug & Fix",
      summary: "reproduce diagnose fix verify",
      tags: ["debug", "bug", "crash", "error"],
      composes: [],
      path: "/nope",
    },
    {
      slug: "write-paper",
      title: "Write Paper",
      summary: "draft a manuscript",
      tags: ["paper", "write"],
      composes: [],
      path: "/nope",
    },
  ];

  it("high confidence for a clear single winner", () => {
    const r = matchKitsDetailed("debug the crash, it throws an error", index);
    expect(r.matches[0]?.entry.slug).toBe("debug");
    expect(r.confidence).toBe("high");
  });

  it("fuzzy match still scores (debugging → debug)", () => {
    const r = matchKitsDetailed("debugging a crashing process", index);
    expect(r.matches[0]?.entry.slug).toBe("debug");
    expect(r.confidence).not.toBe("none");
  });

  it("none when nothing clears threshold", () => {
    const r = matchKitsDetailed("xyzzy plugh frobnicate", index);
    expect(r.matches.length).toBe(0);
    expect(r.confidence).toBe("none");
  });
});

// U1 (2026-06): empirical-fitness feedback boosts the matcher so a proven recipe
// outranks an equally-relevant unproven one. The delta is post-base-score and the
// LEXICAL base is a FLOOR — fitness can only RAISE a kit, never bury a relevant one.
describe("fitnessFeedbackDelta — non-negative fitness boost", () => {
  it("returns 0 for unknown / neutral / below-neutral fitness (floor preserved)", () => {
    expect(fitnessFeedbackDelta(undefined)).toBe(0);
    expect(fitnessFeedbackDelta(0.5)).toBe(0); // neutral
    expect(fitnessFeedbackDelta(0.1)).toBe(0); // poor recipe is never demoted by the matcher
    expect(fitnessFeedbackDelta(0)).toBe(0);
  });
  it("returns a positive, bounded boost for above-neutral fitness", () => {
    const good = fitnessFeedbackDelta(0.9);
    const ok = fitnessFeedbackDelta(0.7);
    expect(good).toBeGreaterThan(0);
    expect(ok).toBeGreaterThan(0);
    expect(good).toBeGreaterThanOrEqual(ok); // monotone in fitness
  });
  it("caps the boost so feedback never dominates the lexical signal", () => {
    expect(fitnessFeedbackDelta(1.0)).toBeLessThanOrEqual(3);
  });
});

describe("scoreKit — feedback delta is additive, base is a floor", () => {
  const kit: KitIndexEntry = {
    slug: "debug",
    title: "Debug & Fix",
    summary: "reproduce diagnose fix verify",
    tags: ["debug", "bug", "crash", "error"],
    composes: [],
    path: "/nope",
  };
  const prompt = "debug the crash, it throws an error";
  const tokens = new Set(
    (prompt.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2),
  );

  it("without feedback, score is the pure lexical base", () => {
    const base = scoreKit(prompt, tokens, kit);
    expect(base).toBeGreaterThan(0);
  });

  it("a proven recipe scores STRICTLY higher than its lexical base", () => {
    const base = scoreKit(prompt, tokens, kit);
    const boosted = scoreKit(prompt, tokens, kit, () => 0.95);
    expect(boosted).toBeGreaterThan(base);
    expect(boosted).toBe(base + fitnessFeedbackDelta(0.95));
  });

  it("a poor / unknown recipe never falls BELOW its lexical base (floor)", () => {
    const base = scoreKit(prompt, tokens, kit);
    expect(scoreKit(prompt, tokens, kit, () => 0.05)).toBe(base); // poor → no demotion
    expect(scoreKit(prompt, tokens, kit, () => undefined)).toBe(base); // unknown → base
  });

  it("re-ranks: a proven kit overtakes an equally-relevant unproven one", () => {
    const a: KitIndexEntry = { ...kit, slug: "a" };
    const b: KitIndexEntry = { ...kit, slug: "b" };
    const feedback = (slug: string) => (slug === "b" ? 0.95 : undefined);
    const sa = scoreKit(prompt, tokens, a, feedback);
    const sb = scoreKit(prompt, tokens, b, feedback);
    expect(sb).toBeGreaterThan(sa);
  });
});

// U12 (2026-06-01): a CLAMPED (±0.2) marketplace-rating tie-breaker that COMPOSES
// with U1's feedback weight. Precedence is base → feedback → rating: rating is the
// weakest signal and can only break ties, never overturn relevance or fitness.
describe("ratingScoreDelta — clamped ±0.2 popularity nudge", () => {
  it("is 0 for unknown / neutral (midpoint) rating", () => {
    expect(ratingScoreDelta(undefined)).toBe(0);
    expect(ratingScoreDelta(1)).toBe(0); // 1.0 is the centered midpoint → no nudge
  });
  it("clamps both directions to ±0.2", () => {
    expect(ratingScoreDelta(2)).toBeCloseTo(RATING_CLAMP, 10); // max popularity → +0.2
    expect(ratingScoreDelta(0)).toBeCloseTo(-RATING_CLAMP, 10); // unpopular → -0.2
    // Even an out-of-range value stays clamped.
    expect(ratingScoreDelta(99)).toBeLessThanOrEqual(RATING_CLAMP);
    expect(ratingScoreDelta(-99)).toBeGreaterThanOrEqual(-RATING_CLAMP);
  });
});

describe("scoreKit — rating composes with feedback (precedence base → feedback → rating)", () => {
  const kit: KitIndexEntry = {
    slug: "debug",
    title: "Debug & Fix",
    summary: "reproduce diagnose fix verify",
    tags: ["debug", "bug", "crash", "error"],
    composes: [],
    path: "/nope",
  };
  const prompt = "debug the crash, it throws an error";
  const tokens = new Set(
    (prompt.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2),
  );

  it("adds the rating delta ON TOP of base + feedback", () => {
    const base = scoreKit(prompt, tokens, kit);
    const withFeedback = scoreKit(prompt, tokens, kit, () => 0.95);
    const withBoth = scoreKit(
      prompt,
      tokens,
      kit,
      () => 0.95,
      () => 2,
    );
    // rating is additive after feedback: base + feedbackDelta + ratingDelta.
    expect(withBoth).toBeCloseTo(base + fitnessFeedbackDelta(0.95) + ratingScoreDelta(2), 10);
    expect(withBoth).toBeGreaterThan(withFeedback);
  });

  it("rating alone never overturns a fitness lead (feedback dominates)", () => {
    // recipe A: high fitness, no rating. recipe B: no fitness, max rating.
    const a: KitIndexEntry = { ...kit, slug: "a" };
    const b: KitIndexEntry = { ...kit, slug: "b" };
    const feedback = (slug: string) => (slug === "a" ? 0.95 : undefined);
    const rating = (slug: string) => (slug === "b" ? 2 : undefined);
    const sa = scoreKit(prompt, tokens, a, feedback, rating);
    const sb = scoreKit(prompt, tokens, b, feedback, rating);
    // The integer fitness boost (>=1) dwarfs the ±0.2 rating clamp → A still wins.
    expect(sa).toBeGreaterThan(sb);
  });

  it("rating breaks a tie between two equally-relevant, equally-unproven recipes", () => {
    const a: KitIndexEntry = { ...kit, slug: "a" };
    const b: KitIndexEntry = { ...kit, slug: "b" };
    const rating = (slug: string) => (slug === "b" ? 2 : 0);
    const sa = scoreKit(prompt, tokens, a, undefined, rating);
    const sb = scoreKit(prompt, tokens, b, undefined, rating);
    expect(sb).toBeGreaterThan(sa); // popular one edges ahead within the clamp
  });
});

describe("buildMergedPlan — composition via composes:", () => {
  let dir: string;
  let index: KitIndexEntry[];
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-compose-"));
    const subMd = `---\nslug: "sub"\ntitle: "Sub"\nsummary: "s"\ntags: ["sub"]\n---\n## Steps\n### 1. SubStepA\nbody\n### 2. SubStepB\nbody\n`;
    const topMd = `---\nslug: "top"\ntitle: "Top"\nsummary: "t"\ntags: ["top"]\ncomposes: ["sub"]\n---\n## Steps\n### 1. TopStep\nbody\n`;
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.mkdir(path.join(dir, "top"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "kit.md"), subMd);
    await fs.writeFile(path.join(dir, "top", "kit.md"), topMd);
    invalidateKitIndexCache();
    index = await loadKitIndex(dir);
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    invalidateKitIndexCache();
  });

  it("loads composes from frontmatter", () => {
    const top = index.find((e) => e.slug === "top");
    expect(top?.composes).toEqual(["sub"]);
  });

  it("pulls composed kit's steps in ahead of the composer's own", async () => {
    const top = index.find((e) => e.slug === "top")!;
    const plan = await buildMergedPlan([{ entry: top, score: 5 }], index);
    expect(plan.composedFrom).toContain("sub");
    expect(plan.kitRefs).toContain("sub");
    const titles = plan.steps.map((s) => s.title);
    expect(titles).toEqual(["SubStepA", "SubStepB", "TopStep"]);
  });
});

// U11 (2026-06-01): loadKitIndex scans an extra bridged-skills dir so imported CC
// SKILL.md recipes are matchable alongside curated kits; own-kits win on a slug
// collision (a bridged import can never shadow a curated kit of the same slug).
describe("loadKitIndex — extraDirs (bridged-skills) scan", () => {
  let ownDir: string;
  let extraDir: string;
  beforeAll(async () => {
    ownDir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-own-"));
    extraDir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-bridged-"));
    const curated = `---\nslug: "shared"\ntitle: "Curated Shared"\nsummary: "the curated one"\ntags: ["shared"]\n---\n### 1. Curated\nbody\n`;
    const bridged = `---\nslug: "imported"\ntitle: "Imported"\nsummary: "from a cc skill"\ntags: ["imported"]\nauthoredBy: "cc-bridge"\n---\n### 1. Imported step\nbody\n`;
    const bridgedShadow = `---\nslug: "shared"\ntitle: "Bridged Shadow"\nsummary: "should NOT win"\ntags: ["shared"]\nauthoredBy: "cc-bridge"\n---\n### 1. Shadow\nbody\n`;
    await fs.mkdir(path.join(ownDir, "shared"), { recursive: true });
    await fs.writeFile(path.join(ownDir, "shared", "kit.md"), curated);
    await fs.mkdir(path.join(extraDir, "imported"), { recursive: true });
    await fs.writeFile(path.join(extraDir, "imported", "kit.md"), bridged);
    await fs.mkdir(path.join(extraDir, "shared"), { recursive: true });
    await fs.writeFile(path.join(extraDir, "shared", "kit.md"), bridgedShadow);
    invalidateKitIndexCache();
  });
  afterAll(async () => {
    await fs.rm(ownDir, { recursive: true, force: true });
    await fs.rm(extraDir, { recursive: true, force: true });
    invalidateKitIndexCache();
  });

  it("includes bridged imports from the extra dir", async () => {
    const index = await loadKitIndex(ownDir, [extraDir]);
    expect(index.find((e) => e.slug === "imported")).toBeTruthy();
  });

  it("own-kits win on a slug collision (bridged cannot shadow curated)", async () => {
    invalidateKitIndexCache();
    const index = await loadKitIndex(ownDir, [extraDir]);
    const shared = index.filter((e) => e.slug === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0].title).toBe("Curated Shared"); // the own-kits entry, not the bridged shadow
  });

  it("a missing extra dir is not an error (empty contribution)", async () => {
    invalidateKitIndexCache();
    const index = await loadKitIndex(ownDir, [path.join(extraDir, "does-not-exist")]);
    expect(index.find((e) => e.slug === "shared")).toBeTruthy();
    expect(index.find((e) => e.slug === "imported")).toBeFalsy();
  });
});

// U1 + U12 PRODUCER WIRING: the turn-start seed (seedPlanFromPrompt) must thread
// the injected feedback + rating lookups into matchKitsDetailed. Before this wiring
// the deps existed but seedPlanFromPrompt called the matcher WITHOUT them, so the
// fitness/rating signals were inert at the real turn-start call site.
describe("seedPlanFromPrompt — threads feedback + rating into the match", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "seed-feedback-"));
    const kitMd = `---\nslug: "debug"\ntitle: "Debug & Fix"\nsummary: "reproduce diagnose fix verify"\ntags: ["debug", "bug", "crash", "error"]\n---\n### 1. Repro\nbody\n`;
    await fs.mkdir(path.join(dir, "debug"), { recursive: true });
    await fs.writeFile(path.join(dir, "debug", "kit.md"), kitMd);
    invalidateKitIndexCache();
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    invalidateKitIndexCache();
  });

  it("consults the deps' feedback + rating lookups while scoring at the seed call site", async () => {
    invalidateKitIndexCache();
    // Proof that the producer fires: the injected lookups are CONSULTED with the
    // catalog slug during the real turn-start scoring pass. seedPlanFromPrompt calls
    // its sibling matchKitsDetailed directly (intra-module), so we assert behaviour
    // (the lookups being invoked) rather than spying the local call.
    const feedback = vi.fn((slug: string) => (slug === "debug" ? 0.95 : undefined));
    const rating = vi.fn((slug: string) => (slug === "debug" ? 2 : undefined));
    const planStore = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue({ runId: "r1" }),
    };
    const outcome = await seedPlanFromPrompt({
      prompt: "debug the crash error",
      sessionKey: "agent:main:main",
      runId: "r1",
      ownKitsDir: dir,
      planStore,
      feedback,
      rating,
    });
    expect(feedback).toHaveBeenCalledWith("debug");
    expect(rating).toHaveBeenCalledWith("debug");
    // And the high-fitness boost made the match seed a plan (end-to-end effect).
    expect(outcome.matches.some((m) => m.slug === "debug")).toBe(true);
  });

  it("WITHOUT feedback/rating the lookups are never consulted (back-compat / inert when unwired)", async () => {
    invalidateKitIndexCache();
    const planStore = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue({ runId: "r2" }),
    };
    // No feedback/rating supplied → pure lexical (the historical, pre-wiring path).
    const outcome = await seedPlanFromPrompt({
      prompt: "debug the crash error",
      sessionKey: "agent:main:main",
      runId: "r2",
      ownKitsDir: dir,
      planStore,
    });
    expect(outcome.matches.some((m) => m.slug === "debug")).toBe(true);
  });
});
