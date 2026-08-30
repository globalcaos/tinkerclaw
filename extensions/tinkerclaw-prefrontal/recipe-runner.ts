/**
 * FORK: prefrontal/recipe-runner — Consumes parallelism.groups from kit frontmatter
 * and dispatches each group's steps as parallel subagents via
 * scripts/openclaw-spawn-subagent.mjs. Plan-row status is the per-step write
 * barrier: in_progress → done (or error on failure).
 *
 * Wired in by: recipe-rpcs.ts (prefrontal.kit.run RPC) which delegates here.
 *
 * Parallelism contract:
 *   parallelism.groups is a list of step-index arrays.
 *   Steps within the same inner array fan out in parallel.
 *   The next group does not start until ALL steps in the prior group are settled.
 *   Absent parallelism block → each step is its own group (fully sequential).
 *
 * Spawn mechanism:
 *   In full gateway mode, dispatches via scripts/openclaw-spawn-subagent.mjs
 *   (node child_process.spawn). Returns runId immediately; plan board updates
 *   live as subagents settle.
 *
 *   In dryRun mode, prints the dispatch plan as JSON without spawning anything.
 *   Useful when the gateway is not running or for testing.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AjvPkg from "ajv";
import type { Plan } from "openclaw/plugin-sdk/fork-prefrontal-schema";
import type { SkillLibrary } from "openclaw/plugin-sdk/fork-recipe-engine";
import { parse as parseYaml } from "yaml";
import { deriveCombinatorFanOut, deriveUsesDepthBudget } from "./combinator-budget.js";
import { deriveOverseerLoopBudget } from "./overseer-budget.js";
import type { PlanStore } from "./plan-store.js";
import type { RecipeParamSpec } from "./recipe-author.js";
import {
  resolveStepRefs,
  parseStepIoDirectives,
  stripStepIoDirectives,
  validateTypedNote,
  parseStepRef,
  parseKitRefValue,
  classifyError,
  isRecoverableKind,
  dotGet,
  type JsonSchema,
  type Port,
  type ClassifiedError,
  type OnErrorPolicy,
} from "./recipe-types.js";
import { deriveRecoveryRetryBudget } from "./recovery-budget.js";
import { deriveRedispatchBudget } from "./redispatch-budget.js";
import { deriveSpawnBudget } from "./spawn-budget.js";
import { evaluateWhen, collectWhenRefs } from "./when-eval.js";

// SS1: shared Ajv for validating typed step outputs (mirrors recipe-rpcs.ts).
const AjvCtor = AjvPkg as unknown as typeof import("ajv").default;
const stepAjv = new AjvCtor({ allErrors: true });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecipeRunOptions {
  /** e.g. "globalcaos/feature" */
  kitRef: string;
  /** plan's session key — used as the plan row identifier */
  sessionKey: string;
  /** user-visible plan intent */
  intent: string;
  /** parameter substitution values applied to step body text */
  parameters?: Record<string, string>;
  /** if true, print the dispatch plan but do not spawn any subagents */
  dryRun?: boolean;
  /** for injection in tests / alternate deploy environments */
  planStore?: PlanStore;
  /** path to the kits directory (default: co-located kits/ dir) */
  ownRecipesDir?: string;
  /** path to the install sandbox (for downloaded kits) */
  recipeInstallSandbox?: string;
  /** FORK 2026-05-29 composition: recursion depth (sub-kits invoked via `uses:`). */
  _depth?: number;
  /** FORK 2026-05-29 composition: kitRefs already on the call stack (cycle guard). */
  _usesChain?: string[];
  /**
   * FORK 2026-05-30 durable checkpointing (Upgrade 5).
   * When true, an existing in_progress plan for this sessionKey with the SAME
   * kitRef is resumed: dispatch starts at plan.currentStep, already-`done` rows
   * are skipped, and prior steps' artifacts are injected into later steps' tasks.
   * Default policy (the architect, 2026-05-30): NO silent re-attach — auto-resume fires
   * only when resume:true is passed. A bare run always force-restarts at step 0.
   */
  resume?: boolean;
  /** FORK 2026-05-30 (Upgrade 5): optional in-flight checkpoint heartbeat sink. */
  onCheckpoint?: CheckpointEmitter;
  /**
   * FORK 2026-05-30 (Upgrade 5): per-step spawn injection seam. Defaults to the
   * real openclaw-spawn-subagent.mjs helper (`spawnStep`). Tests inject a no-op
   * so a mock planStore can drive step completion without a live gateway — the
   * real dispatch path stays untouched in production.
   */
  _spawnStep?: (task: string, label: string, spawnOpts?: SpawnOpts) => Promise<SpawnResult>;
  /**
   * FORK 2026-05-31: recipe-state observability sink. runRecipe calls this at kit
   * start, on each parallel-group transition, and on completion so the Tinker
   * RECIPES panel can render the live recipe header (id + step M/N +
   * parallelism). The caller wires it to fork.prefrontal.setRecipe, which
   * broadcasts the prefrontal-recipe-state lifecycle event. Best-effort and
   * fire-and-forget: recipe-runner wraps every call so observability NEVER throws
   * into the execution loop. Until this was wired the header had no data source
   * and the panel always fell back to the synthetic "Thinking → Acting" plan.
   */
  onRecipeState?: (state: RecipeStateUpdate) => void;
  /**
   * FORK 2026-06 (Upgrade 1): recipe-ATTRIBUTION tag sink.
   *
   * DEFAULT DECISION (attribution is Prefrontal's job): the Cerebellum's
   * recipe-fitness (src/memory/engram/recipe-fitness.ts) attributes an episode to
   * a recipe by reading a `recipe:<owner/slug>` tag off the episode's events, but
   * it is NOT the producer of that tag — the contract is that the EXECUTOR stamps
   * it. recipe-runner is the executor, so it emits the canonical attribution tag here
   * at run start AND at each task dispatch. The caller (recipe-rpcs) forwards the tag
   * to whatever event sink stamps the metadata; recipe-runner stays decoupled from
   * the engram event store (so the native-dep stack is never dragged into this
   * bundled extension — see the onRecipeState rationale above and the J13 embed
   * lane). Best-effort + fire-and-forget: every emit is wrapped so a broken sink
   * can never throw into the dispatch loop.
   */
  onTag?: (ev: TagStamp) => void;
  /**
   * SS1: recipe fitness success rate in [0,1] for the running kit — an OPTIONAL
   * input to the J16 budget-derived re-dispatch bound (more reliable recipe →
   * fewer schema correction attempts). Absent → a 0.5 default, in which case the
   * bound varies only with the step's value-of-work (required-field count). NOT
   * yet threaded by the recipe-rpcs caller; wiring it (and a per-spawn token
   * budget) is a documented SS1 follow-up to bring more J16 signals live in prod.
   */
  fitnessSuccessRate?: number;
  /**
   * SS5b: remaining dispatch/token allowance for the run, if a caller threads one.
   * An OPTIONAL input to the J16 deriveSpawnBudget(...) bound used as the fail-closed
   * default when a step's `max-tokens:` directive is absent / non-numeric / an
   * unresolved {{template}}. NOT yet threaded by the recipe-rpcs caller (the same
   * documented gap as fitnessSuccessRate); absent → the affordability clamp is inert.
   */
  remainingTokenBudget?: number;
  /**
   * SS1: classified-trail sink (mirrors onTag/onRecipeState — best-effort,
   * fire-and-forget, never throws into the run). The runner emits a
   * `schema-mismatch` event on each typed-output re-dispatch so a validation
   * failure is observable, never silent. The caller wires it to
   * fork.prefrontal.trailEvent; absent → no-op (the runner stays gateway-decoupled).
   */
  onTrail?: (ev: TrailEvent) => void;
  /**
   * SS3: the stdlib skill library a step's `invoke skill:<id>` resolves against.
   * Absent → an `invoke skill:` step fails closed (skill not found). The library
   * is read-only here; the runner records outcomes via `onSkillOutcome` (it stays
   * gateway-decoupled, like onTag/onTrail).
   */
  skillLibrary?: SkillLibrary;
  /**
   * SS3: fitness loopback — called on a skill step's terminal outcome
   * (done/error) so the caller can route it to fork.skill.recordOutcome.
   * Best-effort, fire-and-forget (never throws into the run).
   */
  onSkillOutcome?: (skillId: string, success: boolean) => void;
  /**
   * SS5b: OVERSEER keep-going sink. On each supervision pass of the overseer loop
   * (`loop: until OVERSEER_DONE`) whose verdict is a NUDGE (the note does NOT carry
   * the OVERSEER_DONE marker), the runner forwards the nudge text here so the caller
   * can re-prime the supervised task. Mirrors the onTrail/onTag contract exactly:
   * best-effort, fire-and-forget — every call is wrapped so a broken sink can NEVER
   * throw into the execution loop. Absent → no-op (the runner stays gateway-decoupled).
   */
  onKeepGoing?: (sessionKey: string, message: string) => void;
  /**
   * BROCA P1.1 (2026-06-07, ask-for-missing / Seam 4): opt INTO the durable-pause
   * branch at the missing-var clear-fail. Default false → the clear-fail is
   * byte-identical to the shipped behavior (no ask, no wait, no plan seeded). When
   * true AND onAskVar AND a planStore are present, an unmet required param durably
   * pauses the plan (status blocked-awaiting-input on disk) and awaits a resolver.
   */
  interactiveMode?: boolean;
  /**
   * BROCA P1.1: fire-and-forget ask sink. Called ONCE when an interactive run hits
   * a missing required var — the caller surfaces the prompt(s) to the human. Same
   * wrapped/never-throws contract as onCheckpoint/onKeepGoing: a broken sink can
   * never throw into the run. Absent → no durable pause (falls to clear-fail).
   */
  onAskVar?: (ev: {
    sessionKey: string;
    kitRef: string;
    missingVars: { name: string; prompt: string }[];
  }) => void;
  /**
   * BROCA P1.1: resolver SEAM (mirrors _spawnStep) — awaited under a J16-derived
   * timeout to obtain the human's answers for the missing vars. Production wires a
   * real resolver (gateway round-trip + VarStore persistence — a later wave); tests
   * inject one directly. Returns the {name:value} answers, or null on timeout /
   * decline. Absent → a default no-op resolver that returns null (clear-fail). The
   * runner stays gateway-decoupled: it does NOT persist answers to a VarStore — the
   * resolver owns whatever it persists.
   */
  _askResolver?: (ev: {
    sessionKey: string;
    kitRef: string;
    missingVars: { name: string; prompt: string }[];
    timeoutMs: number;
  }) => Promise<Record<string, string> | null>;
}

/** SS1: one classified trail event emitted by the runner (e.g. schema-mismatch). */
export interface TrailEvent {
  kind: string;
  message: string;
  label?: string;
  sessionKey?: string;
  payload?: Record<string, unknown>;
}

/**
 * FORK 2026-06 (Upgrade 1): one recipe-attribution tag emit. `phase` is "start"
 * (the single per-run stamp at runRecipe entry) or "dispatch" (one per task dispatch,
 * carrying the stepIndex). `tag` is always `recipe:<owner/slug>` for the running
 * kit — the exact string recipe-fitness.attributeRecipe() matches on.
 */
export interface TagStamp {
  tag: string;
  phase: "start" | "dispatch";
  stepIndex?: number;
  sessionKey: string;
}

/**
 * FORK 2026-05-31: a single recipe-state observability update emitted by runRecipe.
 * Mirrors the fork.prefrontal.setRecipe param shape so the caller can forward it
 * verbatim. All progress fields optional — the start emit may omit step detail.
 */
export interface RecipeStateUpdate {
  recipeId: string;
  step?: number;
  totalSteps?: number;
  stepName?: string;
  parallelismCap?: number;
  inFlightLabels?: string[];
  sessionKey?: string;
  /** BROCA visibility (2026-06-06): stable per-user-turn id (the run's sessionKey)
   * — the SAME value across every event of one prompt; lets the UI scope the
   * composition to the current turn. Optional → old consumers ignore it. */
  turnId?: string;
  /** BROCA visibility (2026-06-06): the skill the CURRENT step invokes (if any),
   * from the step's `invoke skill:` directive. Optional → old consumers ignore it. */
  skillId?: string;
}

/** FORK 2026-05-30 (Upgrade 5): max chars of a step's done-note persisted as the
 * durable artifact digest. Schema field is bounded at 500 (prefrontal-plan.ts). */
export const ARTIFACT_DIGEST_MAX = 500;

/**
 * FORK 2026-05-30 (Upgrade 5): condense a subagent's done-note into a ≤500-char
 * artifact digest the plan-store can carry in its bounded `artifact` field. Keeps
 * the decision/result line, collapses whitespace, and truncates with an ellipsis.
 * Idempotent on already-short input. The FULL note still lives in the plan body
 * (`step.note`) — this is the bounded carry-forward, not a lossy replacement.
 */
export function summarizeOutput(doneNote: string | null | undefined): string {
  if (!doneNote) return "";
  const collapsed = doneNote.replace(/\s+/g, " ").trim();
  if (collapsed.length <= ARTIFACT_DIGEST_MAX) return collapsed;
  // Truncate on a word boundary near the cap so we don't cut mid-token.
  const slice = collapsed.slice(0, ARTIFACT_DIGEST_MAX - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > ARTIFACT_DIGEST_MAX - 80 ? slice.slice(0, lastSpace) : slice;
  return `${body}…`;
}

/** FORK 2026-05-30 (Upgrade 5): is a given step already settled `done`? */
export function isStepDone(plan: Plan, stepIndex: number): boolean {
  return plan.steps[stepIndex]?.status === "done";
}

/** FORK 2026-05-30 (Upgrade 5): a prior step's carry-forward context. */
export interface PriorArtifact {
  stepIndex: number;
  title: string;
  artifact: string;
  /** SS1: the prior step's validated typed output, when it declared `out:`. */
  output?: unknown;
}

/**
 * FORK 2026-05-30 (Upgrade 5): collect the durable artifacts of every `done`
 * step BEFORE stepIndex, so a resuming / downstream step can read upstream output.
 * SS1: also carry each typed step's validated `output` so downstream `in:` ports
 * and `{{steps.N.out.path}}` refs can bind named fields, not just the prose digest.
 */
export function collectPriorArtifacts(plan: Plan, beforeStep: number): PriorArtifact[] {
  const out: PriorArtifact[] = [];
  plan.steps.forEach((s, i) => {
    if (i >= beforeStep) return;
    if (s.status !== "done") return;
    const artifact = s.artifact ?? summarizeOutput(s.note ?? "");
    // A typed step may carry an output even if its prose digest is empty.
    if (artifact || s.output !== undefined) {
      out.push({ stepIndex: i, title: s.title, artifact: artifact ?? "", output: s.output });
    }
  });
  return out;
}

/**
 * FORK 2026-05-30 (Upgrade 5): prepend a `## Prior step outputs` block to a
 * step's task so the subagent has upstream context. No-op when there are none.
 */
export function withPriorArtifacts(task: string, prior: PriorArtifact[]): string {
  if (prior.length === 0) return task;
  const lines = prior.map((p) => `- Step ${p.stepIndex + 1} (${p.title}): ${p.artifact}`);
  return `## Prior step outputs\n${lines.join("\n")}\n\n---\n\n${task}`;
}

/** Max depth for `uses:` sub-kit recursion — recipes calling recipes. J16: DERIVED
 * (floor 3), not a frozen constant. With no dispatch budget threaded this is 3 —
 * numerically identical to the old `MAX_USES_DEPTH = 3` — and derives UPWARD when a
 * budget signal is wired (recipe-rpcs does not yet thread one — documented follow-up,
 * same gap as fitnessSuccessRate). Computed once at module load. */
const MAX_USES_DEPTH = deriveUsesDepthBudget({});

export interface RecipeRunResult {
  ok: boolean;
  planId: string;
  dryRunPlan?: DryRunDispatchPlan;
  errorMessage?: string;
  /** Per-step results harvested from the plan after the run settles. */
  results?: StepResult[];
  /** SS2a: the value carried by a `return:`/`done:` early-exit (the exiting step's output). */
  returnValue?: unknown;
  /**
   * SS-params (2026-06-07): the structured classification of a seed-time failure
   * (e.g. the `missing-var` clear-fail). Additive — present only on the failing
   * paths that classify their error; `errorMessage` remains the human surface.
   */
  error?: ClassifiedError;
}

export interface StepResult {
  stepIndex: number;
  title: string;
  status: "done" | "error";
  /** The subagent-authored done-note (or error reason), or null if absent. */
  note: string | null;
}

interface StepDispatch {
  stepIndex: number;
  title: string;
  task: string;
  label: string;
  /** FORK: if set, this step runs another kit (owner/slug) instead of a plain subagent.
   * SS2b: may also be an unresolved `{{steps.N.out.path}}` template (isDynamicUsesRef);
   * executeOnce resolves it against prior outputs + validates via parseKitRefValue. */
  usesKitRef?: string;
  /** FORK 2026-05-30: if set, this step repeats (count / until-dry / until-marker). */
  loop?: LoopSpec;
  /** SS1: if set, this step's output is validated against this JSON-Schema. */
  outSchema?: JsonSchema;
  /** SS3: if set, this step invokes a stdlib skill primitive (by id) inline. */
  skillId?: string;
  /** SS2a: a `when:` guard expression; the step runs only if it evaluates true. */
  whenGuard?: string;
  /** SS2a: a `return:`/`done:` marker; closes the plan after this step (early-exit). */
  earlyExit?: boolean;
  /** SS2b: a `map: steps.N.out` ref — fan dispatch.usesKitRef out over this array. */
  mapOver?: string;
  /** SS2b: a `filter: steps.N.out` ref — keep elements of this array passing keepWhen. */
  filterOver?: string;
  /** SS2b: the `keep:` predicate for a filter (evaluated per element with {{item}} substituted). */
  keepWhen?: string;
  /** SS5a: a `onError:` recovery policy — retry N / fallback kit:<id> / continue-partial. */
  onError?: OnErrorPolicy;
  /** SS5b: a `allow-tools:` directive — the comma-separated tool-name allowlist for the spawn. */
  allowTools?: string[];
  /** SS5b: a `max-tokens:` per-spawn token bound. Either the literal directive value or,
   * when the directive is absent / non-numeric / an unresolved {{template}}, the
   * fail-closed deriveSpawnBudget(...) bound (never a throw — mirrors SS5a `retry N`). */
  maxTokens?: number;
  /** SS5b: a `max-tool-calls:` per-spawn tool-call bound (literal or {{template}}; a
   * non-numeric / unresolved value is simply omitted — no fabricated default). */
  maxToolCalls?: number;
  /** §5.84-A: a `model:` per-step model override (raw id or {{template}}). */
  model?: string;
  /** §5.84-A: a `thinking:` per-step effort level (raw level or {{template}}). */
  thinkingLevel?: string;
}

/** The CONSECUTIVE leading directive lines of a step body — only lines that are
 * themselves `uses:`/`loop:` directives, starting from the top (after any blank
 * lines), stopping at the first prose/blank line. So a step may carry both a
 * `loop:` and a `uses:` directive in either order, but a `uses:` buried in prose
 * or a code fence is NOT collected (re-opening that was a 2026-05-29 review bug). */
function leadingDirectives(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (out.length > 0) break; // a blank after directives ends the block
      continue; // skip leading blank lines
    }
    if (
      !/^(?:uses|loop|when|return|done|map|filter|keep|onError|allow-tools|max-tokens|max-tool-calls|model|thinking):|^invoke\s+skill:/i.test(
        line,
      )
    )
      break; // first prose line ends the block
    out.push(line);
  }
  return out;
}

/** The composition seam: a leading `uses: <kit>` directive runs another kit
 * instead of a plain subagent. A STATIC bare slug normalizes to `globalcaos/<slug>`.
 * SS2b: a `{{steps.N.out.path}}` / `{{param}}` template is returned RAW (unresolved)
 * — executeOnce resolves it at dispatch time (the kit-factory edge), then validates
 * via parseKitRefValue. isDynamicUsesRef distinguishes the two forms. */
export function parseUsesDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const tpl = /^uses:\s*(\{\{[^}]+\}\})\s*$/.exec(line);
    if (tpl) return tpl[1];
    const m = /^uses:\s*([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)\s*$/i.exec(line);
    if (!m) continue;
    const ref = m[1];
    return ref.includes("/") ? ref : `globalcaos/${ref}`;
  }
  return undefined;
}

/** SS2b: is a `uses:` ref a `{{…}}` template (resolved at dispatch) vs a static slug? */
export function isDynamicUsesRef(ref: string | undefined): boolean {
  return typeof ref === "string" && ref.startsWith("{{") && ref.endsWith("}}");
}

/** SS3: a leading `invoke skill:<id>` directive calls a stdlib skill primitive
 * inline (a sibling of `uses:`). Skill ids match `[A-Za-z0-9._-]`. Returns the
 * id, or undefined when no invoke directive leads the (io-stripped) body. */
export function parseInvokeSkillDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^invoke\s+skill:\s*([A-Za-z0-9._-]+)\s*$/i.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** SS2a: a leading `when: <expr>` guard. Returns the raw expression (non-empty), or undefined. */
export function parseWhenDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^when:\s*(.+\S)\s*$/i.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** SS2a: a bare leading `return:` / `done:` early-exit marker (nothing after the colon). */
export function parseEarlyExitDirective(body: string): boolean {
  for (const line of leadingDirectives(body)) {
    if (/^(?:return|done):\s*$/i.test(line)) return true;
  }
  return false;
}

/** SS2b: a leading `map: steps.<n>.out[.path]` directive — fan a worker out over
 * the array at that ref. Recognized ONLY when the remainder parses as a
 * steps.<n>.out reference (else it is PROSE, e.g. "map: the files in src/"). */
export function parseMapIterDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^map:\s*(\S+)\s*$/i.exec(line);
    if (!m) continue;
    return parseStepRef(m[1]) ? m[1] : undefined;
  }
  return undefined;
}

/** SS2b: a leading `filter: steps.<n>.out[.path]` directive — keep the elements of
 * that array that pass a `keep:` predicate (or a predicate-kit's truthy returnValue).
 * Prose-collision guarded exactly like parseMapIterDirective. */
export function parseFilterIterDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^filter:\s*(\S+)\s*$/i.exec(line);
    if (!m) continue;
    return parseStepRef(m[1]) ? m[1] : undefined;
  }
  return undefined;
}

/** SS2b: a leading `keep: <when-expr over {{item}}>` predicate for a filter step. */
export function parseKeepDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^keep:\s*(.+\S)\s*$/i.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** SS5a: a leading `onError: <policy>` recovery directive. Three forms:
 *   onError: retry <N|{{template}}>   — re-run the step (bounded by deriveRecoveryRetryBudget)
 *   onError: fallback kit:<id>        — dispatch a recovery kit via the uses: edge
 *   onError: continue-partial         — settle as done-partial (do not abort)
 * Returns the parsed OnErrorPolicy, or undefined when no onError directive leads
 * the (io-stripped) body. A `retry` N may be a literal or a `{{template}}` (resolved
 * at dispatch like uses:; a non-numeric resolution fails closed to the derived bound). */
export function parseOnErrorDirective(body: string): OnErrorPolicy | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^onError:\s*(.+\S)\s*$/i.exec(line);
    if (!m) continue;
    const spec = m[1].trim();
    const retry = /^retry\s+(\S+)$/i.exec(spec);
    if (retry) return { mode: "retry", retryCount: retry[1] };
    const fallback = /^fallback\s+kit:\s*(\S+)$/i.exec(spec);
    if (fallback) return { mode: "fallback", kitRef: fallback[1] };
    if (/^continue-partial$/i.test(spec)) return { mode: "continue-partial" };
    return undefined; // an unrecognized onError body is left as no policy
  }
  return undefined;
}

/** SS5b: a leading `allow-tools: a, b, c` directive — the comma-separated tool-name
 * allowlist threaded to the spawn as `--allow-tools`. Returns the trimmed,
 * non-empty names, or undefined when no allow-tools directive leads the body. */
export function parseAllowToolsDirective(body: string): string[] | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^allow-tools:\s*(.+\S)\s*$/i.exec(line);
    if (!m) continue;
    const names = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return names.length > 0 ? names : undefined;
  }
  return undefined;
}

/** SS5b: a leading `max-tokens: <int|{{template}}>` directive — the RAW value
 * (literal or {{template}}). Resolution + the fail-closed deriveSpawnBudget(...)
 * fallback happen at the dispatch-build call site (mirrors the SS5a `retry N`
 * template rule). Returns the raw string, or undefined when absent. */
export function parseMaxTokensDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^max-tokens:\s*(.+\S)\s*$/i.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** SS5b: a leading `max-tool-calls: <int|{{template}}>` directive — the RAW value
 * (literal or {{template}}). A non-numeric / unresolved value is simply omitted at
 * the call site (no fabricated default). Returns the raw string, or undefined. */
export function parseMaxToolCallsDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^max-tool-calls:\s*(.+\S)\s*$/i.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** §5.84-A: a leading `model: <id|{{template}}>` directive (raw string). */
export function parseModelDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^model:\s*(.+\S)\s*$/i.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}
/** §5.84-A: a leading `thinking: <level|{{template}}>` directive (raw string). */
export function parseThinkingDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^thinking:\s*(.+\S)\s*$/i.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** SS2b: resolve a dynamic `uses: {{steps.N.out.path}}` template against prior
 * steps' typed outputs (mirrors resolveStepRefs), then normalize+validate it as a
 * kitRef. Returns the canonical owner/slug, or null when unresolvable/malformed. */
export function resolveKitRefTemplate(
  rawRef: string,
  outputsByStep: Map<number, unknown>,
): string | null {
  const resolved = resolveStepRefs(rawRef, outputsByStep).trim();
  // resolveStepRefs leaves an unresolvable ref verbatim → still a {{…}} → reject.
  if (resolved.startsWith("{{")) return null;
  return parseKitRefValue(resolved);
}

// ─── Recipe loops (FORK 2026-05-30) ─────────────────────────────────────────
// A step can repeat — the structural gap vs Claude Code workflows. A leading
// `loop:` directive re-runs the step (spawn or sub-kit) until a condition or a
// hard cap. Three modes mirror the workflow patterns:
//   loop: count <N>           — run exactly N times (or until an iteration fails)
//   loop: until-dry [max <M>] — re-run until a subagent reports nothing new
//   loop: until <MARKER> [max <M>] — re-run until a step note contains MARKER
// Every loop is bounded (DEFAULT_LOOP_MAX, hard-capped at HARD_LOOP_MAX) so a
// runaway recipe can never spin forever.

export interface LoopSpec {
  mode: "count" | "until-dry" | "until-marker";
  max: number;
  marker?: string;
}

const DEFAULT_LOOP_MAX = 5;
const HARD_LOOP_MAX = 25;

export function parseLoopDirective(body: string): LoopSpec | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^loop:\s*(?:count\s+(\d+)|until-dry|until\s+(\S+))(?:\s+max\s+(\d+))?\s*$/i.exec(
      line,
    );
    if (!m) continue;
    const clamp = (n: number) => Math.max(1, Math.min(HARD_LOOP_MAX, n));
    if (m[1] !== undefined) return { mode: "count", max: clamp(parseInt(m[1], 10)) };
    if (m[2] !== undefined) {
      return {
        mode: "until-marker",
        marker: m[2],
        max: clamp(m[3] ? parseInt(m[3], 10) : DEFAULT_LOOP_MAX),
      };
    }
    return { mode: "until-dry", max: clamp(m[3] ? parseInt(m[3], 10) : DEFAULT_LOOP_MAX) };
  }
  return undefined;
}

/** A step note signals "dry" (nothing new this iteration) → stop an until-dry
 * loop. Empty/absent notes count as dry. */
export function isDryNote(note: string | null | undefined): boolean {
  if (!note || !note.trim()) return true;
  return /\b(no new|nothing new|none (?:found|left|remain\w*)|complete\w*|done|dry|exhausted|finished|no more|all (?:covered|found|done))\b/i.test(
    note,
  );
}

interface DryRunDispatchPlan {
  kitRef: string;
  intent: string;
  groups: StepDispatch[][];
  totalSteps: number;
}

// ─── Kit body parser ─────────────────────────────────────────────────────────

interface ParsedKitStep {
  index: number;
  title: string;
  body: string;
}

interface RecipeParallelism {
  groups: number[][];
}

interface ParsedRecipe {
  steps: ParsedKitStep[];
  parallelism: RecipeParallelism | null;
}

export function parseKitStepsAndParallelism(text: string): ParsedRecipe {
  // Strip frontmatter, collect parallelism block and step sections.
  const fmMatch = /^---\n([\s\S]+?)\n---\n/.exec(text);
  let parallelism: RecipeParallelism | null = null;
  if (fmMatch) {
    try {
      const fm = parseYaml(fmMatch[1]) as Record<string, unknown> | null;
      if (fm && typeof fm === "object" && fm.parallelism) {
        const p = fm.parallelism as Record<string, unknown>;
        if (Array.isArray(p.groups)) {
          parallelism = { groups: p.groups as number[][] };
        }
      }
    } catch {
      // YAML parse failure — treat as no parallelism block
    }
  }

  const body = fmMatch ? text.slice(fmMatch[0].length) : text;
  const steps: ParsedKitStep[] = [];

  // Split body on "### N. Title" headings (as used by all 19 source kits)
  const headingRe = /^#{1,6}\s+(\d+)\.\s+(.+)$/m;
  const parts = body.split(/(?=^#{1,6}\s+\d+\.\s+)/m);
  for (const part of parts) {
    const m = headingRe.exec(part);
    if (!m) continue;
    // The kit uses 1-based heading numbers; we normalise to 0-based index.
    const headingNumber = parseInt(m[1], 10);
    const index = headingNumber - 1; // convert "1. Explore" → stepIndex 0
    const title = m[2].trim();
    const stepBody = part.slice(m[0].length).trim();
    steps.push({ index, title, body: stepBody });
  }

  // Sort by index in case headings are out of order
  steps.sort((a, b) => a.index - b.index);

  return { steps, parallelism };
}

/**
 * Build the list of step groups from a parallelism block (or fallback to
 * one group per step if the block is absent / invalid).
 */
function resolveGroups(kit: ParsedRecipe): number[][] {
  if (kit.parallelism?.groups && kit.parallelism.groups.length > 0) {
    // Validate: every group must be a non-empty array, all indices in range
    const stepCount = kit.steps.length;
    const valid = kit.parallelism.groups.every(
      (g) =>
        Array.isArray(g) &&
        g.length > 0 &&
        g.every((idx) => typeof idx === "number" && idx >= 0 && idx < stepCount),
    );
    if (valid) return kit.parallelism.groups;
  }
  // Fallback: each step is its own group (fully sequential)
  return kit.steps.map((s) => [s.index]);
}

// ─── SS1: plan-compile port-wiring check ───────────────────────────────────────

/** SS1: a step reduced to just the fields the port-wiring check needs. */
export interface CompileStep {
  title: string;
  /** SS-params: the step's cleaned body text — scanned for {{token}} refs by checkParamRefs. */
  body?: string;
  out?: JsonSchema;
  in?: Port[];
  when?: string;
  /** SS2b: a STATIC `uses:` kitRef (already normalized to owner/slug). */
  usesKitRef?: string;
  /** SS2b: a DYNAMIC `uses: {{steps.N.out.path}}` worker template (unresolved). */
  usesWorkerRef?: string;
  /** SS5a: the step's onError recovery policy (for checkOnErrorRefs at seed). */
  onError?: OnErrorPolicy;
}

/**
 * SS1: verify every `in:` port resolves to a real, EARLIER producer step whose
 * `out:` schema declares the referenced field. Returns human-readable errors;
 * an empty array means the wiring is sound. Run at seed time so a mis-wired
 * recipe fails fast — before any step executes (FOUNDATION: contracts at boundaries).
 */
export function checkPortWiring(steps: CompileStep[]): string[] {
  const errors: string[] = [];
  steps.forEach((step, i) => {
    const consumerNumber = i + 1;
    for (const port of step.in ?? []) {
      const ref = parseStepRef(port.from);
      if (!ref) {
        errors.push(
          `step ${consumerNumber} port "${port.name}": from is not a steps.<n>.out reference`,
        );
        continue;
      }
      if (ref.stepNumber < 1 || ref.stepNumber > steps.length) {
        errors.push(
          `step ${consumerNumber} port "${port.name}": references step ${ref.stepNumber} which does not exist`,
        );
        continue;
      }
      if (ref.stepNumber >= consumerNumber) {
        errors.push(
          `step ${consumerNumber} port "${port.name}": step ${ref.stepNumber} must precede it`,
        );
        continue;
      }
      const producer = steps[ref.stepNumber - 1];
      if (!producer.out) {
        errors.push(
          `step ${consumerNumber} port "${port.name}": step ${ref.stepNumber} declares no out: schema`,
        );
        continue;
      }
      const firstSegment = ref.path.split(".")[0];
      if (firstSegment) {
        const props = (producer.out as { properties?: Record<string, unknown> }).properties ?? {};
        if (!(firstSegment in props)) {
          errors.push(
            `step ${consumerNumber} port "${port.name}": step ${ref.stepNumber} out: schema has no field "${firstSegment}"`,
          );
        }
      }
    }
  });
  return errors;
}

/**
 * SS2a: verify every `when:` reference resolves to a real, EARLIER producer step
 * whose `out:` schema declares the referenced field. Existence-only (matches
 * checkPortWiring); run at seed time so a mis-guarded recipe fails fast.
 */
export function checkWhenRefs(steps: CompileStep[]): string[] {
  const errors: string[] = [];
  steps.forEach((step, i) => {
    if (!step.when) return;
    const consumerNumber = i + 1;
    for (const refStr of collectWhenRefs(step.when)) {
      const ref = parseStepRef(refStr);
      if (!ref) {
        errors.push(`step ${consumerNumber} when: "${refStr}" is not a steps.<n>.out reference`);
        continue;
      }
      if (ref.stepNumber < 1 || ref.stepNumber > steps.length) {
        errors.push(
          `step ${consumerNumber} when: references step ${ref.stepNumber} which does not exist`,
        );
        continue;
      }
      if (ref.stepNumber >= consumerNumber) {
        errors.push(`step ${consumerNumber} when: step ${ref.stepNumber} must precede it`);
        continue;
      }
      const producer = steps[ref.stepNumber - 1];
      if (!producer.out) {
        errors.push(`step ${consumerNumber} when: step ${ref.stepNumber} declares no out: schema`);
        continue;
      }
      const firstSegment = ref.path.split(".")[0];
      if (firstSegment) {
        const props = (producer.out as { properties?: Record<string, unknown> }).properties ?? {};
        if (!(firstSegment in props)) {
          errors.push(
            `step ${consumerNumber} when: step ${ref.stepNumber} out: schema has no field "${firstSegment}"`,
          );
        }
      }
    }
  });
  return errors;
}

/**
 * SS2b: seed-time combinator-ref validation (mirrors checkPortWiring / checkWhenRefs).
 *  - A STATIC `uses:` kitRef must parse via parseKitRefValue and must NOT be the
 *    host kit itself (a self-cycle reachable at depth 0). Cross-kit cycles through
 *    runtime data are caught at dispatch by the _usesChain guard (documented).
 *  - A DYNAMIC `uses: {{steps.N.out.path}}` worker ref must be a well-formed ref to
 *    a strictly-EARLIER step that declares an `out:` schema (existence-only — the
 *    bound value's kitRef validity is re-checked at dispatch by parseKitRefValue).
 */
export function checkCombinatorRefs(steps: CompileStep[], hostKitRef: string): string[] {
  const errors: string[] = [];
  steps.forEach((step, i) => {
    const consumerNumber = i + 1;
    if (step.usesKitRef) {
      const norm = parseKitRefValue(step.usesKitRef);
      if (!norm) {
        errors.push(`step ${consumerNumber} uses: "${step.usesKitRef}" is not a valid kitRef`);
      } else if (norm === hostKitRef) {
        errors.push(`step ${consumerNumber} uses: "${norm}" is the host kit itself (self-cycle)`);
      }
    }
    if (step.usesWorkerRef) {
      const inner = step.usesWorkerRef.replace(/^\{\{\s*|\s*\}\}$/g, "");
      const ref = parseStepRef(inner);
      if (!ref) {
        errors.push(
          `step ${consumerNumber} uses: "${step.usesWorkerRef}" is not a {{steps.<n>.out…}} reference`,
        );
        return;
      }
      if (ref.stepNumber < 1 || ref.stepNumber > steps.length) {
        errors.push(
          `step ${consumerNumber} uses: references step ${ref.stepNumber} which does not exist`,
        );
        return;
      }
      if (ref.stepNumber >= consumerNumber) {
        errors.push(`step ${consumerNumber} uses: step ${ref.stepNumber} must precede it`);
        return;
      }
      const producer = steps[ref.stepNumber - 1];
      if (!producer.out) {
        errors.push(`step ${consumerNumber} uses: step ${ref.stepNumber} declares no out: schema`);
      }
    }
  });
  return errors;
}

/**
 * SS5a: seed-time onError-ref validation (mirrors checkCombinatorRefs). A
 * `fallback kit:<id>` ref must parse via parseKitRefValue and must NOT be the host
 * kit itself (a self-cycle — falling back to the same kit that failed loops). A
 * `retry`/`continue-partial` policy carries no ref → nothing to check. A `{{…}}`
 * fallback kitRef is allowed through (resolved+re-validated at dispatch, like uses:).
 */
export function checkOnErrorRefs(steps: CompileStep[], hostKitRef: string): string[] {
  const errors: string[] = [];
  steps.forEach((step, i) => {
    const consumerNumber = i + 1;
    const policy = step.onError;
    if (!policy || policy.mode !== "fallback") return;
    if (isDynamicUsesRef(policy.kitRef)) return; // dynamic → checked at dispatch
    const norm = parseKitRefValue(policy.kitRef);
    if (!norm) {
      errors.push(
        `step ${consumerNumber} onError: fallback kit "${policy.kitRef}" is not a valid kitRef`,
      );
    } else if (norm === hostKitRef) {
      errors.push(
        `step ${consumerNumber} onError: fallback kit "${norm}" is the host kit itself (self-cycle)`,
      );
    }
  });
  return errors;
}

/**
 * SS-params (2026-06-07): seed-time parameter-ref validation (mirrors
 * checkOnErrorRefs). Collect every `{{token}}` across all step bodies and
 * hard-fail any token that is neither a declared parameter nor a recognized
 * NON-param ref. EXCLUDED (not a param, resolved elsewhere at dispatch):
 *   - `steps.<n>.out…`  (typed prior-step output refs)
 *   - `item` / `index`  (map/filter per-element bindings)
 * Any remaining `{{token}}` MUST name a declared param — so a typo'd / undeclared
 * `{{token}}` fails fast at seed instead of silently surviving substitution.
 */
export function checkParamRefs(
  steps: CompileStep[],
  decls: Record<string, RecipeParamSpec> | undefined,
): string[] {
  const errors: string[] = [];
  const declared = new Set(Object.keys(decls ?? {}));
  const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
  // Leading directives (uses/when/map/onError/allow-tools/max-tokens/max-tool-calls/in/out/
  // invoke skill) carry their OWN {{template}} resolution with fail-closed semantics — they
  // are NOT prose param substitution, so their tokens must not be flagged here (e.g. SS5b
  // max-tokens:{{x}} intentionally fails closed to the derived bound rather than erroring).
  // Only the prose body is scanned for undeclared param refs.
  const DIRECTIVE_LINE_RE =
    /^\s*(?:uses|loop|when|return|done|map|filter|keep|onError|allow-tools|max-tokens|max-tool-calls|in|out)\s*:|^\s*invoke\s+skill\s*:/i;
  steps.forEach((step, i) => {
    const consumerNumber = i + 1;
    const body = step.body ?? "";
    for (const line of body.split("\n")) {
      if (DIRECTIVE_LINE_RE.test(line)) continue;
      for (const m of line.matchAll(TOKEN_RE)) {
        const token = m[1].trim();
        if (/^steps\.\d+\.out/.test(token)) continue; // typed prior-step output ref
        if (token === "item" || token === "index") continue; // map/filter per-element binding
        if (declared.has(token)) continue; // a declared parameter
        errors.push(
          `step ${consumerNumber}: {{${token}}} is not a declared parameter (declare it under params: or use a steps.<n>.out / item / index ref)`,
        );
      }
    }
  });
  return errors;
}

/**
 * SS-params (2026-06-07): the clear-fail backstop. AFTER the RPC-ingress precedence
 * merge + validateParams have produced the RESOLVED param map, any declared param
 * still flagged `required:true` with no resolved value (undefined OR empty string)
 * is a hard `missing-var`. Returns one {name,prompt} per missing var so the runner
 * can FAIL CLEARLY (list every name + its prompt + how to set it) — it never blocks
 * and waits (the interactive ask-loop is a separate follow-up). The `prompt` is the
 * param's `description` (a public-safe name/prompt — never a value, of which there is
 * none), falling back to a generic `value for "<name>"`.
 */
export function checkRequiredVars(
  decls: Record<string, RecipeParamSpec> | undefined,
  resolved: Record<string, string>,
): { name: string; prompt: string }[] {
  if (!decls) return [];
  const missing: { name: string; prompt: string }[] = [];
  for (const [name, d] of Object.entries(decls)) {
    if (d.required && (resolved[name] === undefined || resolved[name] === "")) {
      missing.push({ name, prompt: d.description ?? `value for "${name}"` });
    }
  }
  return missing;
}

// ─── Parameter substitution ───────────────────────────────────────────────────

function substituteParameters(text: string, params: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(params)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ─── SS-params: run-ingress parameter validation ───────────────────────────────

/** SS-params: the boolean truthy/falsy literals a `boolean` param coerces from. */
const BOOL_TRUE = new Set(["true", "1", "yes"]);
const BOOL_FALSE = new Set(["false", "0", "no"]);

/**
 * SS-params (2026-06-07): tolerantly normalize a recipe's `params:` frontmatter
 * block into typed RecipeParamSpec decls. Mirrors recipe-parse.ts EXACTLY (the
 * panel/runner READER) — kept self-contained here (no import of parseRecipeMd,
 * which would create a recipe-parse ↔ recipe-runner import cycle). validateRecipeSpec
 * is the hard authoring gate; this stays lenient.
 */
export function parseParamsFromText(kitText: string): Record<string, RecipeParamSpec> | undefined {
  const fmMatch = /^---\n([\s\S]+?)\n---/.exec(kitText);
  if (!fmMatch) return undefined;
  let fm: Record<string, unknown> | null = null;
  try {
    fm = parseYaml(fmMatch[1]) as Record<string, unknown> | null;
  } catch {
    return undefined;
  }
  if (!fm || typeof fm.params !== "object" || fm.params === null || Array.isArray(fm.params)) {
    return undefined;
  }
  const acc: Record<string, RecipeParamSpec> = {};
  for (const [name, raw] of Object.entries(fm.params as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const spec: RecipeParamSpec = { type: (r.type as RecipeParamSpec["type"]) ?? "string" };
    if (typeof r.required === "boolean") spec.required = r.required;
    if (r.default !== undefined) spec.default = r.default;
    if (typeof r.secret === "boolean") spec.secret = r.secret;
    if (typeof r.description === "string") spec.description = r.description;
    if (typeof r.pattern === "string") spec.pattern = r.pattern;
    if (Array.isArray(r.enum)) spec.enum = r.enum.filter((e): e is string => typeof e === "string");
    acc[name] = spec;
  }
  return Object.keys(acc).length > 0 ? acc : undefined;
}

/**
 * SS-params: load a recipe's DECLARED params (the `params:` frontmatter block),
 * reusing loadRecipeText's path resolution. Returns undefined when the recipe is
 * unreadable or declares no params (back-compat: an un-parameterized recipe runs
 * untouched). Never throws — a missing recipe just yields undefined here, and the
 * real load error surfaces inside runRecipe.
 */
export async function loadRecipeParams(
  kitRef: string,
  ownRecipesDir: string,
  recipeInstallSandbox: string,
): Promise<Record<string, RecipeParamSpec> | undefined> {
  let text: string;
  try {
    text = await loadRecipeText(kitRef, ownRecipesDir, recipeInstallSandbox);
  } catch {
    return undefined;
  }
  return parseParamsFromText(text);
}

/**
 * SS-params (2026-06-07): run-ingress validation + coercion of caller-provided
 * parameter values against a recipe's declared param specs. PURE (no I/O). The
 * single fail-before-spawn gate for both dry-run and live runs.
 *
 *  - undefined / empty decls → pass-through: {ok:true, values: provided ?? {}, errors:[]}
 *    (an un-parameterized recipe is untouched — back-compat).
 *  - unknown provided key (not in decls) → reject.
 *  - missing required (no value, no default) → reject, naming the description.
 *  - a declared key absent from provided but with a `default` → the default is filled.
 *  - each value is COERCED to a string per its type:
 *      string      → as-is; if `pattern` is set the value must match it
 *      number      → String(finite); a non-finite value rejects
 *      boolean     → true/false/1/0/yes/no → 'true' | 'false'; anything else rejects
 *      enum        → must be a member of decls.enum (else reject)
 *      list<string>→ CSV: trim each element, drop empties, re-join with ','
 */
export function validateParams(
  decls: Record<string, RecipeParamSpec> | undefined,
  provided: Record<string, string> | undefined,
): { ok: boolean; values: Record<string, string>; errors: string[] } {
  const given = provided ?? {};
  if (!decls || Object.keys(decls).length === 0) {
    return { ok: true, values: { ...given }, errors: [] };
  }
  const errors: string[] = [];
  const values: Record<string, string> = {};

  // 1) reject any provided key that is not declared.
  for (const key of Object.keys(given)) {
    if (!(key in decls)) errors.push(`unknown parameter "${key}" (not declared by this recipe)`);
  }

  // 2) per declared param: required/default handling + typed coercion.
  for (const [name, spec] of Object.entries(decls)) {
    const hasValue = Object.prototype.hasOwnProperty.call(given, name);
    if (!hasValue) {
      if (spec.default !== undefined) {
        // fill the declared default (already type-validated at author time).
        if (spec.type === "list<string>" && Array.isArray(spec.default)) {
          values[name] = (spec.default as unknown[]).map((x) => String(x)).join(",");
        } else {
          values[name] = String(spec.default);
        }
        continue;
      }
      if (spec.required) {
        const desc = spec.description ? ` — ${spec.description}` : "";
        errors.push(`missing required parameter "${name}"${desc}`);
      }
      continue; // optional with no default → simply unset
    }

    const raw = given[name];
    switch (spec.type) {
      case "string": {
        if (spec.pattern) {
          let re: RegExp | null = null;
          try {
            re = new RegExp(spec.pattern);
          } catch {
            re = null;
          }
          if (re && !re.test(raw)) {
            errors.push(`parameter "${name}" must match /${spec.pattern}/ — got "${raw}"`);
            continue;
          }
        }
        values[name] = raw;
        break;
      }
      case "number": {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          errors.push(`parameter "${name}" must be a finite number — got "${raw}"`);
          continue;
        }
        values[name] = String(n);
        break;
      }
      case "boolean": {
        const lc = raw.trim().toLowerCase();
        if (BOOL_TRUE.has(lc)) values[name] = "true";
        else if (BOOL_FALSE.has(lc)) values[name] = "false";
        else {
          errors.push(
            `parameter "${name}" must be a boolean (true/false/1/0/yes/no) — got "${raw}"`,
          );
          continue;
        }
        break;
      }
      case "enum": {
        const members = spec.enum ?? [];
        if (!members.includes(raw)) {
          errors.push(`parameter "${name}" must be one of ${members.join("|")} — got "${raw}"`);
          continue;
        }
        values[name] = raw;
        break;
      }
      case "list<string>": {
        const items = raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        values[name] = items.join(",");
        break;
      }
      default: {
        // an unrecognized type should never reach here (author-time validated);
        // pass the raw value through rather than dropping it.
        values[name] = raw;
      }
    }
  }

  return { ok: errors.length === 0, values, errors };
}

// ─── Spawn helper ─────────────────────────────────────────────────────────────

/**
 * Path to the openclaw-spawn-subagent.mjs helper, resolved relative to this
 * file's location. From dist/extensions/tinkerclaw-prefrontal/ go three levels
 * up to the repo root, then into scripts/.
 */
function resolveSpawnHelperPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "..", "..", "..", "scripts", "openclaw-spawn-subagent.mjs");
}

interface SpawnResult {
  ok: boolean;
  childSessionKey?: string;
  runId?: string;
  error?: string;
}

/**
 * SS5b: per-spawn budget directives threaded into the openclaw-spawn-subagent.mjs
 * argv. Each field is OPTIONAL — only present flags are appended (an absent field
 * adds no argv entry, so the existing spawn behavior is unchanged).
 */
export interface SpawnOpts {
  /** `--allow-tools` comma-joined tool allowlist. */
  allowTools?: string[];
  /** `--max-tokens` per-spawn token bound. */
  maxTokens?: number;
  /** `--max-tool-calls` per-spawn tool-call bound. */
  maxToolCalls?: number;
  /** `--model` per-spawn model override (§5.84-A). */
  model?: string;
  /** `--thinking` per-spawn effort level (§5.84-A). */
  thinkingLevel?: string;
}

/**
 * Invoke openclaw-spawn-subagent.mjs for a single step. Returns a promise that
 * resolves when the subagent has been spawned (not when it completes — the
 * recipe-runner polls plan-row status for completion).
 *
 * Timeout: 120s per spawn call (time for the subagent to be accepted by the
 * gateway; actual execution continues independently).
 */
function spawnStep(task: string, label: string, spawnOpts?: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const helperPath = resolveSpawnHelperPath();
    // SS5b: append per-spawn budget flags ONLY when present (an absent directive
    // adds no argv entry, so the existing spawn path is byte-for-byte unchanged).
    const budgetArgs: string[] = [];
    if (spawnOpts?.allowTools && spawnOpts.allowTools.length > 0) {
      budgetArgs.push("--allow-tools", spawnOpts.allowTools.join(","));
    }
    if (spawnOpts?.maxTokens != null && Number.isFinite(spawnOpts.maxTokens)) {
      budgetArgs.push("--max-tokens", String(spawnOpts.maxTokens));
    }
    if (spawnOpts?.maxToolCalls != null && Number.isFinite(spawnOpts.maxToolCalls)) {
      budgetArgs.push("--max-tool-calls", String(spawnOpts.maxToolCalls));
    }
    if (spawnOpts?.model) budgetArgs.push("--model", spawnOpts.model);
    if (spawnOpts?.thinkingLevel) budgetArgs.push("--thinking", spawnOpts.thinkingLevel);
    const child = spawn(
      process.execPath,
      [helperPath, "--task", task, "--label", label, ...budgetArgs, "--json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: `spawn timeout after 120s for label=${label}` });
    }, 120_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const payload = JSON.parse(stdout.trim()) as Record<string, unknown>;
        if (payload.ok) {
          resolve({
            ok: true,
            childSessionKey:
              typeof payload.childSessionKey === "string" ? payload.childSessionKey : undefined,
            runId: typeof payload.runId === "string" ? payload.runId : undefined,
          });
        } else {
          resolve({
            ok: false,
            error: String(payload.error ?? `exit ${code} stderr=${stderr.slice(0, 200)}`),
          });
        }
      } catch {
        resolve({
          ok: false,
          error: `JSON parse failed: stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 200)}`,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `child process error: ${String(err)}` });
    });
  });
}

// ─── Plan-row polling ─────────────────────────────────────────────────────────

/**
 * FORK 2026-05-30 (Upgrade 5): how long a single step may poll before we emit a
 * checkpoint heartbeat trail event. Lets the guardian distinguish a stalled poll
 * from genuine long work (mitigates Risk 3 loop-runaway + Risk 4 lossy recovery).
 */
const CHECKPOINT_INTERVAL_MS = 120_000;

/** FORK 2026-05-30 (Upgrade 5): optional in-flight checkpoint emitter. */
export type CheckpointEmitter = (ev: {
  sessionKey: string;
  stepIndex: number;
  elapsedMs: number;
}) => void;

/**
 * Poll the plan store until the given step reaches a terminal status
 * (done | error). Times out after maxWaitMs. Emits a heartbeat checkpoint every
 * CHECKPOINT_INTERVAL_MS so a long-polling step is observably alive (Upgrade 5).
 */
async function waitForStepDone(
  store: PlanStore,
  sessionKey: string,
  stepIndex: number,
  maxWaitMs = 600_000,
  onCheckpoint?: CheckpointEmitter,
): Promise<"done" | "error" | "timeout"> {
  const start = Date.now();
  const deadline = start + maxWaitMs;
  let lastCheckpoint = start;
  while (Date.now() < deadline) {
    await sleep(3_000);
    const now = Date.now();
    if (onCheckpoint && now - lastCheckpoint >= CHECKPOINT_INTERVAL_MS) {
      lastCheckpoint = now;
      try {
        onCheckpoint({ sessionKey, stepIndex, elapsedMs: now - start });
      } catch {
        // a broken emitter must never abort the poll loop
      }
    }
    const plan = await store.get(sessionKey);
    if (!plan) return "error";
    const step = plan.steps[stepIndex];
    if (!step) return "error";
    if (step.status === "done") return "done";
    if (step.status === "error") return "error";
  }
  return "timeout";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Recipe file resolution ───────────────────────────────────────────────────
//
// DUAL-READ (rename migration 2026-06-02): a recipe definition is `recipe.md`
// in the new layout, but legacy definitions are still `kit.md`. We probe
// recipe.md FIRST (so freshly authored recipes win) then fall back to kit.md,
// in both the own-recipes dir and the per-owner install sandbox. No on-disk
// move is required — old kit.md definitions keep loading unchanged.
const RECIPE_FILENAMES = ["recipe.md", "kit.md"] as const;

export async function loadRecipeText(
  kitRef: string,
  ownRecipesDir: string,
  recipeInstallSandbox: string,
): Promise<string> {
  const [owner, slug] = kitRef.split("/");
  const candidates: string[] = [];
  // OVERLAY (first-readable-wins): the OPENCLAW_HOME recipes overlay is probed
  // BEFORE the own-recipes dir, so an installed/overridden copy wins over the
  // bundled definition. Same dual-read (recipe.md preferred, kit.md legacy).
  const overlayDir = resolveRecipeOverlayDir();
  for (const fname of RECIPE_FILENAMES) candidates.push(join(overlayDir, slug, fname));
  for (const fname of RECIPE_FILENAMES) candidates.push(join(ownRecipesDir, slug, fname));
  for (const fname of RECIPE_FILENAMES)
    candidates.push(join(recipeInstallSandbox, owner, slug, fname));
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf-8");
    } catch {
      // try next
    }
  }
  throw new Error(`recipe-runner: recipe ${kitRef} not found in ${candidates.join(" or ")}`);
}

// ─── Result collection ────────────────────────────────────────────────────────

/**
 * Harvest per-step results from a settled plan. Returns title + status + the
 * done-note the subagent (or the runner, on failure) wrote into the plan row.
 * This is the result-capture seam: the note is a SHORT summary, not the
 * subagent's full transcript. Only done/error steps are returned.
 */
export function collectStepResults(plan: Plan): StepResult[] {
  const out: StepResult[] = [];
  plan.steps.forEach((s, i) => {
    if (s.status !== "done" && s.status !== "error") return;
    out.push({
      stepIndex: i,
      title: s.title,
      status: s.status,
      note: s.note ?? null,
    });
  });
  return out;
}

// ─── Recipes-dir resolution ───────────────────────────────────────────────────
//
// The own-recipes dir is `<repo-root>/extensions/tinkerclaw-prefrontal/recipes`
// in the new (canonical) layout, with `kits` as the legacy fallback. The caller
// lives at a DIFFERENT depth depending on layout: source is at
// extensions/tinkerclaw-prefrontal/ (3 levels deep) while the bundle is at
// dist/ root (1 level deep). A fixed `..` count is correct for only one of them.
// Walk UP from startDir and return the FIRST ancestor whose
// `extensions/tinkerclaw-prefrontal/{recipes,kits}` exists on disk — both
// layouts share the same repo root, so this resolves correctly regardless of
// bundle depth. recipes/ is preferred; kits/ is the legacy fallback (dual-read).
// Falls back to the legacy 3-up resolve so behavior never gets worse.
//
// The OVERLAY recipes dir lives under OPENCLAW_HOME (the runtime/workspace home),
// defaulting to `<HOME>/.openclaw/recipes`. loadRecipeText probes it FIRST so an
// installed or overridden recipe copy wins over the bundled definition.
export function resolveRecipeOverlayDir(): string {
  return join(
    process.env.OPENCLAW_HOME ?? join(process.env.HOME ?? "/tmp", ".openclaw"),
    "recipes",
  );
}

export function resolveOwnRecipesDir(startDir: string): string {
  const MAX_LEVELS = 8;
  let dir = startDir;
  for (let i = 0; i < MAX_LEVELS; i++) {
    for (const leaf of ["recipes", "kits"]) {
      const candidate = join(dir, "extensions", "tinkerclaw-prefrontal", leaf);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break; // reached filesystem root
    }
    dir = parent;
  }
  return resolve(startDir, "..", "..", "..", "extensions", "tinkerclaw-prefrontal", "recipes");
}

/**
 * BROCA P1.1 (2026-06-07): derive — NEVER freeze — the wait budget for a durable
 * ask-for-missing-input pause, co-located with the deriveSpawnBudget philosophy.
 *
 * J16 (FOUNDATION §1, "fractal not fixed"): how long the agent should hold a plan
 * blocked-awaiting-input is NOT a constant. It is a function of the live situation:
 *   - missingVarCount : more values to gather earns more time
 *   - stepCount       : a longer recipe is worth waiting on (capped at 12 steps)
 *   - confidence      : a shaky recipe (low fitness) earns a longer grace window
 * base = 60s + 30s/missing + 5s*min(stepCount,12), scaled by (1 + uncertainty)
 * where uncertainty = 1 - clamp01(fitnessSuccessRate ?? 0.5); floored at base.
 * The coefficients are a derivation, not the answer; the OUTPUT responds to the
 * inputs (proven by recipe-runner-ask.integration.test.ts). Do NOT collapse this
 * to a literal — that would re-introduce a frozen ASK_TIMEOUT (the J16 anti-pattern).
 */
export function deriveAskTimeoutMs(signals: {
  missingVarCount: number;
  fitnessSuccessRate?: number;
  stepCount: number;
}): number {
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const base =
    60000 +
    30000 * Math.max(0, signals.missingVarCount) +
    5000 * Math.min(Math.max(0, signals.stepCount), 12);
  const uncertainty = 1 - clamp01(signals.fitnessSuccessRate ?? 0.5); // [0,1]
  const derived = Math.round(base * (1 + uncertainty));
  return Math.max(base, derived);
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runRecipe(opts: RecipeRunOptions): Promise<RecipeRunResult> {
  // Resolve directories
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const ownRecipesDir = opts.ownRecipesDir ?? resolveOwnRecipesDir(thisDir);
  const recipeInstallSandbox =
    opts.recipeInstallSandbox ?? join(process.env.HOME ?? "/tmp", ".openclaw", "workspace", "kits");

  // Load the recipe (recipe.md preferred, kit.md legacy fallback)
  let kitText: string;
  try {
    kitText = await loadRecipeText(opts.kitRef, ownRecipesDir, recipeInstallSandbox);
  } catch (err) {
    return { ok: false, planId: "", errorMessage: String(err) };
  }

  const kit = parseKitStepsAndParallelism(kitText);
  if (kit.steps.length === 0) {
    return {
      ok: false,
      planId: "",
      errorMessage: `recipe-runner: kit ${opts.kitRef} has no parsable steps`,
    };
  }

  // SS1: fail fast on malformed typed-port directives or mis-wired ports BEFORE
  // seeding a plan or dispatching any step (plan-compile check).
  let compileSteps: CompileStep[];
  try {
    compileSteps = kit.steps.map((s) => {
      const io = parseStepIoDirectives(s.body);
      // SS3 eager lift: an `invoke skill:` step with no explicit `out:` adopts the
      // skill's outputSchema NOW (at compile) so checkPortWiring validates
      // downstream `in:` ports against the skill's REAL output. (`uses:` resolves
      // lazily in executeOnce; a skill's output contract must resolve at compile.)
      let out = io.out;
      if (!out && opts.skillLibrary) {
        const sid = parseInvokeSkillDirective(stripStepIoDirectives(s.body));
        const sk = sid ? opts.skillLibrary.read(sid) : undefined;
        if (sk?.outputSchema) out = sk.outputSchema;
      }
      const cleaned = stripStepIoDirectives(s.body);
      const usesRef = parseUsesDirective(cleaned);
      return {
        title: s.title,
        // SS-params: carry the cleaned body so checkParamRefs can scan {{token}} refs.
        body: cleaned,
        out,
        in: io.in,
        when: parseWhenDirective(cleaned),
        usesKitRef: usesRef && !isDynamicUsesRef(usesRef) ? usesRef : undefined,
        usesWorkerRef: usesRef && isDynamicUsesRef(usesRef) ? usesRef : undefined,
        onError: parseOnErrorDirective(cleaned),
      };
    });
  } catch (err) {
    return {
      ok: false,
      planId: "",
      errorMessage: `recipe-runner: malformed typed-port directive in ${opts.kitRef}: ${String(err)}`,
    };
  }
  const wiringErrors = checkPortWiring(compileSteps);
  if (wiringErrors.length > 0) {
    return {
      ok: false,
      planId: "",
      errorMessage: `recipe-runner: port-wiring check failed:\n - ${wiringErrors.join("\n - ")}`,
    };
  }
  const whenErrors = checkWhenRefs(compileSteps);
  if (whenErrors.length > 0) {
    return {
      ok: false,
      planId: "",
      errorMessage: `recipe-runner: when-guard check failed:\n - ${whenErrors.join("\n - ")}`,
    };
  }
  const combErrors = checkCombinatorRefs(compileSteps, opts.kitRef);
  if (combErrors.length > 0) {
    return {
      ok: false,
      planId: "",
      errorMessage: `recipe-runner: combinator-ref check failed:\n - ${combErrors.join("\n - ")}`,
    };
  }
  const onErrorErrors = checkOnErrorRefs(compileSteps, opts.kitRef);
  if (onErrorErrors.length > 0) {
    return {
      ok: false,
      planId: "",
      errorMessage: `recipe-runner: onError-ref check failed:\n - ${onErrorErrors.join("\n - ")}`,
    };
  }

  // SS-params (2026-06-07): every {{token}} in a step body must be a declared
  // parameter (or a steps.<n>.out / item / index ref). Thread the recipe's parsed
  // `params:` frontmatter as the declared set so an undeclared/typo'd token fails
  // fast at seed — before any step executes (FOUNDATION: contracts at boundaries).
  const declaredParams = parseParamsFromText(kitText);
  const paramRefErrors = checkParamRefs(compileSteps, declaredParams);
  if (paramRefErrors.length > 0) {
    return {
      ok: false,
      planId: "",
      errorMessage: `recipe-runner: param-ref check failed:\n - ${paramRefErrors.join("\n - ")}`,
    };
  }

  const groups = resolveGroups(kit);

  // Build dispatch plan (used for both dryRun output and live dispatch)
  const params = opts.parameters ?? {};

  // SS-params (2026-06-07): clear-fail backstop. `params` here is the RESOLVED map
  // (RPC ingress already ran the precedence merge + validateParams). If a declared
  // `required:true` param STILL has no value, fail CLEARLY — listing every missing
  // name + prompt + how to supply it.
  //
  // BROCA P1.1 (2026-06-07, durable-pause branch / Seam 4): when the caller opts
  // into interactiveMode AND wires an onAskVar sink AND a planStore is present, we
  // do NOT clear-fail immediately. Instead we durably PAUSE: seed the plan, write
  // status `blocked-awaiting-input` to disk BEFORE asking (so a crash mid-wait is
  // recoverable), fire onAskVar (fire-and-forget, wrapped), and await the injected
  // resolver under a J16-DERIVED timeout (deriveAskTimeoutMs — never a frozen const).
  // If the human supplies the missing value(s), merge them into params, re-check,
  // flip status back to `in_progress`, and FALL THROUGH to the normal dispatch path.
  // On timeout / null / still-missing we keep the SHIPPED clear-fail return. When
  // NOT interactive the clear-fail below is byte-identical to before this branch.
  //
  // NOTE: the runner does NOT persist answers to a VarStore — it stays
  // gateway-decoupled; durable VarStore persistence is wired in a later wave via
  // the resolver the RPC supplies (the resolver owns whatever it persists).
  let interactiveSeedRunId: string | null = null;
  const buildMissingVarFail = (missing: { name: string; prompt: string }[]): RecipeRunResult => {
    const list = missing.map((m) => `${m.name} — ${m.prompt}`).join("; ");
    return {
      ok: false,
      planId: "",
      errorMessage:
        `recipe-runner: missing required variable(s): ${list}. ` +
        `Set them with \`openclaw recipe set-var ${opts.kitRef} <name> <value>\` ` +
        `(values stay private in ~/.openclaw/recipe-vars.json).`,
      error: classifyError("missing-var", `missing required variable(s): ${list}`, {
        missingVars: missing,
      }),
    };
  };
  let missingVars = checkRequiredVars(declaredParams, params);
  if (missingVars.length > 0) {
    if (opts.interactiveMode && opts.onAskVar && opts.planStore) {
      // Durable pause: seed the plan first so setStatus has a plan to mutate, then
      // mark it blocked-awaiting-input ON DISK before we ask anyone.
      const askStore = opts.planStore;
      try {
        const seeded = await askStore.set({
          sessionKey: opts.sessionKey,
          intent: opts.intent,
          runId: `kit-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
          kitRef: opts.kitRef,
          steps: kit.steps.map((s) => ({ title: s.title })),
        });
        interactiveSeedRunId = seeded.runId;
      } catch {
        // could not seed → fall back to the shipped clear-fail (no durable pause).
        return buildMissingVarFail(missingVars);
      }
      try {
        await askStore.setStatus(opts.sessionKey, "blocked-awaiting-input");
      } catch {
        // status write failed → fall back to clear-fail; the plan exists but we
        // cannot reliably mark the pause, so do not enter the wait.
        return buildMissingVarFail(missingVars);
      }
      // Fire-and-forget ask sink (same wrapped/never-throws contract as onCheckpoint).
      try {
        opts.onAskVar({ sessionKey: opts.sessionKey, kitRef: opts.kitRef, missingVars });
      } catch {
        // ask observability must never break the run
      }
      const timeoutMs = deriveAskTimeoutMs({
        missingVarCount: missingVars.length,
        fitnessSuccessRate: opts.fitnessSuccessRate,
        stepCount: kit.steps.length,
      });
      // Default resolver returns null (no answer) — production wires a real resolver.
      const resolver =
        opts._askResolver ?? (async (): Promise<Record<string, string> | null> => null);
      let answers: Record<string, string> | null = null;
      try {
        answers = await resolver({
          sessionKey: opts.sessionKey,
          kitRef: opts.kitRef,
          missingVars,
          timeoutMs,
        });
      } catch {
        answers = null;
      }
      if (answers) {
        Object.assign(params, answers);
        missingVars = checkRequiredVars(declaredParams, params);
        if (missingVars.length === 0) {
          // Unblocked: flip the durable status back and FALL THROUGH to dispatch.
          try {
            await askStore.setStatus(opts.sessionKey, "in_progress");
          } catch {
            // non-fatal: dispatch still proceeds; the board may show stale status.
          }
        } else {
          // Still missing after the answer → clear-fail (plan stays blocked on disk).
          return buildMissingVarFail(missingVars);
        }
      } else {
        // timeout / null / declined → keep the SHIPPED clear-fail. The plan stays
        // blocked-awaiting-input on disk (a durable record of the unmet need).
        return buildMissingVarFail(missingVars);
      }
    } else {
      // Non-interactive (or no sink / no store): the SHIPPED clear-fail, unchanged.
      return buildMissingVarFail(missingVars);
    }
  }
  const dispatchGroups: StepDispatch[][] = groups.map((groupIndices) =>
    groupIndices.map((idx) => {
      const step = kit.steps[idx];
      if (!step) {
        throw new Error(
          `recipe-runner: parallelism.groups references invalid step index ${idx} (kit has ${kit.steps.length} steps)`,
        );
      }
      // SS1: lift typed IO from the leading directives, then strip them so the
      // subagent never sees raw `out:`/`in:` lines. `uses:`/`loop:` are parsed off
      // the cleaned body so directive order (io vs uses/loop) doesn't matter.
      const stepIo = parseStepIoDirectives(step.body);
      const cleanBody = stripStepIoDirectives(step.body);
      const skillId = parseInvokeSkillDirective(cleanBody);
      // SS3: an `invoke skill:` step injects the skill's PROCEDURE into the task
      // and adopts its output contract; a step-level `out:` still NARROWS it.
      const skill = skillId ? opts.skillLibrary?.read(skillId) : undefined;
      const effectiveOut = stepIo.out ?? (skill?.outputSchema as JsonSchema | undefined);
      const rawTask = `Kit: ${opts.kitRef}\nStep ${idx + 1}/${kit.steps.length}: ${step.title}\n\n${cleanBody}`;
      let task = substituteParameters(rawTask, params);
      if (skill) {
        const ref = skill.verifiedCode
          ? `\n\nReference implementation:\n${skill.verifiedCode}`
          : "";
        // Surface the input contract for visibility (a hard structured-input gate
        // belongs to SS2's structured-call model — this execution path binds
        // inputs as prompt text, so there is no structured input object to reject).
        const inHint = skill.inputSchema
          ? `\n\nExpected input shape:\n${JSON.stringify(skill.inputSchema, null, 2)}`
          : "";
        task += `\n\n---\nSkill ${skillId} procedure:\n${skill.steps.join("\n")}${ref}${inHint}`;
      }
      if (effectiveOut) {
        // Instruct the subagent to emit a single fenced json block matching the schema.
        task +=
          "\n\n---\n**Structured output required.** End your reply with one ```json fenced block " +
          "that validates against this JSON-Schema (and nothing after it):\n```json\n" +
          JSON.stringify(effectiveOut, null, 2) +
          "\n```";
      }
      const label = `${opts.kitRef}:step-${idx}`;
      const usesKitRef = parseUsesDirective(cleanBody);
      const loop = parseLoopDirective(cleanBody);
      const whenGuard = parseWhenDirective(cleanBody);
      const earlyExit = parseEarlyExitDirective(cleanBody);
      const skillForBudget = skillId ? opts.skillLibrary?.read(skillId) : undefined;
      // SS5b: parse the per-spawn directives. `allow-tools` is a name list. A
      // `max-tool-calls` keeps only a numeric literal (no fabricated default). For
      // `max-tokens`: a numeric literal wins; ABSENT / non-numeric / an unresolved
      // {{template}} FAILS CLOSED to the J16 deriveSpawnBudget(...) bound (never a
      // throw — mirrors the SS5a `retry N` template rule). Prior typed outputs are
      // not available at build time, so a {{template}} cannot resolve here and falls
      // through to the derived bound by design.
      const allowTools = parseAllowToolsDirective(cleanBody);
      const rawMaxTokens = parseMaxTokensDirective(cleanBody);
      const rawMaxToolCalls = parseMaxToolCallsDirective(cleanBody);
      const requiredFieldCount = Array.isArray((effectiveOut as { required?: unknown })?.required)
        ? (effectiveOut as { required: unknown[] }).required.length
        : 0;
      const derivedSpawnBudget = deriveSpawnBudget({
        requiredFieldCount,
        skillInvoked: !!skillForBudget,
        fitnessSuccessRate: opts.fitnessSuccessRate,
        remainingTokenBudget: opts.remainingTokenBudget,
      });
      const parsedMaxTokens = rawMaxTokens != null ? Number.parseInt(rawMaxTokens, 10) : NaN;
      const maxTokens = Number.isFinite(parsedMaxTokens) ? parsedMaxTokens : derivedSpawnBudget;
      const parsedMaxToolCalls =
        rawMaxToolCalls != null ? Number.parseInt(rawMaxToolCalls, 10) : NaN;
      const maxToolCalls = Number.isFinite(parsedMaxToolCalls) ? parsedMaxToolCalls : undefined;
      const rawModel = parseModelDirective(cleanBody);
      const rawThinking = parseThinkingDirective(cleanBody);
      return {
        stepIndex: idx,
        title: step.title,
        task,
        label,
        usesKitRef,
        loop,
        outSchema: effectiveOut,
        skillId,
        whenGuard,
        earlyExit,
        mapOver: parseMapIterDirective(cleanBody),
        filterOver: parseFilterIterDirective(cleanBody),
        keepWhen: parseKeepDirective(cleanBody),
        onError: parseOnErrorDirective(cleanBody),
        allowTools,
        maxTokens,
        maxToolCalls,
        model: rawModel,
        thinkingLevel: rawThinking,
      };
    }),
  );

  // ── Dry-run mode ─────────────────────────────────────────────────────────────
  if (opts.dryRun) {
    const plan: DryRunDispatchPlan = {
      kitRef: opts.kitRef,
      intent: opts.intent,
      groups: dispatchGroups,
      totalSteps: kit.steps.length,
    };
    return {
      ok: true,
      planId: `dry-run:${opts.kitRef}:${opts.sessionKey}`,
      dryRunPlan: plan,
    };
  }

  // ── Live mode ─────────────────────────────────────────────────────────────────
  if (!opts.planStore) {
    return {
      ok: false,
      planId: "",
      errorMessage: "recipe-runner: planStore is required in live mode",
    };
  }

  const store = opts.planStore;

  // FORK 2026-05-31: recipe-state observability sink. Emits the live recipe
  // header (id + step M/N + parallelism + in-flight labels) so the RECIPES panel
  // shows the running playbook instead of the generic synthetic plan. The cap is
  // the widest parallel group. Best-effort: every emit is wrapped so observability
  // can never throw into the dispatch loop.
  const maxParallelism = Math.max(1, ...dispatchGroups.map((g) => g.length));
  const emitRecipeState = (update: Omit<Partial<RecipeStateUpdate>, "recipeId">): void => {
    if (!opts.onRecipeState) return;
    try {
      opts.onRecipeState({
        recipeId: opts.kitRef,
        totalSteps: kit.steps.length,
        parallelismCap: maxParallelism,
        sessionKey: opts.sessionKey,
        // BROCA visibility: turnId is the run's sessionKey — stable across every
        // event of one prompt. A per-call skillId in `update` overrides as needed.
        turnId: opts.sessionKey,
        ...update,
      });
    } catch {
      // observability must never break the run
    }
  };

  // FORK 2026-06 (Upgrade 1): recipe-attribution tag stamp. kitRef is already the
  // canonical `owner/slug`, so the tag is `recipe:<owner/slug>` — exactly what
  // recipe-fitness.attributeRecipe() matches on. Best-effort: a broken sink can
  // never throw into the dispatch loop (mirrors emitRecipeState).
  const recipeTag = `recipe:${opts.kitRef}`;
  const emitTag = (phase: "start" | "dispatch", stepIndex?: number): void => {
    if (!opts.onTag) return;
    try {
      opts.onTag({ tag: recipeTag, phase, stepIndex, sessionKey: opts.sessionKey });
    } catch {
      // attribution observability must never break the run
    }
  };

  // SS1: classified-trail emit (e.g. schema-mismatch re-dispatch). Best-effort
  // like the tag/state sinks above — a broken sink can never throw into the loop.
  const emitTrail = (ev: TrailEvent): void => {
    if (!opts.onTrail) return;
    try {
      opts.onTrail(ev);
    } catch {
      // trail observability must never break the run
    }
  };

  // ── Durable checkpointing (FORK 2026-05-30, Upgrade 5) ───────────────────────
  // Decide resume vs. fresh BEFORE seeding. Default policy (the architect 2026-05-30):
  // never silently re-attach — auto-resume requires resume:true AND a matching
  // in_progress plan with the SAME kitRef (a stale plan from an unrelated session
  // must not be hijacked). A partially-written plan that fails to parse is
  // quarantined by store.get() (returns null) → we fall back to a fresh run
  // (mitigates Risk 4 lossy recovery).
  let existing: Plan | null = null;
  try {
    existing = await store.get(opts.sessionKey);
  } catch {
    existing = null;
  }
  const resuming =
    opts.resume === true &&
    !!existing &&
    existing.status === "in_progress" &&
    existing.kitRef === opts.kitRef &&
    existing.steps.length === kit.steps.length;
  const startIndex = resuming ? existing!.currentStep : 0;
  // Carry forward the artifacts of every already-`done` step so later steps read
  // upstream output. Built once here; the per-step task wire reads from the live
  // plan each dispatch so it also picks up artifacts produced THIS run.
  const seedPriorArtifacts: PriorArtifact[] = resuming
    ? collectPriorArtifacts(existing!, startIndex)
    : [];

  // Seed the plan (fresh run) OR keep the existing one (resume) OR reuse the plan
  // the BROCA P1.1 durable-pause branch already seeded (interactiveSeedRunId set).
  let planId: string;
  if (resuming) {
    planId = existing!.runId;
  } else if (interactiveSeedRunId) {
    // The interactive ask-branch already seeded this plan and flipped it back to
    // in_progress; reuse it rather than re-seeding (which would wipe the status).
    planId = interactiveSeedRunId;
  } else {
    try {
      const result = await store.set({
        sessionKey: opts.sessionKey,
        intent: opts.intent,
        runId: `kit-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
        kitRef: opts.kitRef,
        steps: kit.steps.map((s) => ({ title: s.title })),
      });
      planId = result.runId;
    } catch (err) {
      return {
        ok: false,
        planId: "",
        errorMessage: `recipe-runner: failed to seed plan: ${String(err)}`,
      };
    }
  }
  void seedPriorArtifacts; // computed for parity / future logging; live read below

  // FORK 2026-05-31: announce the recipe to the panel as soon as the plan is
  // seeded (resume picks up at the checkpoint step; fresh runs at step 1).
  const startDispatch = dispatchGroups.flat().find((d) => d.stepIndex === startIndex);
  emitRecipeState({
    step: startIndex + 1,
    stepName: kit.steps[startIndex]?.title,
    skillId: startDispatch?.skillId,
  });

  // FORK 2026-06 (Upgrade 1): stamp the recipe-attribution tag ONCE at run start.
  emitTag("start");

  // Execute each group sequentially; within a group, fan out in parallel
  for (const groupDispatches of dispatchGroups) {
    // Resume: skip any group whose every step is already settled `done`.
    if (resuming && groupDispatches.every((d) => isStepDone(existing!, d.stepIndex))) {
      continue;
    }
    // Mark all steps in this group as in_progress (best-effort; plan-store
    // enforces at-most-one invariant by demoting previous, so we accept that)
    for (const dispatch of groupDispatches) {
      try {
        await store.step({
          sessionKey: opts.sessionKey,
          stepIndex: dispatch.stepIndex,
          status: "in_progress",
        });
      } catch {
        // non-fatal — plan board may show stale state briefly
      }
    }

    // FORK 2026-05-31: surface this parallel group's live step + in-flight labels
    // so the recipe header advances as the kit walks its groups.
    {
      const groupFirst = groupDispatches[0]?.stepIndex ?? 0;
      emitRecipeState({
        step: groupFirst + 1,
        stepName: groupDispatches.map((d) => d.title).join(" ∥ "),
        inFlightLabels: groupDispatches.map((d) => d.label),
        skillId: groupDispatches[0]?.skillId,
      });
    }

    // Settle each step in the group in parallel. A step either (a) delegates to
    // another kit (composition via `uses:` — recipes calling recipes), or
    // (b) spawns a single subagent and waits for its plan row to settle.
    const settlePromises = groupDispatches.map(async (dispatch) => {
      // Resume idempotency (Upgrade 5): a step already settled `done` is not
      // re-dispatched. Trust the durable row over re-running work.
      if (resuming && isStepDone(existing!, dispatch.stepIndex)) {
        return { stepIndex: dispatch.stepIndex, outcome: "done" as const };
      }

      // FORK 2026-06 (Upgrade 1): stamp the recipe-attribution tag on THIS task
      // dispatch (one per actually-dispatched step; skipped resume steps above do
      // not stamp, so the tag count tracks real dispatches).
      emitTag("dispatch", dispatch.stepIndex);

      // Persist a ≤500-char artifact digest for a successful step + advance the
      // carry-forward (Upgrade 5). The full note stays in step.note.
      const persistArtifact = async (note: string | null): Promise<void> => {
        const artifact = summarizeOutput(note);
        if (!artifact) return;
        try {
          await store.step({
            sessionKey: opts.sessionKey,
            stepIndex: dispatch.stepIndex,
            status: "done",
            note: note ?? undefined,
            artifact,
          });
        } catch {}
      };

      // SS1: persist a typed step's validated output as a structured artifact
      // (the full object) plus a prose digest for display. Direct store.step()
      // path (not the RPC) so the new fields aren't gated by the wire schema.
      const persistTypedArtifact = async (note: string | null, value: unknown): Promise<void> => {
        const artifact = summarizeOutput(note) || summarizeOutput(JSON.stringify(value));
        try {
          await store.step({
            sessionKey: opts.sessionKey,
            stepIndex: dispatch.stepIndex,
            status: "done",
            note: note ?? undefined,
            artifact,
            output: value,
            outputKind: "json",
          });
        } catch {}
      };

      // SS3: fire the skill-fitness loopback exactly once on a skill step's
      // terminal outcome. The resume-skip path returns its result directly (above)
      // WITHOUT calling this, so an already-`done` step is never re-recorded.
      const settleSkillOutcome = (success: boolean) => {
        if (dispatch.skillId) {
          try {
            opts.onSkillOutcome?.(dispatch.skillId, success);
          } catch {}
        }
      };

      const markError = async (note: string, err?: ClassifiedError) => {
        const classified = err ?? classifyError("execution-error", note, undefined, false);
        try {
          await store.step({
            sessionKey: opts.sessionKey,
            stepIndex: dispatch.stepIndex,
            status: "error",
            note,
            error: classified,
          });
        } catch {}
        settleSkillOutcome(false);
        return { stepIndex: dispatch.stepIndex, outcome: "error" as const };
      };

      const readNote = async (): Promise<string | null> => {
        try {
          const p = await store.get(opts.sessionKey);
          return p?.steps[dispatch.stepIndex]?.note ?? null;
        } catch {
          return null;
        }
      };

      // ONE execution of the step: run a sub-kit (composition via `uses:`) or
      // spawn a subagent and poll the plan row. Returns ok + the note the row
      // ended with, so the loop wrapper can decide whether to run again.
      const executeOnce = async (
        progressNote: string,
      ): Promise<{
        ok: boolean;
        note: string | null;
        subReturnValue?: unknown;
        error?: ClassifiedError;
      }> => {
        // SS3: an `invoke skill:` step fails CLOSED if the skill is absent or
        // deprecated (no silent fallthrough to a procedure-less spawn). The
        // procedure + output contract were already lifted into dispatch.task /
        // dispatch.outSchema at construction, so a resolved skill just falls
        // through to the normal spawn + SS1 typed-output path below.
        if (dispatch.skillId) {
          const skill = opts.skillLibrary?.read(dispatch.skillId);
          if (!skill || skill.deprecated) {
            return {
              ok: false,
              note: `invoke skill: ${dispatch.skillId} not found or deprecated`,
              error: classifyError(
                "skill-not-found",
                `invoke skill: ${dispatch.skillId} not found or deprecated`,
              ),
            };
          }
        }
        // SS2b: a `map:`/`filter:` step fans dispatch.usesKitRef out over an array
        // resolved from a prior step's typed output. This is SIBLING dispatch: the
        // worker runs once per element passing _depth UNCHANGED (the whole map step
        // costs +1 depth, applied by the parent's group dispatch — per-element runs
        // do NOT each increment depth). Width = deriveCombinatorFanOut(arrayLength)
        // (= arrayLength with no budget threaded — J16, never a frozen cap).
        if ((dispatch.mapOver || dispatch.filterOver) && dispatch.usesKitRef) {
          const iterRef = dispatch.mapOver ?? dispatch.filterOver!;
          const parsedRef = parseStepRef(iterRef);
          if (!parsedRef) {
            return {
              ok: false,
              note: `map/filter ref ${iterRef} is not a steps.<n>.out reference`,
              error: classifyError(
                "map-filter-resolution",
                `map/filter ref ${iterRef} is not a steps.<n>.out reference`,
              ),
            };
          }
          // Resolve the array + (dynamic) worker from prior outputs.
          const live = await store.get(opts.sessionKey);
          const outputsByStep = new Map<number, unknown>();
          if (live) {
            for (const p of collectPriorArtifacts(live, dispatch.stepIndex)) {
              if (p.output !== undefined) outputsByStep.set(p.stepIndex + 1, p.output);
            }
          }
          const arr = dotGet(outputsByStep.get(parsedRef.stepNumber), parsedRef.path);
          if (!Array.isArray(arr)) {
            return {
              ok: false,
              note: `map/filter: ${iterRef} did not resolve to an array`,
              error: classifyError(
                "map-filter-resolution",
                `map/filter: ${iterRef} did not resolve to an array`,
              ),
            };
          }
          let workerRef = dispatch.usesKitRef;
          if (isDynamicUsesRef(workerRef)) {
            const w = resolveKitRefTemplate(workerRef, outputsByStep);
            if (!w) {
              return {
                ok: false,
                note: `map/filter worker ${workerRef} did not resolve to a kitRef`,
                error: classifyError(
                  "map-filter-resolution",
                  `map/filter worker ${workerRef} did not resolve to a kitRef`,
                ),
              };
            }
            workerRef = w;
          }
          const chain = opts._usesChain ?? [opts.kitRef];
          const depth = opts._depth ?? 0;
          if (depth >= MAX_USES_DEPTH) {
            return {
              ok: false,
              note: `composition depth limit (${MAX_USES_DEPTH}) reached at ${workerRef}`,
              error: classifyError(
                "depth-limit",
                `composition depth limit (${MAX_USES_DEPTH}) reached at ${workerRef}`,
              ),
            };
          }
          const fanOut = deriveCombinatorFanOut({ arrayLength: arr.length });
          const collected: unknown[] = [];
          const droppedElements: number[] = [];
          for (let i = 0; i < fanOut; i++) {
            const item = arr[i];
            const itemText = typeof item === "string" ? item : JSON.stringify(item);
            // filter `keep:` predicate over {{item}}/{{index}} (text-substituted, then evaluateWhen).
            if (dispatch.filterOver && dispatch.keepWhen) {
              const expr = dispatch.keepWhen
                .replaceAll("{{item}}", JSON.stringify(itemText))
                .replaceAll("{{index}}", String(i));
              let keep: boolean;
              try {
                keep = evaluateWhen(expr, new Map());
              } catch {
                keep = false;
              }
              if (!keep) continue;
            }
            // SIBLING sub-run: _depth + 1 ONCE for the whole map step (depth+1 here is
            // the single increment; each element reuses the SAME depth, not depth+i).
            const sub = await runRecipe({
              kitRef: workerRef,
              sessionKey: `${opts.sessionKey}::${dispatch.mapOver ? "map" : "filter"}::${dispatch.stepIndex}::${i}`,
              intent: `↳ ${dispatch.title} [${i}]`,
              parameters: { ...(opts.parameters ?? {}), item: itemText, index: String(i) },
              planStore: store,
              ownRecipesDir,
              recipeInstallSandbox,
              _depth: depth + 1,
              _usesChain: [...chain, workerRef],
              _spawnStep: opts._spawnStep,
              onRecipeState: opts.onRecipeState,
            });
            if (!sub.ok) {
              if (dispatch.onError?.mode === "continue-partial") {
                droppedElements.push(i);
                continue; // drop this element, keep aggregating survivors
              }
              return {
                ok: false,
                note: `map/filter element ${i} (${workerRef}) failed: ${sub.errorMessage ?? "unknown"}`,
                error: classifyError(
                  "sub-kit-failure",
                  `map/filter element ${i} (${workerRef}) failed: ${sub.errorMessage ?? "unknown"}`,
                  { stepIndex: dispatch.stepIndex, element: i },
                ),
              };
            }
            if (dispatch.mapOver) {
              collected.push(sub.returnValue);
            } else {
              // predicate-kit filter: keep the ELEMENT when the worker returnValue is truthy.
              if (sub.returnValue) collected.push(item);
            }
          }
          if (droppedElements.length > 0) {
            // continue-partial: survivors aggregated, failures dropped → signal a
            // partial so the recovery driver settles this as done-partial.
            return {
              ok: false,
              note: `${dispatch.mapOver ? "mapped" : "filtered"} ${workerRef} over ${arr.length} → ${collected.length} (dropped ${droppedElements.length})`,
              subReturnValue: collected,
              error: classifyError(
                "sub-kit-failure",
                `dropped ${droppedElements.length} failed element(s): [${droppedElements.join(", ")}]`,
                { stepIndex: dispatch.stepIndex, droppedElements },
              ),
            };
          }
          return {
            ok: true,
            note: `${dispatch.mapOver ? "mapped" : "filtered"} ${workerRef} over ${arr.length} → ${collected.length}`,
            subReturnValue: collected,
          };
        }

        if (dispatch.usesKitRef) {
          // SS2b: a dynamic `uses: {{steps.N.out.path}}` template is resolved here,
          // BEFORE the depth/cycle guards, against prior steps' typed outputs. The
          // concrete owner/slug then feeds the existing _usesChain/_depth guards
          // unchanged. A resolve failure is a recorded step error (never silent).
          let resolvedKitRef = dispatch.usesKitRef;
          if (isDynamicUsesRef(dispatch.usesKitRef)) {
            const live = await store.get(opts.sessionKey);
            const outputsByStep = new Map<number, unknown>();
            if (live) {
              for (const p of collectPriorArtifacts(live, dispatch.stepIndex)) {
                if (p.output !== undefined) outputsByStep.set(p.stepIndex + 1, p.output);
              }
            }
            const r = resolveKitRefTemplate(dispatch.usesKitRef, outputsByStep);
            if (!r) {
              return {
                ok: false,
                note: `dynamic uses: ${dispatch.usesKitRef} did not resolve to a valid kitRef`,
                error: classifyError(
                  "map-filter-resolution",
                  `dynamic uses: ${dispatch.usesKitRef} did not resolve to a valid kitRef`,
                ),
              };
            }
            resolvedKitRef = r;
          }
          // Seed the chain with THIS kit's own ref so a self-`uses:` is caught at
          // depth 0 (review finding: an unseeded chain let a self-referencing
          // root kit re-execute once before the guard fired).
          const chain = opts._usesChain ?? [opts.kitRef];
          const depth = opts._depth ?? 0;
          if (depth >= MAX_USES_DEPTH) {
            return {
              ok: false,
              note: `composition depth limit (${MAX_USES_DEPTH}) reached at ${resolvedKitRef}`,
              error: classifyError(
                "depth-limit",
                `composition depth limit (${MAX_USES_DEPTH}) reached at ${resolvedKitRef}`,
              ),
            };
          }
          if (chain.includes(resolvedKitRef)) {
            return {
              ok: false,
              note: `composition cycle: ${resolvedKitRef} already on stack [${chain.join(" → ")}]`,
              error: classifyError(
                "sub-kit-failure",
                `composition cycle: ${resolvedKitRef} already on stack [${chain.join(" → ")}]`,
              ),
            };
          }
          try {
            await store.step({
              sessionKey: opts.sessionKey,
              stepIndex: dispatch.stepIndex,
              status: "in_progress",
              note: progressNote || `↳ running ${resolvedKitRef}`,
            });
          } catch {}
          const sub = await runRecipe({
            kitRef: resolvedKitRef,
            sessionKey: `${opts.sessionKey}::uses::${dispatch.stepIndex}`,
            intent: `↳ ${dispatch.title}`,
            parameters: opts.parameters,
            planStore: store,
            ownRecipesDir,
            recipeInstallSandbox,
            _depth: depth + 1,
            _usesChain: [...chain, resolvedKitRef],
            _spawnStep: opts._spawnStep,
            // FORK 2026-05-31: sub-kits surface their own recipe-state too (latest
            // emit wins in the panel, so the header tracks the active sub-recipe).
            onRecipeState: opts.onRecipeState,
          });
          if (!sub.ok) {
            return {
              ok: false,
              note: `sub-kit ${resolvedKitRef} failed: ${sub.errorMessage ?? "unknown"}`,
              error: classifyError(
                "sub-kit-failure",
                `sub-kit ${resolvedKitRef} failed: ${sub.errorMessage ?? "unknown"}`,
              ),
            };
          }
          // SS2b: carry the sub-kit's returnValue up so compose threads it and
          // map/filter aggregate it. The prose note stays the human-readable digest
          // (backward-compatible: plain uses: recipes with no out: behave as before).
          return {
            ok: true,
            note: `composed ${resolvedKitRef} (${sub.results?.length ?? 0} sub-steps)`,
            subReturnValue: sub.returnValue,
          };
        }

        // Normal: spawn one subagent and poll the plan row.
        if (progressNote) {
          try {
            await store.step({
              sessionKey: opts.sessionKey,
              stepIndex: dispatch.stepIndex,
              status: "in_progress",
              note: progressNote,
            });
          } catch {}
        }
        // Inject the artifacts of every prior `done` step into this step's task
        // so the subagent has upstream context (Upgrade 5 artifact→context wire).
        // Read the LIVE plan so artifacts produced earlier THIS run are included,
        // not just the resume snapshot.
        let taskWithContext = dispatch.task;
        try {
          const live = await store.get(opts.sessionKey);
          if (live) {
            const prior = collectPriorArtifacts(live, dispatch.stepIndex);
            // SS1: bind named typed fields — resolve {{steps.<n>.out.<path>}} from
            // prior steps' validated outputs (1-based step number = stepIndex + 1).
            const outputsByStep = new Map<number, unknown>();
            for (const p of prior) {
              if (p.output !== undefined) outputsByStep.set(p.stepIndex + 1, p.output);
            }
            taskWithContext = withPriorArtifacts(
              resolveStepRefs(dispatch.task, outputsByStep),
              prior,
            );
          }
        } catch {
          // fall back to the bare task on any read failure
        }
        // SS1: deliver the corrective re-dispatch prompt (progressNote) to the
        // subagent's TASK, not just the plan note — otherwise a schema re-dispatch
        // re-spawns blind and cannot actually correct its output. A loop label
        // rides along too (harmless context on which iteration this is).
        const taskForSpawn = progressNote
          ? `${taskWithContext}\n\n---\n${progressNote}`
          : taskWithContext;
        // SS5b: thread the step's per-spawn budget (allow-tools / max-tokens /
        // max-tool-calls) into the spawn. An absent directive leaves the field
        // undefined, so spawnStep appends no flag (unchanged behavior).
        const spawnOpts: SpawnOpts = {
          allowTools: dispatch.allowTools,
          maxTokens: dispatch.maxTokens,
          maxToolCalls: dispatch.maxToolCalls,
          model: dispatch.model,
          thinkingLevel: dispatch.thinkingLevel,
        };
        const spawnResult = await (opts._spawnStep ?? spawnStep)(
          taskForSpawn,
          dispatch.label,
          spawnOpts,
        );
        if (!spawnResult.ok) {
          return {
            ok: false,
            note: `spawn failed: ${spawnResult.error ?? "unknown"}`,
            error: classifyError(
              "spawn-failure",
              `spawn failed: ${spawnResult.error ?? "unknown"}`,
            ),
          };
        }
        const outcome = await waitForStepDone(
          store,
          opts.sessionKey,
          dispatch.stepIndex,
          600_000,
          opts.onCheckpoint,
        );
        if (outcome !== "done") {
          return {
            ok: false,
            note: outcome === "timeout" ? "step timed out after 10 minutes" : "step ended in error",
            error: classifyError(
              outcome === "timeout" ? "timeout" : "execution-error",
              outcome === "timeout" ? "step timed out after 10 minutes" : "step ended in error",
            ),
          };
        }
        return { ok: true, note: await readNote() };
      };

      // SS2a: a `when:` guard gates this step. Evaluate it against prior steps'
      // typed outputs (earlier-steps-only, from collectPriorArtifacts). A false
      // guard SKIPS the step as DONE — a guarded-off step is a successful no-op,
      // not a failure. A guard-eval error is a recorded step error (never silent).
      if (dispatch.whenGuard) {
        let pass: boolean;
        try {
          const live = await store.get(opts.sessionKey);
          const outputsByStep = new Map<number, unknown>();
          if (live) {
            for (const p of collectPriorArtifacts(live, dispatch.stepIndex)) {
              if (p.output !== undefined) outputsByStep.set(p.stepIndex + 1, p.output);
            }
          }
          pass = evaluateWhen(dispatch.whenGuard, outputsByStep);
        } catch (err) {
          return markError(
            `when: guard evaluation failed: ${String(err)}`,
            classifyError("guard-eval-error", `when: guard evaluation failed: ${String(err)}`),
          );
        }
        if (!pass) {
          await persistArtifact(`skipped (when: ${dispatch.whenGuard} = false)`);
          settleSkillOutcome(true);
          return { stepIndex: dispatch.stepIndex, outcome: "done" as const };
        }
      }

      // ── No loop: single execution ──
      if (!dispatch.loop) {
        let r = await executeOnce("");
        // SS5a: catchable recovery. A failed step with an `onError:` policy is not
        // an automatic abort — try retry / fallback / continue-partial first. retry
        // is honored ONLY when the error is recoverable (a hard limit skips it).
        if (!r.ok && dispatch.onError) {
          const policy = dispatch.onError;
          if (policy.mode === "retry" && r.error?.recoverable !== false) {
            // author N is a DOWNWARD cap; the real bound is the derived budget (J16).
            const live0 = await store.get(opts.sessionKey);
            const outputsByStep0 = new Map<number, unknown>();
            if (live0) {
              for (const p of collectPriorArtifacts(live0, dispatch.stepIndex)) {
                if (p.output !== undefined) outputsByStep0.set(p.stepIndex + 1, p.output);
              }
            }
            const resolvedN = resolveStepRefs(String(policy.retryCount), outputsByStep0).trim();
            const authorN = Number.parseInt(resolvedN, 10);
            const derived = deriveRecoveryRetryBudget({
              fitnessSuccessRate: opts.fitnessSuccessRate,
            });
            // a non-numeric / template-unresolved N fails CLOSED to the derived bound.
            const bound = Number.isFinite(authorN)
              ? Math.max(1, Math.min(authorN, derived))
              : derived;
            let attempt = 0;
            while (!r.ok && r.error?.recoverable !== false && attempt < bound) {
              attempt++;
              emitTrail({
                kind: "recovery-retry",
                label: `${opts.kitRef}:step-${dispatch.stepIndex}`,
                message: `step ${dispatch.stepIndex + 1} recovery retry ${attempt}/${bound}: ${r.error?.message ?? r.note ?? "failed"}`,
                sessionKey: opts.sessionKey,
                payload: { stepIndex: dispatch.stepIndex, attempt, bound },
              });
              r = await executeOnce(
                `Previous attempt failed: ${r.error?.message ?? r.note ?? "unknown"}. ` +
                  "Recover and complete the step.",
              );
            }
            if (!r.ok) {
              return markError(
                `recovery exhausted after ${attempt} retr${attempt === 1 ? "y" : "ies"}: ${r.error?.message ?? r.note ?? "failed"}`,
                classifyError(
                  "recovery-exhausted",
                  r.error?.message ?? r.note ?? "recovery exhausted",
                  { stepIndex: dispatch.stepIndex, attempts: attempt },
                ),
              );
            }
          } else if (policy.mode === "fallback") {
            // resolve the fallback kitRef (static or {{…}}), then dispatch it via the
            // SS2b uses: kit-factory edge (its own sub-session, _depth+1, _usesChain
            // pushed so a fallback cycle is caught by the same guard).
            let fbRef = policy.kitRef;
            if (isDynamicUsesRef(fbRef)) {
              const liveF = await store.get(opts.sessionKey);
              const outF = new Map<number, unknown>();
              if (liveF) {
                for (const p of collectPriorArtifacts(liveF, dispatch.stepIndex)) {
                  if (p.output !== undefined) outF.set(p.stepIndex + 1, p.output);
                }
              }
              const resolved = resolveKitRefTemplate(fbRef, outF);
              if (!resolved) {
                return markError(
                  `onError: fallback ${fbRef} did not resolve to a valid kitRef`,
                  classifyError("fallback-failed", `fallback ${fbRef} did not resolve`),
                );
              }
              fbRef = resolved;
            } else {
              const norm = parseKitRefValue(fbRef);
              if (!norm) {
                return markError(
                  `onError: fallback ${fbRef} is not a valid kitRef`,
                  classifyError("fallback-failed", `fallback ${fbRef} is not a valid kitRef`),
                );
              }
              fbRef = norm;
            }
            const chain = opts._usesChain ?? [opts.kitRef];
            const depth = opts._depth ?? 0;
            if (depth >= MAX_USES_DEPTH) {
              return markError(
                `onError: fallback depth limit (${MAX_USES_DEPTH}) reached at ${fbRef}`,
                classifyError("depth-limit", `fallback depth limit reached at ${fbRef}`),
              );
            }
            emitTrail({
              kind: "recovery-fallback",
              label: `${opts.kitRef}:step-${dispatch.stepIndex}`,
              message: `step ${dispatch.stepIndex + 1} falling back to ${fbRef}: ${r.error?.message ?? r.note ?? "failed"}`,
              sessionKey: opts.sessionKey,
              payload: { stepIndex: dispatch.stepIndex, fallbackKit: fbRef },
            });
            const fb = await runRecipe({
              kitRef: fbRef,
              sessionKey: `${opts.sessionKey}::fallback::${dispatch.stepIndex}`,
              intent: `↳ fallback ${dispatch.title}`,
              parameters: opts.parameters,
              planStore: store,
              ownRecipesDir,
              recipeInstallSandbox,
              _depth: depth + 1,
              _usesChain: [...chain, fbRef],
              _spawnStep: opts._spawnStep,
              onRecipeState: opts.onRecipeState,
            });
            if (!fb.ok) {
              return markError(
                `onError: fallback ${fbRef} failed: ${fb.errorMessage ?? "unknown"}`,
                classifyError(
                  "fallback-failed",
                  `fallback ${fbRef} failed: ${fb.errorMessage ?? "unknown"}`,
                ),
              );
            }
            // fallback succeeded → the step settles done carrying the fallback's value.
            r = {
              ok: true,
              note: `recovered via fallback ${fbRef} (${fb.results?.length ?? 0} sub-steps)`,
              subReturnValue: fb.returnValue,
            };
          } else if (policy.mode === "continue-partial") {
            // persist the partial note/artifact + the error envelope, then settle as
            // a NON-aborting done-partial. In a map/filter step r.subReturnValue is
            // the survivor array (a failed element was already dropped upstream).
            const partialErr =
              r.error ??
              classifyError("execution-error", r.note ?? "partial completion", undefined, false);
            try {
              await store.step({
                sessionKey: opts.sessionKey,
                stepIndex: dispatch.stepIndex,
                status: "done",
                note: r.note ?? "partial completion",
                artifact: summarizeOutput(r.note),
                ...(r.subReturnValue !== undefined
                  ? { output: r.subReturnValue, outputKind: "json" as const }
                  : {}),
                error: partialErr,
              });
            } catch {}
            settleSkillOutcome(false);
            return {
              stepIndex: dispatch.stepIndex,
              outcome: "done-partial" as const,
              partialError: partialErr,
            };
          }
        }
        if (!r.ok) return markError(r.note ?? "step failed", r.error);

        // SS1: when the step is typed, validate its output and re-dispatch a
        // budget-derived number of times on mismatch. No frozen retry constant —
        // the bound comes from deriveRedispatchBudget (J16). Exhaustion → a
        // recorded step error, never a silent pass.
        if (dispatch.outSchema) {
          const validate = stepAjv.compile(dispatch.outSchema);
          const requiredFieldCount = Array.isArray(
            (dispatch.outSchema as { required?: unknown }).required,
          )
            ? (dispatch.outSchema as { required: unknown[] }).required.length
            : 0;
          const maxRedispatch = deriveRedispatchBudget({
            requiredFieldCount,
            fitnessSuccessRate: opts.fitnessSuccessRate,
          });
          let attempt = 0;
          // SS2b: a dynamic/static `uses:` step adopts the sub-kit's returnValue as
          // its own typed output — validate the sub value directly (no subagent ran
          // for this step, so there is no note to re-dispatch against).
          let validation =
            r.subReturnValue !== undefined
              ? validateTypedNote(
                  "```json\n" + JSON.stringify(r.subReturnValue) + "\n```",
                  validate,
                )
              : validateTypedNote(r.note, validate);
          while (!validation.ok && r.subReturnValue === undefined && attempt < maxRedispatch) {
            attempt++;
            emitTrail({
              kind: "schema-mismatch",
              label: `${opts.kitRef}:step-${dispatch.stepIndex}`,
              message: `step ${dispatch.stepIndex + 1} output failed schema (attempt ${attempt}/${maxRedispatch}): ${validation.errorText ?? "invalid"}`,
              sessionKey: opts.sessionKey,
              payload: { stepIndex: dispatch.stepIndex, attempt, maxRedispatch },
            });
            r = await executeOnce(
              `Your previous output did not satisfy the required schema: ${validation.errorText}. ` +
                "Re-emit ONLY a corrected ```json block.",
            );
            if (!r.ok) return markError(r.note ?? "step failed during schema re-dispatch");
            validation = validateTypedNote(r.note, validate);
          }
          if (!validation.ok) {
            return markError(
              `typed step output never satisfied its schema after ${maxRedispatch} re-dispatch(es): ${validation.errorText}`,
            );
          }
          await persistTypedArtifact(r.note, validation.value);
          settleSkillOutcome(true);
          if (dispatch.earlyExit) {
            return {
              stepIndex: dispatch.stepIndex,
              outcome: "early-exit" as const,
              returnValue: validation.value,
            };
          }
          return { stepIndex: dispatch.stepIndex, outcome: "done" as const };
        }

        // Persist the artifact digest (Upgrade 5). For the spawn path the
        // subagent already wrote done+note; we re-stamp `done` with the digest
        // (idempotent, keeps the row done). For the sub-kit (uses:) path the
        // sub-plan's terminal result becomes the PARENT step's artifact.
        await persistArtifact(r.note);
        settleSkillOutcome(true);
        if (dispatch.earlyExit) {
          return {
            stepIndex: dispatch.stepIndex,
            outcome: "early-exit" as const,
            returnValue: r.note,
          };
        }
        return { stepIndex: dispatch.stepIndex, outcome: "done" as const };
      }

      // ── Loop: repeat until the condition or the hard cap (recipe loops) ──
      const loop = dispatch.loop;
      // SS5b: the OVERSEER supervision loop (`loop: until OVERSEER_DONE`) does NOT
      // run a frozen loop.max — its per-iteration ceiling is DERIVED from the live
      // situation (J16 design-principle #19: a frozen number is at most a safety
      // CEILING, never the working value). EVERY OTHER loop keeps its author-set
      // loop.max unchanged. loop.max stays the structural downward cap (already
      // clamped to HARD_LOOP_MAX=25 by parseLoopDirective), so the derived working
      // bound min(loop.max, derived) is always in [1, HARD_LOOP_MAX].
      const isOverseerLoop =
        loop.mode === "until-marker" && (loop.marker ?? "").toUpperCase() === "OVERSEER_DONE";
      let iter = 0;
      let lastNote: string | null = null;
      let priorNoteLen: number | null = null;
      // Working ceiling for the current pass: non-overseer loops always use
      // loop.max; the overseer loop re-derives this each pass from live signals.
      let workingBound = loop.max;
      while (iter < workingBound) {
        const r = await executeOnce(`loop ${iter + 1}/${workingBound} · ${loop.mode}`);
        iter++;
        if (!r.ok) return markError(`loop aborted at iter ${iter}: ${r.note ?? "failed"}`);
        lastNote = r.note;
        if (loop.mode === "until-dry" && isDryNote(r.note)) break;
        const hitMarker =
          loop.mode === "until-marker" &&
          !!r.note &&
          !!loop.marker &&
          r.note.toLowerCase().includes(loop.marker.toLowerCase());
        if (hitMarker) break;
        if (isOverseerLoop) {
          // A non-done verdict is a NUDGE: keep going. Surface the nudge text via
          // the best-effort onKeepGoing sink (fire-and-forget — a broken sink must
          // never throw into the run; mirrors emitTrail/emitTag).
          try {
            opts.onKeepGoing?.(opts.sessionKey, r.note ?? "");
          } catch {
            // keep-going observability must never break the run
          }
          // gap trend (a simple converging heuristic): the latest verdict/note is
          // shorter than the prior one → the gap-to-done is shrinking, earn one
          // more supervision pass.
          const curLen = (r.note ?? "").length;
          const gapShrinking = priorNoteLen !== null && curLen < priorNoteLen;
          priorNoteLen = curLen;
          // Re-derive the working ceiling for the NEXT pass. min(loop.max, derived)
          // keeps the author's downward cap; the derived value is the
          // situation-responsive WORKING bound (>=1, never > loop.max <= 25).
          workingBound = Math.min(
            loop.max,
            deriveOverseerLoopBudget({
              priorIterations: iter,
              fitnessSuccessRate: opts.fitnessSuccessRate,
              gapShrinking,
            }),
          );
          // Pressure signal: emit as iter approaches the ceiling so the caller can
          // see the overseer is about to fall through to a GRACEFUL partial
          // settlement (design-principle #19 graceful-degrade — never a hard abort).
          emitTrail({
            kind: "overseer-pressure",
            label: `${opts.kitRef}:step-${dispatch.stepIndex}`,
            message:
              iter >= workingBound
                ? `overseer loop at ${iter}/${workingBound} — at the derived ceiling; will settle a partial if the next verdict is still a nudge`
                : `overseer loop at ${iter}/${workingBound} — supervising`,
            sessionKey: opts.sessionKey,
            payload: { stepIndex: dispatch.stepIndex, iter, workingBound, loopMax: loop.max },
          });
        }
        // count mode: keep going until loop.max iterations.
      }
      const loopNote = `looped ${iter}× (${loop.mode}); last: ${(lastNote ?? "").slice(0, 80)}`;
      await persistArtifact(loopNote);
      settleSkillOutcome(true);
      if (dispatch.earlyExit) {
        return {
          stepIndex: dispatch.stepIndex,
          outcome: "early-exit" as const,
          returnValue: lastNote,
        };
      }
      return { stepIndex: dispatch.stepIndex, outcome: "done" as const };
    });

    const settlements = await Promise.all(settlePromises);

    // SS5a: collect done-partial settlements — a survivable failure caught by
    // `onError: continue-partial`. These do NOT abort: emit a partial-completion
    // trail event for each and CONTINUE to the next group (the step is already
    // persisted as a `done` row carrying its PlanStep.error).
    for (const s of settlements) {
      if (s.outcome === "done-partial") {
        emitTrail({
          kind: "partial-completion",
          label: `${opts.kitRef}:step-${s.stepIndex}`,
          message: `step ${s.stepIndex + 1} completed partially (caught by onError: continue-partial)`,
          sessionKey: opts.sessionKey,
          payload: {
            stepIndex: s.stepIndex,
            error: (s as { partialError?: ClassifiedError }).partialError,
          },
        });
      }
    }

    // SS2a: a `return:`/`done:` early-exit closes the plan as DONE, carrying the
    // exiting step's value — it is NOT a failure. Check before the error path.
    const exit = settlements.find((s) => s.outcome === "early-exit");
    if (exit) {
      let exitResults: StepResult[] = [];
      const exitPlan = await store.get(opts.sessionKey);
      if (exitPlan) {
        exitResults = collectStepResults(exitPlan);
      }
      try {
        await store.close({ sessionKey: opts.sessionKey, status: "done" });
      } catch {}
      return {
        ok: true,
        planId,
        results: exitResults,
        returnValue: (exit as { returnValue?: unknown }).returnValue,
      };
    }

    // If any step in this group errored, abort the whole plan
    const failed = settlements.find((s) => s.outcome === "error");
    if (failed) {
      let partialResults: StepResult[] = [];
      const abortPlan = await store.get(opts.sessionKey);
      if (abortPlan) {
        partialResults = collectStepResults(abortPlan);
      }
      try {
        await store.close({ sessionKey: opts.sessionKey, status: "aborted" });
      } catch {}
      return {
        ok: false,
        planId,
        errorMessage: `recipe-runner: group failed at step ${failed.stepIndex}; plan aborted`,
        results: partialResults,
      };
    }
  }

  // All groups complete — close the plan as done. Harvest results BEFORE close()
  // archives + unlinks the live file (close() removes it from the store).
  let results: StepResult[] = [];
  const finalPlan = await store.get(opts.sessionKey);
  if (finalPlan) {
    results = collectStepResults(finalPlan);
  }
  try {
    await store.close({ sessionKey: opts.sessionKey, status: "done" });
  } catch {}

  return { ok: true, planId, results };
}
