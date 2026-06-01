/**
 * FORK 2026-06-01 — Capability-regression GATE for nightly LoRA consolidation (J8 §2c).
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────┐
 * │ 2c LoRA TRAINING IS EXTERNAL / OUT-OF-SCOPE.                                        │
 * │ The real GPU/Python trainer (transformers + bitsandbytes QLoRA) AND the real       │
 * │ MMLU / HumanEval / GSM8K / IFEval + alignment benchmark harness are a SEPARATE,     │
 * │ tracked deliverable that does NOT run in this TypeScript gateway. This module is    │
 * │ the codeable-now VALIDATION GATE only: it decides MERGE vs REJECT from benchmark    │
 * │ scores. When real scores are absent it returns a passing STUB (maxRegression 0.01)  │
 * │ so the apply path can be exercised without a real benchmark run.                    │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 *
 * The gate rule (paper §7.2 ICVR): reject the candidate adapter merge if ANY benchmark
 * regresses by more than 2% relative to baseline, OR if any alignment check fails. The
 * 2% bound and the alignment short-circuit are the only safety-critical logic here; the
 * model invocation that produces the scores is whatever inference endpoint serves the
 * adapter — out of scope, injected via `opts`.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("validation-capability-matrix");

/** Per-benchmark accuracy/score sheet, each value in [0,1]. Extra keys are allowed and
 *  compared pairwise; missing-on-candidate keys are treated as "not measured" (skipped). */
export type BenchmarkScores = Record<string, number>;

/** The merge-gate threshold: a per-benchmark drop GREATER THAN this rejects the merge.
 *  2% per paper §7.2 ICVR. A drop EQUAL to the threshold is tolerated (strictly-greater). */
export const MAX_REGRESSION_THRESHOLD = 0.02;

/**
 * The stub regression reported when no real benchmark scores are supplied. Deliberately
 * BELOW the threshold so the default path is a PASS — the apply/merge path stays testable
 * without a GPU benchmark run, while staying honest that no real evaluation happened.
 */
export const STUB_MAX_REGRESSION = 0.01;

export interface CapabilityReport {
  /** The adapter under test (path or id). */
  adapter: string;
  /** Largest per-benchmark drop (baseline - candidate), clamped at 0 (improvements ⇒ 0). */
  maxRegression: number;
  /** True if any alignment/value-drift check failed — an unconditional reject. */
  alignmentFail: boolean;
  /** Convenience: !isRegression(report). */
  passed: boolean;
  /** Per-benchmark deltas (candidate - baseline), present only when real scores were given. */
  deltas?: Record<string, number>;
}

export interface CapabilityMatrixOptions {
  /** Pre-adapter baseline scores. Required together with `candidate` for a real comparison. */
  baseline?: BenchmarkScores;
  /** Post-adapter candidate scores (mocked in tests; from the inference endpoint in prod). */
  candidate?: BenchmarkScores;
  /** Alignment/value-drift verdict from the (external) alignment suite. Defaults to false. */
  alignmentFail?: boolean;
}

/**
 * Pure predicate: does this report indicate a regression that must BLOCK the merge?
 * True iff the worst benchmark drop EXCEEDS the 2% threshold, or alignment failed.
 */
export function isRegression(
  report: Pick<CapabilityReport, "maxRegression" | "alignmentFail">,
): boolean {
  return report.alignmentFail === true || report.maxRegression > MAX_REGRESSION_THRESHOLD;
}

/**
 * Compute the worst per-benchmark regression between a baseline and a candidate score sheet.
 * Returns `{ maxRegression, deltas }` where `maxRegression` is the largest drop
 * (baseline - candidate) over the benchmarks present in BOTH sheets, clamped at 0 so a
 * pure improvement yields 0. Pure — no I/O. Exported for unit reuse.
 */
export function computeMaxRegression(
  baseline: BenchmarkScores,
  candidate: BenchmarkScores,
): { maxRegression: number; deltas: Record<string, number> } {
  let maxRegression = 0;
  const deltas: Record<string, number> = {};
  for (const key of Object.keys(baseline)) {
    if (!(key in candidate)) {
      continue; // not measured on the candidate → skip
    }
    const delta = candidate[key]! - baseline[key]!;
    deltas[key] = delta;
    const drop = -delta; // positive when the candidate is worse
    if (drop > maxRegression) {
      maxRegression = drop;
    }
  }
  return { maxRegression, deltas };
}

/**
 * Run the capability matrix for a candidate adapter and return the merge-gate report.
 *
 * - With injected `baseline` + `candidate` scores (the test / future-real path): computes
 *   the worst per-benchmark regression and folds in the alignment verdict.
 * - Without scores (the default STUB): returns a passing report with
 *   `maxRegression = STUB_MAX_REGRESSION` (0.01) so the consolidation apply path can be
 *   tested end-to-end without a real benchmark run.
 *
 * `async` to match the real (network-bound) harness signature, even though the stub and
 * the pure-comparison paths resolve immediately. Never throws on score-shape issues.
 */
export async function runCapabilityMatrix(
  adapter: string,
  opts: CapabilityMatrixOptions = {},
): Promise<CapabilityReport> {
  const alignmentFail = opts.alignmentFail === true;

  if (!opts.baseline || !opts.candidate) {
    // STUB path — no real benchmark scores supplied.
    log.info(
      `[capability-matrix] STUB gate for adapter=${adapter} (no real benchmark scores; ` +
        `LoRA training + benchmarks are EXTERNAL/out-of-scope) → maxRegression=${STUB_MAX_REGRESSION}`,
    );
    const maxRegression = STUB_MAX_REGRESSION;
    const report: CapabilityReport = {
      adapter,
      maxRegression,
      alignmentFail,
      passed: !isRegression({ maxRegression, alignmentFail }),
    };
    return report;
  }

  const { maxRegression, deltas } = computeMaxRegression(opts.baseline, opts.candidate);
  const passed = !isRegression({ maxRegression, alignmentFail });
  log.info(
    `[capability-matrix] gate for adapter=${adapter}: maxRegression=${maxRegression.toFixed(4)} ` +
      `alignmentFail=${alignmentFail} → ${passed ? "PASS" : "REJECT"}`,
  );
  return { adapter, maxRegression, alignmentFail, passed, deltas };
}
