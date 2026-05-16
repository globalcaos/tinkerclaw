/**
 * FORK 2026-05-16: prefrontal/kit-matcher — the "smart router" matching half.
 *
 * The execution half (kit-runner.ts) consumes parallelism.groups and fans out
 * subagents. But nothing CALLED it from a normal conversational turn — Jarvis
 * had to remember to invoke prefrontal.kit.run himself, and he didn't (the
 * 2026-05-14 plan-not-set incident). Per the "force rules in code" preference,
 * the matcher fires automatically at turn start.
 *
 * Contract (decided with the user 2026-05-14/16):
 *   - Fires on EVERY user message to the main session (no heuristic gate —
 *     "no match" frequency is a clean signal that the kit catalog is too thin).
 *   - When >=1 kits match above threshold, MERGE their step lists into one
 *     plan (dedupe by normalized title) and seed it via plan-store. Jarvis
 *     then follows that plan; restart-continue can resume it.
 *   - When NO kit matches, seed nothing and emit a WARN with the prompt
 *     snippet so we can mine recipe gaps. The implicit 2-step panel takes
 *     over (content-rich, see prefrontal-tree.ts humanizeRootStatus).
 *
 * Matching is LOCAL and fast (no Journey network call on every turn): it
 * scores the prompt against each local kit's frontmatter tags/title/summary.
 *
 * See bible subagents-and-kits.md ("the smart frontier") + tool-loop.md.
 */
import fs from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseKitStepsAndParallelism } from "./kit-runner.js";

export interface KitIndexEntry {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  /** Absolute path to the kit.md, for lazy step parsing on a match. */
  path: string;
}

export interface KitMatch {
  entry: KitIndexEntry;
  score: number;
}

export interface MergedPlan {
  intent: string;
  steps: Array<{ title: string }>;
  kitRefs: string[];
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

let cache: { mtimeMs: number; index: KitIndexEntry[] } | null = null;

/**
 * Scan ownKitsDir/<slug>/kit.md, parse frontmatter. Cached; invalidated when
 * the kits directory mtime changes (kit added/edited).
 */
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
    index.push({
      slug: typeof parsed.slug === "string" ? parsed.slug : slug,
      title: typeof parsed.title === "string" ? parsed.title : slug,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags,
      path,
    });
  }
  cache = { mtimeMs: dirStat.mtimeMs, index };
  return index;
}

/**
 * Score a kit against the prompt. Tag hits weigh most (tags are the
 * hand-curated trigger surface), then title, then summary. Multi-word tags
 * ("push to prod") match as a phrase substring on the raw prompt too.
 */
export function scoreKit(prompt: string, promptTokens: Set<string>, kit: KitIndexEntry): number {
  let score = 0;
  const lowPrompt = prompt.toLowerCase();
  for (const tag of kit.tags) {
    const tl = tag.toLowerCase();
    if (tl.includes(" ")) {
      if (lowPrompt.includes(tl)) score += 5; // exact phrase tag
      continue;
    }
    if (promptTokens.has(tl)) score += 3; // single-word tag hit
  }
  for (const tok of tokenize(kit.title)) {
    if (promptTokens.has(tok)) score += 2;
  }
  for (const tok of tokenize(kit.summary)) {
    if (promptTokens.has(tok)) score += 1;
  }
  return score;
}

const DEFAULT_THRESHOLD = 3; // one single-word tag hit, or a title word + summary word
const DEFAULT_MAX_KITS = 3; // merge at most this many kits into one plan

export function matchKits(
  prompt: string,
  index: KitIndexEntry[],
  opts?: { threshold?: number; max?: number },
): KitMatch[] {
  const promptTokens = new Set(tokenize(prompt));
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const max = opts?.max ?? DEFAULT_MAX_KITS;
  const scored = index
    .map((entry) => ({ entry, score: scoreKit(prompt, promptTokens, entry) }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}

/**
 * Build a single merged plan from matched kits. Steps are concatenated in
 * match-rank order, deduped by normalized title (first occurrence wins so the
 * highest-scored kit's phrasing is kept). The intent is a short summary of
 * which kits drove the plan.
 */
export async function buildMergedPlan(matches: KitMatch[]): Promise<MergedPlan> {
  const steps: Array<{ title: string }> = [];
  const seen = new Set<string>();
  const kitRefs: string[] = [];
  for (const m of matches) {
    kitRefs.push(m.entry.slug);
    let text: string;
    try {
      text = await fs.readFile(m.entry.path, "utf8");
    } catch {
      continue;
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
  }
  const intent =
    matches.length === 1
      ? `${matches[0].entry.title}`
      : `Merged: ${matches.map((m) => m.entry.title).join(" + ")}`;
  return { intent, steps, kitRefs };
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
}

/**
 * Orchestration entry called from the before_prompt_build hook. Returns the
 * outcome so the hook can decide whether to inject a "plan seeded" note.
 *
 * Never clobbers an existing in_progress plan (the user — or a prior turn —
 * may have set one explicitly; that wins).
 */
export async function seedPlanFromPrompt(
  deps: SeedPlanDeps,
): Promise<{ seeded: boolean; intent?: string; stepCount?: number; kitRefs?: string[] }> {
  const snippet = deps.prompt.replace(/\s+/g, " ").trim().slice(0, 120);

  // Respect an existing plan — don't overwrite explicit/prior-turn plans.
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
    return { seeded: false };
  }

  const index = await loadKitIndex(deps.ownKitsDir);
  if (index.length === 0) {
    deps.log?.warn?.(`[kit-matcher] no kits found in ${deps.ownKitsDir}`);
    return { seeded: false };
  }

  const matches = matchKits(deps.prompt, index);
  if (matches.length === 0) {
    // The recipe-gap signal. If this fires often for a class of prompts the
    // catalog is too thin / our work has drifted — see bible subagents-and-kits.md.
    deps.log?.warn?.(
      `[kit-matcher] NO-MATCH sessionKey=${deps.sessionKey} prompt="${snippet}" ` +
        `(catalog=${index.length} kits) — recipe-gap signal; implicit 2-step panel takes over`,
    );
    return { seeded: false };
  }

  const plan = await buildMergedPlan(matches);
  if (plan.steps.length === 0) {
    deps.log?.warn?.(
      `[kit-matcher] matched ${plan.kitRefs.join("+")} but produced 0 steps — skipping seed`,
    );
    return { seeded: false };
  }

  await deps.planStore.set({
    sessionKey: deps.sessionKey,
    intent: plan.intent,
    runId: deps.runId,
    kitRef: plan.kitRefs.length === 1 ? plan.kitRefs[0] : undefined,
    steps: plan.steps,
  });
  deps.log?.info?.(
    `[kit-matcher] seeded plan sessionKey=${deps.sessionKey} ` +
      `kits=${plan.kitRefs.join("+")} steps=${plan.steps.length} ` +
      `scores=[${matches.map((m) => `${m.entry.slug}:${m.score}`).join(",")}]`,
  );
  return {
    seeded: true,
    intent: plan.intent,
    stepCount: plan.steps.length,
    kitRefs: plan.kitRefs,
  };
}
