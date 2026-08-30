import { describe, expect, it } from "vitest";
import { blockKindOf, classifyTailRecover, createBlockKeyTracker } from "./stream.js";

// FORK 2026-08-28 (the architect: "There seems to be a disconnect between what Jarvis
// answers and what is visible in the chat"). Two defects, both measured over one
// 5-hour journald window (35,186 lines).
//
// DEFECT 1 — the two ingest paths keyed the SAME text block differently:
//   • content_block_delta keys on Anthropic's ABSOLUTE index; with extended
//     thinking on, thinking is block 0 and the prose is block 1;
//   • the cumulative `assistant` frame keys on the LOOP POSITION in
//     message.content[], and an in-progress frame OMITS the thinking block — so
//     the same prose sits at position 0.
// text_block_break parse over the window: 1,423 total; 727 same-message; the
// same-message index-transition set was EXACTLY {("1","0"): 727} — no other
// pattern. Against 716 "[duprep] WARN BLOCKED duplicate assistant_cumulative
// emit" in the same window. Rendered-DOM receipt (12:40:52Z, inside #messages):
// one bubble ends "…the classic stale-dist trap - I'll" and the next opens
// "confirm which copy the live UI actually loads." One sentence, two bubbles,
// mid-clause. That is the bug the architect sees.
//
// DEFECT 2 — tail-recover never fired: 130 completed turns, `grep -c
// 'tail-recover'` = 0, because on a tool-loop turn the accumulator (every step's
// narration) is LONGER than result.result (the final answer alone), so both the
// prefix arm and the length arm are false and control fell off the end of the
// `if` with no else and no log.

// The message id from the raw journal sample of the 727 spurious breaks.
const MSG = "msg_011CeV1s23A5QMuu4R6S6Rcn";
const MSG2 = "msg_011CeV1s23A5QMuu4R6S6Rd0";

// The exact sentence the rendered DOM split across two bubbles.
const SPLIT_SENTENCE =
  "the built CSS from 25 Aug still has min(94vh, 780px). That's the classic " +
  "stale-dist trap - I'll confirm which copy the live UI actually loads.";

/**
 * Replays the TWO ingest paths of stream.ts against the REAL key tracker, with
 * the same bookkeeping the handler uses:
 *   • a text_block_break whenever the active text key changes;
 *   • the cumulative arm emits `cumulative.slice(prev.length)` only when
 *     `cumulative.length > prev.length && cumulative.startsWith(prev)`, and only
 *     re-seats the active key on a first-ever delta (`prev === ""`).
 * Only the KEYING is under test — that is where the defect lived, and it is the
 * one input both mechanisms share.
 */
function makeIngest() {
  const keys = createBlockKeyTracker();
  const seen = new Map<string, string>();
  const emits: Array<{ source: string; text: string }> = [];
  const breaks: Array<{ from: string; to: string }> = [];
  let active: string | null = null;

  const visitText = (key: string): void => {
    if (active !== null && active !== key) {
      breaks.push({ from: active, to: key });
    }
    active = key;
  };

  return {
    emits,
    breaks,
    /** message_start + the content_block_start events that announce block types. */
    startMessage(id: string, blocks: Array<{ index: number; type: string }>): void {
      keys.noteMessage(id);
      for (const b of blocks) {
        keys.noteBlockStart(b.index, b.type);
      }
    },
    /** content_block_delta path — carries the ABSOLUTE block index. */
    deltaText(index: number, text: string): void {
      const key = keys.keyForStreamIndex(index, "text");
      visitText(key);
      emits.push({ source: "content_block_delta", text });
      seen.set(key, (seen.get(key) ?? "") + text);
    },
    /** cumulative `assistant` path — carries only a POSITION in content[]. */
    cumulative(id: string, blocks: Array<{ type: string; text?: string }>): void {
      keys.noteMessage(id);
      let nthText = 0;
      let nthThinking = 0;
      for (const b of blocks) {
        const kind = blockKindOf(b.type);
        const key =
          kind === "text"
            ? keys.keyForContentOrdinal("text", nthText++)
            : kind === "thinking"
              ? keys.keyForContentOrdinal("thinking", nthThinking++)
              : "";
        if (kind !== "text" || typeof b.text !== "string") {
          continue;
        }
        const prev = seen.get(key) ?? "";
        if (b.text.length > prev.length && b.text.startsWith(prev)) {
          if (prev === "") {
            visitText(key);
          }
          emits.push({ source: "assistant_cumulative", text: b.text.slice(prev.length) });
          seen.set(key, b.text);
        }
      }
    },
  };
}

describe("DEFECT 1 — one text block, ONE key across both ingest paths", () => {
  it("derives the same key from absolute index 1 and from content position 0", () => {
    const t = createBlockKeyTracker();
    t.noteMessage(MSG);
    // delta path: extended thinking on → thinking is block 0, prose is block 1.
    t.noteBlockStart(0, "thinking");
    t.noteBlockStart(1, "text");
    const deltaKey = t.keyForStreamIndex(1, "text");
    // cumulative path: the in-progress frame OMITS thinking, so the SAME prose
    // is the first (and only) text block in message.content[].
    const cumulativeKey = t.keyForContentOrdinal("text", 0);
    expect(deltaKey).toBe(`${MSG}:text:0`);
    expect(deltaKey).toBe(cumulativeKey);
  });

  it("pins the divergence the fix removes (the literal msg:1 -> msg:0 transition)", () => {
    // What the two paths produced before 2026-08-28 — the ONLY same-message
    // transition observed, 727 times out of 727.
    const t = createBlockKeyTracker();
    t.noteMessage(MSG);
    expect(t.keyFor(1)).toBe(`${MSG}:1`);
    expect(t.keyFor(0)).toBe(`${MSG}:0`);
    expect(t.keyFor(1)).not.toBe(t.keyFor(0));
  });

  it("streams thinking@0 + text@1, then a cumulative frame without thinking: no break, no re-emit", () => {
    const ingest = makeIngest();
    ingest.startMessage(MSG, [
      { index: 0, type: "thinking" },
      { index: 1, type: "text" },
    ]);
    ingest.deltaText(1, SPLIT_SENTENCE);
    // claude-cli's cumulative re-emit of the SAME message, thinking omitted.
    ingest.cumulative(MSG, [{ type: "text", text: SPLIT_SENTENCE }]);

    expect(ingest.breaks).toEqual([]);
    expect(ingest.emits.map((e) => e.source)).toEqual(["content_block_delta"]);
    // The sentence survives whole — one bubble, not two.
    expect(ingest.emits.map((e) => e.text).join("")).toBe(SPLIT_SENTENCE);
  });

  it("still lets the cumulative frame extend a block the delta path started", () => {
    // Not a duplicate: genuinely new tokens must still flow (no throughput cap).
    const ingest = makeIngest();
    ingest.startMessage(MSG, [
      { index: 0, type: "thinking" },
      { index: 1, type: "text" },
    ]);
    ingest.deltaText(1, "Reading the built CSS. ");
    ingest.cumulative(MSG, [{ type: "text", text: "Reading the built CSS. It is stale." }]);

    expect(ingest.breaks).toEqual([]);
    expect(ingest.emits.map((e) => e.text).join("")).toBe("Reading the built CSS. It is stale.");
  });

  it("a GENUINE second text block in the same message DOES break (delta path)", () => {
    const ingest = makeIngest();
    ingest.startMessage(MSG, [
      { index: 0, type: "thinking" },
      { index: 1, type: "text" },
      { index: 2, type: "tool_use" },
      { index: 3, type: "text" },
    ]);
    ingest.deltaText(1, "First, I'll read the built CSS.");
    ingest.deltaText(3, "Confirmed: dist is stale.");

    expect(ingest.breaks).toEqual([{ from: `${MSG}:text:0`, to: `${MSG}:text:1` }]);
  });

  it("a GENUINE second text block in the same message DOES break (cumulative path)", () => {
    const ingest = makeIngest();
    ingest.cumulative(MSG, [{ type: "text", text: "First, I'll read the built CSS." }]);
    ingest.cumulative(MSG, [
      { type: "text", text: "First, I'll read the built CSS." },
      { type: "tool_use" },
      { type: "text", text: "Confirmed: dist is stale." },
    ]);

    expect(ingest.breaks).toEqual([{ from: `${MSG}:text:0`, to: `${MSG}:text:1` }]);
    expect(ingest.emits.map((e) => e.text)).toEqual([
      "First, I'll read the built CSS.",
      "Confirmed: dist is stale.",
    ]);
  });

  it("a new assistant message still breaks (each tool-loop step keeps its own bubble)", () => {
    const ingest = makeIngest();
    ingest.cumulative(MSG, [{ type: "text", text: "Step one narration." }]);
    ingest.cumulative(MSG2, [{ type: "text", text: "Step two narration." }]);

    expect(ingest.breaks).toEqual([{ from: `${MSG}:text:0`, to: `${MSG2}:text:0` }]);
  });

  it("a tool_use block between two texts does NOT consume a text ordinal", () => {
    // The type-scoped ordinal is invariant to blocks the cumulative frame may or
    // may not carry — that invariance is the whole reason it beats an offset.
    const t = createBlockKeyTracker();
    t.noteMessage(MSG);
    t.noteBlockStart(0, "text");
    t.noteBlockStart(1, "tool_use");
    t.noteBlockStart(2, "text");
    expect(t.keyForStreamIndex(2, "text")).toBe(`${MSG}:text:1`);
    expect(t.keyForContentOrdinal("text", 1)).toBe(`${MSG}:text:1`);
  });

  it("resolving the same index twice does not consume two ordinals", () => {
    const t = createBlockKeyTracker();
    t.noteMessage(MSG);
    t.noteBlockStart(1, "text");
    expect(t.keyForStreamIndex(1, "text")).toBe(`${MSG}:text:0`);
    expect(t.keyForStreamIndex(1, "text")).toBe(`${MSG}:text:0`);
  });

  it("resets ordinals when the message changes (indices restart at 0 upstream)", () => {
    const t = createBlockKeyTracker();
    t.noteMessage(MSG);
    t.noteBlockStart(1, "text");
    expect(t.keyForStreamIndex(1, "text")).toBe(`${MSG}:text:0`);
    t.noteMessage(MSG2);
    expect(t.keyForStreamIndex(0, "text")).toBe(`${MSG2}:text:0`);
  });

  it("falls back to the delta's own type when content_block_start was missed", () => {
    const t = createBlockKeyTracker();
    t.noteMessage(MSG);
    expect(t.keyForStreamIndex(0, "thinking")).toBe(`${MSG}:thinking:0`);
    expect(t.keyForStreamIndex(1, "text")).toBe(`${MSG}:text:0`);
  });

  it("blockKindOf counts redacted_thinking as thinking and ignores tool blocks", () => {
    expect(blockKindOf("text")).toBe("text");
    expect(blockKindOf("thinking")).toBe("thinking");
    expect(blockKindOf("redacted_thinking")).toBe("thinking");
    expect(blockKindOf("tool_use")).toBeNull();
    expect(blockKindOf("server_tool_use")).toBeNull();
    expect(blockKindOf(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

// The measured tool-loop shape: the accumulator is every step's narration and is
// LONGER than result.result, which is the final answer alone. Turn
// tinker-sp-c2e8f69c ended final_text_len=5992 with this result_text.
const TOOL_LOOP_NARRATION = [
  "Reading tinker-ui/dist/assets to see which max-height actually shipped.",
  "Grepping the source for min(94vh, 780px) to find who owns the value.",
  "Checking git log on the dist bundle — the built file is dated 25 Aug.",
].join("\n");
const FINAL_ANSWER = "Blocked too. So here's where it stands.";

const VERDICTS = ["prefix", "diverged", "missing", "already-present", "no-result"];

const TURN_SHAPES = [
  { streamed: "", result: "" },
  { streamed: "", result: FINAL_ANSWER },
  { streamed: TOOL_LOOP_NARRATION, result: "" },
  { streamed: TOOL_LOOP_NARRATION, result: FINAL_ANSWER },
  { streamed: `${TOOL_LOOP_NARRATION}\n\n${FINAL_ANSWER}`, result: FINAL_ANSWER },
  { streamed: "Here is the plan: ", result: "Here is the plan: read the CSS, then confirm." },
  { streamed: "Let me check.", result: "X".repeat(400) },
];

describe("DEFECT 2 — tail-recover verdicts (the net that never fired)", () => {
  it("prefix: the result extends what we streamed → append only the tail", () => {
    const streamed = "Here is the plan: ";
    const result = "Here is the plan: read the CSS, then confirm the dist hash.";
    const r = classifyTailRecover({ streamed, result });
    expect(r.verdict).toBe("prefix");
    expect(r.append).toBe(result.slice(streamed.length));
    expect(streamed + r.append).toBe(result);
  });

  it("diverged: the result dwarfs the stream → the stream was a preamble", () => {
    const streamed = "Let me check.";
    const result = "X".repeat(400); // > streamed.length * 2 + 50
    const r = classifyTailRecover({ streamed, result });
    expect(r.verdict).toBe("diverged");
    expect(r.append).toBe(`\n\n${result}`);
  });

  it("missing: the tool-loop shape that fired NEITHER old arm now appends the answer", () => {
    // Both old arms are false here — this is the 114-of-130 shape that fell off
    // the end of the `if` with no log and no recovery.
    expect(FINAL_ANSWER.length).toBeLessThan(TOOL_LOOP_NARRATION.length);
    expect(FINAL_ANSWER.startsWith(TOOL_LOOP_NARRATION)).toBe(false);
    expect(FINAL_ANSWER.length > TOOL_LOOP_NARRATION.length * 2 + 50).toBe(false);

    const r = classifyTailRecover({ streamed: TOOL_LOOP_NARRATION, result: FINAL_ANSWER });
    expect(r.verdict).toBe("missing");
    expect(r.append).toBe(`\n\n${FINAL_ANSWER}`);

    // Nothing the model produced becomes invisible, and nothing already visible
    // is dropped to make it fit.
    const merged = TOOL_LOOP_NARRATION + r.append;
    expect(merged).toContain(TOOL_LOOP_NARRATION);
    expect(merged).toContain(FINAL_ANSWER);
  });

  it("already-present: the answer did stream → do nothing", () => {
    const streamed = `${TOOL_LOOP_NARRATION}\n\n${FINAL_ANSWER}`;
    const r = classifyTailRecover({ streamed, result: FINAL_ANSWER });
    expect(r.verdict).toBe("already-present");
    expect(r.append).toBe("");
  });

  it("no-result: claude-cli sent no result text at all", () => {
    const r = classifyTailRecover({ streamed: TOOL_LOOP_NARRATION, result: "" });
    expect(r.verdict).toBe("no-result");
    expect(r.append).toBe("");
  });

  it("an empty stream recovers the WHOLE result (nothing streamed, everything shown)", () => {
    const r = classifyTailRecover({ streamed: "", result: FINAL_ANSWER });
    expect(r.append).toBe(FINAL_ANSWER);
  });

  it("returns a verdict for EVERY turn shape — so the log line is never conditional", () => {
    // The caller logs `[tail-recover] verdict=…` unguarded, once per turn that
    // reached a result. This pins the other half: the classifier is TOTAL, so
    // there is no turn shape for which there is nothing to log. That is what
    // turns "grep -c tail-recover = 0" from ambiguous into impossible.
    for (const shape of TURN_SHAPES) {
      const r = classifyTailRecover(shape);
      expect(VERDICTS).toContain(r.verdict);
      expect(typeof r.append).toBe("string");
    }
  });

  it("is append-only: it never removes or caps streamed content", () => {
    for (const shape of TURN_SHAPES) {
      const { append } = classifyTailRecover(shape);
      // Whatever is appended is either a suffix of the result (prefix arm) or a
      // separator-prefixed copy of it — never a truncation of the stream.
      const appendIsSafe =
        append === "" || shape.result.endsWith(append) || append.includes(shape.result);
      expect(appendIsSafe).toBe(true);
      expect((shape.streamed + append).startsWith(shape.streamed)).toBe(true);
    }
  });
});
