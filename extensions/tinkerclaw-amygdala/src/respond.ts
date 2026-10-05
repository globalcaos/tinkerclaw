/**
 * Answers → response (design doc §3 M6; paper §6.1 proof table, §7.2 order). Pure: no Jev, no I/O.
 * Code chooses the response; the judge only answers questions.
 */
import type { EvidenceKind, Response } from "./types.js";

export type Danger = 0 | 1 | 2 | 3;
export type Risk = "low" | "medium" | "high";

export interface Cell {
  kind: "proceed" | "note" | "ask" | "proof" | "hold";
  /** The user must authorise the step (danger 3). */
  authorise: boolean;
  /** Template hint for a note. */
  templateId: "assumed-reading" | "relevant-fact" | null;
}

/**
 * The proof a step needs, from its danger and the risk of a misreading (paper §6.1, Table 3):
 *
 *   danger 0–1: low proceed | medium note (assumed reading) | high ask (0–1 steps may continue)
 *   danger 2:   low note (relevant fact) | medium proof | high hold until a reading is picked
 *   danger 3:   low proof + authorise (unless the request named this exact action and target)
 *               | medium proof + authorise | high hold until reading picked and step authorised
 */
export function proofCell(danger: Danger, risk: Risk, namedExactAction = false): Cell {
  if (danger <= 1) {
    if (risk === "low") return { kind: "proceed", authorise: false, templateId: null };
    if (risk === "medium") return { kind: "note", authorise: false, templateId: "assumed-reading" };
    return { kind: "ask", authorise: false, templateId: null };
  }
  if (danger === 2) {
    if (risk === "low") return { kind: "note", authorise: false, templateId: "relevant-fact" };
    if (risk === "medium") return { kind: "proof", authorise: false, templateId: null };
    return { kind: "hold", authorise: false, templateId: null };
  }
  if (risk === "low") return { kind: "proof", authorise: !namedExactAction, templateId: null };
  if (risk === "medium") return { kind: "proof", authorise: true, templateId: null };
  return { kind: "hold", authorise: true, templateId: null };
}

export interface DangerAdjust {
  /** The target holds recent work worth protecting: one level more dangerous. */
  recentInvestment?: boolean;
  /** A similar incident was labelled should-hold: one level more dangerous. */
  precedentShouldHold?: boolean;
  /** The step stops, restarts or reconfigures the agent's own system: danger 3. */
  stopsOwnSystem?: boolean;
  /** Data of the harmful-if-seen tier moves to a shared or public place: danger 3. */
  egressTier3?: boolean;
  /** The step repeats an effect already completed and the agent has not shown the earlier one failed: danger 3. */
  repeatUnresolved?: boolean;
}

export function adjustDanger(base: Danger, a: DangerAdjust): Danger {
  if (a.stopsOwnSystem || a.egressTier3 || a.repeatUnresolved) return 3;
  let d: number = base;
  if (a.recentInvestment) d += 1;
  if (a.precedentShouldHold) d += 1;
  return Math.min(3, d) as Danger;
}

/** hold > send-back > ask > proof > note > refusal > proceed (design doc M7 step 7). */
export const SEVERITY: Record<Response["kind"], number> = {
  hold: 5,
  "send-back": 4,
  ask: 3,
  proof: 2,
  note: 1,
  refusal: 0.5,
  proceed: 0,
};

export function severity(r: Response): number {
  return SEVERITY[r.kind];
}

export interface Candidate {
  response: Response;
  family: string;
  reasonCode: string;
}

/** The most severe candidate wins; ties keep the earlier one (family order). Empty → proceed. */
export function mergeResponses(cands: Candidate[]): Candidate {
  let best: Candidate | null = null;
  for (const c of cands) {
    if (!best || severity(c.response) > severity(best.response)) best = c;
  }
  return best ?? { response: { kind: "proceed" }, family: "safety", reasonCode: "none" };
}

export interface NoteState {
  seenNotes: Set<string>;
  notesThisCall: number;
}

/** At most one note per tool call, and the same note is not repeated within a task (paper §4.2). */
export function limitNotes(r: Response, state: NoteState): Response {
  if (r.kind !== "note") return r;
  const key = `${r.templateId}|${JSON.stringify(r.slots)}`;
  if (state.notesThisCall >= 1 || state.seenNotes.has(key)) return { kind: "proceed" };
  state.seenNotes.add(key);
  state.notesThisCall += 1;
  return r;
}

export interface CellBuild {
  slots: Record<string, string | number>;
  needs: EvidenceKind[];
  askId: string;
  options: { id: string; label: string; hint?: string }[];
  preselect?: string;
  reason: string;
}

/** Turn a table cell into a concrete Response using what the caller computed for this step. */
export function cellToResponse(cell: Cell, b: CellBuild): Response {
  switch (cell.kind) {
    case "proceed":
      return { kind: "proceed" };
    case "note":
      return {
        kind: "note",
        templateId: cell.templateId ?? "relevant-fact",
        slots: b.slots,
        channel: "additionalContext",
      };
    case "proof":
      return { kind: "proof", templateId: "proof-required", slots: b.slots, needs: b.needs };
    case "ask":
      return { kind: "ask", askId: b.askId, options: b.options, preselect: b.preselect };
    case "hold":
      return { kind: "hold", ruleOrQuestion: b.reason, releasable: "user-only" };
  }
}
