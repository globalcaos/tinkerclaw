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
 */
import { isTranscriptOnlyModel } from "./transcript-only-models.js";

/** A model as the transcript and the run table name it. */
export type RailModel = { model: string; provider: string };

/** What a run's rail paints: a CSS colour, the logo's HTML, the hover text. */
export type ChatRail = { color: string; logoHtml: string; title: string };

export type RailLookups = {
  /** The model a run reported, by runId: the live run table, or what was remembered from it. */
  runModel: (runId: string) => RailModel | undefined;
  /** The viewed session's model, the last resort. */
  sessionModel: () => RailModel | undefined;
};

type Row = { role?: unknown; model?: unknown; provider?: unknown; _runId?: unknown };

const roleOf = (r: Row): string => (typeof r.role === "string" ? r.role.toLowerCase() : "");
const realModel = (m: unknown): m is string =>
  typeof m === "string" && m.length > 0 && !isTranscriptOnlyModel(m);

/**
 * Did a model answer in this run? An assistant row that is not the gateway's own injected notice.
 * A row with no model at all counts: a live bubble is built in the browser and names none.
 */
export function runHasAnswer(rows: readonly unknown[]): boolean {
  return rows.some((raw) => {
    const r = (raw ?? {}) as Row;
    return (
      roleOf(r) === "assistant" && !(typeof r.model === "string" && isTranscriptOnlyModel(r.model))
    );
  });
}

/**
 * Which model answered a run, newest evidence first:
 *   1. the newest assistant row that names a real model (every stored row does);
 *   2. the newest row whose `_runId` the run table knows (a live bubble names no model);
 *   3. the previous run's model (a reply that finished before any stored row replaced it);
 *   4. the viewed session's model.
 * Null when the run holds no answer (a prompt the gateway answered with its own notice).
 */
export function answeringModel(
  rows: readonly unknown[],
  lookups: RailLookups,
  prev: RailModel | null,
): RailModel | null {
  if (!runHasAnswer(rows)) {
    return null;
  }
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = (rows[k] ?? {}) as Row;
    if (roleOf(r) === "assistant" && realModel(r.model)) {
      return { model: r.model, provider: typeof r.provider === "string" ? r.provider : "" };
    }
  }
  for (let k = rows.length - 1; k >= 0; k--) {
    const id = ((rows[k] ?? {}) as Row)._runId;
    if (typeof id === "string" && id) {
      const known = lookups.runModel(id);
      if (known && realModel(known.model)) {
        return known;
      }
    }
  }
  if (prev) {
    return prev;
  }
  const session = lookups.sessionModel();
  return session && realModel(session.model) ? session : null;
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
 */
export function railSegmentHtml(html: string, rail: ChatRail): string {
  if (!html.trim()) {
    return html;
  }
  return `<div class="turn-seg" style="--rail:${safeRailColor(rail.color)}">${line(rail)}${html}</div>`;
}

/** The logo that opens (`start`) or closes (`end`) a run's rail, with the stub of line that meets it. */
export function railCapHtml(rail: ChatRail, end: "start" | "end"): string {
  return (
    `<div class="turn-rail-cap turn-rail-cap--${end}" style="--rail:${safeRailColor(rail.color)}">` +
    line(rail) +
    `<span class="turn-rail-logo" role="img" aria-label="${attr(rail.title)}" title="${attr(rail.title)}">${rail.logoHtml}</span>` +
    `</div>`
  );
}
