import { emitAgentEvent, getAgentRunContext } from "../../../infra/agent-events.js";
import { log } from "../logger.js";

/** Stream name for one pre-model runner stage. Mirrored in `tinker-ui/src/turn-phase.ts`. */
export const TURN_STAGE_STREAM = "turn-stage";

/**
 * FORK 2026-08-23 — send each stage to the browser, not just to the journal.
 *
 * "preparing context" is the longest row in the architect's chat and it is a CLIENT-measured
 * bracket: everything from `chat.send` returning to a model being named. Its contents were
 * measurable (the twelve spans below) but only in the journal, so the row he actually watches
 * stayed a single opaque number while the breakdown existed on disk.
 *
 * The sessionKey is resolved from the run context rather than threaded through every call
 * site: `getAgentRunContext` is a lookup by id, and twelve extra parameters would be twelve
 * chances to pass the wrong one. Without BOTH ids the UI cannot decide which tab a stage
 * belongs to, and a mis-attributed stage is worse than a missing one — it would paint another
 * session's chat — so a stage with no resolvable session is dropped rather than broadcast.
 *
 * Strictly best-effort: telemetry must never be able to fail a turn.
 */
/**
 * FORK 2026-08-24 — the drop paths LOG; the success path does not.
 *
 * This function used to fail silently, three ways, while `[turn-span]` above it logged
 * unconditionally. That asymmetry cost two wrong diagnoses in one afternoon: a `[turn-span]` line
 * was read as proof the stage reached the browser, when it only proves the stage RAN. The two
 * guards below sit between those facts and nothing recorded crossing them.
 *
 * Deliberately NOT a log line per successful emit: that would double an already-per-stage log
 * volume to say "as expected". Silence is the success signal — a `[turn-span]` line with no
 * matching `[turn-stage] DROPPED` for the same runId+stage means it went out. That is falsifiable,
 * which is the property that was missing, and it costs zero lines on the happy path.
 */
export function emitStage(
  runId: string | undefined,
  stage: string,
  ms: number,
  /** The plugin that owns this stage, when a plugin emitted it — see `PLUGIN_OWNED` in the UI. */
  plugin?: string,
): void {
  try {
    if (!runId) {
      log.info(`[turn-stage] DROPPED stage=${stage} reason=no-runId`);
      return;
    }
    const sessionKey = getAgentRunContext(runId)?.sessionKey;
    if (!sessionKey) {
      log.info(`[turn-stage] DROPPED runId=${runId} stage=${stage} reason=no-sessionKey`);
      return;
    }
    emitAgentEvent({
      runId,
      sessionKey,
      stream: TURN_STAGE_STREAM,
      data: { stage, ms, ...(plugin ? { plugin } : {}) },
    });
  } catch (err) {
    // Still best-effort — telemetry must never fail a turn — but no longer INVISIBLE.
    log.info(
      `[turn-stage] DROPPED runId=${runId ?? "-"} stage=${stage} reason=threw ${String(err)}`,
    );
  }
}

/**
 * A span whose duration the CALLER measured.
 *
 * `turnSpan`/`turnSpanSync` need the work to be expressible as one callback. Some regions are not:
 * a prelude of ~30 interdependent `const` declarations cannot be wrapped without hoisting all of
 * them, and a refactor that large to answer a timing question is how instrumentation gets skipped
 * and the cost gets GUESSED instead. Measured, guessing has been wrong five times on this path.
 *
 * Same output shape as the two above so one parser reads all three, and deliberately no `gapMs`:
 * these regions nest inside a real span, so a gap here would be measured against a sibling and
 * would tile with nothing.
 */
export function markSpan(
  runId: string | undefined,
  stage: string,
  ms: number,
  plugin?: string,
): void {
  log.info(`[turn-span] runId=${runId ?? "-"} stage=${stage} ms=${ms}`);
  emitStage(runId, stage, ms, plugin);
}

/**
 * FORK 2026-08-22 — TURN SPANS: the instrument the latency work kept asking for.
 *
 * Between `chat.send` and the model being named there are ~15 consecutive awaited stages
 * in `attempt.ts` with no timing at all. Measured, that region is p50 ~5s of an ~11s wait
 * (and p50 99s over a 7-day window that includes saturated days) and NOT ONE SECOND of it
 * is attributable to anything. The two labels that bracket it — "choosing a model" and
 * "assembling the prompt" — both fire at the TOP of the runner, ~1,900 source lines before
 * the region ends, so the breadcrumb marks the entrance to the dark room and then stops.
 *
 * `TINKER_UI_DESIGN_BIBLE/turn-latency.md` §7.4 names this as the single change that would
 * have made three of that investigation's four biggest errors impossible.
 *
 * DELIBERATELY UNCONDITIONAL. There is no duration threshold here, and there must not be
 * one. The gateway's RPC log already drops everything under 50ms (`DEFAULT_WS_SLOW_MS`),
 * which is why no total call count exists for any method and why every `n=` in that optic
 * is a count of SLOW calls masquerading as a count of calls. A censored span log would
 * reproduce exactly that defect: you cannot tell "this stage is fast" from "this stage
 * never ran" if the fast case is not written down. ~15 lines per turn is not a volume
 * problem; an unfalsifiable measurement is.
 *
 * Emitted at INFO so it survives the default journal level. One line per stage:
 *
 *     [turn-span] runId=<id> stage=<name> ms=<n>
 */
/**
 * FORK 2026-08-23 — WHERE THE PREVIOUS SPAN ENDED, per run.
 *
 * Timing twelve individual awaits leaves the space BETWEEN them unmeasured, and measured, that
 * space is where the time is: within the instrumented region the spans account for p50 1.0s of a
 * p50 5.0s wall clock, so four seconds in five were falling through the instrument. The architect
 * read it off his own screen — "'not accounted for by any stage' holds over 95% of the time".
 *
 * Each span now also reports `gapMs`: the time since the PREVIOUS span for the same run finished.
 * That makes the segments TILE — every millisecond between the first span and the last is either
 * inside a span or inside a named gap after one — so a gap can never hide again. Zero new call
 * sites, which is why it is done this way rather than by bracketing regions by hand.
 *
 * Bounded by the cap below and nothing else. There is deliberately NO explicit "run finished"
 * cleanup: it would need a call site in the runner's teardown, and an exported cleanup with one
 * caller in a `finally` is precisely the shape that rots into never being called — this codebase
 * already carries a fully-implemented, fully-tested prompt-cache boundary whose every importer is
 * a test. A cap that cannot be forgotten beats a hook that can.
 */
const lastSpanEndByRun = new Map<string, number>();
const MAX_TRACKED_RUNS = 256;

function takeGapMs(runId: string | undefined, now: number): number | undefined {
  if (!runId) {
    return undefined;
  }
  const previous = lastSpanEndByRun.get(runId);
  if (lastSpanEndByRun.size > MAX_TRACKED_RUNS) {
    // Oldest-inserted first; a Map preserves insertion order.
    const oldest = lastSpanEndByRun.keys().next().value;
    if (oldest !== undefined) {
      lastSpanEndByRun.delete(oldest);
    }
  }
  lastSpanEndByRun.set(runId, now);
  return previous === undefined ? undefined : Math.max(0, now - previous);
}

export async function turnSpan<T>(
  runId: string | undefined,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    // `finally`, not a post-await line: a stage that THROWS or is aborted is exactly the
    // one worth timing, and recording only successes would bias the distribution toward
    // the cheap path.
    const endedAt = Date.now();
    const ms = endedAt - startedAt;
    // The gap is measured to this span's START, not its end: it is the time between the previous
    // span finishing and this one beginning, which is the interval that had no name.
    const gapMs = takeGapMs(runId, endedAt);
    const gapBefore = gapMs === undefined ? undefined : Math.max(0, gapMs - ms);
    log.info(
      `[turn-span] runId=${runId ?? "-"} stage=${stage} ms=${ms}` +
        (gapBefore === undefined ? "" : ` gapMs=${gapBefore}`),
    );
    // The gap is emitted as its own stage so the UI breakdown tiles: an unnamed interval is
    // exactly what "not accounted for by any stage" was made of.
    if (gapBefore !== undefined && gapBefore > 0) {
      emitStage(runId, `before:${stage}`, gapBefore);
    }
    emitStage(runId, stage, ms);
  }
}

/** Same contract for a synchronous stage (prompt assembly is not async but is not free). */
export function turnSpanSync<T>(runId: string | undefined, stage: string, fn: () => T): T {
  const startedAt = Date.now();
  try {
    return fn();
  } finally {
    const endedAt = Date.now();
    const ms = endedAt - startedAt;
    // The gap is measured to this span's START, not its end: it is the time between the previous
    // span finishing and this one beginning, which is the interval that had no name.
    const gapMs = takeGapMs(runId, endedAt);
    const gapBefore = gapMs === undefined ? undefined : Math.max(0, gapMs - ms);
    log.info(
      `[turn-span] runId=${runId ?? "-"} stage=${stage} ms=${ms}` +
        (gapBefore === undefined ? "" : ` gapMs=${gapBefore}`),
    );
    // The gap is emitted as its own stage so the UI breakdown tiles: an unnamed interval is
    // exactly what "not accounted for by any stage" was made of.
    if (gapBefore !== undefined && gapBefore > 0) {
      emitStage(runId, `before:${stage}`, gapBefore);
    }
    emitStage(runId, stage, ms);
  }
}
