/**
 * Circuit breaker for the Jev call path (design doc §1 C6). After N consecutive failures it opens; after
 * `resetMs` it lets exactly ONE probe through (half-open) and closes on that probe's success.
 */

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private readonly failuresToOpen: number;
  private readonly resetMs: number;
  private readonly now: () => number;
  private consecutive = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(o: { failures?: number; resetMs?: number; now?: () => number } = {}) {
    this.failuresToOpen = o.failures ?? 3;
    this.resetMs = o.resetMs ?? 30_000;
    this.now = o.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.resetMs ? "half-open" : "open";
  }

  /** When an open breaker lets a probe through (ms), or null while closed. Pure: unlike `isOpen` it changes nothing. */
  get retryAt(): number | null {
    return this.openedAt === null ? null : this.openedAt + this.resetMs;
  }

  /** True when the caller must NOT call. In half-open the first caller gets the probe (false), the rest see true. */
  isOpen(): boolean {
    const st = this.state;
    if (st === "closed") return false;
    if (st === "open") return true;
    if (this.probing) return true;
    this.probing = true;
    return false;
  }

  recordSuccess(): void {
    this.consecutive = 0;
    this.openedAt = null;
    this.probing = false;
  }

  recordFailure(): void {
    if (this.openedAt !== null) {
      // A failed probe (or a straggler while open) restarts the wait.
      this.openedAt = this.now();
      this.probing = false;
      return;
    }
    this.consecutive += 1;
    if (this.consecutive >= this.failuresToOpen) {
      this.openedAt = this.now();
      this.probing = false;
    }
  }
}
