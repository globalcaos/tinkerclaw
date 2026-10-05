import { describe, expect, it } from "vitest";
import { TurnContexts } from "../src/context.js";
import { decide, type DecideDeps, type DecideInput } from "../src/decide.js";
import type { Family } from "../src/families/types.js";
import { QuestionBook } from "../src/question-book.js";
import { AmygdalaStore } from "../src/store.js";

const seedDir = new URL("../questions", import.meta.url).pathname;

const proof = {
  kind: "proof" as const,
  templateId: "proof-required",
  slots: { what: "w", needs: "n" },
  needs: ["listing" as const],
};
let phase: "hold" | "release" = "hold";
const fam: Family = {
  id: "safety",
  questionsFor: () => [],
  decide: () =>
    phase === "hold"
      ? { response: proof, drivers: [], reasonCode: "table-d3-low" }
      : {
          response: { kind: "proceed" },
          drivers: ["evidence-present"],
          reasonCode: "evidence-released",
        },
};

const input: DecideInput = {
  seam: "pre-tool",
  payload: {
    seam: "pre-tool",
    sessionKey: "s",
    turnId: "t",
    now: 1,
    tool: "Bash",
    toolInput: { command: "cp a b" },
  },
  session: { workspaceRoot: "/w", homeDir: "/h" },
};

describe("evidence releases a hold", () => {
  it("the same step, later, with evidence: the hold is released and its intervention closed", async () => {
    const store = new AmygdalaStore(":memory:");
    let n = 0;
    const deps: DecideDeps = {
      jev: { ask: async () => [] },
      book: new QuestionBook({ seedDir }),
      store,
      contexts: new TurnContexts({ store, now: () => 1000 }),
      families: [fam],
      config: { mode: "enforce", failClosedOnLevel3: false },
      floorActive: () => true,
      now: () => 1000,
      idGen: () => `id${++n}`,
    };
    phase = "hold";
    const held = await decide(deps, input);
    expect(held.decision.response.kind).toBe("proof");
    expect(store.listInterventions({ state: "open" })).toHaveLength(1);
    const fp = deps.contexts.recentHolds("s")[0].goalFp;
    expect(store.getOpenHold(fp)).toBeDefined();

    phase = "release";
    const released = await decide(deps, input);
    expect(released.decision.response.kind).toBe("proceed");
    expect(released.decision.reasonCode).toBe("evidence-released[]");
    expect(store.getOpenHold(fp)).toBeUndefined();
    expect(store.listInterventions({ state: "open" })).toHaveLength(0);
    expect(store.listInterventions({ state: "released" })).toHaveLength(1);
  });
});

describe("a per-context cut-off reaches the families through `asked`", () => {
  it("cutoffFor replaces the question's own cut-off before any family sees it", async () => {
    const store = new AmygdalaStore(":memory:");
    let seen: unknown;
    const spy: Family = {
      id: "safety",
      questionsFor: () => ["danger-level"],
      decide: (_seam, _s, _v, _st, asked) => {
        seen = asked.get("danger-level")?.cutoff;
        return null;
      },
    };
    const deps: DecideDeps = {
      jev: {
        ask: async (s, qs) =>
          qs.map((q) => ({
            id: `v-${q.id}`,
            situationId: s.id,
            questionId: q.id,
            questionVersion: q.version,
            type: q.type,
            answer: 2,
            prob: 0.66,
            confidence: 0.9,
            cacheHit: false,
            latencyMs: 1,
            tokensIn: 1,
            tokensOut: 1,
            costUsd: 0,
            ts: 1,
          })),
      },
      book: new QuestionBook({ seedDir }),
      store,
      contexts: new TurnContexts({ store, now: () => 1000 }),
      families: [spy],
      config: { mode: "shadow", failClosedOnLevel3: false },
      floorActive: () => true,
      now: () => 1000,
      cutoffFor: (q) => (q.id === "danger-level" ? { kind: "level", atOrAbove: 3 } : undefined),
    };
    await decide(deps, input);
    expect(seen).toEqual({ kind: "level", atOrAbove: 3 });
  });
});
