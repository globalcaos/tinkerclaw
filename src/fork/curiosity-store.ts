/**
 * FORK 2026-05-30 — Curiosity / intrinsic-motivation episodic-buffer store (J8 THALAMUS).
 *
 * The shared persistence + scoring substrate for the Consolidative Curiosity
 * Architecture (CCA). Every detected knowledge gap — whether from the LCM
 * uncertainty heuristic (2a), a prefrontal NO-MATCH (2e), a retrieval miss, or a
 * user correction — lands here as one `Gap` record. Records are appended to an
 * append-only JSONL file per day under:
 *
 *     ~/.openclaw/workspace/memory/curiosity-gaps/YYYY-MM-DD.jsonl
 *
 * This directory is auto-indexed by memorySearch (memory-layout.md:129 — "any new
 * directory added under workspace/memory/ will be picked up automatically"), so no
 * indexer change is required.
 *
 * Design invariants (from the J8 plan + recon risks):
 *  - **No self-output-as-truth (§9.3):** `source:"lcm-entropy"` gaps are *questions*,
 *    never facts. They may only ever be resolved from an EXTERNAL channel; this
 *    module records resolutionSource but enforcement of "external only" lives in the
 *    active-learning cron body.
 *  - **Atomic writes (feedback_atomic_store_writes):** JSONL append is naturally
 *    append-safe (O_APPEND single write). The daily-index summary, if added later,
 *    must go through read-modify-write-rename. We never blind-overwrite a shared file.
 *  - **Dedupe (recon risk #8):** NO-MATCH spam collapses by `(recipe|tool|reason)`;
 *    other sources by `(source|topic)`. Frequency is counted, not duplicated.
 *
 * Pure functions (`rescore`, `dedupeKey`, `classifyGap`, `detectUncertaintySpans`,
 * `extractTopic`, `dedupeGaps`, `topGaps`) take all inputs as arguments and touch no
 * disk, so they are unit-testable without temp dirs. The I/O functions
 * (`appendGap`, `readGaps`, `markResolved`) accept an optional `baseDir` override so
 * tests can point at a temp dir.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type GapSource =
  | "lcm-entropy"
  | "no-match"
  | "retrieval-miss"
  | "user-correction"
  | "manual";

export type ResolutionType = "recoverable" | "knowledge-gap" | "external-outage";

export interface Gap {
  id: string;
  topic: string;
  source: GapSource;
  ts: number;
  sessionKey?: string;
  runId?: string;
  // scoring inputs (2a/2b), each 0..1
  importance: number;
  learnability: number;
  adjacency: number;
  userRelevance: number;
  // dedupe frequency — how many identical detections collapsed into this record
  frequency?: number;
  // NO-MATCH specifics (2e)
  recipeName?: string;
  stepName?: string;
  toolName?: string;
  reason?: string;
  resolutionType?: ResolutionType;
  // resolution audit (2b)
  resolvedAt?: number;
  resolvedBy?: string;
  resolutionSource?: string;
}

export interface RelevanceWeights {
  importance: number;
  learnability: number;
  adjacency: number;
  userRelevance: number;
  recency: number;
}

/**
 * Default scoring weights. Tunable; the plan (open question 2b) leaves the source
 * of the per-user weight vector as a product decision, so we ship a balanced default
 * that slightly favors importance + user-relevance over raw learnability.
 */
export const DEFAULT_WEIGHTS: RelevanceWeights = {
  importance: 0.3,
  learnability: 0.2,
  adjacency: 0.1,
  userRelevance: 0.3,
  recency: 0.1,
};

/** Half-life (days) for the recency term: a gap loses half its recency weight every N days. */
export const RECENCY_HALF_LIFE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

/** The on-disk root for curiosity gaps. Override-able for tests via the `baseDir` arg. */
export function curiosityGapsDir(baseDir?: string): string {
  if (baseDir) {
    return baseDir;
  }
  const home = process.env.OPENCLAW_HOME ?? os.homedir();
  return path.join(home, ".openclaw", "workspace", "memory", "curiosity-gaps");
}

/** Local YYYY-MM-DD for a timestamp (defaults to now). */
export function dayStamp(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dailyFilePath(ts: number, baseDir?: string): string {
  return path.join(curiosityGapsDir(baseDir), `${dayStamp(ts)}.jsonl`);
}

// --------------------------------------------------------------------------
// ID generation (no `ulid` dependency available in the fork)
// --------------------------------------------------------------------------

let _idCounter = 0;
/**
 * Roughly-sortable, collision-resistant id: base36 millis + a per-process counter +
 * random suffix. Lexicographically ordered within a process for same-ms calls.
 */
export function gapId(ts: number = Date.now()): string {
  const t = ts.toString(36).padStart(9, "0");
  const c = (_idCounter++ & 0xffffff).toString(36).padStart(5, "0");
  const r = Math.floor(Math.random() * 0x7fffffff)
    .toString(36)
    .padStart(6, "0");
  return `gap_${t}${c}${r}`;
}

// --------------------------------------------------------------------------
// Gap construction
// --------------------------------------------------------------------------

export interface NewGapInput {
  topic: string;
  source: GapSource;
  ts?: number;
  sessionKey?: string;
  runId?: string;
  importance?: number;
  learnability?: number;
  adjacency?: number;
  userRelevance?: number;
  recipeName?: string;
  stepName?: string;
  toolName?: string;
  reason?: string;
  resolutionType?: ResolutionType;
}

const clamp01 = (n: number | undefined, dflt = 0.5): number => {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return dflt;
  }
  return Math.max(0, Math.min(1, n));
};

/** Normalize a partial input into a fully-formed Gap (no I/O). */
export function makeGap(input: NewGapInput): Gap {
  const ts = input.ts ?? Date.now();
  const gap: Gap = {
    id: gapId(ts),
    topic: input.topic.trim(),
    source: input.source,
    ts,
    importance: clamp01(input.importance),
    learnability: clamp01(input.learnability),
    adjacency: clamp01(input.adjacency),
    userRelevance: clamp01(input.userRelevance),
    frequency: 1,
  };
  if (input.sessionKey) {
    gap.sessionKey = input.sessionKey;
  }
  if (input.runId) {
    gap.runId = input.runId;
  }
  if (input.recipeName) {
    gap.recipeName = input.recipeName;
  }
  if (input.stepName) {
    gap.stepName = input.stepName;
  }
  if (input.toolName) {
    gap.toolName = input.toolName;
  }
  if (input.reason) {
    gap.reason = input.reason;
  }
  if (input.resolutionType) {
    gap.resolutionType = input.resolutionType;
  }
  return gap;
}

// --------------------------------------------------------------------------
// Scoring (pure)
// --------------------------------------------------------------------------

/**
 * Recency factor in [0,1]: 1.0 for a gap detected now, decaying with the
 * configured half-life. `nowTs` defaults to Date.now() — pass it explicitly in
 * tests for determinism.
 */
export function recencyFactor(gapTs: number, nowTs: number = Date.now()): number {
  const ageDays = Math.max(0, (nowTs - gapTs) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Priority score for a gap. Monotone non-decreasing in each scoring input and in
 * recency (newer = higher). Returns a weighted sum normalized by the weight total,
 * so the result stays in [0,1] for inputs in [0,1].
 */
export function rescore(
  gap: Gap,
  weights: RelevanceWeights = DEFAULT_WEIGHTS,
  nowTs: number = Date.now(),
): number {
  const rec = recencyFactor(gap.ts, nowTs);
  const w = weights;
  const total = w.importance + w.learnability + w.adjacency + w.userRelevance + w.recency;
  if (total <= 0) {
    return 0;
  }
  const sum =
    w.importance * gap.importance +
    w.learnability * gap.learnability +
    w.adjacency * gap.adjacency +
    w.userRelevance * gap.userRelevance +
    w.recency * rec;
  return sum / total;
}

// --------------------------------------------------------------------------
// Dedupe (pure)
// --------------------------------------------------------------------------

/**
 * Logical identity of a gap for dedupe. NO-MATCH gaps collapse by
 * (recipe|tool|reason); everything else by (source|normalized-topic).
 */
export function dedupeKey(
  g: Pick<Gap, "source" | "topic" | "recipeName" | "toolName" | "reason">,
): string {
  if (g.source === "no-match") {
    return `no-match|${g.recipeName ?? ""}|${g.toolName ?? ""}|${(g.reason ?? "").trim().toLowerCase()}`;
  }
  return `${g.source}|${g.topic.trim().toLowerCase()}`;
}

/**
 * Collapse a list of gaps by dedupeKey. The earliest record is kept as the canonical
 * row; `frequency` is summed; `ts` is bumped to the most-recent sighting (so recency
 * scoring reflects the latest occurrence). Resolution state is preserved if ANY of
 * the duplicates was resolved.
 */
export function dedupeGaps(gaps: Gap[]): Gap[] {
  const byKey = new Map<string, Gap>();
  for (const g of gaps) {
    const key = dedupeKey(g);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...g, frequency: g.frequency ?? 1 });
      continue;
    }
    existing.frequency = (existing.frequency ?? 1) + (g.frequency ?? 1);
    if (g.ts > existing.ts) {
      existing.ts = g.ts;
    }
    // carry resolution forward (a later resolution row resolves the logical gap)
    if (g.resolvedAt && (!existing.resolvedAt || g.resolvedAt > existing.resolvedAt)) {
      existing.resolvedAt = g.resolvedAt;
      existing.resolvedBy = g.resolvedBy;
      existing.resolutionSource = g.resolutionSource;
    }
  }
  return [...byKey.values()];
}

/**
 * The active-learning queue: open (unresolved) gaps, deduped, re-scored, sorted
 * descending by priority, capped at k. Pure — caller supplies the gap list.
 */
export function topGaps(
  gaps: Gap[],
  opts: { k?: number; weights?: RelevanceWeights; nowTs?: number } = {},
): Array<{ gap: Gap; priority: number }> {
  const k = opts.k ?? 5;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const nowTs = opts.nowTs ?? Date.now();
  const open = dedupeGaps(gaps).filter((g) => !g.resolvedAt);
  const scored = open.map((gap) => ({ gap, priority: rescore(gap, weights, nowTs) }));
  scored.sort((a, b) => b.priority - a.priority);
  return scored.slice(0, k);
}

// --------------------------------------------------------------------------
// NO-MATCH gap classification (2e, pure)
// --------------------------------------------------------------------------

/**
 * Classify a tool/recipe failure into a resolution type. Rule-based now
 * (LLM-classifier is the documented later option, plan 2e open question):
 *   - permission/auth/denied  -> "recoverable"   (the user can grant it)
 *   - network/timeout/5xx/down -> "external-outage" (not learnable)
 *   - everything else (unknown tool, bad args, "no such")  -> "knowledge-gap"
 *
 * Only "knowledge-gap" should ever feed the learnable curiosity buffer; the other
 * two emit a trail event but no Gap (recon risk #2: don't waste active-learning on
 * a transient outage).
 */
export function classifyGap(
  toolName: string | undefined,
  reason: string | undefined,
): ResolutionType {
  const hay = `${toolName ?? ""} ${reason ?? ""}`.toLowerCase();
  if (
    /\b(permission|denied|unauthor|forbidden|not allowed|not granted|access)\b/.test(hay) ||
    /\b40[13]\b/.test(hay)
  ) {
    return "recoverable";
  }
  if (
    /\b(timeout|timed out|econn|network|unreachable|5\d{2}|service unavailable|down|offline|rate.?limit|429)\b/.test(
      hay,
    )
  ) {
    return "external-outage";
  }
  return "knowledge-gap";
}

// --------------------------------------------------------------------------
// LCM uncertainty heuristic (2a, pure)
// --------------------------------------------------------------------------

const HEDGE_PATTERNS: RegExp[] = [
  /\bi(?:'m| am) not (?:sure|certain)\b/i,
  /\bi (?:don'?t|do not) know\b/i,
  /\bi(?:'m| am) not (?:aware|familiar)\b/i,
  /\bnot (?:entirely |fully |completely )?(?:sure|certain)\b/i,
  /\b(?:might|may|could) be\b/i,
  /\bas of my (?:knowledge|last|training)\b/i,
  /\bi (?:can'?t|cannot) (?:find|recall|remember)\b/i,
  /\bi'?m unsure\b/i,
  /\bunclear (?:to me )?(?:whether|if|how)\b/i,
  /\bbeyond my knowledge\b/i,
];

/**
 * Detect hedging / uncertainty spans in a completed reply. Returns the matched
 * substrings. Guards against false positives by ignoring matches inside
 * blockquotes / fenced code / quoted (echoed) user content — the model hedging in
 * its OWN voice is the signal, not it quoting someone else.
 */
export function detectUncertaintySpans(finalText: string): string[] {
  if (!finalText || !finalText.trim()) {
    return [];
  }
  const masked = maskQuotedContent(finalText);
  const hits: string[] = [];
  for (const re of HEDGE_PATTERNS) {
    const m = masked.match(re);
    if (m) {
      hits.push(m[0]);
    }
  }
  return hits;
}

/** Replace quoted/code/echoed regions with spaces so hedges inside them don't match. */
function maskQuotedContent(text: string): string {
  let out = text;
  // fenced code blocks
  out = out.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
  // inline code
  out = out.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
  // markdown blockquote lines (> ...)
  out = out.replace(/^\s*>.*$/gm, (m) => " ".repeat(m.length));
  // double-quoted spans (user echoes)
  out = out.replace(/"[^"]*"/g, (m) => " ".repeat(m.length));
  return out;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "this",
  "that",
  "it",
  "i",
  "you",
  "we",
  "what",
  "how",
  "why",
  "when",
  "where",
  "about",
  "with",
  "as",
  "my",
  "your",
  "do",
  "does",
  "not",
  "sure",
  "know",
  "can",
  "could",
  "would",
  "should",
]);

/**
 * Pick a topic for a detected gap: prefer a salient noun-phrase from the user's
 * last message (that's what they actually wanted to know); fall back to tokens near
 * the hedge in the reply. Returns a short topic string, never a stopword.
 */
export function extractTopic(spans: string[], lastUserMessage?: string): string {
  const candidates: string[] = [];
  if (lastUserMessage) {
    candidates.push(...salientTerms(lastUserMessage));
  }
  if (candidates.length === 0 && spans.length > 0) {
    candidates.push(...salientTerms(spans.join(" ")));
  }
  // Prefer a 2-gram of the first two salient terms for a richer topic, else 1.
  if (candidates.length >= 2) {
    return `${candidates[0]} ${candidates[1]}`;
  }
  if (candidates.length === 1) {
    return candidates[0]!;
  }
  return "unspecified";
}

function salientTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// --------------------------------------------------------------------------
// I/O — atomic JSONL append + reader + resolution stamping
// --------------------------------------------------------------------------

/**
 * Append a gap as one JSONL line to today's (or the gap's day's) file. Uses
 * `fs.appendFileSync` with O_APPEND semantics — atomic for single writes, so
 * concurrent appenders never interleave a partial line. Creates the directory
 * lazily. Returns the path written.
 */
export function appendGap(gap: Gap, baseDir?: string): string {
  const dir = curiosityGapsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = dailyFilePath(gap.ts, baseDir);
  fs.appendFileSync(file, JSON.stringify(gap) + "\n", "utf8");
  return file;
}

/** Parse one JSONL file into Gap records, skipping malformed lines defensively. */
function readJsonl(file: string): Gap[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Gap[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      out.push(JSON.parse(t) as Gap);
    } catch {
      // skip corrupt line — append-only logs can have a torn tail
    }
  }
  return out;
}

/**
 * Read and merge the last `sinceDays` daily files (inclusive of today), oldest→newest.
 * Returns the raw record stream (NOT deduped — callers dedupe via `topGaps`/`dedupeGaps`
 * so resolution rows can be folded in).
 */
export function readGaps(
  opts: { sinceDays?: number; baseDir?: string; nowTs?: number } = {},
): Gap[] {
  const sinceDays = opts.sinceDays ?? 7;
  const nowTs = opts.nowTs ?? Date.now();
  const out: Gap[] = [];
  for (let i = sinceDays - 1; i >= 0; i--) {
    const ts = nowTs - i * MS_PER_DAY;
    out.push(...readJsonl(dailyFilePath(ts, opts.baseDir)));
  }
  return out;
}

/**
 * Mark a gap resolved. Append-only audit: we write a *resolution row* (a copy of the
 * gap with resolution fields stamped) to today's file rather than rewriting history.
 * `dedupeGaps` folds the resolution back onto the original by dedupeKey.
 *
 * Returns the resolution record written, or undefined if the id wasn't found in the
 * recent buffer.
 */
export function markResolved(
  id: string,
  by: string,
  source: string,
  opts: { sinceDays?: number; baseDir?: string; nowTs?: number } = {},
): Gap | undefined {
  const gaps = readGaps({
    sinceDays: opts.sinceDays ?? 30,
    baseDir: opts.baseDir,
    nowTs: opts.nowTs,
  });
  const original = gaps.find((g) => g.id === id);
  if (!original) {
    return undefined;
  }
  const now = opts.nowTs ?? Date.now();
  const resolution: Gap = {
    ...original,
    ts: now,
    resolvedAt: now,
    resolvedBy: by,
    resolutionSource: source,
  };
  appendGap(resolution, opts.baseDir);
  return resolution;
}
