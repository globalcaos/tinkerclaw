import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecipeArchive } from "./recipe-archive.js";
import {
  createInitialRecipeFitness,
  laplace,
  loadRecipeFitness,
  makeFitnessLookup,
} from "./recipe-fitness.js";

// U1 producer-side reader: the matcher's FitnessLookup reads the SAME on-disk
// recipe-archive the cerebellum's sleep-consolidation writes. These tests write
// fitness via the REAL createRecipeArchive (the actual producer) and assert the
// reader resolves it — exercising the real on-disk layout, not a hand-rolled JSON.

describe("loadRecipeFitness — reads the on-disk recipe-archive", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "recipe-fitness-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns the Laplace-neutral default (0.5) when there is no archive", () => {
    expect(loadRecipeFitness(baseDir, "globalcaos/debug").successRate).toBe(laplace(0, 0));
    expect(loadRecipeFitness(baseDir, "debug").successRate).toBe(0.5);
  });

  it("reads the latest variant's successRate for an exact owner/slug recipeId", () => {
    const archive = createRecipeArchive({ baseDir });
    const fitness = createInitialRecipeFitness("globalcaos/debug", 1);
    fitness.runs = 9;
    fitness.successes = 9;
    fitness.successRate = laplace(9, 9); // (9+1)/(9+2) ≈ 0.909
    archive.putVariant("globalcaos/debug", 1, "body", fitness);

    const got = loadRecipeFitness(baseDir, "globalcaos/debug");
    expect(got.successRate).toBeCloseTo(laplace(9, 9), 10);
    expect(got.successRate).toBeGreaterThan(0.5);
  });

  it("resolves a BARE slug to its owner/slug recipeId (matcher keys by bare slug)", () => {
    const archive = createRecipeArchive({ baseDir });
    const fitness = createInitialRecipeFitness("globalcaos/debug", 1);
    fitness.successRate = laplace(8, 8);
    archive.putVariant("globalcaos/debug", 1, "body", fitness);

    // The matcher calls feedback(kit.slug) with the BARE slug "debug".
    const got = loadRecipeFitness(baseDir, "debug");
    expect(got.successRate).toBeCloseTo(laplace(8, 8), 10);
  });

  it("reads the HIGHEST version when multiple variants exist", () => {
    const archive = createRecipeArchive({ baseDir });
    const v1 = createInitialRecipeFitness("globalcaos/debug", 1);
    v1.successRate = 0.6;
    archive.putVariant("globalcaos/debug", 1, "b1", v1);
    const v2 = createInitialRecipeFitness("globalcaos/debug", 2);
    v2.successRate = 0.95;
    archive.putVariant("globalcaos/debug", 2, "b2", v2);

    expect(loadRecipeFitness(baseDir, "debug").successRate).toBe(0.95);
  });
});

describe("makeFitnessLookup — sync FitnessLookup over the on-disk store", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "fitness-lookup-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns the successRate for a measured recipe and undefined for an unmeasured one", () => {
    const archive = createRecipeArchive({ baseDir });
    const f = createInitialRecipeFitness("globalcaos/proven", 1);
    f.successRate = laplace(10, 10);
    archive.putVariant("globalcaos/proven", 1, "body", f);

    const lookup = makeFitnessLookup(baseDir);
    expect(lookup("proven")).toBeCloseTo(laplace(10, 10), 10); // measured → its rate
    expect(lookup("never-run")).toBeUndefined(); // no record → no opinion (matcher delta 0)
  });

  it("is sync (returns a value, not a promise) so scoreRecipe can call it inline", () => {
    const lookup = makeFitnessLookup(baseDir);
    const r = lookup("whatever");
    expect(r instanceof Promise).toBe(false);
  });
});
