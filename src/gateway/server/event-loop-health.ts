import { performance } from "node:perf_hooks";

const EVENT_LOOP_DELAY_WARN_MS = 1_000;
const EVENT_LOOP_UTILIZATION_WARN = 0.95;
const CPU_CORE_RATIO_WARN = 0.9;

// FORK(2026-08-28): the stall clock ticks at the 20 ms resolution the replaced
// monitorEventLoopDelay() histogram used, so delay sensitivity is unchanged -
// but a plain timer can ALSO answer stallCreditSince(), which a histogram
// never could because histogram reads were destructive (.reset()).
const STALL_CLOCK_TICK_MS = 20;
// ~60 s of history at 20 ms per sample. Deadlines look back at most
// budget + 1x-budget cap (20 s with the default pre-auth budget), so the ring
// always covers a live deadline's window.
const STALL_CLOCK_RING_CAPACITY = 3_000;

type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;
type CpuUsage = ReturnType<typeof process.cpuUsage>;

export type GatewayEventLoopHealthReason = "event_loop_delay" | "event_loop_utilization" | "cpu";

export type GatewayEventLoopHealth = {
  degraded: boolean;
  reasons: GatewayEventLoopHealthReason[];
  intervalMs: number;
  delayP99Ms: number;
  delayMaxMs: number;
  utilization: number;
  cpuCoreRatio: number;
};

export type GatewayEventLoopHealthMonitor = {
  snapshot: () => GatewayEventLoopHealth | undefined;
  stop: () => void;
};

function roundMetric(value: number, digits = 3): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

type StallSample = {
  seq: number;
  at: number;
  latenessMs: number;
  totalMs: number;
};

export type GatewayStallClockReader = {
  /** Lateness stats for the samples recorded since this reader's last read. */
  read: () => { sampleCount: number; latenessP99Ms: number; latenessMaxMs: number };
};

export type GatewayStallClock = {
  /**
   * Milliseconds of observed event-loop lateness accrued since tsMs. Monotonic
   * for a fixed tsMs; reading never mutates state, so concurrent consumers
   * cannot starve each other (the replaced histograms reset on every read).
   */
  stallCreditSince: (tsMs: number) => number;
  /** Independent windowed reader (per-reader cursor, no shared reset). */
  createReader: () => GatewayStallClockReader;
  stop: () => void;
};

// FORK(2026-08-28): R2/R4 - a deadline must not charge a peer for the
// gateway's OWN blockage. On 2026-08-28 every pre-auth `handshake timeout`
// (12:42:23, 12:45:23, 12:59:27, all loopback CLI peers) was followed by its
// own `closed before connect` 1.6-1.8 s later: the close callback itself had
// been queued behind an event-loop stall, i.e. the gateway killed live peers
// for its own stall. The stall clock is a running accumulator: a repeating
// timer adds each tick's lateness (actual - expected) to a monotonic total and
// keeps a ring of samples so stallCreditSince() can subtract a baseline. A
// histogram cannot provide this - both pre-existing monitors destructively
// .reset() on read.
export function createStallClock(
  opts: { tickMs?: number; ringCapacity?: number } = {},
): GatewayStallClock {
  const tickMs = Math.max(1, Math.floor(opts.tickMs ?? STALL_CLOCK_TICK_MS));
  const ringCapacity = Math.max(16, Math.floor(opts.ringCapacity ?? STALL_CLOCK_RING_CAPACITY));
  const startedAt = Date.now();
  const samples: StallSample[] = [];
  let totalMs = 0;
  let seq = 0;
  let stopped = false;
  let expectedAt = Date.now() + tickMs;
  let timer: NodeJS.Timeout | undefined;

  const onTick = () => {
    if (stopped) {
      return;
    }
    const now = Date.now();
    // A synchronous block delays this callback past expectedAt exactly once,
    // so the excess is the loop's lateness for that block. Clamp at 0: timers
    // never fire early, but wall-clock adjustments could read negative.
    const latenessMs = Math.max(0, now - expectedAt);
    totalMs += latenessMs;
    seq += 1;
    samples.push({ seq, at: now, latenessMs, totalMs });
    if (samples.length > ringCapacity + 64) {
      samples.splice(0, samples.length - ringCapacity);
    }
    expectedAt = now + tickMs;
    timer = setTimeout(onTick, tickMs);
    timer.unref();
  };
  timer = setTimeout(onTick, tickMs);
  // Never hold the process open for the sampler.
  timer.unref();

  return {
    stallCreditSince: (tsMs: number) => {
      if (samples.length === 0) {
        return 0;
      }
      if (tsMs <= startedAt) {
        return totalMs;
      }
      // Baseline = newest sample at-or-before tsMs. Lateness recorded after it
      // accrued (at least partly) after tsMs; the slight over-credit for a
      // stall straddling tsMs is bounded by one stall and by the 1x-budget cap
      // in stallAwareDeadlineMs().
      for (let i = samples.length - 1; i >= 0; i--) {
        if (samples[i].at <= tsMs) {
          return Math.max(0, totalMs - samples[i].totalMs);
        }
      }
      // tsMs predates the retained window (ring overflowed). Use the oldest
      // retained baseline: undercounts credit, degrading toward the old naive
      // deadline rather than extending it - the safe direction. Unreachable
      // for the gateway's deadlines (<= 2x budget lookback vs ~60 s of ring).
      return Math.max(0, totalMs - (samples[0].totalMs - samples[0].latenessMs));
    },
    createReader: () => {
      let lastSeq = seq;
      return {
        read: () => {
          const windowLateness: number[] = [];
          for (const sample of samples) {
            if (sample.seq > lastSeq) {
              windowLateness.push(sample.latenessMs);
            }
          }
          lastSeq = seq;
          if (windowLateness.length === 0) {
            return { sampleCount: 0, latenessP99Ms: 0, latenessMaxMs: 0 };
          }
          windowLateness.sort((a, b) => a - b);
          const p99Index = Math.min(
            windowLateness.length - 1,
            Math.floor(windowLateness.length * 0.99),
          );
          return {
            sampleCount: windowLateness.length,
            latenessP99Ms: windowLateness[p99Index],
            latenessMaxMs: windowLateness[windowLateness.length - 1],
          };
        },
      };
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

// Process-wide singleton: server.impl.ts primes it at startup (via
// createGatewayEventLoopHealthMonitor) before any WS connection arrives, and
// the pre-auth deadline in ws-connection.ts consults it lazily. It is unref'd
// and never stopped: one ~50 Hz JS callback replaces this module's previous
// monitorEventLoopDelay() histogram rather than adding a third monitor on the
// same loop (the diagnostic liveness sampler still owns the second; folding it
// onto this clock is a follow-up so its journald `liveness warning` format
// stays byte-identical).
let gatewayStallClock: GatewayStallClock | null = null;

export function getGatewayStallClock(): GatewayStallClock {
  if (!gatewayStallClock) {
    gatewayStallClock = createStallClock();
  }
  return gatewayStallClock;
}

export function gatewayStallCreditSince(tsMs: number): number {
  return getGatewayStallClock().stallCreditSince(tsMs);
}

// FORK(2026-08-28): cap the stall credit at 1x the budget. Event-loop
// utilization ran 0.728-1.000 for hours on 2026-08-28; uncapped credit would
// convert "wrongly kills a live peer" into "never detects a dead one". The cap
// also bounds a dead pre-auth socket's lifetime at budget + cap = 2x budget.
export function stallAwareDeadlineMs(budgetMs: number, stallCreditMs: number): number {
  const budget = Math.max(0, budgetMs);
  const credit = Math.min(Math.max(0, stallCreditMs), budget);
  return budget + credit;
}

export type StallAwareDeadlineHandle = {
  clear: () => void;
};

// FORK(2026-08-28): shared deadline primitive so the pre-auth handshake timer
// (ws-connection.ts) and its tests exercise the SAME re-arm loop. When the
// timer fires, elapsed wall clock is compared against budget + capped stall
// credit; if the gateway's own stall consumed part of the budget, the deadline
// re-arms for the remainder instead of closing. The 1x cap doubles as the
// termination proof: allowedMs never exceeds 2x budget, so real time always
// catches up and a genuinely dead peer still dies within budget + cap.
export function startStallAwareDeadline(opts: {
  budgetMs: number;
  startedAtMs: number;
  stallCreditSince: (tsMs: number) => number;
  onExpire: (info: { elapsedMs: number; stallCreditMs: number }) => void;
}): StallAwareDeadlineHandle {
  let timer: NodeJS.Timeout | undefined;
  let cleared = false;
  const arm = (delayMs: number) => {
    timer = setTimeout(() => {
      if (cleared) {
        return;
      }
      const elapsedMs = Date.now() - opts.startedAtMs;
      const allowedMs = stallAwareDeadlineMs(
        opts.budgetMs,
        opts.stallCreditSince(opts.startedAtMs),
      );
      if (elapsedMs < allowedMs) {
        arm(allowedMs - elapsedMs);
        return;
      }
      opts.onExpire({ elapsedMs, stallCreditMs: allowedMs - opts.budgetMs });
    }, delayMs);
  };
  arm(Math.max(0, opts.budgetMs));
  return {
    clear: () => {
      cleared = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

export function createGatewayEventLoopHealthMonitor(): GatewayEventLoopHealthMonitor {
  // FORK(2026-08-28): this monitor owned a second monitorEventLoopDelay()
  // histogram on the same loop (diagnostic liveness owns another) whose
  // destructive .reset() on read made it useless for "how much lateness
  // accrued since T". Delay stats now come from the shared stall clock via a
  // per-monitor reader: snapshot() no longer resets anything global, and
  // stallCreditSince() stays exact for the pre-auth handshake deadline.
  // delayP99Ms/delayMaxMs are now the EXCESS lateness over the tick (the
  // histogram included its ~20 ms resolution baseline); the warn threshold is
  // 1,000 ms, so the degraded flags are unaffected.
  const reader = getGatewayStallClock().createReader();
  let lastWallAt = Date.now();
  let lastCpuUsage: CpuUsage | null = process.cpuUsage();
  let lastEventLoopUtilization: EventLoopUtilization | null = performance.eventLoopUtilization();

  return {
    snapshot: () => {
      if (!lastCpuUsage || !lastEventLoopUtilization || lastWallAt <= 0) {
        return undefined;
      }

      const now = Date.now();
      const intervalMs = Math.max(1, now - lastWallAt);
      const cpuUsage = process.cpuUsage(lastCpuUsage);
      const currentEventLoopUtilization = performance.eventLoopUtilization();
      const utilization = roundMetric(
        performance.eventLoopUtilization(currentEventLoopUtilization, lastEventLoopUtilization)
          .utilization,
      );
      const latenessWindow = reader.read();
      const delayP99Ms = roundMetric(latenessWindow.latenessP99Ms, 1);
      const delayMaxMs = roundMetric(latenessWindow.latenessMaxMs, 1);
      const cpuTotalMs = roundMetric((cpuUsage.user + cpuUsage.system) / 1_000, 1);
      const cpuCoreRatio = roundMetric(cpuTotalMs / intervalMs);
      const reasons: GatewayEventLoopHealthReason[] = [];

      if (delayP99Ms >= EVENT_LOOP_DELAY_WARN_MS || delayMaxMs >= EVENT_LOOP_DELAY_WARN_MS) {
        reasons.push("event_loop_delay");
      }
      if (utilization >= EVENT_LOOP_UTILIZATION_WARN) {
        reasons.push("event_loop_utilization");
      }
      if (cpuCoreRatio >= CPU_CORE_RATIO_WARN) {
        reasons.push("cpu");
      }

      lastWallAt = now;
      lastCpuUsage = process.cpuUsage();
      lastEventLoopUtilization = currentEventLoopUtilization;

      return {
        degraded: reasons.length > 0,
        reasons,
        intervalMs,
        delayP99Ms,
        delayMaxMs,
        utilization,
        cpuCoreRatio,
      };
    },
    stop: () => {
      // The shared stall clock stays up (unref'd): the pre-auth deadline
      // consults it independently of this monitor's lifecycle.
      lastWallAt = 0;
      lastCpuUsage = null;
      lastEventLoopUtilization = null;
    },
  };
}
