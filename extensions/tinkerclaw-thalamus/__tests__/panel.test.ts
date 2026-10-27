import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCallRouter, type ThalamusBoardLike } from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it } from "vitest";
import type { CallRouteCall } from "../../../src/infra/thalamus-call-router.js";
import { NOW, R, supplies } from "../../../src/shared/thalamus-v4.test-support.js";
import { parseConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";
import { ThalamusStore, type UseRow } from "../src/store.js";

// Phase G, the gateway half: `thalamus.panel` returns everything the Tinker panel draws, and nothing it should not.

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

function make(raw: Record<string, unknown> = { mode: "shadow" }) {
  const root = mkdtempSync(join(tmpdir(), "thalamus-panel-"));
  dirs.push(root);
  const store = new ThalamusStore(":memory:");
  const rt = createRuntime({
    config: parseConfig({ dataDir: join(root, "data"), ...raw }),
    extensionRoot,
    gatewayPort: 18789,
    gatewayCfg: () => ({}),
    onAgentEvent: () => () => {},
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
  });
  stops.push(() => rt.stop());
  return { rt, store };
}

const SECRET = "the quarterly figures for the Hernandez account are confidential";
const call = (i: number): CallRouteCall => ({
  model: { id: "m" },
  context: { systemPrompt: "x", messages: [{ role: "user", content: `${SECRET} ${i}` }] },
  meta: {
    runId: `run-${i}`,
    sessionKey: `agent:main:tinker:secret-${i}`,
    agentId: "main",
    trigger: "user",
    provider: "claude-code",
    model: "claude-opus-5",
    thinkLevel: "high",
  },
  callIndex: 0,
});

const use = (over: Partial<UseRow> = {}): UseRow => ({
  taskId: "t1",
  ts: NOW,
  session: "agent:main:tinker:secret-1",
  source: "tinker",
  private: false,
  shuffled: false,
  shown: [
    { cardId: "skill:translation-checker", rank: 1, prob: 0.62 },
    { cardId: "recipe:photo-sorter", rank: 2, prob: 0.2 },
  ],
  noneFits: 0.1,
  listShown: false,
  listReason: "shown",
  listSource: "jev",
  used: [
    { cardId: "recipe:photo-sorter", onList: true, rank: 2, via: "skill-tool", how: "unknown" },
  ],
  outcome: "done",
  cardVersions: {},
  questionVersion: 1,
  mode: "shadow",
  taskKind: "code",
  ...over,
});

describe("thalamus.panel", () => {
  it("is not available before the runtime runs", () => {
    expect(make().rt.panel()).toEqual({ ok: false, error: "not-running" });
  });

  it("gives the one-line status: the mode, calls today and how many would have changed the model", async () => {
    const t = make();
    await t.rt.start();
    for (let i = 0; i < 3; i++) getCallRouter()!.observe(call(i));
    const p = t.rt.panel();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.mode).toBe("shadow");
    expect(p.today.calls).toBe(3);
    const would = p.decisions.filter((d) => d.wouldChange).length;
    expect(p.today.wouldChange).toBe(would);
    expect(p.lastDecisionAt).toBe(NOW);
    expect(p.learning).toEqual({ enabled: false, apply: false });
  });

  it("lists the newest decisions with the priced options, the rule that decided and the vetoes, and no session key", async () => {
    const t = make();
    await t.rt.start();
    for (let i = 0; i < 15; i++) getCallRouter()!.observe(call(i));
    const p = t.rt.panel();
    if (!p.ok) throw new Error("not ok");
    expect(p.decisions).toHaveLength(12);
    const d = p.decisions[0];
    expect(d.options.length).toBeGreaterThan(1);
    expect(d.options[0]).toHaveProperty("price");
    expect(["keep", "switch", "fresh"]).toContain(d.switchKind);
    expect(typeof d.switchReason).toBe("string");
    expect(d.domain).toBeDefined();
    expect(Array.isArray(d.vetoes)).toBe(true);
    expect(JSON.stringify(p)).not.toContain("agent:main:tinker");
  });

  it("never carries a task's text: nothing the user wrote reaches the panel", async () => {
    const t = make();
    await t.rt.start();
    getCallRouter()!.observe(call(1));
    t.store.upsertUse(use());
    t.store.putReplayText("t1", "a redacted replay text that must not be served", NOW);
    const out = JSON.stringify(t.rt.panel());
    expect(out).not.toContain("Hernandez");
    expect(out).not.toContain("quarterly");
    expect(out).not.toContain("replay text");
  });

  it("gives the newest short lists with what the agent used and the names of the enhancements", async () => {
    const t = make();
    await t.rt.start();
    t.store.seedCards(
      [
        {
          id: "skill:translation-checker",
          kind: "skill",
          name: "translation-checker",
          family: "x",
          purpose: "p",
          structure: "",
          alsoServed: [],
          version: 1,
          status: "active",
          origin: "seed",
        },
        {
          id: "recipe:photo-sorter",
          kind: "recipe",
          name: "photo-sorter",
          family: "x",
          purpose: "p",
          structure: "",
          alsoServed: [],
          version: 1,
          status: "active",
          origin: "seed",
        },
      ],
      NOW,
    );
    t.store.upsertUse(use());
    t.store.upsertUse(use({ taskId: "t0", ts: NOW - 1000, used: [] }));
    const p = t.rt.panel();
    if (!p.ok) throw new Error("not ok");
    expect(p.uses.map((u) => u.taskId)).toEqual(["t1", "t0"]);
    expect(p.uses[0]).toMatchObject({
      listShown: false,
      source: "tinker",
      outcome: "done",
      taskKind: "code",
    });
    expect(p.uses[0].used).toEqual([
      { cardId: "recipe:photo-sorter", onList: true, rank: 2, via: "skill-tool" },
    ]);
    expect(p.cardNames).toEqual({
      "skill:translation-checker": { name: "translation-checker", kind: "skill" },
      "recipe:photo-sorter": { name: "photo-sorter", kind: "recipe" },
    });
  });

  it("gives the newest plan with its units, the critical ones and any hedge, once one was recorded", async () => {
    const t = make();
    await t.rt.start();
    const plan = {
      planId: "p1",
      record: true,
      task: { kind: "general", urgency: "waiting", shape: "parts" },
      units: [
        { id: "a", outputs: ["A"], estIn: 2000, estOut: 300 },
        { id: "b", inputs: ["A"], estIn: 1000, estOut: 200 },
      ],
    };
    expect(t.rt.panel().ok && (t.rt.panel() as { plans: unknown[] }).plans).toEqual([]);
    const r = t.rt.previewPlan(plan);
    expect(r?.ok).toBe(true);
    const p = t.rt.panel();
    if (!p.ok) throw new Error("not ok");
    expect(p.plans).toHaveLength(1);
    expect(p.plans[0]).toMatchObject({ planId: "p1", mode: "shadow" });
    expect(p.plans[0].units.map((u) => u.unitId)).toEqual(["a", "b"]);
    expect(p.plans[0].units.every((u) => u.onCritical)).toBe(true);
    expect(p.plans[0].units[1].deps).toEqual(["a"]);
  });

  it("a preview without record writes nothing, so the panel shows no plan for it", async () => {
    const t = make();
    await t.rt.start();
    t.rt.previewPlan({
      task: { kind: "general", urgency: "waiting", shape: "parts" },
      units: [{ id: "a" }],
    });
    const p = t.rt.panel();
    if (!p.ok) throw new Error("not ok");
    expect(p.plans).toEqual([]);
  });

  it("is empty but well-formed on a fresh store", async () => {
    const t = make();
    await t.rt.start();
    const p = t.rt.panel();
    if (!p.ok) throw new Error("not ok");
    expect(p).toMatchObject({
      ok: true,
      mode: "shadow",
      today: { calls: 0, wouldChange: 0 },
      decisions: [],
      uses: [],
      plans: [],
      cardNames: {},
    });
    expect(p.lastDecisionAt).toBeUndefined();
  });
});
