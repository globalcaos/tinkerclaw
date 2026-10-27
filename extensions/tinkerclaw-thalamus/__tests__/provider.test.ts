import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setRoutingReadProvider, seedCards } from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it } from "vitest";
// Integration only: these two files are the amygdala's own, used here to run its real decide() around the provider.
import { routingCompanion } from "../../tinkerclaw-amygdala/src/companion.js";
import { TurnContexts } from "../../tinkerclaw-amygdala/src/context.js";
import { decide, type DecideDeps, type DecideInput } from "../../tinkerclaw-amygdala/src/decide.js";
import type { Family } from "../../tinkerclaw-amygdala/src/families/types.js";
import { QuestionBook } from "../../tinkerclaw-amygdala/src/question-book.js";
import { AmygdalaStore } from "../../tinkerclaw-amygdala/src/store.js";
import type {
  Question,
  Response,
  Seam,
  Situation,
  Verdict,
} from "../../tinkerclaw-amygdala/src/types.js";
import { createRoutingProvider, type ProviderRead } from "../src/reads/provider.js";
import { loadQuestions } from "../src/reads/questions.js";
import {
  DEFAULT_READER_CONFIG,
  RoutingReader,
  type ReaderConfig,
} from "../src/reads/routing-reader.js";

const here = dirname(fileURLToPath(import.meta.url));
const questions = loadQuestions(join(here, "..", "questions"));
const seedDir = new URL("../../tinkerclaw-amygdala/questions", import.meta.url).pathname;
const NOW = 1_800_000_000_000;

const cards = seedCards([
  {
    kind: "skill",
    name: "translation-checker",
    description: "Compares a translation with its source and repeats until they match.",
  },
  {
    kind: "skill",
    name: "photo-sorter",
    description: "Shows one photo at a time and records a decision.",
  },
]);

/** A Jev that answers every choice with its first option and every score with level 1. */
class FakeJev {
  calls: string[][] = [];
  async ask(s: Situation, qs: Question[]): Promise<Verdict[]> {
    this.calls.push(qs.map((q) => q.id));
    return qs.map((q, i) => {
      const options = q.type === "choice" ? Object.keys(q.criteria as object) : [];
      const first = options[0];
      return {
        id: `v${this.calls.length}-${i}`,
        situationId: s.id,
        questionId: q.id,
        questionVersion: q.version,
        type: q.type,
        answer: q.type === "choice" ? first : q.type === "score" ? 1 : 0.9,
        prob: 0.9,
        ...(q.type === "choice" ? { probs: { [first]: 0.9, [options[1] ?? first]: 0.1 } } : {}),
        confidence: 0.9,
        cacheHit: false,
        latencyMs: 90,
        tokensIn: 100,
        tokensOut: 0,
        costUsd: 0,
        ts: 1,
      };
    });
  }
}

const note: Response = {
  kind: "note",
  templateId: "relevant-fact",
  slots: { fact: "x" },
  channel: "additionalContext",
};
const family: Family = {
  id: "safety",
  // One amygdala question that is active at each seam, so a call is made at all three.
  questionsFor: (seam: Seam) =>
    seam === "prompt"
      ? ["misreading-screen"]
      : seam === "pre-tool"
        ? ["danger-level"]
        : ["progress-made"],
  decide: (_seam, _s, v) =>
    v.length > 0 ? { response: note, drivers: ["danger-level"], reasonCode: "t" } : null,
};

const config = (over: Partial<ReaderConfig> = {}): ReaderConfig => ({
  ...DEFAULT_READER_CONFIG,
  jevEnabled: true,
  sendRealSituations: true,
  ...over,
});

function setup(source = "tinker", cfg: Partial<ReaderConfig> = {}) {
  const jev = new FakeJev();
  const reads: ProviderRead[] = [];
  const reader = new RoutingReader({
    rides: true,
    questions,
    cards: () => cards,
    config: config(cfg),
  });
  const off = setRoutingReadProvider(
    createRoutingProvider({
      reader,
      sourceOf: () => source,
      onRead: (r) => reads.push(r),
      now: () => NOW,
    }),
  );
  const store = new AmygdalaStore(":memory:");
  const deps: DecideDeps = {
    jev,
    book: new QuestionBook({ seedDir }),
    store,
    contexts: new TurnContexts({ store, now: () => 1000 }),
    families: [family],
    config: { mode: "shadow", failClosedOnLevel3: false },
    floorActive: () => true,
    now: () => 1000,
    companion: routingCompanion,
  };
  return { jev, reads, deps, off };
}

const input = (seam: "prompt" | "pre-tool" | "post-tool"): DecideInput => ({
  seam,
  payload: {
    seam,
    sessionKey: "s",
    turnId: "t",
    now: 1000,
    tool: "Bash",
    toolInput: { command: "ls -la" },
    prompt: "Compare my translation with the source text and repeat until they match.",
  },
  session: { workspaceRoot: "/w", homeDir: "/h" },
});

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
});

describe("routing questions on the amygdala's call", () => {
  it("adds the step questions to the pre-tool call: one call, and a step read comes out", async () => {
    const t = setup();
    off = t.off;
    const r = await decide(t.deps, input("pre-tool"));
    expect(t.jev.calls).toHaveLength(1);
    expect(t.jev.calls[0]).toEqual(["danger-level", ...questions.step.map((q) => q.id)]);
    expect(r.verdicts.map((v) => v.questionId)).toEqual(["danger-level"]);
    expect(t.reads).toHaveLength(1);
    expect(t.reads[0].kind).toBe("step");
  });

  it("adds the task and enhancement questions at the prompt, and a task read with a short list comes out", async () => {
    const t = setup();
    off = t.off;
    await decide(t.deps, input("prompt"));
    expect(t.jev.calls).toHaveLength(1);
    const ids = t.jev.calls[0];
    expect(ids[0]).toBe("misreading-screen");
    for (const q of questions.task) expect(ids).toContain(q.id);
    // A small registry fits one flat question, so that is what rides on the amygdala's call.
    expect(ids).toContain("enh-flat");
    expect(ids).not.toContain("enh-family");
    expect(t.reads).toHaveLength(1);
    const read = t.reads[0];
    expect(read.kind === "task" && read.result.usedJev).toBe(true);
  });

  it("rides the family questions on the amygdala's call when the registry is too big for one question", async () => {
    const t = setup("tinker", { flatMaxOptions: 0 });
    off = t.off;
    await decide(t.deps, input("prompt"));
    const ids = t.jev.calls[0];
    expect(ids).toContain("enh-family");
    expect(ids).not.toContain("enh-flat");
  });

  it("adds the outcome question after a tool", async () => {
    const t = setup();
    off = t.off;
    await decide(t.deps, input("post-tool"));
    expect(t.jev.calls[0]).toEqual(["progress-made", ...questions.outcome.map((q) => q.id)]);
    expect(t.reads[0].kind).toBe("outcome");
  });

  it("adds nothing for a private source: the amygdala's call carries only its own question", async () => {
    const t = setup("channel:whatsapp");
    off = t.off;
    await decide(t.deps, input("pre-tool"));
    await decide(t.deps, input("prompt"));
    expect(t.jev.calls).toEqual([["danger-level"], ["misreading-screen"]]);
    expect(t.reads).toEqual([]);
  });

  it("adds nothing when Jev reads are off", async () => {
    const t = setup("tinker", { jevEnabled: false });
    off = t.off;
    await decide(t.deps, input("pre-tool"));
    expect(t.jev.calls).toEqual([["danger-level"]]);
  });

  it("changes nothing for the amygdala: the same decision as with no provider", async () => {
    const withProvider = setup();
    off = withProvider.off;
    const a = await decide(withProvider.deps, input("pre-tool"));
    off();
    off = undefined;
    const bare = setup();
    bare.off();
    const b = await decide(bare.deps, input("pre-tool"));
    expect(a.decision.response).toEqual(b.decision.response);
    expect(a.decision.reasonCode).toBe(b.decision.reasonCode);
    expect(bare.jev.calls[0]).toEqual(["danger-level"]);
  });
});
