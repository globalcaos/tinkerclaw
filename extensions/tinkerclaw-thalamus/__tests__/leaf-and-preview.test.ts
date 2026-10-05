import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLeafModelResolver, type ThalamusBoardLike } from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it } from "vitest";
import { NOW, R, supplies } from "../../../src/shared/thalamus-v4.test-support.js";
import type { AgentEventLike } from "../src/cache-feed.js";
import { parseConfig } from "../src/config.js";
import { MAX_PLAN_UNITS, parsePlanRequest } from "../src/plan-input.js";
import { createRuntime, type RuntimeDeps } from "../src/runtime.js";
import { ThalamusStore } from "../src/store.js";

// Phase E3: `model: "auto"` and the plan preview, through the runtime as the plugin starts it.

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const board = (): ThalamusBoardLike => ({
  rungs: [R.opus, R.sonnet, R.haiku, R.grok],
  supplies: supplies(),
  contextWindowFor: () => 1_000_000,
  dialIdx: 1,
  builtAtMs: NOW,
});

function make(raw: Record<string, unknown> = {}, over: Partial<RuntimeDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "thalamus-leaf-"));
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

const PROMPT =
  "Summarise the clauses of this contract that mention termination, with the page of each.";

describe("the leaf resolver in the runtime", () => {
  it("is registered in shadow and enforce, removed by stop(), and never registered when off", async () => {
    const off = make();
    await off.rt.start();
    expect(getLeafModelResolver()).toBeUndefined();
    const shadow = make({ mode: "shadow" });
    await shadow.rt.start();
    expect(getLeafModelResolver()).toBeDefined();
    shadow.rt.stop();
    expect(getLeafModelResolver()).toBeUndefined();
  });

  it("in shadow writes down the model it would pick and answers nothing, so auto stays an omitted model", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    expect(getLeafModelResolver()!.resolve({ prompt: PROMPT, label: "reader-1" })).toBeUndefined();
    const [row] = t.store.listFreshPoints({ kind: "leaf" });
    expect(row).toMatchObject({ acted: false, reason: "would-pick", mode: "shadow" });
    expect(row.model).toMatch(/^claude-code\//);
    expect(JSON.stringify(row)).not.toContain("termination");
    expect(row.detail).toMatchObject({ label: "reader-1", declaredWrites: 0 });
  });

  it("in enforce without its flag still answers nothing", async () => {
    const t = make({ mode: "enforce" });
    await t.rt.start();
    expect(getLeafModelResolver()!.resolve({ prompt: PROMPT })).toBeUndefined();
    expect(t.store.listFreshPoints({ kind: "leaf" })[0]).toMatchObject({
      acted: false,
      reason: "would-pick",
    });
  });

  it("with the flag on hands back a claude-code model and its effort, and records that it acted", async () => {
    const t = make({ mode: "enforce", enforce: { orchestrateAuto: true } });
    await t.rt.start();
    const out = getLeafModelResolver()!.resolve({
      prompt: PROMPT,
      writes: ["out/a.md"],
      reads: ["in.pdf"],
    });
    expect(out?.model).toMatch(/^claude-code\//);
    const [row] = t.store.listFreshPoints({ kind: "leaf" });
    expect(row).toMatchObject({ acted: true, reason: "picked", model: out?.model });
    expect(row.detail).toMatchObject({ declaredWrites: 1, declaredReads: 1 });
    if (out?.thinking) expect(row.detail.effort).toBe(out.thinking);
  });

  it("never picks outside the allowed leaf providers, even when another provider is cheaper", async () => {
    const cheap = {
      ...board(),
      rungs: [R.opus, R.grok],
    } as ThalamusBoardLike;
    const t = make(
      { mode: "enforce", enforce: { orchestrateAuto: true } },
      { readBoard: () => cheap },
    );
    await t.rt.start();
    for (let i = 0; i < 5; i++) {
      const out = getLeafModelResolver()!.resolve({ prompt: `${PROMPT} ${i}` });
      expect(out?.model).toBe("claude-code/claude-opus-5");
    }
  });

  it("can be widened by config, and only then picks another provider", async () => {
    const xaiOnly = { ...board(), rungs: [R.grok] } as ThalamusBoardLike;
    const closed = make(
      { mode: "enforce", enforce: { orchestrateAuto: true } },
      { readBoard: () => xaiOnly },
    );
    await closed.rt.start();
    expect(getLeafModelResolver()!.resolve({ prompt: PROMPT })).toBeUndefined();
    expect(closed.store.listFreshPoints({ kind: "leaf" })[0].reason).toBe("no-option");
    closed.rt.stop();
    const open = make(
      {
        mode: "enforce",
        enforce: { orchestrateAuto: true },
        orchestrate: { allowedLeafProviders: ["claude-code", "xai"] },
      },
      { readBoard: () => xaiOnly },
    );
    await open.rt.start();
    expect(getLeafModelResolver()!.resolve({ prompt: PROMPT })?.model).toBe("xai/grok-4.7");
  });

  it("owns the formerly fixed sites only under ownModelChoices, and orchestrate-auto only under its own flag", async () => {
    const own = make({ mode: "enforce", enforce: { ownModelChoices: true } });
    await own.rt.start();
    const r = getLeafModelResolver()!;
    expect(r.owns?.("subagent")).toBe(true);
    expect(r.owns?.("orchestrate-default")).toBe(true);
    expect(r.owns?.("round-table")).toBe(true);
    expect(r.owns?.("orchestrate-auto")).toBe(false);
    expect(r.resolve({ prompt: PROMPT, label: "child", site: "subagent" })?.model).toMatch(
      /^claude-code\//,
    );
    expect(r.resolve({ prompt: PROMPT })).toBeUndefined();
    const rows = own.store.listFreshPoints({ kind: "leaf" });
    expect(rows.map((x) => [x.detail.site, x.acted])).toEqual(
      expect.arrayContaining([
        ["subagent", true],
        ["orchestrate-auto", false],
      ]),
    );
    own.rt.stop();

    const autoOnly = make({ mode: "enforce", enforce: { orchestrateAuto: true } });
    await autoOnly.rt.start();
    expect(getLeafModelResolver()!.owns?.("orchestrate-auto")).toBe(true);
    expect(getLeafModelResolver()!.owns?.("subagent")).toBe(false);
    expect(getLeafModelResolver()!.resolve({ prompt: PROMPT, site: "subagent" })).toBeUndefined();
    autoOnly.rt.stop();

    const shadow = make({
      mode: "shadow",
      enforce: { ownModelChoices: true, orchestrateAuto: true },
    });
    await shadow.rt.start();
    expect(getLeafModelResolver()!.owns?.("subagent")).toBe(false);
    expect(getLeafModelResolver()!.resolve({ prompt: PROMPT, site: "subagent" })).toBeUndefined();
  });

  it("answers nothing without a board", async () => {
    const t = make(
      { mode: "enforce", enforce: { orchestrateAuto: true } },
      { readBoard: () => undefined },
    );
    await t.rt.start();
    expect(getLeafModelResolver()!.resolve({ prompt: PROMPT })).toBeUndefined();
  });
});

describe("thalamus.plan.preview", () => {
  const plan = {
    planId: "p1",
    task: { kind: "general", urgency: "waiting", shape: "parts" },
    units: [
      { id: "a", task: "secret text of a", outputs: ["A"], estIn: 2000, estOut: 300 },
      { id: "b", inputs: ["A"], kind: "check", estIn: 1000, estOut: 200 },
    ],
  };

  it("returns the plan on a virtual clock without writing, sending or spending anything, and without any task text", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    const out = t.rt.previewPlan(plan)!;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.units.map((u) => u.unitId)).toEqual(["a", "b"]);
    expect(out.plan.edges).toEqual([{ from: "a", to: "b", why: "input" }]);
    expect(out.plan.criticalPath).toEqual(["a", "b"]);
    expect(JSON.stringify(out)).not.toContain("secret text");
    expect(t.store.counts().planUnits).toBe(0);
  });

  it("answers nothing before the runtime runs, refuses a malformed or oversized plan, and needs no mode to be on", async () => {
    const t = make({ mode: "shadow" });
    expect(t.rt.previewPlan(plan)).toBeUndefined();
    await t.rt.start();
    expect(t.rt.previewPlan({ units: [] })).toEqual({
      ok: false,
      error: "units: a non-empty list is required",
    });
    expect(t.rt.previewPlan({ units: [{ task: "no id" }] })).toEqual({
      ok: false,
      error: "units[0]: an id is required",
    });
    const big = { units: Array.from({ length: MAX_PLAN_UNITS + 1 }, (_, i) => ({ id: `u${i}` })) };
    expect(t.rt.previewPlan(big)).toEqual({ ok: false, error: `units: at most ${MAX_PLAN_UNITS}` });
    const off = make();
    await off.rt.start();
    expect(off.rt.previewPlan(plan)).toBeUndefined();
    expect(existsSync(join(off.root, "data"))).toBe(false);
  });
});

describe("parsePlanRequest", () => {
  it("clips and defaults every field and trusts none of them", () => {
    const r = parsePlanRequest({
      units: [
        {
          id: "x".repeat(200),
          task: "t".repeat(5000),
          kind: "bogus",
          inputs: ["a", 3, "", "b"],
          writes: "not a list",
          estIn: -5,
          estOut: Number.POSITIVE_INFINITY,
          urgency: "never",
          depth: "deep",
          sharedStart: { id: "s", tokens: 9e12 },
          private: "yes",
        },
      ],
      task: { kind: "", urgency: "waiting", shape: "weird", private: 1 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.req.units[0];
    expect(u.id).toHaveLength(64);
    expect(u.task).toHaveLength(2000);
    expect(u).toMatchObject({
      kind: "work",
      inputs: ["a", "b"],
      writes: [],
      urgency: "waiting",
      depth: "deep",
      private: false,
      estOut: 1500,
      model: "auto",
    });
    expect(u.estIn).toBeGreaterThan(0);
    expect(u.sharedStart).toEqual({ id: "s", tokens: 5_000_000 });
    expect(r.req.task).toMatchObject({
      kind: "general",
      shape: "parts",
      urgency: "waiting",
      private: false,
    });
  });
});
