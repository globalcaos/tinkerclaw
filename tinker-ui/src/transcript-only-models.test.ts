import { describe, expect, it } from "vitest";
import {
  compactUnknownModelLabel,
  isTranscriptOnlyModel,
  TRANSCRIPT_ONLY_MODELS,
} from "./transcript-only-models.js";

describe("isTranscriptOnlyModel", () => {
  // The 2026-07-31 regression: after a gateway restart the indicator took the
  // gateway's own injected message as the answering model, so the dot went grey
  // (provider "openclaw" is absent from PROVIDER_COLORS) while Opus was running.
  it("recognises the gateway bookkeeping sentinels", () => {
    expect(isTranscriptOnlyModel("gateway-injected")).toBe(true);
    expect(isTranscriptOnlyModel("delivery-mirror")).toBe(true);
  });

  it("leaves real models alone", () => {
    for (const model of [
      "claude-opus-5",
      "grok-4.5",
      "gpt-5.6-sol",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
    ]) {
      expect(isTranscriptOnlyModel(model)).toBe(false);
    }
  });

  it("is safe on empty, undefined and null", () => {
    expect(isTranscriptOnlyModel("")).toBe(false);
    expect(isTranscriptOnlyModel(undefined)).toBe(false);
    expect(isTranscriptOnlyModel(null)).toBe(false);
  });

  // Guard against a partial match ever counting as a sentinel — the filter is
  // exact-set membership, not substring.
  it("does not match on substrings", () => {
    expect(isTranscriptOnlyModel("gateway")).toBe(false);
    expect(isTranscriptOnlyModel("gateway-injected-v2")).toBe(false);
    expect(TRANSCRIPT_ONLY_MODELS.has("gateway")).toBe(false);
  });
});

describe("compactUnknownModelLabel", () => {
  // The literal string the architect reported reading in the indicator.
  it("no longer produces the 'gatewa' stub", () => {
    expect(compactUnknownModelLabel("gateway-injected")).not.toBe("gatewa");
    expect(compactUnknownModelLabel("gateway-injected")).toBe("gateway…");
  });

  it("cuts on a separator so the label stays a whole word", () => {
    expect(compactUnknownModelLabel("delivery-mirror")).toBe("delivery…");
    expect(compactUnknownModelLabel("something_else_here")).toBe("something…");
    expect(compactUnknownModelLabel("vendor/model-name")).toBe("vendor…");
  });

  it("leaves short labels untouched and unmarked", () => {
    expect(compactUnknownModelLabel("xyz")).toBe("xyz");
    expect(compactUnknownModelLabel("abcdefgh")).toBe("abcdefgh");
    expect(compactUnknownModelLabel("")).toBe("");
  });

  // A long first token must not itself become an unreadable stub, but it still
  // has to be bounded — fall back to a hard cut, still marked as cut.
  it("bounds a very long first token and marks the cut", () => {
    expect(compactUnknownModelLabel("supercalifragilistic-x")).toBe("supercal…");
    expect(compactUnknownModelLabel("aaaaaaaaaaaaaaaaaaaa")).toBe("aaaaaaaa…");
  });

  it("only appends the ellipsis when something was actually removed", () => {
    // Nothing dropped → no ellipsis, even above the 8-char short-circuit: a
    // separator-free 9-char id survives whole, so marking it cut would be a lie.
    expect(compactUnknownModelLabel("abcdefgh")).toBe("abcdefgh");
    expect(compactUnknownModelLabel("abcdefghi")).toBe("abcdefghi");
    expect(compactUnknownModelLabel("abcdefghi").endsWith("…")).toBe(false);
    // Something dropped → ellipsis.
    expect(compactUnknownModelLabel("abcdefghijklmno").endsWith("…")).toBe(true);
    expect(compactUnknownModelLabel("gateway-injected").endsWith("…")).toBe(true);
  });
});
