import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  invalidateRecipeIndexCache,
  loadRecipeIndex,
  recipeIndexExtraDirs,
} from "../recipe-matcher.js";
import { createRecipeRpcs, type KitRpcsDeps } from "../recipe-rpcs.js";
import { RecipeStore } from "../recipe-store.js";

// The extract RPC end to end on a fixture library: the overlay is found first, the matcher sees the new recipe, a
// refusal is a typed result with nothing written, and bad params are an error.

const PARENT = `---
schema: "kit/1.0"
slug: "trip-plan"
title: "Plan a trip"
summary: "Plan a trip from the dates to a brief."
version: "1.0.0"
owner: "globalcaos"
category: "operations"
tags: ["trip"]
authoredBy: "jarvis"
params:
  destination: { type: "string", required: true }
---
# Plan a trip

## Steps

### 1. Pick the dates

Choose dates for {{destination}}.

### 2. Find flights

Search flights to {{destination}}.
`;

let tmp: string;
let own: string;
let overlay: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.OPENCLAW_HOME;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "extract-rpc-"));
  own = path.join(tmp, "own");
  overlay = path.join(tmp, "home", "recipes");
  process.env.OPENCLAW_HOME = path.join(tmp, "home");
  await fs.mkdir(own, { recursive: true });
  await fs.mkdir(overlay, { recursive: true });
  invalidateRecipeIndexCache();
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
  invalidateRecipeIndexCache();
});

const rpcs = () =>
  createRecipeRpcs({
    store: new RecipeStore({ rootDir: path.join(tmp, "sandbox") }),
    baseUrl: "https://example.invalid",
    apiKey: "k",
    recipeInstallSandbox: path.join(tmp, "sandbox"),
    ownRecipesDir: own,
  } as KitRpcsDeps);

describe("prefrontal.recipe.extract", () => {
  it("lifts the step out of an overlay recipe, creates the child beside it, and the matcher finds it", async () => {
    await fs.mkdir(path.join(overlay, "trip-plan"), { recursive: true });
    await fs.writeFile(path.join(overlay, "trip-plan", "recipe.md"), PARENT);
    const r = (await rpcs()["prefrontal.recipe.extract"]({
      from: "trip-plan",
      section: "Find flights",
      slug: "flight-search-step",
      title: "Search flights for a trip",
    })) as { ok: boolean; path: string; kitRef: string; paramsMoved: string[] };
    expect(r.ok).toBe(true);
    expect(r.path).toBe(path.join(overlay, "flight-search-step", "recipe.md"));
    expect(r.kitRef).toBe("globalcaos/flight-search-step");
    expect(r.paramsMoved).toEqual(["destination"]);
    const parent = await fs.readFile(path.join(overlay, "trip-plan", "recipe.md"), "utf-8");
    expect(parent).toContain("uses: flight-search-step");
    const index = await loadRecipeIndex(own, recipeIndexExtraDirs(path.join(tmp, "bridged")));
    expect(index.find((e) => e.slug === "flight-search-step")).toBeTruthy();
  });

  it("is in the handler map the plugin registers (the kit.* alias is added by the plugin's rename loop)", async () => {
    expect(Object.keys(rpcs())).toContain("prefrontal.recipe.extract");
  });

  it("a refusal is a typed result with every reason, and the library is untouched", async () => {
    await fs.mkdir(path.join(own, "trip-plan"), { recursive: true });
    const file = path.join(own, "trip-plan", "recipe.md");
    await fs.writeFile(
      file,
      PARENT.replace("Search flights to {{destination}}.", "Search {{nowhere}}."),
    );
    const before = await fs.readFile(file, "utf-8");
    const r = (await rpcs()["prefrontal.recipe.extract"]({
      from: "trip-plan",
      section: "2",
      slug: "flight-search-step",
      title: "Search flights",
    })) as { ok: boolean; refused: string[] };
    expect(r.ok).toBe(false);
    expect(r.refused.join(" ")).toContain("{{nowhere}}");
    expect(await fs.readFile(file, "utf-8")).toBe(before);
    await expect(fs.stat(path.join(own, "flight-search-step"))).rejects.toThrow();
  });

  it("throws on a missing or empty param, naming it", async () => {
    await expect(
      rpcs()["prefrontal.recipe.extract"]({ from: "trip-plan", section: "2", slug: "x-step" }),
    ).rejects.toThrow(/title \(non-empty string\) required/);
    await expect(
      rpcs()["prefrontal.recipe.extract"]({ from: " ", section: "2", slug: "x-step", title: "t" }),
    ).rejects.toThrow(/from/);
  });
});
