import { describe, it, expect } from "vitest";
import {
  CRON_FILTER_DEFAULT,
  CRON_UNSORTED_ID,
  addCronGroup,
  assignJob,
  buildCronGroupTree,
  canNestUnder,
  cronFilterAccepts,
  cronGroupFoldKey,
  deleteCronGroup,
  groupIdForJob,
  jobsInGroup,
  parseCronFilter,
  parseCronTaxonomy,
  renameCronGroup,
  reorderCronGroups,
  reparentCronGroup,
  serializeCronTaxonomy,
  slugCronGroupId,
  spliceGroupOrder,
  mergeVisibleOrder,
  type CronFilterView,
  type CronTaxonomy,
} from "./cron-taxonomy";

const empty: CronTaxonomy = { groups: [], membership: {} };

const view = (partial: Partial<CronFilterView>): CronFilterView => ({
  enabled: true,
  silent: false,
  failed: false,
  unreadCount: 0,
  ackedCount: 0,
  flagCount: 0,
  openCount: 0,
  ...partial,
});

describe("parseCronTaxonomy", () => {
  it("empty / junk / non-object all degrade to empty", () => {
    expect(parseCronTaxonomy("")).toEqual(empty);
    expect(parseCronTaxonomy("not json")).toEqual(empty);
    expect(parseCronTaxonomy("[]")).toEqual(empty);
    expect(parseCronTaxonomy("null")).toEqual(empty);
    expect(parseCronTaxonomy("42")).toEqual(empty);
  });

  it("drops duplicate ids, reserved Unsorted, and membership pointing at missing groups", () => {
    const tax = parseCronTaxonomy(
      JSON.stringify({
        groups: [
          { id: "night", label: "Night", position: 0, parentId: null },
          { id: "night", label: "Night 2", position: 1, parentId: null },
          { id: "__unsorted__", label: "Nope", position: 2, parentId: null },
          { id: "orphan-child", label: "Orphan", position: 0, parentId: "gone" },
        ],
        membership: { "job-a": "night", "job-b": "missing", "job-c": 3 },
      }),
    );
    expect(tax.groups.map((g) => g.id)).toEqual(["night", "orphan-child"]);
    expect(tax.groups.find((g) => g.id === "orphan-child")?.parentId).toBeNull();
    expect(tax.membership).toEqual({ "job-a": "night" });
  });

  it("round-trips a well-formed taxonomy", () => {
    const tax: CronTaxonomy = {
      groups: [
        { id: "night", label: "Night", position: 0, parentId: null },
        { id: "night-sec", label: "Security", position: 0, parentId: "night" },
      ],
      membership: { "security-updates-check": "night-sec" },
    };
    expect(parseCronTaxonomy(serializeCronTaxonomy(tax))).toEqual(tax);
  });
});

describe("cronFilterAccepts", () => {
  it("all accepts everything", () => {
    expect(cronFilterAccepts(view({ enabled: false, failed: true }), "all")).toBe(true);
  });
  it("unread / flags / failed / disabled / clear each match their own signal", () => {
    expect(cronFilterAccepts(view({ unreadCount: 2 }), "unread")).toBe(true);
    expect(cronFilterAccepts(view({ unreadCount: 0 }), "unread")).toBe(false);
    expect(cronFilterAccepts(view({ ackedCount: 1 }), "acked")).toBe(true);
    expect(cronFilterAccepts(view({ ackedCount: 0 }), "acked")).toBe(false);
    expect(cronFilterAccepts(view({ flagCount: 1 }), "flags")).toBe(true);
    expect(cronFilterAccepts(view({ failed: true }), "failed")).toBe(true);
    expect(cronFilterAccepts(view({ silent: true }), "failed")).toBe(true);
    expect(cronFilterAccepts(view({ enabled: false }), "disabled")).toBe(true);
    expect(cronFilterAccepts(view({ enabled: true, openCount: 0 }), "clear")).toBe(true);
    expect(cronFilterAccepts(view({ openCount: 3 }), "clear")).toBe(false);
    expect(cronFilterAccepts(view({ failed: true, openCount: 0 }), "clear")).toBe(false);
  });
  it("parseCronFilter falls back to all", () => {
    expect(parseCronFilter("unread")).toBe("unread");
    expect(parseCronFilter("nope")).toBe(CRON_FILTER_DEFAULT);
    expect(parseCronFilter(null)).toBe(CRON_FILTER_DEFAULT);
  });
});

describe("groups", () => {
  it("slug + add + two-level cap + Unsorted remainder", () => {
    expect(slugCronGroupId("Night Jobs!", null)).toBe("night-jobs");
    expect(slugCronGroupId("Sec", "night")).toBe("night-sec");
    const added = addCronGroup(empty, "Night", null);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const nested = addCronGroup(added.tax, "Security", added.group.id);
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(canNestUnder(nested.tax, nested.group.id)).toBe(false);
    expect(addCronGroup(nested.tax, "Too deep", nested.group.id).ok).toBe(false);
    const assigned = assignJob(nested.tax, "security-updates-check", nested.group.id);
    expect(groupIdForJob(assigned, "security-updates-check")).toBe(nested.group.id);
    expect(groupIdForJob(assigned, "morning-briefing")).toBe(CRON_UNSORTED_ID);
    const jobs = [
      { id: "security-updates-check" },
      { id: "morning-briefing" },
      { id: "cleaning-lady" },
    ];
    expect(jobsInGroup(assigned, nested.group.id, jobs, (j) => j.id).map((j) => j.id)).toEqual([
      "security-updates-check",
    ]);
    expect(jobsInGroup(assigned, CRON_UNSORTED_ID, jobs, (j) => j.id).map((j) => j.id)).toEqual([
      "morning-briefing",
      "cleaning-lady",
    ]);
  });

  it("delete of a populated group returns jobs to Unsorted; children block delete", () => {
    const night = addCronGroup(empty, "Night", null);
    if (!night.ok) throw new Error("setup");
    const sec = addCronGroup(night.tax, "Security", night.group.id);
    if (!sec.ok) throw new Error("setup");
    expect(deleteCronGroup(sec.tax, night.group.id)).toBeNull();
    const assigned = assignJob(sec.tax, "job-a", sec.group.id);
    const after = deleteCronGroup(assigned, sec.group.id);
    expect(after).not.toBeNull();
    expect(after!.membership["job-a"]).toBeUndefined();
    expect(groupIdForJob(after!, "job-a")).toBe(CRON_UNSORTED_ID);
  });

  it("rename, reorder, reparent (and refuse a 3-level nest)", () => {
    let tax = empty;
    const a = addCronGroup(tax, "A", null);
    if (!a.ok) throw new Error("setup");
    tax = a.tax;
    const b = addCronGroup(tax, "B", null);
    if (!b.ok) throw new Error("setup");
    tax = b.tax;
    const aChild = addCronGroup(tax, "A-child", a.group.id);
    if (!aChild.ok) throw new Error("setup");
    tax = aChild.tax;
    tax = renameCronGroup(tax, a.group.id, "Alpha");
    expect(tax.groups.find((g) => g.id === a.group.id)?.label).toBe("Alpha");
    tax = reorderCronGroups(tax, null, [b.group.id, a.group.id]);
    const tree = buildCronGroupTree(tax.groups);
    expect(tree.map((n) => n.id)).toEqual([b.group.id, a.group.id]);
    // B has no children so it CAN become a sub-group of A.
    const reparented = reparentCronGroup(tax, b.group.id, a.group.id, [b.group.id]);
    expect(reparented).not.toBeNull();
    expect(reparented!.groups.find((g) => g.id === b.group.id)?.parentId).toBe(a.group.id);
    // A has a child, so it cannot become a sub-group of a new top-level.
    const c = addCronGroup(reparented!, "C", null);
    if (!c.ok) throw new Error("setup");
    expect(reparentCronGroup(c.tax, a.group.id, c.group.id, [a.group.id])).toBeNull();
  });
});

describe("spliceGroupOrder", () => {
  it("rewrites only the group's members, leaving the rest in place", () => {
    // cardOrder: nightA, other1, nightB, other2, nightC
    const order = ["night-a", "other-1", "night-b", "other-2", "night-c"];
    const members = ["night-a", "night-b", "night-c"];
    expect(spliceGroupOrder(order, members, ["night-c", "night-a", "night-b"])).toEqual([
      "night-c",
      "other-1",
      "night-a",
      "other-2",
      "night-b",
    ]);
  });

  it("appends a job that just joined the group and had no slot there", () => {
    const order = ["a1", "a2", "b1", "b2"];
    expect(spliceGroupOrder(order, ["b1", "x", "b2"], ["b1", "x", "b2"])).toEqual([
      "a1",
      "a2",
      "b1",
      "x",
      "b2",
    ]);
  });
});

describe("mergeVisibleOrder keeps a within-group reorder", () => {
  it("rewrites only the visible pair and leaves hidden siblings where they were", () => {
    // Night group on screen as b, a; hidden u stays put.
    expect(mergeVisibleOrder(["a", "b", "u"], ["b", "a"])).toEqual(["b", "a", "u"]);
  });
});

describe("mergeVisibleOrder", () => {
  it("writes visible as-is when nothing is stored yet", () => {
    expect(mergeVisibleOrder([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("keeps hidden cards in their slots and rewrites only the visible block", () => {
    expect(mergeVisibleOrder(["n1", "n2", "u1", "u2"], ["u2", "u1"])).toEqual([
      "n1",
      "n2",
      "u2",
      "u1",
    ]);
  });

  it("appends newly visible ids and never drops a stored hidden id", () => {
    expect(mergeVisibleOrder(["n1", "u1"], ["u1", "new"])).toEqual(["n1", "u1", "new"]);
  });
});

describe("cronGroupFoldKey", () => {
  it("namespaces under cron:group:", () => {
    expect(cronGroupFoldKey("night")).toBe("cron:group:night");
  });
});
