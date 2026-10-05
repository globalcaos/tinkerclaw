/**
 * The interface every family implements (design doc §3 M8). A family says which questions it wants at a step and,
 * given the verdicts, may return a response. It never calls Jev and never does I/O: that keeps every decision table
 * a plain unit test over scripted verdicts.
 */
import type { TurnState } from "../context.js";
import type { FamilyId, Question, Response, Seam, Situation, Verdict } from "../types.js";

export interface FamilyResult {
  response: Response;
  /** Ids of the questions whose answers drove this response (shown in the chat window). */
  drivers: string[];
  /** Short stable code, e.g. "table-d3-medium". Combined with the drivers into Decision.reasonCode. */
  reasonCode: string;
  /** The family also found a refusal but returned a more severe response: decide still offers the refusal strip. */
  alsoRefusal?: boolean;
}

/** The questions asked at this step by id: their cut-offs live here, so a family never hard-codes a number. */
export type AskedQuestions = ReadonlyMap<string, Question>;

export interface Family {
  id: FamilyId;
  /**
   * Optional, before any question is chosen: fill situation fields the family can derive by code (claims from the
   * reply, the tool record from the transcript tail). Bounded synchronous work only; never calls Jev.
   */
  enrich?(seam: Seam, s: Situation, state: TurnState): void;
  /** Question ids wanted at this step; an empty list means the family is not involved. */
  questionsFor(seam: Seam, s: Situation, state: TurnState): string[];
  /**
   * Optional, after the answers arrive and before any family decides: let a family update the turn state from this
   * step's verdicts (second opinion sets the misreading risk that safety reads at the same step).
   */
  observe?(
    seam: Seam,
    s: Situation,
    verdicts: Verdict[],
    state: TurnState,
    asked: AskedQuestions,
  ): void;
  /**
   * null = no opinion. Verdicts with `skipped` set carry no answer and must be treated as absent. A `cannot-tell`
   * choice answer must never cross a cut-off (use `crosses` from ./common.js).
   */
  decide(
    seam: Seam,
    s: Situation,
    verdicts: Verdict[],
    state: TurnState,
    asked: AskedQuestions,
  ): FamilyResult | null;
}
