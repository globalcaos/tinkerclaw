import { describe, expect, it } from "vitest";
import { TurnContexts } from "../src/context.js";
import { decide, type DecideDeps, type DecideInput } from "../src/decide.js";
import type { Family } from "../src/families/types.js";
import { rebuildEvents } from "../src/feed.js";
import { QuestionBook } from "../src/question-book.js";
import { AmygdalaStore } from "../src/store.js";
import type { Question, Response, Seam, Situation, Verdict } from "../src/types.js";

const seedDir = new URL("../questions", import.meta.url).pathname;

class FakeJev {
  calls: { qs: string[]; budgetMs?: number }[] = [];
  constructor(private script: (q: Question) => Partial<Verdict> = () => ({})) {}
  async ask(s: Situation, qs: Question[], o?: { budgetMs?: number }): Promise<Verdict[]> {
    this.calls.push({ qs: qs.map((q) => q.id), budgetMs: o?.budgetMs });
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
      ...this.script(q),
    }));
  }
}

const note = (fact: string): Response => ({
  kind: "note",
  templateId: "relevant-fact",
  slots: { fact },
  channel: "additionalContext",
});
const proof: Response = {
  kind: "proof",
  templateId: "proof-required",
  slots: { what: "delete HR", needs: "a listing" },
  needs: ["listing"],
};
const hold: Response = { kind: "hold", ruleOrQuestion: "danger-level", releasable: "user-only" };

function fam(
  id: Family["id"],
  wants: string[],
  res: (v: Verdict[]) => { response: Response; drivers: string[]; reasonCode: string } | null,
): Family {
  return {
    id,
    questionsFor: (seam: Seam) => (seam === "pre-tool" ? wants : []),
    decide: (_seam, _s, v) => res(v),
  };
}

function setup(
  o: {
    families?: Family[];
    mode?: "shadow" | "enforce";
    floor?: boolean;
    failClosedOnLevel3?: boolean;
    jev?: FakeJev;
    enforceFamilies?: Family["id"][];
  } = {},
) {
  const store = new AmygdalaStore(":memory:");
  const events: [string, unknown][] = [];
  let n = 0;
  const jev = o.jev ?? new FakeJev();
  const deps: DecideDeps = {
    jev,
    book: new QuestionBook({ seedDir }),
    store,
    contexts: new TurnContexts({ store, now: () => 1000 }),
    families: o.families ?? [],
    config: {
      mode: o.mode ?? "shadow",
      failClosedOnLevel3: o.failClosedOnLevel3 ?? false,
      ...(o.enforceFamilies ? { enforceFamilies: o.enforceFamilies } : {}),
    },
    floorActive: () => o.floor ?? true,
    now: () => 1000,
    idGen: () => `id${++n}`,
    emit: (e, p) => events.push([e, p]),
  };
  return { deps, store, events, jev };
}

const input = (command: string): DecideInput => ({
  seam: "pre-tool",
  payload: {
    seam: "pre-tool",
    sessionKey: "s",
    turnId: "t",
    now: 1000,
    tool: "Bash",
    toolInput: { command },
  },
  session: { workspaceRoot: "/w", homeDir: "/h" },
});

// Written with the Write tool on purpose: a shell heredoc containing this text trips the live AEGIS hook.
const ABSOLUTE_DELETE = "rm -rf /var/data";

describe("decide: hard rules", () => {
  it("hold before any judge; Jev never called; enforced when the floor is active; the hook denies", async () => {
    const { deps, jev, store } = setup({
      families: [fam("safety", ["danger-level"], () => null)],
      mode: "shadow",
      floor: true,
    });
    const r = await decide(deps, input(ABSOLUTE_DELETE));
    expect(r.decision).toMatchObject({
      family: "hard-rule",
      enforced: true,
      response: { kind: "hold" },
    });
    expect(r.hard?.rule).toBe("FS_DESTRUCTIVE_ROOT");
    expect(r.hook.kind).toBe("deny");
    expect(jev.calls).toHaveLength(0);
    expect(store.getDecision(r.id)?.reasonCode).toContain("hard-rule:FS_DESTRUCTIVE_ROOT");
    expect(store.listInterventions()[0]).toMatchObject({ kind: "hold", state: "denied" });
  });

  it("recorded but NOT enforced when the floor is off (v3.1 enforcing): hook prints nothing, row settled", async () => {
    const { deps, store } = setup({ floor: false });
    const r = await decide(deps, input(ABSOLUTE_DELETE));
    expect(r.decision.enforced).toBe(false);
    expect(r.hook).toEqual({ kind: "none" });
    expect(store.listInterventions()[0].state).toBe("settled");
  });

  it("safe commands go on to the judge path", async () => {
    const { deps } = setup();
    expect((await decide(deps, input("ls -la"))).decision.response.kind).toBe("proceed");
  });
});

describe("decide: families and merge", () => {
  it("no families → proceed and no Jev call", async () => {
    const { deps, jev } = setup();
    const r = await decide(deps, input("ls"));
    expect(r.decision.response.kind).toBe("proceed");
    expect(jev.calls).toHaveLength(0);
  });

  it("one Jev call carries the union of the questions, with the seam budget", async () => {
    const { deps, jev } = setup({
      families: [
        fam("safety", ["danger-level", "runs-or-quotes"], () => null),
        fam("second-opinion", ["runs-or-quotes", "excess-scope"], () => null),
      ],
    });
    await decide(deps, input("ls"));
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0].qs).toEqual(["danger-level", "runs-or-quotes", "excess-scope"]);
    expect(jev.calls[0].budgetMs).toBe(2600);
  });

  it("off questions are not asked", async () => {
    const { deps, jev } = setup({
      families: [fam("second-opinion", ["purpose-unclear"], () => null)],
    });
    await decide(deps, input("ls"));
    expect(jev.calls).toHaveLength(0);
  });

  it("the most severe response wins; the reason code names the driving questions", async () => {
    const { deps } = setup({
      mode: "enforce",
      families: [
        fam("safety", ["danger-level"], () => ({
          response: note("f"),
          drivers: ["danger-level"],
          reasonCode: "n",
        })),
        fam("double-check", ["runs-or-quotes"], () => ({
          response: proof,
          drivers: ["runs-or-quotes"],
          reasonCode: "p",
        })),
      ],
    });
    const r = await decide(deps, input("cp a b"));
    expect(r.decision.response.kind).toBe("proof");
    expect(r.decision.family).toBe("double-check");
    expect(r.decision.reasonCode).toBe("p[runs-or-quotes]");
    expect(r.hook.kind).toBe("deny");
  });

  it("shadow records the response but enforces nothing", async () => {
    const { deps, store } = setup({
      mode: "shadow",
      families: [
        fam("safety", ["danger-level"], () => ({
          response: proof,
          drivers: ["danger-level"],
          reasonCode: "p",
        })),
      ],
    });
    const r = await decide(deps, input("cp a b"));
    expect(r.decision).toMatchObject({
      enforced: false,
      mode: "shadow",
      response: { kind: "proof" },
    });
    expect(r.hook).toEqual({ kind: "none" });
    expect(store.listInterventions()[0].state).toBe("settled");
  });

  it("enforce: a judge hold waits (open intervention, hold saved, goal remembered)", async () => {
    const { deps, store } = setup({
      mode: "enforce",
      families: [
        fam("safety", ["danger-level"], () => ({
          response: hold,
          drivers: ["danger-level"],
          reasonCode: "h",
        })),
      ],
    });
    const r = await decide(deps, input("rm -rf ./data"));
    expect(r.hook).toMatchObject({ kind: "wait", timeoutMs: 300000 });
    expect(store.listInterventions()[0]).toMatchObject({ kind: "hold", state: "open" });
    const fp = deps.contexts.recentHolds("s")[0].goalFp;
    expect(store.getOpenHold(fp)).toBeDefined();
  });
});

describe("decide: notes and send-backs are limited", () => {
  it("one note per tool call; the same note is not repeated in a task", async () => {
    const two = [
      fam("safety", ["danger-level"], () => ({
        response: note("a"),
        drivers: ["danger-level"],
        reasonCode: "a",
      })),
      fam("second-opinion", ["runs-or-quotes"], () => ({
        response: note("b"),
        drivers: ["runs-or-quotes"],
        reasonCode: "b",
      })),
    ];
    const { deps } = setup({ mode: "enforce", families: two });
    const r1 = await decide(deps, input("ls"));
    expect(r1.decision.response.kind).toBe("note");
    const r2 = await decide(deps, input("ls")); // next call, same first note again → suppressed
    expect(r2.decision.response.kind).toBe("proceed");
    expect(r2.decision.reasonCode).toBe("note-suppressed[]");
  });

  it("send-back is capped at two per turn: the third is delivered with a marker event", async () => {
    const back: Response = {
      kind: "send-back",
      templateId: "send-back-dodged",
      slots: { problem: "p" },
      attempt: 1,
    };
    const stop: Family = {
      id: "double-check",
      questionsFor: () => [],
      decide: () => ({ response: back, drivers: ["dodged-work"], reasonCode: "sb" }),
    };
    const { deps, events } = setup({ mode: "enforce", families: [stop] });
    const stopInput: DecideInput = {
      seam: "stop",
      payload: { seam: "stop", sessionKey: "s", turnId: "t", now: 1000, reply: "done" },
      session: { workspaceRoot: "/w", homeDir: "/h" },
    };
    const a = await decide(deps, stopInput);
    const b = await decide(deps, stopInput);
    const c = await decide(deps, stopInput);
    expect([a, b, c].map((x) => x.decision.response.kind)).toEqual([
      "send-back",
      "send-back",
      "proceed",
    ]);
    expect(a.hook.kind).toBe("block");
    expect(events.some(([e]) => e === "amygdala2.marker")).toBe(true);
  });
});

describe("decide: the judge is out", () => {
  const skip = (why: Verdict["skipped"]) => new FakeJev(() => ({ skipped: why }));
  const fams = [fam("safety", ["danger-level"], () => null)];

  it("breaker open / timeout / error → fail open, degraded, family fallback", async () => {
    const { deps } = setup({ families: fams, mode: "enforce", jev: skip("breaker-open") });
    const r = await decide(deps, input("git push origin main"));
    expect(r.decision).toMatchObject({
      family: "fallback",
      degraded: true,
      response: { kind: "proceed" },
      enforced: false,
    });
    expect(r.decision.reasonCode).toBe("jev-unavailable[]");
    expect(r.hook.kind).toBe("none");
  });

  it("real situations not allowed to leave → not consulted, NOT degraded", async () => {
    const { deps } = setup({ families: fams, jev: skip("not-allowed") });
    const r = await decide(deps, input("ls"));
    expect(r.decision).toMatchObject({ degraded: false, family: "fallback" });
    expect(r.decision.reasonCode).toBe("jev-not-consulted[]");
  });

  it("failClosedOnLevel3 holds external steps only", async () => {
    const { deps } = setup({
      families: fams,
      mode: "enforce",
      failClosedOnLevel3: true,
      jev: skip("error"),
    });
    const send = await decide(deps, input("git push origin main"));
    expect(send.decision.response).toMatchObject({
      kind: "hold",
      ruleOrQuestion: "fallback-level3",
    });
    expect(send.decision.enforced).toBe(true);
    const read = await decide(deps, input("ls -la"));
    expect(read.decision.response.kind).toBe("proceed");
  });

  it("a Jev client that throws is treated as unavailable, never as a crash", async () => {
    const { deps } = setup({
      families: fams,
      jev: {
        async ask() {
          throw new Error("boom");
        },
      } as unknown as FakeJev,
    });
    const r = await decide(deps, input("ls"));
    expect(r.decision).toMatchObject({ degraded: true, response: { kind: "proceed" } });
  });
});

describe("decide: Jev dormant (no token)", () => {
  // No token is not a failure of the judge: nothing is asked, no verdict row is written, no "judge down" row is drawn.
  const fams = [fam("safety", ["danger-level", "runs-or-quotes"], () => null)];
  const dormantJev = () => Object.assign(new FakeJev(), { on: () => false });

  it("asks nothing, writes no verdict row, emits nothing, and is not degraded", async () => {
    const jev = dormantJev();
    const { deps, store, events } = setup({ families: fams, mode: "enforce", jev });
    const r = await decide(deps, input("cp a b"));
    expect(jev.calls).toHaveLength(0);
    expect(r.verdicts).toHaveLength(0);
    expect(store.queryVerdicts({ situationId: r.situation.id })).toHaveLength(0);
    expect(r.decision).toMatchObject({ degraded: false, response: { kind: "proceed" } });
    expect(r.decision.reasonCode).toBe("jev-dormant[]");
    expect(events).toHaveLength(0);
  });

  it("the hard rules still hold with no token", async () => {
    const { deps } = setup({ families: fams, mode: "enforce", jev: dormantJev() });
    const r = await decide(deps, input(ABSOLUTE_DELETE));
    expect(r.decision.response).toMatchObject({ kind: "hold" });
  });

  it("failClosedOnLevel3 still holds external steps with no token", async () => {
    const { deps } = setup({
      families: fams,
      mode: "enforce",
      failClosedOnLevel3: true,
      jev: dormantJev(),
    });
    const send = await decide(deps, input("git push origin main"));
    expect(send.decision.response).toMatchObject({
      kind: "hold",
      ruleOrQuestion: "fallback-level3",
    });
    const read = await decide(deps, input("ls -la"));
    expect(read.decision.response.kind).toBe("proceed");
  });

  it("asks again the moment a token exists, in the same runtime", async () => {
    let on = false;
    const jev = Object.assign(new FakeJev(), { on: () => on });
    const { deps } = setup({ families: fams, jev });
    await decide(deps, input("cp a b"));
    expect(jev.calls).toHaveLength(0);
    on = true;
    await decide(deps, input("cp a b"));
    expect(jev.calls).toHaveLength(1);
  });

  it("does not ask the Thalamus routing questions that ride on the call either", async () => {
    const jev = dormantJev();
    const { deps } = setup({ families: fams, jev });
    let asked = 0;
    deps.companion = {
      questionsFor: () => {
        asked += 1;
        return [];
      },
      observe: () => {},
    } as never;
    await decide(deps, input("cp a b"));
    expect(jev.calls).toHaveLength(0);
    expect(asked).toBe(0);
  });
});

describe("decide: persistence and events", () => {
  it("stores situation, verdicts and decision; emits one decision event per answered question and one intervention", async () => {
    const { deps, store, events } = setup({
      mode: "enforce",
      families: [
        fam("safety", ["danger-level", "runs-or-quotes"], () => ({
          response: proof,
          drivers: ["danger-level"],
          reasonCode: "p",
        })),
      ],
    });
    const r = await decide(deps, input("cp a b"));
    expect(store.getDecision(r.id)?.verdictIds).toHaveLength(2);
    expect(store.queryVerdicts({ situationId: r.situation.id })).toHaveLength(2);
    expect(store.situationRecord(r.situation.id)?.id).toBe(r.situation.id);
    const dec = events
      .filter(([e]) => e === "amygdala2.decision")
      .map(([, p]) => p as { questionId: string; codeDid: string });
    expect(dec.map((e) => [e.questionId, e.codeDid])).toEqual([
      ["danger-level", "proof"],
      ["runs-or-quotes", "ok"],
    ]);
    expect(events.filter(([e]) => e === "amygdala2.intervention")).toHaveLength(1);
  });

  it("nothing is emitted or opened for a plain proceed", async () => {
    const { deps, store, events } = setup();
    await decide(deps, input("ls"));
    expect(events).toHaveLength(0);
    expect(store.listInterventions()).toHaveLength(0);
  });
});

describe("decide: refusal", () => {
  const stopInput: DecideInput = {
    seam: "stop",
    payload: {
      seam: "stop",
      sessionKey: "s",
      turnId: "t",
      now: 1000,
      reply: "I would rather not write that.",
    },
    session: { workspaceRoot: "/w", homeDir: "/h" },
  };
  const refuser: Family = {
    id: "double-check",
    questionsFor: () => [],
    decide: () => ({ response: { kind: "refusal" }, drivers: ["refusal"], reasonCode: "refusal" }),
  };
  const holder: Family = {
    id: "safety",
    questionsFor: () => [],
    decide: () => ({ response: hold, drivers: [], reasonCode: "h" }),
  };

  it("alone: a refusal intervention, no hook action, and the router event is published", async () => {
    const { deps, events, store } = setup({ mode: "enforce", families: [refuser] });
    const r = await decide(deps, stopInput);
    expect(r.decision.response.kind).toBe("refusal");
    expect(r.hook).toEqual({ kind: "none" });
    expect(store.listInterventions()[0]).toMatchObject({ kind: "refusal", state: "open" });
    const ev = events.find(([e]) => e === "amygdala2.refusal")?.[1] as {
      redactedExample: string;
      sessionKey: string;
    };
    expect(ev.sessionKey).toBe("s");
    expect(ev.redactedExample).toContain("rather not");
  });

  it("the router event is published even when a hold outranks the refusal (never offered Rewind, always logged)", async () => {
    const { deps, events, store } = setup({ mode: "enforce", families: [refuser, holder] });
    const r = await decide(deps, stopInput);
    expect(r.decision.response.kind).toBe("hold");
    expect(events.filter(([e]) => e === "amygdala2.refusal")).toHaveLength(1);
    expect(store.listInterventions().map((i) => i.kind)).toEqual(["hold"]);
  });

  // 2026-09-30, CTO tab: Jev said refusal 0.98, but a claim send-back won the merge and the strip never showed.
  const sendBacker: Family = {
    id: "second-opinion",
    questionsFor: () => [],
    decide: () => ({
      response: {
        kind: "send-back",
        templateId: "send-back-claim",
        slots: { claim: "it is done", missing: "a result" },
        attempt: 1,
      },
      drivers: [],
      reasonCode: "claim-unsupported",
    }),
  };

  it("one family returns a send-back and flags the refusal it outranked: strip offered, router event logged", async () => {
    const both: Family = {
      id: "double-check",
      questionsFor: () => [],
      decide: () => ({
        ...sendBacker.decide("stop", {} as never, [], {} as never, new Map())!,
        alsoRefusal: true,
      }),
    };
    const { deps, events, store } = setup({ mode: "shadow", families: [both] });
    const r = await decide(deps, stopInput);
    expect(r.decision.response.kind).toBe("send-back");
    expect(
      store
        .listInterventions()
        .map((i) => i.kind)
        .toSorted(),
    ).toEqual(["refusal", "send-back"]);
    expect(events.filter(([e]) => e === "amygdala2.refusal")).toHaveLength(1);
  });

  for (const mode of ["shadow", "enforce"] as const) {
    it(`${mode}: a send-back outranks the refusal, and the refusal strip is still offered (and survives a reload)`, async () => {
      const { deps, events, store } = setup({ mode, families: [refuser, sendBacker] });
      const r = await decide(deps, stopInput);
      expect(r.decision.response.kind).toBe("send-back");
      const ivs = store.listInterventions();
      expect(ivs.map((i) => i.kind).toSorted()).toEqual(["refusal", "send-back"]);
      expect(ivs.find((i) => i.kind === "refusal")!.state).toBe(
        mode === "enforce" ? "open" : "settled",
      );
      const sent = events
        .filter(([e]) => e === "amygdala2.intervention")
        .map(([, p]) => (p as { kind: string; turnId: string }).kind);
      expect(sent.toSorted()).toEqual(["refusal", "send-back"]);
      const rebuilt = rebuildEvents(store, deps.book, { since: 0, limit: 50 });
      expect(rebuilt.interventions.map((i) => i.kind).toSorted()).toEqual(["refusal", "send-back"]);
      expect(new Set(rebuilt.interventions.map((i) => i.id)).size).toBe(2);
    });
  }

  it("in shadow the event still goes out and the row is only a record", async () => {
    const { deps, events, store } = setup({ mode: "shadow", families: [refuser] });
    await decide(deps, stopInput);
    expect(events.some(([e]) => e === "amygdala2.refusal")).toBe(true);
    expect(store.listInterventions()[0].state).toBe("settled");
  });
});

describe("decide: the consult note", () => {
  it("says once per unanswered step why the judge was not consulted", async () => {
    const fams = [fam("safety", ["danger-level"], () => null)];
    const notConsulted = setup({
      families: fams,
      jev: new FakeJev(() => ({ skipped: "not-allowed" })),
    });
    await decide(notConsulted.deps, input("ls"));
    expect(
      notConsulted.events
        .filter(([e]) => e === "amygdala2.consult")
        .map(([, p]) => (p as { state: string }).state),
    ).toEqual(["real-steps-stay-local"]);
    const down = setup({ families: fams, jev: new FakeJev(() => ({ skipped: "error" })) });
    await decide(down.deps, input("ls"));
    expect(
      down.events
        .filter(([e]) => e === "amygdala2.consult")
        .map(([, p]) => (p as { state: string }).state),
    ).toEqual(["judge-down"]);
    const fine = setup({ families: fams });
    await decide(fine.deps, input("ls"));
    expect(fine.events.some(([e]) => e === "amygdala2.consult")).toBe(false);
  });
});

// the architect 2026-10-03: "How is the personality amygdala going? I want it up and running." The rest stays in shadow.
describe("decide: one family enforced while the rest stays in shadow", () => {
  const personalityNote = fam("personality", ["danger-level"], () => ({
    response: note("you expected the tests to pass; they failed"),
    drivers: ["danger-level"],
    reasonCode: "surprise",
  }));
  it("a personality note is enforced and the hook carries it as context", async () => {
    const { deps } = setup({
      families: [personalityNote],
      mode: "shadow",
      enforceFamilies: ["personality"],
    });
    const r = await decide(deps, input("ls"));
    expect(r.decision).toMatchObject({ family: "personality", enforced: true, mode: "shadow" });
    expect(r.hook).toMatchObject({ kind: "context" });
  });
  it("without the setting it stays a shadow record", async () => {
    const { deps } = setup({ families: [personalityNote], mode: "shadow" });
    const r = await decide(deps, input("ls"));
    expect(r.decision.enforced).toBe(false);
    expect(r.hook.kind).toBe("none");
  });
  it("only notes: a hold from an enforced family, or from any other family, is never enforced this way", async () => {
    const holdFrom = (id: Family["id"]) =>
      fam(id, ["danger-level"], () => ({
        response: hold,
        drivers: ["danger-level"],
        reasonCode: "x",
      }));
    for (const f of [holdFrom("personality"), holdFrom("safety")]) {
      const { deps } = setup({ families: [f], mode: "shadow", enforceFamilies: ["personality"] });
      const r = await decide(deps, input("ls"));
      expect(r.decision.enforced, f.id).toBe(false);
      expect(r.hook.kind, f.id).toBe("none");
    }
  });
});

describe("decide: novelty's seen-before count", () => {
  const post = (file: string): DecideInput => ({
    seam: "post-tool",
    payload: {
      seam: "post-tool",
      sessionKey: "s",
      turnId: "t",
      now: 1000,
      tool: "Read",
      toolInput: { file_path: file },
    },
    session: { workspaceRoot: "/w", homeDir: "/h" },
  });
  it("counts each exact thing: seen 0, then 1; a different file starts at 0", async () => {
    const { deps } = setup();
    expect((await decide(deps, post("/w/logs/io-1.log"))).situation.contextCounts.value).toEqual({
      seen: 0,
      alarms: 0,
    });
    expect((await decide(deps, post("/w/logs/io-1.log"))).situation.contextCounts.value).toEqual({
      seen: 1,
      alarms: 0,
    });
    expect((await decide(deps, post("/w/logs/io-2.log"))).situation.contextCounts.value).toEqual({
      seen: 0,
      alarms: 0,
    });
  });
});
