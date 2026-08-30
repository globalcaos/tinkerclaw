import { describe, it, expect } from "vitest";
import {
  splitSectionedReply,
  renderSectionedReply,
  scrubResidualSectionMarkers,
  splitLeadingNarration,
  splitReasoningFromAnswer,
  isFractalSectionText,
} from "./sectioned-reply";

// FORK 2026-08-15 — the predicate app.ts's run classifier keys on. The literal test it replaces
// (`trimStart().startsWith("🌿 FRACTAL:")`) recognised only the clean-turn form, so every
// reflection that actually DID something — `🌿 FRACTAL ACTION:` — slipped past the guard written
// to stop it demoting the answer.
describe("isFractalSectionText", () => {
  it("recognises BOTH mandated prefixes", () => {
    expect(isFractalSectionText("🌿 FRACTAL: clean — nothing to learn")).toBe(true);
    expect(isFractalSectionText("🌿 FRACTAL ACTION: appended the rule to the framing note")).toBe(
      true,
    );
  });

  it("tolerates the same decoration as the section markers", () => {
    expect(isFractalSectionText("  🌿 FRACTAL: x")).toBe(true);
    expect(isFractalSectionText("**🌿 FRACTAL ACTION:** x")).toBe(true);
    expect(isFractalSectionText("## 🌿 FRACTAL x")).toBe(true);
  });

  it("is anchored at the START — a reply that MENTIONS the section is not one", () => {
    expect(isFractalSectionText("Here is the answer.\n\n🌿 FRACTAL: clean")).toBe(false);
    expect(isFractalSectionText("see the 🌿 FRACTAL block above")).toBe(false);
    expect(isFractalSectionText("the fractal reflection is separate")).toBe(false);
    expect(isFractalSectionText("")).toBe(false);
  });
});

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

  it("MARKER-FREE (bug A): 🌿 FRACTAL with NO 💬 ANSWER keeps the answer prose in `other`", () => {
    // After retiring the 💬 ANSWER marker the model emits its answer then a 🌿 FRACTAL section.
    // The answer must stay accessible (renderSectionedReply promotes `other` when a fractal exists),
    // never lost or buried — this is the marker-free contract the structural run-grouping relies on.
    const sec = splitSectionedReply("Here is the real answer.\n\n🌿 FRACTAL: my reflection")!;
    expect(sec).not.toBeNull();
    expect(sec.other).toBe("Here is the real answer.");
    expect(sec.fractal).toBe("my reflection");
    expect(sec.answer).toBeUndefined();
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

  it("MARKER-FREE (bug A): answer + fractal with NO 💬 ANSWER renders the answer VISIBLE", () => {
    const sec = splitSectionedReply("Here is the real answer.\n\n🌿 FRACTAL: refl")!;
    const h = render(sec);
    expect(h).toContain("Here is the real answer."); // answer surfaced, not hidden
    expect(h).toContain("fractal-details"); // fractal still its own collapsed bubble
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

describe("splitLeadingNarration — peels leading tinker-bridge inter-tool narration only", () => {
  it("is a pure no-op when the first sentence is not narration", () => {
    expect(splitLeadingNarration("The value is 5.")).toEqual({
      narration: "",
      answer: "The value is 5.",
    });
  });

  it("peels a single leading narration sentence off the answer", () => {
    const r = splitLeadingNarration("Let me check the config.\n\nThe value is 5.");
    expect(r.narration).toBe("Let me check the config.");
    expect(r.answer).toBe("The value is 5.");
  });

  it("accumulates consecutive leading narration sentences, stops at the answer", () => {
    const r = splitLeadingNarration("Let me check X. Now I will read Y. The answer is Z.");
    expect(r.narration).toContain("Let me check X.");
    expect(r.narration).toContain("Now I will read Y.");
    expect(r.answer).toBe("The answer is Z.");
  });

  it("GUARD: never blanks the answer when every sentence is narration", () => {
    expect(splitLeadingNarration("Let me check the config.")).toEqual({
      narration: "",
      answer: "Let me check the config.",
    });
  });

  it("EXCLUDE: 'let me know …' closing is answer content, not peeled", () => {
    expect(
      splitLeadingNarration("Let me know if you need anything else. The data is ready."),
    ).toEqual({
      narration: "",
      answer: "Let me know if you need anything else. The data is ready.",
    });
  });
});

describe("renderSectionedReply — leading narration becomes a collapsed Commentary block, not inline", () => {
  it("emits narration-details + Commentary when sec.other is set, and does NOT inline sec.other into the answer .msg bubble", () => {
    const h = render({ other: "Let me check.", answer: "The answer" });
    expect(h).toContain("narration-details");
    expect(h).toContain("Commentary");
    // The narration text lives only inside the Commentary block — the answer
    // .msg bubble (after the </details>) must not contain it.
    const afterDetails = h.slice(h.indexOf("</details>") + "</details>".length);
    expect(afterDetails).toContain("The answer");
    expect(afterDetails).not.toContain("Let me check.");
  });

  it("peels leading narration fused into the answer body itself into the Commentary block", () => {
    const h = render({ answer: "Let me check the config. The value is 5." });
    expect(h).toContain("narration-details");
    expect(h).toContain("Let me check the config.");
    const afterDetails = h.slice(h.indexOf("</details>") + "</details>".length);
    expect(afterDetails).toContain("The value is 5.");
    expect(afterDetails).not.toContain("Let me check the config.");
  });

  it("no Commentary block for a plain answer with no leading narration", () => {
    const h = render({ answer: "Hello world." });
    expect(h).not.toContain("narration-details");
    expect(h).toContain("Hello world.");
  });
});

describe("scrubResidualSectionMarkers — strips bare 🧠 AMYGDALA / 💬 ANSWER / 🌿 FRACTAL lines", () => {
  it("removes a standalone retired 🧠 AMYGDALA marker line but keeps surrounding prose", () => {
    const out = scrubResidualSectionMarkers("intro\n🧠 AMYGDALA\nbody text");
    expect(out).not.toMatch(/🧠\s*AMYGDALA/i);
    expect(out).toContain("intro");
    expect(out).toContain("body text");
  });

  it("strips a 💬 ANSWER marker glued MID-LINE without fusing the surrounding words", () => {
    const out = scrubResidualSectionMarkers("Body. 💬 ANSWER restated mid-text.");
    expect(out).not.toMatch(/💬\s*ANSWER/i);
    expect(out).toContain("Body.");
    expect(out).toContain("restated mid-text.");
    // collapsed to a single space — no "Body.restated" fusion.
    expect(out).not.toMatch(/Body\.restated/);
  });

  it("strips an inline-echo 💬 ANSWER reference from prose", () => {
    const out = scrubResidualSectionMarkers("As noted in the 💬 ANSWER above, x.");
    expect(out).not.toMatch(/💬\s*ANSWER/i);
    expect(out).toContain("As noted in the");
    expect(out).toContain("above, x.");
  });

  it("NEVER strips ordinary prose that merely contains the word answer", () => {
    expect(scrubResidualSectionMarkers("the answer is 42")).toBe("the answer is 42");
  });
});

describe("renderSectionedReply — residual section markers never render mid-answer", () => {
  it("REGRESSION: a 💬 ANSWER glued mid-answer does not appear in the rendered HTML", () => {
    const h = render({ answer: "Body. 💬 ANSWER restated mid-text." });
    expect(h).not.toMatch(/💬\s*ANSWER/i);
    expect(h).toContain("Body.");
    expect(h).toContain("restated mid-text.");
  });

  it("REGRESSION: an inline-echo 💬 ANSWER reference does not appear in the rendered HTML", () => {
    const h = render({ answer: "As noted in the 💬 ANSWER above, x." });
    expect(h).not.toMatch(/💬\s*ANSWER/i);
    expect(h).toContain("above, x.");
  });
});

describe("splitReasoningFromAnswer", () => {
  const NARR = "Let me check the merge layer to confirm the dedup case here please.";
  const NARR2 = "Now let me read the gate region to pick the correct fix carefully.";
  const ANS = "The backend is clean; the duplication is injected on the serve path.";

  it("peels interleaved narration anywhere, not just the leading run", () => {
    const text = `${NARR} ${ANS} ${NARR2}`;
    const r = splitReasoningFromAnswer(text);
    expect(r.reasoning).toContain("Let me check");
    expect(r.reasoning).toContain("Now let me read");
    expect(r.answer).toContain("backend is clean");
    expect(r.answer).not.toContain("Let me check");
  });

  it("folds everything before a confident conclusion anchor into reasoning (numbered list)", () => {
    const text = `${NARR} ${NARR2} Found the cause.\n\n1. Root: serve path.\n2. Fix: dedup at the boundary.`;
    const r = splitReasoningFromAnswer(text);
    expect(r.answer.startsWith("1.")).toBe(true);
    expect(r.reasoning).toContain("Found the cause");
  });

  it("folds before a recap phrase anchor", () => {
    const text = `${NARR} Some finding here that is long enough to matter.\n\nBottom line: pin the model to claude-opus.`;
    const r = splitReasoningFromAnswer(text);
    expect(r.answer.toLowerCase().startsWith("bottom line")).toBe(true);
  });

  it("NEVER blanks the answer when there is no anchor and everything looks like notes", () => {
    const text = `${NARR} ${NARR2}`;
    const r = splitReasoningFromAnswer(text);
    expect(r.answer.length).toBeGreaterThan(0);
  });

  it("is a pure no-op when there is no narration and no anchor", () => {
    const text = "Here is a single plain answer sentence with no narration and no anchor.";
    const r = splitReasoningFromAnswer(text);
    expect(r.reasoning).toBe("");
    expect(r.answer).toBe(text);
  });

  it("does not hide content without a confident anchor (only narration removed)", () => {
    const text = `${NARR} ${ANS} A second substantive finding that is not narration at all.`;
    const r = splitReasoningFromAnswer(text);
    expect(r.answer).toContain("backend is clean");
    expect(r.answer).toContain("second substantive finding");
  });

  it("is idempotent on the answer", () => {
    const text = `${NARR} ${ANS}`;
    const once = splitReasoningFromAnswer(text).answer;
    expect(splitReasoningFromAnswer(once).answer).toBe(once);
  });

  // FORK 2026-08-16 — the anchor says WHERE a conclusion may start; it must not by itself decide
  // that everything before it is disposable. Measured over 45 sessions: 24 folds, 24 of them with a
  // hidden head under 10% narration. These pin the discrimination in both directions.
  it("does NOT fold substantive prose just because a heading appears late", () => {
    const prose =
      "the architect — you're right, and the sharpest evidence is from tonight's own wind-down: I filed B037 " +
      "before checking whether the report had already landed, and it had. The same shape shows up in " +
      "the two cron failures earlier this week, which is why the count looks worse than it is. " +
      "None of this is narration; it is the answer to the question you asked.";
    const text = `${prose}\n\n## What to change\n\nGate the filing on a disk read.`;
    const r = splitReasoningFromAnswer(text);
    expect(r.reasoning).toBe("");
    expect(r.answer).toContain("you're right");
    expect(r.answer).toContain("What to change");
  });

  it("STILL folds when the head really is working notes", () => {
    const text = `${NARR} ${NARR2} Found the cause.\n\n## Fix\n\nDedup at the boundary.`;
    const r = splitReasoningFromAnswer(text);
    expect(r.reasoning).toContain("Let me check");
    expect(r.answer.startsWith("## Fix")).toBe(true);
  });

  it("handles a working-note stream that ends in a JSON dump without throwing or blanking", () => {
    const text = `${NARR} ${NARR2} {"raw":"claude subprocess exited (SIGTERM)"}`;
    const r = splitReasoningFromAnswer(text);
    expect(typeof r.answer).toBe("string");
    expect(r.answer.length).toBeGreaterThan(0);
  });
});
