/**
 * FORK: Distribution shift detector for AMYGDALA.
 *
 * Novelty detection via sliding window on conformal set sizes.
 * When AMYGDALA encounters a novel domain, conformal prediction sets widen.
 * This module detects sudden widening and enters a 48h novelty grace period
 * where epsilon is relaxed, allowing the agent to continue operating while
 * accumulating calibration data.
 */

export interface ShiftDetectorConfig {
  /** Size of the sliding window for detecting shifts (in hours) */
  detection_window_hours: number;
  /** Average prediction set size threshold to trigger a grace period */
  shift_threshold: number;
  /** Duration of the grace period (hours) */
  grace_period_hours: number;
  /** Relaxed epsilon during grace period */
  grace_epsilon: number;
  /** Normal operating epsilon */
  normal_epsilon: number;
  /** Minimum evaluations in the detection window before triggering */
  min_evaluations: number;
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
  timestamp: number;
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

  /**
   * Record a new prediction set size and check for distribution shift.
   * Called after every AMYGDALA evaluation.
   */
  recordAndCheck(predictionSetSize: number): ShiftCheckResult {
    const now = Date.now();

    this.window.push({ timestamp: now, setSize: predictionSetSize });
    this.pruneWindow(now);

    // Check if grace period is still active
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
      this.graceStartTime = null;
    }

    // Detect shift
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
      this.graceStartTime = now;
      this.shiftHistory.push({ time: now, avgSetSize: avg });

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
    if (this.graceStartTime === null) {
      return false;
    }
    const graceMs = this.cfg.grace_period_hours * 3_600_000;
    return Date.now() - this.graceStartTime < graceMs;
  }

  /** Effective epsilon to use right now. */
  effectiveEpsilon(): number {
    return this.isInGracePeriod() ? this.cfg.grace_epsilon : this.cfg.normal_epsilon;
  }

  /** How many hours remain in the current grace period. */
  graceRemainingHours(): number {
    if (this.graceStartTime === null) {
      return 0;
    }
    const graceMs = this.cfg.grace_period_hours * 3_600_000;
    const remaining = graceMs - (Date.now() - this.graceStartTime);
    return Math.max(0, remaining / 3_600_000);
  }

  /** History of detected shifts (for monitoring dashboards). */
  getShiftHistory(): ReadonlyArray<{ time: number; avgSetSize: number }> {
    return this.shiftHistory;
  }

  /** Manually trigger grace period exit. */
  forceExitGracePeriod(): void {
    this.graceStartTime = null;
    this.window = [];
  }

  // -- Private helpers --

  private pruneWindow(now: number): void {
    const windowMs = this.cfg.detection_window_hours * 3_600_000;
    const cutoff = now - windowMs;
    let i = 0;
    while (i < this.window.length && this.window[i].timestamp < cutoff) {
      i++;
    }
    if (i > 0) {
      this.window = this.window.slice(i);
    }
  }

  private avgSetSize(): number {
    if (this.window.length === 0) {
      return 1;
    }
    return this.window.reduce((s, e) => s + e.setSize, 0) / this.window.length;
  }
}
