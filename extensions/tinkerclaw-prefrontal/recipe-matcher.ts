/**
 * FORK 2026-05-16 (matching half of the smart router); upgraded 2026-05-29.
 *
 * The execution half (recipe-runner.ts) consumes parallelism.groups and fans out
 * subagents. The matcher fires automatically at turn start (before_prompt_build)
 * so Jarvis never has to remember to invoke a recipe.
 *
 * 2026-05-29 upgrades (the user's "best way of finding the right recipe" + compose):
 *   - FUZZY scoring: stemming + prefix + edit-distance-1 token matching, so
 *     "debugging the crash" matches the `debug` kit even though no literal token
 *     is shared. Lexical-only used to silently NO-MATCH on paraphrases.
 *   - CONFIDENCE: matchRecipes reports none | low | high so the hook can decide
 *     between seeding silently, surfacing alternatives, or prompting authoring.
 *   - COMPOSITION: a kit's frontmatter `composes: [slug, ...]` pulls those kits'
 *     steps into the merged plan (cycle-guarded) — recipes built from recipes.
 *   - PROVENANCE: seedPlanFromPrompt returns the full match detail so the hook
 *     can emit searched/matched/merged/authored trail events to the panel.
 *
 * Matching stays LOCAL and fast (no Journey network call per turn).
 *
 * See bible subagents-and-kits.md + tool-loop.md.
 */
import fs from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseKitStepsAndParallelism } from "./recipe-runner.js";
import type { EmbedFn } from "./semantic-matcher.js";

export interface RecipeIndexEntry {
  slug: string;
  /**
   * Canonical kit owner. Combined with `slug` it forms the `owner/slug` recipeId
   * the fitness store (recipe-fitness.loadRecipeFitness) keys by exactly. Author-
   * owned kits default to 'globalcaos' (the same currentOwner constant used at
   * index.ts + recipe-rpcs.ts); a kit's frontmatter `owner:` overrides it.
   */
  owner: string;
  title: string;
  summary: string;
  tags: string[];
  /**
   * Anti-triggers (frontmatter `antiTriggers:` / `whenNotToUse:`) — the "When NOT
   * to use" discipline from addyosmani/agent-skills, ported to the matcher. Each
   * entry is a phrase/word whose EXACT presence in the prompt subtracts from the
   * base lexical score, so a recipe can suppress itself on look-alike prompts
   * (e.g. `code-review-5pass` anti-triggering "quick look" to yield to `code-review`).
   * Matching is exact-only (no fuzzy) so an anti-trigger never fires by accident.
   */
  antiTriggers: string[];
  /** Other kit slugs this kit composes (frontmatter `composes:`). */
  composes: string[];
  /** Absolute path to the kit.md, for lazy step parsing on a match. */
  path: string;
}

export interface RecipeMatch {
  entry: RecipeIndexEntry;
  score: number;
}

export type MatchConfidence = "none" | "low" | "high";

export interface MatchResult {
  matches: RecipeMatch[];
  confidence: MatchConfidence;
}

export interface MergedPlan {
  intent: string;
  steps: Array<{ title: string }>;
  kitRefs: string[];
  /** Slugs pulled in via `composes:` expansion (subset of kitRefs). */
  composedFrom: string[];
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "be",
  "this",
  "that",
  "it",
  "i",
  "you",
  "we",
  "my",
  "me",
  "can",
  "could",
  "would",
  "should",
  "do",
  "does",
  "please",
  "need",
  "want",
  "how",
  "what",
  "why",
  "when",
  "get",
  "got",
  "now",
  "make",
  "let",
  "lets",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t),
  );
}

/** Lightweight stemmer — strips the common English inflections that broke
 * lexical matching ("debugging"→"debug", "tests"→"test", "fixes"→"fix"). */
function stem(t: string): string {
  return t
    .replace(/(ization|isation)$/, "ize")
    .replace(/(ing|edly|ed|ly|es|s)$/, "")
    .replace(/(er|or)$/, "");
}

/** Edit distance ≤1 check (cheap early-exit), for typo/inflection tolerance. */
function withinEdit1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

/** Fuzzy token match: equality, shared stem, prefix (len≥4), or edit-distance-1
 * (len≥5). The graduated rules avoid false hits on tiny tokens. */
export function tokenMatches(promptTok: string, kitTok: string): boolean {
  if (promptTok === kitTok) return true;
  const ps = stem(promptTok);
  const ks = stem(kitTok);
  if (ps === ks && ps.length >= 3) return true;
  if (promptTok.length >= 4 && kitTok.length >= 4) {
    if (promptTok.startsWith(kitTok) || kitTok.startsWith(promptTok)) return true;
  }
  if (promptTok.length >= 5 && kitTok.length >= 5 && withinEdit1(ps, ks)) return true;
  return false;
}

function anyTokenMatches(promptTokens: string[], kitTok: string): boolean {
  return promptTokens.some((pt) => tokenMatches(pt, kitTok));
}

let cache: { sig: string; index: RecipeIndexEntry[] } | null = null;

/** Drop the in-memory index cache (call after authoring a kit on the fly). */
export function invalidateRecipeIndexCache(): void {
  cache = null;
}

/**
 * Scan ONE `<dir>/<slug>/{recipe.md,kit.md}` tree into RecipeIndexEntry rows.
 * Missing dir → []. DUAL-READ (rename migration 2026-06-02): a definition file
 * is `recipe.md` in the new layout, `kit.md` in the legacy layout. We probe
 * recipe.md FIRST per slug-dir, then fall back to kit.md, so newly authored
 * recipes win and old kit.md definitions keep loading without an on-disk move.
 */
async function scanRecipeDir(dir: string): Promise<RecipeIndexEntry[]> {
  const RECIPE_FILENAMES = ["recipe.md", "kit.md"] as const;
  const index: RecipeIndexEntry[] = [];
  let slugs: string[];
  try {
    slugs = await fs.readdir(dir);
  } catch {
    return index; // dir absent (e.g. no bridged imports yet) — not an error
  }
  for (const slug of slugs) {
    let path = "";
    let text: string | null = null;
    for (const fname of RECIPE_FILENAMES) {
      const candidate = join(dir, slug, fname);
      try {
        text = await fs.readFile(candidate, "utf8");
        path = candidate;
        break;
      } catch {
        // try next filename
      }
    }
    if (text === null) {
      continue; // not a recipe dir (no recipe.md or kit.md)
    }
    const fm = /^---\n([\s\S]+?)\n---\n/.exec(text);
    if (!fm) continue;
    let parsed: Record<string, unknown> | null;
    try {
      parsed = parseYaml(fm[1]) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const tags = Array.isArray(parsed.tags)
      ? (parsed.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const composes = Array.isArray(parsed.composes)
      ? (parsed.composes as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    // `antiTriggers:` is canonical; `whenNotToUse:` is an accepted alias so the
    // frontmatter reads naturally next to the human "When NOT to use" body section.
    const antiRaw = Array.isArray(parsed.antiTriggers)
      ? parsed.antiTriggers
      : Array.isArray(parsed.whenNotToUse)
        ? parsed.whenNotToUse
        : [];
    const antiTriggers = (antiRaw as unknown[]).filter((t): t is string => typeof t === "string");
    index.push({
      slug: typeof parsed.slug === "string" ? parsed.slug : slug,
      // Frontmatter `owner:` wins; author-owned kits default to 'globalcaos' (the
      // same constant used at index.ts:currentOwner + recipe-rpcs.ts), so the
      // fitness lookup below hits the exact `owner/slug` recipeId key.
      owner: typeof parsed.owner === "string" ? parsed.owner : "globalcaos",
      title: typeof parsed.title === "string" ? parsed.title : slug,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags,
      antiTriggers,
      composes,
      path,
    });
  }
  return index;
}

/**
 * Load the matcher's catalog. Scans `ownRecipesDir` plus any `extraDirs` (FORK
 * 2026-06-01 / U11: the bridged-skills dir where imported CC SKILL.md recipes
 * land), so imported recipes are matchable alongside the curated ones. A later
 * dir's entry wins on a slug collision (so a bridged recipe never shadows a
 * curated kit of the same slug — own-kits scan first). The cache key is the
 * combined mtime signature of every scanned dir, so a write to ANY of them
 * invalidates the cache (a missing dir contributes a stable "x" so its later
 * creation also busts the cache).
 */
export async function loadRecipeIndex(
  ownRecipesDir: string,
  extraDirs: string[] = [],
): Promise<RecipeIndexEntry[]> {
  const dirs = [ownRecipesDir, ...extraDirs];
  const sigParts: string[] = [];
  for (const d of dirs) {
    try {
      const st = await fs.stat(d);
      sigParts.push(`${d}:${st.mtimeMs}`);
    } catch {
      sigParts.push(`${d}:x`);
    }
  }
  const sig = sigParts.join("|");
  if (cache && cache.sig === sig) {
    return cache.index;
  }

  // own-recipes first so a bridged import cannot shadow a curated recipe.
  const bySlug = new Map<string, RecipeIndexEntry>();
  for (const d of dirs) {
    for (const entry of await scanRecipeDir(d)) {
      if (!bySlug.has(entry.slug)) bySlug.set(entry.slug, entry);
    }
  }
  const index = [...bySlug.values()];
  cache = { sig, index };
  return index;
}

/**
 * FORK 2026-06 (Upgrade 1): a per-recipe fitness lookup. Returns the recipe's
 * empirical Laplace-smoothed successRate (0..1) for a slug, or undefined when the
 * recipe has no fitness record yet. Injected by the caller so the matcher stays
 * decoupled from the engram store (no native-dep bundle pull — same pattern as the
 * J13 EmbedFn). The matcher reads fitness through this seam only.
 */
export type FitnessLookup = (slug: string) => number | undefined;

/**
 * FORK 2026-06 (Upgrade 1): convert an empirical successRate into a NON-NEGATIVE
 * score boost. Recipe selection prefers empirically-better recipes, but the
 * matcher must never BURY a lexically-relevant recipe just because its fitness is
 * low — demoting a poor recipe is recipe-evolution's job, not the selector's. So:
 *   - undefined / unknown fitness            → 0 (no opinion, base preserved)
 *   - successRate <= NEUTRAL (0.5)           → 0 (floor preserved, no demotion)
 *   - successRate  > NEUTRAL                 → a small, bounded, monotone boost
 * This guarantees `base + delta >= base` (base lexical weights are the floor) while
 * a proven recipe still outranks an equally-relevant unproven one.
 */
export const FITNESS_NEUTRAL = 0.5;
export const FITNESS_MAX_BOOST = 3;
export function fitnessFeedbackDelta(successRate: number | undefined): number {
  if (typeof successRate !== "number" || !Number.isFinite(successRate)) return 0;
  if (successRate <= FITNESS_NEUTRAL) return 0; // floor — never demote a relevant recipe
  // Map (0.5, 1.0] linearly onto (0, FITNESS_MAX_BOOST], rounded to an integer so
  // the boost lives on the same scale as the lexical tag/title/summary weights.
  const scaled = ((successRate - FITNESS_NEUTRAL) / (1 - FITNESS_NEUTRAL)) * FITNESS_MAX_BOOST;
  return Math.min(FITNESS_MAX_BOOST, Math.round(scaled));
}

/**
 * FORK 2026-06-01 (U12): a per-recipe MARKETPLACE-rating lookup. Returns the
 * recipe's already-computed marketplace popularity bonus (recipe-marketplace.ts
 * ratingBonus, in [0, 2]) for a slug, or undefined when the marketplace has no
 * metadata. Injected by the caller so the matcher stays decoupled from the
 * marketplace's network/cache layer (same seam pattern as FitnessLookup).
 */
export type RatingLookup = (slug: string) => number | undefined;

/**
 * FORK 2026-06-01 (U12): the matcher's CLAMPED rating contribution. Discovery
 * popularity is the WEAKEST signal — it must never override genuine relevance or
 * the empirical-fitness feedback — so a recipe's raw marketplace bonus (0..2) is
 * re-clamped here into a tiny ±0.2 band that only breaks ties between otherwise
 * equally-relevant recipes. A neutral/absent rating contributes 0.
 *
 * PRECEDENCE (composed in scoreRecipe, lowest-to-highest authority of the FLOOR):
 *   base (lexical) → feedback (empirical fitness, integer 0..3, floor-preserving)
 *   → rating (popularity, ±0.2, tie-breaker only).
 * So a strong-fitness proven recipe still dominates a merely-popular one, and a
 * lexical mismatch can never be rescued by popularity alone.
 */
export const RATING_CLAMP = 0.2;
export function ratingScoreDelta(rating: number | undefined): number {
  if (typeof rating !== "number" || !Number.isFinite(rating)) return 0;
  // ratingBonus is in [0, MAX_RATING_BONUS=2]; map onto [-RATING_CLAMP,
  // +RATING_CLAMP] centered on the 1.0 midpoint so a below-average recipe is
  // gently demoted and an above-average one gently promoted, both within ±0.2.
  const centered = (rating - 1) / 1; // [-1, +1]
  return Math.max(-RATING_CLAMP, Math.min(RATING_CLAMP, centered * RATING_CLAMP));
}

/**
 * Score a kit against the prompt. Tag hits weigh most (hand-curated trigger
 * surface), then title, then summary. Multi-word tags match as a phrase
 * substring; single-word tags + title/summary words match FUZZILY (stem /
 * prefix / edit-1) so paraphrases and inflections still score.
 *
 * FORK 2026-06 (Upgrade 1): an optional `feedback` lookup adds the recipe's
 * empirical-fitness boost AFTER the lexical base is computed (post-base-score),
 * with the lexical base as a FLOOR — see fitnessFeedbackDelta. Omitted → pure
 * lexical scoring (the historical behaviour, byte-identical).
 *
 * FORK 2026-06-01 (U12): an optional `rating` lookup adds a CLAMPED (±0.2)
 * marketplace-popularity tie-breaker LAST, so precedence is base → feedback →
 * rating (see ratingScoreDelta). Omitted → no rating perturbation.
 */
export function scoreRecipe(
  prompt: string,
  promptTokens: Set<string>,
  kit: RecipeIndexEntry,
  feedback?: FitnessLookup,
  rating?: RatingLookup,
): number {
  let score = 0;
  const lowPrompt = prompt.toLowerCase();
  const tokenList = [...promptTokens];
  for (const tag of kit.tags) {
    const tl = tag.toLowerCase();
    if (tl.includes(" ")) {
      if (lowPrompt.includes(tl)) score += 5; // exact phrase tag
      continue;
    }
    if (promptTokens.has(tl))
      score += 3; // exact single-word tag hit
    else if (anyTokenMatches(tokenList, tl)) score += 2; // fuzzy tag hit
  }
  for (const tok of tokenize(kit.title)) {
    if (promptTokens.has(tok)) score += 2;
    else if (anyTokenMatches(tokenList, tok)) score += 1;
  }
  for (const tok of tokenize(kit.summary)) {
    if (anyTokenMatches(tokenList, tok)) score += 1;
  }
  // Anti-triggers subtract from the BASE lexical score (exact-only, no fuzzy) so a
  // recipe can yield to a better-fit sibling on look-alike prompts. Symmetric with
  // the positive tag weights (phrase −5, single word −3). Part of the lexical floor,
  // applied BEFORE the feedback/rating deltas (which only ever add ≥0).
  for (const anti of kit.antiTriggers) {
    const al = anti.toLowerCase();
    if (al.includes(" ")) {
      if (lowPrompt.includes(al)) score -= 5; // exact phrase anti-trigger
    } else if (promptTokens.has(al)) {
      score -= 3; // exact single-word anti-trigger
    }
  }
  // PRECEDENCE base → feedback → rating:
  // 1) Post-base-score empirical-fitness boost (base is the floor; delta is >= 0).
  // Key fitness by the EXACT canonical `owner/slug` recipeId so the store hits its
  // exact-key branch, not the lossy bare-slug suffix scan (which cross-pollutes
  // when two owners share a slug). Ratings stay keyed by bare slug.
  if (feedback) score += fitnessFeedbackDelta(feedback(kit.owner + "/" + kit.slug));
  // 2) Clamped marketplace-rating tie-breaker LAST (±0.2 — weakest signal).
  if (rating) score += ratingScoreDelta(rating(kit.slug));
  return score;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_MAX_KITS = 3;

export function matchRecipes(
  prompt: string,
  index: RecipeIndexEntry[],
  opts?: { threshold?: number; max?: number; feedback?: FitnessLookup; rating?: RatingLookup },
): RecipeMatch[] {
  return matchRecipesDetailed(prompt, index, opts).matches;
}

/** Like matchRecipes but also classifies confidence — used by the turn hook to
 * decide seed-silently vs surface-alternatives vs prompt-authoring.
 * FORK 2026-06 (Upgrade 1): an optional `feedback` lookup boosts proven recipes
 * (post-base-score, base as floor — see scoreRecipe). FORK 2026-06-01 (U12): an
 * optional `rating` lookup adds a clamped (±0.2) popularity tie-breaker LAST
 * (precedence base → feedback → rating). Both omitted → pure lexical. */
export function matchRecipesDetailed(
  prompt: string,
  index: RecipeIndexEntry[],
  opts?: { threshold?: number; max?: number; feedback?: FitnessLookup; rating?: RatingLookup },
): MatchResult {
  const promptTokens = new Set(tokenize(prompt));
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const max = opts?.max ?? DEFAULT_MAX_KITS;
  const scored = index
    .map((entry) => ({
      entry,
      score: scoreRecipe(prompt, promptTokens, entry, opts?.feedback, opts?.rating),
    }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score);
  const matches = scored.slice(0, max);

  let confidence: MatchConfidence = "none";
  if (matches.length > 0) {
    const top = matches[0].score;
    const second = matches[1]?.score ?? 0;
    // High: a clear leader well above the bar. Low: barely over bar or a tie.
    confidence = top >= threshold + 3 && top - second >= 2 ? "high" : "low";
  }
  return { matches, confidence };
}

/**
 * Build a single merged plan from matched kits. Steps are concatenated in
 * match-rank order, deduped by normalized title. COMPOSITION: when a matched
 * kit declares `composes: [slug, ...]`, those kits' steps are pulled in too
 * (recipes built from recipes), cycle-guarded against infinite expansion.
 */
export async function buildMergedPlan(
  matches: RecipeMatch[],
  index?: RecipeIndexEntry[],
): Promise<MergedPlan> {
  const steps: Array<{ title: string }> = [];
  const seen = new Set<string>();
  const kitRefs: string[] = [];
  const composedFrom: string[] = [];
  const bySlug = new Map<string, RecipeIndexEntry>((index ?? []).map((e) => [e.slug, e]));
  const expanded = new Set<string>();

  const addStepsFrom = async (entry: RecipeIndexEntry, depth: number): Promise<void> => {
    if (expanded.has(entry.slug) || depth > 3) return;
    expanded.add(entry.slug);
    // Expand composed kits FIRST so their steps lead (a composite recipe reads
    // as: do sub-recipe A, then sub-recipe B, then my own steps).
    for (const subSlug of entry.composes) {
      const sub = bySlug.get(subSlug);
      if (sub && !expanded.has(sub.slug)) {
        composedFrom.push(sub.slug);
        if (!kitRefs.includes(sub.slug)) kitRefs.push(sub.slug);
        await addStepsFrom(sub, depth + 1);
      }
    }
    let text: string;
    try {
      text = await fs.readFile(entry.path, "utf8");
    } catch {
      return;
    }
    const parsed = parseKitStepsAndParallelism(text);
    for (const s of parsed.steps) {
      const norm = s.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (seen.has(norm)) continue;
      seen.add(norm);
      steps.push({ title: s.title });
    }
  };

  for (const m of matches) {
    if (!kitRefs.includes(m.entry.slug)) kitRefs.push(m.entry.slug);
    await addStepsFrom(m.entry, 0);
  }

  const baseLabels = matches.map((m) => m.entry.title);
  const intent =
    matches.length === 1 && composedFrom.length === 0
      ? `${matches[0].entry.title}`
      : `Merged: ${baseLabels.join(" + ")}${composedFrom.length ? ` (composes ${composedFrom.join(", ")})` : ""}`;
  return { intent, steps, kitRefs, composedFrom };
}

export interface SeedPlanDeps {
  prompt: string;
  sessionKey: string;
  runId: string;
  ownRecipesDir: string;
  /** FORK 2026-06-01 (U11): additional catalog dirs scanned alongside ownRecipesDir
   * (e.g. the bridged-skills dir) so imported CC SKILL.md recipes are matchable at
   * turn start. Omitted → own-kits only (historical behaviour). */
  extraKitDirs?: string[];
  planStore: {
    get: (sessionKey: string) => Promise<unknown | null>;
    set: (params: {
      sessionKey: string;
      intent: string;
      runId: string;
      kitRef?: string;
      steps: Array<{ title: string }>;
    }) => Promise<unknown>;
  };
  log?: { info?: (m: string) => void; warn?: (m: string) => void };
  /** J13 semantic fallback: injected embed seam. Omit/undefined → lexical-only (default). */
  embed?: EmbedFn;
  /**
   * FORK 2026-06 (U1): per-recipe empirical-fitness lookup. When supplied, the
   * turn-start lexical match folds in each candidate's Laplace-smoothed
   * successRate boost (post-base-score, base as floor — see scoreRecipe). Omitted →
   * pure lexical scoring (historical behaviour). Built once per turn by the caller
   * (index.ts) via makeFitnessLookup so the matcher stays decoupled from the engram
   * store.
   */
  feedback?: FitnessLookup;
  /**
   * FORK 2026-06-01 (U12): per-recipe marketplace-rating lookup. When supplied, a
   * clamped (±0.2) popularity tie-breaker is added LAST (precedence base → feedback
   * → rating — see scoreRecipe). Omitted → no rating perturbation. Built once per turn
   * by the caller via makeRatingLookup over the warmed marketplace cache.
   */
  rating?: RatingLookup;
}

export interface SeedPlanOutcome {
  seeded: boolean;
  intent?: string;
  stepCount?: number;
  kitRefs?: string[];
  composedFrom?: string[];
  /** All scored matches (for provenance trail). */
  matches: Array<{ slug: string; score: number }>;
  confidence: MatchConfidence;
  /** Total kits scanned this turn (catalog size). */
  catalogSize: number;
  /** True when nothing cleared threshold — the authoring opportunity. */
  noMatch: boolean;
  /** Reason a seed was skipped despite matches (existing plan, etc.). */
  skipped?: string;
  /** J13: true when the semantic fallback lane actually ran this turn. */
  semanticInvoked?: boolean;
  /** J13: slugs recovered ONLY by the semantic lane (not in the lexical set). */
  recoveredBySemantic?: string[];
}

/**
 * Orchestration entry called from the before_prompt_build hook. Returns the
 * full outcome so the hook can emit provenance trails + inject guidance.
 * Never clobbers an existing in_progress plan.
 */
export async function seedPlanFromPrompt(deps: SeedPlanDeps): Promise<SeedPlanOutcome> {
  const snippet = deps.prompt.replace(/\s+/g, " ").trim().slice(0, 120);
  const empty = (over: Partial<SeedPlanOutcome>): SeedPlanOutcome => ({
    seeded: false,
    matches: [],
    confidence: "none",
    catalogSize: 0,
    noMatch: false,
    ...over,
  });

  // Never seed for a kit-completion re-injection (phantom plan-of-a-plan).
  if (deps.prompt.trimStart().startsWith("__KIT_DONE__")) {
    deps.log?.info?.(
      `[recipe-matcher] sessionKey=${deps.sessionKey} kit-completion re-injection (suppressed)`,
    );
    return empty({ skipped: "kit-completion" });
  }

  // Respect an existing in_progress plan.
  let existing: unknown | null = null;
  try {
    existing = await deps.planStore.get(deps.sessionKey);
  } catch {
    existing = null;
  }
  if (existing && (existing as { status?: string }).status === "in_progress") {
    deps.log?.info?.(
      `[recipe-matcher] sessionKey=${deps.sessionKey} skipped — plan already in_progress`,
    );
    return empty({ skipped: "plan-in-progress" });
  }

  const index = await loadRecipeIndex(deps.ownRecipesDir, deps.extraKitDirs ?? []);
  if (index.length === 0) {
    deps.log?.warn?.(`[recipe-matcher] no kits found in ${deps.ownRecipesDir}`);
    return empty({ skipped: "empty-catalog" });
  }

  // FORK 2026-06 (U1) + 2026-06-01 (U12): thread the injected fitness + rating
  // lookups into the lexical match so the turn-start seed prefers empirically-better
  // and (as a tie-break) more-popular recipes. Both omitted → pure lexical.
  const lexical = matchRecipesDetailed(deps.prompt, index, {
    feedback: deps.feedback,
    rating: deps.rating,
  });
  let matches = lexical.matches;
  let confidence = lexical.confidence;
  let semanticInvoked = false;
  let recoveredBySemantic: string[] = [];
  // J13 semantic fallback lane — runs ONLY when an embed seam was injected (gated default-OFF
  // in index.ts). Lexical stays the single owner of scoring; smartMatch short-circuits on a
  // clear lexical winner and falls back to lexical on any embed failure, so it can only
  // RECOVER matches the lexical lane missed, never drop one. Loaded lazily (dynamic import) to
  // avoid an import cycle (semantic-matcher imports types from this module).
  if (deps.embed) {
    try {
      const { smartMatch } = await import("./semantic-matcher.js");
      const smart = await smartMatch({
        lexical,
        prompt: deps.prompt,
        index,
        embed: deps.embed,
        log: deps.log,
      });
      matches = smart.matches;
      confidence = smart.confidence;
      semanticInvoked = smart.semanticInvoked;
      recoveredBySemantic = smart.recoveredBySemantic;
    } catch (err) {
      deps.log?.warn?.(
        `[recipe-matcher] semantic lane failed (lexical kept): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const matchSummary = matches.map((m) => ({ slug: m.entry.slug, score: m.score }));

  if (matches.length === 0) {
    deps.log?.warn?.(
      `[recipe-matcher] NO-MATCH sessionKey=${deps.sessionKey} prompt="${snippet}" (catalog=${index.length}) — recipe-gap; authoring offered`,
    );
    return empty({ catalogSize: index.length, noMatch: true });
  }

  const plan = await buildMergedPlan(matches, index);
  if (plan.steps.length === 0) {
    deps.log?.warn?.(
      `[recipe-matcher] matched ${plan.kitRefs.join("+")} but produced 0 steps — skipping seed`,
    );
    return empty({
      catalogSize: index.length,
      matches: matchSummary,
      confidence,
      skipped: "zero-steps",
    });
  }

  await deps.planStore.set({
    sessionKey: deps.sessionKey,
    intent: plan.intent,
    runId: deps.runId,
    kitRef: plan.kitRefs.length === 1 ? plan.kitRefs[0] : undefined,
    steps: plan.steps,
  });
  deps.log?.info?.(
    `[recipe-matcher] seeded plan sessionKey=${deps.sessionKey} kits=${plan.kitRefs.join("+")} ` +
      `steps=${plan.steps.length} conf=${confidence} scores=[${matchSummary.map((m) => `${m.slug}:${m.score}`).join(",")}]`,
  );
  return {
    seeded: true,
    intent: plan.intent,
    stepCount: plan.steps.length,
    kitRefs: plan.kitRefs,
    composedFrom: plan.composedFrom,
    matches: matchSummary,
    confidence,
    catalogSize: index.length,
    noMatch: false,
    semanticInvoked,
    recoveredBySemantic,
  };
}
