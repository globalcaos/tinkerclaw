/**
 * FORK: Fractal Reflection v3 — DERIVED-pressure resource governor.
 *
 * Bible §5.67b "Flood control" + "Safety ceilings" (TINKER_UI_DESIGN_BIBLE/bible.md):
 * the quota governor is BIDIRECTIONAL, driven by one DERIVED pressure score
 * p = f(5h utilization, time-to-reset, value-of-finding). FOUNDATION #2 explicitly
 * FORBIDS a frozen "70%" working threshold — budget weighs real remaining allowance
 * AND time-to-reset. Every fixed number in this module is a documented safety
 * CEILING (design-principles #19), never the working bound; each ceiling's
 * derivation formula belongs in TINKER_UI_DESIGN_BIBLE/config-shape.md.
 *
 * Pure logic with injected dependencies (clock + usage reader) for testability.
 * Three independent mechanisms:
 *   1. mode(valueOfWork)      — derived-pressure quota governor (full → triage-only → skip)
 *   2. tryTakeSpawnToken()    — loop-guard token bucket (plumbing alarm, NOT a quota optimizer)
 *   3. recordOutcome()/breakerState() — crash circuit breaker (budget-exhausted EXCLUDED)
 *
 * Adaptive-pressure warn (§5.67b "Safety ceilings"): every approach within ~80% of
 * any ceiling surfaces as a `WARN:` fragment in the returned reason string — the
 * caller logs/emits it as the `quota-pressure` trail event instead of hitting a cliff.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValueOfWork = "triage" | "evidence-backed-fix";

export type GovernorMode = "full" | "triage-only" | "skip";

export interface UsageSnapshot {
  /** Fraction of the 5h subscription window consumed, 0..1. */
  utilization5h?: number;
  /** Epoch ms at which the 5h window resets. */
  resetsAtMs?: number;
}

export interface GovernorDeps {
  /** Injected clock (epoch ms). All timing flows through this — fake it in tests. */
  now: () => number;
  /**
   * Reads the live usage signal (cc-bridge `usage.status`). Return null (or throw)
   * when the signal is unavailable (403/absent) — the governor fails to NEUTRAL,
   * never to closed (§5.67b: the gateway has no fresh quota signal for the
   * cc-bridge subscription path).
   */
  readUsage: () => Promise<UsageSnapshot | null>;
}

export interface ModeDecision {
  mode: GovernorMode;
  /**
   * The derived pressure score. BIDIRECTIONAL around a neutral baseline of 0:
   * positive = ahead of the window's even-spend pace (real pressure), negative =
   * behind pace (spendable surplus — e.g. low utilization minutes before reset).
   * The surplus-spend consumer is stubbed for Drop 1, but the score already
   * carries the signal it will need.
   */
  pressure: number;
  /** Human-readable derivation + any `WARN:` adaptive-pressure fragments. */
  reason: string;
}

export type BreakerStateName = "closed" | "open" | "half-open";

export interface BreakerState {
  state: BreakerStateName;
  /**
   * Present while "open": epoch ms at which the open window ends and a SINGLE
   * half-open probe is permitted (the caller spawns at most one probe; its
   * recorded outcome closes or re-opens the breaker).
   */
  opensAtMs?: number;
}

// ---------------------------------------------------------------------------
// Safety CEILINGS (#19 discipline — ceilings, never working bounds)
// Derivation formulas live in TINKER_UI_DESIGN_BIBLE/config-shape.md; recompute
// from ledger rows once they exist (§5.67b "Safety ceilings carry #19 discipline").
// ---------------------------------------------------------------------------

/**
 * CEILING — utilization at/above this skips ALL fractal work regardless of the
 * derived pressure score (even spendable surplus never overrides it: surplus
 * mode NEVER raises the safety ceilings, §5.67b). Derivation: leave headroom
 * for the owner's own interactive turns in the 5h window; see config-shape.md.
 */
export const HARD_UTILIZATION_CEILING = 0.85;

/**
 * CEILING — usage-read memo TTL (~5 min). §5.67b: derive from usage-endpoint
 * staleness, not a flat 5 min; this constant is the outermost bound only.
 * Derivation in config-shape.md.
 */
export const USAGE_MEMO_TTL_MS = 5 * 60_000;

/**
 * CEILING — loop-guard token bucket, ~30 spawns/h, continuous refill (§5.67b
 * loop guard L3). Derivation: ≈ p95 observed main-turn rate × 2 lanes/turn ×
 * safety factor — recompute from ledger rows; see config-shape.md. This is a
 * plumbing alarm, not a quota optimizer.
 */
export const SPAWN_TOKEN_CEILING_PER_HOUR = 30;

/** Consecutive non-excluded failures that trip the circuit breaker (§5.67b). */
export const BREAKER_TRIP_THRESHOLD = 3;

/**
 * CEILING — breaker open window (15 min) before a single half-open probe.
 * §5.67b: derive open-time per failure class (quota-blind vs crash); this
 * constant is the Drop-1 ceiling. Derivation in config-shape.md.
 */
export const BREAKER_OPEN_MS = 15 * 60_000;

/** The subscription quota window the utilization signal describes (5 hours). */
export const QUOTA_WINDOW_MS = 5 * 60 * 60_000;

/**
 * CEILING — derived pressure above which the governor degrades full → triage-only.
 * Pressure is pace-relative (utilization minus elapsed window fraction), so 0.10
 * ≈ "10 percentage points ahead of even-spend pace". Derivation in config-shape.md.
 */
export const FULL_PRESSURE_CEILING = 0.1;

/**
 * CEILING — derived pressure above which work degrades to skip (after the
 * value-of-work tolerance credit). Derivation in config-shape.md.
 */
export const SKIP_PRESSURE_CEILING = 0.35;

/**
 * Pressure-tolerance credit for evidence-backed work: an evidence-backed queued
 * fix outranks speculative triage (§5.67b), so it tolerates higher raw pressure
 * before degrading. CEILING; derivation in config-shape.md.
 */
export const EVIDENCE_PRESSURE_TOLERANCE = 0.2;

/**
 * Fraction of any ceiling at which the adaptive-pressure warn fires (§5.67b:
 * "emits an adaptive-pressure warn trail event as it is approached (~80%)").
 */
export const CEILING_WARN_FRACTION = 0.8;

// ---------------------------------------------------------------------------
// Governor
// ---------------------------------------------------------------------------

interface UsageMemo {
  atMs: number;
  value: UsageSnapshot | null;
}

export class FractalGovernor {
  private readonly deps: GovernorDeps;

  private usageMemo: UsageMemo | null = null;

  // Token bucket (starts full; continuous refill at SPAWN_TOKEN_CEILING_PER_HOUR / h)
  private tokens = SPAWN_TOKEN_CEILING_PER_HOUR;
  private lastRefillMs: number;

  // Circuit breaker
  private breaker: BreakerStateName = "closed";
  private openedAtMs = 0;
  private failureStreak = 0;

  constructor(deps: GovernorDeps) {
    this.deps = deps;
    this.lastRefillMs = deps.now();
  }

  // -------------------------------------------------------------------------
  // (1) Derived-pressure quota governor
  // -------------------------------------------------------------------------

  /**
   * Decide the operating mode for a piece of fractal work.
   *
   * Pressure derivation (FOUNDATION #2 — derived, bidirectional, never frozen):
   *   elapsedFraction = 1 − timeToReset / QUOTA_WINDOW_MS   (the even-spend pace)
   *   pressure        = utilization5h − elapsedFraction
   * Ahead of pace → positive pressure; behind pace (e.g. low utilization minutes
   * before reset) → NEGATIVE pressure = spendable surplus that LOWERS the
   * escalation bar. High utilization minutes before reset is surplus, not
   * pressure — but the HARD_UTILIZATION_CEILING still skips regardless.
   *
   * Fail-to-neutral: a null/erroring/stale usage signal yields pressure 0 and
   * mode "full" — triage stays allowed and fix-lane spawns are governed only by
   * the hourly token bucket (the surplus-spend branch disarms).
   */
  async mode(valueOfWork: ValueOfWork): Promise<ModeDecision> {
    const nowMs = this.deps.now();
    const usage = await this.readUsageMemoized(nowMs);

    const utilization = usage?.utilization5h;
    const staleReset = typeof usage?.resetsAtMs === "number" && usage.resetsAtMs <= nowMs;

    if (usage === null || typeof utilization !== "number" || staleReset) {
      const cause =
        usage === null
          ? "unavailable"
          : staleReset
            ? "stale (window already reset)"
            : "incomplete (no utilization)";
      const reason = this.withWarns(
        `usage signal ${cause} -- fail-to-neutral: triage allowed; fix-lane spawns governed by the hourly spawn bucket only (surplus-spend disarmed)`,
        this.collectCeilingWarns(nowMs, undefined, undefined),
      );
      return { mode: "full", pressure: 0, reason };
    }

    const u = clamp01(utilization);
    const elapsedFraction = this.deriveElapsedFraction(usage, nowMs);
    const pressure = u - elapsedFraction;

    const tolerance = valueOfWork === "evidence-backed-fix" ? EVIDENCE_PRESSURE_TOLERANCE : 0;
    const effectivePressure = pressure - tolerance;

    const detail =
      `pressure ${pressure.toFixed(3)} = utilization ${u.toFixed(3)} - even-spend pace ${elapsedFraction.toFixed(3)}` +
      `; value-of-work ${valueOfWork} tolerance ${tolerance.toFixed(2)} -> effective ${effectivePressure.toFixed(3)}` +
      (pressure < 0
        ? "; below neutral baseline: spendable surplus (surplus-spend consumer stubbed in Drop 1)"
        : "");

    const warns = this.collectCeilingWarns(nowMs, u, effectivePressure);

    // Hard ceiling overrides everything, including surplus (§5.67b: surplus mode
    // NEVER raises the safety ceilings).
    if (u >= HARD_UTILIZATION_CEILING) {
      return {
        mode: "skip",
        pressure,
        reason: this.withWarns(
          `utilization ${u.toFixed(3)} >= hard ceiling ${HARD_UTILIZATION_CEILING} -- skip regardless of derived pressure; ${detail}`,
          warns,
        ),
      };
    }

    let mode: GovernorMode;
    if (effectivePressure > SKIP_PRESSURE_CEILING) {
      mode = "skip";
    } else if (effectivePressure > FULL_PRESSURE_CEILING) {
      mode = "triage-only";
    } else {
      mode = "full";
    }

    return { mode, pressure, reason: this.withWarns(detail, warns) };
  }

  /** Elapsed fraction of the 5h window (the even-spend pace expectation). */
  private deriveElapsedFraction(usage: UsageSnapshot, nowMs: number): number {
    if (typeof usage.resetsAtMs === "number" && usage.resetsAtMs > nowMs) {
      const timeToResetMs = Math.min(usage.resetsAtMs - nowMs, QUOTA_WINDOW_MS);
      return 1 - timeToResetMs / QUOTA_WINDOW_MS;
    }
    // No reset timestamp: assume mid-window (the neutral pace expectation) so the
    // score stays derived from utilization rather than failing closed.
    return 0.5;
  }

  private async readUsageMemoized(nowMs: number): Promise<UsageSnapshot | null> {
    if (this.usageMemo && nowMs - this.usageMemo.atMs < USAGE_MEMO_TTL_MS) {
      return this.usageMemo.value;
    }
    let value: UsageSnapshot | null = null;
    try {
      value = await this.deps.readUsage();
    } catch {
      value = null; // fail-to-neutral, never to closed
    }
    this.usageMemo = { atMs: nowMs, value };
    return value;
  }

  // -------------------------------------------------------------------------
  // (2) Loop-guard token bucket (§5.67b loop guard L3 — plumbing alarm)
  // -------------------------------------------------------------------------

  /**
   * Take one spawn token if available. Continuous refill at
   * SPAWN_TOKEN_CEILING_PER_HOUR per hour, capped at the ceiling.
   */
  tryTakeSpawnToken(): boolean {
    this.refillTokens(this.deps.now());
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Current token count after refill (exposed for warns + observability). */
  spawnTokensRemaining(): number {
    this.refillTokens(this.deps.now());
    return this.tokens;
  }

  private refillTokens(nowMs: number): void {
    const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(
      SPAWN_TOKEN_CEILING_PER_HOUR,
      this.tokens + (elapsedMs * SPAWN_TOKEN_CEILING_PER_HOUR) / 3_600_000,
    );
  }

  // -------------------------------------------------------------------------
  // (3) Circuit breaker (§5.67b: 3 consecutive failures → OPEN 15min →
  //     half-open single probe; budget-exhausted does NOT count)
  // -------------------------------------------------------------------------

  /**
   * Record a spawn outcome. `kind` matters only for failures:
   * "budget-exhausted" is EXCLUDED from the breaker (§5.67b lane caps: it is a
   * resumable terminal status, not a plumbing failure) — it neither increments
   * nor resets the consecutive-failure streak.
   */
  recordOutcome(ok: boolean, kind?: "crash" | "budget-exhausted"): void {
    const nowMs = this.deps.now();
    this.syncBreaker(nowMs);

    if (ok) {
      this.failureStreak = 0;
      if (this.breaker === "half-open") {
        this.breaker = "closed"; // probe succeeded → close
      }
      return;
    }

    if (kind === "budget-exhausted") {
      return; // excluded: transparent to the breaker
    }

    this.failureStreak += 1;

    if (this.breaker === "half-open") {
      // Failed probe → re-open for another full window.
      this.breaker = "open";
      this.openedAtMs = nowMs;
      return;
    }

    if (this.breaker === "closed" && this.failureStreak >= BREAKER_TRIP_THRESHOLD) {
      this.breaker = "open";
      this.openedAtMs = nowMs;
    }
  }

  /** Current breaker state (lazily transitions open → half-open on the clock). */
  breakerState(): BreakerState {
    this.syncBreaker(this.deps.now());
    if (this.breaker === "open") {
      return { state: "open", opensAtMs: this.openedAtMs + BREAKER_OPEN_MS };
    }
    return { state: this.breaker };
  }

  private syncBreaker(nowMs: number): void {
    if (this.breaker === "open" && nowMs - this.openedAtMs >= BREAKER_OPEN_MS) {
      this.breaker = "half-open";
    }
  }

  // -------------------------------------------------------------------------
  // Adaptive-pressure warns (§5.67b "Safety ceilings": surface at ~80% of any
  // ceiling instead of only `skipped` at the cliff)
  // -------------------------------------------------------------------------

  private collectCeilingWarns(
    nowMs: number,
    utilization: number | undefined,
    effectivePressure: number | undefined,
  ): string[] {
    const warns: string[] = [];

    if (
      typeof utilization === "number" &&
      utilization >= CEILING_WARN_FRACTION * HARD_UTILIZATION_CEILING
    ) {
      warns.push(
        `WARN: utilization ${utilization.toFixed(3)} within ${Math.round(CEILING_WARN_FRACTION * 100)}% of hard ceiling ${HARD_UTILIZATION_CEILING}`,
      );
    }

    if (
      typeof effectivePressure === "number" &&
      effectivePressure > 0 &&
      effectivePressure >= CEILING_WARN_FRACTION * SKIP_PRESSURE_CEILING
    ) {
      warns.push(
        `WARN: quota pressure ${effectivePressure.toFixed(3)} approaching skip ceiling ${SKIP_PRESSURE_CEILING}`,
      );
    }

    this.refillTokens(nowMs);
    const consumedFraction = 1 - this.tokens / SPAWN_TOKEN_CEILING_PER_HOUR;
    if (consumedFraction >= CEILING_WARN_FRACTION) {
      warns.push(
        `WARN: spawn token bucket ${this.tokens.toFixed(1)}/${SPAWN_TOKEN_CEILING_PER_HOUR} remaining (>=${Math.round(CEILING_WARN_FRACTION * 100)}% consumed)`,
      );
    }

    // Integer ceiling: with a trip threshold of 3 the last pre-trip step (streak 2)
    // IS the >=80% approach (2.4 rounds past it) — warn one failure before the trip.
    if (this.breaker === "closed" && this.failureStreak >= BREAKER_TRIP_THRESHOLD - 1) {
      warns.push(`WARN: breaker failure streak ${this.failureStreak}/${BREAKER_TRIP_THRESHOLD}`);
    }

    return warns;
  }

  private withWarns(base: string, warns: string[]): string {
    if (warns.length === 0) {
      return base;
    }
    return `${base}; ${warns.join("; ")}`;
  }
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
