import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCallRouter,
  getToolResultDigester,
  getWorkerProvider,
  type ThalamusBoardLike,
} from "openclaw/plugin-sdk/fork-thalamus";
import { afterEach, describe, expect, it } from "vitest";
import type { CallRouteCall } from "../../../src/infra/thalamus-call-router.js";
import { NOW, R, supplies } from "../../../src/shared/thalamus-v4.test-support.js";
import type { AgentEventLike } from "../src/cache-feed.js";
import { parseConfig } from "../src/config.js";
import type { ModelCaller } from "../src/model-caller.js";
import { createRuntime, resultText, type RuntimeDeps } from "../src/runtime.js";
import { ThalamusStore } from "../src/store.js";

// Phase D2 wiring: the fresh-point services, the digester seam and the Claude Code worker lane, as the runtime starts them.

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
  dialIdx: 3,
  builtAtMs: NOW,
});

function make(raw: Record<string, unknown> = {}, over: Partial<RuntimeDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "thalamus-fresh-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const store = new ThalamusStore(":memory:");
  const listeners: Array<(e: AgentEventLike) => void> = [];
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
  const emit = (e: Partial<AgentEventLike>) =>
    listeners.forEach((l) => l({ runId: "run-1", stream: "tool", ts: NOW, data: {}, ...e }));
  return { rt, store, dataDir, emit };
}

const call = (over: Partial<CallRouteCall> = {}): CallRouteCall => ({
  model: { id: "m" },
  context: {
    systemPrompt: "You are helpful.",
    messages: [{ role: "user", content: "Compare my translation with the source text." }],
  },
  meta: {
    runId: "run-1",
    sessionKey: "agent:main:tinker:abc",
    agentId: "main",
    trigger: "user",
    provider: "claude-code",
    model: "claude-opus-5",
    thinkLevel: "high",
  },
  callIndex: 0,
  ...over,
});

const LONG = "line of a very long tool result that nobody will read in full\n".repeat(700);
const toolResult = (name: string, toolCallId: string, text: string, isError = false) => ({
  phase: "result",
  name,
  toolCallId,
  isError,
  result: { content: [{ type: "text", text }] },
});

describe("resultText", () => {
  it("reads text blocks, a plain string, and nothing else", () => {
    expect(
      resultText({
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
      }),
    ).toBe("a\nb");
    expect(resultText("plain")).toBe("plain");
    expect(resultText({ details: {} })).toBe("");
    expect(resultText(undefined)).toBe("");
  });
});

describe("the worker provider (design D5)", () => {
  it("is registered with the router in shadow, removed by stop(), and never registered when off", async () => {
    const off = make();
    await off.rt.start();
    expect(getWorkerProvider()).toBeUndefined();
    const t = make({ mode: "shadow" });
    await t.rt.start();
    expect(getWorkerProvider()).toBeDefined();
    t.rt.stop();
    expect(getWorkerProvider()).toBeUndefined();
    expect(getToolResultDigester()).toBeUndefined();
  });

  it("counts a sub-agent call from its start and end frames, one row, with the output joined in", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    const p = getWorkerProvider()!;
    p.noteSubagentCall!({
      sessionKey: "s1",
      phase: "start",
      parentToolUseId: "toolu_1",
      t: 1000,
      model: "claude-haiku-4-5",
      inputTokens: 6,
      cacheReadTokens: 140_000,
    });
    p.noteSubagentCall!({
      sessionKey: "s1",
      phase: "end",
      parentToolUseId: "toolu_1",
      t: 1005,
      outputTokens: 9,
    });
    expect(t.store.listSubagentCalls({ session: "s1" })).toMatchObject([
      {
        session: "s1",
        parentToolUseId: "toolu_1",
        model: "claude-haiku-4-5",
        input: 6,
        cacheRead: 140_000,
        output: 9,
      },
    ]);
    // An end with no start, or with no count, invents nothing.
    p.noteSubagentCall!({
      sessionKey: "s1",
      phase: "end",
      parentToolUseId: "toolu_x",
      t: 1,
      outputTokens: 3,
    });
    expect(t.store.listSubagentCalls({ session: "s1" })).toHaveLength(1);
  });

  const offer = () => ({
    model: "claude-sonnet-5-5",
    agentsJson: '{"scout":{"model":"haiku"}}',
    env: { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" },
  });

  it("offers nothing to a spawn in shadow, or in enforce with both flags off, however the provider answers", async () => {
    for (const cfg of [
      { mode: "shadow", enforce: { workerAgents: true, workerModel: true } },
      { mode: "enforce" },
    ]) {
      const t = make(cfg, { workerExtras: offer });
      await t.rt.start();
      expect(getWorkerProvider()!.spawnExtras!({ sessionKey: "s" })).toBeUndefined();
      t.rt.stop();
    }
  });

  it("filters the offer by flag in enforce: the model by workerModel, agents and env by workerAgents", async () => {
    const only = async (enforce: Record<string, boolean>) => {
      const t = make({ mode: "enforce", enforce }, { workerExtras: offer });
      await t.rt.start();
      const x = getWorkerProvider()!.spawnExtras!({ sessionKey: "s" });
      t.rt.stop();
      return x;
    };
    expect(await only({ workerModel: true })).toEqual({ model: "claude-sonnet-5-5" });
    expect(await only({ workerAgents: true })).toEqual({
      agentsJson: '{"scout":{"model":"haiku"}}',
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" },
    });
  });

  it("offers nothing when nothing decides (the default)", async () => {
    const t = make({ mode: "enforce", enforce: { workerModel: true, workerAgents: true } });
    await t.rt.start();
    expect(getWorkerProvider()!.spawnExtras!({ sessionKey: "s" })).toBeUndefined();
  });
});

describe("shadow: the event bus feeds the fresh-point services, and they only write down what they would do", () => {
  it("records a digest that would pay and spends and changes nothing; no raw file is written", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    getCallRouter()!.observe(call());
    t.emit({ data: toolResult("read", "tc1", LONG) });
    const rows = t.store.listFreshPoints({ kind: "digest" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ acted: false, mode: "shadow", runId: "run-1" });
    expect(existsSync(join(t.dataDir, "raw"))).toBe(false);
    expect(getToolResultDigester()).toBeUndefined();
  });

  it("counts the same error twice as stuck for the next call of that run, and a success clears it", async () => {
    const t = make({ mode: "shadow" });
    await t.rt.start();
    getCallRouter()!.observe(call());
    t.emit({ data: toolResult("exec", "a", "ENOENT /tmp/a1", true) });
    t.emit({ data: toolResult("exec", "b", "ENOENT /tmp/b2", true) });
    getCallRouter()!.observe(call({ callIndex: 1 }));
    expect(t.store.listFreshPoints({ kind: "stuck" })).toHaveLength(1);
    t.emit({ data: toolResult("exec", "c", "ok") });
    getCallRouter()!.observe(call({ callIndex: 2 }));
    expect(t.store.listFreshPoints({ kind: "stuck" })).toHaveLength(1);
  });
});

describe("enforce with the digest flag: the registered digester condenses, keeps the raw, and records that it acted", () => {
  it("registers the digester only then, and digests through a mocked reader", async () => {
    const asked: string[] = [];
    const caller: ModelCaller = async (req) => {
      asked.push(req.modelKey);
      return { text: "a short digest of the long result", input: 10, output: 8 };
    };
    const shadowOnly = make({ mode: "enforce" }, { caller });
    await shadowOnly.rt.start();
    expect(getToolResultDigester()).toBeUndefined();
    shadowOnly.rt.stop();

    const t = make({ mode: "enforce", enforce: { digest: true } }, { caller });
    await t.rt.start();
    const digester = getToolResultDigester();
    expect(digester).toBeDefined();
    getCallRouter()!.observe(call());
    const out = await digester!.digest({
      meta: call().meta,
      toolName: "read",
      toolCallId: "tc9",
      params: {},
      text: LONG,
    });
    expect(out).toContain("a short digest of the long result");
    expect(asked).toHaveLength(1);
    expect(t.store.listFreshPoints({ kind: "digest" })).toMatchObject([
      { acted: true, reason: "digested", mode: "enforce" },
    ]);
    // The bus must not overwrite that acted record with a "would" one for the same result.
    t.emit({ data: toolResult("read", "tc9", LONG) });
    expect(t.store.listFreshPoints({ kind: "digest" })).toMatchObject([{ acted: true }]);
    expect(readdirSync(join(t.dataDir, "raw")).length).toBeGreaterThan(0);
  });

  it("a reader that fails leaves the result as it was", async () => {
    const t = make(
      { mode: "enforce", enforce: { digest: true } },
      { caller: async () => undefined },
    );
    await t.rt.start();
    getCallRouter()!.observe(call());
    const out = await getToolResultDigester()!.digest({
      meta: call().meta,
      toolName: "read",
      toolCallId: "tc1",
      params: {},
      text: LONG,
    });
    expect(out).toBeUndefined();
    expect(t.store.listFreshPoints({ kind: "digest" })[0]).toMatchObject({
      acted: false,
      reason: "reader-failed",
    });
  });
});

describe("the Claude Code digest entry joins a bridge chat to its run by session key", () => {
  it("digests a long result of that session's latest run in enforce, and answers nothing for an unknown session or in shadow", async () => {
    const caller: ModelCaller = async () => ({ text: "the short version", input: 5, output: 4 });
    const t = make({ mode: "enforce", enforce: { digest: true } }, { caller });
    await t.rt.start();
    const i = {
      sessionKey: "agent:main:tinker:abc",
      toolName: "Bash",
      toolCallId: "tu1",
      text: LONG,
    };
    expect(await t.rt.digestForSession(i)).toBeUndefined(); // no run yet for this session
    getCallRouter()!.observe(call());
    expect(await t.rt.digestForSession({ ...i, sessionKey: "someone-else" })).toBeUndefined();
    expect(await t.rt.digestForSession(i)).toContain("the short version");
    expect(t.store.listFreshPoints({ kind: "digest" })).toMatchObject([
      { acted: true, reason: "digested" },
    ]);

    const shadow = make({ mode: "shadow" }, { caller });
    await shadow.rt.start();
    getCallRouter()!.observe(call());
    expect(await shadow.rt.digestForSession(i)).toBeUndefined();
  });
});
