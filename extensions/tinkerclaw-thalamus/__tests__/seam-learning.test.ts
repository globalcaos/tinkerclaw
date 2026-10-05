import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnhancementCard, Shortlist } from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW, R, supplies } from "../../../src/shared/thalamus-v4.test-support.js";
import { parseConfig } from "../src/config.js";
import type { ReadInput, RoutingReader } from "../src/reads/routing-reader.js";
import { createRuntime } from "../src/runtime.js";
import { createShortlistSeam } from "../src/shortlist-seam.js";
import { ThalamusStore } from "../src/store.js";
import { createUseTracker } from "../src/use-tracker.js";

// Phase F at the prompt: the overnight shuffle, the task kind on each use, and the replay text.

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const card = (id: string): EnhancementCard => ({
  id,
  kind: "skill",
  name: id.split(":")[1],
  family: "other",
  purpose: "does a thing",
  structure: "",
  alsoServed: [],
  version: 1,
  status: "active",
  origin: "seed",
});
const cards = ["skill:a", "skill:b", "skill:c", "skill:d"].map(card);

const LIST: Shortlist = {
  entries: [
    { cardId: "skill:a", rank: 1, prob: 0.5 },
    { cardId: "skill:b", rank: 2, prob: 0.3 },
    { cardId: "skill:c", rank: 3, prob: 0.1 },
    { cardId: "skill:d", rank: 4, prob: 0.05 },
  ],
  noneFitsProb: 0.05,
  shown: true,
  reason: "shown",
  source: "jev",
};

const input = (
  over: Partial<ReadInput & { runId: string }> = {},
): ReadInput & { runId: string } => ({
  id: "t1",
  runId: "t1",
  ts: NOW,
  sessionKey: "agent:main:tinker:x",
  text: "Fix the failing unit test in this TypeScript function",
  source: "tinker",
  trigger: "user",
  ...over,
});

function seamWith(o: {
  mode?: "shadow" | "enforce";
  priv?: boolean;
  learning?: Partial<NonNullable<Parameters<typeof createShortlistSeam>[0]["learning"]>> | null;
  rand?: () => number;
}) {
  const store = new ThalamusStore(":memory:");
  const mode = o.mode ?? "enforce";
  const tracker = createUseTracker({
    store: () => store,
    cards: () => new Map(cards.map((c) => [c.id, c])),
    attribute: () => [],
    now: () => NOW,
    mode: () => mode,
  });
  const reader = {
    readTask: async () => ({ shortlist: LIST, usedJev: false, enhancementVersion: 1 }),
    isPrivate: () => o.priv ?? false,
  } as unknown as RoutingReader;
  const recorded: Array<[string, string]> = [];
  const learning =
    o.learning === null
      ? undefined
      : {
          shuffle: () => true,
          rand: o.rand ?? (() => 0.05),
          replayAllowed: () => false,
          recordReplay: (id: string, text: string) => void recorded.push([id, text]),
          ...o.learning,
        };
  const seam = createShortlistSeam({
    reader,
    cards: () => cards,
    mode: () => mode,
    budgetMs: () => 500,
    tracker,
    ...(learning ? { learning } : {}),
  });
  return { seam, tracker, store, recorded };
}

describe("the overnight shuffle at the prompt", () => {
  it("in enforce, on a cron job, with the switch on and a small draw, shows the list shuffled and records that it did", async () => {
    const t = seamWith({});
    const out = await t.seam.prepare(input({ trigger: "cron" }));
    expect(out.list.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(new Set(out.list.entries.map((e) => e.cardId))).toEqual(
      new Set(LIST.entries.map((e) => e.cardId)),
    );
    expect(out.list.entries.map((e) => e.cardId)).not.toEqual(LIST.entries.map((e) => e.cardId));
    for (const e of out.list.entries)
      expect(e.prob).toBe(LIST.entries.find((x) => x.cardId === e.cardId)!.prob);
    const row = t.tracker.finish("t1", "done")!;
    expect(row.shuffled).toBe(true);
    expect(row.shown.map((s) => s.cardId)).toEqual(out.list.entries.map((e) => e.cardId));
  });

  it("never in shadow (the agent sees nothing there), never off a cron job, never for a private task", async () => {
    for (const [mode, trigger, priv] of [
      ["shadow", "cron", false],
      ["enforce", "user", false],
      ["enforce", "cron", true],
    ] as const) {
      const t = seamWith({ mode, priv });
      const out = await t.seam.prepare(input({ trigger }));
      expect(
        out.list.entries.map((e) => e.cardId),
        `${mode} ${trigger} ${priv}`,
      ).toEqual(LIST.entries.map((e) => e.cardId));
      expect(t.tracker.finish("t1", "done")!.shuffled).toBe(false);
    }
  });

  it("never with the switch off, and never on a large draw", async () => {
    const off = seamWith({ learning: { shuffle: () => false } });
    expect((await off.seam.prepare(input({ trigger: "cron" }))).list.entries[0].cardId).toBe(
      "skill:a",
    );
    const big = seamWith({ rand: () => 0.9 });
    expect((await big.seam.prepare(input({ trigger: "cron" }))).list.entries[0].cardId).toBe(
      "skill:a",
    );
  });

  it("with no learning hook at all, behaves exactly as it did before phase F: the list untouched, no task kind, no replay", async () => {
    const t = seamWith({ learning: null });
    const out = await t.seam.prepare(input({ trigger: "cron" }));
    expect(out.list).toEqual(LIST);
    const row = t.tracker.finish("t1", "done")!;
    expect(row.shuffled).toBe(false);
    expect(row.taskKind).toBeUndefined();
    expect(t.recorded).toEqual([]);
  });
});

describe("the task kind and the replay capture", () => {
  it("records the task's kind of work on the use, from the local read", async () => {
    const t = seamWith({});
    await t.seam.prepare(input());
    expect(t.tracker.finish("t1", "done")!.taskKind).toBe("code");
  });

  it("hands the text to the replay set only when the hook allows it, and a hook that throws breaks nothing", async () => {
    const no = seamWith({});
    await no.seam.prepare(input());
    expect(no.recorded).toEqual([]);
    const yes = seamWith({ learning: { replayAllowed: () => true } });
    await yes.seam.prepare(input());
    expect(yes.recorded).toEqual([["t1", input().text]]);
    const boom = vi.fn(() => {
      throw new Error("disk full");
    });
    const bad = seamWith({ learning: { replayAllowed: () => true, recordReplay: boom } });
    await expect(bad.seam.prepare(input())).resolves.toBeDefined();
    expect(boom).toHaveBeenCalled();
  });
});

describe("the replay set through the runtime: redacted, approved sources only, learning on", () => {
  const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const make = (raw: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), "thalamus-replay-"));
    dirs.push(root);
    const store = new ThalamusStore(":memory:");
    const rt = createRuntime({
      config: parseConfig({ dataDir: join(root, "data"), mode: "shadow", ...raw }),
      extensionRoot,
      gatewayPort: 18789,
      gatewayCfg: () => ({}),
      onAgentEvent: () => () => {},
      broadcast: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => NOW,
      readBoard: () => ({
        rungs: [R.opus],
        supplies: supplies(),
        contextWindowFor: () => 1_000_000,
        dialIdx: 1,
        builtAtMs: NOW,
      }),
      handPicked: () => false,
      listing: () => [],
      attribute: () => [],
      readText: () => "",
      defer: (fn) => fn(),
      store,
    });
    stops.push(() => rt.stop());
    return { rt, store };
  };
  const text =
    "Please review the contract for jane.doe@example.com and call +34 600 123 456 about the clauses";
  const prep = (rt: ReturnType<typeof make>["rt"], source: string, id = "r1") =>
    rt
      .shortlist()!
      .prepare({ id, runId: id, ts: NOW, sessionKey: `k:${id}`, text, source, trigger: "user" });

  it("keeps a redacted copy of a task from an ordinary source, and never the original text", async () => {
    const t = make({ learning: { enabled: true } });
    await t.rt.start();
    await prep(t.rt, "tinker");
    const [row] = t.store.listReplayTexts();
    expect(row.taskId).toBe("r1");
    expect(row.text).toContain("[email]");
    expect(row.text).not.toContain("jane.doe@example.com");
    expect(row.text).not.toContain("600 123 456");
  });

  it("clips it to the configured length", async () => {
    const t = make({ learning: { enabled: true, replayMaxChars: 200 } });
    await t.rt.start();
    await t.rt
      .shortlist()!
      .prepare({
        id: "r2",
        runId: "r2",
        ts: NOW,
        sessionKey: "k",
        text: "word ".repeat(400),
        source: "tinker",
        trigger: "user",
      });
    expect(t.store.listReplayTexts()[0].text.length).toBeLessThanOrEqual(200);
  });

  it("keeps nothing with learning off", async () => {
    const t = make({});
    await t.rt.start();
    await prep(t.rt, "tinker");
    expect(t.store.listReplayTexts()).toEqual([]);
  });

  it("keeps nothing from a private source, unless the owner approved that source for Jev", async () => {
    const closed = make({ learning: { enabled: true } });
    await closed.rt.start();
    await prep(closed.rt, "channel:whatsapp");
    expect(closed.store.listReplayTexts()).toEqual([]);
    const open = make({
      learning: { enabled: true },
      privacy: { jevApprovedSources: ["channel:whatsapp"] },
    });
    await open.rt.start();
    await prep(open.rt, "channel:whatsapp");
    expect(open.store.listReplayTexts()).toHaveLength(1);
    await prep(open.rt, "channel:teams", "r3");
    expect(open.store.listReplayTexts()).toHaveLength(1);
  });
});
