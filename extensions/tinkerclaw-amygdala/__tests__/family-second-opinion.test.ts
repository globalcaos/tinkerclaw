import { describe, expect, it } from "vitest";
import { createSecondOpinionFamily } from "../src/families/second-opinion.js";
import { readSeeds } from "../src/question-book.js";
import { renderTemplate } from "../src/templates.js";
import type { Response, Situation } from "../src/types.js";
import {
  book,
  caseSituation,
  freshState,
  loadCaseFile,
  meetsCeiling,
  meetsFloor,
  respond,
  result,
  seedDir,
  V,
  verdictsFromCase,
} from "./helpers/family-harness.js";

const fam = createSecondOpinionFamily({ book });
const F = <T>(value: T) => ({ value, origin: "observed" as const });
const sit = (seam: "prompt" | "pre-tool" | "post-tool", extra: Partial<Situation> = {}) =>
  caseSituation(null, seam, {}, extra);
const commitment = {
  payer: "user",
  amount: "1 EUR",
  date: null,
  condition: null,
  firmness: "owed",
} as const;

function renders(r: Response) {
  if (r.kind === "note") expect(() => renderTemplate(r.templateId, r.slots)).not.toThrow();
}

describe("enrich", () => {
  const readingsOf = (text: string) => {
    const st = freshState();
    fam.enrich?.("prompt", sit("prompt", { restatement: F(text) }), st);
    return st.readings;
  };
  it("numbered lines become open readings", () => {
    expect(readingsOf("1. first\n2) second")).toEqual([
      { id: "r1", label: "first", status: "open" },
      { id: "r2", label: "second", status: "open" },
    ]);
  });
  it("bulleted lines become open readings, clipped to 80", () => {
    const r = readingsOf(`- ${"a".repeat(200)}\n* b\n• c`);
    expect(r).toHaveLength(3);
    expect(r[0]?.label.length).toBeLessThanOrEqual(80);
  });
  it("a single-line restatement or one bullet adds nothing", () => {
    expect(readingsOf("Send it to Jordi.")).toEqual([]);
    expect(readingsOf("- only one")).toEqual([]);
  });
  it("existing readings are kept", () => {
    const st = freshState({ readings: [{ id: "x", label: "x", status: "open" }] });
    fam.enrich?.("prompt", sit("prompt", { restatement: F("- a\n- b") }), st);
    expect(st.readings).toHaveLength(1);
  });
});

describe("questionsFor", () => {
  it("prompt: the screen when a request exists", () => {
    expect(
      fam.questionsFor("prompt", sit("prompt", { request: F("do it") }), freshState()),
    ).toEqual(["misreading-screen"]);
    expect(fam.questionsFor("prompt", sit("prompt"), freshState())).toEqual([]);
  });
  it("pre-tool: each question only when relevant", () => {
    expect(fam.questionsFor("pre-tool", sit("pre-tool"), freshState())).toEqual([]);
    const s = sit("pre-tool", {
      request: F("r"),
      effectClass: F("send"),
      draftCommitments: F([commitment]),
      standingFacts: F(["f"]),
    });
    expect(fam.questionsFor("pre-tool", s, freshState())).toEqual([
      "commitment-changed",
      "excess-scope",
      "standing-fact-clash",
    ]);
    const read = sit("pre-tool", { request: F("r"), effectClass: F("read") });
    expect(fam.questionsFor("pre-tool", read, freshState())).toEqual([]);
  });
  it("evidence questions only with an open reading, at pre-tool and post-tool", () => {
    const open = freshState({ readings: [{ id: "r1", label: "a", status: "open" }] });
    const done = freshState({ readings: [{ id: "r1", label: "a", status: "confirmed" }] });
    for (const seam of ["pre-tool", "post-tool"] as const) {
      expect(fam.questionsFor(seam, sit(seam), open)).toEqual([
        "reading-confirmed",
        "reading-ruled-out",
      ]);
      expect(fam.questionsFor(seam, sit(seam), done)).toEqual([]);
    }
  });
  it("every id exists in the seed file and lists the seam; purpose-unclear is never asked", () => {
    const seed = {
      questions: readSeeds(seedDir)
        .map((x) => x.question as { id: string; family: string; seams: string[] })
        .filter((q) => q.family === "second-opinion"),
    };
    const st = () => freshState({ readings: [{ id: "r1", label: "a", status: "open" }] });
    const full = {
      request: F("r"),
      effectClass: F("send" as const),
      draftCommitments: F([commitment]),
      standingFacts: F(["f"]),
    };
    for (const seam of ["prompt", "pre-tool", "post-tool"] as const) {
      for (const id of fam.questionsFor(seam, sit(seam, full), st())) {
        expect(id).not.toBe("purpose-unclear");
        const q = seed.questions.find((x) => x.id === id);
        expect(q, id).toBeDefined();
        expect(q?.seams).toContain(seam);
      }
    }
  });
});

describe("observe: risk transitions", () => {
  it("prompt: low to medium when the screen crosses, back to low when not, unchanged when unanswered", () => {
    const st = freshState();
    result(fam, "prompt", sit("prompt"), [V("misreading-screen", 0.9)], st);
    expect(st.misreadingRisk).toBe("medium");
    result(fam, "prompt", sit("prompt"), [V("misreading-screen", 0.3)], st);
    expect(st.misreadingRisk).toBe("low");
    st.misreadingRisk = "high";
    const skipped = { ...V("misreading-screen", 0.9), skipped: "error" as const };
    result(fam, "prompt", sit("prompt"), [skipped], st);
    expect(st.misreadingRisk).toBe("high");
  });
  it("two open readings make the risk high", () => {
    const st = freshState({
      misreadingRisk: "medium",
      readings: [
        { id: "r1", label: "a", status: "open" },
        { id: "r2", label: "b", status: "open" },
      ],
    });
    result(
      fam,
      "pre-tool",
      sit("pre-tool"),
      [V("reading-confirmed", 0.1), V("reading-ruled-out", 0.1)],
      st,
    );
    expect(st.misreadingRisk).toBe("high");
  });
  it("ruling one of two out gives medium, then confirming the last gives low", () => {
    const st = freshState({
      misreadingRisk: "high",
      readings: [
        { id: "r1", label: "a", status: "open" },
        { id: "r2", label: "b", status: "open" },
      ],
    });
    result(fam, "post-tool", sit("post-tool"), [V("reading-ruled-out", 0.9)], st);
    expect(st.readings.map((r) => r.status)).toEqual(["ruled-out", "open"]);
    expect(st.misreadingRisk).toBe("medium");
    result(fam, "post-tool", sit("post-tool"), [V("reading-confirmed", 0.9)], st);
    expect(st.readings.map((r) => r.status)).toEqual(["ruled-out", "confirmed"]);
    expect(st.misreadingRisk).toBe("low");
  });
  it("high to low when one is confirmed and the rest are ruled out", () => {
    const st = freshState({
      misreadingRisk: "high",
      readings: [
        { id: "r1", label: "a", status: "ruled-out" },
        { id: "r2", label: "b", status: "open" },
      ],
    });
    result(fam, "pre-tool", sit("pre-tool"), [V("reading-confirmed", 0.8)], st);
    expect(st.misreadingRisk).toBe("low");
  });
  it("ruled-out wins over confirmed on the same reading", () => {
    const st = freshState({ readings: [{ id: "r1", label: "a", status: "open" }] });
    result(
      fam,
      "pre-tool",
      sit("pre-tool"),
      [V("reading-confirmed", 0.9), V("reading-ruled-out", 0.9)],
      st,
    );
    expect(st.readings[0]?.status).toBe("ruled-out");
  });
  it("no open reading: evidence answers change nothing", () => {
    const st = freshState({ misreadingRisk: "medium" });
    result(fam, "pre-tool", sit("pre-tool"), [V("reading-confirmed", 0.9)], st);
    expect(st.misreadingRisk).toBe("medium");
  });
  it("safety reads the risk after second-opinion at the same step", () => {
    const st = freshState();
    respond(fam, "prompt", sit("prompt", { request: F("r") }), [V("misreading-screen", 0.9)], st);
    expect(st.misreadingRisk).toBe("medium");
  });
});

describe("decide: decision table", () => {
  it("prompt: screen crossing gives the reading-list note", () => {
    const r = result(fam, "prompt", sit("prompt"), [V("misreading-screen", 0.9)]);
    expect(r?.response).toMatchObject({ kind: "note", templateId: "reading-list" });
    expect(r?.drivers).toEqual(["misreading-screen"]);
    expect(r?.reasonCode).toBe("screen-flagged");
    renders(r?.response as Response);
  });
  it("prompt: screen below the cut-off gives no opinion", () => {
    expect(result(fam, "prompt", sit("prompt"), [V("misreading-screen", 0.6)])).toBeNull();
  });
  it("pre-tool: commitment changed asks with restore preselected", () => {
    for (const a of ["dropped-condition", "firmer", "new-commitment"]) {
      const s = sit("pre-tool");
      const r = result(fam, "pre-tool", s, [V("commitment-changed", a)]);
      expect(r?.response).toEqual({
        kind: "ask",
        askId: `commitment-${s.id}`,
        options: [
          { id: "as-drafted", label: "Send it as drafted" },
          { id: "restore", label: "Restore what you asked for" },
          { id: "other", label: "Something else…" },
        ],
        preselect: "restore",
      });
      expect(r?.drivers).toEqual(["commitment-changed"]);
      expect(r?.reasonCode).toBe("commitment-changed");
    }
  });
  it("pre-tool: same commitment is quiet", () => {
    expect(result(fam, "pre-tool", sit("pre-tool"), [V("commitment-changed", "same")])).toBeNull();
  });
  it("pre-tool: excess scope asks with only-asked preselected", () => {
    const r = result(fam, "pre-tool", sit("pre-tool"), [V("excess-scope", 0.9)]);
    expect(r?.response).toMatchObject({
      kind: "ask",
      preselect: "only-asked",
      options: [{ id: "only-asked" }, { id: "go-beyond" }, { id: "other" }],
    });
    expect(r?.drivers).toEqual(["excess-scope"]);
    expect(r?.reasonCode).toBe("excess-scope");
  });
  it("pre-tool: standing-fact clash notes the mapped fact", () => {
    const s = sit("pre-tool", { standingFacts: F(["first fact", "second fact"]) });
    const r = result(fam, "pre-tool", s, [V("standing-fact-clash", "fact-2")]);
    expect(r?.response).toMatchObject({
      kind: "note",
      templateId: "relevant-fact",
      slots: { fact: "the plan contradicts a standing fact: second fact" },
    });
    expect(r?.reasonCode).toBe("standing-fact-clash");
    expect(r?.drivers).toEqual(["standing-fact-clash"]);
    renders(r?.response as Response);
  });
  it("pre-tool: fact index out of range or none is ignored", () => {
    const s = sit("pre-tool", { standingFacts: F(["only"]) });
    expect(result(fam, "pre-tool", s, [V("standing-fact-clash", "fact-2")])).toBeNull();
    expect(result(fam, "pre-tool", s, [V("standing-fact-clash", "none")])).toBeNull();
  });
  it("pre-tool: several at once, ask over note, first in order on a tie", () => {
    const s = sit("pre-tool", { standingFacts: F(["f"]) });
    const both = result(fam, "pre-tool", s, [
      V("standing-fact-clash", "fact-1"),
      V("excess-scope", 0.9),
    ]);
    expect(both?.reasonCode).toBe("excess-scope");
    const tie = result(fam, "pre-tool", s, [
      V("excess-scope", 0.9),
      V("commitment-changed", "firmer"),
    ]);
    expect(tie?.reasonCode).toBe("commitment-changed");
  });
  it("post-tool: no response, evidence only updates state", () => {
    const st = freshState({ readings: [{ id: "r1", label: "a", status: "open" }] });
    expect(
      result(fam, "post-tool", sit("post-tool"), [V("reading-ruled-out", 0.9)], st),
    ).toBeNull();
    expect(st.readings[0]?.status).toBe("ruled-out");
  });
});

describe("cannot-tell and skipped", () => {
  const choiceQs: [string, string, string][] = [
    ["commitment-changed", "firmer", "same"],
    ["standing-fact-clash", "fact-1", "none"],
  ];
  it("cannot-tell at p 0.95 never acts", () => {
    for (const [id] of choiceQs) {
      const s = sit("pre-tool", { standingFacts: F(["f"]) });
      expect(respond(fam, "pre-tool", s, [V(id, "cannot-tell", 0.95)]).kind).toBe("proceed");
    }
  });
  it("the acting option just below its cut-off does not act", () => {
    for (const [id, act, other] of choiceQs) {
      const s = sit("pre-tool", { standingFacts: F(["f"]) });
      const v = V(id, other, 0.41);
      const q = book.get(id);
      const at = q && q.cutoff.kind === "choice" ? q.cutoff.at : 0;
      const probs = { [act]: at - 0.02, [other]: 1 - (at - 0.02) };
      expect(respond(fam, "pre-tool", s, [{ ...v, probs }]).kind).toBe("proceed");
    }
  });
  it("every skipped verdict is absent", () => {
    const skip = (id: string, a: string | number) => ({ ...V(id, a), skipped: "error" as const });
    const s = sit("pre-tool", { standingFacts: F(["f"]) });
    const vs = [
      skip("commitment-changed", "firmer"),
      skip("excess-scope", 0.95),
      skip("standing-fact-clash", "fact-1"),
    ];
    expect(respond(fam, "pre-tool", s, vs).kind).toBe("proceed");
    expect(respond(fam, "prompt", sit("prompt"), [skip("misreading-screen", 0.95)]).kind).toBe(
      "proceed",
    );
  });
});

describe("cases replay", () => {
  const seamOf = (ids: string[]) => {
    const q = book.get(ids[0] ?? "");
    return (q?.seams[0] ?? "pre-tool") as "prompt" | "pre-tool" | "post-tool";
  };
  const run = (c: ReturnType<typeof loadCaseFile>[number]) => {
    const seam = seamOf(Object.keys(c.answers ?? {}));
    const r = respond(fam, seam, caseSituation(c, seam), verdictsFromCase(c));
    renders(r);
    return r;
  };
  const must = loadCaseFile("must-catch", "second-opinion");
  const ctl = loadCaseFile("controls", "second-opinion");
  it("has cases", () => {
    expect(must.length).toBeGreaterThanOrEqual(6);
    expect(ctl.length).toBeGreaterThanOrEqual(5);
  });
  for (const c of must) {
    it(`must-catch ${c.id}`, () => {
      expect(c.answers).toBeDefined();
      expect(meetsFloor(run(c), c.mustBeAtLeast ?? "note")).toBe(true);
    });
  }
  for (const c of ctl) {
    it(`control ${c.id}`, () => {
      expect(meetsCeiling(run(c), c.mustBeAtMost ?? "proceed")).toBe(true);
    });
  }
});
