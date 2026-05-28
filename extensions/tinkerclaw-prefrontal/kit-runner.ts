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
}

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
 * Poll the plan store until the given step reaches a terminal status
 * (done | error). Times out after maxWaitMs.
 */
async function waitForStepDone(
  store: PlanStore,
  sessionKey: string,
  stepIndex: number,
  maxWaitMs = 600_000,
): Promise<"done" | "error" | "timeout"> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(3_000);
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
      return { stepIndex: idx, title: step.title, task, label };
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

  // Seed the plan
  let planId: string;
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

  // Execute each group sequentially; within a group, fan out in parallel
  for (const groupDispatches of dispatchGroups) {
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

    // Spawn all steps in the group in parallel
    const spawnPromises = groupDispatches.map(async (dispatch) => {
      const spawnResult = await spawnStep(dispatch.task, dispatch.label);
      return { dispatch, spawnResult };
    });
    const spawnResults = await Promise.all(spawnPromises);

    // For each spawned step, poll until the subagent marks it done in the plan,
    // OR mark it done/error based on the spawn result itself.
    const settlePromises = spawnResults.map(async ({ dispatch, spawnResult }) => {
      if (!spawnResult.ok) {
        // Spawn failed immediately — mark error and record reason
        try {
          await store.step({
            sessionKey: opts.sessionKey,
            stepIndex: dispatch.stepIndex,
            status: "error",
            note: `spawn failed: ${spawnResult.error ?? "unknown"}`,
          });
        } catch {}
        return { stepIndex: dispatch.stepIndex, outcome: "error" as const };
      }

      // Spawn succeeded; wait for the subagent to mark the plan step done.
      // The subagent is responsible for calling prefrontal.plan.step when it
      // completes. We poll for up to 10 minutes.
      const outcome = await waitForStepDone(store, opts.sessionKey, dispatch.stepIndex, 600_000);

      if (outcome !== "done") {
        // Timed out or errored — mark the step with the outcome
        try {
          await store.step({
            sessionKey: opts.sessionKey,
            stepIndex: dispatch.stepIndex,
            status: "error",
            note: outcome === "timeout" ? "step timed out after 10 minutes" : "step ended in error",
          });
        } catch {}
        return { stepIndex: dispatch.stepIndex, outcome: "error" as const };
      }

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
