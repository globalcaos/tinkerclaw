/**
 * 2c LoRA training is EXTERNAL/OUT-OF-SCOPE — real GPU/Python trainer + MMLU/HumanEval
 * benchmarks are a separate tracked deliverable. This shell only signals intent.
 *
 * FORK 2026-06-01 — Nightly-consolidation SUPERVISOR shell (J8 §2c, "sleep phase").
 *
 * The paper's headline thesis (CCA §3): cross from prompt-level self-improvement into
 * WEIGHT-level adaptation via a nightly QLoRA pass over the day's *externally-validated*
 * episodic buffer, gated by a capability-regression test. That training step CANNOT run
 * in this TypeScript gateway — it needs a GPU, a Python ML stack (transformers +
 * bitsandbytes QLoRA), a replay buffer, and an adapter merge/stack lifecycle. All of
 * that is a SEPARATE, tracked deliverable.
 *
 * What lives here is ONLY the deterministic supervisor: gather the day's validated gaps,
 * (a) signal intent that training is needed (fire-and-forget), and (b) drive the
 * spawn → gate → merge-or-reject decision against an INJECTED black-box trainer + the
 * codeable-now `runCapabilityMatrix` gate. The trainer is a JSON-contract subprocess;
 * this module never imports torch, never spawns a GPU job itself in this build, and never
 * trains in-process.
 *
 * Safety invariants carried from the plan:
 *  - §9.3 No self-output-as-truth: only EXTERNALLY-validated gaps (resolutionSource set,
 *    resolutionType !== "external-outage") are eligible to enter a training buffer.
 *  - Cost guard (recon risk #6): skip nights with zero high-priority validated gaps.
 *  - Capability gate is MANDATORY: a regression > 2% or an alignment failure ⇒ keep the
 *    old adapter (rollback by inaction — we simply never update the pointer).
 *  - Atomic pointer update is owned by ENGRAM/J1 (memory-layout.md:135) → delegated to an
 *    injected `updateConsolidationPointer`; this shell does NOT clobber that schema.
 *  - Defensive: the supervisor never throws to its caller; any failure ⇒ "rejected".
 */

import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type CapabilityReport } from "../validation/capability-matrix.js";
import { type Gap } from "./curiosity-store.js";

const log = createSubsystemLogger("fork-consolidation-shell");

/** Default runId for events emitted by the (sessionless) consolidation cron. */
const DEFAULT_RUN_ID = "consolidation";

// --------------------------------------------------------------------------
// Eligibility (pure) — §9.3 external-validation guard + high-priority filter
// --------------------------------------------------------------------------

/**
 * Is this gap eligible to enter a training buffer? It must be EXTERNALLY validated
 * (a resolutionSource exists — the fact came from web/user/tool, never from the model's
 * own uncertain output) and NOT an external-outage (those aren't learnable). Pure.
 */
export function isTrainingEligible(gap: Gap): boolean {
  if (!gap.resolutionSource || !gap.resolvedAt) {
    return false; // unresolved or self-asserted → never train on it (§9.3)
  }
  if (gap.resolutionType === "external-outage") {
    return false; // transient outage is not a knowledge gain
  }
  return true;
}

// --------------------------------------------------------------------------
// (a) notifyLoraTrainingNeeded — fire-and-forget intent signal
// --------------------------------------------------------------------------

/**
 * Signal that the day's validated buffer warrants a LoRA consolidation pass. ORCHESTRATION
 * SHELL ONLY: this spawns a fire-and-forget promise and NEVER awaits it — the actual
 * training is the external deliverable. The caller gets `void` back immediately, so a hot
 * inference path can drop this signal without blocking. Best-effort: it never throws, even
 * if the emitter does.
 *
 * @returns void — intentionally NOT a Promise, so callers cannot accidentally await it.
 */
export function notifyLoraTrainingNeeded(
  gaps: Gap[],
  opts: { emit?: typeof emitAgentEvent; runId?: string; sessionKey?: string } = {},
): void {
  const emit = opts.emit ?? emitAgentEvent;
  const runId = opts.runId ?? DEFAULT_RUN_ID;
  // Fire-and-forget: schedule the signal off the caller's stack, never await it.
  void Promise.resolve()
    .then(() => {
      const eligible = gaps.filter(isTrainingEligible);
      emit({
        runId,
        stream: "lifecycle",
        data: {
          phase: "lora-training-needed",
          gapCount: gaps.length,
          eligibleCount: eligible.length,
          note: "2c LoRA training is EXTERNAL/out-of-scope — intent only",
        },
        ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      });
    })
    .catch((err) => {
      // A fire-and-forget signal must never surface an error anywhere.
      log.warn(
        `[consolidation] notifyLoraTrainingNeeded signal failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
}

// --------------------------------------------------------------------------
// (b) runNightlyConsolidation — the supervisor (DI, no GPU, never throws)
// --------------------------------------------------------------------------

/** Result of the (external) black-box trainer subprocess, by JSON contract. */
export interface TrainerResult {
  ok: boolean;
  /** Path/id of the produced adapter, present on success. */
  adapterPath?: string;
  /** Error string when ok=false. */
  error?: string;
}

/**
 * Injected dependencies for the supervisor. Every external touchpoint (the trainer, the
 * benchmark gate, the ENGRAM-owned pointer update, the event emitter, the gap source) is
 * injected so the supervisor unit-tests with NO GPU and NO model API.
 */
export interface ConsolidationDeps {
  /** Read the day's EXTERNALLY-VALIDATED, high-priority gaps eligible for training. */
  readValidatedGaps: () => Gap[];
  /** Spawn the EXTERNAL black-box trainer (JSON contract). Out-of-scope impl. */
  trainAdapter: (gaps: Gap[]) => Promise<TrainerResult>;
  /** The codeable-now capability gate (default real impl is `runCapabilityMatrix`). */
  runCapabilityMatrix: (adapter: string) => Promise<CapabilityReport>;
  /** ENGRAM/J1-owned atomic pointer update — called ONLY on a passing gate. */
  updateConsolidationPointer: (adapterPath: string) => void;
  /** Event emitter (defaults to emitAgentEvent in prod). */
  emit?: typeof emitAgentEvent;
  /** runId for emitted lifecycle events. */
  runId?: string;
  /** Optional sessionKey to thread through events. */
  sessionKey?: string;
}

export type ConsolidationStatus = "skipped" | "merged" | "rejected";

export interface ConsolidationResult {
  status: ConsolidationStatus;
  reason?: string;
  adapterPath?: string;
  report?: CapabilityReport;
}

/**
 * Supervise one nightly consolidation cycle:
 *   1. gather validated high-priority gaps → SKIP (cost guard) if none;
 *   2. spawn the EXTERNAL trainer → REJECT if it fails (no adapter produced);
 *   3. run the capability gate → REJECT (keep old adapter) on regression/alignment-fail,
 *      emitting "consolidation-fail";
 *   4. on PASS → update the ENGRAM-owned pointer + emit "consolidation-merged".
 *
 * NO training happens in-process. Defensive: any thrown error collapses to "rejected"
 * with the pointer untouched — never throws to the caller.
 */
export async function runNightlyConsolidation(
  deps: ConsolidationDeps,
): Promise<ConsolidationResult> {
  const emit = deps.emit ?? emitAgentEvent;
  const runId = deps.runId ?? DEFAULT_RUN_ID;
  const sessionKey = deps.sessionKey;
  const emitPhase = (phase: string, extra: Record<string, unknown> = {}) => {
    try {
      emit({
        runId,
        stream: "lifecycle",
        data: { phase, ...extra },
        ...(sessionKey ? { sessionKey } : {}),
      });
    } catch (err) {
      log.warn(
        `[consolidation] emit "${phase}" failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  try {
    // 1. Cost guard — only train when there are high-priority validated gaps.
    const gaps = deps.readValidatedGaps().filter(isTrainingEligible);
    if (gaps.length === 0) {
      log.info("[consolidation] skip — no high-priority validated gaps");
      emitPhase("consolidation-skipped", { reason: "no-high-priority-gaps" });
      return { status: "skipped", reason: "no-high-priority-gaps" };
    }

    emitPhase("consolidation-started", { gapCount: gaps.length });

    // 2. External black-box trainer (out-of-scope impl; injected here).
    const trained = await deps.trainAdapter(gaps);
    if (!trained.ok || !trained.adapterPath) {
      log.warn(
        `[consolidation] external trainer failed: ${trained.error ?? "no adapter produced"}`,
      );
      emitPhase("consolidation-fail", {
        stage: "train",
        error: trained.error ?? "trainer produced no adapter",
      });
      return { status: "rejected", reason: trained.error ?? "trainer-failed" };
    }
    const adapterPath = trained.adapterPath;

    // 3. Mandatory capability gate (codeable-now).
    const report = await deps.runCapabilityMatrix(adapterPath);
    if (!report.passed) {
      // Rollback = keep the old adapter (we simply never update the pointer).
      log.warn(
        `[consolidation] gate REJECT adapter=${adapterPath} ` +
          `maxRegression=${report.maxRegression} alignmentFail=${report.alignmentFail}`,
      );
      emitPhase("consolidation-fail", {
        stage: "gate",
        adapterPath,
        maxRegression: report.maxRegression,
        alignmentFail: report.alignmentFail,
      });
      return { status: "rejected", reason: "capability-regression", adapterPath, report };
    }

    // 4. Pass → atomic ENGRAM-owned pointer update + merged event.
    deps.updateConsolidationPointer(adapterPath);
    log.info(`[consolidation] MERGED adapter=${adapterPath} (gate passed)`);
    emitPhase("consolidation-merged", {
      adapterPath,
      maxRegression: report.maxRegression,
    });
    return { status: "merged", adapterPath, report };
  } catch (err) {
    // Defensive: a thrown trainer/gate/pointer must not crash the cron; keep old adapter.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[consolidation] supervisor caught error (rejecting, pointer untouched): ${msg}`);
    emitPhase("consolidation-fail", { stage: "supervisor", error: msg });
    return { status: "rejected", reason: msg };
  }
}
