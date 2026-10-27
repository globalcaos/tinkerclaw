/**
 * FORK 2026-10-09: publish the matcher's resolved catalog to
 * `<stateDir>/prefrontal/recipe-index.json`, so a plain Claude Code session (outside
 * the gateway) reads the SAME recipe list the turn-start matcher scores — without
 * starting the gateway's plugin CLI (~11 s per call). Same "the gateway publishes,
 * Claude Code only reads" split as the moral code (`<stateDir>/moral-code/moral-code.md`),
 * and the same state-dir resolver (`resolveStateDir`: OPENCLAW_STATE_DIR with a leading
 * `~` expanded, else `~/.openclaw`), so both files land under one root. The recipe
 * OVERLAY dir (recipe-runner.ts resolveRecipeOverlayDir) derives from OPENCLAW_HOME, not
 * the state dir, so it is deliberately NOT the resolver here.
 *
 * CONTRACT — read by the Claude Code hook in claude-plugins/tinkerclaw-core; change the
 * reader before changing this shape:
 *   { version: 1, generatedAt: <ISO>, recipes: [ { slug, owner, title, summary, tags: [],
 *     category?, subdivision?, path } ] }
 * sorted by slug, one row per slug exactly as loadRecipeIndex resolved it (an overlay
 * recipe wins a slug collision — decided in the matcher, never re-decided here).
 *
 * Properties: atomic (tmp + rename, a reader never sees a torn file); churn-free (an
 * identical recipes array is not rewritten, so mtime watchers stay quiet and
 * `generatedAt` only moves when the catalog does); silent on failure (one log line —
 * a publisher that threw into the matcher's hot path would cost the turn).
 */
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { RecipeIndexEntry } from "./recipe-matcher.js";

export const RECIPE_INDEX_VERSION = 1 as const;

/** One published row: the contract's fields and nothing else. */
export interface PublishedRecipe {
  slug: string;
  owner: string;
  title: string;
  summary: string;
  tags: string[];
  category?: string;
  subdivision?: string;
  path: string;
}

export interface PublishedRecipeIndex {
  version: typeof RECIPE_INDEX_VERSION;
  generatedAt: string;
  recipes: PublishedRecipe[];
}

export type RecipeIndexPublishLog = {
  info?: (m: string) => void;
  warn?: (m: string) => void;
};

/** `<stateDir>/prefrontal/recipe-index.json`; stateDir defaults to the gateway's. */
export function recipeIndexPath(stateDir: string = resolveStateDir()): string {
  return join(stateDir, "prefrontal", "recipe-index.json");
}

/**
 * Map matcher entries onto the contract: listed fields only (no antiTriggers, no
 * composes), optional fields present only when they carry a value (undefined-free
 * JSON), sorted by slug in byte order so the file is deterministic.
 */
export function toPublishedRecipes(entries: RecipeIndexEntry[]): PublishedRecipe[] {
  return entries
    .map((e) => {
      const row: PublishedRecipe = {
        slug: e.slug,
        owner: e.owner,
        title: e.title,
        summary: e.summary,
        tags: [...e.tags],
        path: e.path,
      };
      if (typeof e.category === "string" && e.category) {
        row.category = e.category;
      }
      if (typeof e.subdivision === "string" && e.subdivision) {
        row.subdivision = e.subdivision;
      }
      return row;
    })
    .toSorted((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** The on-disk recipes array as a comparable string, or null when absent/unreadable. */
async function readPublishedRecipes(file: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
      version?: unknown;
      recipes?: unknown;
    };
    if (parsed.version !== RECIPE_INDEX_VERSION || !Array.isArray(parsed.recipes)) {
      return null;
    }
    return JSON.stringify(parsed.recipes);
  } catch {
    return null;
  }
}

/**
 * Publish `entries` to the contract file. Skips the write when the recipes array on
 * disk is already identical (compared without generatedAt). Never throws: a failure
 * is one warn line and the catalog keeps being served from memory.
 */
export async function publishRecipeIndex(
  entries: RecipeIndexEntry[],
  opts: { stateDir?: string; log?: RecipeIndexPublishLog } = {},
): Promise<void> {
  const file = recipeIndexPath(opts.stateDir);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const recipes = toPublishedRecipes(entries);
    if ((await readPublishedRecipes(file)) === JSON.stringify(recipes)) {
      return; // unchanged — no churn
    }
    const doc: PublishedRecipeIndex = {
      version: RECIPE_INDEX_VERSION,
      generatedAt: new Date().toISOString(),
      recipes,
    };
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
    opts.log?.info?.(`[recipe-index] published ${recipes.length} recipes → ${file}`);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    opts.log?.warn?.(
      `[recipe-index] publish to ${file} failed (catalog still served from memory): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
