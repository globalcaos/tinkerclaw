import { describe, expect, it } from "vitest";
import { AmygdalaStore } from "../src/store.js";

describe("store learning queries", () => {
  it("listContextCounts filters by question and by time", () => {
    const st = new AmygdalaStore(":memory:");
    st.bumpContext("k1", "danger-level", { alarms: 2 }, 100);
    st.bumpContext("k2", "danger-level", { falseAlarms: 1 }, 200);
    st.bumpContext("k3", "refusal", { confirms: 1 }, 300);
    expect(st.listContextCounts()).toHaveLength(3);
    expect(st.listContextCounts({ questionId: "danger-level" }).map((c) => c.contextKey)).toEqual([
      "k1",
      "k2",
    ]);
    expect(st.listContextCounts({ sinceTs: 250 }).map((c) => c.contextKey)).toEqual(["k3"]);
    expect(st.listContextCounts({ questionId: "danger-level", sinceTs: 150 })[0]).toMatchObject({
      contextKey: "k2",
      falseAlarms: 1,
    });
  });
  it("listLabels filters by kind and time, oldest first, and honours the limit", () => {
    const st = new AmygdalaStore(":memory:");
    const l = (id: string, kind: "judge" | "useful" | "miss", ts: number) =>
      st.addLabel({
        id,
        targetId: `t-${id}`,
        targetKind: "decision",
        kind,
        value: 1,
        source: "user",
        weight: 3,
        ts,
      });
    l("a", "judge", 10);
    l("b", "useful", 20);
    l("c", "judge", 30);
    expect(st.listLabels().map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(st.listLabels({ kind: "judge" }).map((x) => x.id)).toEqual(["a", "c"]);
    expect(st.listLabels({ sinceTs: 15 }).map((x) => x.id)).toEqual(["b", "c"]);
    expect(st.listLabels({ limit: 1 })).toHaveLength(1);
  });
});
