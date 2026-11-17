import { describe, expect, it } from "vitest";
import { TurnContexts } from "../src/context.js";
import { decide, vitalStop, type DecideDeps, type DecideInput } from "../src/decide.js";
import type { Family } from "../src/families/types.js";
import { QuestionBook } from "../src/question-book.js";
import { AmygdalaStore } from "../src/store.js";
import type { Question, Response, Situation, TurnKind, Verdict } from "../src/types.js";

// 2026-11-13. A hold or an ask waits five minutes for the owner's click in the chat. On a turn nobody typed (a job, a
// Zen Mail card prompt or an agent woke it; a cron run; a reflection; a subagent) nobody reads that chat: from 10-23
// to 11-13 the scope ask fired 20 times on such turns and was never answered. Only the vital stops wait there now.

const seedDir = new URL("../questions", import.meta.url).pathname;

/** A judge that reads every step at the given danger and answers every other question with 0.9. */
class Jev {
  constructor(private danger: number | null) {}
  async ask(s: Situation, qs: Question[]): Promise<Verdict[]> {
    return qs.map((q, i) => ({
      id: `v${i}`,
      situationId: s.id,
      questionId: q.id,
      questionVersion: q.version,
      type: q.type,
      answer: q.id === "danger-level" ? (this.danger ?? 0) : 0.9,
      prob: 0.9,
      confidence: 0.9,
      cacheHit: false,
      latencyMs: 1,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      ts: 1,
      ...(q.id === "danger-level" && this.danger === null ? { skipped: "timeout" as const } : {}),
    }));
  }
}

const ask: Response = {
  kind: "ask",
  askId: "scope-1",
  options: [{ id: "only-asked", label: "Do only what you asked" }],
  preselect: "only-asked",
};
const hold = (rule: string): Response => ({
  kind: "hold",
  ruleOrQuestion: rule,
  releasable: "user-only",
});

/** One family that always answers with `response` under `reasonCode`, and has the danger question asked. */
function stops(response: Response, reasonCode: string): Family {
  return {
    id: "second-opinion",
    questionsFor: (seam) => (seam === "pre-tool" ? ["danger-level"] : []),
    decide: () => ({ response, drivers: [reasonCode], reasonCode }),
  };
}

function setup(family: Family, danger: number | null, mode: "shadow" | "enforce" = "enforce") {
  const store = new AmygdalaStore(":memory:");
  let n = 0;
  const deps: DecideDeps = {
    jev: new Jev(danger),
    book: new QuestionBook({ seedDir }),
    store,
    contexts: new TurnContexts({ store, now: () => 1000 }),
    families: [family],
    config: { mode, failClosedOnLevel3: false },
    floorActive: () => true,
    now: () => 1000,
    idGen: () => `id${++n}`,
  };
  return { deps, store };
}

const step = (sessionKey: string, turnKind?: TurnKind): DecideInput => ({
  seam: "pre-tool",
  payload: {
    seam: "pre-tool",
    sessionKey,
    turnId: "t",
    now: 1000,
    tool: "Bash",
    toolInput: { command: "echo hello" },
  },
  session: { workspaceRoot: "/w", homeDir: "/h", ...(turnKind ? { turnKind } : {}) },
});

const CHAT = "agent:main:tinker:t1";

describe("decide: a turn nobody typed", () => {
  it("lets a scope ask through at danger 1 and keeps the question on record", async () => {
    const { deps, store } = setup(stops(ask, "excess-scope"), 1);
    const r = await decide(deps, step(CHAT, "agent"));
    expect(r.decision.response.kind).toBe("proceed");
    expect(r.hook.kind).toBe("none");
    expect(store.getDecision(r.id)?.reasonCode).toBe("unattended-pass[excess-scope]");
    expect(store.listInterventions({ state: "open" })).toEqual([]);
  });

  it("the same ask on a turn the owner typed still waits for him", async () => {
    const { deps } = setup(stops(ask, "excess-scope"), 1);
    const r = await decide(deps, step(CHAT, "owner"));
    expect(r.decision.response.kind).toBe("ask");
    expect(r.hook.kind).toBe("wait");
  });

  it("a turn whose kind is unknown counts as typed", async () => {
    const { deps } = setup(stops(ask, "excess-scope"), 1);
    expect((await decide(deps, step(CHAT))).hook.kind).toBe("wait");
  });

  it("the ask stands when the step reads at danger 3, and when the danger was not read", async () => {
    const d3 = setup(stops(ask, "excess-scope"), 3);
    expect((await decide(d3.deps, step(CHAT, "agent"))).hook.kind).toBe("wait");
    const unread = setup(stops(ask, "excess-scope"), null);
    expect((await decide(unread.deps, step(CHAT, "agent"))).hook.kind).toBe("wait");
  });

  it("covers a cron run, a reflection and a subagent, whatever their prompt looks like", async () => {
    for (const key of [
      "agent:main:cron:wind-down:run:r1",
      "agent:main:fractal:f1",
      "agent:main:subagent:u1",
    ]) {
      const { deps } = setup(stops(hold("weakens-own-check"), "weakens-own-check"), 1);
      const r = await decide(deps, step(key, "owner"));
      expect([key, r.decision.response.kind, r.hook.kind]).toEqual([key, "proceed", "none"]);
    }
  });

  it("a vital stop waits even at danger 1", async () => {
    for (const code of [
      "planted-instruction",
      "first-contact",
      "commitment-changed",
      "retry-after-hold",
      "fallback-level3",
      "table-d3-high-authorise",
    ]) {
      const { deps } = setup(stops(hold(code), code), 1);
      const r = await decide(deps, step(CHAT, "agent"));
      expect([code, r.hook.kind]).toEqual([code, "wait"]);
    }
  });

  it("a vital stop in a subagent is still refused at once", async () => {
    const { deps, store } = setup(stops(hold("first-contact"), "first-contact"), 1);
    const r = await decide(deps, step("agent:main:subagent:u1", "owner"));
    expect(r.hook.kind).toBe("deny");
    expect(store.listInterventions({ state: "open" })).toEqual([]);
  });

  it("a proof is not a wait: it is refused with what to show, as before", async () => {
    const proof: Response = {
      kind: "proof",
      templateId: "proof-required",
      slots: { what: "delete x", needs: "listing" },
      needs: ["listing"],
    };
    const { deps } = setup(stops(proof, "table-d2-medium"), 2);
    expect((await decide(deps, step(CHAT, "agent"))).hook.kind).toBe("deny");
  });

  it("changes nothing in shadow mode", async () => {
    const { deps, store } = setup(stops(ask, "excess-scope"), 1, "shadow");
    const r = await decide(deps, step(CHAT, "agent"));
    expect(r.decision.response.kind).toBe("ask");
    expect(store.getDecision(r.id)?.reasonCode).toBe("excess-scope[excess-scope]");
  });
});

describe("vitalStop", () => {
  const danger = (answer: number): Verdict[] => [
    {
      id: "v",
      situationId: "s",
      questionId: "danger-level",
      questionVersion: 1,
      type: "score",
      answer,
      prob: 0.9,
      confidence: 0.9,
      cacheHit: false,
      latencyMs: 1,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      ts: 1,
    },
  ];
  it("reads the danger as its nearest level, like the proof table", () => {
    expect(vitalStop("excess-scope", danger(2.4))).toBe(false);
    expect(vitalStop("excess-scope", danger(2.5))).toBe(true);
    expect(vitalStop("weakens-own-check", danger(0.2))).toBe(false);
    expect(vitalStop("excess-scope", [])).toBe(true);
  });
});
