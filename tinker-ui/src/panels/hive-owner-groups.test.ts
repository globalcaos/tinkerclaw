import { describe, expect, it } from "vitest";
import { groupByOwner, ownerBucket } from "./hive-owner-groups.ts";

const row = (key: string, hiveOwner: string | null, hiveOwnerName: string, hiveScope: string) => ({
  key,
  hiveOwner,
  hiveOwnerName,
  hiveScope,
});

describe("hive owner groups", () => {
  it("single-user rows (no tags) come back untouched", () => {
    const items = [{ key: "a" }, { key: "b" }];
    const r = groupByOwner(
      items,
      (x) => x,
      "me",
      () => false,
    );
    expect(r.ordered).toEqual(items);
    expect(r.headers.size).toBe(0);
  });

  it("open tabs stay on top; the rest is grouped: mine, users by name, shared, system", () => {
    const items = [
      row("open1", "bob", "Bob", "user"),
      row("x1", "bob", "Bob", "user"),
      row("x2", null, "System", "system"),
      row("x3", "me", "Me", "private"),
      row("x4", null, "Shared (before multi-user)", "legacy"),
      row("x5", "ann", "Ann", "user"),
      row("x6", "bob", "Bob", "user"),
    ];
    const r = groupByOwner(
      items,
      (x) => x,
      "me",
      (x) => x.key === "open1",
    );
    expect(r.ordered.map((x) => x.key)).toEqual(["open1", "x3", "x5", "x1", "x6", "x4", "x2"]);
    expect([...r.headers.entries()]).toEqual([
      [1, "Mine"],
      [2, "Ann"],
      [3, "Bob"],
      [5, "Shared (before multi-user)"],
      [6, "System"],
    ]);
  });

  it("buckets a row by owner and scope", () => {
    expect(ownerBucket(row("k", "me", "Me", "private"), "me")?.label).toBe("Mine");
    expect(ownerBucket({ key: "k" }, "me")).toBeNull();
  });
});
