import { afterEach, describe, expect, it, vi } from "vitest";
import { JEV_MAX_WAIT_MS, type JevTransport } from "../jev/jev.js";
import type { JevVerdict } from "../jev/types.js";
import {
  FRACTAL_GATE_BUDGET_MS,
  buildFractalGateState,
  createFractalGateAsk,
  FRACTAL_GATE_QUESTIONS,
  readFractalJevVerdicts,
  runFractalGate,
} from "./gate-jev.js";

// The gate's Jev half (charter C1): four noul questions and one worth score in one call, through an injected transport
// so nothing touches the network. Whatever Jev does (answers, fails, hangs), the gate answers.

vi.mock("../jev/availability.js", () => ({
  jevToken: () => "tok-test",
  reportJevResult: vi.fn(),
  noteJevBreaker: vi.fn(),
}));

const STAMP = "[Thu 2026-10-09 18:47 GMT+2] ";

function params(over: Record<string, unknown> = {}) {
  return {
    sessionKey: "agent:main:tinker:secret-session",
    parentRunId: "run-xyz",
    prompt: STAMP + "Book a table at 9, mail me at oscar@example.com",
    reply: "Booked. Saved to /home/oscar/notes/booking.md",
    trail: {
      calls: 40,
      toolCalls: 30,
      toolErrors: 0,
      repeated: [],
      tools: [{ name: "exec", n: 30, err: 0 }],
    },
    ...over,
  };
}

function transportAnswering(answers: Record<string, unknown>) {
  const calls: Array<{
    url: string;
    body: any;
    headers: Record<string, string>;
    timeoutMs: number;
  }> = [];
  const t: JevTransport = {
    post: async (url, body, headers, timeoutMs) => {
      calls.push({ url, body, headers, timeoutMs });
      return { status: 200, json: { answers }, ms: 5 };
    },
  };
  return { t, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runFractalGate with Jev", () => {
  // The gate's own race stays at 6 s; the Jev client clamps every call to the owner's 1 s rule (JEV_MAX_WAIT_MS,
  // 2026-10-15), so the transport sees 1 s.
  it("asks the five questions once, on jev-latest at typesafe, within the 1 s Jev rule", async () => {
    const { t, calls } = transportAnswering({
      correction: { noul: 0.1 },
      friction: { noul: 0.2 },
      delivery: { noul: 0.81 },
      channel: { noul: 0.05 },
      worth: { score: 2 },
    });
    const r = await runFractalGate(params(), { ask: createFractalGateAsk({ transport: t }) });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].body.model).toBe("jev-latest");
    expect(calls[0].timeoutMs).toBe(JEV_MAX_WAIT_MS);
    expect(FRACTAL_GATE_BUDGET_MS).toBe(6000);
    expect(Object.keys(calls[0].body.questions).toSorted()).toEqual([
      "channel",
      "correction",
      "delivery",
      "friction",
      "worth",
    ]);
    expect(calls[0].body.questions.worth).toMatchObject({
      type: "score",
      criteria: ["nothing", "small", "clear", "high"],
    });
    expect(r.source).toBe("jev");
    expect(r.triggers).toEqual(["delivery"]);
    expect(r.fire).toBe(true);
    expect(r.probs).toMatchObject({ delivery: 0.81, worth: 2 / 3 });
  });

  it("sends only prompt, reply and trail, redacted, never the session key or run id", async () => {
    const { t, calls } = transportAnswering({ correction: { noul: 0 } });
    await runFractalGate(params(), { ask: createFractalGateAsk({ transport: t }) });
    const sent = JSON.stringify(calls[0].body.state);
    expect(Object.keys(calls[0].body.state).toSorted()).toEqual(["prompt", "reply", "trail"]);
    expect(sent).not.toContain("secret-session");
    expect(sent).not.toContain("run-xyz");
    expect(sent).not.toContain("oscar@example.com");
    expect(calls[0].body.state.prompt.startsWith("[Thu")).toBe(false);
  });

  it("worth clear fires with no trigger; rules triggers still count under Jev", async () => {
    const quiet = transportAnswering({
      correction: { noul: 0.1 },
      friction: { noul: 0.1 },
      delivery: { noul: 0.1 },
      channel: { noul: 0.1 },
      worth: { score: 2 },
    });
    const a = await runFractalGate(
      params({ trail: { calls: 1, toolCalls: 1, toolErrors: 0, repeated: [], tools: [] } }),
      {
        ask: createFractalGateAsk({ transport: quiet.t }),
      },
    );
    expect(a).toMatchObject({ fire: true, triggers: [], source: "jev" });

    const low = transportAnswering({
      correction: { noul: 0.1 },
      friction: { noul: 0.1 },
      delivery: { noul: 0.1 },
      channel: { noul: 0.1 },
      worth: { score: 0 },
    });
    // A short trail: the default 30-call one is a long turn, which always adds delivery since 2026-10-26.
    const b = await runFractalGate(
      params({
        prompt: STAMP + "why did you delete it?",
        trail: { calls: 1, toolCalls: 1, toolErrors: 0, repeated: [], tools: [] },
      }),
      { ask: createFractalGateAsk({ transport: low.t }) },
    );
    expect(b).toMatchObject({ fire: true, triggers: ["correction"], source: "jev" });
  });

  it("a Jev error falls back to the rules", async () => {
    const t: JevTransport = { post: async () => ({ status: 500, json: {}, ms: 3 }) };
    const r = await runFractalGate(params(), { ask: createFractalGateAsk({ transport: t }) });
    expect(r).toMatchObject({ fire: true, triggers: ["delivery"], source: "rules" });
  });

  it("a hung transport is cut at the budget and the Fractal fires (no Jev = always)", async () => {
    vi.useFakeTimers();
    const t: JevTransport = { post: () => new Promise(() => {}) };
    const pending = runFractalGate(
      params({ trail: { calls: 1, toolCalls: 1, toolErrors: 0, repeated: [], tools: [] } }),
      {
        ask: createFractalGateAsk({ transport: t }),
      },
    );
    await vi.advanceTimersByTimeAsync(FRACTAL_GATE_BUDGET_MS);
    await expect(pending).resolves.toMatchObject({ fire: true, source: "rules" });
  });

  it("Jev off: nothing is asked", async () => {
    const ask = vi.fn();
    const r = await runFractalGate(params(), { ask, jevOn: () => false });
    expect(ask).not.toHaveBeenCalled();
    expect(r.source).toBe("rules");
  });

  it("a throwing ask never reaches the caller", async () => {
    const r = await runFractalGate(params(), {
      ask: () => {
        throw new Error("sync boom");
      },
    });
    expect(r.source).toBe("rules");
  });
});

describe("readFractalJevVerdicts", () => {
  const v = (o: Partial<JevVerdict>): JevVerdict => ({
    id: "i",
    situationId: "s",
    questionId: "correction",
    questionVersion: 1,
    type: "noul",
    answer: 0,
    prob: 0,
    confidence: 0,
    cacheHit: false,
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    ts: 0,
    ...o,
  });

  it("skipped verdicts mean Jev did not answer", () => {
    expect(readFractalJevVerdicts([v({ skipped: "timeout" })])).toBeUndefined();
  });

  it("maps the worth score to its level", () => {
    expect(
      readFractalJevVerdicts([v({ questionId: "worth", type: "score", answer: 3, prob: 1 })]),
    ).toEqual({ probs: { worth: 1 }, worth: "high" });
  });
});

describe("buildFractalGateState", () => {
  it("cuts redacted text: prompt keeps its head, reply its tail", () => {
    const state = buildFractalGateState(
      {
        id: "x",
        prompt: { value: "P".repeat(4500) },
        reply: { value: "R".repeat(4500) + "tail" },
        trail: { value: { calls: 1, toolCalls: 1, toolErrors: 0, repeated: [], tools: [] } },
      },
      "/home/oscar",
    );
    expect((state.prompt as string).length).toBe(4000);
    expect((state.reply as string).endsWith("tail")).toBe(true);
  });

  it("every question declares only the three sent fields", () => {
    for (const q of FRACTAL_GATE_QUESTIONS) {
      for (const f of q.fields) {
        expect(["prompt", "reply", "trail"]).toContain(f);
      }
    }
  });
});
