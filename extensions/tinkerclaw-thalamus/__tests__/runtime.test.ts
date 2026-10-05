import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCallRouter,
  getRoutingReadProvider,
  type ThalamusBoardLike,
  type UsageMark,
} from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GROK,
  NOW,
  OPUS,
  R,
  SONNET,
  HAIKU,
  supplies,
} from "../../../src/shared/thalamus-v4.test-support.js";
import type { AgentEventLike } from "../src/cache-feed.js";
import { parseConfig } from "../src/config.js";
import { createRuntime, type RuntimeDeps } from "../src/runtime.js";
import { ThalamusStore } from "../src/store.js";

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.OPENCLAW_THALAMUS_V4;
});

const board = (): ThalamusBoardLike => ({
  rungs: [R.opus, R.sonnet, R.haiku, R.grok],
  supplies: supplies(),
  contextWindowFor: () => 1_000_000,
  dialIdx: 3,
  builtAtMs: NOW,
});

function make(raw: Record<string, unknown> = {}, over: Partial<RuntimeDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "thalamus-rt-"));
  dirs.push(root);
  const dataDir = join(root, "not", "yet", "there");
  const listeners: Array<(e: AgentEventLike) => void> = [];
  const logs: string[] = [];
  const rt = createRuntime({
    config: parseConfig({ dataDir, ...raw }),
    extensionRoot,
    gatewayPort: 18789,
    gatewayCfg: () => ({}),
    onAgentEvent: (l) => {
      listeners.push(l);
      return () => void listeners.splice(listeners.indexOf(l), 1);
    },
    broadcast: () => {},
    logger: {
      info: (m) => void logs.push(m),
      warn: (m) => void logs.push(m),
      error: (m) => void logs.push(m),
    },
    now: () => NOW,
    readBoard: () => board(),
    handPicked: () => false,
    listing: () => [
      { kind: "skill", name: "translation-checker", path: "/s/tc/SKILL.md" },
      { kind: "skill", name: "photo-sorter", path: "/s/ps/SKILL.md" },
    ],
    attribute: (call) =>
      call.name === "Skill"
        ? ([
            {
              kind: "skill",
              name: String((call.args as { skill?: string }).skill),
              via: "skill-tool",
            },
          ] as UsageMark[])
        : [],
    readText: (p) =>
      p.includes("/tc/")
        ? "---\ndescription: Compares a translation with its source.\n---\n"
        : "---\ndescription: Sorts photos.\n---\n",
    defer: (fn) => fn(),
    ...over,
  });
  stops.push(() => rt.stop());
  const emit = (e: Partial<AgentEventLike>) =>
    listeners.forEach((l) => l({ runId: "run-1", stream: "call", ts: NOW, data: {}, ...e }));
  return { rt, dataDir, emit, logs, listeners };
}

describe("mode off: nothing is opened", () => {
  it("creates no folder, no file, no router and no provider", async () => {
    const t = make();
    await t.rt.start();
    expect(existsSync(t.dataDir)).toBe(false);
    expect(getCallRouter()).toBeUndefined();
    expect(getRoutingReadProvider()).toBeUndefined();
    expect(t.listeners).toHaveLength(0);
    expect(t.rt.status()).toMatchObject({ mode: "off", running: false, cards: 0 });
    expect(t.rt.shortlist()).toBeUndefined();
  });

  it("treats a mode it does not know as off", async () => {
    const t = make({ mode: "on" });
    await t.rt.start();
    expect(existsSync(t.dataDir)).toBe(false);
  });

  it("honours the environment kill switch even in shadow", async () => {
    process.env.OPENCLAW_THALAMUS_V4 = "off";
    const t = make({ mode: "shadow" });
    await t.rt.start();
    expect(existsSync(t.dataDir)).toBe(false);
    expect(getCallRouter()).toBeUndefined();
  });
});

describe("mode shadow: it starts what it needs and creates the folder itself", () => {
  it("creates the data folder that did not exist, with a private token file", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    expect(existsSync(join(t.dataDir, "thalamus.sqlite"))).toBe(true);
    expect(statSync(t.dataDir).mode & 0o777).toBe(0o700);
    const endpoint = join(t.dataDir, "endpoint.json");
    expect(statSync(endpoint).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(endpoint, "utf8"));
    expect(body.port).toBe(18789);
    expect(body.token).toBe(t.rt.token());
    expect(body.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it("registers the call router and listens to the event bus, and stop() removes both", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    expect(getCallRouter()).toBeDefined();
    expect(t.listeners).toHaveLength(1);
    t.rt.stop();
    expect(getCallRouter()).toBeUndefined();
    expect(t.listeners).toHaveLength(0);
    expect(t.rt.status().running).toBe(false);
  });

  it("does not register the routing provider unless Jev is on", async () => {
    const off = make({ mode: "shadow" });
    await off.rt.start();
    expect(getRoutingReadProvider()).toBeUndefined();
    off.rt.stop();
    const on = make({ mode: "shadow", jev: { enabled: true } });
    await on.rt.start();
    expect(getRoutingReadProvider()).toBeDefined();
    on.rt.stop();
    expect(getRoutingReadProvider()).toBeUndefined();
  });

  it("seeds a card for every installed enhancement, from its own file, once", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    expect(t.rt.cardCount()).toBe(2);
    const store = new ThalamusStore(join(t.dataDir, "thalamus.sqlite"));
    const cards = store.activeCards();
    expect(cards.map((c) => c.id)).toEqual(["skill:photo-sorter", "skill:translation-checker"]);
    expect(cards.find((c) => c.name === "translation-checker")!.purpose).toBe(
      "Compares a translation with its source.",
    );
    store.close();
  });

  it("does not start twice", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    await t.rt.start();
    expect(t.listeners).toHaveLength(1);
  });

  it("survives a card seeding that fails", async () => {
    const t = make(
      { mode: "shadow" },
      {
        listing: () => {
          throw new Error("registry not ready");
        },
      },
    );
    await t.rt.start();
    expect(t.rt.status().running).toBe(true);
    expect(t.logs.some((l) => l.includes("card seeding failed"))).toBe(true);
  });
});

describe("mode shadow: what the bus does", () => {
  it("routes a call from the embedded runner, records it, and joins the outcome by run and call index", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    getCallRouter()!.observe({
      model: {},
      context: { messages: [{ role: "user", content: "compare my translation" }] },
      meta: {
        runId: "run-1",
        sessionKey: "agent:main:tinker:x",
        provider: "claude-code",
        model: "claude-opus-5",
      },
      callIndex: 0,
    });
    expect(t.rt.feed()).toHaveLength(1);
    expect(t.rt.explain("run-1:0")).toMatchObject({
      runId: "run-1",
      lane: "embedded",
      applied: false,
    });
    t.emit({
      data: { phase: "end", callIndex: 0, input: 5, cacheRead: 0, cacheWrite: 300, output: 40 },
    });
    const store = new ThalamusStore(join(t.dataDir, "thalamus.sqlite"));
    expect(store.getOutcome("run-1:0")).toMatchObject({
      actual_model: OPUS,
      cache_write: 300,
      output: 40,
    });
    store.close();
    expect(t.rt.status()).toMatchObject({
      mode: "shadow",
      running: true,
      counts: { decisions: 1, outcomes: 1 },
    });
  });

  it("does not record an outcome for a call it made no decision about", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    t.emit({
      runId: "stranger",
      data: { phase: "end", callIndex: 4, input: 1, cacheRead: 0, cacheWrite: 1 },
    });
    expect(t.rt.status().counts!.outcomes).toBe(0);
  });

  it("observes tool starts and writes one use row when the run ends", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    const seam = t.rt.shortlist()!;
    await seam.prepare({
      id: "run-1",
      runId: "run-1",
      ts: 1,
      sessionKey: "s",
      text: "compare my translation with the source text",
      source: "tinker",
      trigger: "user",
    });
    t.emit({
      stream: "tool",
      data: { phase: "start", name: "Skill", args: { skill: "translation-checker" } },
    });
    t.emit({ stream: "lifecycle", data: { phase: "end" } });
    const store = new ThalamusStore(join(t.dataDir, "thalamus.sqlite"));
    const use = store.getUse("run-1")!;
    expect(use.outcome).toBe("done");
    expect(use.used.map((u) => u.cardId)).toEqual(["skill:translation-checker"]);
    expect(use.used[0].onList).toBe(true);
    store.close();
  });

  it("records a run that ended in error as retried", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    await t.rt
      .shortlist()!
      .prepare({
        id: "run-1",
        runId: "run-1",
        ts: 1,
        sessionKey: "s",
        text: "compare my translation with the source",
        source: "tinker",
      });
    t.emit({ stream: "lifecycle", data: { phase: "error" } });
    const store = new ThalamusStore(join(t.dataDir, "thalamus.sqlite"));
    expect(store.getUse("run-1")!.outcome).toBe("retried");
    store.close();
  });

  it("never lets a bad event break the bus", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    expect(() => {
      t.emit({ data: undefined as never });
      t.emit({ stream: "tool", data: { phase: "start" } });
      t.emit({ stream: "lifecycle", data: {} });
    }).not.toThrow();
  });
});

describe("status", () => {
  it("reports the mode, whether Jev is on and whether a key exists, without exposing the key", async () => {
    process.env.TYPESAFE_API_KEY = "k-secret";
    try {
      const t = make({ mode: "shadow", jev: { enabled: true } });
      await t.rt.start();
      const s = JSON.stringify(t.rt.status());
      expect(t.rt.status().jev).toEqual({ enabled: true, sendRealSituations: false, hasKey: true });
      expect(s).not.toContain("k-secret");
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });
});
