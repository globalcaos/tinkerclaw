import {
  seedCards,
  type EnhancementCard,
  type Shortlist,
  type UsageMark,
} from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it, vi } from "vitest";
import { ThalamusStore } from "../src/store.js";
import { createUseTracker } from "../src/use-tracker.js";

const cards = seedCards([
  { kind: "skill", name: "a", description: "Extract a PDF." },
  { kind: "skill", name: "b", description: "Sort photos." },
  { kind: "recipe", name: "Review", description: "Review a diff." },
]);
const byId = new Map<string, EnhancementCard>(cards.map((c) => [c.id, c]));

const list = (over: Partial<Shortlist> = {}): Shortlist => ({
  entries: [
    { cardId: "skill:a", rank: 1, prob: 0.6 },
    { cardId: "skill:b", rank: 2, prob: 0.2 },
  ],
  noneFitsProb: 0.1,
  shown: true,
  reason: "shown",
  source: "local",
  ...over,
});

// A stand-in for attributeToolUsage: Read of a SKILL.md names its skill, `Skill` names one, `browser` is a plugin.
const attribute = (call: { name: string; args?: unknown }): UsageMark[] => {
  const a = (call.args ?? {}) as { path?: string; skill?: string };
  if (call.name === "Read" && a.path?.endsWith("/SKILL.md"))
    return [{ kind: "skill", name: a.path.split("/").at(-2)!, via: "read", path: a.path }];
  if (call.name === "Skill" && a.skill)
    return [{ kind: "skill", name: a.skill, via: "skill-tool" }];
  if (call.name === "browser") return [{ kind: "plugin", name: "browser", via: "plugin-tool" }];
  return [];
};

function setup() {
  const store = new ThalamusStore(":memory:");
  const t = createUseTracker({
    store: () => store,
    cards: () => byId,
    attribute,
    now: () => 5000,
    mode: () => "shadow",
  });
  return { store, t };
}
const shown = (l = list()) => ({
  sessionKey: "s",
  source: "tinker",
  private: false,
  list: l,
  questionVersion: 7,
});

describe("use observation", () => {
  it("joins what was used to the list that was shown, with its rank", () => {
    const { store, t } = setup();
    t.noteShown("run-1", shown());
    t.onToolStart("run-1", { name: "Read", args: { path: "/skills/b/SKILL.md" } });
    const row = t.finish("run-1", "done")!;
    expect(row.used).toEqual([
      { cardId: "skill:b", onList: true, rank: 2, via: "read", how: "unknown" },
    ]);
    expect(row.shown.map((e) => e.cardId)).toEqual(["skill:a", "skill:b"]);
    expect(store.getUse("run-1")).toMatchObject({
      outcome: "done",
      listShown: true,
      questionVersion: 7,
      mode: "shadow",
    });
  });

  it("records a use that was not on the list", () => {
    const { t } = setup();
    t.noteShown("r", shown());
    t.onToolStart("r", { name: "browser", args: {} });
    const row = t.finish("r", "done")!;
    expect(row.used).toEqual([
      { cardId: "plugin:browser", onList: false, via: "plugin-tool", how: "unknown" },
    ]);
  });

  it("records a list that was computed and never used: an unused list is evidence", () => {
    const { store, t } = setup();
    t.noteShown("r", shown());
    const row = t.finish("r", "done")!;
    expect(row.used).toEqual([]);
    expect(store.getUse("r")!.shown).toHaveLength(2);
  });

  it("records a use even when no list was computed", () => {
    const { t } = setup();
    t.onToolStart("r", { name: "Skill", args: { skill: "a" } });
    const row = t.finish("r", "done")!;
    expect(row).toMatchObject({ listShown: false, listReason: "not-asked" });
    expect(row.used[0]).toMatchObject({ cardId: "skill:a", onList: false });
  });

  it("writes nothing for a task with no list and no use", () => {
    const { store, t } = setup();
    t.onToolStart("r", { name: "Bash", args: { command: "ls" } });
    expect(t.finish("r", "done")).toBeUndefined();
    expect(store.counts().uses).toBe(0);
  });

  it("counts an enhancement once, however many tool calls touch it", () => {
    const { t } = setup();
    t.noteShown("r", shown());
    for (let i = 0; i < 3; i++) t.onToolStart("r", { name: "Skill", args: { skill: "a" } });
    expect(t.finish("r", "done")!.used).toHaveLength(1);
  });

  it("stamps the card versions of what was shown and used", () => {
    const { t } = setup();
    t.noteShown("r", shown());
    t.onToolStart("r", { name: "Skill", args: { skill: "Review" } }); // not a card of that kind: no version
    const row = t.finish("r", "done")!;
    expect(row.cardVersions).toEqual({ "skill:a": 1, "skill:b": 1 });
  });

  it("records a task that ended in error as retried", () => {
    const { t } = setup();
    t.noteShown("r", shown());
    expect(t.finish("r", "retried")!.outcome).toBe("retried");
  });

  it("never lets a failing attribution or a failing store break the run", () => {
    const store = new ThalamusStore(":memory:");
    store.close();
    const t = createUseTracker({
      store: () => store,
      cards: () => byId,
      attribute: () => {
        throw new Error("attribution");
      },
      now: () => 1,
      mode: () => "shadow",
    });
    t.noteShown("r", shown());
    expect(() => t.onToolStart("r", { name: "Read", args: {} })).not.toThrow();
    expect(() => t.finish("r", "done")).not.toThrow();
  });

  it("ignores a tool event with no name and forgets a run once it is finished", () => {
    const { t } = setup();
    t.onToolStart("r", {});
    t.onToolStart("r", { name: "" });
    expect(t.open()).toBe(0);
    t.noteShown("r", shown());
    t.finish("r", "done");
    expect(t.open()).toBe(0);
    expect(t.finish("r", "done")).toBeUndefined();
  });

  it("keeps its table of open runs bounded", () => {
    const { t } = setup();
    for (let i = 0; i < 500; i++) t.noteShown(`r${i}`, shown());
    expect(t.open()).toBeLessThanOrEqual(256);
  });

  it("calls the attribution with the id and the arguments of the tool call", () => {
    const store = new ThalamusStore(":memory:");
    const spy = vi.fn(() => [] as UsageMark[]);
    const t = createUseTracker({
      store: () => store,
      cards: () => byId,
      attribute: spy,
      now: () => 1,
      mode: () => "shadow",
    });
    t.onToolStart("r", { name: "Read", args: { path: "/x" }, toolCallId: "tc1" });
    expect(spy).toHaveBeenCalledWith({ name: "Read", args: { path: "/x" }, toolCallId: "tc1" });
  });
});
