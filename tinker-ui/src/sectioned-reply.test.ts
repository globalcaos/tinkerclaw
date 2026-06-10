import { describe, it, expect } from "vitest";
import {
  splitSectionedReply,
  renderSectionedReply,
  scrubResidualSectionMarkers,
} from "./sectioned-reply";

// Identity stubs — the structural assertions below (which bubbles/classes are
// emitted) are independent of real markdown rendering / HTML escaping.
const md = (s: string): string => s;
const esc = (s: string): string => s;
const render = (sec: Parameters<typeof renderSectionedReply>[0]): string =>
  renderSectionedReply(sec, "", md, esc);

describe("splitSectionedReply — amygdala retired (only 💬 ANSWER / 🌿 FRACTAL are sections)", () => {
  it("splits a normal ANSWER + FRACTAL reply", () => {
    const sec = splitSectionedReply(
      "💬 ANSWER\n\nThe answer body.\n\n🌿 FRACTAL\n\nThe reflection.",
    );
    expect(sec).not.toBeNull();
    expect(sec!.answer).toBe("The answer body.");
    expect(sec!.fractal).toBe("The reflection.");
    expect(sec!.other).toBeUndefined();
    // amygdala is no longer a field at all.
    expect((sec as Record<string, unknown>).amygdala).toBeUndefined();
  });

  it("does NOT treat a 🧠 AMYGDALA header as a section — it falls into `other`", () => {
    // Model still emits the old three-part shape out of session habit.
    const sec = splitSectionedReply(
      "🧠 AMYGDALA\n\ngut read here\n\n💬 ANSWER\n\nThe real answer\n\n🌿 FRACTAL\n\nrefl",
    );
    expect(sec).not.toBeNull();
    // The 🧠 chunk before the first recognised marker is preface → `other`.
    expect(sec!.other).toContain("gut read here");
    expect(sec!.answer).toBe("The real answer");
    expect(sec!.fractal).toBe("refl");
    expect((sec as Record<string, unknown>).amygdala).toBeUndefined();
  });

  it("keeps pre-answer narration as `other`", () => {
    const sec = splitSectionedReply("Let me check that.\n\n💬 ANSWER\n\nDone.");
    expect(sec!.other).toBe("Let me check that.");
    expect(sec!.answer).toBe("Done.");
  });

  it("returns null when there is no ANSWER or FRACTAL marker", () => {
    expect(splitSectionedReply("just a plain reply, no markers")).toBeNull();
    expect(splitSectionedReply("")).toBeNull();
  });
});

describe("renderSectionedReply — no fabricated amygdala block, fractal preserved", () => {
  it("REGRESSION (fabricated amygdala): pre-answer narration must NOT become a collapsed 🧠 block", () => {
    // Old code: sec.other + any marker → mergedAmygdala → <details class='msg msg-amygdala'>.
    const h = render({ other: "Let me check.", answer: "The answer", fractal: "refl" });
    expect(h).not.toContain("msg-amygdala");
    expect(h).not.toContain("amygdala-summary");
    // Narration is folded INTO the answer bubble, inline (nothing on the floor).
    expect(h).toContain("Let me check.");
    expect(h).toContain("The answer");
    // Fractal still renders as its own collapsed bubble.
    expect(h).toContain("fractal-details");
    expect(h).toContain("msg-fractal");
  });

  it("REGRESSION (literal amygdala header): a residual 🧠 gut-read renders inline as prose, no 🧠 label, no block", () => {
    // After the split, the 🧠 chunk lives in `other`.
    const sec = splitSectionedReply(
      "🧠 AMYGDALA\n\ngut read here\n\n💬 ANSWER\n\nThe real answer",
    )!;
    const h = render(sec);
    expect(h).not.toContain("msg-amygdala");
    // The bare "🧠 AMYGDALA" marker line is scrubbed; the gut-read text survives inline.
    expect(h).toContain("gut read here");
    expect(h).not.toMatch(/🧠\s*AMYGDALA/i);
    expect(h).toContain("The real answer");
  });

  it("renders a plain ANSWER inline (expanded), no amygdala bubble", () => {
    const h = render({ answer: "Hello world." });
    expect(h).toContain('class="msg assistant"');
    expect(h).toContain("Hello world.");
    expect(h).not.toContain("msg-amygdala");
  });

  it("preserves the FRACTAL collapsed bubble for an ANSWER + FRACTAL reply", () => {
    const h = render({ answer: "ans", fractal: "MEMORY: something worth keeping" });
    expect(h).toContain('class="fractal-details"');
    expect(h).toContain("fractal-summary");
    expect(h).toContain("msg-fractal");
    expect(h).not.toContain("msg-amygdala");
  });

  it("promotes narration to the answer when only a FRACTAL marker exists (no answer dropped)", () => {
    const h = render({ other: "narration only", fractal: "refl" });
    expect(h).toContain("narration only");
    expect(h).toContain("fractal-details");
    expect(h).not.toContain("msg-amygdala");
  });
});

describe("scrubResidualSectionMarkers — strips bare 🧠 AMYGDALA / 💬 ANSWER / 🌿 FRACTAL lines", () => {
  it("removes a standalone retired 🧠 AMYGDALA marker line but keeps surrounding prose", () => {
    const out = scrubResidualSectionMarkers("intro\n🧠 AMYGDALA\nbody text");
    expect(out).not.toMatch(/🧠\s*AMYGDALA/i);
    expect(out).toContain("intro");
    expect(out).toContain("body text");
  });
});
