import { describe, expect, it } from "vitest";
import { dedupStreamingOverlap } from "./stream.js";

// FORK 2026-06-19 (bug B — "duplication of text in the answers"): dedupStreamingOverlap trims/drops a
// streaming "restart" where an incoming delta re-sends the TAIL of what was already accumulated. The
// legacy per-block 60-char prefix guard missed partial / offset / cross-block re-sends; this helper
// catches them against the GLOBAL accumulator while leaving legitimate short repeats untouched.

const A60 = "A".repeat(60); // a >=minLen run so the overlap gate engages
const SENT =
  "Good catches — the recipe was missing Step 7, which resets improvement_notes after incorporating.";

describe("dedupStreamingOverlap (bug B: cross-block / offset answer duplication)", () => {
  it("passes a normal, non-overlapping delta through unchanged", () => {
    expect(dedupStreamingOverlap(SENT, " The next sentence continues the thought.")).toBe(
      " The next sentence continues the thought.",
    );
  });

  it("does NOT dedup when the overlap is shorter than minLen (legit short repeats survive)", () => {
    // "Step 2:" repeats "Step 1:"-style openings — far under 60 chars, must be left alone.
    const acc = "Step 1: do the thing.\nStep 2: ";
    expect(dedupStreamingOverlap(acc, "Step 2: do the other thing.")).toBe(
      "Step 2: do the other thing.",
    );
  });

  it("drops a delta that fully re-sends the accumulator tail (full restart)", () => {
    // The classic doubling: the whole sentence is streamed once, then re-emitted verbatim.
    expect(dedupStreamingOverlap(SENT, SENT)).toBe("");
  });

  it("trims the overlapping prefix when a delta re-sends the tail then adds new text", () => {
    const tail = SENT.slice(-80); // a >=minLen suffix of what we've sent
    const fresh = " And here is genuinely new content.";
    expect(dedupStreamingOverlap(SENT, tail + fresh)).toBe(fresh);
  });

  it("handles a cumulative re-emit that repeats everything plus more", () => {
    // acc is fully a prefix of delta (cumulative message re-sends the block then appends new tokens).
    const more = " plus the freshly generated continuation.";
    expect(dedupStreamingOverlap(A60, A60 + more)).toBe(more);
  });

  it("returns the delta unchanged when the accumulator is still tiny", () => {
    expect(dedupStreamingOverlap("hi", SENT)).toBe(SENT);
  });

  it("'Good catches…Good catches…' doubling collapses to a single copy", () => {
    // Simulate the observed live doubling: same prose appended onto itself.
    const acc = SENT;
    const dup = dedupStreamingOverlap(acc, SENT + " Continuing.");
    expect(dup).toBe(" Continuing.");
    expect(acc + dup).toBe(SENT + " Continuing."); // exactly one copy survives
  });
});
