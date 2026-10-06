import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  registerTaskRanker,
  type RankedEntry,
  type RankResult,
  type TaskRanking,
} from "openclaw/plugin-sdk/fork-thalamus";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import register from "../index.js";
import { invalidateRecipeIndexCache } from "../recipe-matcher.js";

// Broca retrieval v2, phase E: the matcher hook reads the one ranked result per task. The real plugin is registered with a
// test api and the real before_prompt_build hook is called, in a temp OPENCLAW_HOME with one recipe the lexical matcher finds.

const entry = (
  cardId: string,
  mode: "USE" | "INSPIRE",
  source: "jev" | "local",
  score: number,
  section?: string,
): RankedEntry => ({
  cardId,
  mode,
  source,
  score,
  modeScore: score,
  recallRank: 0,
  ...(section ? { section, sectionSource: source } : {}),
});
const ranked = (
  use: RankedEntry[],
  inspire: RankedEntry[],
  source: RankResult["source"],
): TaskRanking => ({
  ranked: true,
  runId: "run-1",
  basis: "own",
  result: { use, inspire, source, asked: 3, answered: 3, dropped: 0 },
});

let home: string;
let prevHome: string | undefined;
let prevUserHome: string | undefined;
let hook: (e: unknown, c: unknown) => Promise<{ prependSystemContext?: string } | undefined>;
let events: Array<{
  stream?: string;
  data?: { kind?: string; message?: string; payload?: Record<string, unknown>; phase?: string };
}>;
const logs: string[] = [];

beforeAll(async () => {
  prevHome = process.env.OPENCLAW_HOME;
  prevUserHome = process.env.HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "matcher-hook-"));
  process.env.OPENCLAW_HOME = home;
  // The plugin keeps its plan files under os.homedir() (a worker thread's HOME change does not reach it): without this a test
  // run writes plans into the live workspace.
  process.env.HOME = home;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  await fs.mkdir(path.join(home, "recipes", "trip-planner-recipe"), { recursive: true });
  await fs.writeFile(
    path.join(home, "recipes", "trip-planner-recipe", "recipe.md"),
    `---\nslug: "trip-planner-recipe"\ntitle: "Plan a family trip"\nsummary: "flights and a motorhome for the family holiday"\ntriggers: ["plan a family trip", "motorhome holiday", "family holiday flights"]\n---\n### 1. Pick dates\nbody\n### 2. Flights\nbody\n`,
  );
  invalidateRecipeIndexCache();
  events = [];
  const hooks: Array<{
    name: string;
    fn: (e: unknown, c: unknown) => Promise<unknown>;
    priority?: number;
  }> = [];
  const api = createTestPluginApi({
    id: "tinkerclaw-prefrontal",
    logger: {
      debug() {},
      info: (m: string) => void logs.push(m),
      warn: (m: string) => void logs.push(`WARN ${m}`),
      error: (m: string) => void logs.push(`ERROR ${m}`),
    } as never,
    config: { plugins: { entries: {} } } as never,
    on: ((name: string, fn: never, opts?: { priority?: number }) =>
      void hooks.push({ name, fn, priority: opts?.priority })) as never,
    broadcast: ((_ev: string, payload: never) => void events.push(payload)) as never,
  } as never);
  (api as unknown as { broadcast: unknown }).broadcast = (_ev: string, payload: never) =>
    void events.push(payload);
  register(api as never);
  const matcher = hooks
    .filter((h) => h.name === "before_prompt_build")
    .find((h) => h.priority === 20);
  if (!matcher) throw new Error("the matcher hook was not registered");
  hook = matcher.fn as never;
  // the plan store must be under the temp home, never the live workspace
  expect(logs.find((l) => l.includes("planRootDir="))).toContain(home);
});
afterAll(async () => {
  if (prevHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = prevHome;
  vi.restoreAllMocks();
  if (prevUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevUserHome;
  await fs.rm(home, { recursive: true, force: true });
});

const TRIP = "Plan a family trip with a motorhome holiday and flights to Scotland in August";
// a session of its own per call: a seeded plan stays in the plan store and would turn the next test into "plan in progress"
let n = 0;
const tinker = {
  get sessionKey() {
    n += 1;
    return `agent:main:tinker:t${n}`;
  },
  runId: "run-1",
  trigger: "user",
};
const trail = (kind: string) =>
  events.filter((e) => e.data?.phase === "prefrontal-trail-event" && e.data.kind === kind);

describe("the matcher hook on the shared ranking", () => {
  it("runs for a Tinker tab (it used to return for anything not ending :main), with no ranker: lexical, as before", async () => {
    events.length = 0;
    const out = await hook({ prompt: TRIP, messages: [] }, { ...tinker, runId: "r-plain" });
    expect(out?.prependSystemContext).toContain("<active_recipe");
    expect(trail("matched").length + trail("merged").length).toBeGreaterThan(0);
    expect(out?.prependSystemContext).not.toContain("<recipe_advice");
  });

  it("still never runs for a subagent, a cron job, a heartbeat or a channel chat", async () => {
    for (const ctx of [
      { ...tinker, sessionKey: "agent:main:subagent:x" },
      { ...tinker, sessionKey: "agent:main:cron:x" },
      { ...tinker, trigger: "cron" },
      { ...tinker, trigger: "heartbeat" },
      { ...tinker, sessionKey: "agent:main:whatsapp:1" },
    ]) {
      expect(
        await hook({ prompt: TRIP, messages: [] }, { ...ctx, runId: `r-${Math.random()}` }),
      ).toEqual({});
    }
  });

  it("gives a marked notice, or a prompt with inter-session provenance, no match, no plan and no advice", async () => {
    const off = registerTaskRanker(async () =>
      ranked([entry("recipe:trip-planner-recipe", "USE", "jev", 0.9)], [], "jev"),
    );
    try {
      for (const [prompt, over] of [
        ["[System] the gateway restarted; " + TRIP, {}],
        ["System (untrusted): exec completed. " + TRIP, {}],
        ["<task-notification><task-id>x</task-id></task-notification> " + TRIP, {}],
        ["⟦AGENT:📈 Thalamus⟧ " + TRIP, {}],
        [TRIP, { inputProvenanceKind: "inter_session" }],
      ] as Array<[string, Record<string, unknown>]>) {
        events.length = 0;
        const out = await hook(
          { prompt, messages: [] },
          { ...tinker, runId: `r-${Math.random()}`, ...over },
        );
        expect(out?.prependSystemContext ?? "").not.toContain("<active_recipe");
        expect(out?.prependSystemContext ?? "").not.toContain("<recipe_advice");
        expect(trail("advice")).toHaveLength(0);
        expect(trail("matched")).toHaveLength(0);
      }
    } finally {
      off();
    }
  });

  it("seeds a plan from a USE Jev chose with a high share, and writes the advice line, as a tag and as a trail event", async () => {
    const off = registerTaskRanker(async () =>
      ranked(
        [
          entry("recipe:trip-planner-recipe", "USE", "jev", 0.92),
          entry("skill:flight-scan", "USE", "jev", 0.04),
        ],
        [entry("recipe:review-site", "INSPIRE", "jev", 0.6, "Build the page")],
        "jev",
      ),
    );
    try {
      events.length = 0;
      const out = await hook({ prompt: TRIP, messages: [] }, { ...tinker, runId: "r-jev" });
      const ctx = out!.prependSystemContext!;
      expect(ctx).toContain("<active_recipe");
      const tag = /<recipe_advice source="Jev">([^<]*)<\/recipe_advice>/.exec(ctx);
      expect(tag?.[1]).toBe(
        "Use: trip-planner-recipe, flight-scan · Inspiration: review-site (§ Build the page) · source: Jev",
      );
      const ev = trail("advice");
      expect(ev).toHaveLength(1);
      expect(ev[0].data).toMatchObject({
        message: tag![1],
        payload: { adviceLine: tag![1], adviceSource: "Jev" },
      });
    } finally {
      off();
    }
  });

  it("seeds nothing when the recipe the matcher found is only an INSPIRE, but still names it in the advice", async () => {
    const off = registerTaskRanker(async () =>
      ranked([], [entry("recipe:trip-planner-recipe", "INSPIRE", "jev", 0.95, "Flights")], "jev"),
    );
    try {
      events.length = 0;
      const out = await hook({ prompt: TRIP, messages: [] }, { ...tinker, runId: "r-inspire" });
      const ctx = out?.prependSystemContext ?? "";
      expect(ctx).not.toContain("<active_recipe");
      expect(ctx).not.toContain("<recipe_gap");
      expect(ctx).toContain("Inspiration: trip-planner-recipe (§ Flights) · source: Jev");
      expect(trail("matched")).toHaveLength(0);
    } finally {
      off();
    }
  });

  it("does not seed from a USE Jev gave a low share", async () => {
    const off = registerTaskRanker(async () =>
      ranked([entry("recipe:trip-planner-recipe", "USE", "jev", 0.3)], [], "jev"),
    );
    try {
      const out = await hook({ prompt: TRIP, messages: [] }, { ...tinker, runId: "r-low" });
      expect(out?.prependSystemContext ?? "").not.toContain("<active_recipe");
      expect(out?.prependSystemContext).toContain("Use: trip-planner-recipe · source: Jev");
    } finally {
      off();
    }
  });

  it("with a local list, seeds only a recipe the lexical matcher scored high and the ranking lists as USE; says local", async () => {
    const off = registerTaskRanker(async () =>
      ranked([entry("recipe:trip-planner-recipe", "USE", "local", 0)], [], "local"),
    );
    try {
      const out = await hook({ prompt: TRIP, messages: [] }, { ...tinker, runId: "r-local" });
      expect(out?.prependSystemContext).toContain("<active_recipe");
      expect(out?.prependSystemContext).toContain("Use: trip-planner-recipe · source: local");
    } finally {
      off();
    }
  });

  it("an unranked follow-up (no context) seeds nothing and offers no authoring", async () => {
    const off = registerTaskRanker(
      async () => ({ ranked: false, runId: "r", why: "follow-up-no-context" }) as TaskRanking,
    );
    try {
      const out = await hook(
        { prompt: "plan a family trip", messages: [] },
        { ...tinker, runId: "r-follow" },
      );
      expect(out?.prependSystemContext ?? "").not.toContain("<active_recipe");
      expect(out?.prependSystemContext ?? "").not.toContain("<recipe_gap");
      expect(out?.prependSystemContext ?? "").not.toContain("<recipe_advice");
    } finally {
      off();
    }
  });

  it("a quiet ranking (only recall's order was left) changes nothing: the lexical match seeds as before, no advice", async () => {
    const off = registerTaskRanker(
      async () => ({ ranked: false, runId: "r", why: "local-quiet" }) as TaskRanking,
    );
    try {
      events.length = 0;
      const out = await hook({ prompt: TRIP, messages: [] }, { ...tinker, runId: "r-quiet" });
      expect(out?.prependSystemContext).toContain("<active_recipe");
      expect(out?.prependSystemContext).not.toContain("<recipe_advice");
      expect(trail("advice")).toHaveLength(0);
    } finally {
      off();
    }
  });

  it("scores what the person wrote, not the reflection instructions the harness appends to every turn", async () => {
    // 2026-10-06: every Tinker turn ends with ~30,000 characters of reflection doctrine. The lexical matcher scored all of it,
    // so the same three recipes matched at "high" on unrelated prompts and one seeded a plan on a chat that never asked for it.
    const tail = `\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line. ${TRIP}. ${TRIP}. ${TRIP}.`;
    events.length = 0;
    const out = await hook(
      { prompt: `What is the time in Madrid now?${tail}`, messages: [] },
      { ...tinker, runId: "r-tail" },
    );
    // the question may legitimately match a shipped recipe on its own words; what it must not do is match the recipe named only in the tail
    expect(out?.prependSystemContext ?? "").not.toContain("trip-planner-recipe");
    // and the same request WITHOUT the tail still matches its own words
    const own = await hook(
      { prompt: `${TRIP}${tail}`, messages: [] },
      { ...tinker, runId: "r-tail-own" },
    );
    expect(own?.prependSystemContext).toContain("<active_recipe");
  });

  it("asks the ranker once per run: two hooks, one call", async () => {
    const ranker = vi.fn(async () =>
      ranked([entry("recipe:trip-planner-recipe", "USE", "jev", 0.9)], [], "jev"),
    );
    const off = registerTaskRanker(ranker);
    try {
      await hook({ prompt: TRIP, messages: [] }, { ...tinker, runId: "r-once" });
      await hook({ prompt: TRIP, messages: [] }, { ...tinker, runId: "r-once" });
      expect(ranker).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});
