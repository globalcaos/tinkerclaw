import { setRoutingReadProvider, type ProviderQuestion } from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it } from "vitest";
import { routingCompanion, type Companion } from "../src/companion.js";
import { TurnContexts } from "../src/context.js";
import { decide, type DecideDeps, type DecideInput } from "../src/decide.js";
import type { Family } from "../src/families/types.js";
import { QuestionBook } from "../src/question-book.js";
import { AmygdalaStore } from "../src/store.js";
import type { Question, Response, Seam, Situation, Verdict } from "../src/types.js";

const seedDir = new URL("../questions", import.meta.url).pathname;

class FakeJev {
  calls: { qs: string[]; arg: Question[] }[] = [];
  constructor(private readonly fail = false) {}
  async ask(s: Situation, qs: Question[]): Promise<Verdict[]> {
    this.calls.push({ qs: qs.map((q) => q.id), arg: qs });
    if (this.fail) throw new Error("down");
    return qs.map((q, i) => ({
      id: `v${this.calls.length}-${i}`,
      situationId: s.id,
      questionId: q.id,
      questionVersion: q.version,
      type: q.type,
      answer: q.type === "score" ? 3 : 0.9,
      prob: q.type === "score" ? 1 : 0.9,
      confidence: 0.9,
      cacheHit: false,
      latencyMs: 100,
      tokensIn: 100,
      tokensOut: 5,
      costUsd: 0.0000042,
      ts: 1,
    }));
  }
}

const note: Response = {
  kind: "note",
  templateId: "relevant-fact",
  slots: { fact: "x" },
  channel: "additionalContext",
};

const family = (wants: string[], seen?: Verdict[][]): Family => ({
  id: "safety",
  questionsFor: (seam: Seam) => (seam === "pre-tool" ? wants : []),
  observe: (_seam, _s, v) => {
    seen?.push(v);
  },
  decide: (_seam, _s, v) =>
    v.length > 0
      ? { response: note, drivers: v.map((x) => x.questionId), reasonCode: "test" }
      : null,
});

const routingQ = (id: string): Question =>
  ({
    id,
    version: 1,
    family: "routing",
    seams: ["pre-tool"],
    type: "choice",
    criteria: { a: "one", b: "two" },
    instructions: "i",
    fields: ["request"],
    cutoff: { kind: "none" },
    purpose: "p",
    origin: "t",
    retirement: "r",
    mustCatch: [],
    status: "active",
    name: "n",
  }) as unknown as Question;

function setup(jev: FakeJev, families: Family[], companion?: Companion) {
  const store = new AmygdalaStore(":memory:");
  let n = 0;
  const deps: DecideDeps = {
    jev,
    book: new QuestionBook({ seedDir }),
    store,
    contexts: new TurnContexts({ store, now: () => 1000 }),
    families,
    config: { mode: "shadow", failClosedOnLevel3: false },
    floorActive: () => true,
    now: () => 1000,
    idGen: () => `id${++n}`,
    ...(companion ? { companion } : {}),
  };
  return { deps, store };
}

const input: DecideInput = {
  seam: "pre-tool",
  payload: {
    seam: "pre-tool",
    sessionKey: "s",
    turnId: "t",
    now: 1000,
    tool: "Bash",
    toolInput: { command: "ls -la" },
  },
  session: { workspaceRoot: "/w", homeDir: "/h" },
};

describe("the companion seam", () => {
  it("changes nothing when there is no companion: the very same question list reaches Jev", async () => {
    const jev = new FakeJev();
    const { deps } = setup(jev, [family(["danger-level"])]);
    const r = await decide(deps, input);
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0].qs).toEqual(["danger-level"]);
    expect(r.verdicts.map((v) => v.questionId)).toEqual(["danger-level"]);
  });

  it("adds the routing questions to the same call, one call in all", async () => {
    const jev = new FakeJev();
    const seen: Verdict[][] = [];
    const companion: Companion = {
      questionsFor: () => [routingQ("route-x"), routingQ("route-y")],
      observe: (_seam, _s, v) => {
        seen.push(v);
      },
    };
    const { deps } = setup(jev, [family(["danger-level"])], companion);
    await decide(deps, input);
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0].qs).toEqual(["danger-level", "route-x", "route-y"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].map((v) => v.questionId)).toEqual(["route-x", "route-y"]);
  });

  it("keeps the routing verdicts away from families, the result and the store", async () => {
    const jev = new FakeJev();
    const famSeen: Verdict[][] = [];
    const companion: Companion = { questionsFor: () => [routingQ("route-x")], observe: () => {} };
    const { deps, store } = setup(jev, [family(["danger-level"], famSeen)], companion);
    const r = await decide(deps, input);
    expect(famSeen[0].map((v) => v.questionId)).toEqual(["danger-level"]);
    expect(r.verdicts.map((v) => v.questionId)).toEqual(["danger-level"]);
    expect(r.decision.verdictIds).toHaveLength(1);
    expect(JSON.stringify(store.listInterventions())).not.toContain("route-x");
  });

  it("gives the same decision with and without a companion", async () => {
    const a = setup(new FakeJev(), [family(["danger-level"])]);
    const b = setup(new FakeJev(), [family(["danger-level"])], {
      questionsFor: () => [routingQ("route-x")],
      observe: () => {},
    });
    const ra = await decide(a.deps, input);
    const rb = await decide(b.deps, input);
    expect(rb.decision.response).toEqual(ra.decision.response);
    expect(rb.decision.family).toBe(ra.decision.family);
    expect(rb.decision.reasonCode).toBe(ra.decision.reasonCode);
    expect(rb.decision.degraded).toBe(ra.decision.degraded);
  });

  it("rides only on a call the amygdala is making anyway", async () => {
    const jev = new FakeJev();
    let asked = 0;
    let observed = 0;
    const companion: Companion = {
      questionsFor: () => {
        asked += 1;
        return [routingQ("route-x")];
      },
      observe: () => {
        observed += 1;
      },
    };
    const { deps } = setup(jev, [family([])], companion);
    await decide(deps, input);
    expect(jev.calls).toHaveLength(0);
    expect(asked).toBe(0);
    expect(observed).toBe(0);
  });

  it("hands the companion unavailable verdicts, and the amygdala its own, when Jev is down", async () => {
    const jev = new FakeJev(true);
    const seen: Verdict[][] = [];
    const companion: Companion = {
      questionsFor: () => [routingQ("route-x")],
      observe: (_a, _b, v) => void seen.push(v),
    };
    const { deps } = setup(jev, [family(["danger-level"])], companion);
    const r = await decide(deps, input);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0][0].questionId).toBe("route-x");
    expect(seen[0][0].skipped).toBeDefined();
    expect(r.verdicts.map((v) => v.questionId)).toEqual(["danger-level"]);
    expect(r.decision.degraded).toBe(true);
  });

  it("never lets a failing companion break a decision", async () => {
    const jev = new FakeJev();
    const bad: Companion = {
      questionsFor: () => {
        throw new Error("x");
      },
      observe: () => {
        throw new Error("y");
      },
    };
    const { deps } = setup(jev, [family(["danger-level"])], bad);
    const r = await decide(deps, input);
    expect(jev.calls[0].qs).toEqual(["danger-level"]);
    expect(r.decision.response.kind).toBe("note");

    const bad2: Companion = {
      questionsFor: () => [routingQ("route-x")],
      observe: () => {
        throw new Error("y");
      },
    };
    const b = setup(new FakeJev(), [family(["danger-level"])], bad2);
    expect((await decide(b.deps, input)).decision.response.kind).toBe("note");
  });
});

describe("routingCompanion", () => {
  let off: (() => void) | undefined;
  afterEach(() => {
    off?.();
    off = undefined;
  });

  const pq: ProviderQuestion = {
    id: "route-x",
    version: 3,
    type: "choice",
    criteria: { a: "one", b: "two" },
    instructions: "i",
    fields: ["request"],
    name: "N",
    purpose: "P",
  };
  const situation = {
    id: "sit",
    sessionKey: "s",
    turnId: "t",
    originKind: "real",
    request: { value: "hello", origin: "observed" },
    tool: { value: null, origin: "missing" },
  } as unknown as Situation;

  it("asks nothing and observes nothing with no provider registered", () => {
    expect(routingCompanion.questionsFor("pre-tool", situation)).toEqual([]);
    expect(() => routingCompanion.observe("pre-tool", situation, [])).not.toThrow();
  });

  it("shapes the provider's questions for the seam and passes on what it may read", () => {
    const views: unknown[] = [];
    off = setRoutingReadProvider({
      questionsFor: (_seam, view) => {
        views.push(view);
        return [pq];
      },
      observe: () => {},
    });
    const [q] = routingCompanion.questionsFor("pre-tool", situation);
    expect(q).toMatchObject({
      id: "route-x",
      version: 3,
      seams: ["pre-tool"],
      cutoff: { kind: "none" },
      status: "active",
    });
    expect(views[0]).toEqual({
      id: "sit",
      sessionKey: "s",
      turnId: "t",
      originKind: "real",
      request: "hello",
    });
  });

  it("returns nothing, rather than throwing, when the provider throws", () => {
    off = setRoutingReadProvider({
      questionsFor: () => {
        throw new Error("x");
      },
      observe: () => {
        throw new Error("y");
      },
    });
    expect(routingCompanion.questionsFor("prompt", situation)).toEqual([]);
    expect(() => routingCompanion.observe("prompt", situation, [])).not.toThrow();
  });

  it("stops asking once the provider is removed", () => {
    off = setRoutingReadProvider({ questionsFor: () => [pq], observe: () => {} });
    expect(routingCompanion.questionsFor("prompt", situation)).toHaveLength(1);
    off();
    off = undefined;
    expect(routingCompanion.questionsFor("prompt", situation)).toEqual([]);
  });
});
