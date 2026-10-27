/**
 * Factory types for the families (design doc §3 M8). The shared answer helpers, including the rule that a `cannot-tell`
 * answer never crosses a cut-off, live in ./common.ts. Families receive the questions asked at a step through the
 * `asked` map, so their cut-offs (with any per-context override already applied by `decide`) never come from a book.
 */
import type { QuestionBook } from "../question-book.js";
import type { Family } from "./types.js";

export interface FamilyDeps {
  book: QuestionBook;
}

export type FamilyFactory = (deps: FamilyDeps) => Family;
