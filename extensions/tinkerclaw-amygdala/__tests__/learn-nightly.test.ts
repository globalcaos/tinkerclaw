import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAMILY_FACTORIES, FAMILY_ORDER } from "../src/families/index.js";
import { nightlyWorklist, runNightly, type NightlyDeps } from "../src/learn/nightly.js";
import type { ChangeEngineApi, ChangeOutcome, Proposal, Proposer } from "../src/learn/types.js";
import { QuestionBook } from "../src/question-book.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";
import type { CaseFile, Change } from "../src/types.js";
import { casesRoot, loadCaseFile, seedDir } from "./helpers/family-harness.js";

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
const tmps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noveltyMust = loadCaseFile("must-catch", "personality").find(
  (c) => c.id === "mc-pe-novel-io-log",
) as CaseFile;

/** A control answering novelty at `answer`; with the seed cut-off 0.7 a 0.75 answer is a note, above a "proceed" ceiling. */
function novelCtl(id: string, answer: number, ceiling: "note" | "proceed"): CaseFile {
  const c = structuredClone(noveltyMust) as CaseFile;
  c.id = id;
  c.kind = "control";
  c.description = "test control";
  delete c.mustBeAtLeast;
  c.mustBeAtMost = ceiling;
  c.answers = { novelty: { answer, prob: answer } };
  return c;
}

function corpusWith(extraControls: CaseFile[]): string {
  const dir = mkdtempSync(join(tmpdir(), "amyg-e3-"));
  tmps.push(dir);
  const root = join(dir, "cases");
  cpSync(casesRoot, root, { recursive: true });
  if (extraControls.length) {
    writeFileSync(
      join(root, "controls", "zz-extra.json"),
      JSON.stringify({ cases: extraControls }),
    );
  }
  return root;
}

const change = (): Change => ({
  id: "c",
  ts: T0,
  questionId: "novelty",
  fromVersion: 1,
  toVersion: 2,
  kind: "reword",
  exceptional: false,
  status: "applied",
  replay: {
    cases: 0,
    relaxed: 0,
    tightened: 0,
    mustCatchTotal: 0,
    mustCatchLost: 0,
    heldOutBetter: null,
    liveCalls: 0,
  },
  proposedBy: "nightly-proposer",
});

function setup(root: string, proposer?: Proposer) {
  const store = new AmygdalaStore(":memory:");
  const book = new QuestionBook({ seedDir });
  const order: string[] = [];
  const proposals: { p: Proposal; by?: string }[] = [];
  const engine: ChangeEngineApi = {
    async propose(p, o) {
      order.push(`engine:${p.kind}`);
      proposals.push({ p, by: o?.proposedBy });
      return { outcome: "applied", change: change() } as ChangeOutcome;
    },
    async approve() {
      throw new Error("not used");
    },
    undo: () => ({ ok: false }),
    pending: () => [],
  };
  const deps: NightlyDeps = {
    store,
    book,
    engine,
    now: () => T0,
    families: () => FAMILY_ORDER.map((id) => FAMILY_FACTORIES[id]({ book })),
    casesRoot: root,
    proposer,
  };
  return { deps, order, proposals, store, book };
}

describe("nightlyWorklist", () => {
  it("is empty when every case holds", async () => {
    expect(await nightlyWorklist(setup(corpusWith([])).deps)).toEqual([]);
  });

  it("groups failing cases by question id and omits passing ones", async () => {
    const root = corpusWith([
      novelCtl("ctl-fail-a", 0.75, "proceed"),
      novelCtl("ctl-fail-b", 0.9, "proceed"),
      novelCtl("ctl-pass", 0.3, "proceed"),
    ]);
    const list = await nightlyWorklist(setup(root).deps);
    expect(list.map((i) => i.questionId)).toEqual(["novelty"]);
    const item = list[0]!;
    expect(item.failing.map((f) => f.caseId).toSorted()).toEqual(["ctl-fail-a", "ctl-fail-b"]);
    expect(item.failing[0]).toMatchObject({
      expected: "at most proceed",
      got: "note",
      answers: { novelty: { answer: 0.75, prob: 0.75 } },
    });
  });

  it("a must-catch case below its floor is listed under each question it answers", async () => {
    const root = corpusWith([]);
    const mc = structuredClone(noveltyMust) as CaseFile;
    mc.id = "mc-extra";
    mc.answers = { novelty: { answer: 0.1, prob: 0.1 } };
    mc.mustBeAtLeast = "hold";
    const dir = join(root, "must-catch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "zz-extra.json"), JSON.stringify({ cases: [mc] }));
    const list = await nightlyWorklist(setup(root).deps);
    const f = list
      .find((i) => i.questionId === "novelty")
      ?.failing.find((x) => x.caseId === "mc-extra");
    expect(f?.expected).toBe("at least hold");
  });

  it("never lets question wording into a work item and never opens the eval folder", async () => {
    const root = corpusWith([novelCtl("ctl-fail", 0.75, "proceed")]);
    mkdirSync(join(root, "eval"), { recursive: true });
    writeFileSync(join(root, "eval", "poison.json"), "{ this is not json");
    const s = setup(root);
    const list = await nightlyWorklist(s.deps);
    const text = JSON.stringify(list);
    const q = s.book.get("novelty")!;
    expect(text).not.toContain(q.instructions.slice(0, 40));
    expect(text).not.toContain(noveltyMust.description);
    expect(Object.keys(list[0]!.failing[0]!).toSorted()).toEqual([
      "answers",
      "caseId",
      "expected",
      "got",
    ]);
  });
});

describe("runNightly", () => {
  it("does the online retune, then the worklist, and calls no proposer when none is given", async () => {
    const s = setup(corpusWith([novelCtl("ctl-fail", 0.75, "proceed")]));
    const r = await runNightly(s.deps);
    expect(r.online).toEqual({ tighten: [], loosen: [] });
    expect(r.worklist.map((i) => i.questionId)).toEqual(["novelty"]);
    expect(r.proposals).toEqual([]);
    expect(s.order).toEqual([]);
  });

  it("sends a proposer's candidate to the engine with nightly-proposer", async () => {
    const seen: string[] = [];
    const proposer: Proposer = async ({ question, failing }) => {
      seen.push(`${question.id}:${failing.length}`);
      return { instructions: "test-wording" };
    };
    const s = setup(corpusWith([novelCtl("ctl-fail", 0.75, "proceed")]), proposer);
    const r = await runNightly(s.deps);
    expect(seen).toEqual(["novelty:1"]);
    expect(r.proposals).toHaveLength(1);
    expect(s.proposals[0]).toEqual({
      p: { kind: "reword", questionId: "novelty", candidate: { instructions: "test-wording" } },
      by: "nightly-proposer",
    });
    expect(s.order).toEqual(["engine:reword"]);
  });

  it("proposes the free cut-off change before the reword", async () => {
    const s = setup(corpusWith([novelCtl("ctl-fail", 0.75, "proceed")]), async () => ({
      instructions: "test-wording",
    }));
    const sit = buildSituation(
      { seam: "pre-tool", sessionKey: "s", turnId: "s#1", now: T0 - 1000, originKind: "synthetic" },
      { workspaceRoot: "/work/demo", homeDir: "/home/demo" },
    );
    s.store.saveSituation(sit);
    s.store.saveVerdicts([
      {
        id: "v1",
        situationId: sit.id,
        questionId: "novelty",
        questionVersion: 1,
        type: "noul",
        answer: 0.6,
        prob: 0.6,
        confidence: 0.9,
        cacheHit: false,
        latencyMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        ts: T0 - 1000,
      },
    ]);
    s.store.saveDecision(
      {
        situationId: sit.id,
        response: { kind: "proceed" },
        family: "personality",
        reasonCode: "none",
        verdictIds: ["v1"],
        mode: "enforce",
        enforced: true,
        degraded: false,
      },
      { id: "dec-1", seam: "pre-tool", ts: T0 - 1000 },
    );
    s.store.addLabel({
      id: "l1",
      targetId: "dec-1",
      targetKind: "decision",
      kind: "miss",
      value: 1,
      source: "user",
      weight: 3,
      ts: T0 - 500,
    });
    const r = await runNightly(s.deps);
    expect(s.order).toEqual(["engine:cutoff", "engine:reword"]);
    expect(r.online.tighten).toHaveLength(1);
  });

  it("a throwing or null proposer skips the item and logs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = setup(corpusWith([novelCtl("ctl-fail", 0.75, "proceed")]), async () => {
      throw new Error("model down");
    });
    expect((await runNightly(boom.deps)).proposals).toEqual([]);
    expect(err).toHaveBeenCalledWith("[amygdala] proposer failed", expect.any(Error));
    const none = setup(corpusWith([novelCtl("ctl-fail", 0.75, "proceed")]), async () => null);
    expect((await runNightly(none.deps)).proposals).toEqual([]);
    expect(none.order).toEqual([]);
  });
});
