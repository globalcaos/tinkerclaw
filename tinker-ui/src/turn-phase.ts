// FORK 2026-08-13 (the architect) — "preparing context" is a GUESS; these helpers render the
// gateway's own account of the pre-turn gap.
//
// After `chat.send` resolves, the gateway spends a measured 21-36s assembling the turn
// (compaction gate → engram/total-recall retrieval → prompt build → model pick → spawn)
// before it emits any lifecycle event naming a model. The pending pill used to fill that
// whole silence with one static string. The gateway now narrates it over the existing
// agent-event bus as `stream:"turn-phase"` envelopes:
//
//   { runId, sessionKey, stream: "turn-phase", data: { phase, label } }
//     phase — "accepted" | "compaction" | "recall" | "prompt" | "model" | "spawn"
//     label — short lowercase human text, e.g. "recalling memories"
//
// THE ONE RULE THESE HELPERS ENFORCE: the pill may only ever say what the gateway
// actually sent. Nothing here derives a phase from elapsed time, and nothing invents a
// next step — a gateway that has not been rebuilt emits no turn-phase events at all, so
// `readTurnPhaseEvent` never fires, the stored state stays null and `pendingPillLabel`
// falls back to exactly today's text. That fallback is the compatibility contract with
// the un-rebuilt gateway, not a nicety.
//
// Pure (DOM-free, global-free), the queued-sends.ts precedent: app.ts is a browser entry
// and cannot be unit-tested, so the parse/gate/label decisions live here.

/** The literal `stream` value the gateway stamps on every phase envelope. */
export const TURN_PHASE_STREAM = "turn-phase";

/** The phases the gateway currently emits. Advisory: `readTurnPhaseEvent` accepts any
 *  non-empty phase string so a gateway that grows a seventh phase still paints, rather
 *  than silently falling back to the static text while the UI waits for a redeploy. */
export type TurnPhaseName = "accepted" | "compaction" | "recall" | "prompt" | "model" | "spawn";

/** The latest phase the gateway reported, plus WHOSE turn it was about. The sessionKey
 *  is retained (not just gated on at arrival) because the user can switch tabs mid-wait:
 *  a phase captured for tab A must not paint tab B's pill. */
export type TurnPhase = {
  phase: string;
  label: string;
  /** Wall-clock ms when the event arrived (client-side; the envelope carries no time). */
  at: number;
  sessionKey: string;
  /**
   * Wall time the stage actually held, MEASURED SERVER-SIDE and carried on the completion
   * event only (a start event has no `ms`). Present ⇒ this stage is finished.
   *
   * FORK 2026-08-15 — durations used to be derived client-side from the gap between two
   * arrival times, which quietly attributed network and event-loop latency to whichever stage
   * happened to be open. The gateway now measures around the work itself, because the point of
   * these numbers is to decide which stage to optimise.
   */
  ms?: number;
  /**
   * Per-plugin breakdown of `ms`, in the order the handlers ran. Completion events only.
   *
   * FORK 2026-08-22 — a phase label is NOT a stage. `before_prompt_build` runs EIGHT plugin
   * handlers sequentially and the row shows their sum, so "recalling memories — 12.7s" says
   * nothing about which of the eight spent it. Optimising one of them from 19.5s to ~1s barely
   * moved the row, and the aggregate was read as a component twice before anyone noticed.
   * Absent on an older gateway, which is why every consumer must treat it as optional.
   */
  plugins?: TurnPhasePluginTiming[];
};

/** One plugin's share of a narrated stage. Mirrors the gateway DTO exactly. */
export type TurnPhasePluginTiming = { id: string; ms: number };

/**
 * FORK 2026-08-23 — one RUNNER STAGE inside the client-measured "preparing context" window.
 *
 * Separate stream from `turn-phase` on purpose. A phase is a gateway HOOK CHAIN and drives the
 * pill; a stage is a single awaited step in the runner and drives only a breakdown row. Folding
 * them into one stream would have put twelve extra timing rows in the transcript and relabelled
 * the pill twelve times per turn.
 */
export const TURN_STAGE_STREAM = "turn-stage";

/** One runner stage. Mirrors `src/agents/embedded-agent-runner/run/turn-span.ts`. */
export type TurnStage = { stage: string; ms: number; sessionKey: string };

/**
 * Parse a `turn-stage` envelope, or null if unusable.
 *
 * Same validation posture as the plugin breakdown: a stage with a NaN duration is a WRONG
 * measurement, an absent stage is an honest gap, and the second is always preferable.
 */
export function readTurnStageEvent(
  payload: { sessionKey?: unknown; data?: unknown } | null | undefined,
): TurnStage | null {
  const sessionKey = asString(payload?.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const data = payload?.data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const stage = asString((data as { stage?: unknown }).stage).trim();
  const rawMs = (data as { ms?: unknown }).ms;
  if (!stage) {
    return null;
  }
  if (typeof rawMs !== "number" || !Number.isFinite(rawMs) || rawMs < 0) {
    return null;
  }
  return { stage, ms: rawMs, sessionKey };
}

/** Did this envelope report a FINISHED stage (as opposed to one starting)? */
export function isPhaseCompletion(p: TurnPhase | null | undefined): boolean {
  return typeof p?.ms === "number" && Number.isFinite(p.ms);
}

/** Matches two session keys, tolerant of short ("tinker:A") vs canonical
 *  ("agent:main:tinker:A") forms — pass app.ts `sessionKeyMatches` here. */
export type SessionKeyMatcher = (a: string | undefined, b: string | undefined) => boolean;

/** Longest label the pill will render. The pill is a single fixed-height row; a runaway
 *  string would push the elapsed counter and the Stop affordance off it. */
const MAX_LABEL_LEN = 48;

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Parse one `stream:"turn-phase"` envelope into the state the pill renders, or null if it
 * is not usable. Callers MUST have already gated on the session key (the fractal consumer
 * precedent) — `sessionKey` is captured here only so the render side can re-check it
 * against whatever tab is on screen when the pill actually paints.
 *
 * Normalization is cosmetic only: whitespace and trailing dots are trimmed because the
 * pill appends its own "…", and the label is clamped. When `label` is absent the raw
 * phase name is used — still the gateway's own word, never a synthesized one.
 */
export function readTurnPhaseEvent(
  payload: { sessionKey?: unknown; data?: unknown } | null | undefined,
  at: number,
): TurnPhase | null {
  const sessionKey = asString(payload?.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const data = (payload?.data ?? {}) as { phase?: unknown; label?: unknown };
  const phase = asString(data.phase).trim();
  if (!phase) {
    return null;
  }
  const raw = asString(data.label).trim().replace(/\.+$/, "").trim() || phase;
  const label = raw.length > MAX_LABEL_LEN ? `${raw.slice(0, MAX_LABEL_LEN - 1)}…` : raw;
  // `ms` is the server-measured duration and marks this as a COMPLETION. Absent (or junk) means
  // the stage just started, which is the older gateway's only shape — so an un-rebuilt gateway
  // still produces valid start events and simply never produces a timing row.
  const rawMs = (data as { ms?: unknown }).ms;
  const ms = typeof rawMs === "number" && Number.isFinite(rawMs) && rawMs >= 0 ? rawMs : undefined;
  if (ms === undefined) {
    return { phase, label, at, sessionKey };
  }
  const plugins = readPluginTimings((data as { plugins?: unknown }).plugins);
  return plugins
    ? { phase, label, at, sessionKey, ms, plugins }
    : { phase, label, at, sessionKey, ms };
}

/**
 * Parse the per-plugin breakdown, discarding anything malformed rather than rendering junk.
 *
 * Every field is re-validated because this arrives over the wire from a gateway that may be
 * older, newer, or mid-deploy. A row that shows a plugin with a NaN duration is worse than a
 * row that shows no breakdown at all: the first is a wrong measurement, the second is an
 * honest absence.
 */
function readPluginTimings(raw: unknown): TurnPhasePluginTiming[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const out: TurnPhasePluginTiming[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    const ms = (entry as { ms?: unknown }).ms;
    if (typeof id !== "string" || !id.trim()) {
      continue;
    }
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      continue;
    }
    out.push({ id: id.trim(), ms });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The label to paint for the tab currently on screen, or null if the stored phase belongs
 * to a different session (background tab) or nothing has arrived yet.
 */
export function turnPhaseLabelFor(
  state: TurnPhase | null | undefined,
  viewedKey: string | undefined,
  matches: SessionKeyMatcher,
): string | null {
  if (!state || !viewedKey) {
    return null;
  }
  return matches(state.sessionKey, viewedKey) ? state.label : null;
}

/**
 * The pending pill's text. Precedence, most-informative first:
 *   1. a phase the gateway actually reported for this session;
 *   2. "preparing context" — `chat.send` resolved, so the message IS on the gateway and
 *      the wait is prompt assembly (what the pill said before turn-phase existed, and
 *      what it keeps saying against an un-rebuilt gateway);
 *   3. "sending" — `chat.send` has not come back yet.
 */
export function pendingPillLabel(state: {
  preparing: boolean;
  phaseLabel?: string | null;
}): string {
  const phaseLabel = (state.phaseLabel ?? "").trim();
  if (phaseLabel) {
    return phaseLabel;
  }
  return state.preparing ? "preparing context" : "sending";
}

// ─── Itemised trail (FORK 2026-08-15, the architect: "itemized as much as possible") ───
//
// The single-label pill answers "what is it doing NOW". It cannot answer "where did the
// 30 seconds go", which is the question the architect actually has while he waits. So we
// keep the ORDER of phases and how long each one held, and render the finished ones as a
// breadcrumb behind the live one.
//
// Still the same one rule: every entry is a phase the gateway sent. Durations are derived
// from arrival times of real events (the gap between phase N and phase N+1), never from a
// model of what a stage "should" take. The last entry has no successor yet, so its
// duration is open-ended and rendered against the clock.

/** Hard cap on retained steps. A turn has ~6 phases; more than this means something is
 *  looping and we would rather truncate than grow an unbounded row. */
const MAX_TRAIL = 8;

/**
 * Append a phase to the trail. Consecutive duplicates of the SAME phase name collapse
 * (the gateway may re-announce a stage; the user should see one entry, not a stutter),
 * and a phase belonging to a different session resets the trail — that is a new turn.
 */
export function appendTurnPhase(trail: TurnPhase[], next: TurnPhase): TurnPhase[] {
  const last = trail[trail.length - 1];
  if (last && !sameSession(last.sessionKey, next.sessionKey)) {
    return [next];
  }
  // A stage reports twice — start, then completion with `ms` — under the SAME phase name. The
  // completion must REPLACE its start rather than be swallowed as a duplicate, which is what the
  // original dedupe did to it: with start/end pairs every completion was dropped and the trail
  // held only open-ended stages. Collapse still applies to a genuine re-announcement (two starts).
  if (last && last.phase === next.phase) {
    if (isPhaseCompletion(next) && !isPhaseCompletion(last)) {
      return [...trail.slice(0, -1), { ...next, at: last.at }];
    }
    return trail;
  }
  const out = [...trail, next];
  return out.length > MAX_TRAIL ? out.slice(out.length - MAX_TRAIL) : out;
}

/** Exact-match session compare, deliberately strict: the trail stores whatever key the
 *  envelope carried, and two envelopes in one turn always carry the same one. */
function sameSession(a: string, b: string): boolean {
  return a === b;
}

export type PhaseStep = {
  label: string;
  /** Seconds this step held. Open-ended for the live (last) step. */
  seconds: number;
  /**
   * Milliseconds this step held — the UNROUNDED value.
   *
   * FORK 2026-08-16 (the architect: "All the phase elapsed times should always show even though the time
   * is small or zero"). `seconds` is a rounded integer, so every sub-second stage collapsed to
   * `0` and rendered as "0s" — which reads as "did not happen" for the stages that are FAST,
   * i.e. exactly the ones a warm cache produces. The renderer formats from this instead.
   */
  ms: number;
  done: boolean;
};

/**
 * Turn the trail into rendered steps for the tab on screen. Returns [] when the trail
 * belongs to another tab or is empty, so the caller falls back to the static text.
 */
export function turnPhaseSteps(
  trail: TurnPhase[] | null | undefined,
  viewedKey: string | undefined,
  matches: SessionKeyMatcher,
  nowMs: number,
): PhaseStep[] {
  if (!trail || trail.length === 0 || !viewedKey) {
    return [];
  }
  if (!matches(trail[0].sessionKey, viewedKey)) {
    return [];
  }
  return trail.map((p, i) => {
    // A stage that reported its own duration is finished and self-timed; that number wins over
    // any arrival-gap arithmetic. Otherwise fall back to the gap (an older gateway sends only
    // starts), and treat a stage with a successor as finished.
    if (isPhaseCompletion(p)) {
      const ms = Math.max(0, p.ms as number);
      return {
        label: p.label,
        seconds: Math.round(ms / 1000),
        ms,
        done: true,
      };
    }
    const end = i + 1 < trail.length ? trail[i + 1].at : nowMs;
    const ms = Math.max(0, end - p.at);
    return {
      label: p.label,
      seconds: Math.round(ms / 1000),
      ms,
      done: i + 1 < trail.length,
    };
  });
}
