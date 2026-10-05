import { describe, expect, it } from "vitest";
import { isCapRebase, rebaseAnchors } from "./stream-rebase.js";

describe("rebaseAnchors", () => {
  it("anchors every bubble when the buffer still shows all of them, in order", () => {
    const { starts, scan } = rebaseAnchors(["alpha ", "beta ", "gamma"], "alpha beta gamma");
    expect(starts).toEqual([0, 6, 11]);
    expect(scan).toBe(16);
  });

  it("anchors past a NEW HEAD the buffer carries above what is on screen", () => {
    // A retry preamble the client never saw. The body is still findable, just moved.
    const { starts } = rebaseAnchors(["the answer"], "preamble... the answer");
    expect(starts).toEqual([12]);
  });

  it("is FORWARD-ONLY: a repeated phrase never anchors backwards into an earlier claim", () => {
    // Both bubbles hold "ok". Without a forward cursor the second would anchor at 0 too and the
    // two envelopes would overlap — which is the duplicate rendering itself.
    const { starts } = rebaseAnchors(["ok", "ok"], "ok ok");
    expect(starts).toEqual([0, 3]);
  });

  it("reports null for text the buffer no longer shows, and parks it at the cursor", () => {
    const { starts, parks } = rebaseAnchors(["kept", "superseded", "tail"], "kept tail");
    expect(starts).toEqual([0, null, 5]);
    // The unanchored bubble parks at the cursor after "kept" — NOT past "tail"'s start, which
    // would collapse "kept"'s end bound in stream-reslice.ts.
    expect(parks[1]).toBe(4);
    expect(parks[1]).toBeLessThanOrEqual(starts[2] as number);
  });

  it("never parks a bubble past a later bubble's anchor", () => {
    const shown = ["a", "gone", "b", "alsogone", "c"];
    const { starts, parks } = rebaseAnchors(shown, "a b c");
    for (let i = 0; i < shown.length; i++) {
      if (starts[i] !== null) continue;
      const laterAnchors = starts.slice(i + 1).filter((s): s is number => s !== null);
      for (const later of laterAnchors) {
        expect(parks[i]).toBeLessThanOrEqual(later);
      }
    }
  });

  it("scan lands past everything still shown, so a new bubble cannot repeat visible text", () => {
    const { scan } = rebaseAnchors(["one ", "two"], "one two three");
    expect(scan).toBe(7);
    expect("one two three".slice(scan)).toBe(" three");
  });

  it("handles a buffer that shows nothing on screen (a total reset)", () => {
    const { starts, parks, scan } = rebaseAnchors(["old text"], "completely different");
    expect(starts).toEqual([null]);
    expect(parks).toEqual([0]);
    expect(scan).toBe(0);
  });

  it("treats an empty bubble as unanchored but still parks it", () => {
    const { starts, parks } = rebaseAnchors(["", "real"], "real");
    expect(starts).toEqual([null, 0]);
    expect(parks[0]).toBe(0);
  });

  it("returns empty results for no bubbles", () => {
    expect(rebaseAnchors([], "anything")).toEqual({ starts: [], parks: [], scan: 0 });
  });

  it("never returns an anchor that would make a bubble's slice disagree with its text", () => {
    // The property the caller relies on to GROW in place: buffer.slice(at) startsWith the text.
    const shown = ["first part ", "second part"];
    const buffer = "noise first part second part more";
    const { starts } = rebaseAnchors(shown, buffer);
    for (let i = 0; i < shown.length; i++) {
      const at = starts[i];
      if (at === null) continue;
      expect(buffer.slice(at).startsWith(shown[i])).toBe(true);
    }
  });
});

describe("isCapRebase", () => {
  it("detects a tail-slice: the new buffer is a strict suffix of the old", () => {
    expect(isCapRebase("aaaaBBBB", "BBBB")).toBe(true);
  });

  it("is false for a RESET, where the body genuinely changed", () => {
    expect(isCapRebase("old body here", "new body here")).toBe(false);
  });

  it("is false for an ordinary extension (not a re-base at all)", () => {
    expect(isCapRebase("abc", "abcdef")).toBe(false);
  });

  it("is false when the buffer is unchanged", () => {
    expect(isCapRebase("same", "same")).toBe(false);
  });

  it("is false on the first delta, when there is no previous buffer", () => {
    expect(isCapRebase("", "anything")).toBe(false);
  });
});
