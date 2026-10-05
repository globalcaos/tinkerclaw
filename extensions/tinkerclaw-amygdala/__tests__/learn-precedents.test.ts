import { afterEach, describe, expect, it } from "vitest";
import { PrecedentIndex } from "../src/learn/precedents.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";
import type { Decision, Situation } from "../src/types.js";

const sit = (command: string, id = "sit-1"): Situation => ({
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
const index = (threshold?: number) =>
  new PrecedentIndex({ store, threshold, now: () => 100, idGen: () => `p${++n}` });

afterEach(() => store?.close());

describe("precedent index", () => {
  it("one incident matches an exact repeat and a rewording", () => {
    store = new AmygdalaStore(":memory:");
    const ix = index();
    ix.add(sit("rm -rf /a/b/HR"), "should-hold", "inc-1");
    expect(ix.match(sit("rm -rf /a/b/HR"))).toEqual({ shouldHold: true, refs: ["inc-1"] });
    expect(ix.match(sit("rm -r -f /x/y/HR"))).toEqual({ shouldHold: true, refs: ["inc-1"] });
  });

  it("a different target or verb does not match", () => {
    store = new AmygdalaStore(":memory:");
    const ix = index();
    ix.add(sit("rm -rf /a/b/HR"), "should-hold", "inc-1");
    expect(ix.match(sit("rm -rf /a/b/other")).shouldHold).toBe(false);
    expect(ix.match(sit("cp /a/b/HR /a/c/HR")).shouldHold).toBe(false);
  });

  it("a near miss below the threshold does not match", () => {
    store = new AmygdalaStore(":memory:");
    const ix = index(0.9);
    ix.add(sit("rm -rf /a/b/HR old"), "should-hold", "inc-1");
    expect(ix.match(sit("rm -rf /a/b/HR")).shouldHold).toBe(false);
  });

  it("a harmless precedent at least as similar cancels a should-hold of lower similarity", () => {
    store = new AmygdalaStore(":memory:");
    const ix = index(0.3);
    ix.add(sit("rm -rf /a/b/HR old"), "should-hold", "inc-1");
    ix.add(sit("rm -rf /a/b/HR"), "harmless", "inc-2");
    const m = ix.match(sit("rm -rf /a/b/HR"));
    expect(m.shouldHold).toBe(false);
    expect(m.refs).toEqual(["inc-1"]);
  });

  it("addFromDecision uses the stored situation, and returns null when it was pruned", () => {
    store = new AmygdalaStore(":memory:");
    const s = sit("rm -rf /a/b/HR", "sit-A");
    store.saveSituation(s);
    const d: Decision = {
      situationId: "sit-A",
      response: { kind: "proceed" },
      family: "safety",
      reasonCode: "none",
      verdictIds: [],
      mode: "enforce",
      enforced: true,
      degraded: false,
    };
    store.saveDecision(d, { id: "dec-A", seam: "pre-tool", ts: 5 });
    const ix = index();
    const p = ix.addFromDecision("dec-A", "should-hold");
    expect(p?.incidentRef).toBe("dec-A");
    expect(ix.match(sit("rm -rf /a/b/HR")).shouldHold).toBe(true);
    store.pruneRecords(1000);
    expect(ix.addFromDecision("dec-A", "should-hold")).toBeNull();
    expect(ix.addFromDecision("missing", "harmless")).toBeNull();
  });

  it("hits bump on every matched precedent and the hook has the same shape as match", () => {
    store = new AmygdalaStore(":memory:");
    const ix = index();
    ix.add(sit("rm -rf /a/b/HR"), "should-hold", "inc-1");
    const hook = ix.asDecideHook();
    expect(hook(sit("rm -rf /a/b/HR"))).toEqual({ shouldHold: true, refs: ["inc-1"] });
    hook(sit("rm -rf /a/b/HR"));
    expect(store.allPrecedents()[0]?.hits).toBe(2);
  });
});
