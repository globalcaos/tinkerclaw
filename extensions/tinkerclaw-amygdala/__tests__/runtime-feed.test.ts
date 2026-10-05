import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { Family } from "../src/families/types.js";
import { changeView, cutoffText, editablePath, questionRows, rebuildEvents } from "../src/feed.js";
import type { JevTransport } from "../src/jev.js";
import { QuestionBook } from "../src/question-book.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";
import { FAMILY_PAPER, type Change } from "../src/types.js";

const EXT = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const transport: JevTransport = {
  async post() {
    return {
      status: 200,
      ms: 40,
      json: {
        answers: {
          "danger-level": { type: "score", score: 3, confidence: 0.9 },
          "runs-or-quotes": { type: "noul", noul: 0.9, confidence: 0.9 },
        },
        usage: { input_tokens: 100, output_tokens: 5 },
      },
    };
  },
};

const holdFamily: Family = {
  id: "safety",
  questionsFor: (seam) => (seam === "pre-tool" ? ["danger-level", "runs-or-quotes"] : []),
  decide: () => ({
    response: { kind: "hold", ruleOrQuestion: "danger-level", releasable: "user-only" },
    drivers: ["danger-level"],
    reasonCode: "table-d3-low",
  }),
};

function make(sendReal = true) {
  const root = mkdtempSync(join(tmpdir(), "amy-feed-"));
  dirs.push(root);
  const events: { event: string; payload: unknown }[] = [];
  let t = 1_700_000_000_000;
  const rt = createRuntime({
    config: parseConfig({
      mode: "enforce",
      dataDir: join(root, "data"),
      jev: { sendRealSituations: sendReal },
      hooks: { enabled: false },
    }),
    extensionRoot: EXT,
    gatewayPort: 1,
    v31: { readPluginConfig: () => undefined, settingsPath: join(root, "none.json") },
    transport,
    apiKey: () => (sendReal ? "test-key" : undefined),
    emit: (event, payload) => events.push({ event, payload }),
    now: () => (t += 1000),
    logger: { info() {}, warn() {}, error() {} },
    families: [holdFamily],
  });
  runtimes.push(rt);
  rt.start();
  return { rt, events };
}

const TAB = "agent:main:tinker:tabX";
const hook = {
  session_id: "claude-sess-1",
  tool_name: "Bash",
  tool_input: { command: "cp /work/demo/a /work/demo/b" },
  tool_use_id: "toolu_1",
  cwd: "/work/demo",
};

describe("runtime feed, tab keys and the canary", () => {
  it("events are keyed by the tab key the hook forwarded, and carry decisionId / toolUseId", async () => {
    const { rt, events } = make();
    void rt.decide("pre-tool", hook, TAB);
    const deadline = Date.now() + 3000;
    while (!events.some((e) => e.event === "amygdala2.intervention") && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    const dec = events
      .filter((e) => e.event === "amygdala2.decision")
      .map((e) => e.payload as Record<string, unknown>);
    expect(dec.length).toBe(2);
    expect(dec.every((d) => d.sessionKey === TAB && d.toolUseId === "toolu_1")).toBe(true);
    const iv = events.find((e) => e.event === "amygdala2.intervention")?.payload as Record<
      string,
      unknown
    >;
    expect(iv).toMatchObject({ sessionKey: TAB, kind: "hold", decisionId: expect.any(String) });
  });

  it("feed rebuilds decision events, intervention views, questions and spend for one tab", async () => {
    const { rt } = make();
    await Promise.race([rt.decide("pre-tool", hook, TAB), new Promise((r) => setTimeout(r, 200))]);
    await new Promise((r) => setTimeout(r, 50));
    const feed = rt.feed({ sessionKey: TAB });
    expect(feed.decisionEvents.map((e) => e.questionId).toSorted()).toEqual([
      "danger-level",
      "runs-or-quotes",
    ]);
    expect(feed.decisionEvents.every((e) => e.sessionKey === TAB)).toBe(true);
    expect(feed.interventions[0]).toMatchObject({
      kind: "hold",
      cmd: "cp /work/demo/a /work/demo/b",
    });
    expect(feed.questions.length).toBe(30);
    expect(feed.questions.find((q) => q.id === "danger-level")).toMatchObject({
      name: "Danger level: how hard is this step to undo?",
      family: "safety",
      today: 1,
      right: null,
    });
    expect(feed.spend.eur30).toBeGreaterThanOrEqual(feed.spend.eur);
    expect(feed.precedents).toBe(0);
    expect(rt.feed({ sessionKey: "someone-else" }).decisionEvents).toEqual([]);
  });

  it("canary: the floor holds the known step and is timed; the judge is timed when it is up, null when it is not", async () => {
    const up = await make(true).rt.canary();
    expect(up.heldBy).toBe("hard-rule");
    expect(up.floorMs).toBeGreaterThanOrEqual(0);
    expect(up.judgeMs).not.toBeNull();
    const down = await make(false).rt.canary();
    expect(down).toMatchObject({ heldBy: "hard-rule", judgeMs: null });
  });
});

describe("feed helpers", () => {
  it("cutoffText covers every cut-off shape", () => {
    expect(cutoffText({ kind: "prob", at: 0.6 })).toBe("p ≥ 0.6");
    expect(cutoffText({ kind: "level", atOrAbove: 2 })).toBe("≥ 2");
    expect(cutoffText({ kind: "level", atOrBelow: 0 })).toBe("≤ 0");
    expect(cutoffText({ kind: "choice", option: "same", at: 0.6, negate: true })).toBe(
      "not same ≥ 0.6",
    );
    expect(cutoffText({ kind: "none" })).toBe("never");
    expect(cutoffText("v3")).toBe("v3");
    expect(cutoffText(null)).toBe("—");
  });

  it("changeView names the question, shows from → to, and carries the replay summary", () => {
    const book = new QuestionBook({ seedDir: join(EXT, "questions") });
    const c: Change = {
      id: "c1",
      ts: 5,
      questionId: "danger-level",
      fromVersion: 1,
      toVersion: null,
      kind: "context-loosen",
      exceptional: false,
      status: "applied",
      replay: {
        cases: 7,
        relaxed: 6,
        tightened: 0,
        mustCatchTotal: 14,
        mustCatchLost: 0,
        controlsTotal: 5,
        controlsNewlyHeld: 0,
        heldOutBetter: null,
        liveCalls: 0,
        proposal: {
          kind: "cutoff",
          scope: "context",
          questionId: "danger-level",
          contextKey: "k",
          cutoff: { kind: "level", atOrAbove: 3 },
        },
      },
      proposedBy: "code",
    };
    expect(changeView(c, book)).toMatchObject({
      questionName: "Danger level: how hard is this step to undo?",
      from: "≥ 2",
      to: "≥ 3",
      status: "applied",
      replaySummary: { relaxed: 6, mustCatchLost: 0, controlsNewlyHeld: 0 },
    });
  });

  it("questionRows: right is the share of labelled judgements that agreed; null without labels", () => {
    const store = new AmygdalaStore(":memory:");
    const book = new QuestionBook({ seedDir: join(EXT, "questions") });
    const sit = buildSituation(
      {
        seam: "pre-tool",
        sessionKey: "k",
        turnId: "t",
        now: 10,
        tool: "Bash",
        toolInput: { command: "ls" },
      },
      { workspaceRoot: "/w", homeDir: "/h" },
    );
    store.saveSituation({ ...sit, id: "s1" });
    store.saveDecision(
      {
        situationId: "s1",
        response: { kind: "hold", ruleOrQuestion: "q", releasable: "user-only" },
        family: "safety",
        reasonCode: "table-d3-low[danger-level]",
        verdictIds: [],
        mode: "enforce",
        enforced: true,
        degraded: false,
      },
      { id: "d1", seam: "pre-tool", ts: 10 },
    );
    store.addLabel({
      id: "l1",
      targetId: "d1",
      targetKind: "decision",
      kind: "judge",
      value: 1,
      source: "user",
      weight: 3,
      ts: 11,
    });
    const rows = questionRows(store, book, 0);
    expect(rows.find((r) => r.id === "danger-level")?.right).toBe(1);
    expect(rows.find((r) => r.id === "runs-or-quotes")?.right).toBeNull();
  });

  it("rebuildEvents skips a decision whose situation record is gone", () => {
    const store = new AmygdalaStore(":memory:");
    const book = new QuestionBook({ seedDir: join(EXT, "questions") });
    const sit = buildSituation(
      {
        seam: "pre-tool",
        sessionKey: "k",
        turnId: "t",
        now: 5,
        tool: "Bash",
        toolInput: { command: "ls" },
      },
      { workspaceRoot: "/w", homeDir: "/h" },
    );
    store.saveSituation({ ...sit, id: "s9" });
    store.saveDecision(
      {
        situationId: "s9",
        response: { kind: "proceed" },
        family: "safety",
        reasonCode: "x[]",
        verdictIds: [],
        mode: "shadow",
        enforced: false,
        degraded: false,
      },
      { id: "d9", seam: "pre-tool", ts: 5 },
    );
    store.pruneRecords(1_000_000); // the situation record is nulled, the decision stays
    expect(rebuildEvents(store, book, { since: 0, limit: 10 })).toEqual({
      decisionEvents: [],
      interventions: [],
    });
  });
});

describe("prompt files in the feed (panel open-to-edit, 2026-09-30)", () => {
  it("a dist prompt opens its source copy when one exists; otherwise the path it was given", () => {
    const repo = mkdtempSync(join(tmpdir(), "amy-edit-"));
    try {
      const src = join(repo, "extensions", "x", "questions", "safety", "a.md");
      const dist = join(repo, "dist", "extensions", "x", "questions", "safety", "a.md");
      mkdirSync(join(src, ".."), { recursive: true });
      writeFileSync(src, "---\n---\n");
      expect(editablePath(dist)).toBe(src);
      const lonely = join(repo, "dist", "extensions", "x", "questions", "safety", "b.md");
      expect(editablePath(lonely)).toBe(lonely);
      expect(editablePath(src)).toBe(src);
      expect(editablePath(undefined)).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("every question row carries the .md file that holds its prompt", () => {
    const store = new AmygdalaStore(":memory:");
    const book = new QuestionBook({ seedDir: join(EXT, "questions") });
    const rows = questionRows(store, book, 0);
    expect(rows.length).toBe(30);
    for (const r of rows) expect(r.file).toMatch(new RegExp(`questions/[a-z-]+/${r.id}\\.md$`));
    store.close();
  });

  // the architect 2026-10-01: "they should be classified into families, like the paper".
  it("rows come by family in the paper's order, prompts in each family's order, with the paper's label", () => {
    const store = new AmygdalaStore(":memory:");
    const book = new QuestionBook({ seedDir: join(EXT, "questions") });
    const rows = questionRows(store, book, 0);
    expect([...new Set(rows.map((r) => r.family))]).toEqual([
      "safety",
      "second-opinion",
      "double-check",
      "personality",
      "efficiency",
    ]);
    expect(rows.map((r) => r.id)).toEqual(FAMILY_PAPER.flatMap((f) => f.prompts));
    expect(rows.find((r) => r.id === "surprise")).toMatchObject({
      family: "personality",
      familyTitle: "Personality",
      familySubtitle: "curiosity, surprise and a steady voice",
    });
    store.close();
  });
});
