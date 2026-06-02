/**
 * FORK 2026-05-31 — Semantic recall lane for the recipe matcher.
 *
 * WHY THIS EXISTS
 * ---------------
 * `recipe-matcher.ts` is LEXICAL-ONLY (stem / prefix / edit-distance-1). Its named
 * loss mode: a *paraphrased* intent that shares no lexical surface with any
 * recipe's tags/title/summary silently NO-MATCHes. Example: a recipe tagged
 * ["deploy", "ship", "release"] with title "Ship to production" does not score
 * against "push my changes live for customers" — zero stem/prefix/edit-1 overlap,
 * yet they mean the same thing.
 *
 * DESIGN: LEXICAL-FIRST / SEMANTIC-FALLBACK
 * -----------------------------------------
 * The hot path stays fast and offline. We run the existing lexical scorer first.
 * ONLY when its confidence is `none` or `low` (i.e. it whiffed or is unsure) do
 * we pay for the semantic lane: embed the prompt + each recipe's embed-text,
 * rank by cosine similarity, and blend the semantic hits back into the lexical
 * result. A clear lexical `high` short-circuits — no embedding call at all.
 *
 * THE EMBEDDING SEAM (feasibility, honestly reported)
 * ---------------------------------------------------
 * There is NO JSON-RPC `memory.search` method on the gateway (server-methods-list
 * exposes only `doctor.memory.*`, which are status/dream-diary probes, not query
 * endpoints). The real semantic seam is the gateway's OpenAI-compatible
 * `POST /v1/embeddings` HTTP endpoint (`src/gateway/embeddings-http.ts`,
 * mounted at `src/gateway/server-http.ts` `isEmbeddingsPath`). It returns
 * `{ data: [{ embedding: number[] }] }` for `input: string|string[]`.
 *
 * That endpoint is:
 *   - HTTP, not `callGateway` JSON-RPC — needs the gateway base URL + operator auth.
 *   - CONFIG-GATED: only served when `openAiCompatEnabled` is on AND an embedding
 *     provider is configured (`agents.*.memorySearch.provider`). It can be absent.
 *
 * So the embedding call is modelled as an injectable `EmbedFn` dependency. The
 * PURE blend/decision logic in this module is fully unit-tested without a live
 * gateway. The actual HTTP wiring (resolving port/auth, POSTing /v1/embeddings)
 * is a thin adapter that belongs in `index.ts` where the gateway runtime handles
 * are in scope — see `makeHttpEmbedFn` below for the reference shape and the
 * integration notes. When the seam is unavailable (endpoint disabled, embed
 * throws, dimension mismatch) the matcher degrades GRACEFULLY to lexical-only —
 * it never hard-fails a turn.
 */

import type {
  RecipeIndexEntry,
  RecipeMatch,
  MatchConfidence,
  MatchResult,
} from "./recipe-matcher.js";

/**
 * Embed one-or-more texts into vectors. Injected so the hot path stays lexical
 * and tests need no live gateway. Returns one vector per input, in order.
 * Implementations MUST throw (or return a wrong-length array) on failure — the
 * caller treats any error as "semantic lane unavailable" and falls back.
 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface SemanticMatch {
  entry: RecipeIndexEntry;
  /** Cosine similarity in [-1, 1] (typically [0, 1] for these providers). */
  similarity: number;
}

export interface SemanticLaneResult {
  matches: SemanticMatch[];
  /** True when the embedding seam was actually invoked (vs. skipped/unavailable). */
  invoked: boolean;
  /** Set when the lane could not run (no embed fn, embed threw, etc.). */
  unavailable?: string;
}

/**
 * The text a recipe is embedded as. Tags carry the curated trigger surface, so
 * they lead; title + summary give natural-language context. Kept compact so a
 * batch of recipes stays well under the endpoint's per-input char cap.
 */
export function recipeEmbedText(entry: RecipeIndexEntry): string {
  const tags = entry.tags.join(", ");
  return [entry.title, entry.summary, tags].filter((p) => p && p.trim().length > 0).join(". ");
}

/** Cosine similarity of two equal-length vectors. Returns 0 for a degenerate
 * (zero-norm) or length-mismatched pair rather than NaN, so ranking is safe. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Confidence is "weak" (a candidate for semantic rescue) when the lexical lane
 * either whiffed entirely (`none`) or is only tentatively sure (`low`). A clear
 * `high` short-circuits the semantic lane — the cheap answer was already good. */
export function shouldRunSemanticLane(lexical: MatchResult): boolean {
  return lexical.confidence === "none" || lexical.confidence === "low";
}

export interface SemanticLaneOpts {
  /** Min cosine similarity to count as a semantic hit. Default 0.45. */
  minSimilarity?: number;
  /** Max semantic hits to return. Default 3. */
  max?: number;
}

const DEFAULT_MIN_SIMILARITY = 0.45;
const DEFAULT_SEMANTIC_MAX = 3;

/**
 * Run the semantic lane: embed the prompt + every candidate recipe, rank by
 * cosine similarity, keep those above `minSimilarity`. Pure aside from the
 * injected `embed`. Any failure (no embed fn, embed throws, bad dimensions)
 * resolves to `{ matches: [], invoked, unavailable }` — never throws — so the
 * caller can fall back to lexical-only.
 */
export async function runSemanticLane(
  prompt: string,
  index: RecipeIndexEntry[],
  embed: EmbedFn | undefined,
  opts?: SemanticLaneOpts,
): Promise<SemanticLaneResult> {
  if (!embed) return { matches: [], invoked: false, unavailable: "no-embed-fn" };
  if (index.length === 0) return { matches: [], invoked: false, unavailable: "empty-index" };
  const minSimilarity = opts?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const max = opts?.max ?? DEFAULT_SEMANTIC_MAX;

  // One batched embed call: [prompt, recipe0, recipe1, ...].
  const texts = [prompt, ...index.map(recipeEmbedText)];
  let vectors: number[][];
  try {
    vectors = await embed(texts);
  } catch (err) {
    return {
      matches: [],
      invoked: true,
      unavailable: `embed-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    return { matches: [], invoked: true, unavailable: "embed-shape-mismatch" };
  }
  const promptVec = vectors[0];
  if (!Array.isArray(promptVec) || promptVec.length === 0) {
    return { matches: [], invoked: true, unavailable: "empty-prompt-vector" };
  }

  const scored: SemanticMatch[] = [];
  for (let i = 0; i < index.length; i++) {
    const vec = vectors[i + 1];
    if (!Array.isArray(vec) || vec.length !== promptVec.length) continue;
    const similarity = cosineSimilarity(promptVec, vec);
    if (similarity >= minSimilarity) scored.push({ entry: index[i], similarity });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return { matches: scored.slice(0, max), invoked: true };
}

export interface BlendOpts {
  /** Max total matches in the blended result. Default 3. */
  max?: number;
  /** Lexical threshold the synthetic semantic score must clear to seed a plan.
   * Defaults to the matcher's DEFAULT_THRESHOLD (3). */
  threshold?: number;
}

const DEFAULT_BLEND_MAX = 3;
const DEFAULT_BLEND_THRESHOLD = 3;

/**
 * Blend lexical + semantic results into one ranked `MatchResult`.
 *
 * Rules:
 *  - Lexical matches keep their original score and ALWAYS lead (the curated
 *    trigger surface is higher-trust than embedding proximity).
 *  - A semantic hit for a recipe NOT already in the lexical set is converted to
 *    a synthetic lexical-equivalent score so the rest of the pipeline
 *    (threshold filter, plan seeding) treats it uniformly. The mapping is
 *    `threshold + round(similarity * SEMANTIC_SCORE_SPAN)` clamped so a strong
 *    paraphrase (sim≈0.8) lands like a solid lexical match but never outranks a
 *    genuine lexical winner.
 *  - A semantic hit for a recipe ALREADY matched lexically gives a small bonus
 *    (cross-lane agreement) without reordering above a stronger lexical hit.
 *  - Confidence is recomputed: a recovered semantic-only match is at most `low`
 *    (semantic recall is softer evidence than a curated tag hit); cross-lane
 *    agreement on the top hit can promote to `high`.
 *
 * Pure — no I/O. Deterministic given its inputs.
 */
export function blendLexicalSemantic(
  lexical: MatchResult,
  semantic: SemanticMatch[],
  opts?: BlendOpts,
): MatchResult {
  const max = opts?.max ?? DEFAULT_BLEND_MAX;
  const threshold = opts?.threshold ?? DEFAULT_BLEND_THRESHOLD;
  const SEMANTIC_SCORE_SPAN = 4; // sim 0→0, sim 1→threshold+4 (a strong-but-not-dominant score)
  const AGREEMENT_BONUS = 1;

  const bySlug = new Map<string, RecipeMatch>();
  // Lexical first — preserves curated scores.
  for (const m of lexical.matches) {
    bySlug.set(m.entry.slug, { entry: m.entry, score: m.score });
  }

  let crossLaneAgreementOnLeader = false;
  const lexicalTopSlug = lexical.matches[0]?.entry.slug;

  for (const s of semantic) {
    const existing = bySlug.get(s.entry.slug);
    if (existing) {
      // Cross-lane agreement: small bonus, never enough to leapfrog a clearly
      // stronger lexical competitor (bonus is +AGREEMENT_BONUS only).
      existing.score += AGREEMENT_BONUS;
      if (s.entry.slug === lexicalTopSlug) crossLaneAgreementOnLeader = true;
    } else {
      // Recovered paraphrase: synthesize a lexical-equivalent score.
      const synthetic = threshold + Math.round(Math.max(0, s.similarity) * SEMANTIC_SCORE_SPAN);
      bySlug.set(s.entry.slug, { entry: s.entry, score: synthetic });
    }
  }

  const merged = [...bySlug.values()].sort((a, b) => b.score - a.score).slice(0, max);

  // Recompute confidence on the blended set.
  let confidence: MatchConfidence = "none";
  if (merged.length > 0) {
    const top = merged[0].score;
    const second = merged[1]?.score ?? 0;
    const lexicalWasHigh = lexical.confidence === "high";
    const topIsSemanticOnly = !lexical.matches.some((m) => m.entry.slug === merged[0].entry.slug);

    if (lexicalWasHigh) {
      // A lexical high stays high (we only get here if it wasn't, but be safe).
      confidence = "high";
    } else if (crossLaneAgreementOnLeader && top >= threshold + 3 && top - second >= 2) {
      // Both lanes agree on a clear leader → promote.
      confidence = "high";
    } else if (topIsSemanticOnly) {
      // Recovered purely by embeddings — softer evidence, cap at low.
      confidence = "low";
    } else {
      confidence = top >= threshold + 3 && top - second >= 2 ? "high" : "low";
    }
  }

  return { matches: merged, confidence };
}

export interface SmartMatchDeps {
  /** Lexical result from `matchRecipesDetailed` (already computed by the caller). */
  lexical: MatchResult;
  prompt: string;
  index: RecipeIndexEntry[];
  /** Injected embedding seam. Omit/undefined → lexical-only (graceful). */
  embed?: EmbedFn;
  semanticOpts?: SemanticLaneOpts;
  blendOpts?: BlendOpts;
  log?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface SmartMatchResult extends MatchResult {
  /** True when the semantic lane actually ran this turn. */
  semanticInvoked: boolean;
  /** Set when the semantic lane was wanted but could not run. */
  semanticUnavailable?: string;
  /** Slugs recovered ONLY by the semantic lane (not in the lexical set). */
  recoveredBySemantic: string[];
}

/**
 * The orchestration entry: lexical-first, semantic-fallback. The caller passes
 * the already-computed lexical `matchRecipesDetailed` result so this module never
 * re-implements lexical scoring (single owner: recipe-matcher.ts). When lexical
 * confidence is weak AND an embed seam is present, run + blend the semantic
 * lane; otherwise return the lexical result untouched.
 *
 * Pure aside from the injected `embed`; safe to unit-test end-to-end with a
 * stub embed fn.
 */
export async function smartMatch(deps: SmartMatchDeps): Promise<SmartMatchResult> {
  const { lexical } = deps;

  if (!shouldRunSemanticLane(lexical)) {
    // Clear lexical winner — short-circuit, no embedding cost.
    return { ...lexical, semanticInvoked: false, recoveredBySemantic: [] };
  }

  const lane = await runSemanticLane(deps.prompt, deps.index, deps.embed, deps.semanticOpts);
  if (!lane.invoked || lane.matches.length === 0) {
    if (lane.unavailable) {
      deps.log?.info?.(`[semantic-matcher] lane skipped/empty: ${lane.unavailable}`);
    }
    return {
      ...lexical,
      semanticInvoked: lane.invoked,
      semanticUnavailable: lane.unavailable,
      recoveredBySemantic: [],
    };
  }

  const lexicalSlugs = new Set(lexical.matches.map((m) => m.entry.slug));
  const recoveredBySemantic = lane.matches
    .map((m) => m.entry.slug)
    .filter((slug) => !lexicalSlugs.has(slug));

  const blended = blendLexicalSemantic(lexical, lane.matches, deps.blendOpts);
  deps.log?.info?.(
    `[semantic-matcher] blended lexical(${lexical.matches.length},${lexical.confidence}) + ` +
      `semantic(${lane.matches.length}) → ${blended.matches.length} matches conf=${blended.confidence} ` +
      `recovered=[${recoveredBySemantic.join(",")}]`,
  );

  return {
    ...blended,
    semanticInvoked: true,
    recoveredBySemantic,
  };
}

/**
 * Reference adapter that wires `EmbedFn` to the gateway's `POST /v1/embeddings`
 * endpoint. Lives here for documentation + reuse, but the REAL instance must be
 * constructed in `index.ts` where the gateway base URL + operator credentials
 * are resolvable (see integration notes). This factory takes those as params so
 * it has no `src/` import of its own.
 *
 * The endpoint shape (verified in src/gateway/embeddings-http.ts):
 *   POST {baseUrl}/v1/embeddings
 *   body:  { model: "openclaw", input: string[] }
 *   200:   { object:"list", data: [{ object:"embedding", index, embedding: number[] }] }
 *
 * NOTE: the endpoint is config-gated (openAiCompatEnabled + a configured
 * embedding provider). On any non-200 / network error this throws, which the
 * lane treats as "unavailable" → graceful lexical-only fallback.
 */
export function makeHttpEmbedFn(params: {
  baseUrl: string;
  /** OpenAI-compat operator auth — usually a bearer token / gateway password. */
  authHeader?: Record<string, string>;
  model?: string;
  /** Injected fetch (undici in the extension). */
  fetchImpl: (
    url: string,
    init: unknown,
  ) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}): EmbedFn {
  const model = params.model ?? "openclaw";
  return async (texts: string[]): Promise<number[][]> => {
    const res = await params.fetchImpl(`${params.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(params.authHeader ?? {}) },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`/v1/embeddings ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const body = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
    const data = Array.isArray(body.data) ? body.data : [];
    // Reorder by `index` defensively; some providers may not preserve order.
    const out: number[][] = new Array(texts.length);
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const at = typeof row.index === "number" ? row.index : i;
      out[at] = Array.isArray(row.embedding) ? row.embedding : [];
    }
    return out;
  };
}
