import { describe, expect, it } from "vitest";
import {
  defaultKeyMatch,
  dropBeforeId,
  dropKeyFromOrder,
  liveOrderKeys,
  mergeTabSessionOrder,
  orderSessionsByTabs,
  reorderTabs,
  restoreTabsWithMain,
  sessionKeysOfTabs,
} from "./tab-session-order";

const tabs = (
  ids: Array<[string, string | null]>,
): Array<{ id: string; sessionKey: string | null }> =>
  ids.map(([id, sessionKey]) => ({ id, sessionKey }));

describe("sessionKeysOfTabs", () => {
  it("keeps tab-bar order and skips missing keys", () => {
    expect(
      sessionKeysOfTabs(
        tabs([
          ["tab-main", "agent:main:main"],
          ["tab-a", "tinker:a"],
          ["tab-empty", null],
          ["tab-b", "tinker:b"],
        ]),
      ),
    ).toEqual(["agent:main:main", "tinker:a", "tinker:b"]);
  });

  it("does not emit a duplicated sessionKey twice", () => {
    expect(
      sessionKeysOfTabs(
        tabs([
          ["tab-a", "tinker:a"],
          ["tab-a2", "tinker:a"],
        ]),
      ),
    ).toEqual(["tinker:a"]);
  });
});

describe("reorderTabs", () => {
  const list = tabs([
    ["tab-main", "main"],
    ["tab-a", "a"],
    ["tab-b", "b"],
    ["tab-c", "c"],
  ]);

  it("moves a tab before a later neighbour", () => {
    expect(reorderTabs(list, "tab-a", "tab-c").map((t) => t.id)).toEqual([
      "tab-main",
      "tab-b",
      "tab-a",
      "tab-c",
    ]);
  });

  it("moves a tab before an earlier neighbour", () => {
    expect(reorderTabs(list, "tab-c", "tab-a").map((t) => t.id)).toEqual([
      "tab-main",
      "tab-c",
      "tab-a",
      "tab-b",
    ]);
  });

  it("appends when beforeId is null", () => {
    expect(reorderTabs(list, "tab-a", null).map((t) => t.id)).toEqual([
      "tab-main",
      "tab-b",
      "tab-c",
      "tab-a",
    ]);
  });

  it("can park Main somewhere other than index 0", () => {
    expect(reorderTabs(list, "tab-main", "tab-c").map((t) => t.id)).toEqual([
      "tab-a",
      "tab-b",
      "tab-main",
      "tab-c",
    ]);
  });

  it("is a no-op for an unknown id (returns a copy)", () => {
    const next = reorderTabs(list, "nope", "tab-a");
    expect(next).toEqual(list);
    expect(next).not.toBe(list);
  });

  it("dropping a tab onto its own next sibling puts it back where it was", () => {
    expect(reorderTabs(list, "tab-a", "tab-b").map((t) => t.id)).toEqual(list.map((t) => t.id));
  });
});

describe("mergeTabSessionOrder — open tabs first, closed right after", () => {
  it("closes a middle tab into the slot right after the still-open ones", () => {
    const open = ["main", "foo", "baz"];
    const prev = ["main", "foo", "bar", "baz"];
    expect(mergeTabSessionOrder(open, prev)).toEqual(["main", "foo", "baz", "bar"]);
  });

  it("a reorder of open tabs is mirrored, closed keys keep relative order", () => {
    const open = ["baz", "main", "foo"];
    const prev = ["main", "foo", "bar", "baz"];
    expect(mergeTabSessionOrder(open, prev)).toEqual(["baz", "main", "foo", "bar"]);
  });

  it("a brand-new open tab joins the open prefix", () => {
    expect(mergeTabSessionOrder(["main", "new"], ["main", "old"])).toEqual(["main", "new", "old"]);
  });

  it("does not duplicate short vs canonical forms of the same session", () => {
    expect(
      mergeTabSessionOrder(["tinker:a"], ["agent:main:tinker:a", "tinker:b"], defaultKeyMatch),
    ).toEqual(["tinker:a", "tinker:b"]);
  });
});

describe("orderSessionsByTabs", () => {
  const rows = [
    { key: "agent:main:main", name: "Main" },
    { key: "agent:main:heartbeat", name: "Heartbeat" },
    { key: "agent:main:tinker:foo", name: "Foo" },
    { key: "agent:main:tinker:bar", name: "Bar" },
    { key: "agent:main:tinker:baz", name: "Baz" },
  ];
  const keyOf = (row: { key: string }) => row.key;

  it("paints open tabs first in tab-bar order, then closed, then leftovers", () => {
    const open = ["agent:main:main", "tinker:baz", "tinker:foo"];
    const stored = ["agent:main:main", "tinker:foo", "tinker:bar", "tinker:baz"];
    expect(orderSessionsByTabs(rows, open, stored, keyOf).map((r) => r.name)).toEqual([
      "Main",
      "Baz",
      "Foo",
      "Bar",
      "Heartbeat",
    ]);
  });

  it("matches short tab keys against canonical session rows", () => {
    const open = ["tinker:foo"];
    expect(orderSessionsByTabs(rows, open, [], keyOf).map((r) => r.name)[0]).toBe("Foo");
  });
});

describe("dropBeforeId", () => {
  const ids = ["tab-main", "tab-a", "tab-b"];

  it("leading half of a tab drops before that tab", () => {
    expect(dropBeforeId(ids, "tab-a", true)).toBe("tab-a");
  });

  it("trailing half of a tab drops before the next one", () => {
    expect(dropBeforeId(ids, "tab-a", false)).toBe("tab-b");
  });

  it("trailing half of the last tab appends", () => {
    expect(dropBeforeId(ids, "tab-b", false)).toBeNull();
  });

  it("no tab under the pointer appends", () => {
    expect(dropBeforeId(ids, null, true)).toBeNull();
  });
});

describe("restoreTabsWithMain", () => {
  it("keeps Main where the stored list put it", () => {
    const stored = tabs([
      ["tab-a", "a"],
      ["tab-main", "old-main"],
      ["tab-b", "b"],
    ]);
    const main = { id: "tab-main", sessionKey: "agent:main:main" };
    expect(restoreTabsWithMain(stored, main).map((t) => t.id)).toEqual([
      "tab-a",
      "tab-main",
      "tab-b",
    ]);
    expect(restoreTabsWithMain(stored, main)[1]).toBe(main);
  });

  it("prepends Main when the stored list has none (first load)", () => {
    const stored = tabs([["tab-a", "a"]]);
    const main = { id: "tab-main", sessionKey: "agent:main:main" };
    expect(restoreTabsWithMain(stored, main).map((t) => t.id)).toEqual(["tab-main", "tab-a"]);
  });
});

describe("order maintenance", () => {
  it("liveOrderKeys drops sessions that no longer exist", () => {
    expect(liveOrderKeys(["a", "b", "c"], ["agent:main:b", "c"])).toEqual(["b", "c"]);
  });

  it("dropKeyFromOrder removes short or canonical matches", () => {
    expect(dropKeyFromOrder(["agent:main:tinker:a", "tinker:b"], "tinker:a")).toEqual(["tinker:b"]);
  });
});
