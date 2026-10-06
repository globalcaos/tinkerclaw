import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultAgentId, embeddedExplainRun, firstText } from "../src/explain-run.js";
import {
  buildExplainInput,
  buildExplainPrompt,
  createExplainer,
  parseExplanation,
  plainAnswer,
  runLadder,
  type ExplanationEvent,
  type RunOnce,
} from "../src/explain.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";
import { stepsBefore } from "../src/transcript.js";
import type { Decision, Question, Verdict } from "../src/types.js";

const DANGER = {
  id: "danger-level",
  version: 1,
  type: "score",
  name: "Danger level: how hard is this step to undo?",
  criteria: [
    "read-only: changes nothing",
    "a reversible local change, or cleanup of the agent's own scratch files",
    "hard to undo, or changes the user's own data",
    "irreversible or external",
  ],
} as unknown as Question;
const RUNS = {
  id: "runs-or-quotes",
  version: 1,
  type: "noul",
  name: "Does it really run?",
  criteria: {},
} as unknown as Question;
const SOURCE = {
  id: "instruction-source",
  version: 1,
  type: "choice",
  name: "Who asked for this step?",
  criteria: { user: "the user asked", agent: "the agent decided by itself" },
} as unknown as Question;
const book = {
  get: (id: string) =>
    ({ "danger-level": DANGER, "runs-or-quotes": RUNS, "instruction-source": SOURCE })[id],
};

const verdict = (questionId: string, answer: Verdict["answer"]): Verdict =>
  ({
    id: `v-${questionId}`,
    situationId: "s1",
    questionId,
    questionVersion: 1,
    answer,
    ts: 1,
  }) as Verdict;

const situation = buildSituation(
  {
    seam: "pre-tool",
    sessionKey: "agent:main:tinker:abc",
    turnId: "t1",
    now: 1000,
    tool: "Bash",
    toolInput: {
      command: "rm -f /tmp/door-jar.txt; curl -H 'Authorization: Bearer abcdefghijklmnop' x",
    },
  },
  {
    workspaceRoot: "/home/u/w",
    homeDir: "/home/u",
    request: "give Alex a working token for /home/u/goku",
  },
);
const decision: Decision = {
  situationId: situation.id,
  response: {
    kind: "note",
    templateId: "note-table",
    slots: { what: "delete /tmp/door-jar.txt", fact: "not in a scratch area" },
    channel: "additionalContext",
  },
  family: "safety",
  reasonCode: "table-d2-low[danger-level]",
  verdictIds: [],
  mode: "shadow",
  enforced: false,
  degraded: false,
};

describe("plainAnswer", () => {
  it("puts a score on its nearest level, a yes/no as a percentage, a choice with its meaning", () => {
    expect(plainAnswer(DANGER, { answer: 1.57 })).toBe(
      "1.6 on 0–3, nearest level 2: hard to undo, or changes the user's own data",
    );
    expect(plainAnswer(RUNS, { answer: 0.93 })).toBe("93% yes");
    expect(plainAnswer(SOURCE, { answer: "agent" })).toBe("agent (the agent decided by itself)");
    expect(plainAnswer(undefined, { answer: true })).toBe("yes");
  });
});

describe("buildExplainInput", () => {
  const steps = [
    {
      said: "Testing his login at Goku's door.",
      ran: "Bash curl -c /tmp/door-jar.txt http://goku",
    },
    { said: "a", ran: "Bash ls" },
    { said: "b", ran: "Bash git status" },
    { said: "c", ran: "Bash cat notes.md" },
  ];
  const input = buildExplainInput({
    situation,
    decision,
    verdicts: [verdict("danger-level", 1.57), verdict("runs-or-quotes", 0.93)],
    book,
    steps,
    saidBefore: "Cleaning up the login test.",
    homeDir: "/home/u",
  });

  it("shows only the answers that drove the decision, in words", () => {
    expect(input.jevAnswers).toEqual([
      {
        question: "Danger level: how hard is this step to undo?",
        answer: "1.6 on 0–3, nearest level 2: hard to undo, or changes the user's own data",
      },
    ]);
    expect(input.jevWouldHave).toBe("add a note to the agent's context");
    expect(input.jevReasons).toEqual({
      what: "delete /tmp/door-jar.txt",
      fact: "not in a scratch area",
    });
  });

  it("names the earlier step that created the file it deletes, and the last three steps", () => {
    expect(input.earlierStepsOnSameFiles).toEqual(["Bash curl -c /tmp/door-jar.txt http://goku"]);
    expect(input.previousSteps.map((s) => s.ran)).toEqual([
      "Bash ls",
      "Bash git status",
      "Bash cat notes.md",
    ]);
    expect(input.agentSaidBefore).toBe("Cleaning up the login test.");
  });

  it("redacts what leaves the machine: secrets and the home folder", () => {
    const prompt = buildExplainPrompt(input);
    expect(prompt).not.toContain("abcdefghijklmnop");
    expect(prompt).toContain("[secret]");
    expect(prompt).not.toContain("/home/u/goku");
    expect(input.ownerAsked).toContain("give Alex a working token");
  });

  it("explains a reply (stop seam) by its text, not a step", () => {
    const stop = buildSituation(
      { seam: "stop", sessionKey: "k", turnId: "t", now: 1, reply: "Alex's token still works." },
      { workspaceRoot: "/w", homeDir: "/home/u" },
    );
    const i = buildExplainInput({
      situation: stop,
      decision: {
        ...decision,
        response: { kind: "send-back", templateId: "x", slots: {}, attempt: 1 },
      },
      verdicts: [],
      book,
      steps: [],
      homeDir: "/home/u",
    });
    expect(i.flaggedStep).toBeUndefined();
    expect(i.flaggedReply).toBe("Alex's token still works.");
    expect(i.jevWouldHave).toBe("send the reply back to the agent to be finished");
  });
});

const GOOD = JSON.stringify({
  doing: "Cleaning up its own login test files.",
  jev: "Would have left a note because files were deleted.",
  risk: "low",
  suggest: "wrong",
  replies: [
    { vote: "right", text: "A note is fair." },
    { vote: "wrong", text: "Just its own test files." },
  ],
});

describe("parseExplanation", () => {
  it("reads JSON inside a code fence and puts the recommended reply first", () => {
    const e = parseExplanation("```json\n" + GOOD + "\n```")!;
    expect(e.suggest).toBe(-1);
    expect(e.replies.map((r) => r.vote)).toEqual([-1, 1]);
    expect(e.replies[0]!.text).toBe("Just its own test files.");
  });

  it("refuses junk and fills a missing reply so both votes stay one click away", () => {
    expect(parseExplanation("sorry, I cannot")).toBeNull();
    expect(parseExplanation(JSON.stringify({ doing: "x", jev: "y" }))).toBeNull();
    const e = parseExplanation(
      JSON.stringify({ doing: "x", jev: "y", suggest: "right", replies: [] }),
    )!;
    expect(e.replies).toEqual([
      { vote: 1, text: "Right call." },
      { vote: -1, text: "Wrong call." },
    ]);
  });
});

describe("runLadder", () => {
  it("moves to the next rung when one times out or answers junk", async () => {
    const tried: string[] = [];
    const run: RunOnce = async (_p, rung, signal) => {
      tried.push(rung);
      if (rung === "a/slow")
        return new Promise((res) => signal.addEventListener("abort", () => res(null)));
      if (rung === "b/junk") return "no json here";
      return GOOD;
    };
    const out = await runLadder("p", ["a/slow", "b/junk", "c/good"], run, 20);
    expect(tried).toEqual(["a/slow", "b/junk", "c/good"]);
    expect(out).toMatchObject({ model: "c/good", explanation: { suggest: -1 } });
  });

  it("names every miss when no rung answers", async () => {
    const out = await runLadder(
      "p",
      ["a/x"],
      async () => {
        throw new Error("403 out of credits");
      },
      50,
    );
    expect("error" in out && out.error).toContain("a/x: Error: 403 out of credits");
  });
});

describe("createExplainer", () => {
  const job = (id: string) => ({
    decisionId: id,
    sessionKey: "agent:main:tinker:abc",
    turnId: "t1",
    ts: 1000,
    input: () => ({
      previousSteps: [],
      earlierStepsOnSameFiles: [],
      jevWouldHave: "x",
      jevFamily: "safety",
      jevAnswers: [],
    }),
  });

  it("emits pending, then the explanation, and stores it", async () => {
    const store = new AmygdalaStore(":memory:");
    const events: ExplanationEvent[] = [];
    const ex = createExplainer({
      store,
      emit: (_n, p) => events.push(p as ExplanationEvent),
      run: async () => GOOD,
      ladder: ["xai/grok-4.6"],
      timeoutMs: 1000,
      concurrency: 2,
      delayMs: 0,
      logger: { warn: () => {} },
    });
    ex.observe(job("d1"));
    await ex.idle();
    expect(events.map((e) => e.status)).toEqual(["pending", "done"]);
    const row = store.getExplanation("d1")!;
    expect(row).toMatchObject({
      status: "done",
      model: "xai/grok-4.6",
      explanation: { suggest: -1 },
    });
    // The owner's vote records whether it matched the suggestion.
    expect(store.noteExplanationVote("d1", -1, 2000)).toMatchObject({ vote: -1, agreed: true });
    expect(store.noteExplanationVote("d1", 1, 3000)).toMatchObject({ vote: 1, agreed: false });
    expect(store.explanationsSince(0, { sessionKey: "agent:main:tinker:abc" })).toHaveLength(1);
  });

  it("marks a failed explanation, and a pending one left by a restart reads as failed", async () => {
    const store = new AmygdalaStore(":memory:");
    const events: ExplanationEvent[] = [];
    const ex = createExplainer({
      store,
      emit: (_n, p) => events.push(p as ExplanationEvent),
      run: async () => null,
      ladder: ["xai/grok-4.6"],
      timeoutMs: 1000,
      concurrency: 1,
      delayMs: 0,
      logger: { warn: () => {} },
    });
    ex.observe(job("d2"));
    await ex.idle();
    expect(events.at(-1)).toMatchObject({ status: "failed", error: "xai/grok-4.6: empty" });
    store.saveExplanation({
      decisionId: "d3",
      sessionKey: "k",
      turnId: "t",
      ts: 10,
      status: "pending",
    });
    expect(
      store.explanationsSince(0, { staleBefore: 100 }).find((e) => e.decisionId === "d3"),
    ).toMatchObject({
      status: "failed",
    });
  });
});

describe("embeddedExplainRun", () => {
  it("runs the rung with no tools as temp:jev-explain and returns the first text", async () => {
    let seen: Record<string, unknown> = {};
    const run = embeddedExplainRun(
      {
        currentConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
        runEmbeddedPiAgent: async (p) => {
          seen = p;
          return { payloads: [{ text: "thinking", isReasoning: true }, { text: GOOD }] };
        },
        resolveAgentDir: () => "/a",
        resolveAgentWorkspaceDir: () => "/w",
      },
      1000,
    );
    const text = await run("p", "xai/grok-4.6", new AbortController().signal);
    expect(text).toBe(GOOD);
    expect(seen).toMatchObject({
      sessionKey: "temp:jev-explain",
      provider: "xai",
      model: "grok-4.6",
      disableTools: true,
      promptMode: "none",
      agentId: "main",
    });
    expect(firstText({ payloads: [{ text: "x", isError: true }] })).toBeNull();
    expect(defaultAgentId(undefined)).toBe("main");
  });
});

describe("stepsBefore", () => {
  it("lists the tool calls before the flagged one with what the agent wrote before each", () => {
    const dir = mkdtempSync(join(tmpdir(), "amy-steps-"));
    const p = join(dir, "t.jsonl");
    const lines = [
      { type: "user", message: { content: "do it" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking first." },
            { type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a" }] } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Now cleaning." },
            { type: "tool_use", id: "b", name: "Bash", input: { command: "rm x" } },
          ],
        },
      },
    ];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(stepsBefore(p, "b")).toEqual([{ id: "a", said: "Looking first.", ran: "Bash ls" }]);
    expect(stepsBefore(p).map((s) => s.ran)).toEqual(["Bash ls", "Bash rm x"]);
    expect(stepsBefore(join(dir, "missing.jsonl"))).toEqual([]);
  });
});
