import type { ThalamusBoardLike, Unit } from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it, vi } from "vitest";
import { cachePolicyFor, ratesFor } from "../../../src/shared/thalamus-price-table.js";
import { NOW, R, supplies } from "../../../src/shared/thalamus-v4.test-support.js";
import { DEFAULT_PROVIDER_CAPS, parseConfig } from "../src/config.js";
import {
  createScheduler,
  providerOf,
  type PlanDecision,
  type PlanRequest,
  type SchedulerDeps,
  type Spawner,
  type UnitHandle,
} from "../src/scheduler.js";
import { ThalamusStore } from "../src/store.js";

// Phase E: the scheduler. The plan, the critical path and the decisions are asserted on the synthetic contract task of
// paper section 9 (a shared start, twelve readers on two providers, one hedge, a combine, a check by another family).

const board = (over: Partial<ThalamusBoardLike> = {}): ThalamusBoardLike => ({
  rungs: [R.opus, R.sonnet, R.haiku, R.grok],
  supplies: supplies(),
  contextWindowFor: () => 1_000_000,
  dialIdx: 1,
  builtAtMs: NOW,
  ...over,
});

const unit = (id: string, o: Partial<Unit> = {}): Unit => ({
  id,
  task: id,
  kind: "work",
  inputs: [],
  outputs: [],
  writes: [],
  estIn: 1000,
  estOut: 200,
  model: "auto",
  urgency: "waiting",
  private: false,
  ...o,
});

function make(
  raw: Record<string, unknown> = {},
  over: Partial<SchedulerDeps> = {},
  b: ThalamusBoardLike = board(),
) {
  const cfg = parseConfig({
    mode: "shadow",
    scheduler: { providerCaps: { "claude-code": 6, xai: 6 } },
    ...raw,
  });
  const store = new ThalamusStore(":memory:");
  const events: Array<[string, unknown]> = [];
  const sched = createScheduler({
    cfg: () => cfg,
    board: () => b,
    ledger: () => new Map(),
    now: () => NOW,
    store: () => store,
    broadcast: (n, p) => void events.push([n, p]),
    defer: (fn) => fn(),
    ...over,
  });
  return { sched, store, events, cfg };
}

const contract = (over: Partial<PlanRequest["task"]> = {}): PlanRequest => {
  const readers = Array.from({ length: 12 }, (_, i) =>
    unit(`r${i + 1}`, {
      kind: "read",
      inputs: ["start"],
      outputs: [`l${i + 1}`],
      estIn: 59_000,
      estOut: 800,
      sharedStart: { id: "defs", tokens: 9000 },
    }),
  );
  return {
    id: "contract",
    task: { kind: "general", urgency: "waiting", shape: "parts", ...over },
    units: [
      unit("plan", { outputs: ["start"], estIn: 12_000, estOut: 600 }),
      ...readers,
      unit("combine", {
        kind: "combine",
        inputs: readers.flatMap((r) => r.outputs),
        outputs: ["combined"],
        estIn: 13_000,
        estOut: 2000,
      }),
      unit("check", {
        kind: "check",
        inputs: ["combined"],
        outputs: ["checked"],
        estIn: 6000,
        estOut: 500,
      }),
      unit("answer", { kind: "write", inputs: ["checked"], estIn: 4000, estOut: 1500 }),
    ],
  };
};

const of = (d: PlanDecision, id: string, copy: 0 | 1 = 0) =>
  d.placements.find((p) => p.unitId === id && p.copy === copy)!;

/** The most calls any one provider held at once, by the timeline (an interval ends when the next begins). */
function peakPerProvider(d: PlanDecision): Record<string, number> {
  const peaks: Record<string, number> = {};
  for (const p of d.placements) {
    const at = d.placements.filter(
      (q) =>
        providerOf(q.routeKey) === providerOf(p.routeKey) &&
        q.startSec <= p.startSec &&
        q.endSec > p.startSec,
    ).length;
    peaks[providerOf(p.routeKey)] = Math.max(peaks[providerOf(p.routeKey)] ?? 0, at);
  }
  return peaks;
}

describe("the synthetic contract task (paper section 9), routed as a graph", () => {
  const SLOW = { r7: 200 };

  it("is a graph: the plan first, twelve readers after it, then combine, check, answer", () => {
    const { sched } = make();
    const d = sched.simulate(contract(), { actualSec: SLOW })!;
    expect(d.graph.units).toHaveLength(16);
    expect(d.graph.edges).toHaveLength(12 + 12 + 1 + 1);
    expect(d.graph.order[0]).toBe("plan");
    expect(d.graph.order.slice(-3)).toEqual(["combine", "check", "answer"]);
    expect(d.unplaced).toEqual([]);
    for (let i = 1; i <= 12; i++)
      expect(of(d, `r${i}`).startSec).toBeGreaterThanOrEqual(of(d, "plan").endSec);
    const lastReader = Math.max(...Array.from({ length: 12 }, (_, i) => of(d, `r${i + 1}`).endSec));
    expect(of(d, "combine").startSec).toBeGreaterThanOrEqual(lastReader - 1e-9);
    expect(of(d, "check").startSec).toBeGreaterThanOrEqual(of(d, "combine").endSec);
    expect(of(d, "answer").startSec).toBeGreaterThanOrEqual(of(d, "check").endSec);
  });

  it("puts the readers on one shared start, because the cache makes it cheaper", () => {
    const { sched } = make();
    const d = sched.simulate(contract(), { actualSec: SLOW })!;
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]).toMatchObject({ startId: "defs", n: 12, mode: "shared-start" });
    expect(d.groups[0].sharedCost!).toBeLessThan(d.groups[0].ownCost!);
  });

  it("runs the readers at once on two providers, each within its cap, and never queues behind itself", () => {
    const { sched } = make();
    const d = sched.simulate(contract(), { actualSec: SLOW })!;
    const readers = d.placements.filter((p) => /^r\d+$/.test(p.unitId) && p.copy === 0);
    const providers = new Set(readers.map((p) => providerOf(p.routeKey)));
    expect(providers).toEqual(new Set(["claude-code", "xai"]));
    for (const peak of Object.values(peakPerProvider(d))) expect(peak).toBeLessThanOrEqual(6);
    // With six lanes on each provider the twelve readers start together: none waits for another reader.
    expect(new Set(readers.map((p) => p.startSec)).size).toBe(1);
    expect(readers.some((p) => p.spilledFrom !== undefined)).toBe(true);
  });

  it("keeps the readers of a shared start on one model per provider", () => {
    const { sched } = make();
    const d = sched.simulate(contract(), { actualSec: SLOW })!;
    const byProvider = new Map<string, Set<string>>();
    for (const p of d.placements.filter((x) => /^r\d+$/.test(x.unitId) && x.copy === 0)) {
      const set = byProvider.get(providerOf(p.routeKey)) ?? new Set<string>();
      set.add(`${p.routeKey}@${p.effort}`);
      byProvider.set(providerOf(p.routeKey), set);
    }
    for (const models of byProvider.values()) expect(models.size).toBe(1);
  });

  it("hedges the one slow reader on the other provider, once; shadow records it as not sent", () => {
    const { sched } = make();
    const d = sched.simulate(contract(), { actualSec: SLOW })!;
    expect(d.hedges).toHaveLength(1);
    const h = d.hedges[0];
    expect(h.unitId).toBe("r7");
    expect(providerOf(h.to)).not.toBe(providerOf(h.from));
    expect(h.sent).toBe(false);
    expect(h.won).toBe("copy");
    const copy = of(d, "r7", 1);
    expect(copy.startSec).toBeGreaterThan(of(d, "r7").startSec + of(d, "r7").timeSec * 1.5 - 1e-6);
    const without = sched.simulate(contract(), { actualSec: SLOW, hedge: false })!;
    expect(without.hedges).toEqual([]);
    expect(d.lengthSec).toBeLessThan(without.lengthSec);
  });

  it("finds the critical path through the slow reader to the answer", () => {
    const { sched } = make();
    const d = sched.simulate(contract(), { actualSec: SLOW, hedge: false })!;
    expect(d.criticalPath[0]).toBe("plan");
    expect(d.criticalPath).toContain("r7");
    expect(d.criticalPath.slice(-3)).toEqual(["combine", "check", "answer"]);
    // On the real timeline the readers' slack follows from the slow one.
    expect(d.graph.slackSec.r7).toBe(0);
    expect(d.graph.slackSec.r1).toBeGreaterThan(0);
  });

  it("has the check made by another family than the unit it checks, and says so", () => {
    const { sched } = make();
    const d = sched.simulate(contract(), { actualSec: SLOW })!;
    const check = of(d, "check");
    expect(check.checker).toBe("picked");
    expect(check.family).not.toBe(of(d, "combine").family);
  });

  it("records a check with no other family as unchecked, not as checked", () => {
    const { sched } = make({}, {}, board({ rungs: [R.opus, R.sonnet, R.haiku] }));
    const d = sched.simulate(contract(), { actualSec: SLOW })!;
    expect(of(d, "check").checker).toBe("no-other-family");
  });

  it("prices the readers of a shared start at what the cache makes them cost, so the plan's cost is the sum of those prices", () => {
    const { sched } = make();
    const d = sched.simulate(contract(), { hedge: false })!;
    const readers = d.placements.filter((p) => /^r\d+$/.test(p.unitId) && p.copy === 0);
    const EUR_PER_USD = 0.92;
    const usd = (
      key: string,
      total: number,
      shared: number,
      out: number,
      warm: boolean,
    ): number => {
      const rates = ratesFor(key, total)!;
      const policy = cachePolicyFor(key)!;
      const read = rates.cacheReadPerMTok ?? rates.inputPerMTok;
      const start = warm ? shared * read : shared * rates.inputPerMTok * policy.write1hMult;
      return (start + (total - shared) * rates.inputPerMTok + out * rates.outputPerMTok) / 1e6;
    };
    const seen = new Set<string>();
    let expected = 0;
    for (const p of readers) {
      const warm = seen.has(p.routeKey);
      seen.add(p.routeKey);
      expect(p.sharedStart).toBe(warm ? "read" : "write");
      const want = usd(p.routeKey, 59_000, 9_000, 800, warm) * EUR_PER_USD;
      expect(p.money).toBeCloseTo(want, 12);
      expected += want;
    }
    // One write per model the readers ran on, eleven or fewer reads.
    expect(readers.filter((p) => p.sharedStart === "write")).toHaveLength(seen.size);
    const others = d.placements.filter((p) => !/^r\d+$/.test(p.unitId) && p.copy === 0);
    expected += others.reduce((n, p) => n + p.money, 0);
    expect(d.costEur).toBeCloseTo(expected, 10);
    expect(others.every((p) => p.sharedStart === undefined)).toBe(true);
  });

  it("is the same every time it is asked", () => {
    const { sched } = make();
    const a = sched.simulate(contract(), { actualSec: SLOW })!;
    const b = sched.simulate(contract(), { actualSec: SLOW })!;
    expect(b).toEqual(a);
  });
});

describe("the graph rules in a plan", () => {
  it("never runs two units that change the same thing at once, and lets the rest overlap", () => {
    const { sched } = make();
    const d = sched.simulate({
      id: "w",
      task: { kind: "general", urgency: "waiting", shape: "parts" },
      units: [
        unit("x", { writes: ["src/a.ts"] }),
        unit("y", { writes: ["src/a.ts"] }),
        unit("z", { writes: ["src/b.ts"] }),
      ],
    })!;
    const [x, y, z] = ["x", "y", "z"].map((id) => of(d, id));
    expect(y.startSec).toBeGreaterThanOrEqual(x.endSec - 1e-9);
    expect(z.startSec).toBe(0);
    expect(x.startSec).toBe(0);
  });

  it("gives a unit off the critical path slack, and keeps hedges off it", () => {
    const { sched } = make();
    const d = sched.simulate({
      id: "s",
      task: { kind: "general", urgency: "waiting", shape: "parts" },
      units: [
        unit("long", { outputs: ["L"], estIn: 100_000, estOut: 6000 }),
        unit("short", { outputs: ["S"], estIn: 500, estOut: 50 }),
        unit("join", { inputs: ["L", "S"] }),
      ],
    })!;
    expect(of(d, "short").slackSec).toBeGreaterThan(0);
    expect(of(d, "short").onCritical).toBe(false);
    expect(of(d, "long").onCritical).toBe(true);
    const slow = sched.simulate(
      {
        id: "s2",
        task: { kind: "general", urgency: "waiting", shape: "parts" },
        units: [
          unit("long", { outputs: ["L"], estIn: 100_000, estOut: 6000 }),
          unit("short", { outputs: ["S"], estIn: 500, estOut: 50 }),
          unit("join", { inputs: ["L", "S"] }),
        ],
      },
      { actualSec: { short: 100 } },
    )!;
    expect(slow.hedges.some((h) => h.unitId === "short")).toBe(false);
  });

  it("holds every provider to its cap on a wide fan-out, and places every unit", () => {
    const { sched } = make({ scheduler: { providerCaps: { "claude-code": 2, xai: 2 } } });
    const units = Array.from({ length: 10 }, (_, i) => unit(`u${i}`));
    const d = sched.simulate({
      id: "wide",
      task: { kind: "general", urgency: "waiting", shape: "parts" },
      units,
    })!;
    expect(d.unplaced).toEqual([]);
    expect(d.placements.filter((p) => p.copy === 0)).toHaveLength(10);
    for (const peak of Object.values(peakPerProvider(d))) expect(peak).toBeLessThanOrEqual(2);
  });

  it("keeps a chain or a single answer as one unit, however the planner cut it", () => {
    const { sched } = make();
    for (const shape of ["chain", "answer"] as const) {
      const d = sched.simulate({
        ...contract(),
        task: { kind: "general", urgency: "waiting", shape },
      })!;
      expect(d.collapsed).toBe(true);
      expect(d.graph.units.map((u) => u.id)).toEqual(["whole"]);
      expect(d.placements).toHaveLength(1);
    }
  });

  it("reports a unit no model can take, and the units waiting on it, instead of leaving them out", () => {
    const { sched } = make({}, {}, board({ contextWindowFor: () => 1000 }));
    const d = sched.simulate({
      id: "big",
      task: { kind: "general", urgency: "waiting", shape: "parts" },
      units: [unit("huge", { outputs: ["H"], estIn: 50_000 }), unit("after", { inputs: ["H"] })],
    })!;
    expect(d.unplaced).toEqual([
      { unitId: "huge", why: "no-option" },
      { unitId: "after", why: "blocked" },
    ]);
  });

  it("sends private work only to approved providers", () => {
    const { sched } = make();
    const d = sched.simulate({
      id: "p",
      task: { kind: "general", urgency: "waiting", shape: "parts", private: true },
      units: Array.from({ length: 4 }, (_, i) => unit(`p${i}`)),
    })!;
    expect(d.unplaced).toEqual([]);
    for (const p of d.placements) expect(providerOf(p.routeKey)).toBe("claude-code");
  });
});

describe("hedging rules", () => {
  const equal = (n: number) =>
    Array.from({ length: n }, (_, i) => unit(`e${i}`, { outputs: [`o${i}`] }));

  it("hedges at most a fifth of a plan's units, all of them critical and slow", () => {
    const { sched } = make({ scheduler: { providerCaps: { "claude-code": 20, xai: 20 } } });
    const units = equal(10);
    const actual = Object.fromEntries(units.map((u) => [u.id, 500]));
    const d = sched.simulate(
      { id: "cap", task: { kind: "general", urgency: "waiting", shape: "parts" }, units },
      { actualSec: actual },
    )!;
    expect(d.hedges.length).toBe(2); // floor(10 x 0.2)
    expect(new Set(d.hedges.map((h) => h.unitId)).size).toBe(2);
  });

  it("waits for the margin: no copy for a unit that runs only a little long", () => {
    const { sched } = make();
    const units = equal(6);
    const est = sched.simulate({
      id: "m",
      task: { kind: "general", urgency: "waiting", shape: "parts" },
      units,
    })!;
    const t = of(est, "e0").timeSec;
    const d = sched.simulate(
      { id: "m", task: { kind: "general", urgency: "waiting", shape: "parts" }, units },
      { actualSec: { e0: t * 1.4 } },
    )!;
    expect(d.hedges).toEqual([]);
  });

  it("does not hedge when the copy would land on the same provider (only one provider has a model)", () => {
    const { sched } = make({}, {}, board({ rungs: [R.opus, R.sonnet, R.haiku] }));
    const d = sched.simulate(
      { id: "one", task: { kind: "general", urgency: "waiting", shape: "parts" }, units: equal(6) },
      { actualSec: { e0: 500, e1: 500 } },
    )!;
    expect(d.hedges).toEqual([]);
  });
});

describe("shadow spends nothing and changes nothing", () => {
  it("writes the plan down, sends no hedge, and calls nothing", () => {
    const spawner = vi.fn();
    const { sched, store, events } = make();
    const d = sched.shadow(contract())!;
    expect(d.mode).toBe("shadow");
    expect(spawner).not.toHaveBeenCalled();
    expect(d.hedges.every((h) => !h.sent)).toBe(true);
    const rows = store.listPlanUnits("contract");
    expect(rows.length).toBe(d.placements.length);
    expect(rows.every((r) => r.mode === "shadow")).toBe(true);
    expect(rows.find((r) => r.unitId === "plan")).toMatchObject({
      copy: 0,
      onCritical: true,
      status: "placed",
    });
    const plan = events.find(([n]) => n === "thalamus.plan");
    expect(plan?.[1]).toMatchObject({ planId: "contract", mode: "shadow", units: 16 });
    expect(store.counts().planUnits).toBe(rows.length);
  });

  it("does nothing at all when the mode is off, and refuses to execute outside enforce", async () => {
    const off = make({ mode: "off" });
    expect(off.sched.shadow(contract())).toBeUndefined();
    const spawner = vi.fn();
    const shadow = make();
    expect(await shadow.sched.execute(contract(), spawner as unknown as Spawner)).toBeUndefined();
    expect(spawner).not.toHaveBeenCalled();
  });

  it("does nothing without a board", () => {
    const { sched } = make({}, { board: () => undefined });
    expect(sched.simulate(contract())).toBeUndefined();
  });
});

// A virtual clock for execute: `sleep` advances time and finishes the units whose time has come.
function harness(durations: (job: { unitId: string; copy: 0 | 1 }) => number | "fail") {
  let now = NOW;
  const live: Array<{
    at: number;
    fail: boolean;
    job: string;
    resolve: () => void;
    reject: () => void;
    cancelled: boolean;
  }> = [];
  const started: string[] = [];
  const cancelled: string[] = [];
  const spawn: Spawner = (job) => {
    const key = `${job.unit.id}:${job.copy}`;
    started.push(key);
    const d = durations({ unitId: job.unit.id, copy: job.copy });
    let resolve!: () => void;
    let reject!: () => void;
    const done = new Promise<void>((ok, bad) => {
      resolve = ok;
      reject = () => bad(new Error("boom"));
    });
    const entry = {
      at: now + (d === "fail" ? 1000 : d * 1000),
      fail: d === "fail",
      job: key,
      resolve,
      reject,
      cancelled: false,
    };
    live.push(entry);
    const handle: UnitHandle = {
      done,
      cancel: () => {
        entry.cancelled = true;
        cancelled.push(key);
      },
    };
    return handle;
  };
  const sleep = async (ms: number): Promise<void> => {
    now += ms;
    for (const e of live.splice(0).filter((x) => {
      if (x.cancelled) return false;
      if (x.at > now) {
        live.push(x);
        return false;
      }
      return true;
    })) {
      if (e.fail) e.reject();
      else e.resolve();
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return { spawn, sleep, clockMs: () => now, started, cancelled };
}

describe("execute (enforce only), through a fake spawner", () => {
  const chainOfThree: PlanRequest = {
    id: "exec",
    task: { kind: "general", urgency: "waiting", shape: "parts" },
    units: [
      unit("a", { outputs: ["A"] }),
      unit("b", { inputs: ["A"], outputs: ["B"] }),
      unit("c", { inputs: ["B"] }),
    ],
  };

  it("runs the units in order, each on the model the scheduler chose, and records the plan", async () => {
    const h = harness(() => 5);
    const { sched, store } = make({ mode: "enforce" });
    const d = await sched.execute(chainOfThree, h.spawn, {
      sleep: h.sleep,
      clockMs: h.clockMs,
      tickMs: 1000,
    });
    expect(h.started).toEqual(["a:0", "b:0", "c:0"]);
    expect(d?.unplaced).toEqual([]);
    expect(d?.mode).toBe("enforce");
    expect(store.listPlanUnits("exec")).toHaveLength(3);
    expect(of(d!, "b").startSec).toBeGreaterThanOrEqual(of(d!, "a").endSec - 1e-9);
  });

  const slowCritical: PlanRequest = {
    id: "hedgy",
    task: { kind: "general", urgency: "waiting", shape: "parts" },
    units: Array.from({ length: 5 }, (_, i) => unit(`e${i}`, { outputs: [`o${i}`] })),
  };

  it("starts a hedge copy on another provider only with enforce.hedge on; the first to finish wins, the other is cancelled", async () => {
    const h = harness((j) => (j.unitId === "e0" && j.copy === 0 ? 400 : j.copy === 1 ? 5 : 10));
    const on = make({ mode: "enforce", enforce: { hedge: true } });
    const d = await on.sched.execute(slowCritical, h.spawn, {
      sleep: h.sleep,
      clockMs: h.clockMs,
      tickMs: 1000,
    });
    expect(h.started).toContain("e0:1");
    expect(d?.hedges).toHaveLength(1);
    expect(d?.hedges[0]).toMatchObject({ unitId: "e0", sent: true, won: "copy" });
    expect(h.cancelled).toContain("e0:0");
    expect(providerOf(d!.hedges[0].to)).not.toBe(providerOf(d!.hedges[0].from));

    const h2 = harness((j) => (j.unitId === "e0" ? 40 : 10));
    const off = make({ mode: "enforce" });
    const d2 = await off.sched.execute(slowCritical, h2.spawn, {
      sleep: h2.sleep,
      clockMs: h2.clockMs,
      tickMs: 1000,
    });
    expect(h2.started.some((k) => k.endsWith(":1"))).toBe(false);
    expect(d2?.hedges).toEqual([]);
  });

  it("stops everything when a unit fails, cancels what still runs, and reports the rest as aborted", async () => {
    const h = harness((j) => (j.unitId === "b" ? "fail" : 5));
    const { sched } = make({ mode: "enforce" });
    const d = await sched.execute(chainOfThree, h.spawn, {
      sleep: h.sleep,
      clockMs: h.clockMs,
      tickMs: 1000,
    });
    expect(h.started).toEqual(["a:0", "b:0"]);
    expect(d?.unplaced).toEqual([
      { unitId: "b", why: "failed" },
      { unitId: "c", why: "aborted" },
    ]);
  });

  it("cancels whatever is still running when the plan ends", async () => {
    const h = harness(() => 5);
    const { sched } = make({ mode: "enforce" });
    await sched.execute(chainOfThree, h.spawn, {
      sleep: h.sleep,
      clockMs: h.clockMs,
      tickMs: 1000,
    });
    expect(h.cancelled).toEqual([]);
  });
});

describe("the scheduler's config", () => {
  it("defaults to the design's caps and margin, every enforce switch off", () => {
    const c = parseConfig({});
    expect(c.scheduler.providerCaps).toEqual(DEFAULT_PROVIDER_CAPS);
    expect(c.hedge.margin).toBe(1.5);
    expect(c.enforce.hedge).toBe(false);
    expect(c.enforce.orchestrateAuto).toBe(false);
  });

  it("takes a cap from config, ignores one that is not a number of at least one, and never lets the margin fall below one", () => {
    const c = parseConfig({
      scheduler: { providerCaps: { xai: 9, copilot: 0, "claude-code": "x", mistral: 3 } },
      hedge: { margin: 0.2 },
    });
    expect(c.scheduler.providerCaps).toMatchObject({
      xai: 9,
      copilot: 2,
      "claude-code": 4,
      mistral: 3,
    });
    expect(c.hedge.margin).toBe(1);
  });
});

describe("what the ledger taught the scheduler (phase F)", () => {
  const six = (urgency: "waiting" | "whenever" = "waiting") =>
    Array.from({ length: 6 }, (_, i) => unit(`e${i}`, { outputs: [`o${i}`], urgency }));
  const req = (units: Unit[]): PlanRequest => ({
    id: "f",
    task: { kind: "general", urgency: "waiting", shape: "parts" },
    units,
  });

  it("a hedge waits past the measured slow end of the rung, not past the typical time", () => {
    const plain = make();
    const base = plain.sched.simulate(req(six()), { actualSec: { e0: 900 } })!;
    const h0 = base.hedges[0];
    expect(h0.unitId).toBe("e0");
    const SLOW = {
      ttftColdSec: 40,
      ttftWarmSec: 40,
      tokensPerSec: 4,
      thinkSec: { mechanical: 0, routine: 3, deep: 20 },
    };
    const measured = make({}, { slowTimeFor: () => SLOW });
    const d = measured.sched.simulate(req(six()), { actualSec: { e0: 900 } })!;
    const e0 = of(d, "e0");
    // Usual time = first token + thinking + output at the slow speed (200 tokens at 4/s = 50 s).
    expect(e0.usualSec).toBeCloseTo(40 + 3 + 200 / 4, 9);
    expect(e0.usualSec).toBeGreaterThan(e0.timeSec);
    expect(d.hedges[0].atSec).toBeGreaterThan(h0.atSec);
    expect(d.hedges[0].atSec).toBeCloseTo(e0.startSec + e0.usualSec * 1.5, 1);
  });

  it("the usual time is the unit's own estimate when nothing was measured, as before", () => {
    const { sched } = make();
    const d = sched.simulate(req(six()))!;
    for (const p of d.placements) expect(p.usualSec).toBe(p.timeSec);
  });

  const explorer = (rand: number, raw: Record<string, unknown> = {}) =>
    make({ mode: "enforce", learning: { explore: true }, ...raw }, { rand: () => rand });

  it("an overnight unit, in enforce, now and then takes an option the router would not: one in the first calls, marked", () => {
    const d = explorer(0.001).sched.simulate(req(six("whenever")), { mode: "enforce" })!;
    const explored = d.placements.filter((p) => p.explored);
    expect(explored).toHaveLength(1);
    const others = d.placements.filter((p) => !p.explored && p.copy === 0);
    expect(others.length).toBe(5);
    const pick = explorer(0.9).sched.simulate(req(six("whenever")), { mode: "enforce" })!;
    const normal = pick.placements[0];
    expect(`${explored[0].routeKey}@${explored[0].effort}`).not.toBe(
      `${normal.routeKey}@${normal.effort}`,
    );
  });

  it("never on a large draw, never for a unit someone is waiting for, never in shadow or preview, never with the switch off", () => {
    expect(
      explorer(0.9)
        .sched.simulate(req(six("whenever")), { mode: "enforce" })!
        .placements.some((p) => p.explored),
    ).toBe(false);
    expect(
      explorer(0.001)
        .sched.simulate(req(six("waiting")), { mode: "enforce" })!
        .placements.some((p) => p.explored),
    ).toBe(false);
    expect(
      explorer(0.001)
        .sched.simulate(req(six("whenever")))!
        .placements.some((p) => p.explored),
    ).toBe(false);
    expect(
      explorer(0.001)
        .sched.simulate(req(six("whenever")), { mode: "shadow" })!
        .placements.some((p) => p.explored),
    ).toBe(false);
    const off = make({ mode: "enforce" }, { rand: () => 0.001 });
    expect(
      off.sched
        .simulate(req(six("whenever")), { mode: "enforce" })!
        .placements.some((p) => p.explored),
    ).toBe(false);
  });

  it("learned strengths and refusals reach the scheduler's pricing, and change nothing when absent", () => {
    const { sched } = make();
    const d0 = sched.simulate(req(six()))!;
    const refuseAll = make({}, { learned: () => ({ refusals: [] }) });
    expect(refuseAll.sched.simulate(req(six()))!.placements.map((p) => p.routeKey)).toEqual(
      d0.placements.map((p) => p.routeKey),
    );
  });
});
