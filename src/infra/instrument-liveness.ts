// FORK 2026-07-28 (the architect: "implement the liveness invariant") — the INSTRUMENT LIVENESS
// REGISTRY. Single owner of the answer to one question: *is this thing actually on the
// traffic path, or does it merely exist?*
//
// WHY THIS EXISTS. In one week this deployment produced six independent components that were
// installed, enabled, registered, and doing NOTHING. Every structural check was green for all
// six; each was caught only when a human happened to read a number that could not be true:
//
//   1. headroom compression proxy — service enabled + running + referenced by the gateway env,
//      6 requests LIFETIME and 0 tokens saved, because the real traffic runs in a CLI
//      subprocess that strips the env var.
//   2. The CLI cache-telemetry producer (agents/cli-runner.ts) — correct per-call logic, bound
//      to a `cliBackend` that is not configured, so it has never fired once. Its own comment
//      claimed it served "the MAIN pipe".
//   3. The compaction-safeguard extension — fully implemented, entirely dead under the live
//      `compaction.mode = "engram"` config.
//   4. An EEG anatomy hook, orphaned. 5. An ORCA lease hook, inert. 6. An amygdala per-prompt
//      injection, inert.
//
// The common shape: "registered" was treated as "running". Registration is a STATIC property;
// being on the traffic path is a DYNAMIC one, and only the second is worth anything. J15 (RSC)
// states the general form — a gate scoped to each delta never proves the cumulative property.
//
// THE INVARIANT: every instrument that declares itself MUST fire, or it is broken.
// A declared instrument that has never fired is a defect, not a quiet success. This module
// makes that difference observable instead of invisible.
//
// DESIGN NOTES (each earned):
//  - Declaration and firing are SEPARATE calls, deliberately. Anything that infers liveness
//    from registration reproduces the exact bug this exists to catch.
//  - `expectFireWithinMs` lets an instrument say how long silence is legitimate, so a
//    genuinely rare instrument is not reported as broken every hour.
//  - `conditional` marks an instrument whose silence is EXPECTED under the current config
//    (e.g. the CLI cache producer when no cliBackend is configured). It is still tracked and
//    still reported, but under a heading that says "silent by configuration" rather than
//    "broken" — the distinction the six cases above all lacked.
//  - Nothing here throws into a serving path. Diagnostics must never disturb what they observe.
//
// FORK 2026-08-03 (the architect: "it works; nobody can read it") — THE ALARM'S OWN SIGNAL-TO-NOISE.
// Measured: `journalctl -u openclaw-gateway --since '7 days ago' | grep instrument-liveness` →
// 86,386 lines. The first reporter read `overdue` as a VERDICT and re-printed every silent
// instrument on every 60s maintenance tick, so a gateway with no traffic for 108 minutes emitted
// `prefrontal:effort-route — ...; silent for 6492s. Declared-but-silent is a DEFECT` — and the six
// instruments that have GENUINELY never fired were indistinguishable from that wallpaper. An alarm
// nobody can read is instance #8 of the shape this module exists to catch.
//  - NEVER-FIRED (zero firings, past its own tolerance) and IDLE (fired before, quiet on a quiet
//    process) are different states and must never share a sentence. `overdue` is now a raw timing
//    fact; `state` is the verdict, and only `state` may phrase an accusation.
//  - Silence accuses only when the process demonstrably kept working WITHOUT the instrument, and
//    that needs agreement on TWO axes — elapsed work past the instrument's own declared tolerance,
//    AND several distinct peers having fired since. Within one turn instruments fire milliseconds
//    apart, so "anything fired after me" would convict every instrument but the last one.
//  - The per-instrument list prints only when the SET CHANGES (or hourly). A list that reprints
//    unchanged 10,080 times a week is not an alarm, it is wallpaper.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { formatDurationHuman } from "./format-time/format-duration.js";

const log = createSubsystemLogger("infra/instrument-liveness");

export type InstrumentKind = "producer" | "gate" | "hook" | "extension" | "integration";

export interface InstrumentDeclaration {
  /** Stable id — it is grepped and it appears in reports. Do not rename casually. */
  id: string;
  kind: InstrumentKind;
  /** What it observes or does, in one line. */
  description: string;
  /**
   * How long silence is legitimate. Omit for "should fire on essentially every turn".
   * A rarely-exercised instrument should set this generously rather than be reported hourly.
   */
  expectFireWithinMs?: number;
  /**
   * Set when silence is a legitimate consequence of the CURRENT configuration (e.g. a producer
   * for a backend that is not configured). Explain WHY — the string is printed verbatim, and a
   * future reader deciding whether silence is a bug will have only this sentence to go on.
   */
  conditional?: string;
}

interface InstrumentRecord extends InstrumentDeclaration {
  /**
   * FIRST declaration in this process. It survives re-declaration on reload because
   * `Object.assign(existing, decl)` copies only declaration fields and `InstrumentDeclaration` has
   * no timestamp — so this is the honest denominator for "has never fired in N".
   */
  declaredAtMs: number;
  fireCount: number;
  lastFiredAtMs?: number;
  lastDetail?: string;
}

const REGISTRY_KEY = Symbol.for("openclaw.instrumentLiveness.registry");

/**
 * The registry lives on globalThis, NOT in a module-level `const`, because extensions are
 * bundled SEPARATELY: `dist/extensions/<id>/index.js` is self-contained and INLINES everything
 * it imports from `src/infra/`. A module-level Map therefore hands each such bundle its own
 * private registry, and `logInstrumentLivenessSummary` — running in the core bundle — never
 * reads it.
 *
 * That is not theoretical. Measured 2026-07-29 on the deploy of the first extension instrument:
 * `tinkerclaw-learned-intuition` loaded, its module-scope `declareInstrument` ran, and
 * `amygdala:nudge-write` was STILL absent from the report — the instrument was invisible rather
 * than merely silent. Invisible is strictly worse than silent: `neverFired` is a defect this
 * module reports, but an instrument in another Map produces no row at all, so the report reads
 * as "everything accounted for" while a component goes unobserved. That is this module's own
 * failure mode, reproduced inside the module itself.
 *
 * Resolved per call rather than once at module scope, matching `src/infra/agent-events.ts`
 * (`Symbol.for("openclaw.agentEvents.state")`), which shares state across the same bundle split
 * for the same reason. Per-call resolution is what makes it safe: a duplicated copy of this
 * helper still converges on the one globalThis slot.
 */
function registryMap(): Map<string, InstrumentRecord> {
  return resolveGlobalSingleton(REGISTRY_KEY, () => new Map<string, InstrumentRecord>());
}

/**
 * Declare an instrument at registration time. Declaring does NOT mean it works — that is the
 * whole point. Call this where the component is wired up.
 */
export function declareInstrument(decl: InstrumentDeclaration): void {
  try {
    const registry = registryMap();
    const existing = registry.get(decl.id);
    if (existing) {
      // Re-declaration (a second session, a reload) keeps the accumulated counters: losing them
      // on every reload would hide exactly the "never fires" case we are hunting.
      Object.assign(existing, decl);
      return;
    }
    registry.set(decl.id, { ...decl, declaredAtMs: Date.now(), fireCount: 0 });
  } catch {
    /* never disturb the path being instrumented */
  }
}

/**
 * Record that the instrument actually executed on real traffic. Call this at the point where
 * the work genuinely happens — NOT where it is registered, and not behind the same condition
 * that decides whether it is registered.
 */
export function noteInstrumentFired(id: string, detail?: string): void {
  try {
    const registry = registryMap();
    const rec = registry.get(id);
    if (!rec) {
      // Firing without declaring is itself a wiring bug worth surfacing, but it is not fatal.
      registry.set(id, {
        id,
        kind: "producer",
        description: "(fired without declaration)",
        declaredAtMs: Date.now(),
        fireCount: 1,
        lastFiredAtMs: Date.now(),
        lastDetail: detail,
      });
      return;
    }
    rec.fireCount += 1;
    rec.lastFiredAtMs = Date.now();
    if (detail !== undefined) {
      rec.lastDetail = detail;
    }
  } catch {
    /* never disturb the path being instrumented */
  }
}

/**
 * What the report is ALLOWED TO SAY about an instrument.
 *
 * The shipped reporter had two buckets — "broken" and "byConfig" — and dropped a merely-quiet
 * instrument into the first. These six exist so the word DEFECT is spent only where it is earned.
 */
export type InstrumentLivenessState =
  /** Fired inside its own tolerance. Nothing to say. */
  | "live"
  /** Declared, not yet fired, still inside its tolerance — the boot window, not a defect. */
  | "pending"
  /** Declared, past its own tolerance, ZERO firings ever. The defect this module exists to catch. */
  | "never"
  /** Fired before, quiet since — and so was the rest of the process. Expected silence. */
  | "idle"
  /** Fired before, quiet while the process kept working. SUSPECT, not proven. */
  | "stale"
  /** Silent, and its own declaration explains why. Reported apart from defects, always. */
  | "byConfig";

export interface InstrumentLivenessRow {
  id: string;
  kind: InstrumentKind;
  description: string;
  fireCount: number;
  silentMs: number;
  /** true when this instrument has NEVER fired since it was declared. */
  neverFired: boolean;
  /**
   * true when silence has exceeded the instrument's own tolerance. A RAW TIMING FACT, not a
   * verdict — reading it as one is what produced 86,386 journal lines. Read `state` to decide.
   */
  overdue: boolean;
  /** The verdict, and the only field the log may phrase an accusation from. */
  state: InstrumentLivenessState;
  /** First declaration in this process — the denominator for "never fired in N". */
  declaredAtMs: number;
  /** Last firing, or undefined when it has never fired. */
  lastFiredAtMs?: number;
  /** The tolerance actually applied, so the report can QUOTE it instead of implying one. */
  toleranceMs: number;
  /**
   * How long the REST of the process kept firing after this instrument last fired (newest firing
   * anywhere − this one's). 0 means the whole process went quiet along with it.
   */
  quietWhileBusyMs: number;
  /** How many OTHER instruments have fired more recently than this one. */
  peersFiredSince: number;
  conditional?: string;
  lastDetail?: string;
}

/** Default tolerance: an instrument silent for 30 minutes on a live gateway is suspicious. */
export const DEFAULT_EXPECT_FIRE_WITHIN_MS = 30 * 60 * 1000;

/**
 * How many DISTINCT other instruments must have fired more recently before a quiet instrument is
 * called `stale` rather than `idle`.
 *
 * Relevance is not knowable from this registry — a cron timer waking up is not evidence that
 * `prefrontal:effort-route` should have run — so `stale` requires agreement on two independent
 * axes: elapsed process work (> this instrument's OWN tolerance, which is self-calibrating and
 * needs no magic number) AND breadth. Either axis alone mislabels: instruments fire milliseconds
 * apart within a single turn, so "anything fired after me" convicts every instrument but the last
 * one on an idle box, which is the original bug restored; and a single chatty producer firing
 * hundreds of times is one component working, not the fleet.
 */
export const STALE_MIN_PEERS = 3;

/**
 * Past this multiple of its own tolerance a never-fired instrument stops being late and starts
 * being dead code, and the sentence says so instead of repeating "verify it".
 */
export const NEVER_FIRED_DEAD_MULTIPLE = 8;

/**
 * How often an UNCHANGED report may repeat its per-instrument lines. The one-line summary still
 * goes out every tick; only the enumeration is throttled.
 */
export const DEFAULT_ENUMERATE_INTERVAL_MS = 60 * 60 * 1000;

function classifyLiveness(
  row: Pick<
    InstrumentLivenessRow,
    | "neverFired"
    | "overdue"
    | "conditional"
    | "toleranceMs"
    | "quietWhileBusyMs"
    | "peersFiredSince"
  >,
  staleMinPeers: number,
): InstrumentLivenessState {
  if (!row.overdue) {
    // Inside its own tolerance. A never-fired instrument here is BOOTING, not broken — without
    // this case every gateway restart warns about all ~20 instruments before the first turn.
    return row.neverFired ? "pending" : "live";
  }
  if (row.conditional) {
    return "byConfig";
  }
  if (row.neverFired) {
    return "never";
  }
  return row.quietWhileBusyMs > row.toleranceMs && row.peersFiredSince >= staleMinPeers
    ? "stale"
    : "idle";
}

export function reportInstrumentLiveness(
  nowMs: number = Date.now(),
  opts: { staleMinPeers?: number } = {},
): InstrumentLivenessRow[] {
  const staleMinPeers = opts.staleMinPeers ?? STALE_MIN_PEERS;
  const records = [...registryMap().values()];

  // The process-level activity clock, DERIVED from the records rather than kept in a counter of
  // its own. Two reasons, both earned here: a separately-bundled copy of `noteInstrumentFired`
  // writes `lastFiredAtMs` into the SHARED record but would never find a private counter — the
  // same bundle split that made `amygdala:nudge-write` invisible in 2026-07 — and deriving it at
  // read time leaves the write path untouched, which is the standing rule for this whole file.
  const fireTimes: number[] = [];
  for (const rec of records) {
    if (typeof rec.lastFiredAtMs === "number") {
      fireTimes.push(rec.lastFiredAtMs);
    }
  }
  const processLastFireAtMs = fireTimes.length > 0 ? Math.max(...fireTimes) : 0;

  const rows: InstrumentLivenessRow[] = [];
  for (const rec of records) {
    // `?? nowMs` covers a record written by an older separately-bundled copy: a missing stamp must
    // read as "declared just now", never as NaN.
    const declaredAtMs = rec.declaredAtMs ?? nowMs;
    const since = rec.lastFiredAtMs ?? declaredAtMs;
    const silentMs = Math.max(0, nowMs - since);
    const toleranceMs = rec.expectFireWithinMs ?? DEFAULT_EXPECT_FIRE_WITHIN_MS;
    const base: Omit<InstrumentLivenessRow, "state"> = {
      id: rec.id,
      kind: rec.kind,
      description: rec.description,
      fireCount: rec.fireCount,
      silentMs,
      neverFired: rec.fireCount === 0,
      overdue: silentMs > toleranceMs,
      declaredAtMs,
      lastFiredAtMs: rec.lastFiredAtMs,
      toleranceMs,
      quietWhileBusyMs: Math.max(0, processLastFireAtMs - since),
      // Strict `>` excludes this instrument's own stamp, so these really are PEERS.
      peersFiredSince: fireTimes.filter((t) => t > since).length,
      conditional: rec.conditional,
      lastDetail: rec.lastDetail,
    };
    rows.push({ ...base, state: classifyLiveness(base, staleMinPeers) });
  }
  return rows.sort(
    (a, b) => Number(b.neverFired) - Number(a.neverFired) || b.silentMs - a.silentMs,
  );
}

/** Level dispatch as data, so the emit path below reads as policy rather than as branching. */
const LOG_SINK: Record<"warn" | "info" | "debug", (message: string) => void> = {
  warn: (message) => log.warn(message),
  info: (message) => log.info(message),
  debug: (message) => log.debug(message),
};

/**
 * Everything the reporter must remember BETWEEN ticks. Module-level rather than on globalThis, and
 * deliberately unlike the registry: only the core bundle's maintenance tick calls the summary, so a
 * second bundle owning its own throttle would merely log its own report — harmless, whereas a
 * second REGISTRY hides instruments outright, which is why that one had to be global.
 */
const reporter = {
  /** The reported+byConfig set as last enumerated. A change is news; a clock tick is not. */
  lastSignature: null as string | null,
  lastEnumeratedAtMs: 0,
  /** Σ fireCount at the previous report; -1 before the first one, so it is never called idle. */
  lastProcessFires: -1,
  /** The idle process gets ONE sentence, not one per minute forever. */
  idleAnnounced: false,
};

export interface InstrumentLivenessLogOutcome {
  counts: {
    declared: number;
    live: number;
    pending: number;
    never: number;
    stale: number;
    idle: number;
    byConfig: number;
  };
  /** Nothing anywhere in the process fired since the previous report. */
  processIdle: boolean;
  /** Declared, past its own tolerance, never fired once. Always a defect. */
  defects: string[];
  /** Quiet while the process kept working. SUSPECT — relevance is not knowable here. */
  suspects: string[];
  /** Silent with a declared reason. Listed apart from defects, never inside them. */
  byConfig: string[];
  /** Quiet because the process was quiet. Counted, never accused. */
  idle: string[];
  /** true when this call printed the per-instrument lines. */
  enumerated: boolean;
  /** Exactly the lines handed to the logger, in order. Assert on these, not on a logger mock. */
  lines: string[];
}

/**
 * Escalating clarity for the one state that always IS a defect. Six instruments on this deployment
 * have never fired since declaration; they must read differently from one that is two minutes late.
 */
function describeNeverFired(row: InstrumentLivenessRow): string {
  const age = formatDurationHuman(row.silentMs);
  if (row.silentMs >= NEVER_FIRED_DEAD_MULTIPLE * row.toleranceMs) {
    const multiple = Math.floor(row.silentMs / Math.max(1, row.toleranceMs));
    return (
      `[instrument-liveness] ${row.id} — ${row.description}; has NEVER fired in the ${age} since ` +
      `it was declared — ${multiple}× its own tolerance. Treat it as DEAD CODE, not slow: it is ` +
      `registered but not on the traffic path. Put it there, or declare why it cannot fire.`
    );
  }
  return (
    `[instrument-liveness] ${row.id} — ${row.description}; has NEVER fired in the ${age} since it ` +
    `was declared (tolerance ${formatDurationHuman(row.toleranceMs)}). DEFECT: registration is ` +
    `not liveness — verify it is on the traffic path, not merely registered.`
  );
}

function describeStale(row: InstrumentLivenessRow): string {
  return (
    `[instrument-liveness] ${row.id} — ${row.description}; last fired ` +
    `${formatDurationHuman(row.silentMs)} ago, while ${row.peersFiredSince} other instrument(s) ` +
    `kept firing for ${formatDurationHuman(row.quietWhileBusyMs)} after it. SUSPECT, not proven: ` +
    `this registry cannot know whether that work was relevant to this instrument. Worth one look.`
  );
}

function describeByConfig(row: InstrumentLivenessRow): string {
  return (
    `[instrument-liveness] ${row.id} — ${row.description}; silent BY CONFIGURATION, not broken: ` +
    `${row.conditional}`
  );
}

/**
 * Emit ONE counts-by-state line per tick, and enumerate individual instruments only when the
 * picture actually changed.
 *
 * FORK 2026-08-03 — WHY THIS IS NOT THE OBVIOUS "warn on everything silent". The obvious version
 * shipped first and produced 86,386 journal lines in seven days: it re-printed every
 * declared-but-silent instrument once a minute forever, and it called an instrument on an idle
 * gateway a DEFECT. Both halves destroyed the alarm — the volume made it unreadable, and the false
 * accusations made the six genuinely-never-fired instruments indistinguishable from routine quiet.
 * design-principles.md #20 named this in advance: honest silences printed like defects train every
 * reader to ignore the alarm.
 *
 * The rules now:
 *  - `never` is always reportable. `pending` (boot window) and `idle` are never enumerated.
 *  - `stale` is reported as SUSPECT, never as proven; relevance of other traffic is not knowable.
 *  - On an idle process even `stale` is demoted — nothing fired, so nothing shows this one should
 *    have. The process says it is idle ONCE and enumerates nothing.
 *  - Per-instrument lines print only when the defect SET changes, or once per interval (1h).
 *  - `byConfig` prints its reason as a sentence, at INFO, after and apart from the defects.
 *  - When the set empties, it SAYS so: an alarm that never clears cannot be told from a muted one.
 *
 * Returns what it decided, and the exact lines it emitted, so a test asserts on the decision and
 * on the wording without mocking the logging subsystem.
 */
export function logInstrumentLivenessSummary(
  nowMs: number = Date.now(),
  opts: { enumerateIntervalMs?: number; staleMinPeers?: number } = {},
): InstrumentLivenessLogOutcome {
  const nothing: InstrumentLivenessLogOutcome = {
    counts: { declared: 0, live: 0, pending: 0, never: 0, stale: 0, idle: 0, byConfig: 0 },
    processIdle: false,
    defects: [],
    suspects: [],
    byConfig: [],
    idle: [],
    enumerated: false,
    lines: [],
  };
  try {
    const rows = reportInstrumentLiveness(nowMs, { staleMinPeers: opts.staleMinPeers });
    if (rows.length === 0) {
      return nothing;
    }
    const enumerateIntervalMs = opts.enumerateIntervalMs ?? DEFAULT_ENUMERATE_INTERVAL_MS;

    // Process activity SUMMED from the records, for the same bundle-split reason as the clock in
    // reportInstrumentLiveness. An unchanged total means literally nothing fired anywhere since the
    // previous report, so every quiet instrument is quiet for the boring reason.
    const processFires = rows.reduce((sum, r) => sum + r.fireCount, 0);
    const processIdle =
      reporter.lastProcessFires >= 0 && processFires === reporter.lastProcessFires;
    reporter.lastProcessFires = processFires;

    const inState = (s: InstrumentLivenessState) => rows.filter((r) => r.state === s);
    const defects: InstrumentLivenessRow[] = inState("never");
    const suspects: InstrumentLivenessRow[] = processIdle ? [] : inState("stale");
    const byConfig: InstrumentLivenessRow[] = inState("byConfig");
    const idle: InstrumentLivenessRow[] = processIdle
      ? [...inState("idle"), ...inState("stale")]
      : inState("idle");
    const reported = [...defects, ...suspects];

    const counts = {
      declared: rows.length,
      live: inState("live").length,
      pending: inState("pending").length,
      never: defects.length,
      stale: suspects.length,
      idle: idle.length,
      byConfig: byConfig.length,
    };

    // What a reader would actually LEARN from the enumeration. Unchanged signature ⇒ reprinting
    // teaches nothing, so it is not reprinted.
    const signature = [...reported, ...byConfig]
      .map((r) => `${r.state}:${r.id}`)
      .toSorted()
      .join(",");
    const changed = signature !== reporter.lastSignature;
    const dueForReassertion = nowMs - reporter.lastEnumeratedAtMs >= enumerateIntervalMs;
    const enumerate = signature.length > 0 && (changed || dueForReassertion);

    const lines: string[] = [];
    const emit = (level: "warn" | "info" | "debug", line: string) => {
      lines.push(line);
      LOG_SINK[level](line);
    };

    const head =
      `[instrument-liveness] declared=${counts.declared} live=${counts.live} ` +
      `pending=${counts.pending} never=${counts.never} stale=${counts.stale} ` +
      `idle=${counts.idle} byConfig=${counts.byConfig}${processIdle ? " process=IDLE" : ""}`;
    // WARN only when there is something new to accuse. The once-a-minute heartbeat of an unchanged
    // fleet is DEBUG, and that single level choice is most of the 86,386 → ~170 lines/week collapse.
    emit(enumerate && reported.length > 0 ? "warn" : "debug", head);

    if (processIdle && idle.length > 0 && !reporter.idleAnnounced) {
      emit(
        "debug",
        `[instrument-liveness] nothing fired anywhere in this process since the last report — the ` +
          `process is IDLE and silence is expected. ${counts.idle} quiet instrument(s) are NOT ` +
          `being enumerated; they become suspects only if work resumes without them.`,
      );
      reporter.idleAnnounced = true;
    }
    if (!processIdle) {
      reporter.idleAnnounced = false;
    }

    if (enumerate) {
      for (const row of defects) {
        emit("warn", describeNeverFired(row));
      }
      for (const row of suspects) {
        emit("warn", describeStale(row));
      }
      for (const row of byConfig) {
        // The reason as a sentence, verbatim — design-principles #20 — at INFO and after the
        // defects, so an honest silence can never be mistaken for a broken one.
        emit("info", describeByConfig(row));
      }
      reporter.lastEnumeratedAtMs = nowMs;
    } else if (signature.length === 0 && reporter.lastSignature) {
      emit(
        "info",
        "[instrument-liveness] every previously-reported instrument is accounted for again.",
      );
    }
    reporter.lastSignature = signature;

    return {
      counts,
      processIdle,
      defects: defects.map((r) => r.id),
      suspects: suspects.map((r) => r.id),
      byConfig: byConfig.map((r) => r.id),
      idle: idle.map((r) => r.id),
      enumerated: enumerate,
      lines,
    };
  } catch {
    /* diagnostics must never disturb the path they observe */
    return nothing;
  }
}

/** Test-only: drop all state — the registry AND the reporter's memory of what it already said. */
export function resetInstrumentLivenessForTest(): void {
  registryMap().clear();
  reporter.lastSignature = null;
  reporter.lastEnumeratedAtMs = 0;
  reporter.lastProcessFires = -1;
  reporter.idleAnnounced = false;
}
