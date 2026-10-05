import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { DecideResult } from "../src/decide.js";
import { contextKey } from "../src/learn/keys.js";
import { createLearning, type Learning } from "../src/learning.js";
import { QuestionBook } from "../src/question-book.js";
import type { SessionMap } from "../src/rewind.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";
import type { Decision, Situation } from "../src/types.js";

const extensionRoot = new URL("..", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(sessionMap?: SessionMap) {
  const dataDir = mkdtempSync(join(tmpdir(), "amy-learning-"));
  dirs.push(dataDir);
  const store = new AmygdalaStore(":memory:");
  const book = new QuestionBook({ seedDir: join(extensionRoot, "questions") });
  let t = 1_000_000;
  const learning: Learning = createLearning({
    store,
    book,
    jev: { ask: async () => [] },
    config: parseConfig({ mode: "enforce" }),
    extensionRoot,
    dataDir,
    emit: () => {},
    now: () => t++,
    sessionMap,
  });
  return { store, book, learning, dataDir };
}

const sit = (command: string): Situation =>
  buildSituation(
    {
      seam: "pre-tool",
      sessionKey: "s",
      turnId: "s#1",
      now: 1,
      tool: "Bash",
      toolInput: { command },
    },
    { workspaceRoot: "/work/demo", homeDir: "/home/demo" },
  );

function storeHold(store: AmygdalaStore, s: Situation, decisionId: string): Decision {
  store.saveSituation(s);
  const d: Decision = {
    situationId: s.id,
    response: { kind: "hold", ruleOrQuestion: "danger-level", releasable: "user-only" },
    family: "safety",
    reasonCode: "table-d3-low[danger-level]",
    verdictIds: [],
    mode: "enforce",
    enforced: true,
    degraded: false,
  };
  store.saveDecision(d, { id: decisionId, seam: "pre-tool", ts: 5 });
  return d;
}

describe("createLearning", () => {
  it("cutoffFor returns a stored context override only for the exact context", () => {
    const { store, book, learning } = setup();
    const s = sit("cp /work/demo/a /work/demo/b");
    const q = book.get("danger-level")!;
    expect(learning.cutoffFor(q, s)).toBeUndefined();
    store.saveContextOverride({
      questionId: q.id,
      contextKey: contextKey(s, q.id),
      cutoff: { kind: "level", atOrAbove: 3 },
      changeId: "c1",
    });
    expect(learning.cutoffFor(q, s)).toEqual({ kind: "level", atOrAbove: 3 });
    expect(learning.cutoffFor(q, sit("git push origin main"))).toBeUndefined();
  });

  it("a miss label stores the label and makes a precedent at once; a similar step then carries it", () => {
    const { store, learning } = setup();
    const s = sit("cp /work/demo/cv.pdf /shared/public/cv.pdf");
    storeHold(store, s, "d1");
    const r = learning.label({ targetId: "d1", targetKind: "decision", kind: "miss", value: 1 });
    expect(r.precedent).toBe(true);
    expect(r.label).toMatchObject({ kind: "miss", weight: 3, source: "user" });
    const hook = learning.precedents(sit("cp /elsewhere/cv.pdf /shared/public/cv.pdf"));
    expect(hook.shouldHold).toBe(true);
    expect(learning.precedents(sit("ls /work/demo")).shouldHold).toBe(false);
  });

  it("a miss on a pruned decision still labels but makes no precedent", () => {
    const { learning } = setup();
    const r = learning.label({ targetId: "nope", targetKind: "decision", kind: "miss", value: 1 });
    expect(r.precedent).toBe(false);
    expect(r.label.kind).toBe("miss");
  });

  it("useful -1 on a decision counts a false alarm for its drivers, in their own context only", () => {
    const { store, learning } = setup();
    const s = sit("cp /work/demo/a /work/demo/b");
    storeHold(store, s, "d2");
    learning.label({ targetId: "d2", targetKind: "decision", kind: "useful", value: -1 });
    expect(store.getContext(contextKey(s, "danger-level"), "danger-level")?.falseAlarms).toBe(1);
    expect(
      store.getContext(contextKey(sit("git push"), "danger-level"), "danger-level"),
    ).toBeUndefined();
  });

  it("observe counts alarms of an acting decision and ignores a proceed", () => {
    const { store, learning } = setup();
    const s = sit("cp /work/demo/a /work/demo/b");
    const acting = {
      situation: s,
      decision: {
        situationId: s.id,
        response: { kind: "hold", ruleOrQuestion: "q", releasable: "user-only" },
        family: "safety",
        reasonCode: "table-d3-low[danger-level]",
        verdictIds: [],
        mode: "enforce",
        enforced: true,
        degraded: false,
      },
    } as unknown as DecideResult;
    learning.observe(acting);
    expect(store.getContext(contextKey(s, "danger-level"), "danger-level")?.alarms).toBe(1);
    const proceed = {
      situation: s,
      decision: { ...acting.decision, response: { kind: "proceed" } },
    } as unknown as DecideResult;
    learning.observe(proceed);
    expect(store.getContext(contextKey(s, "danger-level"), "danger-level")?.alarms).toBe(1);
  });

  it("approve: an id that is not an exceptional change is refused as not-exceptional; pending count starts at 0", async () => {
    const { learning } = setup();
    expect(await learning.approve("does-not-exist", true)).toEqual({
      ok: false,
      error: "not-exceptional",
    });
    expect(learning.pendingCount()).toBe(0);
    expect(learning.undo("does-not-exist")).toMatchObject({ ok: false });
  });

  it("questionRecord and changes", () => {
    const { learning } = setup();
    expect(learning.questionRecord("danger-level")?.id).toBe("danger-level");
    expect(learning.questionRecord("nope")).toBeUndefined();
    expect(learning.changes()).toEqual([]);
  });

  it("a reword through propose without a live judge is rejected as no-effect (nothing to replay it with)", async () => {
    const { learning } = setup();
    const out = await learning.propose("danger-level", { instructions: "x" }, "nightly-script");
    expect(out).toMatchObject({ outcome: "rejected" });
  });

  it("propose refuses a hard-rule id and an unknown question", async () => {
    const { learning } = setup();
    expect(await learning.propose("hard-rule-FS", { instructions: "x" }, "code")).toMatchObject({
      outcome: "rejected",
      reason: "hard-rule",
    });
    expect(await learning.propose("nope", { instructions: "x" }, "code")).toMatchObject({
      outcome: "rejected",
      reason: "unknown-question",
    });
  });
});

describe("nightly through learning", () => {
  it("on a fresh store: no online changes, and a worklist that lists no ids or wording it should not", async () => {
    const { learning } = setup();
    const r = await learning.nightly();
    expect(r.online).toEqual({ tighten: [], loosen: [] });
    expect(Array.isArray(r.worklist)).toBe(true);
    expect(r.proposals).toEqual([]);
    expect(JSON.stringify(r.worklist)).not.toContain("instructions");
  });
});

describe("rewind through learning is inert without a session map", () => {
  it("reports unsupported and touches nothing", () => {
    const { learning, dataDir } = setup();
    expect(learning.rewind({ sessionKey: "k", turnId: "t" })).toMatchObject({
      ok: false,
      capability: "unsupported",
    });
    expect(() => writeFileSync(join(dataDir, "probe"), "x")).not.toThrow();
  });
});
