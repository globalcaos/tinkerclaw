import { describe, expect, it } from "vitest";
import { createPersonalityFamily } from "../src/families/personality.js";
import { renderTemplate } from "../src/templates.js";
import type { Response, Situation, Verdict } from "../src/types.js";
import {
  book,
  caseSituation,
  freshState,
  loadCaseFile,
  meetsCeiling,
  meetsFloor,
  respond,
  result,
  V,
  verdictsFromCase,
} from "./helpers/family-harness.js";

const fam = createPersonalityFamily({ book });

const rec = (exit: number | null, shape: { failed?: boolean; outputLines?: number } = {}) => ({
  value: [
    {
      tool: "Bash",
      argsDigest: "run",
      exit,
      filesWritten: [],
      effects: ["read" as const],
      ts: 1,
      ...shape,
    },
  ],
  origin: "observed" as const,
});

function sit(extra: Partial<Situation> = {}): Situation {
  return caseSituation(null, "post-tool", {}, extra);
}

const target = (path: string) => ({
  value: [{ path, kind: "file" as const, resolvedFrom: `Read ${path}` }],
  origin: "derived" as const,
});

function render(r: Response) {
  if (r.kind === "note") renderTemplate(r.templateId, r.slots);
}

describe("personality: decision table", () => {
  it("surprise at its cut-off: a note naming both sides, observed from the last record", () => {
    const s = sit({
      expectation: { value: "The test suite will pass.", origin: "observed" },
      toolRecord: rec(1),
    });
    const r = result(fam, "post-tool", s, [V("surprise", 2)]);
    expect(r?.response).toEqual({
      kind: "note",
      templateId: "surprise",
      slots: { expected: "The test suite will pass.", observed: "exit 1" },
      channel: "additionalContext",
    });
    expect(r?.drivers).toEqual(["surprise"]);
    expect(r?.reasonCode).toBe("surprise");
    render(r!.response);
  });

  // Cut-off raised to "the opposite" on 2026-10-03: "partly" fired on six steps in a row in one live chat.
  it("surprise at 'partly' (level 1, under the cut-off of 2) does nothing", () => {
    const s = sit({ expectation: { value: "x", origin: "observed" }, toolRecord: rec(0) });
    expect(respond(fam, "post-tool", s, [V("surprise", 1)]).kind).toBe("proceed");
    expect(respond(fam, "post-tool", s, [V("surprise", 0.49)]).kind).toBe("proceed");
  });

  it("observed phrasing: exit N, an error, no output", () => {
    const ex = { value: "y", origin: "observed" as const };
    const slots = (s: Situation) => {
      const r = respond(fam, "post-tool", s, [V("surprise", 2)]);
      if (r.kind !== "note") throw new Error("expected a note");
      render(r);
      return r.slots.observed;
    };
    expect(slots(sit({ expectation: ex, toolRecord: rec(0) }))).toBe("exit 0");
    expect(slots(sit({ expectation: ex, toolRecord: rec(2) }))).toBe("exit 2");
    // 2026-10-03, live: Claude Code's Bash results carry no exit code, so "no exit code = an error" made every
    // surprise note say the result was an error. The record's shape decides now.
    expect(
      slots(sit({ expectation: ex, toolRecord: rec(null, { failed: true, outputLines: 2 }) })),
    ).toBe("an error");
    expect(
      slots(sit({ expectation: ex, toolRecord: rec(null, { failed: false, outputLines: 0 }) })),
    ).toBe("no output");
    expect(
      slots(sit({ expectation: ex, toolRecord: rec(null, { failed: false, outputLines: 3 }) })),
    ).toBe("3 lines of output");
    expect(
      slots(sit({ expectation: ex, toolRecord: rec(null, { failed: false, outputLines: 1 }) })),
    ).toBe("1 line of output");
    expect(slots(sit({ expectation: ex, toolRecord: rec(null) }))).toBe("a result");
    expect(slots(sit({ expectation: ex, toolRecord: { value: [], origin: "observed" } }))).toBe(
      "no output",
    );
  });

  it("novelty at its cut-off: a note (never a hold) naming the first target", () => {
    const s = sit({ targets: target("/work/demo/logs/new.log") });
    const r = result(fam, "post-tool", s, [V("novelty", 0.7)]);
    expect(r?.response).toEqual({
      kind: "note",
      templateId: "novelty",
      slots: { what: "/work/demo/logs/new.log" },
      channel: "additionalContext",
    });
    expect(r?.drivers).toEqual(["novelty"]);
    expect(r?.reasonCode).toBe("novelty");
    render(r!.response);
  });

  it("novelty names the tool when there is no target, and stays quiet under its cut-off", () => {
    const s = sit({ tool: { value: "WebFetch", origin: "observed" } });
    const r = respond(fam, "post-tool", s, [V("novelty", 0.7)]);
    expect(r).toMatchObject({ kind: "note", slots: { what: "WebFetch" } });
    expect(respond(fam, "post-tool", s, [V("novelty", 0.69)]).kind).toBe("proceed");
  });

  it("worth-knowing at its cut-off: a relevant-fact note, and the rationing clock starts", () => {
    const state = freshState({ stepCount: 12 });
    const s = sit({ targets: target("/work/demo/notes/plan.md") });
    const r = result(fam, "post-tool", s, [V("worth-knowing", 3)], state);
    expect(r?.response).toEqual({
      kind: "note",
      templateId: "relevant-fact",
      slots: { fact: "this looks relevant to your goals: /work/demo/notes/plan.md" },
      channel: "additionalContext",
    });
    expect(r?.drivers).toEqual(["worth-knowing"]);
    expect(r?.reasonCode).toBe("worth-knowing");
    expect(state.curiosityStep).toBe(12);
    render(r!.response);
  });

  it("worth-knowing just under its cut-off does nothing and does not start the clock", () => {
    const state = freshState({ stepCount: 12 });
    expect(respond(fam, "post-tool", sit(), [V("worth-knowing", 2)], state).kind).toBe("proceed");
    expect(state.curiosityStep).toBe(-100);
  });

  it("several crossing: surprise > novelty > worth-knowing, one note only", () => {
    const s = sit({
      expectation: { value: "z", origin: "observed" },
      toolRecord: rec(1),
      targets: target("/work/demo/a.txt"),
    });
    const all = [V("surprise", 2), V("novelty", 0.9), V("worth-knowing", 3)];
    expect(result(fam, "post-tool", s, all)?.response).toMatchObject({ templateId: "surprise" });
    expect(result(fam, "post-tool", s, all.slice(1))?.response).toMatchObject({
      templateId: "novelty",
    });
    expect(result(fam, "post-tool", s, all.slice(2))?.response).toMatchObject({
      templateId: "relevant-fact",
    });
  });

  it("an outranked worth-knowing does not spend the rationing clock", () => {
    const state = freshState({ stepCount: 20 });
    const s = sit({ targets: target("/work/demo/a.txt") });
    result(fam, "post-tool", s, [V("novelty", 0.9), V("worth-knowing", 3)], state);
    expect(state.curiosityStep).toBe(-100);
  });

  it("has no opinion at any other seam", () => {
    const vs = [V("surprise", 2), V("novelty", 0.9), V("worth-knowing", 3)];
    for (const seam of ["prompt", "pre-tool", "stop"] as const) {
      const s = caseSituation(null, seam);
      expect(fam.questionsFor(seam, s, freshState({ stepCount: 50 }))).toEqual([]);
      expect(result(fam, seam, s, vs)).toBeNull();
    }
  });

  it("no choice question is read, so cannot-tell does not apply: skipped verdicts are absent", () => {
    const s = sit({
      expectation: { value: "z", origin: "observed" },
      toolRecord: rec(1),
    });
    const skipped: Verdict[] = [
      { ...V("surprise", 2), skipped: "error" },
      { ...V("novelty", 0.95), skipped: "error" },
      { ...V("worth-knowing", 3), skipped: "error" },
    ];
    expect(result(fam, "post-tool", s, skipped)).toBeNull();
  });
});

describe("personality: questionsFor", () => {
  const state = () => freshState({ stepCount: 50 });

  it("surprise only when an expectation was stated", () => {
    const none = fam.questionsFor("post-tool", sit(), state());
    expect(none).not.toContain("surprise");
    const some = fam.questionsFor(
      "post-tool",
      sit({ expectation: { value: "it passes", origin: "observed" } }),
      state(),
    );
    expect(some).toContain("surprise");
  });

  it("habituation: seen 2 asks novelty, seen 3 does not", () => {
    const at = (seen: number) =>
      fam.questionsFor(
        "post-tool",
        sit({
          targets: target("/work/demo/logs/a.log"),
          contextCounts: { value: { seen, alarms: 0 }, origin: "derived" },
        }),
        state(),
      );
    expect(at(2)).toContain("novelty");
    expect(at(3)).not.toContain("novelty");
  });

  // 2026-10-03, first live hour: target-less steps gave notes like "New this session: Bash" and "exec", which tell
  // the agent nothing. Novelty is about a new file, service or place, so it needs a target.
  it("novelty is only asked when the step touches a target", () => {
    const q = (extra: Partial<Situation>) =>
      fam.questionsFor(
        "post-tool",
        sit({ contextCounts: { value: { seen: 0, alarms: 0 }, origin: "derived" }, ...extra }),
        state(),
      );
    expect(q({})).not.toContain("novelty");
    expect(q({ targets: target("/work/demo/logs/io-2.log") })).toContain("novelty");
  });

  it("hurry mutes curiosity", () => {
    const q = fam.questionsFor("post-tool", sit(), freshState({ stepCount: 50, hurry: true }));
    expect(q).not.toContain("worth-knowing");
  });

  it("rationing: 9 steps after the last curiosity note not asked, 10 asked", () => {
    const at = (gap: number) =>
      fam.questionsFor("post-tool", sit(), freshState({ stepCount: 30, curiosityStep: 30 - gap }));
    expect(at(9)).not.toContain("worth-knowing");
    expect(at(10)).toContain("worth-knowing");
  });

  it("every id returned exists in the seed file and lists the seam", () => {
    const s = sit({
      expectation: { value: "it passes", origin: "observed" },
      targets: target("/work/demo/tests/test_a.py"),
    });
    const ids = fam.questionsFor("post-tool", s, state());
    expect(ids).toEqual(["surprise", "novelty", "worth-knowing"]);
    for (const id of ids) {
      const q = book.get(id);
      expect(q, id).toBeTruthy();
      expect(q?.seams).toContain("post-tool");
    }
  });
});

describe("personality: cases replay", () => {
  const mc = loadCaseFile("must-catch", "personality");
  const ctl = loadCaseFile("controls", "personality");

  it("has cases to replay", () => {
    expect(mc.length).toBeGreaterThanOrEqual(3);
    expect(ctl.length).toBeGreaterThanOrEqual(5);
  });

  for (const c of mc) {
    it(`must-catch ${c.id}`, () => {
      const r = respond(fam, "post-tool", caseSituation(c, "post-tool"), verdictsFromCase(c));
      expect(meetsFloor(r, c.mustBeAtLeast!)).toBe(true);
    });
  }

  for (const c of ctl) {
    it(`control ${c.id}`, () => {
      const r = respond(fam, "post-tool", caseSituation(c, "post-tool"), verdictsFromCase(c));
      expect(meetsCeiling(r, c.mustBeAtMost!)).toBe(true);
    });
  }

  it("note-only ceiling: no case ever yields more than a note, and every note renders", () => {
    for (const c of [...mc, ...ctl]) {
      const r = respond(fam, "post-tool", caseSituation(c, "post-tool"), verdictsFromCase(c));
      expect(["proceed", "note"]).toContain(r.kind);
      render(r);
    }
  });
});
