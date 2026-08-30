import { describe, expect, it } from "vitest";
import {
  endsAtSentenceBoundary,
  isSentenceContinuation,
  sameRun,
} from "./sentence-continuation.js";

// FORK 2026-08-25 (the architect: "I interrupted one turn with another query, then the
// intermediate thinking gets deleted in the chat").
//
// mergeSentenceContinuations SPLICES the merged bubble out of the transcript, so
// a wrong "this is a fragment" verdict is a DELETION. The old test read only the
// fragment's first character and counted a leading digit as proof. Every string
// below marked REAL was measured in a live transcript on 2026-08-25.

const REAL_NARRATIONS = [
  "488 species researched — 260 have PFAF monographs, 468 resolved in GBIF.",
  "746 live plants, 724 in stock. Let me read the full roster.",
  "63 pages of live plants — roughly 750 species.",
  "50 of 488 species carry an EMA assessment — that's the evidence tier.",
  "10/10 green. Now looking at the actual render rather than trusting strings.",
  "19/19 green. Tracking down that one 404 before I call it clean.",
];

describe("endsAtSentenceBoundary", () => {
  it("recognises a clean end, with or without trailing quotes/brackets", () => {
    expect(endsAtSentenceBoundary("…before merging.")).toBe(true);
    expect(endsAtSentenceBoundary("Is that right?")).toBe(true);
    expect(endsAtSentenceBoundary('He said "go."')).toBe(true);
    expect(endsAtSentenceBoundary("Here is the list:")).toBe(true);
  });

  it("recognises an UNFINISHED tail — the only thing a fragment can follow", () => {
    expect(endsAtSentenceBoundary("746 live medicinal specie")).toBe(false);
    expect(endsAtSentenceBoundary("the nursery is genuinely")).toBe(false);
  });

  it("treats a markdown block as structurally complete", () => {
    expect(endsAtSentenceBoundary("## Three corrections first")).toBe(true);
    expect(endsAtSentenceBoundary("- Brahmi €5")).toBe(true);
  });

  it("treats empty/whitespace as a boundary so it cannot swallow the next bubble", () => {
    expect(endsAtSentenceBoundary("")).toBe(true);
    expect(endsAtSentenceBoundary("   \n ")).toBe(true);
  });
});

describe("isSentenceContinuation (a wrong verdict DELETES a bubble)", () => {
  it("never merges a real narration after a cleanly-ended bubble", () => {
    const prev = "Crawl at 280/488. Waiting for it to finish before merging.";
    for (const next of REAL_NARRATIONS) {
      expect(isSentenceContinuation(prev, next)).toBe(false);
    }
  });

  it("still repairs a genuine mid-word stream split", () => {
    // The verbatim artifact seen in the rendered DOM: a bubble that began "s at €3,50".
    expect(isSentenceContinuation("— 746 live medicinal specie", "s at €3,50 is remarkable")).toBe(
      true,
    );
  });

  it("still repairs a lowercase continuation of an unfinished clause", () => {
    expect(isSentenceContinuation("The shop's founder was", " fined 1.2 million euros.")).toBe(
      true,
    );
  });

  it("never merges INTO a markdown block, and never merges a markdown block", () => {
    expect(isSentenceContinuation("## Phase 2 — 19 more plants", "488 species researched")).toBe(
      false,
    );
    expect(isSentenceContinuation("the list is as follows", "- Brahmi €5")).toBe(false);
  });

  it("refuses on empty input rather than guessing", () => {
    expect(isSentenceContinuation("", "s at €3,50")).toBe(false);
    expect(isSentenceContinuation("unfinished tex", "")).toBe(false);
  });
});

describe("sameRun (the interrupt guard)", () => {
  it("allows a merge only within one run", () => {
    expect(sameRun("run-a", "run-a")).toBe(true);
    expect(sameRun("run-a", "run-b")).toBe(false);
  });

  it("refuses when either provenance is unknown — the failure mode is deletion", () => {
    expect(sameRun(undefined, "run-a")).toBe(false);
    expect(sameRun("run-a", undefined)).toBe(false);
    expect(sameRun(undefined, undefined)).toBe(false);
  });
});
