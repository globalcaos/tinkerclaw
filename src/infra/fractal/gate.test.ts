import { describe, expect, it } from "vitest";
import {
  decideFractalGate,
  fractalGateFailOpen,
  fractalGateRules,
  matchChannel,
  matchCorrection,
  normalizeFractalGateParams,
  ownerWords,
  type FractalGateParams,
} from "./gate.js";

// The Fractal gate's rules (charter C1): the ship path for a clone with no Jev token, and the half that always counts.
// Prompts below are shaped like real Tinker prompts: a `[Thu … GMT+2]` stamp in front, sometimes a doctrine seam after.

const STAMP = "[Thu 2026-10-09 18:47 GMT+2] ";
const OLD_SEAM =
  "\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** … do it again, still, again …";
const NEW_SEAM = "\n\n---\n\n⟦FRACTAL-DOCTRINE⟧\nRun it again if it still fails.";

function params(over: Partial<FractalGateParams> = {}): FractalGateParams {
  return normalizeFractalGateParams({
    sessionKey: "agent:main:tinker:abc",
    parentRunId: "run-1",
    prompt: "",
    reply: "",
    trail: { calls: 3, toolCalls: 2, toolErrors: 0, repeated: [], tools: [] },
    ...over,
  });
}

describe("correction patterns (EN/ES/CA)", () => {
  it.each([
    "you should have checked the branch first",
    "Why did you restart the gateway?",
    "That's wrong, the file is in workspace",
    "this is not what I asked",
    "I was not asking for a summary",
    "Did you finish the merge?",
    "did you remember to commit",
    "It failed again",
    "it's still broken",
    "Otra vez lo mismo",
    "No es eso, mira el log",
    "¿Por qué has borrado la rama?",
    "deberías haber preguntado",
    "Encara no funciona",
    "T’has oblidat del commit",
    "No és això el que volia",
    "per què has reiniciat?",
  ])("reads %j as a correction", (text) => {
    expect(matchCorrection(STAMP + text)).toBeTruthy();
  });

  it.each([
    "Book a table for two at 9",
    "Write the quarterly summary for Alex",
    "Prepara el correu per al proveïdor",
    "Busca vuelos a Boston para la semana 44",
  ])("leaves %j alone", (text) => {
    expect(matchCorrection(STAMP + text)).toBeUndefined();
  });

  it("never reads the appended doctrine as the owner's words (old and new seam)", () => {
    expect(matchCorrection(STAMP + "Book a table for two" + OLD_SEAM)).toBeUndefined();
    expect(matchCorrection(STAMP + "Book a table for two" + NEW_SEAM)).toBeUndefined();
  });
});

describe("channel patterns (EN/ES/CA)", () => {
  it.each([
    "I don't see the card",
    "can't see the chart",
    "the table does not render",
    "it's not rendering on my phone",
    "I didn't get the email",
    "No veo el botón",
    "no me ha llegado el WhatsApp",
    "No ho veig a la pantalla",
    "no m'ha arribat res",
    "no es veu res",
  ])("reads %j as a channel complaint", (text) => {
    expect(matchChannel(STAMP + text)).toBeTruthy();
  });

  it.each(["do not show the diff, just merge", "Show me the chart", "Envia-ho a la Laia"])(
    "leaves %j alone",
    (text) => {
      expect(matchChannel(STAMP + text)).toBeUndefined();
    },
  );
});

describe("ownerWords", () => {
  it("strips the stamp, the sender header, both seams and HTML comments", () => {
    const sender = 'Sender (untrusted metadata):\n```json\n{"a":1}\n```\n';
    expect(ownerWords(sender + STAMP + "hello <!-- x again -->" + OLD_SEAM)).toBe("hello");
    expect(ownerWords(STAMP + "hola" + NEW_SEAM)).toBe("hola");
  });
});

describe("fractalGateRules", () => {
  it("friction from tool errors or a repeated tool", () => {
    const a = fractalGateRules(
      params({ trail: { calls: 4, toolCalls: 3, toolErrors: 2, repeated: [], tools: [] } }),
    );
    expect(a.triggers).toEqual(["friction"]);
    expect(a.reasons.join(" ")).toContain("2 tool errors");
    const b = fractalGateRules(
      params({ trail: { calls: 9, toolCalls: 8, toolErrors: 0, repeated: ["exec"], tools: [] } }),
    );
    expect(b.triggers).toEqual([]);
    expect(b.weak).toEqual(["friction"]);
    expect(b.reasons.join(" ")).toContain("repeated exec");
  });

  it("a long turn is flagged as longTurn, not a rules trigger", () => {
    const r = fractalGateRules(
      params({ trail: { calls: 30, toolCalls: 25, toolErrors: 0, repeated: [], tools: [] } }),
    );
    expect(r.triggers).toEqual([]);
    expect(r.longTurn).toBe(true);
    expect(
      fractalGateRules(
        params({ trail: { calls: 30, toolCalls: 24, toolErrors: 0, repeated: [], tools: [] } }),
      ).longTurn,
    ).toBe(false);
  });

  it("an agent's prompt is not the owner: no correction or channel from its words", () => {
    const r = fractalGateRules(
      params({ prompt: STAMP + "⟦AGENT:longjob⟧ the job failed again, I don't see output" }),
    );
    expect(r.triggers).toEqual([]);
  });

  it("lists triggers in canonical order", () => {
    const r = fractalGateRules(
      params({
        prompt: STAMP + "Why did you do that? I don't see the chart",
        trail: { calls: 2, toolCalls: 2, toolErrors: 2, repeated: [], tools: [] },
      }),
    );
    expect(r.triggers).toEqual(["correction", "friction", "channel"]);
  });
});

describe("decideFractalGate", () => {
  const quiet = fractalGateRules(params({ prompt: STAMP + "Book a table" }));
  const long = fractalGateRules(
    params({
      prompt: STAMP + "Book a table",
      trail: { calls: 40, toolCalls: 31, toolErrors: 0, repeated: [], tools: [] },
    }),
  );

  it("no Jev: even a quiet turn fires (owner 2026-10-10: Jev only sits on top)", () => {
    const r = decideFractalGate(quiet, undefined);
    expect(r).toMatchObject({ fire: true, triggers: [], source: "rules" });
    expect(r.reasons).toContain("Jev not answering: fires on every turn");
  });

  it("CONTROL: with Jev, a quiet turn Jev finds worth nothing does not fire", () => {
    expect(decideFractalGate(quiet, { probs: { correction: 0.05 }, worth: "nothing" }).fire).toBe(
      false,
    );
  });

  it("rules only: a long turn fires as delivery", () => {
    const r = decideFractalGate(long, undefined);
    expect(r).toMatchObject({ fire: true, triggers: ["delivery"], source: "rules" });
    expect(r.reasons).toContain("long turn: 31 tool calls");
  });

  // 2026-10-26 (the architect): a costly turn always reflects, so Fractal can turn what it figured out into a skill or recipe.
  it("with Jev, a long turn still fires as delivery even when Jev finds it worth nothing", () => {
    const r = decideFractalGate(long, {
      probs: { delivery: 0.2, correction: 0.1 },
      worth: "nothing",
    });
    expect(r).toMatchObject({ fire: true, triggers: ["delivery"], source: "jev" });
    expect(r.reasons).toContain("long turn: 31 tool calls");
    expect(r.probs).toEqual({ delivery: 0.2, correction: 0.1 });
  });

  it("CONTROL: with Jev, a 24-call turn Jev finds worth nothing does not fire", () => {
    const short = fractalGateRules(
      params({
        prompt: STAMP + "Book a table",
        trail: { calls: 30, toolCalls: 24, toolErrors: 0, repeated: [], tools: [] },
      }),
    );
    expect(decideFractalGate(short, { probs: { delivery: 0.2 }, worth: "nothing" }).fire).toBe(
      false,
    );
  });

  it("a partial Jev answer with no delivery read keeps the long-turn rule", () => {
    const r = decideFractalGate(long, { probs: { correction: 0.1 } });
    expect(r).toMatchObject({ fire: true, triggers: ["delivery"], source: "jev" });
  });

  it("Jev adds triggers at 0.4 and above; rules still count", () => {
    const rules = fractalGateRules(
      params({
        prompt: STAMP + "x",
        trail: { calls: 2, toolCalls: 2, toolErrors: 2, repeated: [], tools: [] },
      }),
    );
    const r = decideFractalGate(rules, { probs: { delivery: 0.4, channel: 0.39, friction: 0.1 } });
    expect(r.triggers).toEqual(["friction", "delivery"]);
    expect(r.fire).toBe(true);
    expect(r.reasons).toContain("Jev: delivery 0.40");
  });

  // FORK 2026-10-09 — weak evidence: a bare "still"/"again"/"encara", or one tool error, fires alone only when Jev is
  // not there to ask; with Jev it needs Jev at JEV_WEAK_CONFIRM_PROB.
  it("weak evidence fires without Jev, and with Jev only when Jev agrees at 0.25", () => {
    const weakRules = fractalGateRules(
      params({
        prompt: STAMP + "Is it still running?",
        trail: { calls: 2, toolCalls: 2, toolErrors: 1, repeated: [], tools: [] },
      }),
    );
    expect(weakRules.triggers).toEqual([]);
    expect(weakRules.weak).toEqual(["correction", "friction"]);
    expect(decideFractalGate(weakRules, undefined).triggers).toEqual(["correction", "friction"]);
    const doubted = decideFractalGate(weakRules, {
      probs: { correction: 0.1, friction: 0.24 },
      worth: "nothing",
    });
    expect(doubted.fire).toBe(false);
    const agreed = decideFractalGate(weakRules, { probs: { correction: 0.3, friction: 0.1 } });
    expect(agreed.triggers).toEqual(["correction"]);
    expect(agreed.fire).toBe(true);
  });

  it("a repeated tool alone is weak friction (2026-10-10: 4 Bash calls fired it)", () => {
    const r = fractalGateRules(
      params({
        prompt: STAMP + "Keep the threshold low",
        trail: { calls: 5, toolCalls: 4, toolErrors: 0, repeated: ["Bash"], tools: [] },
      }),
    );
    expect(r.triggers).toEqual([]);
    expect(r.weak).toEqual(["friction"]);
    expect(decideFractalGate(r, { probs: { friction: 0.2 } }).triggers).toEqual([]);
  });

  it("a strong correction still counts whatever Jev says", () => {
    const strong = fractalGateRules(params({ prompt: STAMP + "Why did you skip the tests?" }));
    expect(strong.triggers).toEqual(["correction"]);
    expect(decideFractalGate(strong, { probs: { correction: 0.05 }, worth: "nothing" }).fire).toBe(
      true,
    );
  });

  it("worth clear or high fires with no trigger; small does not", () => {
    expect(decideFractalGate(quiet, { probs: { worth: 0.67 }, worth: "clear" }).fire).toBe(true);
    expect(decideFractalGate(quiet, { probs: { worth: 1 }, worth: "high" }).fire).toBe(true);
    expect(decideFractalGate(quiet, { probs: { worth: 0.33 }, worth: "small" }).fire).toBe(true);
  });

  it("fail-open answer", () => {
    expect(fractalGateFailOpen(new Error("boom"))).toEqual({
      fire: true,
      triggers: [],
      source: "rules",
      reasons: ["gate error: boom"],
    });
  });
});

describe("normalizeFractalGateParams", () => {
  it("never throws on junk and cuts prompt head and reply tail to 4000", () => {
    expect(normalizeFractalGateParams(null).trail).toEqual({
      calls: 0,
      toolCalls: 0,
      toolErrors: 0,
      repeated: [],
      tools: [],
    });
    const p = normalizeFractalGateParams({
      prompt: "a".repeat(5000) + "END",
      reply: "START" + "b".repeat(5000),
      trail: { toolErrors: "3", repeated: [1, "exec"], tools: [{ name: "exec", n: 2 }, { n: 1 }] },
    });
    expect(p.prompt.length).toBe(4000);
    expect(p.prompt.endsWith("END")).toBe(false);
    expect(p.reply.length).toBe(4000);
    expect(p.reply.startsWith("START")).toBe(false);
    expect(p.trail.toolErrors).toBe(0);
    expect(p.trail.repeated).toEqual(["exec"]);
    expect(p.trail.tools).toEqual([{ name: "exec", n: 2, err: 0 }]);
  });
});
