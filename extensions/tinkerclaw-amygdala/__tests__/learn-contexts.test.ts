import { afterEach, describe, expect, it } from "vitest";
import {
  createCutoffResolver,
  recordAlarms,
  recordConfirm,
  recordFalseAlarm,
} from "../src/learn/contexts.js";
import { contextKey } from "../src/learn/keys.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";
import type { Decision, Question, Response, Situation } from "../src/types.js";

const sit = (command: string, root = "/work/demo"): Situation =>
  buildSituation(
    {
      seam: "pre-tool",
      sessionKey: "s",
      turnId: "t",
      now: 1,
      tool: "Bash",
      toolInput: { command },
    },
    { workspaceRoot: root, homeDir: "/h" },
  );

const dec = (response: Response, reasonCode: string): Decision => ({
  situationId: "sit",
  response,
  family: "safety",
  reasonCode,
  verdictIds: [],
  mode: "enforce",
  enforced: true,
  degraded: false,
});

let store: AmygdalaStore;
afterEach(() => store?.close());

describe("learn contexts", () => {
  it("resolver returns an override only for the exact context key", () => {
    store = new AmygdalaStore(":memory:");
    const a = sit("rm -rf /work/demo/tmp/x");
    const b = sit("rm -rf /other/place/x");
    store.saveContextOverride({
      questionId: "q1",
      contextKey: contextKey(a, "q1"),
      cutoff: { kind: "prob", at: 0.9 },
      changeId: "c1",
    });
    const resolve = createCutoffResolver(store);
    const q = { id: "q1" } as Question;
    expect(resolve(q, a)).toEqual({ kind: "prob", at: 0.9 });
    expect(resolve(q, b)).toBeUndefined();
    expect(resolve({ id: "q2" } as Question, a)).toBeUndefined();
  });

  it("recordAlarms counts drivers of acting decisions only", () => {
    store = new AmygdalaStore(":memory:");
    const s = sit("rm -rf /work/demo/x");
    const hold: Response = { kind: "hold", ruleOrQuestion: "r", releasable: "user-only" };
    recordAlarms(store, s, dec(hold, "code[q1,q2]"), 10);
    recordAlarms(store, s, dec({ kind: "proceed" }, "none[q1]"), 11);
    recordAlarms(store, s, dec({ kind: "refusal" }, "refusal[q1]"), 12);
    expect(store.getContext(contextKey(s, "q1"), "q1")?.alarms).toBe(1);
    expect(store.getContext(contextKey(s, "q2"), "q2")?.alarms).toBe(1);
    expect(store.getContext(contextKey(s, "q1"), "q1")?.lastTs).toBe(10);
  });

  it("false-alarm and confirm counters accumulate per context without leaking", () => {
    store = new AmygdalaStore(":memory:");
    const a = sit("rm -rf /work/demo/x");
    const b = sit("rm -rf /other/place/x");
    recordFalseAlarm(store, a, ["q1"], 1);
    recordFalseAlarm(store, a, ["q1"], 2);
    recordConfirm(store, a, ["q1"], 3);
    recordConfirm(store, b, ["q1"], 4);
    const ca = store.getContext(contextKey(a, "q1"), "q1");
    expect(ca).toMatchObject({ falseAlarms: 2, confirms: 1, alarms: 0 });
    const cb = store.getContext(contextKey(b, "q1"), "q1");
    expect(cb).toMatchObject({ falseAlarms: 0, confirms: 1 });
  });
});
