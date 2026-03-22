// ============================================================
// src/amygdala/distribution-shift.ts
// Novelty detection via sliding window on conformal set sizes.
//
// When AMYGDALA encounters a novel domain (e.g., a new API, a new
// codebase), conformal prediction sets widen because calibration data
// doesn't cover the new distribution. Without this module, the agent
// would escalate every action for ~30 days until the calibration
// window catches up — effectively paralysing itself.
//
// Solution: detect sudden widening → enter a 48h novelty grace period
// where epsilon is relaxed (ε=0.15 instead of 0.05), allowing the agent
// to continue operating while accumulating calibration data. After the
// grace period, auto-recalibrate and resume normal operation.
// ============================================================

export interface ShiftDetectorConfig {
  /** Size of the sliding window for detecting shifts (in hours) */
  detection_window_hours: number;    // default: 4
  /** Average prediction set size threshold to trigger a grace period */
  shift_threshold: number;           // default: 2.0
  /** Duration of the grace period (hours) */
  grace_period_hours: number;        // default: 48
  /** Relaxed epsilon during grace period (wider prediction sets allowed) */
  grace_epsilon: number;             // default: 0.15
  /** Normal operating epsilon */
  normal_epsilon: number;            // default: 0.05
  /** Minimum evaluations in the detection window before triggering */
  min_evaluations: number;           // default: 20
}

const DEFAULTS: ShiftDetectorConfig = {
  detection_window_hours: 4,
  shift_threshold: 2.0,
  grace_period_hours: 48,
  grace_epsilon: 0.15,
  normal_epsilon: 0.05,
  min_evaluations: 20,
};

export interface ShiftCheckResult {
  /** Whether we are currently in a novelty grace period */
  inGracePeriod: boolean;
  /** Effective epsilon to use for conformal prediction */
  effectiveEpsilon: number;
  /** Whether a new shift was detected by this call */
  shiftDetected: boolean;
  /** Current average set size in the detection window */
  currentAvgSetSize: number;
}

interface WindowEntry {
  timestamp: number; // Date.now()
  setSize: number;
}

export class DistributionShiftDetector {
  private cfg: ShiftDetectorConfig;
  private window: WindowEntry[] = [];
  private graceStartTime: number | null = null;
  private shiftHistory: Array<{ time: number; avgSetSize: number }> = [];

  constructor(config: Partial<ShiftDetectorConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Record a new prediction set size and check for distribution shift.
   *
   * Called after every AMYGDALA evaluation.  O(1) amortised.
   *
   * @param predictionSetSize  Size of the conformal prediction set (1, 2, or 3)
   */
  recordAndCheck(predictionSetSize: number): ShiftCheckResult {
    const now = Date.now();

    // Add entry and prune old ones
    this.window.push({ timestamp: now, setSize: predictionSetSize });
    this.pruneWindow(now);

    // ── Check if grace period is still active ────────────────
    if (this.graceStartTime !== null) {
      const graceMs = this.cfg.grace_period_hours * 3_600_000;
      if (now - this.graceStartTime < graceMs) {
        return {
          inGracePeriod: true,
          effectiveEpsilon: this.cfg.grace_epsilon,
          shiftDetected: false,
          currentAvgSetSize: this.avgSetSize(),
        };
      }
      // Grace period expired — exit and signal for recalibration
      this.graceStartTime = null;
      this.onGracePeriodExpired();
    }

    // ── Detect shift ─────────────────────────────────────────
    if (this.window.length < this.cfg.min_evaluations) {
      return {
        inGracePeriod: false,
        effectiveEpsilon: this.cfg.normal_epsilon,
        shiftDetected: false,
        currentAvgSetSize: this.avgSetSize(),
      };
    }

    const avg = this.avgSetSize();
    if (avg > this.cfg.shift_threshold) {
      // Enter grace period
      this.graceStartTime = now;
      this.shiftHistory.push({ time: now, avgSetSize: avg });

      console.warn(
        `[AMYGDALA:DistributionShift] Novelty detected: avg prediction set size ` +
          `${avg.toFixed(2)} > threshold ${this.cfg.shift_threshold}. ` +
          `Entering ${this.cfg.grace_period_hours}h grace period ` +
          `(ε: ${this.cfg.normal_epsilon} → ${this.cfg.grace_epsilon}).`,
      );

      return {
        inGracePeriod: true,
        effectiveEpsilon: this.cfg.grace_epsilon,
        shiftDetected: true,
        currentAvgSetSize: avg,
      };
    }

    return {
      inGracePeriod: false,
      effectiveEpsilon: this.cfg.normal_epsilon,
      shiftDetected: false,
      currentAvgSetSize: avg,
    };
  }

  /** Whether we are currently in a novelty grace period. */
  isInGracePeriod(): boolean {
    if (this.graceStartTime === null) return false;
    const graceMs = this.cfg.grace_period_hours * 3_600_000;
    return Date.now() - this.graceStartTime < graceMs;
  }

  /** Effective epsilon to use right now. */
  effectiveEpsilon(): number {
    return this.isInGracePeriod()
      ? this.cfg.grace_epsilon
      : this.cfg.normal_epsilon;
  }

  /**
   * How many hours remain in the current grace period.
   * Returns 0 if not in a grace period.
   */
  graceRemainingHours(): number {
    if (this.graceStartTime === null) return 0;
    const graceMs = this.cfg.grace_period_hours * 3_600_000;
    const remaining = graceMs - (Date.now() - this.graceStartTime);
    return Math.max(0, remaining / 3_600_000);
  }

  /**
   * History of detected shifts (for monitoring dashboards).
   */
  getShiftHistory(): ReadonlyArray<{ time: number; avgSetSize: number }> {
    return this.shiftHistory;
  }

  /**
   * Manually trigger grace period exit + recalibration signal.
   * Useful in tests or when the nightly calibration runs early.
   */
  forceExitGracePeriod(): void {
    this.graceStartTime = null;
    this.window = []; // Reset window so the next phase has clean data
  }

  /**
   * Update the baseline average set size after a successful recalibration.
   * Used to dynamically adjust the shift_threshold if needed.
   */
  updateBaseline(newBaselineAvg: number): void {
    // Optionally update threshold based on new baseline + margin
    // For now, keep the threshold static as per the plan.
    // This hook is here for future use.
    void newBaselineAvg;
  }

  // ── Private helpers ──────────────────────────────────────────

  private pruneWindow(now: number): void {
    const windowMs = this.cfg.detection_window_hours * 3_600_000;
    const cutoff = now - windowMs;
    // Find first entry within the window (entries are chronological)
    let i = 0;
    while (i < this.window.length && this.window[i].timestamp < cutoff) i++;
    if (i > 0) this.window = this.window.slice(i);
  }

  private avgSetSize(): number {
    if (this.window.length === 0) return 1;
    return (
      this.window.reduce((s, e) => s + e.setSize, 0) / this.window.length
    );
  }

  /**
   * Called when a grace period expires.
   * In the full system, this triggers an async recalibration request.
   * For now it just logs — the nightly CEREBELLUM cycle handles recalibration.
   */
  private onGracePeriodExpired(): void {
    console.info(
      `[AMYGDALA:DistributionShift] Grace period expired. ` +
        `Recalibration will run on next nightly cycle.`,
    );
  }
}
