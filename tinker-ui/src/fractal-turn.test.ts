// FORK 2026-10-08 — Fractal as its own turn (fractal-turn.ts).
import { describe, expect, it } from "vitest";
import { stripInjectedFractalDoctrine } from "./fractal-prompt-strip.js";
import {
  armFractalTurn,
  buildFractalTurnMessage,
  FRACTAL_ARM_TTL_MS,
  FRACTAL_DOCTRINE_SEAM_MARKER,
  FRACTAL_GATE_TEXT_MAX,
  FRACTAL_TURN_SEAM,
  FRACTAL_TURN_SEAM_LEGACY,
  fractalGateParams,
  fractalModelFor,
  fractalTriggersLine,
  gateTrailOf,
  parseFractalGateResult,
  replyTextOf,
  fractalParentOf,
  fractalParentRunOfSessionKey,
  fractalRunIdFor,
  fractalSessionKeyFor,
  isFractalRunId,
  takeFractalArm,
  takeFractalArmForTerminal,
  trailDigestLines,
} from "./fractal-turn.js";
import { trailFromStore } from "./fractal-turn.js";
import { CallTimelineStore } from "./panels/call-timeline.js";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("fractal turn — run ids", () => {
  it("round-trips the parent through the run id", () => {
    const id = fractalRunIdFor("abc-123");
    expect(isFractalRunId(id)).toBe(true);
    expect(fractalParentOf(id)).toBe("abc-123");
    expect(isFractalRunId("abc-123")).toBe(false);
    expect(fractalParentOf("abc-123")).toBeNull();
  });
});

describe("fractal turn — arming", () => {
  it("fires once per armed prompt and never for a Fractal run", () => {
    const st = memoryStorage();
    armFractalTurn(st, "r1", "agent:main:tinker:x", 1_000);
    armFractalTurn(st, fractalRunIdFor("r1"), "agent:main:tinker:x", 1_000);
    expect(takeFractalArm(st, "r1", 2_000)).toEqual({
      sessionKey: "agent:main:tinker:x",
      armedAt: 1_000,
    });
    expect(takeFractalArm(st, "r1", 2_000)).toBeNull();
    expect(takeFractalArm(st, fractalRunIdFor("r1"), 2_000)).toBeNull();
  });

  // FORK 2026-10-09 (Fractal v2, charter C1) — the gate reads what the owner typed.
  it("keeps the prompt text in the arm, cut to the gate's limit", () => {
    const st = memoryStorage();
    armFractalTurn(st, "r1", "s", 1_000, `  why did you skip it?${"x".repeat(5_000)}`);
    const arm = takeFractalArm(st, "r1", 2_000);
    expect(arm?.prompt?.startsWith("why did you skip it?")).toBe(true);
    expect(arm?.prompt).toHaveLength(FRACTAL_GATE_TEXT_MAX);
    armFractalTurn(st, "r2", "s", 1_000);
    expect(takeFractalArm(st, "r2", 2_000)).toEqual({ sessionKey: "s", armedAt: 1_000 });
  });

  it("hands a linked follow-up run every prompt it answers, in order", () => {
    const st = memoryStorage();
    armFractalTurn(st, "q1", "s", 1_000, "first");
    armFractalTurn(st, "q2", "s", 1_000, "that's wrong");
    const linked = { kind: "linked", keys: ["q1", "q2"] } as const;
    expect(takeFractalArmForTerminal(st, "follow-1", linked, 2_000)?.prompt).toBe(
      "first\n\nthat's wrong",
    );
  });

  it("drops an arm older than the TTL", () => {
    const st = memoryStorage();
    armFractalTurn(st, "r1", "s", 0);
    expect(takeFractalArm(st, "r1", FRACTAL_ARM_TTL_MS + 1)).toBeNull();
  });

  // 2026-10-09, tinker:mue2cvin: a prompt sent while a turn ran was folded into it, and its early
  // final started a blind Fractal while the turn was still working.
  it("starts nothing on a folded prompt's early final, and keeps its arm", () => {
    const st = memoryStorage();
    armFractalTurn(st, "d24", "agent:main:tinker:x", 1_000);
    const steered = { kind: "prompt", key: "d24", disposition: "steered" } as const;
    expect(takeFractalArmForTerminal(st, "d24", steered, 2_000)).toBeNull();
    expect(takeFractalArm(st, "d24", 2_000)).toEqual({
      sessionKey: "agent:main:tinker:x",
      armedAt: 1_000,
    });
  });

  it("fires a run's own terminal, as before", () => {
    const st = memoryStorage();
    armFractalTurn(st, "f32", "agent:main:tinker:x", 1_000);
    expect(takeFractalArmForTerminal(st, "f32", { kind: "session" }, 2_000)).toEqual({
      sessionKey: "agent:main:tinker:x",
      promptKeys: [],
      armedAt: 1_000,
    });
    expect(takeFractalArmForTerminal(st, "f32", null, 2_000)).toBeNull();
  });

  it("fires a linked follow-up run for the backlogged prompts it answers", () => {
    const st = memoryStorage();
    armFractalTurn(st, "q1", "agent:main:tinker:x", 1_000);
    armFractalTurn(st, "q2", "agent:main:tinker:x", 1_000);
    const linked = { kind: "linked", keys: ["q1", "q2", "q3"] } as const;
    expect(takeFractalArmForTerminal(st, "follow-1", linked, 2_000)).toEqual({
      sessionKey: "agent:main:tinker:x",
      promptKeys: ["q1", "q2"],
      armedAt: 1_000,
    });
    expect(takeFractalArm(st, "q1", 2_000)).toBeNull();
  });
});

describe("fractal turn — the trail digest", () => {
  // 2026-10-09: a rebuild reloaded the page mid-turn; the digest claimed "15 s, No tool calls" for a
  // nine-minute turn, and the Fractal believed it.
  it("says first when the page loaded in the middle of the turn", () => {
    const lines = trailDigestLines(
      { calls: 3, tokensIn: 1, tokensOut: 1, tools: [] },
      { seenFrom: Date.UTC(2026, 9, 9, 12, 59, 0) },
    );
    expect(lines[0]).toMatch(/^- This page loaded in the middle of the turn \(\d\d:\d\d:\d\d\)/);
    expect(lines[0]).toContain("The trail in your context is the full record.");
    expect(lines).toContain("- No tool calls.");
    expect(trailDigestLines(null, { seenFrom: 1 })[1]).toMatch(
      /^- The page recorded no per-call data/,
    );
    expect(trailDigestLines({ calls: 1, tokensIn: 1, tokensOut: 1, tools: [] })[0]).toMatch(
      /^- 1 model call/,
    );
  });

  it("states cost, tools, failures and repeats from the timeline record", () => {
    const store = new CallTimelineStore();
    const T = 1_700_000_000_000;
    store.turnStart("p1", T, "m");
    store.callEvent("p1", { phase: "send", callIndex: 1, t: T + 1_000 }, T + 1_000);
    store.callEvent("p1", { phase: "usage", callIndex: 1, input: 100_000 }, T + 2_000);
    store.callEvent("p1", { phase: "end", callIndex: 1, output: 2_000 }, T + 3_000);
    for (let i = 0; i < 5; i++) {
      store.toolStart("p1", `b${i}`, "Bash", T + 4_000 + i * 1_000, 10);
      store.toolEnd(`b${i}`, T + 4_500 + i * 1_000, i < 2);
    }
    store.toolStart("p1", "w1", "browser", T + 10_000, 10);
    store.toolEnd("w1", T + 50_000, true);
    store.turnEnd("p1", T + 60_000);
    const lines = trailDigestLines(trailFromStore(store, "p1"));
    const text = lines.join("\n");
    // The store infers one model call per tool round (§5.4 fallbacks), so the count is its own.
    expect(text).toMatch(/- \d+ model calls?, 100\.0k tokens sent, 2\.0k back, 1 min/);
    expect(text).toContain("6 tool calls: Bash ×5 (2 failed), browser ×1 (1 failed)");
    expect(text).toContain("3 tool calls failed");
    expect(text).toContain("Repeated 4+ times: Bash ×5");
    expect(text).toContain("Slowest tool call: browser");
  });

  it("says plainly when the page recorded nothing", () => {
    expect(trailDigestLines(null)[0]).toContain("recorded no per-call data");
  });
});

describe("fractal turn — the message", () => {
  const msg = buildFractalTurnMessage({
    ordinal: 7,
    digest: ["- 3 model calls"],
    parentSessionKey: "agent:main:tinker:abc",
    core: "## How this turn works\n\nbody",
    chapters: {
      friction: "## Friction\n\nfix the path",
      correction: "## Correction\n\nname the rule",
    },
    triggers: ["friction", "correction"],
    reasons: ["2 tool calls failed", "the prompt says “why did you”"],
  });

  it("opens with the named agent marker the chat paints blue", () => {
    expect(msg.startsWith("⟦AGENT:🌿 Fractal · prompt 7⟧ ")).toBe(true);
  });

  it("tells the model it runs in the background and where the owner's chat is", () => {
    expect(msg).toContain("running in the BACKGROUND on a copy of that conversation");
    expect(msg).toContain("sessions_history on agent:main:tinker:abc");
    expect(msg).toContain("naming every path you changed and every commit you made");
  });

  // FORK 2026-10-09 (Fractal v2, charter C4).
  it("lays out digest, Triggers line, the new seam, the core, then each trigger's chapter in order", () => {
    expect(msg).toContain(
      "- 3 model calls\n\nTriggers: friction, correction — 2 tool calls failed; the prompt says “why did you”" +
        "\n\n---\n\n⟦FRACTAL-DOCTRINE⟧\n## How this turn works\n\nbody" +
        "\n\n## Friction\n\nfix the path\n\n## Correction\n\nname the rule",
    );
    expect(FRACTAL_TURN_SEAM).toBe(`\n\n---\n\n${FRACTAL_DOCTRINE_SEAM_MARKER}\n`);
    expect(msg).not.toContain("**After your reply, append");
  });

  it("skips a trigger with no chapter and writes no Triggers line when the gate gave none", () => {
    const bare = buildFractalTurnMessage({
      ordinal: 1,
      digest: ["- 1 model call"],
      parentSessionKey: "agent:main:tinker:abc",
      core: "CORE",
      chapters: { delivery: "" },
      triggers: ["delivery"],
      reasons: [],
    });
    expect(bare).toContain("Triggers: delivery\n\n---\n\n⟦FRACTAL-DOCTRINE⟧\nCORE");
    expect(bare.endsWith("CORE")).toBe(true);
    const ungated = buildFractalTurnMessage({
      ordinal: 1,
      digest: ["- 1 model call"],
      parentSessionKey: "agent:main:tinker:abc",
      core: "CORE",
    });
    expect(ungated).not.toContain("Triggers:");
    expect(ungated).toContain("- 1 model call\n\n---\n\n⟦FRACTAL-DOCTRINE⟧\nCORE");
    expect(fractalTriggersLine([], ["Jev: worth high"])).toBe(
      "Why this reflection runs: Jev: worth high",
    );
  });

  it("keeps the trail visible and the doctrine out of the bubble", () => {
    const shown = stripInjectedFractalDoctrine(msg);
    expect(shown).toContain("- 3 model calls");
    expect(shown).toContain("Triggers: friction, correction");
    expect(shown).not.toContain("How this turn works");
    // the seam the 2026-10-08 pages wrote is still exported for the readers of old transcripts
    expect(stripInjectedFractalDoctrine(`hi${FRACTAL_TURN_SEAM_LEGACY} doctrine`)).toBe("hi");
  });
});

describe("fractal turn — the gate (charter C1)", () => {
  function storeWithTurn(): CallTimelineStore {
    const store = new CallTimelineStore();
    const T = 1_700_000_000_000;
    store.turnStart("p1", T, "claude-opus-5-5", "claude-code");
    store.callEvent("p1", { phase: "send", callIndex: 1, t: T + 1_000 }, T + 1_000);
    store.callEvent("p1", { phase: "end", callIndex: 1, output: 2_000 }, T + 3_000);
    for (let i = 0; i < 5; i++) {
      store.toolStart("p1", `b${i}`, "Bash", T + 4_000 + i * 1_000, 10);
      store.toolEnd(`b${i}`, T + 4_500 + i * 1_000, i < 2);
    }
    store.toolStart("p1", "r1", "Read", T + 10_000, 10);
    store.toolEnd("r1", T + 11_000, false);
    store.turnEnd("p1", T + 60_000);
    return store;
  }

  it("builds the C1 params from the timeline, the prompt's head and the reply's tail", () => {
    const params = fractalGateParams({
      store: storeWithTurn(),
      sessionKey: "agent:main:tinker:abc",
      parentRunId: "p1",
      prompt: `  ${"p".repeat(5_000)}`,
      reply: `${"a".repeat(1_000)}${"z".repeat(4_000)}`,
    });
    expect(params.sessionKey).toBe("agent:main:tinker:abc");
    expect(params.parentRunId).toBe("p1");
    expect(params.prompt).toHaveLength(FRACTAL_GATE_TEXT_MAX);
    expect(params.reply).toBe("z".repeat(4_000));
    expect(params.trail).toMatchObject({
      toolCalls: 6,
      toolErrors: 2,
      repeated: ["Bash"],
      tools: [
        { name: "Bash", n: 5, err: 2 },
        { name: "Read", n: 1, err: 0 },
      ],
      durationMs: 60_000,
    });
    expect(params.trail.calls).toBeGreaterThan(0);
    expect(Object.keys(params).toSorted()).toEqual([
      "parentRunId",
      "prompt",
      "reply",
      "sessionKey",
      "trail",
    ]);
  });

  it("sends an all-zero trail when the page recorded nothing", () => {
    const params = fractalGateParams({
      store: new CallTimelineStore(),
      sessionKey: "s",
      parentRunId: "nope",
    });
    expect(params).toEqual({
      sessionKey: "s",
      parentRunId: "nope",
      prompt: "",
      reply: "",
      trail: { calls: 0, toolCalls: 0, toolErrors: 0, repeated: [], tools: [] },
    });
    expect(gateTrailOf(null).tools).toEqual([]);
  });

  it("reads the gate's answer, and refuses what is not one", () => {
    expect(
      parseFractalGateResult({
        fire: true,
        triggers: ["channel", "bogus", "friction", "channel"],
        source: "jev",
        reasons: ["he does not see it", "", 3],
      }),
    ).toEqual({
      fire: true,
      triggers: ["channel", "friction"],
      source: "jev",
      reasons: ["he does not see it"],
    });
    expect(parseFractalGateResult({ fire: false })).toEqual({
      fire: false,
      triggers: [],
      source: "rules",
      reasons: [],
    });
    expect(parseFractalGateResult({ triggers: [] })).toBeNull();
    expect(parseFractalGateResult(null)).toBeNull();
    expect(parseFractalGateResult("fire")).toBeNull();
  });

  it("reads the reply text off a chat final's message", () => {
    expect(
      replyTextOf({
        content: [
          { type: "thinking", thinking: "x" },
          { type: "text", text: "done" },
        ],
      }),
    ).toBe("done");
    expect(replyTextOf({ content: "plain" })).toBe("plain");
    expect(replyTextOf(undefined)).toBe("");
  });
});

describe("fractal turn — the model (charter M2)", () => {
  it("is the chat's pin when there is one, else the route the run actually took", () => {
    const store = new CallTimelineStore();
    store.turnStart("p1", 1, "claude-opus-5-5", "claude-code");
    expect(store.runModel("p1")).toEqual({ model: "claude-opus-5-5", provider: "claude-code" });
    expect(fractalModelFor({ run: store.runModel("p1") })).toBe("claude-code/claude-opus-5-5");
    expect(fractalModelFor({ pin: "openai-codex/gpt-5", run: store.runModel("p1") })).toBe(
      "openai-codex/gpt-5",
    );
    expect(fractalModelFor({ run: store.runModel("nope") })).toBeUndefined();
    expect(fractalModelFor({ run: { model: "claude-code/x", provider: "claude-code" } })).toBe(
      "claude-code/x",
    );
    expect(fractalModelFor({ run: { model: "bare" } })).toBe("bare");
  });

  it("follows a fallback model on the same run, and drops the old provider with it", () => {
    const store = new CallTimelineStore();
    store.turnStart("p1", 1, "claude-opus-5-5", "claude-code");
    store.turnEnd("p1", 2);
    store.turnStart("p1", 3, "gpt-5");
    expect(store.runModel("p1")).toEqual({ model: "gpt-5" });
  });
});

describe("fractal turn — its own session", () => {
  it("runs beside the chat, under the same agent, named by the prompt run", () => {
    expect(fractalSessionKeyFor("agent:main:tinker:abc", "run-1")).toBe("agent:main:fractal:run-1");
    expect(fractalSessionKeyFor("agent:goku:main", "run-2")).toBe("agent:goku:fractal:run-2");
    expect(fractalSessionKeyFor("tinker:abc", "run-3")).toBe("agent:main:fractal:run-3");
  });

  it("reads the prompt run back from that key, and nothing from any other key", () => {
    expect(fractalParentRunOfSessionKey("agent:main:fractal:run-1")).toBe("run-1");
    expect(fractalParentRunOfSessionKey("agent:main:fractal-reflection:run-1")).toBeNull();
    expect(fractalParentRunOfSessionKey("agent:main:tinker:abc")).toBeNull();
    expect(fractalParentRunOfSessionKey("agent:main:fractal:")).toBeNull();
    expect(fractalParentRunOfSessionKey(undefined)).toBeNull();
  });
});
