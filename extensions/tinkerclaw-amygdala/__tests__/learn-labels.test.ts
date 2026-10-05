import { afterEach, describe, expect, it } from "vitest";
import { contextKey } from "../src/learn/keys.js";
import { LabelService } from "../src/learn/labels.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";
import type { Decision, Response, Situation } from "../src/types.js";

const sit = (command: string, id: string): Situation => ({
  ...buildSituation(
    {
      seam: "pre-tool",
      sessionKey: "s",
      turnId: "t",
      now: 1,
      tool: "Bash",
      toolInput: { command },
    },
    { workspaceRoot: "/work/demo", homeDir: "/h" },
  ),
  id,
});

let store: AmygdalaStore;
let n = 0;
const svc = () => new LabelService({ store, now: () => 50, idGen: () => `l${++n}` });

const seed = (
  decisionId: string,
  s: Situation,
  response: Response = { kind: "hold", ruleOrQuestion: "r", releasable: "user-only" },
  reason = "code[q1]",
) => {
  store.saveSituation(s);
  const d: Decision = {
    situationId: s.id,
    response,
    family: "safety",
    reasonCode: reason,
    verdictIds: [],
    mode: "enforce",
    enforced: true,
    degraded: false,
  };
  store.saveDecision(d, { id: decisionId, seam: "pre-tool", ts: 5 });
};

const open = (id: string, decisionId: string, kind: "hold" | "proof" | "ask" = "hold") =>
  store.openIntervention({ id, decisionId, kind, state: "open", ts: 6 });

afterEach(() => store?.close());

describe("label service", () => {
  it("weights follow the source and the default source is user", () => {
    store = new AmygdalaStore(":memory:");
    const l = svc();
    const base = { targetId: "d", targetKind: "decision", kind: "useful", value: 1 } as const;
    expect(l.label(base)).toMatchObject({ source: "user", weight: 3, ts: 50 });
    expect(l.label({ ...base, source: "override" }).weight).toBe(2);
    expect(l.label({ ...base, source: "outcome" }).weight).toBe(1);
    expect(store.labelsFor("d")).toHaveLength(3);
  });

  it("onIntervention: allow-once is a false-alarm override, keep-held a confirm override", () => {
    store = new AmygdalaStore(":memory:");
    const s = sit("rm -rf /work/demo/x", "s1");
    seed("d1", s);
    open("i1", "d1");
    open("i2", "d1", "ask");
    const l = svc();
    l.onIntervention("i1", "allow-once");
    l.onIntervention("i2", "keep-held");
    const labels = store.labelsFor("d1");
    expect(labels.map((x) => [x.kind, x.value, x.source, x.weight])).toEqual([
      ["judge", -1, "override", 2],
      ["judge", 1, "override", 2],
    ]);
    expect(store.getContext(contextKey(s, "q1"), "q1")).toMatchObject({
      falseAlarms: 1,
      confirms: 1,
    });
  });

  it("onIntervention: evidence is a positive outcome; option, timeout and unknown do nothing", () => {
    store = new AmygdalaStore(":memory:");
    seed("d1", sit("ls /work/demo", "s1"));
    open("i1", "d1", "proof");
    const l = svc();
    l.onIntervention("i1", "evidence");
    expect(store.labelsFor("d1").map((x) => [x.kind, x.value, x.source])).toEqual([
      ["outcome", 1, "outcome"],
    ]);
    l.onIntervention("i1", "option:a");
    l.onIntervention("i1", "timeout");
    l.onIntervention("nope", "allow-once");
    expect(store.labelsFor("d1")).toHaveLength(1);
  });

  it("counts move only for the drivers' own context", () => {
    store = new AmygdalaStore(":memory:");
    const a = sit("rm -rf /work/demo/x", "sa");
    const b = sit("rm -rf /other/place/x", "sb");
    seed("da", a, undefined, "code[q1,q2]");
    seed("db", b);
    svc().label({ targetId: "da", targetKind: "decision", kind: "judge", value: -1 });
    expect(store.getContext(contextKey(a, "q1"), "q1")?.falseAlarms).toBe(1);
    expect(store.getContext(contextKey(a, "q2"), "q2")?.falseAlarms).toBe(1);
    expect(store.getContext(contextKey(b, "q1"), "q1")).toBeUndefined();
    expect(store.getContext(contextKey(a, "q3"), "q3")).toBeUndefined();
  });

  it("driversOf with a pruned situation keeps the labels and skips the counts", () => {
    store = new AmygdalaStore(":memory:");
    const s = sit("rm -rf /work/demo/x", "s1");
    seed("d1", s);
    store.pruneRecords(1000);
    const l = svc();
    expect(l.driversOf("d1")).toEqual({ situation: undefined, questionIds: ["q1"] });
    expect(l.driversOf("missing")).toEqual({ situation: undefined, questionIds: [] });
    l.label({ targetId: "d1", targetKind: "decision", kind: "judge", value: -1 });
    expect(store.labelsFor("d1")).toHaveLength(1);
    expect(store.listContextCounts()).toEqual([]);
  });

  it("markMiss writes a weight-3 user miss label and nothing else", () => {
    store = new AmygdalaStore(":memory:");
    const s = sit("ls", "s1");
    seed("d1", s, { kind: "proceed" }, "none");
    const m = svc().markMiss("d1");
    expect(m).toMatchObject({ kind: "miss", value: 1, source: "user", weight: 3 });
    expect(store.listContextCounts()).toEqual([]);
    expect(store.allPrecedents()).toEqual([]);
  });
});
