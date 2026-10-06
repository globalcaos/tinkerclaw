/**
 * FORK 2026-10-01 (the architect: "When an LLM is answering one of my prompts, I would like a vertical line
 * to show at the left of all its thinking, tool calls and responses. The line should start and end
 * with the logo of the model's company, and have its line with the same color as its EEG trace, and
 * show precisely on hover the model's full name. No line should be visible on the left of any
 * prompt.")
 *
 * THE RAIL IS DRAWN PER UNIT, never around a run. A wrapper around a whole run would make the run
 * one keyed unit, and every streaming delta would re-parse every row of it (chat-render.ts). So each
 * unit of the run is wrapped in a `.turn-seg` that draws its own stretch of the line, reaching into
 * the `.messages` gap above and below so the stretches meet, and the two logos are units of their
 * own, one before the run and one after it. No unit's markup depends on what comes after it, so a
 * new row re-parses nothing but itself.
 *
 * Pure: what only app.ts knows (the live run table, the session row) is injected.
 *
 * FORK 2026-10-05 (the architect: "the tinker UI first assigns the last model used and, when and if the
 * model Thalamus choses to use is different, then the whole line changes, pretending nothing
 * happened. It would be better to just not show anything next to 'TURN TIMING' and instead wait
 * until we know for sure the model that needs to be used, then display all the thinking and model
 * indicators synchronized, without going back.")
 *
 * THE TURN IN FLIGHT SHOWS ONLY THE MODEL IT HAS NAMED. The TURN TIMING block is written seconds
 * before any model is chosen, and it counted as an answer, so the resolver fell through to the
 * previous run's model and painted it; the first live bubble then repainted the line in the model
 * Thalamus had actually picked. A guess (the previous run, the session row, which keeps the
 * previous run's model until the gateway persists the new one at run end) is now allowed only for
 * a settled run a model visibly wrote into. The run in flight takes the model the thinking
 * indicator names (`namedModel`, from the run table), and until there is one its rail is
 * `PENDING_RAIL`: the same room, nothing painted, so nothing moves when the colour arrives.
 */
import { isTranscriptOnlyModel } from "./transcript-only-models.js";

/** A model as the transcript and the run table name it. */
export type RailModel = { model: string; provider: string };

/** What a run's rail paints: a CSS colour, the logo's HTML, the hover text. */
export type ChatRail = { color: string; logoHtml: string; title: string; pending?: boolean };

/** The rail of a turn whose model is not known yet: its room is kept, nothing in it is painted. */
export const PENDING_RAIL: ChatRail = { color: "", logoHtml: "", title: "", pending: true };

export type RailLookups = {
  /** The model a run reported, by runId: the live run table, or what was remembered from it. */
  runModel: (runId: string) => RailModel | undefined;
  /** The viewed session's model, the last resort. */
  sessionModel: () => RailModel | undefined;
};

type Row = {
  role?: unknown;
  model?: unknown;
  provider?: unknown;
  _runId?: unknown;
  _isPhaseTiming?: unknown;
  _phaseRunId?: unknown;
};

const roleOf = (r: Row): string => (typeof r.role === "string" ? r.role.toLowerCase() : "");
const realModel = (m: unknown): m is string =>
  typeof m === "string" && m.length > 0 && !isTranscriptOnlyModel(m);

/**
 * Did a model answer in this run? An assistant row that is not the gateway's own injected notice
 * and not the TURN TIMING block (chrome the browser writes about the turn before any model runs).
 * A row with no model at all counts: a live bubble is built in the browser and names none.
 */
export function runHasAnswer(rows: readonly unknown[]): boolean {
  return rows.some((raw) => {
    const r = (raw ?? {}) as Row;
    return (
      roleOf(r) === "assistant" &&
      r._isPhaseTiming !== true &&
      !(typeof r.model === "string" && isTranscriptOnlyModel(r.model))
    );
  });
}

/** The model a run has NAMED for itself (its run-table entry), or null: never an empty or injected id. */
export function namedModel(
  run: { model?: string; provider?: string } | undefined,
): RailModel | null {
  return run && realModel(run.model) ? { model: run.model, provider: run.provider ?? "" } : null;
}

/** Steps 1 and 2 of `answeringModel`: what the run's own rows prove, or null. */
function modelTheRunNamed(rows: readonly unknown[], lookups: RailLookups): RailModel | null {
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = (rows[k] ?? {}) as Row;
    if (roleOf(r) === "assistant" && r._isPhaseTiming !== true && realModel(r.model)) {
      return { model: r.model, provider: typeof r.provider === "string" ? r.provider : "" };
    }
  }
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = (rows[k] ?? {}) as Row;
    // A TURN TIMING block names the run it times (`_phaseRunId`); a live bubble its own `_runId`.
    const id = r._isPhaseTiming === true ? r._phaseRunId : r._runId;
    if (typeof id === "string" && id) {
      const known = lookups.runModel(id);
      if (known && realModel(known.model)) {
        return known;
      }
    }
  }
  return null;
}

/**
 * Which model answered a SETTLED run, newest evidence first:
 *   1. the newest assistant row that names a real model (every stored row does);
 *   2. the newest row whose run the run table knows (a live bubble's `_runId`, the TURN TIMING
 *      block's `_phaseRunId`; neither names a model of its own);
 *   3. the previous run's model (a reply that finished before any stored row replaced it);
 *   4. the viewed session's model.
 * Steps 3 and 4 are guesses, taken only for a run a model wrote into (`runHasAnswer`). Null when it
 * holds no answer: a prompt the gateway answered with its own notice, or a block and nothing else.
 * The run in flight never comes here; `runRailState` answers for it.
 */
export function answeringModel(
  rows: readonly unknown[],
  lookups: RailLookups,
  prev: RailModel | null,
): RailModel | null {
  const named = modelTheRunNamed(rows, lookups);
  if (named) {
    return named;
  }
  if (!runHasAnswer(rows)) {
    return null;
  }
  if (prev) {
    return prev;
  }
  const session = lookups.sessionModel();
  return session && realModel(session.model) ? session : null;
}

/** A run's rail: painted in a model, kept unpainted while its turn has named none, or none at all. */
export type RunRailState = { kind: "model"; model: RailModel } | { kind: "pending" } | null;

/**
 * The rail a run gets. `inFlight` is set for the turn still running (its model as the thinking
 * indicator names it, null until the turn has named one) and is null for a settled run.
 *
 * In flight, the indicator's model is the only answer: the pill and the line switch on the same
 * event (lifecycle `phase:start`, an effort event, or the pinned model the send itself requested),
 * so they cannot disagree and neither repaints. A settled run resolves through `answeringModel`.
 */
export function runRailState(
  rows: readonly unknown[],
  lookups: RailLookups,
  prev: RailModel | null,
  inFlight: { model: RailModel | null } | null,
): RunRailState {
  if (inFlight) {
    return inFlight.model ? { kind: "model", model: inFlight.model } : { kind: "pending" };
  }
  const model = answeringModel(rows, lookups, prev);
  return model ? { kind: "model", model } : null;
}

/** The hover text: the friendly label, then the full provider/model id it stands for. */
export function railTitle(m: RailModel, label: string): string {
  const full = m.provider ? `${m.provider}/${m.model}` : m.model;
  return label && label !== m.model && label !== full ? `${label} — ${full}` : full;
}

const ATTR: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const attr = (s: string): string => s.replace(/[&<>"']/g, (c) => ATTR[c] ?? c);

/** Only a colour may reach the style attribute: a hex, an rgb()/hsl() call, or a plain name. */
export function safeRailColor(c: string): string {
  return /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-zA-Z]+)$/.test(c)
    ? c
    : "var(--muted)";
}

/** The line itself: a 10px-wide hover target whose centre 2px are painted (base.css). */
function line(rail: ChatRail): string {
  return `<span class="turn-rail-line" title="${attr(rail.title)}" aria-hidden="true"></span>`;
}

/**
 * Wrap one unit of the run in its stretch of the rail. An empty unit stays empty: a wrapper around
 * nothing would still be a flex item, and add a gap to the column.
 *
 * A pending rail is the same box with nothing in it: no colour, no line, no name. The unit sits
 * exactly where it will sit once the model is known, so the colour arriving moves nothing.
 */
export function railSegmentHtml(html: string, rail: ChatRail): string {
  if (!html.trim()) {
    return html;
  }
  if (rail.pending) {
    return `<div class="turn-seg is-pending">${html}</div>`;
  }
  return `<div class="turn-seg" style="--rail:${safeRailColor(rail.color)}">${line(rail)}${html}</div>`;
}

/** The logo that opens (`start`) or closes (`end`) a run's rail, with the stub of line that meets it. */
export function railCapHtml(rail: ChatRail, end: "start" | "end"): string {
  if (rail.pending) {
    // The cap's 18px row is kept, empty, for the logo that comes with the model.
    return `<div class="turn-rail-cap turn-rail-cap--${end} is-pending" aria-hidden="true"></div>`;
  }
  return (
    `<div class="turn-rail-cap turn-rail-cap--${end}" style="--rail:${safeRailColor(rail.color)}">` +
    line(rail) +
    `<span class="turn-rail-logo" role="img" aria-label="${attr(rail.title)}" title="${attr(rail.title)}">${rail.logoHtml}</span>` +
    `</div>`
  );
}
