import { describe, expect, it } from "vitest";
import { resliceSegments } from "./stream-reslice.js";

const b = (text: string, segStart: number) => ({ text, segStart });

describe("resliceSegments — the happy path still reslices", () => {
  it("grows every bubble when the final is a strict extension of the deltas", () => {
    // Streamed "Hello wor" split across two bubbles; the final completes the word and adds more.
    const out = resliceSegments([b("Hello ", 0), b("wor", 6)], "Hello world. And more.");
    expect(out.texts).toEqual(["Hello ", "world. And more."]);
    expect(out.appendTail).toBeUndefined();
  });

  it("is a no-op when every bubble already equals its slice (idempotent input)", () => {
    const out = resliceSegments([b("Hello ", 0), b("world", 6)], "Hello world");
    expect(out.texts).toEqual(["Hello ", "world"]);
    expect(out.appendTail).toBeUndefined();
  });
});

describe("resliceSegments — THE LAW: text only grows", () => {
  it("keeps every bubble verbatim when the final is SHORTER than the deltas — no '' ever", () => {
    // The proven 2026-07-22 shape: a short envelope re-slicing a longer stream.
    const out = resliceSegments([b("Hello ", 0), b("world, nice to see you", 6)], "Hello world");
    expect(out.texts).toEqual(["Hello ", "world, nice to see you"]);
    expect(out.texts.every((t) => t.length > 0)).toBe(true);
    // Everything the final wants shown is already on screen — appending would duplicate.
    expect(out.appendTail).toBeUndefined();
  });

  it("keeps the shown text and APPENDS a wholly divergent final instead of overwriting", () => {
    const out = resliceSegments([b("The answer is 4.", 0)], "Provider error: quota exhausted");
    expect(out.texts).toEqual(["The answer is 4."]);
    expect(out.appendTail).toBe("Provider error: quota exhausted");
  });

  it("a segStart beyond finalText.length keeps its text — the exact blank-bubble crash", () => {
    const out = resliceSegments([b("A long streamed paragraph.", 500)], "short final");
    expect(out.texts).toEqual(["A long streamed paragraph."]);
    // The final's content is genuinely unseen, so it arrives as an append — never a blank.
    expect(out.appendTail).toBe("short final");
  });

  it("the grok/qwen shape: final carries only the LAST message — earlier bubbles untouched, no blanks, no duplicate", () => {
    // Cumulative deltas placed msg1 at 0, msg2 at 15, msg3 at 31; the final envelope is ONLY msg3.
    const out = resliceSegments(
      [b("First thought. ", 0), b("Second thought. ", 15), b("Final answer.", 31)],
      "Final answer.",
    );
    expect(out.texts).toEqual(["First thought. ", "Second thought. ", "Final answer."]);
    // msg3 is already on screen (a kept bubble IS the final) — appending would show it twice.
    expect(out.appendTail).toBeUndefined();
  });

  it("the grok/qwen shape with a partially-streamed last message: only the missing suffix appends", () => {
    const out = resliceSegments([b("First thought. ", 0), b("Final ans", 15)], "Final answer.");
    expect(out.texts).toEqual(["First thought. ", "Final ans"]);
    expect(out.appendTail).toBe("wer.");
  });
});

describe("resliceSegments — edges", () => {
  it("empty finalText keeps everything and appends nothing", () => {
    expect(resliceSegments([b("kept", 0)], "")).toEqual({ texts: ["kept"] });
  });

  it("empty bubbles array surfaces the whole final as appendTail", () => {
    expect(resliceSegments([], "Hello")).toEqual({ texts: [], appendTail: "Hello" });
    expect(resliceSegments([], "")).toEqual({ texts: [] });
  });

  it("an empty streamed bubble may grow from ''", () => {
    expect(resliceSegments([b("", 0)], "Hi").texts).toEqual(["Hi"]);
  });

  it("INVARIANT SWEEP: every output startsWith its input and never shrinks — hostile geometry included", () => {
    const shapes: [{ text: string; segStart: number }[], string][] = [
      [[b("abc", 0)], "abc def"],
      [[b("abc", 0), b("def", 3)], "abcdef"],
      [[b("abc", 0)], "zz"],
      [[b("abc", 10)], "short"],
      [[b("", 4)], "tiny"],
      [[b("abc", 0), b("def", 3)], ""],
      // negative segStart must not be handed to slice() raw (it would count from the END)
      [[b("abc", -5)], "abcxyz"],
      // out-of-order segStarts must not fabricate text
      [[b("b", 2), b("a", 1)], "xyzw"],
    ];
    for (const [bubbles, final] of shapes) {
      const out = resliceSegments(bubbles, final);
      out.texts.forEach((t, i) => {
        expect(t.startsWith(bubbles[i]!.text)).toBe(true);
        expect(t.length).toBeGreaterThanOrEqual(bubbles[i]!.text.length);
      });
    }
  });
});

describe("resliceSegments — idempotence", () => {
  it("applying the result again changes nothing", () => {
    const bubbles = [b("First thought. ", 0), b("Second", 15)];
    const final = "First thought. Second thought, completed.";
    const once = resliceSegments(bubbles, final);
    const again = resliceSegments(
      once.texts.map((text, i) => ({ text, segStart: bubbles[i]!.segStart })),
      final,
    );
    expect(again.texts).toEqual(once.texts);
    expect(again.appendTail).toEqual(once.appendTail);
  });

  it("once the caller pushes the appendTail bubble, the next pass owes nothing more", () => {
    const bubbles = [b("The answer is 4.", 0)];
    const final = "Provider error: quota exhausted";
    const once = resliceSegments(bubbles, final);
    expect(once.appendTail).toBe(final);
    // The caller anchors the new bubble where the tail begins inside finalText.
    const applied = [...bubbles, b(once.appendTail!, final.length - once.appendTail!.length)];
    const twice = resliceSegments(applied, final);
    expect(twice.texts).toEqual(["The answer is 4.", final]);
    expect(twice.appendTail).toBeUndefined();
  });
});
