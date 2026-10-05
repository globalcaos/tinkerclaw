import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevQuestion, JevVerdict } from "openclaw/plugin-sdk/fork-jev";
import {
  FLAT_QUESTION_ID,
  MAX_CHOICE_OPTIONS,
  NONE_KEY,
  seedCards,
  type EnhancementCard,
  type EnhancementListing,
} from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it } from "vitest";
import { loadQuestions } from "../src/reads/questions.js";
import {
  DEFAULT_READER_CONFIG,
  RoutingReader,
  type AskFn,
  type ReaderConfig,
  type ReadInput,
} from "../src/reads/routing-reader.js";

const questions = loadQuestions(join(dirname(fileURLToPath(import.meta.url)), "..", "questions"));
const NOW = 1_800_000_000_000;

const listing = (name: string, description: string): EnhancementListing => ({
  kind: "skill",
  name,
  description,
});
const CARDS: EnhancementCard[] = seedCards([
  listing(
    "translation-checker",
    "Compares a translation with its source and repeats until they match.",
  ),
  listing("photo-sorter", "Shows one photo at a time and records a keep or delete decision."),
  listing("gmail-helper", "Draft replies in Gmail and keep the thread."),
  listing("amazon-shopper", "Find the best price on Amazon."),
  listing("pdf-tools", "Extract text from a PDF."),
  listing("gateway-restart", "Restart the gateway and check the chats continue."),
]);

const input = (over: Partial<ReadInput> = {}): ReadInput => ({
  id: "t1",
  ts: NOW,
  sessionKey: "s",
  text: "Compare my translation with the source text and repeat until they match.",
  source: "tinker",
  trigger: "user",
  synthetic: true,
  ...over,
});

// The tests below that script a family question keep the family path by forcing it; the flat path has its own describe.
const on: ReaderConfig = { ...DEFAULT_READER_CONFIG, jevEnabled: true, flatMaxOptions: 0 };

const verdict = (
  q: JevQuestion,
  answer: string | number,
  confidence: number,
  probs?: Record<string, number>,
): JevVerdict => ({
  id: `v-${q.id}`,
  situationId: "t1",
  questionId: q.id,
  questionVersion: q.version,
  type: q.type,
  answer,
  prob: probs ? (probs[answer as string] ?? 0) : typeof answer === "number" ? answer : 1,
  confidence,
  ...(probs ? { probs } : {}),
  cacheHit: false,
  latencyMs: 80,
  tokensIn: 100,
  tokensOut: 0,
  costUsd: 0,
  ts: NOW,
});

type Script = {
  /** Family probabilities. */
  family?: Record<string, number>;
  /** Within-family probabilities by family id. */
  members?: Record<string, Record<string, number>>;
  confidence?: number;
  task?: Record<string, string | number>;
  fit?: Record<string, string>;
};

const TASK_ANSWERS: Record<string, string | number> = {
  "route-work-kind": "languages",
  "route-difficulty": 1,
  "route-topic-class": "none",
  "route-urgency": "waiting",
  "route-shape": "chain",
};

/** A scripted Jev: answers each question from the script and counts the calls it receives. */
function scripted(s: Script = {}) {
  const calls: JevQuestion[][] = [];
  const ask: AskFn = async (_sit, qs) => {
    calls.push(qs);
    const conf = s.confidence ?? 0.9;
    return qs.map((q) => {
      if (q.id === "enh-family") {
        const probs = s.family ?? { documents: 0.05, [NONE_KEY]: 0.05, writing: 0.9 };
        return verdict(q, top(probs), conf, probs);
      }
      if (q.id.startsWith("enh-in-")) {
        const fam = q.id.slice("enh-in-".length);
        const probs = s.members?.[fam] ?? { [NONE_KEY]: 1 };
        return verdict(q, top(probs), conf, probs);
      }
      if (q.id.startsWith("enh-fit-")) {
        const kind = s.fit?.[q.id] ?? "made-for";
        return verdict(q, kind, conf, { [kind]: 1 });
      }
      if (q.type === "choice" && q.id in TASK_ANSWERS)
        return verdict(q, TASK_ANSWERS[q.id] as string, conf);
      if (q.type === "score" && q.id in TASK_ANSWERS)
        return verdict(q, TASK_ANSWERS[q.id] as number, conf);
      return verdict(q, 0.2, conf);
    });
  };
  return { ask, calls };
}
const top = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];

const reader = (
  ask: AskFn | undefined,
  over: Partial<ReaderConfig> = {},
  cards: EnhancementCard[] = CARDS,
) => new RoutingReader({ ask, questions, cards: () => cards, config: { ...on, ...over } });

const familyOfCard = (id: string) => CARDS.find((c) => c.id === id)!.family;

describe("the privacy gate: decided from the source, before any question is built", () => {
  it("makes no Jev call at all for a private source", async () => {
    const jev = scripted();
    const r = await reader(jev.ask).readTask(input({ source: "channel:whatsapp" }));
    expect(jev.calls).toHaveLength(0);
    expect(r).toMatchObject({ usedJev: false, local: "private-source", private: true });
    expect(r.task.private).toBe(true);
    expect(r.task.kind.source).toBe("local");
  });

  it("gives a private task a local short list from word matching, never from Jev", async () => {
    const jev = scripted();
    const r = await reader(jev.ask).readTask(input({ source: "channel:mail" }));
    expect(jev.calls).toHaveLength(0);
    expect(r.shortlist.source).toBe("local");
    expect(r.shortlist.entries[0]?.cardId).toBe("skill:translation-checker");
  });

  it("asks once for a private source the operator approved for Jev", async () => {
    const jev = scripted();
    const r = await reader(jev.ask, { jevApprovedSources: ["channel:whatsapp"] }).readTask(
      input({ source: "channel:whatsapp" }),
    );
    expect(jev.calls).toHaveLength(1);
    expect(r.usedJev).toBe(true);
    expect(r.private).toBe(true);
  });

  it("does not let approval of one private source open another", async () => {
    const jev = scripted();
    await reader(jev.ask, { jevApprovedSources: ["channel:whatsapp"] }).readTask(
      input({ source: "channel:mail" }),
    );
    expect(jev.calls).toHaveLength(0);
  });

  it("keeps a real conversation on the machine unless real sending is switched on", async () => {
    const jev = scripted();
    const r = await reader(jev.ask).readTask(input({ synthetic: false }));
    expect(jev.calls).toHaveLength(0);
    expect(r.local).toBe("real-not-allowed");
    await reader(jev.ask, { sendRealSituations: true }).readTask(input({ synthetic: false }));
    expect(jev.calls).toHaveLength(1);
  });

  it("still keeps a private real source local when real sending is on", async () => {
    const jev = scripted();
    await reader(jev.ask, { sendRealSituations: true }).readTask(
      input({ synthetic: false, source: "channel:sms" }),
    );
    expect(jev.calls).toHaveLength(0);
  });

  it("makes no call when Jev is off or there is no way to ask", async () => {
    const jev = scripted();
    expect((await reader(jev.ask, { jevEnabled: false }).readTask(input())).local).toBe("jev-off");
    expect((await reader(undefined).readTask(input())).local).toBe("no-key");
    expect(jev.calls).toHaveLength(0);
  });

  it("applies to every read, not only the task read", async () => {
    const jev = scripted();
    const r = reader(jev.ask);
    const priv = input({ source: "channel:whatsapp" });
    expect((await r.readStep({ ...priv, callIndex: 1 })).usedJev).toBe(false);
    expect((await r.readOutcome({ ...priv, callIndex: 1 })).usedJev).toBe(false);
    const list = {
      entries: [{ cardId: "skill:photo-sorter", rank: 1, prob: 0.9 }],
      noneFitsProb: 0.1,
      shown: true,
      reason: "shown" as const,
      source: "jev" as const,
    };
    expect(await r.readFit(priv, list)).toBe(list);
    expect(jev.calls).toHaveLength(0);
  });
});

describe("one call for the task read and the enhancement ranking", () => {
  it("carries the five task questions, the family question, and one question per family", async () => {
    const jev = scripted();
    await reader(jev.ask).readTask(input());
    expect(jev.calls).toHaveLength(1);
    const ids = jev.calls[0].map((q) => q.id);
    expect(ids.slice(0, 5)).toEqual(questions.task.map((q) => q.id));
    expect(ids).toContain("enh-family");
    const families = new Set(CARDS.map((c) => c.family));
    for (const f of families) expect(ids).toContain(`enh-in-${f}`);
    expect(ids).toHaveLength(5 + 1 + families.size);
  });

  it("reads the task and ranks the enhancements from the same verdicts", async () => {
    const family = familyOfCard("skill:translation-checker");
    const jev = scripted({
      family: { [family]: 0.9, [NONE_KEY]: 0.1 },
      members: { [family]: { "skill:translation-checker": 0.85, [NONE_KEY]: 0.15 } },
    });
    const r = await reader(jev.ask).readTask(input());
    expect(r.task.kind).toMatchObject({ value: "languages", source: "jev" });
    expect(r.task.difficulty.value).toBe(2);
    expect(r.task.urgency.value).toBe("waiting");
    expect(r.shortlist).toMatchObject({ shown: true, source: "jev", reason: "shown" });
    expect(r.shortlist.entries[0].cardId).toBe("skill:translation-checker");
    expect(r.shortlist.entries[0].prob).toBeCloseTo(0.9 * 0.85, 9);
    expect(r.enhancementVersion).toBeGreaterThan(0);
  });

  it("does not show a list when 'none of these fits' leads, and still returns the task read", async () => {
    const family = familyOfCard("skill:translation-checker");
    const jev = scripted({
      family: { [family]: 0.3, [NONE_KEY]: 0.7 },
      members: { [family]: { "skill:translation-checker": 0.6, [NONE_KEY]: 0.4 } },
    });
    const r = await reader(jev.ask).readTask(input());
    expect(r.shortlist).toMatchObject({ shown: false, reason: "none-leads" });
    expect(r.task.kind.source).toBe("jev");
    expect(r.usedJev).toBe(true);
  });

  it("asks no enhancement questions when there are no cards", async () => {
    const jev = scripted();
    const r = await reader(jev.ask, {}, []).readTask(input());
    expect(jev.calls[0].map((q) => q.id)).toEqual(questions.task.map((q) => q.id));
    expect(r.shortlist.reason).toBe("not-asked");
    expect(r.enhancementVersion).toBe(0);
  });
});

describe("Jev down and low confidence", () => {
  it("falls back to local rules when the call throws", async () => {
    const r = await reader(async () => {
      throw new Error("boom");
    }).readTask(input());
    expect(r).toMatchObject({ usedJev: false, local: "jev-silent" });
    expect(r.task.kind.source).toBe("local");
    expect(r.shortlist.source).toBe("local");
  });

  it("falls back when every verdict is skipped (breaker open, timeout, not allowed)", async () => {
    for (const why of ["breaker-open", "timeout", "error", "not-allowed"] as const) {
      const r = await reader(async (_s, qs) =>
        qs.map((q) => ({ ...verdict(q, "", 0), skipped: why })),
      ).readTask(input());
      expect(r.local, why).toBe("jev-silent");
      expect(r.usedJev, why).toBe(false);
    }
  });

  it("falls back when the call returns nothing", async () => {
    expect((await reader(async () => []).readTask(input())).local).toBe("jev-silent");
  });

  it("makes every task answer cautious when confidence is low, but ranks the list by probability (no floor on the joint)", async () => {
    const tcFamily = familyOfCard("skill:translation-checker");
    const jev = scripted({
      confidence: 0.3,
      family: { [tcFamily]: 0.9, [NONE_KEY]: 0.1 },
      members: { [tcFamily]: { "skill:translation-checker": 0.9, [NONE_KEY]: 0.1 } },
    });
    const r = await reader(jev.ask).readTask(input());
    expect(r.usedJev).toBe(true);
    for (const a of [r.task.kind, r.task.difficulty, r.task.topic, r.task.urgency, r.task.shape]) {
      expect(a.source).toBe("fallback");
    }
    // Paper 7.1 builds the list from the probabilities, by share. The verdicts' own confidence floors the TASK answers
    // above, never a card's joint probability (phase H2: a split family read made two tasks lose their card).
    expect(r.shortlist.source).toBe("jev");
    expect(r.shortlist.entries[0].cardId).toBe("skill:translation-checker");
  });

  it("lists a card ranked by the joint when the family read splits, instead of falling back to word matching", async () => {
    const tc = familyOfCard("skill:translation-checker");
    const pdf = familyOfCard("skill:pdf-tools");
    expect(tc).not.toBe(pdf);
    const jev = scripted({
      confidence: 0.4,
      family: { [tc]: 0.5, [pdf]: 0.45, [NONE_KEY]: 0.05 },
      members: {
        [tc]: { "skill:translation-checker": 0.99, [NONE_KEY]: 0.01 },
        [pdf]: { "skill:pdf-tools": 0.9, [NONE_KEY]: 0.1 },
      },
    });
    const r = await reader(jev.ask).readTask(input());
    expect(r.shortlist.source).toBe("jev");
    expect(r.shortlist.shown).toBe(true);
    expect(r.shortlist.entries.map((e) => e.cardId)).toEqual([
      "skill:translation-checker",
      "skill:pdf-tools",
    ]);
    expect(r.shortlist.entries[0].prob).toBeCloseTo(0.495, 3);
  });

  it("still lets 'none fits' lead when the mass says so", async () => {
    const tc = familyOfCard("skill:translation-checker");
    const jev = scripted({
      confidence: 0.9,
      family: { [tc]: 0.4, [NONE_KEY]: 0.6 },
      members: { [tc]: { "skill:translation-checker": 0.9, [NONE_KEY]: 0.1 } },
    });
    const r = await reader(jev.ask).readTask(input());
    expect(r.shortlist.shown).toBe(false);
    expect(r.shortlist.reason).toBe("none-leads");
  });

  it("does not build a Jev list on a missing within-family answer", async () => {
    const family = familyOfCard("skill:translation-checker");
    const jev = scripted({
      family: { [family]: 0.9, [NONE_KEY]: 0.1 },
      members: { [family]: { "skill:translation-checker": 0.9, [NONE_KEY]: 0.1 } },
    });
    // Control: with every answer present, the list is Jev's.
    expect((await reader(jev.ask).readTask(input())).shortlist.source).toBe("jev");
    const ask: AskFn = async (s, qs) => {
      const vs = await jev.ask(s, qs);
      return vs.map((v) =>
        v.questionId === `enh-in-${family}` ? { ...v, skipped: "timeout" as const } : v,
      );
    };
    const r = await reader(ask).readTask(input());
    expect(r.usedJev).toBe(true);
    expect(r.shortlist.source).not.toBe("jev");
  });
});

describe("a registry larger than 255 enhancements", () => {
  const many = (n: number, families: string[]): EnhancementCard[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `skill:big${i}`,
      kind: "skill" as const,
      name: `big${i}`,
      family: families[i % families.length],
      purpose: `purpose ${i}`,
      structure: "",
      alsoServed: [],
      version: 1,
      status: "active" as const,
      origin: "seed" as const,
    }));

  it("still asks once, in legal questions, and ranks the right card first", async () => {
    const cards = many(300, ["coding", "writing", "messages", "documents", "shopping", "media"]);
    const target = "skill:big7"; // family: writing (7 % 6 = 1)
    const calls: JevQuestion[][] = [];
    const ask: AskFn = async (_s, qs) => {
      calls.push(qs);
      return qs.map((q) => {
        if (q.id === "enh-family")
          return verdict(q, "writing", 0.9, { writing: 0.9, [NONE_KEY]: 0.1 });
        if (q.id === "enh-in-writing")
          return verdict(q, target, 0.9, { [target]: 0.9, [NONE_KEY]: 0.1 });
        if (q.id.startsWith("enh-in-")) return verdict(q, NONE_KEY, 0.9, { [NONE_KEY]: 1 });
        return q.type === "score"
          ? verdict(q, 1, 0.9)
          : verdict(
              q,
              q.id === "route-work-kind" ? "code" : Object.keys(q.criteria as object)[0],
              0.9,
            );
      });
    };
    const r = await reader(ask, {}, cards).readTask(input());
    expect(calls).toHaveLength(1);
    for (const q of calls[0]) {
      expect(Object.keys(q.criteria as object).length, q.id).toBeLessThanOrEqual(
        MAX_CHOICE_OPTIONS,
      );
    }
    expect(r.shortlist.entries[0].cardId).toBe(target);
    expect(r.shortlist.source).toBe("jev");
  });

  it("splits a family of 600 across questions and still asks once", async () => {
    const cards = many(600, ["coding"]);
    const calls: JevQuestion[][] = [];
    const ask: AskFn = async (_s, qs) => {
      calls.push(qs);
      return [];
    };
    await reader(ask, {}, cards).readTask(input());
    expect(calls).toHaveLength(1);
    const memberQs = calls[0].filter((q) => q.id.startsWith("enh-in-"));
    expect(memberQs.map((q) => q.id)).toEqual([
      "enh-in-coding-p1",
      "enh-in-coding-p2",
      "enh-in-coding-p3",
    ]);
    for (const q of memberQs)
      expect(Object.keys(q.criteria as object).length).toBeLessThanOrEqual(MAX_CHOICE_OPTIONS);
  });
});

describe("the fit-kind read", () => {
  const list = (source: "jev" | "local" = "jev") => ({
    entries: [
      "skill:translation-checker",
      "skill:photo-sorter",
      "skill:pdf-tools",
      "skill:gmail-helper",
    ].map((cardId, i) => ({
      cardId,
      rank: i + 1,
      prob: 0.4 - i * 0.08,
    })),
    noneFitsProb: 0.1,
    shown: true,
    reason: "shown" as const,
    source,
  });

  it("goes out for the top three entries only, in one call", async () => {
    const jev = scripted();
    const out = await reader(jev.ask).readFit(input(), list());
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0].map((q) => q.id)).toEqual(["enh-fit-1", "enh-fit-2", "enh-fit-3"]);
    expect(out.entries.slice(0, 3).every((e) => e.fit?.source === "jev")).toBe(true);
    expect(out.entries[3].fit).toBeUndefined();
  });

  it("says the top two fit together when both cover part", async () => {
    const jev = scripted({
      fit: { "enh-fit-1": "covers-part", "enh-fit-2": "covers-part", "enh-fit-3": "made-for" },
    });
    const out = await reader(jev.ask).readFit(input(), list());
    expect(out.together).toEqual(["skill:translation-checker", "skill:photo-sorter"]);
  });

  it("leaves a local list alone, with no call", async () => {
    const jev = scripted();
    const l = list("local");
    expect(await reader(jev.ask).readFit(input(), l)).toBe(l);
    expect(jev.calls).toHaveLength(0);
  });

  it("leaves the list as it was when Jev is down or unsure", async () => {
    const l = list();
    const down = await reader(async () => {
      throw new Error("x");
    }).readFit(input(), l);
    expect(down.entries.every((e) => e.fit === undefined)).toBe(true);
    const unsure = await reader(scripted({ confidence: 0.2 }).ask).readFit(input(), l);
    expect(unsure.entries.every((e) => e.fit === undefined)).toBe(true);
  });

  it("does not ask for a list that is not shown", async () => {
    const jev = scripted();
    const hidden = { ...list(), shown: false, entries: [] };
    expect(await reader(jev.ask).readFit(input(), hidden)).toBe(hidden);
    expect(jev.calls).toHaveLength(0);
  });
});

describe("the step and outcome reads", () => {
  it("asks the step questions and one per pending item, and maps the answers back to the items", async () => {
    const calls: JevQuestion[][] = [];
    const ask: AskFn = async (_s, qs) => {
      calls.push(qs);
      return qs.map((q) => {
        if (q.id === "step-parallel-ok-1") return verdict(q, 0.9, 0.9);
        if (q.id === "step-parallel-ok-2") return verdict(q, 0.1, 0.9);
        if (q.type === "score") return verdict(q, 0, 0.9);
        if (q.type === "noul") return verdict(q, 0.1, 0.9);
        return verdict(q, Object.keys(q.criteria as object)[0], 0.9);
      });
    };
    const out = await reader(ask).readStep({ ...input(), callIndex: 2 }, ["file-a", "file-b"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].map((q) => q.id)).toEqual([
      ...questions.step.map((q) => q.id),
      "step-parallel-ok-1",
      "step-parallel-ok-2",
    ]);
    expect(out.usedJev).toBe(true);
    expect(out.step.parallelOk["file-a"].value).toBe(true);
    expect(out.step.parallelOk["file-b"].value).toBe(false);
    expect(out.step.depth.value).toBe("mechanical");
  });

  it("shows Jev the tool name and its arguments for a step, and only the request for an outcome", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ask: AskFn = async (sit, qs) => {
      seen.push(sit as unknown as Record<string, unknown>);
      return qs.map((q) =>
        verdict(
          q,
          q.type === "choice" ? Object.keys(q.criteria as object)[0] : 0,
          0.9,
          q.type === "choice" ? { [Object.keys(q.criteria as object)[0]]: 1 } : undefined,
        ),
      );
    };
    await reader(ask).readStep({
      ...input(),
      callIndex: 2,
      toolName: "Bash",
      args: { command: "npm test" },
    });
    await reader(ask).readOutcome({ ...input(), callIndex: 3 });
    expect(seen[0]).toMatchObject({
      tool: { value: "Bash" },
      args: { value: { command: "npm test" } },
    });
    expect(Object.keys(seen[1]).sort()).toEqual(["id", "request"]);
  });

  it("uses local rules for a step when the gate is closed", async () => {
    const jev = scripted();
    const out = await reader(jev.ask, { jevEnabled: false }).readStep({
      ...input(),
      callIndex: 2,
      toolName: "Read",
    });
    expect(out).toMatchObject({ usedJev: false, local: "jev-off" });
    expect(out.step.kind.value).toBe("read");
    expect(jev.calls).toHaveLength(0);
  });

  it("falls back to local rules when Jev is silent on a step", async () => {
    const out = await reader(async (_s, qs) =>
      qs.map((q) => ({ ...verdict(q, "", 0), skipped: "timeout" as const })),
    ).readStep({
      ...input(),
      callIndex: 2,
    });
    expect(out).toMatchObject({ usedJev: false, local: "jev-silent" });
  });

  it("reads `stuck` from the error count with no call", async () => {
    const jev = scripted();
    const out = await reader(jev.ask).readOutcome({ ...input(), callIndex: 3, repeatedErrors: 2 });
    expect(out.outcome.state.value).toBe("stuck");
    expect(out.local).toBe("counted");
    expect(jev.calls).toHaveLength(0);
  });

  it("asks the outcome question otherwise", async () => {
    const ask: AskFn = async (_s, qs) => qs.map((q) => verdict(q, "retry", 0.9, { retry: 1 }));
    const out = await reader(ask).readOutcome({ ...input(), callIndex: 3 });
    expect(out.outcome.state.value).toBe("retry");
    expect(out.usedJev).toBe(true);
  });
});

describe("the flat enhancement ranking (paper 7.1: families exist only for the 255-option limit)", () => {
  const registry = (n: number): EnhancementCard[] =>
    seedCards(
      Array.from({ length: n }, (_, i) => listing(`tool-${i}`, `Does job number ${i} on its own.`)),
    );
  const flatOn = { flatMaxOptions: undefined };

  const enhancementIds = (qs: JevQuestion[]) =>
    qs.map((q) => q.id).filter((id) => id.startsWith("enh-"));

  it("asks one question over every card when 210 enhancements fit, and the probabilities are the ranking", async () => {
    const cards = registry(210);
    const asked: JevQuestion[][] = [];
    const ask: AskFn = async (_s, qs) => {
      asked.push(qs);
      return qs.map((q) => {
        if (q.id === FLAT_QUESTION_ID) {
          const probs = {
            "skill:tool-7": 0.55,
            "skill:tool-8": 0.3,
            "skill:tool-9": 0.05,
            [NONE_KEY]: 0.1,
          };
          return verdict(q, "skill:tool-7", 0.35, probs);
        }
        if (q.type === "score") return verdict(q, 0, 0.9);
        return verdict(q, Object.keys(q.criteria as object)[0], 0.9, {
          [Object.keys(q.criteria as object)[0]]: 1,
        });
      });
    };
    const r = await reader(ask, flatOn, cards).readTask(input());
    expect(asked).toHaveLength(1);
    expect(enhancementIds(asked[0])).toEqual([FLAT_QUESTION_ID]);
    expect(
      Object.keys(asked[0].find((q) => q.id === FLAT_QUESTION_ID)!.criteria as object),
    ).toHaveLength(211);
    expect(r.shortlist.source).toBe("jev");
    // The 80% share of 0.55 / 0.30 / 0.05 / none 0.10 is the first two; none does not lead.
    expect(r.shortlist.entries.map((e) => e.cardId)).toEqual(["skill:tool-7", "skill:tool-8"]);
    expect(r.shortlist.shown).toBe(true);
  });

  it("does not floor the flat ranking on the verdict's confidence either", async () => {
    const cards = registry(30);
    const ask: AskFn = async (_s, qs) =>
      qs.map((q) =>
        q.id === FLAT_QUESTION_ID
          ? verdict(q, "skill:tool-1", 0.2, { "skill:tool-1": 0.9, [NONE_KEY]: 0.1 })
          : q.type === "score"
            ? verdict(q, 0, 0.9)
            : verdict(q, Object.keys(q.criteria as object)[0], 0.9, {
                [Object.keys(q.criteria as object)[0]]: 1,
              }),
      );
    const r = await reader(ask, flatOn, cards).readTask(input());
    expect(r.shortlist.source).toBe("jev");
    expect(r.shortlist.entries[0].cardId).toBe("skill:tool-1");
  });

  it("lets 'none fits' lead a flat ranking", async () => {
    const ask: AskFn = async (_s, qs) =>
      qs.map((q) =>
        q.id === FLAT_QUESTION_ID
          ? verdict(q, NONE_KEY, 0.9, { "skill:tool-1": 0.2, [NONE_KEY]: 0.8 })
          : q.type === "score"
            ? verdict(q, 0, 0.9)
            : verdict(q, Object.keys(q.criteria as object)[0], 0.9, {
                [Object.keys(q.criteria as object)[0]]: 1,
              }),
      );
    const r = await reader(ask, flatOn, registry(30)).readTask(input());
    expect(r.shortlist.shown).toBe(false);
    expect(r.shortlist.reason).toBe("none-leads");
  });

  it("falls back to the local list when the flat answer is skipped", async () => {
    const ask: AskFn = async (_s, qs) =>
      qs.map((q) =>
        q.id === FLAT_QUESTION_ID
          ? { ...verdict(q, NONE_KEY, 0, { [NONE_KEY]: 1 }), skipped: "timeout" as const }
          : q.type === "score"
            ? verdict(q, 0, 0.9)
            : verdict(q, Object.keys(q.criteria as object)[0], 0.9, {
                [Object.keys(q.criteria as object)[0]]: 1,
              }),
      );
    const r = await reader(ask, flatOn, registry(30)).readTask(input());
    expect(r.shortlist.source).not.toBe("jev");
  });

  it("uses the family questions above the limit: 300 enhancements ask the family question", async () => {
    const cards = registry(300).map((c, i) => ({ ...c, family: `fam-${i % 3}` }));
    const asked: JevQuestion[][] = [];
    const ask: AskFn = async (_s, qs) => {
      asked.push(qs);
      return [];
    };
    await reader(ask, flatOn, cards).readTask(input());
    const ids = enhancementIds(asked[0]);
    expect(ids).toContain("enh-family");
    expect(ids).not.toContain(FLAT_QUESTION_ID);
  });
});
