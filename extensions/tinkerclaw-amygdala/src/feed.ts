/**
 * What `amygdala2.feed` returns beyond the raw decisions (design doc §9): the events a reload needs to redraw the Jev
 * windows and cards, the panel's Learning and Questions data. Pure over the store and the question book. Names of
 * questions are shown, never their wording (U9).
 */
import { existsSync } from "node:fs";
import { sep } from "node:path";
import {
  buildDecisionEvents,
  buildInterventionEvent,
  parseDrivers,
  type DecisionEvent,
  type InterventionEvent,
} from "./events.js";
import type { Proposal } from "./learn/types.js";
import type { QuestionBook } from "./question-book.js";
import type { AmygdalaStore } from "./store.js";
import { FAMILY_PAPER, type Change, type Cutoff, type FamilyId, type Situation } from "./types.js";

/** A cut-off as short text for the panel ("≥ 2", "p ≥ 0.6", "not same ≥ 0.6", "never"). */
export function cutoffText(c: unknown): string {
  if (typeof c === "string") return c;
  if (!c || typeof c !== "object") return "—";
  const k = c as Cutoff;
  switch (k.kind) {
    case "prob":
      return `p ≥ ${k.at}`;
    case "level":
      return k.atOrAbove !== undefined ? `≥ ${k.atOrAbove}` : `≤ ${k.atOrBelow}`;
    case "choice":
      return `${k.negate ? "not " : ""}${k.option} ≥ ${k.at}`;
    case "none":
      return "never";
    default:
      return "—";
  }
}

export interface ChangeViewOut {
  id: string;
  kind: Change["kind"];
  questionName: string;
  from: string;
  to: string;
  exceptional: boolean;
  status: Change["status"];
  replaySummary: {
    cases: number;
    relaxed: number;
    tightened: number;
    mustCatchLost: number;
    controlsNewlyHeld: number;
  };
  ts: number;
}

interface Stored {
  proposal?: Proposal;
  previousCutoff?: Cutoff | null;
}

export function changeView(c: Change, book: QuestionBook): ChangeViewOut {
  const st = c.replay as unknown as Stored;
  const p = st.proposal;
  const q = (v: number) => book.get(c.questionId, v)?.cutoff;
  const context = p?.kind === "cutoff" && p.scope === "context";
  const from = context ? (st.previousCutoff ?? q(c.fromVersion)) : q(c.fromVersion);
  const to = p?.kind === "cutoff" ? p.cutoff : c.toVersion !== null ? `v${c.toVersion}` : null;
  return {
    id: c.id,
    kind: c.kind,
    questionName: book.get(c.questionId)?.name ?? c.questionId,
    from: cutoffText(from),
    to: cutoffText(to),
    exceptional: c.exceptional,
    status: c.status,
    replaySummary: {
      cases: c.replay.cases,
      relaxed: c.replay.relaxed,
      tightened: c.replay.tightened,
      mustCatchLost: c.replay.mustCatchLost,
      controlsNewlyHeld: c.replay.controlsNewlyHeld ?? 0,
    },
    ts: c.ts,
  };
}

export interface QuestionRowOut {
  id: string;
  name: string;
  version: number;
  today: number;
  right: number | null;
  status: "active" | "off";
  /** The prompt's file, for the panel's open-to-edit link (the source copy when the plugin runs from dist). */
  file?: string;
  /** The family as the J11 paper names it; the panel groups the rows under it. */
  family: FamilyId;
  familyTitle: string;
  familySubtitle: string;
}

const DIST_SEGMENT = `${sep}dist${sep}extensions${sep}`;

/**
 * The file to open for editing. The gateway reads its prompts from dist, which the next build overwrites, so a
 * prompt shipped from `<repo>/dist/extensions/...` opens as `<repo>/extensions/...` when that source file exists.
 */
export function editablePath(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const i = file.lastIndexOf(DIST_SEGMENT);
  if (i === -1) return file;
  const source = `${file.slice(0, i)}${sep}extensions${sep}${file.slice(i + DIST_SEGMENT.length)}`;
  return existsSync(source) ? source : file;
}

/** One row per question: today's answers and the share of labelled answers the user agreed with. */
export function questionRows(
  store: AmygdalaStore,
  book: QuestionBook,
  dayStart: number,
): QuestionRowOut[] {
  const decisions = store.decisionsSince(dayStart);
  const agree = new Map<string, { yes: number; total: number }>();
  for (const d of decisions) {
    const labels = store.labelsFor(d.id).filter((l) => l.kind === "judge");
    if (labels.length === 0) continue;
    const last = labels[labels.length - 1]!;
    for (const id of parseDrivers(d.reasonCode)) {
      const a = agree.get(id) ?? { yes: 0, total: 0 };
      a.total += 1;
      if (last.value === 1) a.yes += 1;
      agree.set(id, a);
    }
  }
  // By family in the paper's order, each family's prompts in its listed order; an unlisted prompt goes last, by id.
  const rank = (id: string, family: FamilyId): number => {
    const f = FAMILY_PAPER.findIndex((x) => x.id === family);
    const p = f === -1 ? -1 : FAMILY_PAPER[f]!.prompts.indexOf(id);
    return (f === -1 ? FAMILY_PAPER.length : f) * 1000 + (p === -1 ? 999 : p);
  };
  return book
    .ids()
    .map((id) => book.get(id)!)
    .toSorted((a, b) => rank(a.id, a.family) - rank(b.id, b.family) || a.id.localeCompare(b.id))
    .map((q) => {
      const id = q.id;
      const a = agree.get(id);
      const fam = FAMILY_PAPER.find((f) => f.id === q.family);
      return {
        id,
        name: q.name,
        version: q.version,
        today: store.queryVerdicts({ questionId: id, sinceTs: dayStart }).filter((v) => !v.skipped)
          .length,
        right: a && a.total > 0 ? a.yes / a.total : null,
        status: q.status,
        file: editablePath(book.file(id)),
        family: q.family,
        familyTitle: fam?.title ?? q.family,
        familySubtitle: fam?.subtitle ?? "",
      };
    });
}

/**
 * The decision events and intervention views of the decisions since `since`, rebuilt from the store so a reload can redraw
 * the windows and cards. A decision whose situation record has been pruned is skipped. `sessionKey` filters to one tab.
 */
export function rebuildEvents(
  store: AmygdalaStore,
  book: QuestionBook,
  o: { since: number; limit: number; sessionKey?: string },
): { decisionEvents: DecisionEvent[]; interventions: InterventionEvent[] } {
  // Filter by tab BEFORE the limit (2026-09-30: the CTO tab's rows fell outside the last 400 of the whole gateway).
  const rows = (
    o.sessionKey !== undefined
      ? store.decisionsSinceForSession(o.since, o.sessionKey)
      : store.decisionsSince(o.since)
  ).slice(-o.limit);
  // A decision can carry two interventions: its own and a refusal strip the merge outranked (decide.ts `refusalAlso`).
  const byDecision = new Map<string, ReturnType<AmygdalaStore["listInterventions"]>>();
  for (const i of store.listInterventions({ sinceTs: o.since, limit: 5000 })) {
    const list = byDecision.get(i.decisionId) ?? [];
    list.push(i);
    byDecision.set(i.decisionId, list);
  }
  const decisionEvents: DecisionEvent[] = [];
  const interventions: InterventionEvent[] = [];
  for (const d of rows) {
    const s: Situation | undefined = store.situationRecord(d.situationId);
    if (!s || (o.sessionKey !== undefined && s.sessionKey !== o.sessionKey)) continue;
    const ivs = byDecision.get(d.id) ?? [];
    const iv = ivs.find((i) => i.kind === d.response.kind) ?? ivs[0];
    const ctx = {
      situation: s,
      verdicts: store.queryVerdicts({ situationId: d.situationId }),
      decision: d,
      decisionId: d.id,
      book,
      interventionId: iv?.id,
    };
    decisionEvents.push(...buildDecisionEvents(ctx));
    for (const one of ivs) {
      const decision =
        one.kind === "refusal" && d.response.kind !== "refusal"
          ? { ...d, response: { kind: "refusal" as const } }
          : d;
      const e = buildInterventionEvent({
        ...ctx,
        decision,
        interventionId: one.id,
        state: one.state,
      });
      if (e) interventions.push(e);
    }
  }
  return { decisionEvents, interventions };
}
