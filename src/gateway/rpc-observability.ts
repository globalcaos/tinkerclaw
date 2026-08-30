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
 * DELIBERATELY NOT A METRICS SYSTEM. No histograms, no cardinality explosion, no export format.
 * Counters live in one Map keyed by method name, which is bounded by the handler table. The
 * summary is a line in the journal next to the one report that is actually read
 * (`[instrument-liveness]`). Adding a second thing nobody looks at would repeat the exact
 * mistake this file exists to correct — fractal wrote a perfect record of its own failure into a
 * file nobody opened.
 */
import { declareInstrument, noteInstrumentFired } from "../infra/instrument-liveness.js";

/** Why a request never reached its handler. Each is a distinct failure with a distinct fix. */
export type RpcRefusalReason = "auth" | "unavailable" | "rate-limit" | "unknown-method";

type MethodCounters = {
  dispatched: number;
  refused: number;
  lastAtMs: number;
};

const counters = new Map<string, MethodCounters>();
const refusalsByReason = new Map<RpcRefusalReason, number>();
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
    c = { dispatched: 0, refused: 0, lastAtMs: 0 };
    counters.set(method, c);
  }
  return c;
}

/** Record that `method` reached its handler. Called once, at the chokepoint. */
export function noteRpcDispatch(method: string): void {
  ensureDeclared();
  known.add(method);
  const c = bump(method);
  c.dispatched++;
  c.lastAtMs = Date.now();
  noteInstrumentFired("gateway:rpc-dispatch", method);
}

/** Record that `method` was refused BEFORE its handler, and why. */
export function noteRpcRefusal(method: string, reason: RpcRefusalReason): void {
  ensureDeclared();
  // An unknown method is not evidence that the method exists, so it must not enter `known` —
  // otherwise a client typo would invent a capability and then report it as never-called forever.
  if (reason !== "unknown-method") known.add(method);
  const c = bump(method);
  c.refused++;
  c.lastAtMs = Date.now();
  refusalsByReason.set(reason, (refusalsByReason.get(reason) ?? 0) + 1);
  noteInstrumentFired("gateway:rpc-refusal", `${method} (${reason})`);
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
}
