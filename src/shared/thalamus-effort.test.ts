import { describe, expect, it } from "vitest";
import { snapToLadder, taskEffort } from "./thalamus-effort.js";
import { isTrivialPrompt, localTaskRead } from "./thalamus-reads.js";
import type { TaskRead } from "./thalamus-v4-types.js";
import { APPENDED_SECTION_MARKERS, userTaskText } from "./user-task-text.js";

const FULL = ["low", "medium", "high", "xhigh", "max"];
const TO_XHIGH = ["low", "medium", "high", "xhigh"];

// Every word is a code cue (7 hits, no rival domain: "logic" is avoided because it is a reason cue).
const CODING = [
  "Refactor the retry handling across src/infra/retry.ts and src/agents/runner.ts, then debug the",
  "flaky unit test in src/infra/retry.test.ts and fix the typescript compile error.",
  "```ts",
  "export async function withRetry() {}",
  "```",
].join("\n");

/** A Jev read with the answers given; everything else is Jev's too, so only `difficulty` decides. */
function jevRead(over: {
  difficulty: 1 | 2 | 3 | 4 | 5;
  kind?: TaskRead["kind"]["value"];
  shape?: TaskRead["shape"]["value"];
  difficultySource?: TaskRead["difficulty"]["source"];
}): TaskRead {
  const jev = <T>(value: T) => ({ value, conf: 0.9, source: "jev" as const });
  return {
    id: "r",
    ts: 0,
    sessionKey: "s",
    kind: jev(over.kind ?? "general"),
    difficulty: { value: over.difficulty, conf: 0.9, source: over.difficultySource ?? "jev" },
    topic: jev("none"),
    urgency: jev("waiting"),
    shape: jev(over.shape ?? "answer"),
    private: false,
  };
}

describe("the trivial tier of the local read", () => {
  it("reads a greeting, an ack or a thanks in the three languages as difficulty 1", () => {
    for (const text of [
      "hello",
      "thanks!",
      "hola",
      "moltes gràcies",
      "bon dia",
      "got it",
      "ok perfect, thanks",
      "de nada",
    ]) {
      expect(isTrivialPrompt(text), text).toBe(true);
      expect(
        localTaskRead({ id: "r", ts: 0, sessionKey: "s", text, private: false }).difficulty.value,
      ).toBe(1);
    }
  });

  it("does not read a short ask as trivial, however it opens", () => {
    for (const text of [
      "What time is it in Tokyo?",
      "hello world program in rust",
      "ok, now fix the bug",
      "thanks, now prove the bound",
      "hi there, can you check the deploy",
      "",
    ]) {
      expect(isTrivialPrompt(text), text).toBe(false);
    }
  });
});

describe("taskEffort", () => {
  it("a greeting runs at low, with no fan-out, whatever the stop suggests", () => {
    for (const text of ["hello", "thanks", "hola"]) {
      const e = taskEffort({ text, ceiling: "max", ladder: FULL });
      expect(e.level, text).toBe("low");
      expect(e.ultracode).toBe(false);
      expect(e.basis).toBe("local");
      expect(e.why).toBe("low: greeting");
    }
  });

  it("a multi-file refactor and debug with paths and a fence is max + ultracode at a max stop", () => {
    const e = taskEffort({ text: CODING, ceiling: "max", ladder: FULL });
    expect(e.level).toBe("max");
    expect(e.ultracode).toBe(true);
    expect(e.why.startsWith("max + ultracode: ")).toBe(true);
    expect(e.why).toContain("refactor");
    expect(e.why).toContain("debug");
  });

  it("the same task at a low stop runs at low and says why there is no fan-out", () => {
    const e = taskEffort({ text: CODING, ceiling: "low", ladder: FULL });
    expect(e.level).toBe("low");
    expect(e.ultracode).toBe(false);
    expect(e.why).toContain("stop caps at low");
    expect(e.why).toContain("no ultracode");
  });

  it("clamps to the rungs the routed model actually has", () => {
    const e = taskEffort({ text: CODING, ceiling: "max", ladder: TO_XHIGH });
    expect(e.level).toBe("xhigh");
    expect(e.ultracode).toBe(true);
    expect(e.why).toContain("ladder stops at xhigh");
    expect(snapToLadder("max", ["low", "high"])).toBe("high");
    expect(snapToLadder("low", ["high"])).toBe("high");
    expect(snapToLadder("low", [])).toBe("");
  });

  it("a model with no effort ladder has nothing to choose", () => {
    const e = taskEffort({ text: CODING, ceiling: "", ladder: [] });
    expect(e.level).toBe("");
    expect(e.ultracode).toBe(false);
    expect(e.why.startsWith("no ladder")).toBe(true);
  });

  it("measures the user's words, not the trailer the UI appends", () => {
    const raw =
      "hello" +
      APPENDED_SECTION_MARKERS[0] +
      " a 🌿 FRACTAL reflection: refactor and debug across the codebase, fix the bug.\n```ts\n```";
    expect(userTaskText(raw)).toBe("hello");
    expect(taskEffort({ text: userTaskText(raw), ceiling: "max", ladder: FULL }).level).toBe("low");
    // The trailer alone would have asked for the fan-out: this is the defect the stripping prevents.
    expect(taskEffort({ text: raw, ceiling: "max", ladder: FULL }).ultracode).toBe(true);
  });

  it("the word ultracode forces max + ultracode when the stop allows it, and only then", () => {
    const text = "ultracode: rename the config key everywhere";
    const open = taskEffort({ text, ceiling: "max", ladder: FULL });
    expect(open).toMatchObject({
      level: "max",
      ultracode: true,
      why: "max + ultracode: asked for ultracode",
    });
    const capped = taskEffort({ text, ceiling: "high", ladder: FULL });
    expect(capped.level).toBe("high");
    expect(capped.ultracode).toBe(false);
    expect(capped.why).toContain("no ultracode below a max stop");
  });

  it("maps a Jev read's difficulty onto the ladder and keeps Jev as the basis", () => {
    const at = (difficulty: 1 | 2 | 3 | 4 | 5, shape?: TaskRead["shape"]["value"]) =>
      taskEffort({ text: "x", read: jevRead({ difficulty, shape }), ceiling: "max", ladder: FULL });
    expect(at(1).level).toBe("low");
    expect(at(2).level).toBe("low");
    expect(at(3).level).toBe("medium");
    expect(at(4).level).toBe("high");
    expect(at(4, "parts").level).toBe("xhigh");
    expect(at(4, "chain").level).toBe("xhigh");
    expect(at(5)).toMatchObject({ level: "max", ultracode: false, basis: "jev" });
  });

  it("a hard, many-part build task from Jev is the fan-out; the same shape in maths is not", () => {
    const code = taskEffort({
      text: "x",
      read: jevRead({ difficulty: 4, kind: "code", shape: "parts" }),
      ceiling: "max",
      ladder: FULL,
    });
    expect(code).toMatchObject({ level: "max", ultracode: true, basis: "jev" });
    const maths = taskEffort({
      text: "x",
      read: jevRead({ difficulty: 4, kind: "maths", shape: "parts" }),
      ceiling: "max",
      ladder: FULL,
    });
    expect(maths).toMatchObject({ level: "xhigh", ultracode: false });
  });

  it("never uses the cautious fallback: a silent Jev hands 'hello' to the local rules, not to high", () => {
    const e = taskEffort({
      text: "hello",
      read: jevRead({ difficulty: 4, difficultySource: "fallback" }),
      ceiling: "max",
      ladder: FULL,
    });
    expect(e).toMatchObject({ level: "low", ultracode: false, basis: "local" });
  });
});
