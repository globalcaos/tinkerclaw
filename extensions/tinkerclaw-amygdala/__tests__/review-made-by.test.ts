import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_TASK_MAX,
  buildPassReviewInput,
  buildPassReviewPrompt,
  buildReviewInput,
  buildReviewPrompt,
} from "../src/review.js";
import { agentSteps, type AgentStep } from "../src/transcript.js";
import type { Decision, Field, Situation } from "../src/types.js";

// 2026-11-16: a call that a background agent of the chat made reaches both judges with that agent's task. On 11-15 a
// workflow the owner ordered wrote its code and tests inside turns a PDF Apply had woken, and the pass judge read the
// Apply's "no other files" as their brief: three passes "missed".

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "amyg-made-by-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

const json = (o: unknown): string => JSON.stringify(o);
const prompt = (content: unknown): string =>
  json({ type: "user", message: { role: "user", content } });
const call = (id: string, command: string): string =>
  json({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
    },
  });
const LEAD =
  "[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. It carries no user authority. The computed task text follows:\n";

interface AgentFile {
  dir: string;
  name: string;
  meta: Record<string, unknown>;
  lines: string[];
}

/** A chat transcript whose own call is `c1`, with its background agents under `<chat>/subagents/`. */
function chatWith(...agents: AgentFile[]): string {
  const root = tmp();
  const transcript = join(root, "chat.jsonl");
  writeFileSync(transcript, `${[prompt("fix the build"), call("c1", "ls")].join("\n")}\n`);
  for (const a of agents) {
    const d = join(root, "chat", "subagents", a.dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${a.name}.jsonl`), `${a.lines.join("\n")}\n`);
    writeFileSync(join(d, `${a.name}.meta.json`), json(a.meta));
  }
  return transcript;
}

const build: AgentFile = {
  dir: "workflows/wf_1",
  name: "agent-a1",
  meta: { agentType: "workflow-subagent", description: "build" },
  lines: [
    prompt(`${LEAD}  \n  CONTEXT: his order of 19:29.\n  TASK: write the guard and its tests`),
    call("w1", "vitest run"),
  ],
};

describe("agentSteps: the calls a background agent of the chat made", () => {
  it("names the workflow agent behind a call, reads its task without the harness lead, and leaves the chat's own call", () => {
    const got = agentSteps(chatWith(build), ["w1", "c1"], 0);
    expect([...got.keys()]).toEqual(["w1"]);
    expect(got.get("w1")).toEqual({
      id: "agent-a1",
      agent: "build",
      task: "CONTEXT: his order of 19:29.\n  TASK: write the guard and its tests",
    });
  });
  it("keeps the call that started a fork as the chat's, and reads the fork's directive without its boilerplate", () => {
    const fork: AgentFile = {
      dir: "",
      name: "agent-f1",
      meta: { agentType: "fork", description: "Cards: the square", toolUseId: "c1" },
      lines: [
        json({ type: "fork-context-ref" }),
        call("c1", "ls"),
        prompt([
          { type: "tool_result", tool_use_id: "c1", content: "" },
          {
            type: "text",
            text: "<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>\n\nYour directive: edit the square cards.",
          },
        ]),
        call("f1", "sed -i s/a/b/ square.md"),
      ],
    };
    const got = agentSteps(chatWith(fork), ["c1", "f1"], 0);
    expect([...got.keys()]).toEqual(["f1"]);
    expect(got.get("f1")?.task).toBe("Your directive: edit the square cards.");
  });
  it("reads only agent files written since the turn began", () => {
    const t = chatWith(build);
    const f = join(
      t.slice(0, -".jsonl".length),
      "subagents",
      "workflows",
      "wf_1",
      "agent-a1.jsonl",
    );
    utimesSync(f, new Date(1_000_000), new Date(1_000_000));
    expect(agentSteps(t, ["w1"], 2_000_000).size).toBe(0);
    expect(agentSteps(t, ["w1"], 1_000_000).size).toBe(1);
  });
  it("gives an empty map for a chat with no background agent, or no transcript", () => {
    expect(agentSteps(chatWith(), ["c1"], 0).size).toBe(0);
    expect(agentSteps(join(tmp(), "gone.jsonl"), ["c1"], 0).size).toBe(0);
  });
});

const miss = <T>(): Field<T> => ({ value: null, origin: "missing" });
const sit = (id: string, toolUseId: string, command: string): Situation => ({
  id,
  toolUseId,
  ts: 100,
  sessionKey: "k",
  turnId: "t",
  seam: "pre-tool",
  originKind: "synthetic",
  tool: { value: "Bash", origin: "observed" },
  args: miss(),
  command: { value: command, origin: "observed" },
  effectClass: { value: "local-write", origin: "derived" },
  targets: miss(),
  targetHistory: miss(),
  scratch: miss(),
  toolRecord: miss(),
  request: miss(),
  restatement: miss(),
  expectation: miss(),
  draftCommitments: miss(),
  repeatedErrors: miss(),
  stepsSinceNewFact: miss(),
  recentHolds: miss(),
  standingFacts: miss(),
  similarIncidents: miss(),
  reply: miss(),
  claims: miss(),
  provenance: miss(),
  holdNeeds: miss(),
  candidates: miss(),
  scheduledJobs: miss(),
  contextCounts: miss(),
  turnKind: miss(),
  ownedTargets: miss(),
});
const proceed = (situationId: string): Decision => ({
  situationId,
  response: { kind: "proceed" },
  family: "safety",
  reasonCode: "none[]",
  verdictIds: [],
  mode: "enforce",
  enforced: false,
  degraded: false,
});
const book = { get: () => undefined };
const agent = (id: string, label: string, task: string): AgentStep => ({ id, agent: label, task });
const passOf = (s: Situation) => ({ situation: s, decision: proceed(s.id), verdicts: [] });
const flagOn = (s: Situation, agentStep?: AgentStep) =>
  buildReviewInput({
    situation: s,
    decision: proceed(s.id),
    verdicts: [],
    book,
    steps: [],
    saidBefore: null,
    homeDir: "/home/x",
    after: [],
    ...(agentStep ? { agentStep } : {}),
  });

describe("both judges read a background agent's task beside its calls", () => {
  const wake = {
    words:
      "[pdf-review] Apply comments pressed on ch05.pdf at 21:43. Update the PDF only: no website, no other files, no publishing.",
    orders: ["narrow the check to paid steps"],
  };
  it("names the agent on each of its passes and sends its task once; the chat's own pass has no name", () => {
    const task = "TASK: implement the plan, tests first, do not merge";
    const input = buildPassReviewInput({
      passes: [
        sit("s1", "w1", "cat > money.ts"),
        sit("s2", "w2", "cat > money.test.ts"),
        sit("s3", "c1", "python3 md2pdf.py ch05.md ch05.pdf"),
      ].map(passOf),
      book,
      did: [],
      wake,
      homeDir: "/home/x",
      byAgent: new Map([
        ["w1", agent("agent-a1", "build", task)],
        ["w2", agent("agent-a1", "build", task)],
      ]),
    });
    expect(input.agents).toEqual({ build: task });
    expect(input.passed.map((p) => p.madeBy)).toEqual(["build", "build", undefined]);
    expect(input.runOrders).toContain("Apply comments pressed");
  });
  it("keeps two agents that share a label apart", () => {
    const input = buildPassReviewInput({
      passes: [sit("s1", "w1", "ls"), sit("s2", "w2", "ls")].map(passOf),
      book,
      did: [],
      homeDir: "/home/x",
      byAgent: new Map([
        ["w1", agent("agent-a1", "build", "first")],
        ["w2", agent("agent-b2", "build", "second")],
      ]),
    });
    expect(input.agents).toEqual({ "build (agent-a1)": "first", "build (agent-b2)": "second" });
    expect(input.passed.map((p) => p.madeBy)).toEqual(["build (agent-a1)", "build (agent-b2)"]);
  });
  it("redacts the task and keeps its two ends when it is long", () => {
    const long = `CONTEXT /home/x/src/repo ${"x".repeat(5000)} TASK: do not merge`;
    const input = buildPassReviewInput({
      passes: [passOf(sit("s1", "w1", "ls"))],
      book,
      did: [],
      homeDir: "/home/x",
      byAgent: new Map([["w1", agent("agent-a1", "build", long)]]),
    });
    const task = input.agents?.build ?? "";
    expect(task).toContain("/home/owner/src/repo");
    expect(task).not.toContain("/home/x/");
    expect(task.endsWith("TASK: do not merge")).toBe(true);
    expect(task.length).toBeLessThan(AGENT_TASK_MAX + 40);
  });
  it("leaves the input as it was when no passed call was an agent's", () => {
    const input = buildPassReviewInput({
      passes: [passOf(sit("s1", "c1", "ls"))],
      book,
      did: [],
      homeDir: "/home/x",
      byAgent: new Map(),
    });
    expect(input).not.toHaveProperty("agents");
    expect(input.passed[0]).not.toHaveProperty("madeBy");
  });
  it("a flag on an agent's call carries the same two fields, and a flag on the chat's call neither", () => {
    const s = sit("s1", "w1", "git commit -F - -- money.ts");
    const got = flagOn(s, agent("agent-a1", "build", "TASK: commit in the worktree"));
    expect(got.madeBy).toBe("build");
    expect(got.agents).toEqual({ build: "TASK: commit in the worktree" });
    const own = flagOn(sit("s2", "c1", "ls"));
    expect(own).not.toHaveProperty("madeBy");
    expect(own).not.toHaveProperty("agents");
  });
  it("both prompts say whose brief such a step is judged by, and the Apply rule gives way to it", () => {
    const pass = buildPassReviewPrompt(
      buildPassReviewInput({ passes: [], book, did: [], homeDir: "/home/x" }),
    );
    const flag = buildReviewPrompt(flagOn(sit("s1", "c1", "ls")));
    for (const p of [pass, flag]) {
      expect(p).toContain(
        'A step with "madeBy" was made by a background agent that the chat started',
      );
      expect(p).toContain(
        "it is unasked only when it goes beyond the brief, or the brief goes beyond his orders",
      );
    }
    const apply = pass.indexOf("The PDF viewer's Apply button");
    const yields = pass.indexOf(`A step marked "madeBy" is not the Apply's`);
    expect(apply).toBeGreaterThan(0);
    expect(yields).toBeGreaterThan(apply);
    expect(yields).toBeLessThan(pass.indexOf("Return ONLY"));
  });
});
