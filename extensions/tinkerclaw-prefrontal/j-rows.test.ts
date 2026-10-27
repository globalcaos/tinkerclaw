/**
 * The J-series `j.*` rows produced under extensions/ — TINKER_UI_DESIGN_BIBLE/logging.md §4.12
 * (§9 step 9), the prefrontal half: J16 `j.bound.derived` (spawn, recovery, redispatch),
 * J17 `j.recipe.parse`, J13 `j.recipe.match` and `j.recipe.run`.
 *
 * CONTROL: before this change none of these producers exists, so every expectation below fails on
 * zero emitEvent calls.
 *
 * WHAT THIS PINS, and what it deliberately does not. The rows themselves — schema, retention,
 * views, the L4 field filter — are core's to test (src/infra/events/*.test.ts). What is checked
 * here is that the PRODUCER fires, exactly once per unit of work, with the declared name and the
 * declared MEANING of label/n1..n4. A green build cannot otherwise tell a live metric from one
 * that does nothing (VERIFICATION DISCIPLINE #2), which is precisely how J3's success rate sat at
 * zero for eight weeks without anyone noticing.
 *
 * `emitEvent` is mocked at the plugin-sdk subpath, so no writer, no worker thread and no database
 * are involved: the assertions are about the CALL, which is the part this extension owns.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateRecipeIndexCache, seedPlanFromPrompt } from "./recipe-matcher.js";
import { parseRecipeMd } from "./recipe-parse.js";
import { runRecipe } from "./recipe-runner.js";
import { deriveRecoveryRetryBudget } from "./recovery-budget.js";
import { deriveRedispatchBudget } from "./redispatch-budget.js";
import { deriveSpawnBudget } from "./spawn-budget.js";

type EmittedRow = { name: string; record: Record<string, unknown> };

const emitted = vi.hoisted(() => ({ rows: [] as EmittedRow[] }));

vi.mock("openclaw/plugin-sdk/fork-telemetry", () => ({
  emitEvent: (name: string, record: Record<string, unknown> = {}) => {
    emitted.rows.push({ name, record });
  },
}));

const rowsNamed = (name: string): EmittedRow[] => emitted.rows.filter((r) => r.name === name);

beforeEach(() => {
  emitted.rows.length = 0;
});

describe("J16 j.bound.derived — the spawn fan-out bound", () => {
  it("writes one row whose n1 IS the value the caller got back", () => {
    const units = deriveSpawnBudget({
      requiredFieldCount: 6,
      skillInvoked: true,
      fitnessSuccessRate: 0.2,
    });

    const rows = rowsNamed("j.bound.derived");
    expect(rows).toHaveLength(1);
    expect(rows[0].record.label).toBe("spawn");
    // The row must carry the ANSWER, not the pre-clamp derivation: a row that disagreed with the
    // returned bound would make every J16 query describe a number nothing acted on.
    expect(rows[0].record.n1).toBe(units);
    // No budget threaded: the ceiling is an honest NULL, never Infinity (which the writer would
    // reject and count as an invalid value) and never 0.
    expect(rows[0].record.n2).toBeNull();
    // sample_size: three of the five signals were supplied.
    expect(rows[0].record.n4).toBe(3);
  });

  it("n3 says the ceiling BIT, not merely that a ceiling exists", () => {
    // No budget threaded → the affordability clamp is inert, so it cannot have fired.
    deriveSpawnBudget({ requiredFieldCount: 6, skillInvoked: true, fitnessSuccessRate: 0.2 });
    expect(rowsNamed("j.bound.derived")[0].record.n3).toBe(0);

    emitted.rows.length = 0;
    // A budget that pays for exactly one spawn, against a derivation that wanted several.
    const units = deriveSpawnBudget({
      requiredFieldCount: 8,
      skillInvoked: true,
      fitnessSuccessRate: 0,
      remainingTokenBudget: 100,
      estStepTokens: 100,
    });
    const row = rowsNamed("j.bound.derived")[0];
    expect(units).toBe(1);
    expect(row.record.n1).toBe(1);
    expect(row.record.n2).toBe(1);
    expect(row.record.n3).toBe(1);
    expect(row.record.n4).toBe(5);
  });
});

describe("J16 j.bound.derived — the recovery-retry and schema-redispatch bounds", () => {
  it("recovery: one row labelled recovery, n1 = the returned bound, ceiling that bit", () => {
    const retries = deriveRecoveryRetryBudget({
      fitnessSuccessRate: 0,
      remainingDispatchBudget: 200,
      estStepTokens: 100,
    });
    const rows = rowsNamed("j.bound.derived");
    expect(rows).toHaveLength(1);
    expect(rows[0].record).toMatchObject({ label: "recovery", n1: retries, n2: 2, n3: 1, n4: 3 });
    // A wholly unreliable recipe derives 3 attempts; a budget for 2 is what set the answer.
    expect(retries).toBe(2);
  });

  it("redispatch: one row labelled redispatch; an inert ceiling is NULL and did not fire", () => {
    const redispatches = deriveRedispatchBudget({ requiredFieldCount: 4 });
    const rows = rowsNamed("j.bound.derived");
    expect(rows).toHaveLength(1);
    expect(rows[0].record).toMatchObject({
      label: "redispatch",
      n1: redispatches,
      n2: null,
      n3: 0,
      n4: 1,
    });
  });
});

describe("J17 j.recipe.parse — the grammar's verdict", () => {
  const STEP = "### 1. Do the thing\n\nbody text\n";

  it("labels a well-formed recipe ok, once", () => {
    parseRecipeMd(`---\nslug: demo\ntitle: Demo\n---\n\n${STEP}`);
    expect(rowsNamed("j.recipe.parse").map((r) => r.record.label)).toEqual(["ok"]);
  });

  it("classifies missing frontmatter WITHOUT changing what the tolerant parser returns", () => {
    const spec = parseRecipeMd(STEP);
    // The parse stays lenient — validateRecipeSpec is the hard gate, and this row must not
    // become a second gate by accident.
    expect(spec.slug).toBe("unknown");
    expect(spec.steps).toHaveLength(1);
    expect(rowsNamed("j.recipe.parse")[0].record.label).toBe("rejected.no_frontmatter");
  });

  it("classifies a recipe with frontmatter but no parsable step", () => {
    parseRecipeMd("---\nslug: demo\ntitle: Demo\n---\n\njust prose, no numbered heading\n");
    expect(rowsNamed("j.recipe.parse")[0].record.label).toBe("rejected.no_steps");
  });

  it("classifies a recipe with steps but no slug", () => {
    parseRecipeMd(`---\ntitle: Demo\n---\n\n${STEP}`);
    expect(rowsNamed("j.recipe.parse")[0].record.label).toBe("rejected.no_slug");
  });

  it("carries no prompt text, path or slug — the label is the whole payload (L4)", () => {
    parseRecipeMd(`---\nslug: demo\ntitle: Demo\n---\n\n${STEP}`);
    expect(Object.keys(rowsNamed("j.recipe.parse")[0].record)).toEqual(["label"]);
  });
});

describe("J13 j.recipe.match — one row per prompt that reached the matcher", () => {
  const planStore = {
    get: async () => null,
    set: async () => ({}),
  };

  async function withCatalog(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "j-rows-match-"));
    try {
      await mkdir(join(dir, "debug"), { recursive: true });
      await writeFile(
        join(dir, "debug", "kit.md"),
        `---\nslug: "debug"\ntitle: "Debug & Fix"\nsummary: "reproduce diagnose fix verify"\ntags: ["debug", "bug", "crash", "error"]\n---\n### 1. Reproduce\nbody\n`,
      );
      invalidateRecipeIndexCache();
      await fn(dir);
    } finally {
      invalidateRecipeIndexCache();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("labels a single winning recipe matched, with its score and the catalog size", async () => {
    await withCatalog(async (dir) => {
      const outcome = await seedPlanFromPrompt({
        prompt: "debug the crash, it throws an error",
        sessionKey: "test:j-rows",
        runId: "run-1",
        ownRecipesDir: dir,
        planStore,
      });
      const rows = rowsNamed("j.recipe.match");
      expect(rows).toHaveLength(1);
      expect(rows[0].record.label).toBe("matched");
      expect(rows[0].record.n1).toBe(outcome.matches[0]?.score);
      expect(rows[0].record.n2).toBe(outcome.catalogSize);
    });
  });

  it("labels a prompt nothing clears threshold for no_match, and carries no prompt text", async () => {
    await withCatalog(async (dir) => {
      await seedPlanFromPrompt({
        prompt: "xyzzy plugh frobnicate",
        sessionKey: "test:j-rows",
        runId: "run-2",
        ownRecipesDir: dir,
        planStore,
      });
      const rows = rowsNamed("j.recipe.match");
      expect(rows).toHaveLength(1);
      expect(rows[0].record).toMatchObject({ label: "no_match", n1: 0, n2: 1 });
      expect(JSON.stringify(rows[0].record)).not.toContain("xyzzy");
    });
  });

  it("writes nothing for a kit-completion re-injection (it never reaches the matcher)", async () => {
    await withCatalog(async (dir) => {
      await seedPlanFromPrompt({
        prompt: "__KIT_DONE__ debug",
        sessionKey: "test:j-rows",
        runId: "run-3",
        ownRecipesDir: dir,
        planStore,
      });
      expect(rowsNamed("j.recipe.match")).toHaveLength(0);
    });
  });
});

describe("J13 j.recipe.run — one span per run, on every exit", () => {
  it("writes the row even when the recipe cannot be loaded at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "j-rows-"));
    try {
      const result = await runRecipe({
        kitRef: "nobody/j-rows-no-such-recipe",
        sessionKey: "test:j-rows",
        intent: "a run that never starts",
        ownRecipesDir: join(dir, "recipes"),
        recipeInstallSandbox: join(dir, "sandbox"),
      });

      expect(result.ok).toBe(false);
      // The earliest possible failure is the one an emit-per-return would miss first.
      const rows = rowsNamed("j.recipe.run");
      expect(rows).toHaveLength(1);
      expect(rows[0].record.label).toBe("error");
      expect(typeof rows[0].record.durMs).toBe("number");
      expect(rows[0].record.n1).toBe(0);
      expect(rows[0].record.n2).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
