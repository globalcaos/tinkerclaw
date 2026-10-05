// The shapes the Jev client reads (design doc section 13A.8, C5).
//
// WHAT THIS IS FOR. The Jev client lived in the amygdala extension and imported that extension's
// `Question`, `Situation`, `SituationFieldName` and `Verdict`. Core cannot import from an extension, so
// the client moved to `src/infra/jev/` and reads these structural types instead. They are exactly the
// fields the client touches; the amygdala's own, larger types are assignable to them, so its code keeps
// its types unchanged (the client is generic over them).

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevQuestion {
  id: string;
  version: number;
  type: JevQuestionType;
  /** choice: option -> description|null; score: ordered levels; noul: optional {true,false}. */
  criteria: Record<string, string | null> | string[];
  instructions: string;
  fields: readonly string[];
}

/** A situation is anything with an id whose named fields each carry a `value`. */
export interface JevSituation {
  readonly id: string;
}

export interface JevVerdict {
  id: string;
  situationId: string;
  questionId: string;
  questionVersion: number;
  type: JevQuestionType;
  answer: string | number | boolean;
  prob: number;
  confidence: number;
  probs?: Record<string, number>;
  cacheHit: boolean;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  skipped?: "not-allowed" | "breaker-open" | "timeout" | "error";
  ts: number;
}
