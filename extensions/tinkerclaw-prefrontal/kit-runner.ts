/**
 * FORK: prefrontal/kit-runner — Consumes parallelism.groups from kit frontmatter
 * and dispatches each group's steps as parallel subagents via
 * scripts/openclaw-spawn-subagent.mjs. Plan-row status is the per-step write
 * barrier: in_progress → done (or error on failure).
 *
 * Wired in by: kit-rpcs.ts (prefrontal.kit.run RPC) which delegates here.
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
import { parse as parseYaml } from "yaml";
import type { Plan } from "../../src/gateway/protocol/schema/prefrontal-plan.js";
import type { PlanStore } from "./plan-store.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KitRunOptions {
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
  ownKitsDir?: string;
  /** path to the install sandbox (for downloaded kits) */
  kitInstallSandbox?: string;
  /** FORK 2026-05-29 composition: recursion depth (sub-kits invoked via `uses:`). */
  _depth?: number;
  /** FORK 2026-05-29 composition: kitRefs already on the call stack (cycle guard). */
  _usesChain?: string[];
  /**
   * FORK 2026-05-30 durable checkpointing (Upgrade 5).
   * When true, an existing in_progress plan for this sessionKey with the SAME
   * kitRef is resumed: dispatch starts at plan.currentStep, already-`done` rows
   * are skipped, and prior steps' artifacts are injected into later steps' tasks.
   * Default policy (Oscar, 2026-05-30): NO silent re-attach — auto-resume fires
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
  _spawnStep?: (task: string, label: string) => Promise<SpawnResult>;
  /**
   * FORK 2026-05-31: recipe-state observability sink. runKit calls this at kit
   * start, on each parallel-group transition, and on completion so the Tinker
   * RECIPES panel can render the live recipe header (id + step M/N +
   * parallelism). The caller wires it to fork.prefrontal.setRecipe, which
   * broadcasts the prefrontal-recipe-state lifecycle event. Best-effort and
   * fire-and-forget: kit-runner wraps every call so observability NEVER throws
   * into the execution loop. Until this was wired the header had no data source
   * and the panel always fell back to the synthetic "Thinking → Acting" plan.
   */
  onRecipeState?: (state: RecipeStateUpdate) => void;
}

/**
 * FORK 2026-05-31: a single recipe-state observability update emitted by runKit.
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
}

/**
 * FORK 2026-05-30 (Upgrade 5): collect the durable artifacts of every `done`
 * step BEFORE stepIndex, so a resuming / downstream step can read upstream output.
 */
export function collectPriorArtifacts(plan: Plan, beforeStep: number): PriorArtifact[] {
  const out: PriorArtifact[] = [];
  plan.steps.forEach((s, i) => {
    if (i >= beforeStep) return;
    if (s.status !== "done") return;
    const artifact = s.artifact ?? summarizeOutput(s.note ?? "");
    if (artifact) out.push({ stepIndex: i, title: s.title, artifact });
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

/** Max depth for `uses:` sub-kit recursion — recipes calling recipes. */
const MAX_USES_DEPTH = 3;

export interface KitRunResult {
  ok: boolean;
  planId: string;
  dryRunPlan?: DryRunDispatchPlan;
  errorMessage?: string;
  /** Per-step results harvested from the plan after the run settles. */
  results?: StepResult[];
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
  /** FORK: if set, this step runs another kit (owner/slug) instead of a plain subagent. */
  usesKitRef?: string;
  /** FORK 2026-05-30: if set, this step repeats (count / until-dry / until-marker). */
  loop?: LoopSpec;
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
    if (!/^(?:uses|loop):/i.test(line)) break; // first prose line ends the block
    out.push(line);
    if (out.length >= 3) break;
  }
  return out;
}

/** The composition seam: a leading `uses: <kit>` directive runs another kit
 * instead of a plain subagent. Bare slugs normalize to `globalcaos/<slug>`. */
export function parseUsesDirective(body: string): string | undefined {
  for (const line of leadingDirectives(body)) {
    const m = /^uses:\s*([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)\s*$/i.exec(line);
    if (!m) continue;
    const ref = m[1];
    return ref.includes("/") ? ref : `globalcaos/${ref}`;
  }
  return undefined;
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

interface KitParallelism {
  groups: number[][];
}

interface ParsedKit {
  steps: ParsedKitStep[];
  parallelism: KitParallelism | null;
}

export function parseKitStepsAndParallelism(text: string): ParsedKit {
  // Strip frontmatter, collect parallelism block and step sections.
  const fmMatch = /^---\n([\s\S]+?)\n---\n/.exec(text);
  let parallelism: KitParallelism | null = null;
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
function resolveGroups(kit: ParsedKit): number[][] {
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

// ─── Parameter substitution ───────────────────────────────────────────────────

function substituteParameters(text: string, params: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(params)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
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
 * Invoke openclaw-spawn-subagent.mjs for a single step. Returns a promise that
 * resolves when the subagent has been spawned (not when it completes — the
 * kit-runner polls plan-row status for completion).
 *
 * Timeout: 120s per spawn call (time for the subagent to be accepted by the
 * gateway; actual execution continues independently).
 */
function spawnStep(task: string, label: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const helperPath = resolveSpawnHelperPath();
    const child = spawn(
      process.execPath,
      [helperPath, "--task", task, "--label", label, "--json"],
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

// ─── Kit file resolution ──────────────────────────────────────────────────────

async function loadKitText(
  kitRef: string,
  ownKitsDir: string,
  kitInstallSandbox: string,
): Promise<string> {
  const [owner, slug] = kitRef.split("/");
  const candidates = [
    join(ownKitsDir, slug, "kit.md"),
    join(kitInstallSandbox, owner, slug, "kit.md"),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf-8");
    } catch {
      // try next
    }
  }
  throw new Error(`kit-runner: kit ${kitRef} not found in ${candidates.join(" or ")}`);
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

// ─── Kits-dir resolution ────────────────────────────────────────────────────
//
// The own-kits dir is `<repo-root>/extensions/tinkerclaw-prefrontal/kits`. The
// caller lives at a DIFFERENT depth depending on layout: source is at
// extensions/tinkerclaw-prefrontal/ (3 levels deep) while the bundle is at
// dist/ root (1 level deep). A fixed `..` count is correct for only one of them.
// Walk UP from startDir and return the FIRST ancestor whose
// `extensions/tinkerclaw-prefrontal/kits` exists on disk — both layouts share
// the same repo root, so this resolves correctly regardless of bundle depth.
// Falls back to the legacy 3-up resolve so behavior never gets worse.
export function resolveOwnKitsDir(startDir: string): string {
  const MAX_LEVELS = 8;
  let dir = startDir;
  for (let i = 0; i < MAX_LEVELS; i++) {
    const candidate = join(dir, "extensions", "tinkerclaw-prefrontal", "kits");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break; // reached filesystem root
    }
    dir = parent;
  }
  return resolve(startDir, "..", "..", "..", "extensions", "tinkerclaw-prefrontal", "kits");
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runKit(opts: KitRunOptions): Promise<KitRunResult> {
  // Resolve directories
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const ownKitsDir = opts.ownKitsDir ?? resolveOwnKitsDir(thisDir);
  const kitInstallSandbox =
    opts.kitInstallSandbox ?? join(process.env.HOME ?? "/tmp", ".openclaw", "workspace", "kits");

  // Load the kit
  let kitText: string;
  try {
    kitText = await loadKitText(opts.kitRef, ownKitsDir, kitInstallSandbox);
  } catch (err) {
    return { ok: false, planId: "", errorMessage: String(err) };
  }

  const kit = parseKitStepsAndParallelism(kitText);
  if (kit.steps.length === 0) {
    return {
      ok: false,
      planId: "",
      errorMessage: `kit-runner: kit ${opts.kitRef} has no parsable steps`,
    };
  }

  const groups = resolveGroups(kit);

  // Build dispatch plan (used for both dryRun output and live dispatch)
  const params = opts.parameters ?? {};
  const dispatchGroups: StepDispatch[][] = groups.map((groupIndices) =>
    groupIndices.map((idx) => {
      const step = kit.steps[idx];
      if (!step) {
        throw new Error(
          `kit-runner: parallelism.groups references invalid step index ${idx} (kit has ${kit.steps.length} steps)`,
        );
      }
      const rawTask = `Kit: ${opts.kitRef}\nStep ${idx + 1}/${kit.steps.length}: ${step.title}\n\n${step.body}`;
      const task = substituteParameters(rawTask, params);
      const label = `${opts.kitRef}:step-${idx}`;
      const usesKitRef = parseUsesDirective(step.body);
      const loop = parseLoopDirective(step.body);
      return { stepIndex: idx, title: step.title, task, label, usesKitRef, loop };
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
      errorMessage: "kit-runner: planStore is required in live mode",
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
        ...update,
      });
    } catch {
      // observability must never break the run
    }
  };

  // ── Durable checkpointing (FORK 2026-05-30, Upgrade 5) ───────────────────────
  // Decide resume vs. fresh BEFORE seeding. Default policy (Oscar 2026-05-30):
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

  // Seed the plan (fresh run) OR keep the existing one (resume).
  let planId: string;
  if (resuming) {
    planId = existing!.runId;
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
        errorMessage: `kit-runner: failed to seed plan: ${String(err)}`,
      };
    }
  }
  void seedPriorArtifacts; // computed for parity / future logging; live read below

  // FORK 2026-05-31: announce the recipe to the panel as soon as the plan is
  // seeded (resume picks up at the checkpoint step; fresh runs at step 1).
  emitRecipeState({
    step: startIndex + 1,
    stepName: kit.steps[startIndex]?.title,
  });

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

      const markError = async (note: string) => {
        try {
          await store.step({
            sessionKey: opts.sessionKey,
            stepIndex: dispatch.stepIndex,
            status: "error",
            note,
          });
        } catch {}
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
      ): Promise<{ ok: boolean; note: string | null }> => {
        if (dispatch.usesKitRef) {
          // Seed the chain with THIS kit's own ref so a self-`uses:` is caught at
          // depth 0 (review finding: an unseeded chain let a self-referencing
          // root kit re-execute once before the guard fired).
          const chain = opts._usesChain ?? [opts.kitRef];
          const depth = opts._depth ?? 0;
          if (depth >= MAX_USES_DEPTH) {
            return {
              ok: false,
              note: `composition depth limit (${MAX_USES_DEPTH}) reached at ${dispatch.usesKitRef}`,
            };
          }
          if (chain.includes(dispatch.usesKitRef)) {
            return {
              ok: false,
              note: `composition cycle: ${dispatch.usesKitRef} already on stack [${chain.join(" → ")}]`,
            };
          }
          try {
            await store.step({
              sessionKey: opts.sessionKey,
              stepIndex: dispatch.stepIndex,
              status: "in_progress",
              note: progressNote || `↳ running ${dispatch.usesKitRef}`,
            });
          } catch {}
          const sub = await runKit({
            kitRef: dispatch.usesKitRef,
            sessionKey: `${opts.sessionKey}::uses::${dispatch.stepIndex}`,
            intent: `↳ ${dispatch.title}`,
            parameters: opts.parameters,
            planStore: store,
            ownKitsDir,
            kitInstallSandbox,
            _depth: depth + 1,
            _usesChain: [...chain, dispatch.usesKitRef],
            // FORK 2026-05-31: sub-kits surface their own recipe-state too (latest
            // emit wins in the panel, so the header tracks the active sub-recipe).
            onRecipeState: opts.onRecipeState,
          });
          if (!sub.ok) {
            return {
              ok: false,
              note: `sub-kit ${dispatch.usesKitRef} failed: ${sub.errorMessage ?? "unknown"}`,
            };
          }
          return {
            ok: true,
            note: `composed ${dispatch.usesKitRef} (${sub.results?.length ?? 0} sub-steps)`,
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
            taskWithContext = withPriorArtifacts(
              dispatch.task,
              collectPriorArtifacts(live, dispatch.stepIndex),
            );
          }
        } catch {
          // fall back to the bare task on any read failure
        }
        const spawnResult = await (opts._spawnStep ?? spawnStep)(taskWithContext, dispatch.label);
        if (!spawnResult.ok) {
          return { ok: false, note: `spawn failed: ${spawnResult.error ?? "unknown"}` };
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
          };
        }
        return { ok: true, note: await readNote() };
      };

      // ── No loop: single execution ──
      if (!dispatch.loop) {
        const r = await executeOnce("");
        if (!r.ok) return markError(r.note ?? "step failed");
        // Persist the artifact digest (Upgrade 5). For the spawn path the
        // subagent already wrote done+note; we re-stamp `done` with the digest
        // (idempotent, keeps the row done). For the sub-kit (uses:) path the
        // sub-plan's terminal result becomes the PARENT step's artifact.
        await persistArtifact(r.note);
        return { stepIndex: dispatch.stepIndex, outcome: "done" as const };
      }

      // ── Loop: repeat until the condition or the hard cap (recipe loops) ──
      const loop = dispatch.loop;
      let iter = 0;
      let lastNote: string | null = null;
      while (iter < loop.max) {
        const r = await executeOnce(`loop ${iter + 1}/${loop.max} · ${loop.mode}`);
        iter++;
        if (!r.ok) return markError(`loop aborted at iter ${iter}: ${r.note ?? "failed"}`);
        lastNote = r.note;
        if (loop.mode === "until-dry" && isDryNote(r.note)) break;
        if (
          loop.mode === "until-marker" &&
          r.note &&
          loop.marker &&
          r.note.toLowerCase().includes(loop.marker.toLowerCase())
        ) {
          break;
        }
        // count mode: keep going until loop.max iterations.
      }
      const loopNote = `looped ${iter}× (${loop.mode}); last: ${(lastNote ?? "").slice(0, 80)}`;
      await persistArtifact(loopNote);
      return { stepIndex: dispatch.stepIndex, outcome: "done" as const };
    });

    const settlements = await Promise.all(settlePromises);

    // If any step in this group errored, abort the whole plan
    const failed = settlements.find((s) => s.outcome !== "done");
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
        errorMessage: `kit-runner: group failed at step ${failed.stepIndex}; plan aborted`,
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
