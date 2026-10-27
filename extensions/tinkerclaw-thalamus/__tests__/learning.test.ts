import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  domainStrengthFor,
  getCallRouter,
  type ThalamusBoardLike,
} from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it } from "vitest";
import type { CallRouteCall } from "../../../src/infra/thalamus-call-router.js";
import { HAIKU, NOW, OPUS, R, supplies } from "../../../src/shared/thalamus-v4.test-support.js";
import type { AgentEventLike } from "../src/cache-feed.js";
import { parseConfig } from "../src/config.js";
import { createRuntime, type RuntimeDeps } from "../src/runtime.js";
import { ThalamusStore } from "../src/store.js";

// Phase F: the nightly run through the runtime, end to end: outcomes in the ledger, estimates out, and the router using them.

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const board = (): ThalamusBoardLike => ({
  rungs: [R.opus, R.haiku],
  supplies: supplies(),
  contextWindowFor: () => 1_000_000,
  dialIdx: 1,
  builtAtMs: NOW,
});

function make(raw: Record<string, unknown> = {}, over: Partial<RuntimeDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "thalamus-learn-"));
  dirs.push(root);
  const store = new ThalamusStore(":memory:");
  const listeners: Array<(e: AgentEventLike) => void> = [];
  const rt = createRuntime({
    config: parseConfig({ dataDir: join(root, "data"), ...raw }),
    extensionRoot,
    gatewayPort: 18789,
    gatewayCfg: () => ({}),
    onAgentEvent: (l) => {
      listeners.push(l);
      return () => void listeners.splice(listeners.indexOf(l), 1);
    },
    broadcast: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => NOW,
    readBoard: () => board(),
    handPicked: () => false,
    listing: () => [],
    attribute: () => [],
    readText: () => "",
    defer: (fn) => fn(),
    store,
    ...over,
  });
  stops.push(() => rt.stop());
  return { rt, store, root };
}

const CODE = "Fix the failing unit test in this TypeScript function and refactor the code";
// The "router uses what was learned" block needs a domain where BOTH Haiku and Opus 5 have an
// Epoch run. CODE stopped being one on 2026-10-02, when Terminal Bench (Haiku's only code
// table) moved to SHELL; REASON has runs for both.
const REASON = "A lateral thinking riddle: reason through this logic puzzle and its paradox";
const call = (i: number, text = CODE): CallRouteCall => ({
  model: { id: "m" },
  context: { systemPrompt: "x", messages: [{ role: "user", content: text }] },
  meta: {
    runId: `run-${i}`,
    sessionKey: `agent:main:tinker:${i}`,
    agentId: "main",
    trigger: "user",
    provider: "claude-code",
    model: "claude-opus-5",
    thinkLevel: "high",
  },
  callIndex: 0,
});

/** Route `n` calls in shadow so decisions exist, then give each one a recorded outcome from `model`. */
function ledger(
  t: ReturnType<typeof make>,
  n: number,
  o: {
    model?: string;
    win?: (i: number) => boolean;
    refused?: (i: number) => boolean;
    text?: string;
  } = {},
) {
  for (let i = 0; i < n; i++) getCallRouter()!.observe(call(i, o.text));
  // A decision's id is `<run>:<call index>`. (`listDecisions` clamps at 200, which would quietly record fewer outcomes.)
  const ds = Array.from({ length: n }, (_, i) => ({ id: `run-${i}:0` }));
  expect(t.store.getDecision(ds[n - 1].id)).toBeDefined();
  ds.forEach((d, i) => {
    const refused = o.refused?.(i) ?? false;
    t.store.insertOutcome({
      decisionId: d.id,
      ts: NOW + i,
      actualModel: o.model ?? HAIKU,
      input: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 200,
      durationMs: 4000 + (i % 7) * 500,
      ttftMs: 800,
      outcome: refused ? "refused" : (o.win?.(i) ?? true) ? "done" : "retry",
      refused,
      moneyBasis: "list",
    });
  });
  return ds;
}

describe("the decision records what the read said", () => {
  it("stores the kind of work, the topic and the kind of step, so learning can group by them", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    const [d] = ledger(t, 1);
    expect(d).toBeDefined();
    const facts = t.store.outcomeFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      domain: "code",
      topic: "none",
      stepKind: "tool",
      rungKey: HAIKU,
      outcome: "done",
      refused: false,
    });
  });

  it("leaves out an outcome whose decision was written before those columns existed", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    ledger(t, 2);
    expect(t.store.outcomeFacts()).toHaveLength(2);
  });
});

describe("the nightly run", () => {
  it("a dry run reports what a run would change and writes nothing at all", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    ledger(t, 10);
    const r = await t.rt.learningRun({ dry: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).toMatchObject({ dry: true, facts: 10 });
    expect(r.report.estimates).toMatchObject({ total: 1, new: 1, changed: 0 });
    const prior = domainStrengthFor(HAIKU, "code")?.p ?? 0.5;
    expect(r.report.estimates.movers[0].to).toBeCloseTo((10 * prior + 10) / 20, 12);
    expect(t.store.getEstimates()).toEqual([]);
    expect(t.store.getRungTimes()).toEqual([]);
    expect(t.store.lastLearningRun()).toBeUndefined();
  });

  it("a real run needs learning.enabled: without it, it says so and touches nothing", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    ledger(t, 10);
    expect(await t.rt.learningRun({ dry: false })).toEqual({
      ok: false,
      error: "learning-disabled",
    });
    expect(t.store.getEstimates()).toEqual([]);
    expect(t.store.lastLearningRun()).toBeUndefined();
  });

  it("with it on, writes the estimates and the measured time per rung and keeps the report", async () => {
    const t = make({ mode: "shadow", learning: { enabled: true } });
    await t.rt.start();
    ledger(t, 30, { win: (i) => i % 3 !== 0 });
    const r = await t.rt.learningRun({ dry: false });
    expect(r.ok).toBe(true);
    const est = t.store.getEstimates();
    expect(est).toHaveLength(1);
    expect(est[0]).toMatchObject({
      domain: "code",
      stepKind: "tool",
      rung: HAIKU,
      n: 30,
      wins: 20,
    });
    const prior = domainStrengthFor(HAIKU, "code")?.p ?? 0.5;
    expect(est[0].posterior).toBeCloseTo((10 * prior + 20) / 40, 12);
    const times = t.store.getRungTimes();
    expect(times).toHaveLength(1);
    expect(times[0]).toMatchObject({ rung: HAIKU, n: 30 });
    expect(times[0].durationP95Sec).toBeGreaterThanOrEqual(times[0].durationP50Sec);
    const report = t.rt.learningReport();
    expect(report.last?.report).toMatchObject({ dry: false, facts: 30 });
    expect(report.estimates).toBe(1);
  });

  it("run twice on the same ledger, the second changes nothing", async () => {
    const t = make({ mode: "shadow", learning: { enabled: true } });
    await t.rt.start();
    ledger(t, 12);
    await t.rt.learningRun({ dry: false });
    const again = await t.rt.learningRun({ dry: true });
    expect(again.ok && again.report.estimates).toMatchObject({ changed: 0, new: 0, movers: [] });
  });

  it("joins an outcome to the model that answered, never to the pick", async () => {
    const t = make({ mode: "shadow", learning: { enabled: true } });
    await t.rt.start();
    // The router's decision named claude-opus-5 as incumbent; Haiku answered. The credit goes to Haiku.
    ledger(t, 5, { model: HAIKU });
    await t.rt.learningRun({ dry: false });
    expect(t.store.getEstimates().map((e) => e.rung)).toEqual([HAIKU]);
  });

  it("reads the refusals the veto is built from, from the ledger", async () => {
    const t = make({ mode: "shadow", learning: { enabled: true } });
    await t.rt.start();
    const medical =
      "My doctor prescribed a medication dose; what are the side effects and symptoms of this treatment";
    ledger(t, 4, { model: OPUS, text: medical, refused: (i) => i < 2 });
    const r = await t.rt.learningRun({ dry: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const topic = t.store.outcomeFacts()[0]?.topic;
    if (topic && topic !== "none") {
      expect(r.report.refusals.records).toBe(2);
      expect(r.report.refusals.vetoes).toEqual([{ family: "claude-opus-5", cls: topic, count: 2 }]);
    } else {
      // The local reader did not call this text medical; the refusals then belong to no class and veto nothing.
      expect(r.report.refusals.records).toBe(0);
    }
  });
});

describe("the router uses what was learned, and only when told to", () => {
  const plan = {
    id: "p",
    task: { kind: "reason" as const, urgency: "whenever" as const, shape: "answer" as const },
    units: [
      {
        id: "u",
        task: "",
        kind: "work" as const,
        inputs: [],
        outputs: [],
        writes: [],
        estIn: 1000,
        estOut: 200,
        model: "auto" as const,
        urgency: "whenever" as const,
        private: false,
      },
    ],
  };
  const qualityOfHaiku = (t: ReturnType<typeof make>): number => {
    const sched = t.rt.scheduler()!;
    const unit = plan.units[0];
    const dec = sched.priceUnit(
      plan,
      unit,
      { nowMs: NOW, ledger: new Map(), conversationKey: "c", slackSec: 0, index: 0 },
      board(),
    )!;
    return dec.options.find((o) => o.rung.key === HAIKU)!.quality;
  };

  async function after(n: number, raw: Record<string, unknown>) {
    const t = make({ mode: "shadow", ...raw });
    await t.rt.start();
    const before = qualityOfHaiku(t);
    ledger(t, n, { text: REASON });
    await t.rt.learningRun({ dry: false });
    return { before, after: qualityOfHaiku(t) };
  }

  it("the option's quality moves by twenty AA points per unit of strength, toward the record, more with more evidence", async () => {
    const pHaiku = domainStrengthFor(HAIKU, "reason")!.p;
    const pOpus = domainStrengthFor(OPUS, "reason")!.p;
    const cfg = { learning: { enabled: true, apply: true } };
    const few = await after(10, cfg);
    const many = await after(300, cfg);
    // Quality = smart + 20 x (strength - anchor's). Every recorded call won, so strength rises from the map toward 1.
    const expected = (n: number) => 52 + 20 * ((10 * pHaiku + n) / (10 + n) - pOpus);
    expect(few.before).toBeCloseTo(52 + 20 * (pHaiku - pOpus), 9);
    expect(few.after).toBeCloseTo(expected(10), 9);
    expect(many.after).toBeCloseTo(expected(300), 9);
    expect(many.after).toBeGreaterThan(few.after);
    expect(few.after).toBeGreaterThan(few.before);
  });

  it("leaves the router on the public map when apply is off, however much was learned", async () => {
    const off = await after(300, { learning: { enabled: true } });
    expect(off.after).toBeCloseTo(off.before, 12);
  });

  it("a store that already holds a run gives the router its estimates at start, with no new run", async () => {
    const first = make({ mode: "shadow", learning: { enabled: true, apply: true } });
    await first.rt.start();
    ledger(first, 300, { text: REASON });
    await first.rt.learningRun({ dry: false });
    const learned = qualityOfHaiku(first);
    const second = make({ mode: "shadow", learning: { apply: true } }, { store: first.store });
    await second.rt.start();
    expect(qualityOfHaiku(second)).toBeCloseTo(learned, 12);
  });
});

describe("the owner's pin", () => {
  it("is stored for a known task and refused for an unknown one", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    t.store.upsertUse({
      taskId: "t1",
      ts: NOW,
      session: "s",
      source: "tinker",
      private: false,
      shuffled: false,
      shown: [],
      noneFits: 1,
      listShown: false,
      listReason: "not-asked",
      listSource: "local",
      used: [],
      outcome: "done",
      cardVersions: {},
      questionVersion: 0,
      mode: "shadow",
    });
    expect(t.rt.pin({ taskId: "nope", cardId: "skill:a" })).toEqual({
      ok: false,
      error: "unknown-task",
    });
    expect(t.rt.pin({ taskId: "t1", cardId: "skill:a" })).toEqual({ ok: true });
    expect(t.store.listPins()).toMatchObject([{ taskId: "t1", cardId: "skill:a", by: "owner" }]);
  });
});

describe("a store made before phase F", () => {
  it("gains the new columns in place and keeps working", () => {
    const root = mkdtempSync(join(tmpdir(), "thalamus-migrate-"));
    dirs.push(root);
    const file = join(root, "old.sqlite");
    new ThalamusStore(file).close();
    const raw = new Database(file);
    for (const col of ["domain", "topic", "step_kind"])
      raw.exec(`ALTER TABLE decisions DROP COLUMN ${col}`);
    raw.exec("ALTER TABLE enh_uses DROP COLUMN task_kind");
    raw.close();
    const s = new ThalamusStore(file);
    const check = new Database(file, { readonly: true });
    const has = (table: string, col: string) =>
      (check.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
        (c) => c.name === col,
      );
    expect(
      has("decisions", "domain") && has("decisions", "topic") && has("decisions", "step_kind"),
    ).toBe(true);
    expect(has("enh_uses", "task_kind")).toBe(true);
    check.close();
    expect(s.outcomeFacts()).toEqual([]);
    s.close();
  });
});
