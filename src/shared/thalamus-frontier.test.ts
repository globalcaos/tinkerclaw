import { describe, expect, it } from "vitest";
import { DOMAIN_STRENGTH } from "./domain-strength.generated.js";
import {
  biasPick,
  classifyTaskDomain,
  domainStrengthFor,
  frontierRungsFor,
  paretoFrontier,
  TASK_DOMAINS,
  clampBiasIdx,
  THALAMUS_ANCHOR_KEY,
  THALAMUS_BIAS_GAP,
  SUGGESTION_PRIOR,
  suggestionMoves,
  THALAMUS_DEFAULT_BIAS_IDX,
  thalamusRoute,
  type DomainStrength,
  type FrontierRung,
  type TaskDomain,
  anchorRung,
  anchoredBiasPick,
  modelLineOf,
} from "./thalamus-frontier.js";
import { tokensPerTaskFor } from "./tokens-per-task.js";

// FORK 2026-09-02: picks sit as far up-left as possible, on the top-left outline.
// These tests pin the three properties the
// envelope and the router now share: the frontier is a monotone top-left outline, the
// BIAS dial walks along it, and a task domain can only move the pick to a model with a
// MEASURED advantage.

const rung = (key: string, effort: string, smart: number, cost: number): FrontierRung => ({
  key,
  effort,
  smart,
  cost,
  basis: "measured",
});

const BOARD: FrontierRung[] = [
  rung("a/best", "max", 65, 1.0),
  rung("a/best", "high", 62, 0.5),
  rung("a/best", "low", 55, 0.3),
  rung("b/mid", "max", 60, 0.2),
  rung("b/mid", "low", 50, 0.05),
  rung("c/cheap", "", 45, 0.02),
  rung("d/dear-and-dumb", "", 58, 2.0), // dominated: dearer than everything, dumber than most
  rung("e/same-price-dumber", "", 40, 0.02), // dominated by c/cheap at equal cost
];

describe("frontierRungsFor — a rung's task cost", () => {
  // FIX 2026-09-30 (J19 r2 review, Astra): the rung multiplied EFFORT_COST_MULT into a
  // token ratio whose tokens already carry it, so max cost 4x high instead of 2x and the
  // frontier was drawn on the squared ladder.
  it("counts effort ONCE: two efforts of one model differ by their tokens per task", () => {
    const rungs = frontierRungsFor("claude-code/claude-opus-5", 70, 10);
    const at = (e: string) => rungs.find((r) => r.effort === e)!.cost;
    expect(at("max") / at("high")).toBeCloseTo(
      tokensPerTaskFor("claude-code/claude-opus-5", "max") /
        tokensPerTaskFor("claude-code/claude-opus-5", "high"),
      10,
    );
    expect(at("high")).toBeCloseTo(10, 10); // the reference task at its own price
  });
});

describe("paretoFrontier — the top-left outline", () => {
  it("is cost-ascending with STRICTLY increasing intelligence, and drops every dominated rung", () => {
    const f = paretoFrontier(BOARD);
    for (let i = 1; i < f.length; i++) {
      expect(f[i].cost).toBeGreaterThanOrEqual(f[i - 1].cost);
      expect(f[i].smart).toBeGreaterThan(f[i - 1].smart);
    }
    const keys = f.map((r) => `${r.key}@${r.effort}`);
    expect(keys).not.toContain("d/dear-and-dumb@");
    expect(keys).not.toContain("e/same-price-dumber@");
    // a/best@low (55 at 0.30) is dominated by b/mid@max (60 at 0.20)
    expect(keys).not.toContain("a/best@low");
    expect(keys).toEqual(["c/cheap@", "b/mid@low", "b/mid@max", "a/best@high", "a/best@max"]);
  });

  it("is a function of the SET, not of input order", () => {
    const a = paretoFrontier(BOARD).map((r) => `${r.key}@${r.effort}`);
    const b = paretoFrontier([...BOARD].reverse()).map((r) => `${r.key}@${r.effort}`);
    expect(b).toEqual(a);
  });
});

describe("biasPick — the dial walks the frontier", () => {
  const f = paretoFrontier(BOARD);
  it("at SMART (6) takes the best rung; at FAST (0) the cheapest within 15 points of it", () => {
    expect(biasPick(f, 6)).toMatchObject({ key: "a/best", effort: "max" });
    // best 65 − 15 = 50 → cheapest frontier rung ≥ 50 is b/mid@low (50 at 0.05)
    expect(biasPick(f, 0)).toMatchObject({ key: "b/mid", effort: "low" });
  });
  it("never moves DOWN the frontier as the dial turns right", () => {
    let last = -Infinity;
    for (let i = 0; i < THALAMUS_BIAS_GAP.length; i++) {
      const p = biasPick(f, i)!;
      expect(p.smart).toBeGreaterThanOrEqual(last);
      last = p.smart;
    }
  });
  it("clamps an out-of-range or missing dial to a real stop", () => {
    expect(biasPick(f, 99)).toEqual(biasPick(f, 6));
    expect(biasPick(f, -3)).toEqual(biasPick(f, 0));
    // a missing dial is the middle stop, "default" (2026-10-02; it was smart for one day)
    expect(biasPick(f, undefined)).toEqual(biasPick(f, THALAMUS_DEFAULT_BIAS_IDX));
  });
});

describe("thalamusRoute — the Fugu step: a domain moves the pick only on measured advantage", () => {
  const strengths: Record<string, Partial<Record<TaskDomain, DomainStrength>>> = {
    "a/best": { code: { p: 0.7, n: 5, basis: [] } },
    "b/mid": { code: { p: 0.95, n: 4, basis: [] }, write: { p: 0.72, n: 1, basis: [] } },
  };
  const strengthFor = (key: string, d: TaskDomain) => strengths[key]?.[d];

  it("general = the bias pick, untouched", () => {
    const r = thalamusRoute({ rungs: BOARD, biasIdx: 6, domain: "general", strengthFor })!;
    expect(r.rung).toMatchObject({ key: "a/best", effort: "max" });
    expect(r.rung).toEqual(r.biasRung);
  });

  it("switches to the domain leader inside the band, at its cheapest rung above the floor", () => {
    // bias 3 → floor 60 → bias pick b/mid@max (0.2); band = rungs ≥ 60 within 5x: b/mid@max,
    // a/best@high (0.5), a/best@max (1.0). b/mid leads CODE by 25 points → stays on b/mid@max.
    const r = thalamusRoute({ rungs: BOARD, biasIdx: 3, domain: "code", strengthFor })!;
    expect(r.biasRung).toMatchObject({ key: "b/mid", effort: "max" });
    expect(r.rung).toMatchObject({ key: "b/mid", effort: "max" });
    const r6 = thalamusRoute({ rungs: BOARD, biasIdx: 6, domain: "code", strengthFor })!;
    expect(r6.biasRung).toMatchObject({ key: "a/best", effort: "max" });
    // at SMART the floor is 65: only a/best@max clears it, so no switch is possible
    expect(r6.rung).toMatchObject({ key: "a/best", effort: "max" });
  });

  it("refuses a specialist dearer than DOMAIN_SWITCH_MAX_COST_MULT x the bias pick", () => {
    // bias 0 → floor 50 → bias pick b/mid@low (0.05), cap 0.25. a/best@low (0.3) is 6x and
    // a/best@high (0.5) 10x dearer: even at p0.99 in CODE neither may take a "fast" turn.
    const pricey = (key: string, d: TaskDomain): DomainStrength | undefined =>
      d === "code" && key === "a/best" ? { p: 0.99, n: 5, basis: [] } : undefined;
    const r = thalamusRoute({ rungs: BOARD, biasIdx: 0, domain: "code", strengthFor: pricey })!;
    expect(r.biasRung).toMatchObject({ key: "b/mid", effort: "low" });
    expect(r.rung).toEqual(r.biasRung);
  });

  it("does NOT switch on a gain under the threshold, or to a model with no measurement", () => {
    const close = (key: string, d: TaskDomain): DomainStrength | undefined =>
      d === "code"
        ? key === "a/best"
          ? { p: 0.9, n: 3, basis: [] }
          : key === "b/mid"
            ? { p: 0.95, n: 3, basis: [] }
            : undefined
        : undefined;
    const r = thalamusRoute({ rungs: BOARD, biasIdx: 5, domain: "code", strengthFor: close })!;
    // bias 5 → floor 63.5 → bias pick a/best@max; b/mid does not clear the floor anyway
    expect(r.rung).toMatchObject({ key: "a/best", effort: "max" });
    const r2 = thalamusRoute({ rungs: BOARD, biasIdx: 4, domain: "write", strengthFor })!;
    // floor 62: band = a/best@high, a/best@max; neither has a WRITE measurement → keep
    expect(r2.rung).toEqual(r2.biasRung);
    expect(r2.reason).toContain("no measured strengths");
  });
});

// 2026-10-01: the smart bias is the default and uses the best model for every decision.
describe("the smart stop — the default, and the best model for each decision", () => {
  const SMART_BOARD: FrontierRung[] = [
    rung(THALAMUS_ANCHOR_KEY, "max", 50, 1.0),
    rung("x/top", "max", 58, 1.5),
    rung("y/specialist", "high", 52, 9.0), // dearer than the board's best and dumber overall
    rung("y/specialist", "max", 54, 12.0),
  ];
  const lead = (key: string, d: TaskDomain): DomainStrength | undefined =>
    d !== "code"
      ? undefined
      : key === "y/specialist"
        ? { p: 0.9, n: 4, basis: [] }
        : key === "x/top"
          ? { p: 0.85, n: 4, basis: [] }
          : undefined;

  it("an unset dial is the middle stop, default (the architect, 2026-10-02: it was smart for one day)", () => {
    expect(THALAMUS_DEFAULT_BIAS_IDX).toBe(3);
    expect(clampBiasIdx(undefined)).toBe(THALAMUS_DEFAULT_BIAS_IDX);
    expect(thalamusRoute({ rungs: SMART_BOARD })!.biasIdx).toBe(THALAMUS_DEFAULT_BIAS_IDX);
  });

  it("with no domain it is the smartest model on the board", () => {
    const r = thalamusRoute({
      rungs: SMART_BOARD,
      biasIdx: 6,
      domain: "general",
      strengthFor: lead,
    })!;
    expect(r.rung).toMatchObject({ key: "x/top", effort: "max" });
  });

  it("the measured leader of the task's domain wins whatever it costs, at its strongest effort", () => {
    const r = thalamusRoute({ rungs: SMART_BOARD, biasIdx: 6, domain: "code", strengthFor: lead })!;
    expect(r.biasRung).toMatchObject({ key: "x/top", effort: "max" });
    expect(r.rung).toMatchObject({ key: "y/specialist", effort: "max" });
    expect(r.reason).toContain("switched");
  });

  it("one stop lower keeps the cost cap and the 10-point threshold", () => {
    const r = thalamusRoute({ rungs: SMART_BOARD, biasIdx: 5, domain: "code", strengthFor: lead })!;
    expect(r.rung).toMatchObject({ key: "x/top", effort: "max" });
  });

  it("never drops below the anchor for a specialist", () => {
    const weak = (key: string, d: TaskDomain): DomainStrength | undefined =>
      d === "code" && key === "z/weak" ? { p: 0.99, n: 3, basis: [] } : lead(key, d);
    const r = thalamusRoute({
      rungs: [...SMART_BOARD, rung("z/weak", "", 40, 0.1)],
      biasIdx: 6,
      domain: "code",
      strengthFor: weak,
    })!;
    expect(r.rung.key).toBe("y/specialist");
  });
});

describe("classifyTaskDomain — deterministic, ties go to general", () => {
  it("reads the obvious cues", () => {
    expect(classifyTaskDomain("fix the failing unit test in the typescript build")).toBe("code");
    // MOVED 2026-09-23: proofs and integrals are MATHS now. REASON kept the puzzles,
    // which is what the ARC-AGI / SimpleBench tables it routes on actually measure.
    expect(classifyTaskDomain("prove the theorem and derive the integral")).toBe("maths");
    expect(classifyTaskDomain("draft an email to the landlord, polite tone")).toBe("write");
    expect(
      classifyTaskDomain("my partner is anxious about the argument we had, how do I tell her"),
    ).toBe("psych");
    expect(classifyTaskDomain("what do you see in this screenshot")).toBe("vision");
  });
  // One representative prompt per domain ADDED 2026-09-23. Every capability column in the
  // dossier except SPEED and COST is a TaskDomain, and a domain nothing classifies to is a
  // column that cannot influence routing — which is the whole point of the widening. This
  // test is the proof that each of the seven new ones is reachable from real wording.
  it("reaches every new domain from a representative prompt", () => {
    expect(
      classifyTaskDomain(
        "build a responsive landing page with tailwind css and a dark mode button",
      ),
    ).toBe("frontend");
    expect(
      classifyTaskDomain(
        "pivot this csv into a dashboard of monthly kpi metrics and group by region",
      ),
    ).toBe("data");
    expect(
      classifyTaskDomain(
        "explain the enzyme reaction and the quantum thermodynamics of the experiment",
      ),
    ).toBe("science");
    expect(
      classifyTaskDomain("solve this lateral thinking riddle, it is a classic logic puzzle"),
    ).toBe("reason");
    expect(classifyTaskDomain("translate this into catalan and spanish for a native speaker")).toBe(
      "languages",
    );
    expect(
      classifyTaskDomain("output only bullet points, no more than 20 words, nothing else"),
    ).toBe("instruct");
    expect(
      classifyTaskDomain("who was born in and when did they die, fact check that trivia"),
    ).toBe("factual");
    expect(
      classifyTaskDomain("what is the latest breaking news right now about the stock price today"),
    ).toBe("world");
  });
  // 2026-10-02 verticals: one prompt of the kind the architect actually sends, per column.
  it("classifies the seven 2026-10-02 verticals from real-shaped prompts", () => {
    expect(
      classifyTaskDomain("the nginx service failed after reboot, ssh in and check journalctl"),
    ).toBe("shell");
    expect(
      classifyTaskDomain(
        "fine-tune the yolo object detection model, the loss curve is overfitting",
      ),
    ).toBe("ml");
    expect(
      classifyTaskDomain(
        "design a parametric bracket in openscad with a clearance fit, then 3d print it",
      ),
    ).toBe("cad");
    expect(
      classifyTaskDomain(
        "do a deep research pass: literature review of the state of the art, with references",
      ),
    ).toBe("research");
    expect(
      classifyTaskDomain("prepare the client proposal and a slide deck with an executive summary"),
    ).toBe("office");
    expect(
      classifyTaskDomain(
        "audit this login form for sql injection and xss, then write a pentest report",
      ),
    ).toBe("security");
    expect(
      classifyTaskDomain(
        "what dose of this medicinal plant is safe, any drug interactions or side effects",
      ),
    ).toBe("health");
  });
  it("moved cue words land in their new domain, not in a tie", () => {
    // `terminal|shell|cron` left AGENTIC and `kubernetes` left CODE on 2026-10-02.
    expect(classifyTaskDomain("open a terminal and fix the cron job")).toBe("shell");
    expect(classifyTaskDomain("scale the kubernetes deployment")).not.toBe("general");
  });
  it("every new vertical except health has a measured strength for some family", () => {
    for (const d of ["shell", "ml", "cad", "research", "office", "security"] as const) {
      const measured = Object.values(DOMAIN_STRENGTH).filter((f) => f[d] !== undefined).length;
      expect(measured, d).toBeGreaterThan(5);
    }
  });
  it("every domain in the type is reachable, and TASK_DOMAINS lists them all", () => {
    // A domain that appears in TaskDomain but not in TASK_DOMAINS would be dropped from
    // the dossier's route strip and from the generated strength table without any error.
    expect(TASK_DOMAINS).toContain("frontend");
    expect(TASK_DOMAINS).toContain("data");
    expect(TASK_DOMAINS).toContain("maths");
    expect(TASK_DOMAINS).toContain("science");
    expect(TASK_DOMAINS).toContain("languages");
    expect(TASK_DOMAINS).toContain("instruct");
    expect(TASK_DOMAINS).toContain("factual");
    expect(new Set(TASK_DOMAINS).size).toBe(TASK_DOMAINS.length);
    expect(TASK_DOMAINS).not.toContain("general" as never);
  });
  // A domain with no Epoch table must be a NO-OP, never an error: domainStrengthFor
  // returns undefined and thalamusRoute keeps the bias pick. This is what makes adding
  // a column safe.
  it("an unmeasured domain falls back to the bias pick instead of throwing", () => {
    for (const d of TASK_DOMAINS) {
      expect(() => domainStrengthFor("claude-code/claude-opus-5", d)).not.toThrow();
    }
    const r = thalamusRoute({
      rungs: BOARD,
      biasIdx: 3,
      domain: "languages",
      strengthFor: () => undefined,
    })!;
    expect(r).toBeDefined();
    expect(r.rung).toEqual(r.biasRung);
    expect(r.reason).toContain("no measured strengths in band");
  });
  it("returns general on silence and on a tie", () => {
    expect(classifyTaskDomain("")).toBe("general");
    expect(classifyTaskDomain("ok")).toBe("general");
    expect(classifyTaskDomain("write code")).toBe("general");
  });
});

describe("frontierRungsFor — one route becomes its rungs on the shared tables", () => {
  it("builds Opus 5's five measured rungs priced in €/TASK on the chart's task axis", () => {
    const rungs = frontierRungsFor("claude-code/claude-opus-5", 63.05, 0.0735);
    expect(rungs.map((r) => r.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(rungs.every((r) => r.basis === "measured")).toBe(true);
    // €/task = €/Mtok x tokens(max)/tokens(reference high) = 0.0735 x 3/1.5. The price per
    // token does not change with effort; only the burn does, so the multiplier enters
    // ONCE (2026-09-30 — until then it entered twice and this line pinned 0.0735·3·2).
    expect(rungs.find((r) => r.effort === "max")!.cost).toBeCloseTo(0.0735 * 2);
    expect(rungs.find((r) => r.effort === "high")!.cost).toBeCloseTo(0.0735);
  });
  it("gives a ladderless route one headline rung, and refuses a non-positive price", () => {
    expect(frontierRungsFor("openrouter/qwen/qwen3.8-max", 58, 4)).toHaveLength(1);
    expect(frontierRungsFor("claude-code/claude-opus-5", 63, 0)).toEqual([]);
  });
});

// 2026-10-02 (full deploy): the owner's picks are suggestions — a prior of 10 % of the suggestion's own score.
describe("thalamusRoute — a suggestion is a prior, not a pin", () => {
  const BOARD2: FrontierRung[] = [
    rung("claude-code/opus", "max", 63, 3.0),
    rung("claude-code/opus", "low", 52, 0.8),
    rung("claude-code/sonnet", "low", 50, 0.3),
    rung("claude-code/sonnet", "high", 55, 0.6),
    rung("xai/grok", "", 57, 0.2),
  ];
  const strengths: Record<string, Partial<Record<TaskDomain, DomainStrength>>> = {
    "claude-code/opus": { code: { p: 0.7, n: 5, basis: [] } },
    "claude-code/sonnet": { code: { p: 0.72, n: 5, basis: [] } },
    "xai/grok": { code: { p: 0.95, n: 4, basis: [] }, write: { p: 0.5, n: 3, basis: [] } },
  };
  const strengthFor = (key: string, d: TaskDomain) => strengths[key]?.[d];

  it("the prior is ten percent", () => {
    expect(SUGGESTION_PRIOR).toBe(0.1);
  });

  it("keeps the suggestion at the effort it asked for on a general task, whatever the dial's own pick", () => {
    const r = thalamusRoute({
      rungs: BOARD2,
      biasIdx: 6,
      domain: "general",
      suggestion: { key: "claude-code/sonnet", effort: "low" },
    })!;
    expect(r.biasRung).toMatchObject({ key: "claude-code/opus", effort: "max" });
    expect(r.rung).toMatchObject({ key: "claude-code/sonnet", effort: "low" });
    expect(r.suggestion).toMatchObject({ state: "kept", key: "claude-code/sonnet", effort: "low" });
    expect(r.reason).toContain("nothing task-specific");
  });

  it("takes the suggestion's rung nearest the dial's pick when no effort is named", () => {
    const r = thalamusRoute({
      rungs: BOARD2,
      biasIdx: 6,
      domain: "general",
      suggestion: { key: "claude-code/sonnet" },
    })!;
    expect(r.rung).toMatchObject({ key: "claude-code/sonnet", effort: "high" });
  });

  it("falls to the nearest rung, and says so, when the model has no rung at the effort asked", () => {
    const r = thalamusRoute({
      rungs: BOARD2,
      biasIdx: 3,
      domain: "general",
      suggestion: { key: "claude-code/sonnet", effort: "max" },
    })!;
    expect(r.rung.key).toBe("claude-code/sonnet");
    expect(r.suggestion).toMatchObject({ state: "kept", effortAsked: "max" });
  });

  it("moves off it for a measured domain leader that still wins after the prior", () => {
    // bias 0 band = grok, both sonnets, opus@low. code: opus p0.7 x 1.1 = 0.77; grok p0.95 leads by 36 %
    const r = thalamusRoute({
      rungs: BOARD2,
      biasIdx: 0,
      domain: "code",
      strengthFor,
      suggestion: { key: "claude-code/opus", effort: "low" },
    })!;
    expect(r.rung).toMatchObject({ key: "xai/grok" });
    expect(r.suggestion).toMatchObject({
      state: "moved",
      key: "claude-code/opus",
      effort: "low",
      to: { key: "xai/grok" },
      gainPct: 36,
    });
    expect(r.reason).toContain("p95 against p70 on code strength");
  });

  // 2026-11-13 (owner: if any model is better than the smart stop at a task, route to it). The old test was a
  // bonus of 10 % of the stop's own score, which nothing can beat once the stop sits above p0.91.
  it("at the top stop any measured lead moves it; below it the lead must be ten points", () => {
    expect(suggestionMoves(0.96, 0.99, true)).toBe(true);
    expect(suggestionMoves(0.96, 0.96, true)).toBe(false);
    expect(suggestionMoves(0.96, 0.99, false)).toBe(false);
    expect(suggestionMoves(0.7, 0.8, false)).toBe(true);
  });

  it("the top stop leaves its suggestion for a rival three points ahead, which the 10 % prior never allowed", () => {
    // No anchor rung on this board, so the top stop's floor is the board's best (63): the rival must be as smart.
    const board: FrontierRung[] = [...BOARD2, rung("google/gem", "", 64, 3.5)];
    const near = (key: string, domain: TaskDomain) =>
      domain !== "code"
        ? undefined
        : key === "claude-code/opus"
          ? { p: 0.96, n: 3, basis: [] }
          : key === "google/gem"
            ? { p: 0.99, n: 3, basis: [] }
            : undefined;
    const ask = { key: "claude-code/opus", effort: "max" };
    const top = thalamusRoute({
      rungs: board,
      biasIdx: 6,
      domain: "code",
      strengthFor: near,
      suggestion: ask,
    })!;
    expect(top.suggestion).toMatchObject({ state: "moved", to: { key: "google/gem" } });
    // Below the top stop the same three points are not enough.
    const mid = thalamusRoute({
      rungs: board,
      biasIdx: 3,
      domain: "code",
      strengthFor: near,
      suggestion: ask,
    })!;
    expect(mid.suggestion).toMatchObject({ state: "kept" });
    // A general task has nothing task-specific to move the stop.
    const general = thalamusRoute({
      rungs: board,
      biasIdx: 6,
      domain: "general",
      strengthFor: near,
      suggestion: ask,
    })!;
    expect(general.suggestion).toMatchObject({ state: "kept" });
  });

  it("keeps it when the rival leads by less than the prior", () => {
    // code: sonnet p0.72 against opus p0.7 is a 3 % lead, inside the 10 % prior
    const r = thalamusRoute({
      rungs: BOARD2.filter((x) => x.key !== "xai/grok"),
      biasIdx: 0,
      domain: "code",
      strengthFor,
      suggestion: { key: "claude-code/opus", effort: "low" },
    })!;
    expect(r.rung).toMatchObject({ key: "claude-code/opus", effort: "low" });
    expect(r.suggestion?.state).toBe("kept");
  });

  it("does not treat its own model at another effort as a rival", () => {
    const r = thalamusRoute({
      rungs: BOARD2.filter((x) => x.key !== "xai/grok" && x.key !== "claude-code/sonnet"),
      biasIdx: 0,
      domain: "code",
      strengthFor,
      suggestion: { key: "claude-code/opus", effort: "low" },
    })!;
    expect(r.rung).toMatchObject({ key: "claude-code/opus", effort: "low" });
  });

  it("a suggestion with no measured row for the domain keeps the turn (it is not assumed worse)", () => {
    // 'write': sonnet has no row, grok does. Nothing task-specific says sonnet is worse.
    const r = thalamusRoute({
      rungs: BOARD2,
      biasIdx: 0,
      domain: "write",
      strengthFor,
      suggestion: { key: "claude-code/sonnet", effort: "low" },
    })!;
    expect(r.rung).toMatchObject({ key: "claude-code/sonnet", effort: "low" });
    expect(r.reason).toContain("no measured write strength");
  });

  it("admits a reserved suggestion on its own authority", () => {
    const withFable = [...BOARD2, rung("claude-code/fable", "max", 66, 9)];
    const r = thalamusRoute({
      rungs: withFable,
      biasIdx: 3,
      domain: "general",
      suggestion: { key: "claude-code/fable", effort: "max" },
    })!;
    expect(r.rung.key).toBe("claude-code/fable");
    expect(r.suggestion?.state).toBe("kept");
  });

  it("a suggestion whose model is not on the board changes nothing", () => {
    const plain = thalamusRoute({ rungs: BOARD2, biasIdx: 6, domain: "general" })!;
    const r = thalamusRoute({
      rungs: BOARD2,
      biasIdx: 6,
      domain: "general",
      suggestion: { key: "nobody/model", effort: "max" },
    })!;
    expect(r.rung).toEqual(plain.rung);
    expect(r.suggestion).toBeUndefined();
  });
});

// 2026-11-13: the anchor named Opus 5. Opus 5.5 dominates it, so it left the frontier, no anchor was found, and
// the top stop's floor became the top model's own score: no rival could enter the band. Nothing tested the anchor.
describe("the anchor is a model line, not one version", () => {
  const TODAY: FrontierRung[] = [
    rung("claude-code/claude-haiku-5-5", "high", 30, 0.01),
    rung("xai/grok-4.6", "medium", 44.3, 0.1),
    rung("claude-code/claude-sonnet-5-5", "max", 54.5, 0.2),
    rung("claude-code/claude-opus-5-5", "max", 59.1, 0.41),
    rung(THALAMUS_ANCHOR_KEY, "max", 50.8, 0.52), // the named version: dearer and less smart than its successor
    rung("google/gem-4", "", 60, 0.6),
    rung("claude-code/claude-fable-5-2", "max", 64.6, 0.83),
  ];
  const science = (key: string, d: TaskDomain): DomainStrength | undefined =>
    d !== "science"
      ? undefined
      : key === "claude-code/claude-fable-5-2"
        ? { p: 0.78, n: 1, basis: [] }
        : key === "google/gem-4"
          ? { p: 1, n: 1, basis: [] }
          : undefined;

  it("reads a key's line by dropping its version", () => {
    expect(modelLineOf("claude-code/claude-opus-5")).toBe("claude-code/claude-opus");
    expect(modelLineOf("claude-code/claude-opus-5-5")).toBe("claude-code/claude-opus");
    expect(modelLineOf("openai-codex/gpt-6.1-sol")).toBe("openai-codex/gpt-6.1-sol");
    expect(modelLineOf("xai/grok-4.6")).toBe("xai/grok");
  });

  it("takes the named version when it is on the frontier, else the newest of its line, else none", () => {
    const frontier = paretoFrontier(TODAY);
    expect(frontier.some((r) => r.key === THALAMUS_ANCHOR_KEY)).toBe(false);
    expect(anchorRung(frontier)?.key).toBe("claude-code/claude-opus-5-5");
    // Before its successor (and the Sonnet that also beats it) existed, the named version was the anchor.
    const old = paretoFrontier(TODAY.filter((r) => !/opus-5-5|sonnet-5-5/.test(r.key)));
    expect(anchorRung(old)?.key).toBe(THALAMUS_ANCHOR_KEY);
    expect(
      anchorRung(paretoFrontier(TODAY.filter((r) => !r.key.includes("opus")))),
    ).toBeUndefined();
  });

  it("the stops below smart are measured from that anchor, not from the reserved model", () => {
    const frontier = paretoFrontier(TODAY);
    expect(anchoredBiasPick(frontier, 3)?.key).toBe("claude-code/claude-opus-5-5");
    expect(anchoredBiasPick(frontier, 0)?.key).toBe("xai/grok-4.6"); // cheapest within 15 points of 59.1
    expect(anchoredBiasPick(frontier, 2)?.key).toBe("claude-code/claude-sonnet-5-5"); // within 5 points
  });

  it("at the top stop a rival as smart as the anchor can take the task it is measured better at", () => {
    const r = thalamusRoute({
      rungs: TODAY,
      biasIdx: 6,
      domain: "science",
      strengthFor: science,
      suggestion: { key: "claude-code/claude-fable-5-2", effort: "max" },
    })!;
    expect(r.target).toBe(59.1);
    expect(r.suggestion).toMatchObject({ state: "moved", to: { key: "google/gem-4" } });
    // A rival less smart than the anchor stays out, however strong its one benchmark.
    const weak = TODAY.map((x) => (x.key === "google/gem-4" ? { ...x, smart: 55 } : x));
    const kept = thalamusRoute({
      rungs: weak,
      biasIdx: 6,
      domain: "science",
      strengthFor: science,
      suggestion: { key: "claude-code/claude-fable-5-2", effort: "max" },
    })!;
    expect(kept.suggestion).toMatchObject({ state: "kept" });
  });
});
