/**
 * FORK 2026-08-04 — observability for the gateway RPC surface.
 *
 * WHY. `scripts/bible/capability-coverage.mjs` measured the fork's capability surface and found
 * 185 gateway RPC methods with ZERO observability — the single largest blind spot in the repo,
 * and the one every other surface reaches the gateway through. The UI, the CLI, and every plugin
 * call these methods; nothing counted a call, timed one, or noticed one had stopped happening.
 *
 * Before writing that down it was checked against the innocent explanation, because a per-file
 * coverage scorer reports exactly the same zero when methods are observed CENTRALLY instead:
 * there was no per-method log, counter or timing anywhere on the dispatch path. The only
 * `metrics` object in the gateway (server.impl.ts) is startup timings, and diagnostics-prometheus
 * matches `req.method` — the HTTP verb, not the gateway method. The zero was real.
 *
 * THE SHAPE OF THE FIX. One chokepoint, not 185 edits. Every method — core and
 * plugin-registered — resolves through `handleGatewayRequest` in server-methods.ts, so counting
 * happens there and nowhere else. That also means this file can never drift out of sync with the
 * method list: it does not HAVE a method list, it observes whatever actually dispatches.
 *
 * THE MEASURE THAT MATTERS. Call counts are the cheap part. The number worth having is
 * NEVER-CALLED: methods that are registered and have not been invoked once since boot. That is
 * the capability-is-dead signal the fork has repeatedly lacked — `tinkerclaw-fractal-reflection`
 * failed 2,466 consecutive runs over eight weeks and nothing said so, because absence of a
 * success is not an event and nothing was watching for the absence. A registered method nobody
 * calls is either dead code or a broken caller, and both are worth knowing.
 *
 * NOT A METRICS SYSTEM, AND NOT AN EXPORT FORMAT. The summary is a line in the journal next to the
 * one report that is actually read (`[instrument-liveness]`). Adding a second thing nobody looks
 * at would repeat the exact mistake this file exists to correct — fractal wrote a perfect record
 * of its own failure into a file nobody opened.
 *
 * CORRECTION 2026-09-25: this header used to claim the counter Map was "bounded by the handler
 * table". It was not. `authorizeGatewayMethod` runs BEFORE the handler lookup, so a method name
 * that does not exist is refused with reason `auth`, not `unknown-method`, and a client-chosen
 * string entered both `counters` and `known` unbounded. The caps below make the claim true; the
 * sentence was removed rather than left to be believed.
 *
 * FORK 2026-09-25 (logging.md §4.2) — the since-boot counters answer "what is dead". The rollup
 * added here answers "what costs the main thread, per minute", which nothing could: the only
 * per-call record (`⇄ res`) fires for slow and failed calls ONLY, so no percentile was derivable
 * from it. Hot-path cost is a counter bump and one array index (L3); one row per method per window
 * leaves through the events writer.
 */
import { emitEvent } from "../infra/events/emit.js";
import { declareInstrument, noteInstrumentFired } from "../infra/instrument-liveness.js";
import { DEFAULT_WS_SLOW_MS } from "./ws-logging.js";

/** Why a request never reached its handler. Each is a distinct failure with a distinct fix. */
export type RpcRefusalReason = "auth" | "unavailable" | "rate-limit" | "unknown-method";

/** logging.md §4.2: one `rpc.minute` row per method per 60 s window, on the minute grid. */
const RPC_ROLLUP_WINDOW_MS = 60_000;
/** log2 buckets: bucket b covers [2^(b-1), 2^b) ms, so bucket 23 holds everything past ~2.3 h. */
const RPC_HIST_BUCKETS = 24;
/**
 * Below this many calls in a window, a "p99" is just the window's maximum: at one call a minute it
 * IS that call, so every next call would sit under a bar derived from itself and a smooth 3.5x
 * degradation would never be reported. Under the floor, the bar stays the floor.
 */
const RPC_SLOW_MIN_SAMPLES = 20;
/** A single outlier must not immunise the next window against a worse one. */
const RPC_SLOW_BAR_MAX_MS = 2_000;
/** Distinct method keys kept apart before the rest fold into one bucket (see the correction above). */
const RPC_COUNTER_CAP = 512;
/** Distinct names `known` accepts from the REQUEST path; `registerKnownRpcMethods` is not capped. */
const RPC_KNOWN_CAP = 1_024;
const RPC_OVERFLOW_METHOD = "(overflow)";

type MethodCounters = {
  dispatched: number;
  refused: number;
  lastAtMs: number;
  /** ── the open 60 s window (logging.md §4.2) ── */
  calls: number;
  totalMs: number;
  maxMs: number;
  errors: number;
  windowRefused: number;
  /** Allocated only when a refusal happens; refusals are rare and bump() stays a push. */
  windowRefusals: Partial<Record<RpcRefusalReason, number>> | null;
  hist: number[];
  /** max(DEFAULT_WS_SLOW_MS, 2 x the PREVIOUS window's p99), capped — see flushRpcRollup. */
  slowBarMs: number;
};

const counters = new Map<string, MethodCounters>();
const refusalsByReason = new Map<RpcRefusalReason, number>();
let rpcWindowStartMs = 0;
/** Methods known to exist, so "never called" has a denominator. Filled at first dispatch. */
const known = new Set<string>();

let declared = false;
/**
 * Declared lazily from the dispatch path rather than at module scope. Module-scope declaration
 * registers the instrument merely because something imported the file — including a test — which
 * turns a real "never fired" into a permanent false "pending" in the liveness report, the one
 * bucket that reads as reassuring when it should not (observability.md, rule 5).
 */
function ensureDeclared(): void {
  if (declared) return;
  declared = true;
  declareInstrument({
    id: "gateway:rpc-dispatch",
    kind: "gate",
    description:
      "a gateway RPC method reached its handler — covers all core + plugin-registered methods at the single chokepoint",
  });
  declareInstrument({
    id: "gateway:rpc-refusal",
    kind: "gate",
    description:
      "a gateway RPC was refused before its handler (auth / unavailable / rate-limit / unknown-method)",
  });
}

function bump(method: string): MethodCounters {
  let c = counters.get(method);
  if (!c) {
    // Past the cap every further name shares ONE bucket. Unbounded growth here is not theoretical:
    // an authenticated client can mint method names through the auth-refusal path, and each entry
    // now carries a 24-slot histogram and earns a `hot`-retention row every minute. The overflow
    // key itself is exempt from the cap — otherwise the first name past the cap would recurse here
    // forever, because the overflow bucket does not exist yet either.
    if (counters.size >= RPC_COUNTER_CAP && method !== RPC_OVERFLOW_METHOD) {
      return bump(RPC_OVERFLOW_METHOD);
    }
    c = {
      dispatched: 0,
      refused: 0,
      lastAtMs: 0,
      calls: 0,
      totalMs: 0,
      maxMs: 0,
      errors: 0,
      windowRefused: 0,
      windowRefusals: null,
      hist: Array.from({ length: RPC_HIST_BUCKETS }, () => 0),
      slowBarMs: DEFAULT_WS_SLOW_MS,
    };
    counters.set(method, c);
  }
  return c;
}

/** Bucket index = the bit length of floor(ms), so bucket b spans [2^(b-1), 2^b). */
function histBucket(ms: number): number {
  const whole = Math.floor(ms);
  if (whole < 1) {
    return 0;
  }
  return Math.min(RPC_HIST_BUCKETS - 1, 32 - Math.clz32(whole));
}

/**
 * Nearest-rank p99 over the log2 histogram, reported as the containing bucket's LOWER bound.
 * The upper bound would be the obvious choice and is wrong: a true p99 of 33 ms sits in [32, 64),
 * so an upper-bound estimate doubled gives a bar of 128 ms — nearly 4x p99, against the 2x the
 * spec fixes, and the error is always in the direction of reporting FEWER outliers. The lower
 * bound keeps the derived bar at or under the documented 2x.
 */
function histP99LowerMs(hist: readonly number[]): number {
  let total = 0;
  for (const count of hist) {
    total += count;
  }
  if (total === 0) {
    return 0;
  }
  const rank = Math.ceil(total * 0.99);
  let seen = 0;
  for (let b = 0; b < hist.length; b++) {
    seen += hist[b];
    if (seen >= rank) {
      return b === 0 ? 0 : 2 ** (b - 1);
    }
  }
  return 2 ** (hist.length - 2);
}

function rpcMinuteSlot(nowMs: number): number {
  return Math.floor(nowMs / RPC_ROLLUP_WINDOW_MS) * RPC_ROLLUP_WINDOW_MS;
}

/**
 * Advance the window when `nowMs` has left its minute. Called from the two seams that START work
 * (dispatch and refusal) and from the 60 s health-tick summary — never from the duration seam: a
 * duration that lands after the boundary belongs to the new window, and opening a window from it
 * would produce a row with a duration and no call.
 */
function advanceRpcWindow(nowMs: number): void {
  const slot = rpcMinuteSlot(nowMs);
  if (rpcWindowStartMs === 0) {
    rpcWindowStartMs = slot;
    return;
  }
  if (slot !== rpcWindowStartMs) {
    flushRpcRollup(nowMs);
  }
}

/**
 * Emit one `rpc.minute` per method that saw traffic and open the next window. Rows are stamped at
 * the START of their minute, and the grid guarantees a row stamped at minute M holds only events
 * from minute M — a window that merely began at the first event would let one call at T0 and one
 * at T0+10 min share a row stamped T0, over-reporting the rate tenfold for exactly the quiet
 * methods this module exists to watch.
 *
 * A method with only REFUSALS is emitted too, which stretches §4.2's "per method with at least one
 * call": the `refused` and `refusal_reasons` fields exist precisely so a refusal storm is visible,
 * and a refused call still costs the dispatch path.
 */
export function flushRpcRollup(nowMs: number = Date.now()): void {
  const tsMs = rpcWindowStartMs === 0 ? rpcMinuteSlot(nowMs) : rpcWindowStartMs;
  for (const [method, c] of counters) {
    if (c.calls === 0 && c.windowRefused === 0) {
      continue;
    }
    const histMs: Record<string, number> = {};
    for (let b = 0; b < c.hist.length; b++) {
      if (c.hist[b] > 0) {
        histMs[String(b)] = c.hist[b];
      }
    }
    emitEvent("rpc.minute", {
      tsMs,
      label: method,
      n1: c.calls,
      n2: c.totalMs,
      n3: c.maxMs,
      n4: c.errors,
      fields: {
        refused: c.windowRefused,
        refusal_reasons: c.windowRefusals ?? {},
        hist_ms: histMs,
      },
    });
    c.slowBarMs =
      c.calls >= RPC_SLOW_MIN_SAMPLES
        ? Math.min(RPC_SLOW_BAR_MAX_MS, Math.max(DEFAULT_WS_SLOW_MS, 2 * histP99LowerMs(c.hist)))
        : DEFAULT_WS_SLOW_MS;
    c.calls = 0;
    c.totalMs = 0;
    c.maxMs = 0;
    c.errors = 0;
    c.windowRefused = 0;
    c.windowRefusals = null;
    c.hist.fill(0);
  }
  rpcWindowStartMs = rpcMinuteSlot(nowMs);
}

/** Record that `method` reached its handler. Called once, at the chokepoint. */
export function noteRpcDispatch(method: string): void {
  ensureDeclared();
  if (known.size < RPC_KNOWN_CAP) {
    known.add(method);
  }
  const nowMs = Date.now();
  advanceRpcWindow(nowMs);
  const c = bump(method);
  c.dispatched++;
  // Counted HERE, before the handler runs, for the same reason `dispatched` is: a handler that
  // never returns must not make its method's call count fall to zero, which would be
  // indistinguishable from the method going unused — the one reading this file exists to prevent.
  c.calls++;
  c.lastAtMs = nowMs;
  noteInstrumentFired("gateway:rpc-dispatch", method);
}

/** Record that `method` was refused BEFORE its handler, and why. */
export function noteRpcRefusal(method: string, reason: RpcRefusalReason): void {
  ensureDeclared();
  // An unknown method is not evidence that the method exists, so it must not enter `known` —
  // otherwise a client typo would invent a capability and then report it as never-called forever.
  if (reason !== "unknown-method" && known.size < RPC_KNOWN_CAP) {
    known.add(method);
  }
  const nowMs = Date.now();
  advanceRpcWindow(nowMs);
  const c = bump(method);
  c.refused++;
  c.lastAtMs = nowMs;
  c.windowRefused++;
  const windowRefusals = (c.windowRefusals ??= {});
  windowRefusals[reason] = (windowRefusals[reason] ?? 0) + 1;
  refusalsByReason.set(reason, (refusalsByReason.get(reason) ?? 0) + 1);
  noteInstrumentFired("gateway:rpc-refusal", `${method} (${reason})`);
}

/**
 * Record how long one dispatched call's handler took, at the same chokepoint (logging.md §4.2),
 * and emit `rpc.slow` for a call past this method's own bar.
 *
 * `threw` means the handler REJECTED. KNOWN GAP, stated rather than hidden: a gateway handler
 * reports ordinary failure with `respond(false, …, errorShape(…))` and returns normally, so
 * `n4=errors` counts UNCAUGHT failures only and an alert built on it would miss a method failing
 * every call. Observing the responder's `ok` means wrapping `respond` in a closure — a
 * per-request allocation on the hot path, which this seam is explicitly not allowed to add. Owed:
 * either the responder reports its own outcome, or §4.2 renames the column.
 *
 * Also known: a re-entrant dispatch (a plugin subagent calling back into the gateway) bills the
 * inner call's time to the outer method as well as to itself, so `n2` is a per-method trend, not
 * a quantity to sum across methods.
 *
 * n1 (`response_bytes`) is deliberately NULL for the same allocation reason.
 */
export function noteRpcHandlerDuration(method: string, durationMs: number, threw: boolean): void {
  const c = counters.get(method) ?? counters.get(RPC_OVERFLOW_METHOD);
  if (c === undefined) {
    // Only a DISPATCHED call is timed, and dispatch is what creates the counters.
    return;
  }
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  c.totalMs += ms;
  if (ms > c.maxMs) {
    c.maxMs = ms;
  }
  if (threw) {
    c.errors++;
  }
  c.hist[histBucket(ms)]++;
  if (ms >= c.slowBarMs) {
    emitEvent("rpc.slow", { label: method, durMs: ms });
  }
}

/**
 * Seed the set of methods that EXIST, so never-called can be reported against the real
 * denominator instead of only against methods that happened to be called. Safe to call repeatedly.
 */
export function registerKnownRpcMethods(methods: Iterable<string>): void {
  for (const m of methods) known.add(m);
}

export type RpcObservabilitySnapshot = {
  methodsKnown: number;
  methodsCalled: number;
  neverCalled: string[];
  totalDispatched: number;
  totalRefused: number;
  refusalsByReason: Record<string, number>;
  topMethods: Array<{ method: string; dispatched: number }>;
};

export function snapshotRpcObservability(): RpcObservabilitySnapshot {
  const neverCalled: string[] = [];
  let totalDispatched = 0;
  let totalRefused = 0;
  for (const m of known) {
    const c = counters.get(m);
    if (!c || c.dispatched === 0) neverCalled.push(m);
  }
  for (const c of counters.values()) {
    totalDispatched += c.dispatched;
    totalRefused += c.refused;
  }
  const topMethods = [...counters.entries()]
    .filter(([, c]) => c.dispatched > 0)
    .sort((a, b) => b[1].dispatched - a[1].dispatched)
    .slice(0, 8)
    .map(([method, c]) => ({ method, dispatched: c.dispatched }));
  return {
    methodsKnown: known.size,
    methodsCalled: known.size - neverCalled.length,
    neverCalled: neverCalled.sort(),
    totalDispatched,
    totalRefused,
    refusalsByReason: Object.fromEntries(refusalsByReason),
    topMethods,
  };
}

/** One line for the journal, shaped to sit beside the instrument-liveness summary. */
export function formatRpcObservabilitySummary(): string {
  const s = snapshotRpcObservability();
  const refusals = Object.entries(s.refusalsByReason)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return (
    `[gateway/rpc] methods=${s.methodsKnown} called=${s.methodsCalled} never-called=${s.neverCalled.length} ` +
    `dispatched=${s.totalDispatched} refused=${s.totalRefused}${refusals ? ` (${refusals})` : ""}`
  );
}

/** Last emitted signature, so an unchanged report is not reprinted every 60s. */
let lastSignature = "";

/**
 * The summary, but ONLY when it would teach a reader something — otherwise null.
 *
 * Emitted at INFO on the health tick. Two mistakes were made getting here and both are worth
 * keeping written down:
 *
 *   1. The first version logged at DEBUG. `log.child()` exposes only info/warn/error
 *      (`LogMethod` in src/logger.ts:18), so the call was `logHealth.debug?.(…)` against a
 *      method that does not exist — an OPTIONAL call that silently did nothing. The deploy was
 *      green, the build was green, and the line never appeared once. A guarded call to a missing
 *      method is indistinguishable from a working one that has nothing to say, which is precisely
 *      the class of silence this whole module exists to end. The call is now UNGUARDED and the
 *      parameter type REQUIRES `info`, so a missing method is a type error instead of silence.
 *
 *   2. Logging unconditionally every 60s is 1,440 identical lines a day, which is its own way of
 *      being unreadable. So the line is emitted only when the signature changes — the same
 *      reasoning the instrument-liveness reporter uses for its enumeration block: an unchanged
 *      report reprinted teaches nothing and trains the reader to skip it.
 *
 * The signature deliberately EXCLUDES the raw dispatch total, which changes on every tick of a
 * live system and would make "changed" mean "time passed". It tracks the facts worth waking up
 * for: how many methods exist, how many have ever been called, and the refusal count.
 */
export function formatRpcObservabilitySummaryIfChanged(): string | null {
  // FORK 2026-09-25 — this also CLOSES the `rpc.minute` window. It is called from the gateway's
  // existing 60 s health tick (server-maintenance.ts), the same tick this file already chose for
  // its own report "so there is one fewer thing that can itself stop running". Without a tick the
  // rollup would be closed only by a LATER call to the same method, so the quieter a method went
  // the less it would report — the exact inversion of what this module is for, and the final
  // window before every restart would be lost.
  advanceRpcWindow(Date.now());
  const s = snapshotRpcObservability();
  const signature = `${s.methodsKnown}/${s.methodsCalled}/${s.neverCalled.length}/${s.totalRefused}`;
  if (signature === lastSignature) return null;
  lastSignature = signature;
  return formatRpcObservabilitySummary();
}

/** Test-only reset. Counters are process-global by design; tests must not leak into each other. */
export function __resetRpcObservabilityForTests(): void {
  counters.clear();
  refusalsByReason.clear();
  known.clear();
  declared = false;
  lastSignature = "";
  rpcWindowStartMs = 0;
}
