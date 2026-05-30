/**
 * ENGRAM — Recipe archive (Upgrade 1, never-delete versioned store).
 *
 * Append-only store of recipe variants + their fitness history, modeled on
 * artifact-store.ts (ULID-style ids, JSON sidecars, factory). NEVER deletes —
 * supersession marks a prior version `deprecated` while its body remains
 * readable (the never-delete invariant; self-reinforcing-error-spiral mitigation:
 * every variant is recoverable for rollback).
 *
 * Selection: `rank()` returns variants best-fitness-first with an epsilon-greedy
 * explorer slot (deterministic when a seeded RNG is injected, for tests).
 *
 * Layout under <baseDir>/recipe-archive/:
 *   index.json                         — { recipeId -> RecipeArchiveIndexEntry }
 *   <recipeId-slug>/v<n>.json          — { body, fitness, deprecated }
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 1).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecipeFitness } from "./recipe-fitness.js";

export interface VariantRef {
  recipeId: string;
  version: number;
  deprecated: boolean;
  fitness: RecipeFitness;
}

export interface VariantRecord extends VariantRef {
  body: string;
}

export interface RecipeArchiveOptions {
  baseDir: string;
  /** Epsilon for epsilon-greedy ranking exploration. Default 0.1. */
  epsilon?: number;
  /** Injectable RNG (0..1) for deterministic tests. Default Math.random. */
  rng?: () => number;
}

export interface RecipeArchive {
  /** Store a new variant (version) for a recipe. Returns its ref. */
  putVariant(recipeId: string, version: number, body: string, fitness: RecipeFitness): VariantRef;
  /** Read a variant's full record (body included) — works even if deprecated. */
  read(recipeId: string, version: number): VariantRecord | undefined;
  /** Chronological fitness history for a recipe. */
  history(recipeId: string): RecipeFitness[];
  /** Latest (highest-version) fitness for a recipe, or null. */
  latestFitness(recipeId: string): RecipeFitness | null;
  /** Mark a variant deprecated — never deletes the body. */
  deprecate(recipeId: string, version: number): void;
  /**
   * Rank live (non-deprecated) variants best-fitness-first with an epsilon-greedy
   * explorer. `taskDifficulty`, when given, biases toward variants whose encoded
   * difficulty is closest to the task (Gödel: difficulty-aware selection).
   */
  rank(taskDifficulty?: number): VariantRef[];
}

interface RecipeArchiveIndexEntry {
  recipeId: string;
  versions: number[];
}

function slugify(recipeId: string): string {
  return recipeId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function createRecipeArchive(options: RecipeArchiveOptions): RecipeArchive {
  const root = join(options.baseDir, "recipe-archive");
  const indexPath = join(root, "index.json");
  const epsilon = options.epsilon ?? 0.1;
  const rng = options.rng ?? Math.random;
  mkdirSync(root, { recursive: true });

  function loadIndex(): Record<string, RecipeArchiveIndexEntry> {
    if (!existsSync(indexPath)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(indexPath, "utf-8"));
    } catch {
      return {};
    }
  }

  function saveIndex(idx: Record<string, RecipeArchiveIndexEntry>): void {
    writeFileSync(indexPath, JSON.stringify(idx, null, 2));
  }

  function variantPath(recipeId: string, version: number): string {
    return join(root, slugify(recipeId), `v${version}.json`);
  }

  function readVariant(recipeId: string, version: number): VariantRecord | undefined {
    const p = variantPath(recipeId, version);
    if (!existsSync(p)) {
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as VariantRecord;
    } catch {
      return undefined;
    }
  }

  function writeVariant(rec: VariantRecord): void {
    const dir = join(root, slugify(rec.recipeId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(variantPath(rec.recipeId, rec.version), JSON.stringify(rec, null, 2));
  }

  function allLiveVariants(recipeId: string): VariantRef[] {
    const idx = loadIndex();
    const entry = idx[recipeId];
    if (!entry) {
      return [];
    }
    const refs: VariantRef[] = [];
    for (const v of entry.versions) {
      const rec = readVariant(recipeId, v);
      if (rec && !rec.deprecated) {
        refs.push({
          recipeId: rec.recipeId,
          version: rec.version,
          deprecated: rec.deprecated,
          fitness: rec.fitness,
        });
      }
    }
    return refs;
  }

  return {
    putVariant(recipeId, version, body, fitness) {
      const rec: VariantRecord = { recipeId, version, deprecated: false, body, fitness };
      writeVariant(rec);
      const idx = loadIndex();
      const entry = idx[recipeId] ?? { recipeId, versions: [] };
      if (!entry.versions.includes(version)) {
        entry.versions.push(version);
        entry.versions.sort((a, b) => a - b);
      }
      idx[recipeId] = entry;
      saveIndex(idx);
      return { recipeId, version, deprecated: false, fitness };
    },

    read(recipeId, version) {
      return readVariant(recipeId, version);
    },

    history(recipeId) {
      const idx = loadIndex();
      const entry = idx[recipeId];
      if (!entry) {
        return [];
      }
      return entry.versions
        .map((v) => readVariant(recipeId, v))
        .filter((r): r is VariantRecord => r !== undefined)
        .map((r) => r.fitness);
    },

    latestFitness(recipeId) {
      const idx = loadIndex();
      const entry = idx[recipeId];
      if (!entry || entry.versions.length === 0) {
        return null;
      }
      const latest = entry.versions[entry.versions.length - 1];
      return readVariant(recipeId, latest)?.fitness ?? null;
    },

    deprecate(recipeId, version) {
      const rec = readVariant(recipeId, version);
      if (rec) {
        writeVariant({ ...rec, deprecated: true });
      }
    },

    rank(taskDifficulty) {
      // Collect live variants across all recipes.
      const idx = loadIndex();
      const live: VariantRef[] = [];
      for (const recipeId of Object.keys(idx)) {
        live.push(...allLiveVariants(recipeId));
      }
      if (live.length === 0) {
        return [];
      }

      const score = (v: VariantRef): number => {
        let s = v.fitness.successRate;
        if (taskDifficulty != null) {
          // Penalise distance from the task's difficulty (Gödel-style).
          const dist = Math.abs(v.fitness.difficulty - taskDifficulty);
          s -= 0.01 * dist;
        }
        return s;
      };

      const sorted = [...live].sort((a, b) => score(b) - score(a));

      // Epsilon-greedy: with prob epsilon, promote a random explorer to the front.
      if (sorted.length > 1 && rng() < epsilon) {
        const idxPick = Math.floor(rng() * sorted.length);
        const [explorer] = sorted.splice(idxPick, 1);
        sorted.unshift(explorer);
      }

      return sorted;
    },
  };
}
