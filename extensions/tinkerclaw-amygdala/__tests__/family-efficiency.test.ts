import { describe, expect, it } from "vitest";
import { createEfficiencyFamily } from "../src/families/efficiency.js";
import { renderTemplate } from "../src/templates.js";
import type { Response, Seam, Situation } from "../src/types.js";
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

const fam = (stats?: (id: string) => { chosen: number; ok: number } | undefined) =>
  createEfficiencyFamily({ book }, { stats });
const f = fam();

const obs = <T>(value: T) => ({ value, origin: "derived" as const });
const stuck = (n: number, steps = 0): Partial<Situation> => ({
  repeatedErrors: obs(n),
  stepsSinceNewFact: obs(steps),
});
const cands = (n: number): Partial<Situation> => ({
  candidates: obs(
    Array.from({ length: n }, (_v, i) => ({
      id: `proc-${i + 1}`,
      description: "test-description",
    })),
  ),
});
const sit = (seam: Seam, extra: Partial<Situation> = {}) => caseSituation(null, seam, {}, extra);

function renders(r: Response) {
  if (r.kind === "note" || r.kind === "proof")
    expect(() => renderTemplate(r.templateId, r.slots)).not.toThrow();
}

describe("efficiency: futility", () => {
  it("first time: futility note with the count, warning recorded", () => {
    const st = freshState();
    const r = result(f, "post-tool", sit("post-tool", stuck(3)), [V("progress-made", 0)], st);
    expect(r?.response).toMatchObject({ kind: "note", templateId: "futility", slots: { n: 3 } });
    expect(r?.drivers).toEqual(["progress-made"]);
    expect(r?.reasonCode).toBe("futility-warn");
    expect(st.futilityWarnings).toBe(1);
    expect(st.stopTask).toBe(false);
    renders(r!.response);
  });

  it("second time: stop-task note, stopTask set", () => {
    const st = freshState({ futilityWarnings: 1 });
    const r = result(f, "post-tool", sit("post-tool", stuck(4)), [V("progress-made", 0)], st);
    expect(r?.response).toMatchObject({ kind: "note", templateId: "stop-task", slots: {} });
    expect(r?.reasonCode).toBe("futility-stop");
    expect(st.stopTask).toBe(true);
    expect(st.futilityWarnings).toBe(2);
    renders(r!.response);
  });

  it("third time: stays stopped", () => {
    const st = freshState({ futilityWarnings: 2, stopTask: true });
    const r = result(f, "post-tool", sit("post-tool", stuck(5)), [V("progress-made", 0)], st);
    expect(r?.reasonCode).toBe("futility-stop");
    expect(st.stopTask).toBe(true);
    expect(st.futilityWarnings).toBe(2);
  });

  it("no action below three repeats, or when progress is above the cut-off, and no state change", () => {
    const st = freshState();
    expect(
      respond(f, "post-tool", sit("post-tool", stuck(2, 9)), [V("progress-made", 0)], st).kind,
    ).toBe("proceed");
    expect(
      respond(f, "post-tool", sit("post-tool", stuck(3)), [V("progress-made", 1)], st).kind,
    ).toBe("proceed");
    expect(st.futilityWarnings).toBe(0);
  });

  it("skipped verdict is absent", () => {
    const v = { ...V("progress-made", 0), skipped: "error" as const };
    const st = freshState();
    expect(respond(f, "post-tool", sit("post-tool", stuck(6)), [v], st).kind).toBe("proceed");
    expect(st.futilityWarnings).toBe(0);
  });

  it("decide has no side effects", () => {
    const st = freshState();
    const s = sit("post-tool", stuck(3));
    const vs = [V("progress-made", 0)];
    const asked = new Map([["progress-made", book.get("progress-made")!]]);
    f.decide("post-tool", s, vs, st, asked);
    expect(st.futilityWarnings).toBe(0);
    expect(st.stopTask).toBe(false);
  });
});

describe("efficiency: stop-task", () => {
  it("denies every pre-tool call while set", () => {
    for (const tool of ["Bash", "Read", "Write"]) {
      const s = sit("pre-tool", { tool: obs(tool) });
      const r = result(f, "pre-tool", s, [], freshState({ stopTask: true }));
      expect(r?.response).toEqual({ kind: "proof", templateId: "stop-task", slots: {}, needs: [] });
      expect(r?.drivers).toEqual([]);
      expect(r?.reasonCode).toBe("stop-task");
      renders(r!.response);
    }
  });

  it("does nothing when not set", () => {
    expect(respond(f, "pre-tool", sit("pre-tool"), []).kind).toBe("proceed");
  });

  it("the stop seam clears it and has no opinion", () => {
    const st = freshState({ stopTask: true, futilityWarnings: 2 });
    expect(result(f, "stop", sit("stop"), [], st)).toBeNull();
    expect(st.stopTask).toBe(false);
    expect(respond(f, "pre-tool", sit("pre-tool"), [], st).kind).toBe("proceed");
  });
});

describe("efficiency: procedure choice", () => {
  const prompt = (n = 3) => sit("prompt", cands(n));

  it("no record: blended = 0.6 * p + 0.2, suggest", () => {
    const r = result(f, "prompt", prompt(), [V("procedure-choice", "candidate-2", 0.9)]);
    expect(r?.response).toMatchObject({
      kind: "note",
      templateId: "procedure",
      slots: { id: "proc-2", p: "0.74" },
    });
    expect(r?.drivers).toEqual(["procedure-choice"]);
    expect(r?.reasonCode).toBe("procedure-suggest");
    renders(r!.response);
  });

  it("exactly 0.8 loads (boundary)", () => {
    const r = result(f, "prompt", prompt(), [V("procedure-choice", "candidate-1", 1)]);
    expect(r?.reasonCode).toBe("procedure-load");
    expect(r?.response).toMatchObject({ slots: { id: "proc-1", p: "0.80" } });
  });

  it("just under 0.8 suggests", () => {
    const r = result(f, "prompt", prompt(), [V("procedure-choice", "candidate-1", 0.99)]);
    expect(r?.reasonCode).toBe("procedure-suggest");
  });

  it("stats path: a good record loads, a bad record drops the note", () => {
    const good = fam(() => ({ chosen: 4, ok: 3 }));
    const rg = result(good, "prompt", prompt(), [V("procedure-choice", "candidate-1", 0.9)]);
    expect(rg?.reasonCode).toBe("procedure-load");
    expect(rg?.response).toMatchObject({ slots: { p: "0.84" } });
    const bad = fam(() => ({ chosen: 10, ok: 0 }));
    expect(respond(bad, "prompt", prompt(), [V("procedure-choice", "candidate-1", 0.7)]).kind).toBe(
      "proceed",
    );
    const untried = fam(() => ({ chosen: 0, ok: 0 }));
    expect(
      result(untried, "prompt", prompt(), [V("procedure-choice", "candidate-1", 0.9)])?.reasonCode,
    ).toBe("procedure-suggest");
  });

  it("stats are looked up by the mapped candidate id", () => {
    const seen: string[] = [];
    const g = fam((id) => {
      seen.push(id);
      return undefined;
    });
    result(g, "prompt", prompt(), [V("procedure-choice", "candidate-3", 0.9)]);
    expect(seen).toEqual(["proc-3"]);
  });

  it("unknown candidate index: no opinion", () => {
    expect(result(f, "prompt", prompt(2), [V("procedure-choice", "candidate-3", 0.9)])).toBeNull();
  });

  it("none as the best option: no opinion", () => {
    expect(result(f, "prompt", prompt(), [V("procedure-choice", "none", 0.95)])).toBeNull();
  });

  it("skipped verdict is absent", () => {
    const v = { ...V("procedure-choice", "candidate-1", 0.99), skipped: "error" as const };
    expect(result(f, "prompt", prompt(), [v])).toBeNull();
  });

  it("cannot-tell never crosses (p 0.95), and the acting option just below its cut-off does not act", () => {
    expect(result(f, "prompt", prompt(), [V("procedure-choice", "cannot-tell", 0.95)])).toBeNull();
    const below = {
      ...V("procedure-choice", "candidate-1", 0.59),
      probs: { none: 0.41, "candidate-1": 0.59 },
    };
    expect(result(f, "prompt", prompt(), [below])).toBeNull();
  });

  it("progress-made is a score question: cannot-tell does not apply", () => {
    expect(book.get("progress-made")!.type).toBe("score");
  });
});

describe("efficiency: questionsFor", () => {
  it("post-tool asks progress-made only when the counts say stuck", () => {
    expect(f.questionsFor("post-tool", sit("post-tool", stuck(3)), freshState())).toEqual([
      "progress-made",
    ]);
    expect(f.questionsFor("post-tool", sit("post-tool", stuck(0, 8)), freshState())).toEqual([
      "progress-made",
    ]);
    expect(f.questionsFor("post-tool", sit("post-tool", stuck(2, 7)), freshState())).toEqual([]);
  });

  it("prompt asks procedure-choice only with candidates", () => {
    expect(f.questionsFor("prompt", sit("prompt", cands(2)), freshState())).toEqual([
      "procedure-choice",
    ]);
    expect(f.questionsFor("prompt", sit("prompt"), freshState())).toEqual([]);
  });

  it("nothing at pre-tool or stop; request-difficulty is never asked", () => {
    expect(
      f.questionsFor("pre-tool", sit("pre-tool", { ...stuck(9, 9), ...cands(2) }), freshState()),
    ).toEqual([]);
    expect(f.questionsFor("stop", sit("stop", stuck(9, 9)), freshState())).toEqual([]);
    for (const seam of ["prompt", "post-tool"] as const) {
      expect(
        f.questionsFor(seam, sit(seam, { ...stuck(9, 9), ...cands(2) }), freshState()),
      ).not.toContain("request-difficulty");
    }
  });

  it("every id returned exists in the seed file and lists the seam", () => {
    for (const seam of ["prompt", "post-tool"] as const) {
      for (const id of f.questionsFor(
        seam,
        sit(seam, { ...stuck(9, 9), ...cands(2) }),
        freshState(),
      )) {
        const q = book.get(id);
        expect(q, id).toBeDefined();
        expect(q!.seams).toContain(seam);
      }
    }
  });
});

// The recipe case names its candidates in the request, not in a situation field; the replay supplies the list.
const caseExtra: Record<string, Partial<Situation>> = {
  "mc-ef-recipe-by-name": {
    candidates: obs([
      { id: "weekly-report", description: "test-description" },
      { id: "other-recipe", description: "test-description" },
    ]),
  },
};

describe("efficiency: cases replay", () => {
  const replay = (c: ReturnType<typeof loadCaseFile>[number]): Response => {
    const vs = verdictsFromCase(c);
    expect(vs.length, c.id).toBeGreaterThan(0);
    const seam = book.get(vs[0]!.questionId)!.seams[0]!;
    return respond(f, seam, caseSituation(c, seam, {}, caseExtra[c.id] ?? {}), vs);
  };

  const must = loadCaseFile("must-catch", "efficiency");
  const controls = loadCaseFile("controls", "efficiency");
  it("has cases", () => {
    expect(must.length).toBeGreaterThanOrEqual(2);
    expect(controls.length).toBeGreaterThanOrEqual(5);
  });
  for (const c of must) {
    it(`must-catch ${c.id}`, () => {
      const r = replay(c);
      expect(meetsFloor(r, c.mustBeAtLeast!)).toBe(true);
      renders(r);
    });
  }
  for (const c of controls) {
    it(`control ${c.id}`, () => {
      expect(meetsCeiling(replay(c), c.mustBeAtMost!)).toBe(true);
    });
  }
});
