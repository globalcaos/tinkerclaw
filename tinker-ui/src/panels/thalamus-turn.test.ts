import { describe, expect, it } from "vitest";
import type { EegSample, EegTurnEnd } from "./eeg-trace.js";
import {
  buildThalamusTurnView,
  presentTurnSamples,
  renderThalamusTurn,
  type ThalamusTurnDecision,
} from "./thalamus-turn.js";

const s = (o: Partial<EegSample> & { runId: string; startedAt: number }): EegSample => ({
  model: "claude-opus-5",
  provider: "anthropic",
  chosenLevel: "high",
  subagent: false,
  ...o,
});

const ends: EegTurnEnd[] = [
  { turn: 1, runId: "r1", endedAt: 1_000 },
  { turn: 2, runId: "r2", endedAt: 2_000 },
];

const opts = {
  modelName: (id: string) =>
    id.includes("opus")
      ? "Opus 5"
      : id.includes("grok")
        ? "Grok 4.7"
        : id.includes("haiku")
          ? "Haiku 4.5"
          : id,
  colorOf: () => "#E8702A",
  idle: false,
  modelPinned: false,
};

const decision = (o: Partial<ThalamusTurnDecision> = {}): ThalamusTurnDecision => ({
  at: 2_100,
  model: "claude-code/claude-opus-5",
  effort: "high",
  tier: "default",
  why: ["bias"],
  declined: [],
  domain: "general",
  subject: "none",
  mode: "solo",
  panel: [],
  ...o,
});

describe("presentTurnSamples", () => {
  it("a turn in flight is everything after the last turn end", () => {
    const r = presentTurnSamples(
      [
        s({ runId: "old", startedAt: 1_500, endedAt: 1_900 }),
        s({ runId: "now", startedAt: 2_100 }),
      ],
      ends,
    );
    expect(r.samples.map((x) => x.runId)).toEqual(["now"]);
    expect(r.live).toBe(true);
    expect(r.since).toBe(2_000);
  });

  it("between turns it is the last finished turn, never older ones", () => {
    const r = presentTurnSamples(
      [
        s({ runId: "t1", startedAt: 500, endedAt: 900 }),
        s({ runId: "t2", startedAt: 1_500, endedAt: 1_900 }),
      ],
      ends,
    );
    expect(r.samples.map((x) => x.runId)).toEqual(["t2"]);
    expect(r.live).toBe(false);
    expect(r.since).toBe(1_000);
  });
});

describe("buildThalamusTurnView", () => {
  it("lists every model with its part; tools are counted, not listed", () => {
    const v = buildThalamusTurnView(
      {
        samples: [
          s({ runId: "main", startedAt: 2_100, outputTokens: 9_000 }),
          s({
            runId: "sub",
            startedAt: 2_200,
            subagent: true,
            model: "claude-haiku-4-5",
            chosenLevel: "low",
            label: "scan the logs",
            outputTokens: 1_000,
            endedAt: 2_400,
          }),
          s({ runId: "t", startedAt: 2_300, tool: true, model: "tool:bash" }),
        ],
        ends,
      },
      undefined,
    );
    expect(v.members.map((m) => [m.model, m.role, m.task ?? ""])).toEqual([
      ["claude-opus-5", "main", ""],
      ["claude-haiku-4-5", "subagent", "scan the logs"],
    ]);
    expect(v.tools).toBe(1);
    expect(v.live).toBe(true);
  });

  it("a decision from an earlier turn is not this turn's", () => {
    const v = buildThalamusTurnView(
      { samples: [s({ runId: "main", startedAt: 2_100 })], ends },
      {
        decision: decision({ at: 1_500 }),
        fallbacks: [{ at: 1_600, from: "a", to: "b", reason: "timeout" }],
      },
    );
    expect(v.decision).toBeUndefined();
    expect(v.fallbacks).toEqual([]);
  });
});

describe("renderThalamusTurn", () => {
  const view = (dec?: ThalamusTurnDecision, extra: EegSample[] = []) =>
    buildThalamusTurnView(
      { samples: [s({ runId: "main", startedAt: 2_100, outputTokens: 12_000 }), ...extra], ends },
      { decision: dec, fallbacks: [] },
    );

  it("says plainly when the model and the effort are both fixed", () => {
    const html = renderThalamusTurn(view(), { ...opts, idle: true });
    expect(html).toContain("nothing to decide");
    expect(html).not.toContain("thal-row");
  });

  it("names a censorship skip and the subject", () => {
    const html = renderThalamusTurn(
      view(
        decision({
          model: "xai/grok-4.7",
          why: ["bias", "censorship"],
          subject: "medical",
          declined: [
            { model: "claude-code/claude-opus-5@high", detail: "claude declined medical work 3×" },
          ],
        }),
      ),
      opts,
    );
    expect(html).toContain("picked");
    expect(html).toContain("Grok 4.7");
    expect(html).toContain("skipped Opus 5: it declines medical questions");
  });

  it("names a best-of switch and what it replaced", () => {
    const html = renderThalamusTurn(
      view(
        decision({
          why: ["best-of"],
          domain: "code",
          instead: { model: "claude-code/claude-haiku-4-5", effort: "medium" },
        }),
      ),
      opts,
    );
    expect(html).toContain("best at code, instead of Haiku 4.5 · med");
  });

  it("says the suggestion was kept", () => {
    const html = renderThalamusTurn(
      view(
        decision({
          why: ["kept"],
          suggestion: { state: "kept", model: "claude-code/claude-opus-5", effort: "high" },
        }),
      ),
      opts,
    );
    expect(html).toContain("kept your default suggestion");
  });

  it("says a suggestion moved, to what and why: a better rung, or a job it cannot take", () => {
    const better = renderThalamusTurn(
      view(
        decision({
          why: ["moved"],
          domain: "code",
          instead: { model: "claude-code/claude-haiku-4-5", effort: "low" },
          suggestion: {
            state: "moved",
            model: "claude-code/claude-haiku-4-5",
            effort: "low",
            cause: "better",
            gainPct: 102.4,
          },
        }),
      ),
      opts,
    );
    expect(better).toContain(
      "moved off your default suggestion (Haiku 4.5 · low): code is better served here (+102 %)",
    );
    const capacity = renderThalamusTurn(
      view(
        decision({
          why: ["moved"],
          instead: { model: "claude-code/claude-haiku-4-5", effort: "" },
          suggestion: {
            state: "moved",
            model: "claude-code/claude-haiku-4-5",
            effort: "",
            cause: "capacity",
          },
        }),
      ),
      opts,
    );
    expect(capacity).toContain(
      "moved off your default suggestion (Haiku 4.5): it does not fit this job",
    );
  });

  it("says a supply is cooling and until when, or just that it is cooling when no end is known", () => {
    const withEnd = renderThalamusTurn(
      view(
        decision({
          why: ["cooling"],
          instead: { model: "claude-code/claude-opus-5", effort: "high" },
          cooling: {
            from: { model: "claude-code/claude-opus-5", effort: "high" },
            supply: "claude-code",
            untilMs: 5_000,
          },
        }),
      ),
      { ...opts, clock: (ms: number) => `t${ms}` },
    );
    expect(withEnd).toContain("Opus 5 is cooling until t5000, so the next best runs");
    const noEnd = renderThalamusTurn(
      view(
        decision({
          why: ["cooling"],
          cooling: {
            from: { model: "claude-code/claude-opus-5", effort: "high" },
            supply: "claude-code",
          },
        }),
      ),
      opts,
    );
    expect(noEnd).toContain("Opus 5 is cooling, so the next best runs");
    expect(noEnd).not.toContain("until");
  });

  it("shows cooperation: two models, each with its part, the bar sized by work", () => {
    const html = renderThalamusTurn(
      view(decision(), [
        s({
          runId: "sub",
          startedAt: 2_200,
          subagent: true,
          model: "claude-haiku-4-5",
          chosenLevel: "low",
          label: "review the diff",
          outputTokens: 3_000,
          endedAt: 2_500,
        }),
      ]),
      opts,
    );
    expect(html).toContain("2 models worked on this turn");
    expect(html).toContain("main reply");
    expect(html).toContain("review the diff");
    expect(html).toContain("width:100%");
    expect(html).toContain("width:25%");
    expect(html).toContain("is-running");
  });

  it("explains a mid-turn takeover in words", () => {
    const v = buildThalamusTurnView(
      { samples: [s({ runId: "main", startedAt: 2_100 })], ends },
      {
        decision: decision(),
        fallbacks: [
          {
            at: 2_200,
            from: "claude-code/claude-opus-5",
            to: "xai/grok-4.7",
            reason: "overloaded",
          },
        ],
      },
    );
    expect(renderThalamusTurn(v, opts)).toContain("Grok 4.7 took over: Opus 5 was overloaded");
  });

  it("escapes a subagent task", () => {
    const html = renderThalamusTurn(
      view(decision(), [
        s({ runId: "x", startedAt: 2_200, subagent: true, label: "<img onerror=1>" }),
      ]),
      opts,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
