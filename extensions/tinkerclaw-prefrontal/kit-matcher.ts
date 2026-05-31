/**
 * FORK 2026-05-16 (matching half of the smart router); upgraded 2026-05-29.
 *
 * The execution half (kit-runner.ts) consumes parallelism.groups and fans out
 * subagents. The matcher fires automatically at turn start (before_prompt_build)
 * so Jarvis never has to remember to invoke a recipe.
 *
 * 2026-05-29 upgrades (the user's "best way of finding the right recipe" + compose):
 *   - FUZZY scoring: stemming + prefix + edit-distance-1 token matching, so
 *     "debugging the crash" matches the `debug` kit even though no literal token
 *     is shared. Lexical-only used to silently NO-MATCH on paraphrases.
 *   - CONFIDENCE: matchKits reports none | low | high so the hook can decide
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
import { parseKitStepsAndParallelism } from "./kit-runner.js";
import type { EmbedFn } from "./semantic-matcher.js";

export interface KitIndexEntry {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  /** Other kit slugs this kit composes (frontmatter `composes:`). */
  composes: string[];
  /** Absolute path to the kit.md, for lazy step parsing on a match. */
  path: string;
}

export interface KitMatch {
  entry: KitIndexEntry;
  score: number;
}

export type MatchConfidence = "none" | "low" | "high";

export interface MatchResult {
  matches: KitMatch[];
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

let cache: { mtimeMs: number; index: KitIndexEntry[] } | null = null;

/** Drop the in-memory index cache (call after authoring a kit on the fly). */
export function invalidateKitIndexCache(): void {
  cache = null;
}

export async function loadKitIndex(ownKitsDir: string): Promise<KitIndexEntry[]> {
  let dirStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    dirStat = await fs.stat(ownKitsDir);
  } catch {
    return [];
  }
  if (cache && cache.mtimeMs === dirStat.mtimeMs) {
    return cache.index;
  }
  const index: KitIndexEntry[] = [];
  let slugs: string[];
  try {
    slugs = await fs.readdir(ownKitsDir);
  } catch {
    return [];
  }
  for (const slug of slugs) {
    const path = join(ownKitsDir, slug, "kit.md");
    let text: string;
    try {
      text = await fs.readFile(path, "utf8");
    } catch {
      continue; // not a kit dir
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
    index.push({
      slug: typeof parsed.slug === "string" ? parsed.slug : slug,
      title: typeof parsed.title === "string" ? parsed.title : slug,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags,
      composes,
      path,
    });
  }
  cache = { mtimeMs: dirStat.mtimeMs, index };
  return index;
}

/**
 * Score a kit against the prompt. Tag hits weigh most (hand-curated trigger
 * surface), then title, then summary. Multi-word tags match as a phrase
 * substring; single-word tags + title/summary words match FUZZILY (stem /
 * prefix / edit-1) so paraphrases and inflections still score.
 */
export function scoreKit(prompt: string, promptTokens: Set<string>, kit: KitIndexEntry): number {
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
  return score;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_MAX_KITS = 3;

export function matchKits(
  prompt: string,
  index: KitIndexEntry[],
  opts?: { threshold?: number; max?: number },
): KitMatch[] {
  return matchKitsDetailed(prompt, index, opts).matches;
}

/** Like matchKits but also classifies confidence — used by the turn hook to
 * decide seed-silently vs surface-alternatives vs prompt-authoring. */
export function matchKitsDetailed(
  prompt: string,
  index: KitIndexEntry[],
  opts?: { threshold?: number; max?: number },
): MatchResult {
  const promptTokens = new Set(tokenize(prompt));
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const max = opts?.max ?? DEFAULT_MAX_KITS;
  const scored = index
    .map((entry) => ({ entry, score: scoreKit(prompt, promptTokens, entry) }))
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
  matches: KitMatch[],
  index?: KitIndexEntry[],
): Promise<MergedPlan> {
  const steps: Array<{ title: string }> = [];
  const seen = new Set<string>();
  const kitRefs: string[] = [];
  const composedFrom: string[] = [];
  const bySlug = new Map<string, KitIndexEntry>((index ?? []).map((e) => [e.slug, e]));
  const expanded = new Set<string>();

  const addStepsFrom = async (entry: KitIndexEntry, depth: number): Promise<void> => {
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
  ownKitsDir: string;
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
      `[kit-matcher] sessionKey=${deps.sessionKey} kit-completion re-injection (suppressed)`,
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
      `[kit-matcher] sessionKey=${deps.sessionKey} skipped — plan already in_progress`,
    );
    return empty({ skipped: "plan-in-progress" });
  }

  const index = await loadKitIndex(deps.ownKitsDir);
  if (index.length === 0) {
    deps.log?.warn?.(`[kit-matcher] no kits found in ${deps.ownKitsDir}`);
    return empty({ skipped: "empty-catalog" });
  }

  const lexical = matchKitsDetailed(deps.prompt, index);
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
        `[kit-matcher] semantic lane failed (lexical kept): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const matchSummary = matches.map((m) => ({ slug: m.entry.slug, score: m.score }));

  if (matches.length === 0) {
    deps.log?.warn?.(
      `[kit-matcher] NO-MATCH sessionKey=${deps.sessionKey} prompt="${snippet}" (catalog=${index.length}) — recipe-gap; authoring offered`,
    );
    return empty({ catalogSize: index.length, noMatch: true });
  }

  const plan = await buildMergedPlan(matches, index);
  if (plan.steps.length === 0) {
    deps.log?.warn?.(
      `[kit-matcher] matched ${plan.kitRefs.join("+")} but produced 0 steps — skipping seed`,
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
    `[kit-matcher] seeded plan sessionKey=${deps.sessionKey} kits=${plan.kitRefs.join("+")} ` +
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
