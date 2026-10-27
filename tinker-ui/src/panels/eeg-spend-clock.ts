/**
 * FORK 2026-08-08 — the EEG spend clock (spec:
 * docs/superpowers/specs/2026-08-08-eeg-all-scope-spend-clock-design.md).
 *
 * WHAT THIS SOLVES. The EEG's vertical axis is euros, not time: a sample's length is its cost and
 * an idle hour advances nothing. That works for one session because rows can simply be stacked. It
 * does NOT compose: with several tabs, "All" scope drew each session on its OWN cumulative-euro
 * axis, so equal heights meant "each spent the same since its own start" — never "these happened
 * together". Several unrelated papers printed on top of each other.
 *
 * THE MODEL. Let every call accrue its euros linearly across its life, and let
 *
 *     S(t) = total euros spent by all in-scope sessions up to real time t
 *
 * Paper position IS S(t); a call occupies [S(start), S(end)]. Everything the instrument needs is
 * then derived rather than bolted on:
 *
 *   - nothing running  -> rate 0 -> S flat            (the paper stops, and resumes on the next task)
 *   - a call running alone -> S advances by exactly its euros -> its height IS its cost
 *   - calls overlapping -> each spans a taller interval, because real money was spent alongside
 *   - advance over any window == euros spent in that window -> the €1 grid can never lie
 *   - one shared monotone map from real time -> cross-tab alignment is exact, not approximate
 *
 * With one session and no concurrency this reproduces the old stacked rendering exactly; it is a
 * generalisation, not a replacement. `eeg-spend-clock.test.ts` pins that.
 *
 * THE CHOSEN TRADE-OFF (architect, 2026-08-08). "grid = total euros" and "strand length = its own
 * euros" cannot both survive concurrency. The grid won: a strand that ran beside others is drawn
 * TALLER than its own cost. The paper is the system's ledger, and money is the thing it must never
 * misreport.
 *
 * STATED ASSUMPTION. Euros accrue linearly within a call — we only learn the total at the end, so
 * any within-call distribution is a model. Linear keeps S piecewise-linear and exact at breakpoints.
 *
 * NO FLOORS HERE. `EEG_MIN_LEN` and friends are legibility concerns and belong to the renderer. The
 * clock is exact arithmetic, which is the only reason the conservation test can be exact.
 */

/** One billable call, reduced to what the clock needs. */
export interface EegClockSample {
  /** Stable identity (the run id). Ties at equal timestamps break on this, so it must be stable. */
  key: string;
  startedAt: number;
  /** Absent => still running; the clock substitutes `now`. */
  endedAt?: number;
  /** Estimated euro cost. Negative and non-finite values are clamped to 0. */
  euros: number;
}

/** Where one call sits on the paper, in EUROS (not pixels — the renderer scales). */
export interface EegClockSpan {
  key: string;
  /** Euros on the clock when this call started. */
  yStart: number;
  /** Euros on the clock when it ended. `yEnd - yStart` >= its own euros under concurrency. */
  yEnd: number;
}

export interface EegSpendClock {
  /** S at the last breakpoint — total euros across every sample handed in. */
  total: number;
  /** S(t) for any t, clamped to [0, total]. */
  yOf: (t: number) => number;
  /** Per-sample span, keyed by `EegClockSample.key`. */
  spans: Map<string, EegClockSpan>;
}

/** A call with no measurable duration accrues as a STEP rather than a rate. */
const INSTANT_EPSILON_MS = 1;

/**
 * How long a sample with NO `endedAt` may still be believed to be running.
 *
 * FORK 2026-08-08b — found by SCREENSHOTTING the live panel, not by reading code. Several
 * `eeg-main` strands (notably `announce:v1:…` runs, which never receive a final effort event and
 * so are never stamped) spanned ~7011px of a 7056px paper: 10px-wide bars painted over the entire
 * €78 ledger, burying every real strand under them.
 *
 * The cause is that this design made duration LOAD-BEARING. The old renderer stacked every sample
 * in its own slot, so a never-ended run drew one small block and nobody noticed the missing stamp.
 * Here, "no end" meant "still running", and a run left open days ago accrued across all of history.
 *
 * The principle: this clock models money accruing over a call's LIFE. If we do not know when a call
 * ended, we do not know the window its money accrued over — so spreading it across all of history
 * is a fabrication, not a conservative default. Past the grace period the euros are still counted
 * in full (conservation is untouched), but as a STEP at the start instant: the money is real, the
 * window is not.
 *
 * Inside the grace period a genuinely running call still grows against `now`, which is what keeps
 * the live leading edge honest.
 */
export const EEG_LIVE_GRACE_MS = 15 * 60_000;

function safeEuros(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Build the clock. `now` is injected rather than read from the environment so the function stays
 * pure and testable (and so a live sample renders identically for every caller in one repaint).
 */
export function buildEegSpendClock(samples: EegClockSample[], now: number): EegSpendClock {
  type Norm = { key: string; start: number; end: number; euros: number; step: boolean };

  // FINDING 7 (review 2026-10-01). COLLAPSE DUPLICATE KEYS FIRST, last write wins. `spans` is keyed
  // by run id, so a run handed in twice used to bill the ledger twice and draw once — the surviving
  // span twice as tall as the run's own cost. Later frames carry better data (a final frame brings
  // the end stamp and the token count a live frame could not), so the last one is the one to keep.
  // This lives in the clock rather than at a call site because the invariant the module promises
  // ("advance over any window == euros spent in that window") is the caller's to rely on, not to
  // re-establish.
  const byKey = new Map<string, EegClockSample>();
  for (const s of samples) byKey.set(s.key, s);

  const norm: Norm[] = [];
  for (const s of byKey.values()) {
    const euros = safeEuros(s.euros);
    const start = Number.isFinite(s.startedAt) ? s.startedAt : now;
    // A live sample runs to `now` — but only while it is still CREDIBLY live (see
    // EEG_LIVE_GRACE_MS). An unstamped run from days ago collapses to a step instead of accruing
    // across the whole ledger. A corrupt end before its start likewise collapses rather than
    // contributing a negative rate, which would make S non-monotone and the axis meaningless.
    const hasEnd = Number.isFinite(s.endedAt as number);
    const stillLive = now - start <= EEG_LIVE_GRACE_MS;
    const rawEnd = hasEnd ? (s.endedAt as number) : stillLive ? now : start;
    const end = Math.max(start, rawEnd);
    norm.push({ key: s.key, start, end, euros, step: end - start < INSTANT_EPSILON_MS });
  }

  if (norm.length === 0) {
    return { total: 0, yOf: () => 0, spans: new Map() };
  }

  // ── breakpoints: S is linear between consecutive event times ──
  const timeSet = new Set<number>();
  for (const n of norm) {
    timeSet.add(n.start);
    timeSet.add(n.end);
  }
  const times = [...timeSet].sort((a, b) => a - b);

  // Steps land AT their instant. Ordered by key so two steps at the same millisecond always stack
  // in the same order across repaints (no flicker).
  const stepsAt = new Map<number, Norm[]>();
  for (const n of norm) {
    if (!n.step) continue;
    const arr = stepsAt.get(n.start);
    if (arr) arr.push(n);
    else stepsAt.set(n.start, [n]);
  }
  for (const arr of stepsAt.values())
    arr.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Rate of every spanning sample, active over [start, end).
  const spanning = norm.filter((n) => !n.step);
  const rateOf = new Map<string, number>();
  for (const n of spanning) rateOf.set(n.key, n.euros / (n.end - n.start));

  // ── accumulate S at each breakpoint ──
  // `acc[i]` = S at times[i], INCLUDING every step at times[i].
  const acc: number[] = new Array(times.length);
  // `segRate[i]` = constant total rate on [times[i], times[i+1]).
  const segRate: number[] = new Array(Math.max(0, times.length - 1)).fill(0);

  // FINDING 9 (review 2026-10-01). This was `for each breakpoint { for each spanning sample }` —
  // clean N^2, measured 124ms / 425ms / 2009ms at 1k / 2k / 4k samples. EEG_PERSIST_CAP is 2000 and
  // the paper repaints on every effort frame, so a long session blocked the UI for ~0.4s per frame.
  //
  // Same arithmetic as a SWEEP. Every sample's start and end IS a breakpoint, and a spanning sample
  // is active on segment i exactly when idx(start) <= i < idx(end) — which is what the old pair of
  // inequalities tested, since the active set is constant between consecutive breakpoints. So add
  // +rate at its start index, -rate at its end index, then one prefix pass gives every segment's
  // total rate. O(N) after the sort the breakpoint list already pays for.
  const idxOf = new Map<number, number>();
  for (let i = 0; i < times.length; i++) idxOf.set(times[i], i);
  const rateDelta: number[] = new Array(times.length + 1).fill(0);
  for (const n of spanning) {
    const a = idxOf.get(n.start);
    const b = idxOf.get(n.end);
    if (a === undefined || b === undefined) continue;
    const rate = rateOf.get(n.key) ?? 0;
    rateDelta[a] += rate;
    rateDelta[b] -= rate;
  }
  let running = 0;
  for (let i = 0; i < times.length - 1; i++) {
    running += rateDelta[i];
    segRate[i] = running;
  }

  // Where each step sits, so a step's own span is exactly its euros.
  const stepSpan = new Map<string, { yStart: number; yEnd: number }>();

  let s = 0;
  for (let i = 0; i < times.length; i++) {
    if (i > 0) s += segRate[i - 1] * (times[i] - times[i - 1]);
    const steps = stepsAt.get(times[i]);
    if (steps) {
      for (const st of steps) {
        stepSpan.set(st.key, { yStart: s, yEnd: s + st.euros });
        s += st.euros;
      }
    }
    acc[i] = s;
  }
  const total = acc[acc.length - 1] ?? 0;

  // ── S(t) ──
  const yOf = (t: number): number => {
    if (!Number.isFinite(t)) return 0;
    // FINDING 10 (review 2026-10-01). The lower bound used to collapse `t <= times[0]` to 0, which
    // is right strictly BEFORE the ledger opens and wrong AT its first instant: `acc[0]` already
    // includes every step landing there, so a spanning sample that starts at times[0] must begin
    // from acc[0]. Returning 0 drew it over the step beneath it and 50% too tall — and since
    // backfilled history is all steps, a step at the session's first instant is the common case.
    if (t < times[0]) return 0;
    if (t === times[0]) return acc[0];
    if (t >= times[times.length - 1]) return total;
    // binary search for the segment containing t
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const val = acc[lo] + (segRate[lo] ?? 0) * (t - times[lo]);
    return Math.min(total, Math.max(0, val));
  };

  // ── per-sample spans ──
  const spans = new Map<string, EegClockSpan>();
  for (const n of norm) {
    const step = stepSpan.get(n.key);
    if (step) {
      spans.set(n.key, { key: n.key, yStart: step.yStart, yEnd: step.yEnd });
      continue;
    }
    spans.set(n.key, { key: n.key, yStart: yOf(n.start), yEnd: yOf(n.end) });
  }

  return { total, yOf, spans };
}
