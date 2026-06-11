/**
 * FORK: Shared type contract for the parallel fractal reflection v3 plugin.
 *
 * Design of record: TINKER_UI_DESIGN_BIBLE/bible.md §5.67a + §5.67b (§5.67b
 * wins on conflict). The triage lane emits exactly one fenced JSON verdict
 * block (see triage-prompt.md — the committed parse contract); these types
 * are its type-side mirror and MUST stay in lockstep with that prompt.
 *
 * No imports. The only runtime exports are DEFAULT_FRACTAL_CONFIG and the
 * canonical run-kind predicate (FRACTAL_SESSION_PREFIX / isFractalSessionKey).
 */

// ---------------------------------------------------------------------------
// Ledger row status machine
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a fractal reflection ledger row (§5.67b status union).
 *
 * - `pending`   — stub emitted at spawn; the UI docks a placeholder instantly.
 * - `clean`     — triage verdict: nothing to act on.
 * - `acted`     — fix lane ran and completed its change.
 * - `flagged`   — found-not-fixed (Drop 1 cold arm, or fix turn-budget
 *                 exhausted with `incomplete: true` — never `error`).
 * - `gap`       — the only finding was a grounding failure (L0 GROUNDING).
 * - `skipped`   — no model spawned; `skipReason` says why. Never silent.
 * - `proposed`  — host-self-mod / irreversible action queued as a one-click
 *                 proposal patch instead of direct action.
 * - `applied`   — a proposed patch was owner-applied.
 * - `dismissed` — a proposed patch was owner-dismissed.
 * - `suspended` — circuit breaker open or `fractal.suspend` engaged.
 * - `error`     — watchdog converted a stub on VERIFIED deadness, or a hard
 *                 failure (budget exhaustion is `flagged`, not `error`).
 */
export type FractalStatus =
  | "pending"
  | "clean"
  | "acted"
  | "flagged"
  | "gap"
  | "skipped"
  | "proposed"
  | "applied"
  | "dismissed"
  | "suspended"
  | "error";

/**
 * Why a turn was skipped. Skips are never silent (§5.67b, principle #12):
 * every skip writes a ledger row carrying one of these reasons.
 *
 * - `quota`      — governor pressure degraded mode to `skipped:quota`.
 * - `superseded` — single-flight latest-wins replaced this turn's pending slot.
 * - `budget`     — loop-guard token bucket ceiling hit (a plumbing alarm).
 */
export type FractalSkipReason = "quota" | "superseded" | "budget";

// ---------------------------------------------------------------------------
// Triage verdict contract (parse target of triage-prompt.md's JSON block)
// ---------------------------------------------------------------------------

/**
 * Horizontal consequence classes — the `kind` vocabulary of triage findings.
 * MUST match triage-prompt.md's axis list verbatim (the prompt is the parse
 * contract; this union is its mirror — change them together).
 */
export type FractalFindingKind =
  | "staleness-online"
  | "staleness-artifact"
  | "security-exposure"
  | "recurring-cost"
  | "people"
  | "commitment"
  | "downstream-dependency"
  | "correctness"
  | "gap"
  | "persistence"
  | "recipe-gap"
  | "recipe-upgrade"
  | "orca-miss"
  | "process";

/**
 * One triage finding. Evidence is mandatory and falsifiable: file-backed
 * findings carry `path` + a verbatim `quote` from disk, which the plugin
 * re-verifies BEFORE spawning the expensive fix lane (a stale quote kills the
 * finding → `abstainedFindings`). Non-file kinds (`people`, `commitment`,
 * `staleness-online`) carry the external surface or person in `path` and may
 * omit `quote`.
 */
export interface FractalFinding {
  kind: FractalFindingKind;
  /** What is wrong / stale / missing, in one or two sentences. */
  claim: string;
  /** Absolute file path, external surface, or person. */
  path?: string;
  /** Verbatim text from disk proving the claim (re-verified plugin-side). */
  quote?: string;
  /** The concrete change the fix lane should make (prompt key: `fix_hint`). */
  fixHint?: string;
  /** Needs deep multi-step deliberation, not just more tools. Measured, not gating. */
  hard?: boolean;
  /** Plugin-stamped: Nth instance of this finding class (fix the column, not the cell). */
  recurrenceCount?: number;
}

// ---------------------------------------------------------------------------
// Append-only JSONL ledger row (<stateDir>/fractal/results.jsonl)
// ---------------------------------------------------------------------------

/**
 * One version-stamped row in the append-only results ledger (§5.67b result
 * store). `fractal.byRunId` / `fractal.stats` / `fractal.feed` read THIS file
 * (restart-safe) — never the run-context store, which is cleared on the
 * parent's terminal event. Invariant under always-fire: every main-turn
 * `agent_end` yields exactly one row, including `skipped`/`suspended`.
 */
export interface FractalRow {
  /** Row schema version stamp. */
  v: 1;
  /** ISO 8601 timestamp the row was written. */
  ts: string;
  /** The main run this reflection judged (the UI dock anchor). */
  parentRunId: string;
  /** The MAIN session's sessionKey (stream events are emitted under it). */
  sessionKey: string;
  triageRunId?: string;
  fixRunId?: string;
  status: FractalStatus;
  skipReason?: FractalSkipReason;
  /** Triage verdict: `act` ⇒ fix lane warranted; `gap` ⇒ grounding-only. */
  verdict?: "clean" | "act" | "gap";
  /** One plain line summarizing the judgment. */
  headline?: string;
  findings?: FractalFinding[];
  /** Short markdown (zoom + horizontal axes). Narrative — never telemetry. */
  reasoning?: string;
  /** Findings killed plugin-side by stale-quote re-verification. */
  abstainedFindings?: number;
  /** Fix lane hit its turn budget; remaining work persisted, row resumable. */
  incomplete?: boolean;
  /**
   * Cheapest scoped post-edit verifier, stamped plugin-side. vitest with zero
   * matched tests = kind `none`, never `passed: true`.
   */
  verification?: {
    kind: "test" | "typecheck" | "reread" | "none";
    /** The exact command/check that ran. */
    ran?: string;
    passed?: boolean;
  };
  /** Tool-event-derived (transcript join) — the ONLY source for "changed X" claims. */
  artifactsTouched?: string[];
  /** Token usage; warm-ratio = cacheRead / (input + cacheRead + cacheWrite). */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  queueWaitMs?: number;
  timeToDockMs?: number;
  /** Triage escalated to a fix lane this turn. */
  escalated?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/**
 * Plugin config keys. Structural owner: TINKER_UI_DESIGN_BIBLE/config-shape.md
 * (`minGapMs` is RETIRED per §5.67b — do not reintroduce).
 */
export interface FractalConfig {
  enabled: boolean;
  /** Triage transport arm. fork-warm LOCKS model = parent (caches are per-model). */
  triageArm: "cold" | "observer" | "fork-warm";
  triageThinkLevel: string;
  fixThinkLevel: string;
  /** Fix-lane model override; default = the main model. */
  fixModel?: string;
  laneConcurrency: number;
  maxFixTurnsCeiling: number;
  maxFixSpawnsPerHour: number;
  /** Roots the post-fix staleness scan greps (bible, papers, workspace notes). */
  artifactRoots: string[];
}

export const DEFAULT_FRACTAL_CONFIG: FractalConfig = {
  // Config-layer default. Manifest-level enablement (`enabledByDefault: false`;
  // the witnessed plugins.entries flag flip = Drop 1's exit criterion) is a
  // separate gate — this key being true does NOT arm the plugin by itself.
  enabled: true,
  triageArm: "cold",
  triageThinkLevel: "low",
  fixThinkLevel: "max",
  laneConcurrency: 1,
  // #19 safety CEILING, never the working bound: the per-spawn turn budget is
  // derived from the finding's scope (files in evidence, findingKind) and
  // capped here. Derivation formula lives in config-shape.md.
  maxFixTurnsCeiling: 25,
  // CEILING: binds only when usage.status is blind (403/absent); the governor's
  // derived pressure score is the working bound. Derivation in config-shape.md.
  maxFixSpawnsPerHour: 10,
  artifactRoots: [],
};

// ---------------------------------------------------------------------------
// Canonical run-kind predicate (#18 — ONE predicate, ONE prefix constant)
// ---------------------------------------------------------------------------

/**
 * The sessionKey prefix the plugin mints for every lane it spawns. THE single
 * exported constant per principle #18 — consumers import it, never inline the
 * literal (subagents-and-recipes.md carries a verify: gate that fails on any
 * literal `fractal-reflection:` outside this module).
 */
export const FRACTAL_SESSION_PREFIX = "fractal-reflection:";

/**
 * THE one canonical run-kind predicate (#18): "is this run a fractal
 * reflection lane?". Drop 1 operates in prefix-only mode; once the shared
 * run-kind discriminator lands on the core hook ctx (§5.67b cross-consumer
 * hygiene), the L1 meta read routes through here too. Cross-consumer skips
 * (prefrontal, skill-workshop, memory-lancedb) and the plugin's own L2 loop
 * guard MUST import and call this — never re-derive or inline the prefix.
 * (The plugin's private runId Set is an ownership guard — "did I spawn this
 * run" — not this classifier.)
 */
export function isFractalSessionKey(sessionKey: unknown): boolean {
  return typeof sessionKey === "string" && sessionKey.startsWith(FRACTAL_SESSION_PREFIX);
}
