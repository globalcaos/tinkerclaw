/**
 * FORK 2026-10-29: tests for fork.prefrontal.embed, the server half of the J13 semantic recipe
 * lane (src/fork/prefrontal-state-rpc.ts; TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
 *
 * The decision (resolveMemorySearchConfig, the fit record) and the governor are stubbed and the
 * provider is a fake, so these cases pin the RPC's own contract: a words-only machine answers at
 * once, the first call warms the recipe cache with one background fill, a warm call embeds only
 * the prompt, a budget that cannot be met degrades without waiting, and a retired trial calls no
 * provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __prefrontalRecipeFillsForTest,
  __resetPrefrontalRecipeVectorsForTest,
  forkPrefrontalStateHandlers,
} from "./prefrontal-state-rpc.js";

type CallOpts = { priority?: string; budgetMs?: number };
type FakeProvider = {
  id: string;
  model: string;
  embedQuery: (text: string, opts?: CallOpts) => Promise<number[]>;
  embedBatch: (texts: string[], opts?: CallOpts) => Promise<number[][]>;
};

const h = vi.hoisted(() => {
  class FakeUnavailableError extends Error {
    readonly reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.name = "EmbedderUnavailableError";
      this.reason = reason;
    }
  }
  return {
    FakeUnavailableError,
    config: {} as Record<string, unknown>,
    memorySearch: null as Record<string, unknown> | null,
    createProvider: vi.fn(),
    governOptions: [] as unknown[],
    trial: { retired: false, n: Number.POSITIVE_INFINITY, invocations: 0, recoveries: 0 },
    trialStateCalls: [] as unknown[][],
    noteTrial: vi.fn(),
    queryWindow: { n: 0 } as { n: number; meanMs?: number; p50Ms?: number; p95Ms?: number },
    /** The prompt embed's expected service time: a smaller foreground budget is refused at once. */
    expectedQueryMs: 0,
    /** Reasons the next background calls are refused with, in order. */
    batchRefusals: [] as string[],
  };
});

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => h.config }));
vi.mock("../agents/agent-scope-config.js", () => ({ resolveDefaultAgentId: () => "main" }));
vi.mock("../agents/agent-scope.js", () => ({ resolveAgentDir: () => "agent-dir" }));
vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: () => h.memorySearch,
}));
vi.mock("../gateway/embeddings-http.js", () => ({
  createConfiguredEmbeddingProvider: h.createProvider,
}));
vi.mock("../memory/embeddings-ollama.js", () => ({
  resolveOllamaEmbeddingBaseUrl: () => "http://127.0.0.1:11434",
}));
vi.mock("./embedder-fit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedder-fit.js")>()),
  // No fit record: the trial's miss cost is the labelled prior.
  readEmbedderFit: () => null,
}));
// The governor, reduced to what these cases need: a foreground call whose budget is below the
// expected service time is refused up front, background calls are refused on demand, and the
// trial and the query window are scripted.
vi.mock("./embedder-governor.js", () => ({
  EmbedderUnavailableError: h.FakeUnavailableError,
  governEmbeddingProvider: (provider: FakeProvider, options: unknown) => {
    h.governOptions.push(options);
    return {
      id: provider.id,
      model: provider.model,
      endpointKey: "ollama|http://127.0.0.1:11434",
      embedQuery: (text: string, opts?: CallOpts) => {
        const budgetMs = opts?.budgetMs;
        if (typeof budgetMs === "number" && h.expectedQueryMs > budgetMs) {
          const why = `expected ${h.expectedQueryMs} ms exceeds the ${budgetMs} ms budget`;
          return Promise.reject(new h.FakeUnavailableError("over-budget", why));
        }
        return provider.embedQuery(text, opts);
      },
      embedBatch: (texts: string[], opts?: CallOpts) => {
        const refusal = opts?.priority === "background" ? h.batchRefusals.shift() : undefined;
        if (refusal) {
          return Promise.reject(new h.FakeUnavailableError(refusal, `refused: ${refusal}`));
        }
        return provider.embedBatch(texts, opts);
      },
    };
  },
  getEmbedGovernor: () => ({
    noteTrial: h.noteTrial,
    trialState: (...args: unknown[]) => {
      h.trialStateCalls.push(args);
      return { ...h.trial };
    },
    liveQueryWindow: () => ({ ...h.queryWindow }),
    budget: () => ({
      concurrency: 1,
      batchTokens: 8000,
      batchDeadlineMs: 600_000,
      queryDeadlineMs: 60_000,
      retries5xx: 0,
      source: "ceiling",
    }),
  }),
}));

const PROMPT = "push my changes live for customers";
const RECIPES = Array.from({ length: 100 }, (_, i) => `Recipe ${i}. Does task ${i}. tag-${i}`);
const TEXTS = [PROMPT, ...RECIPES];

/** A distinct vector per text, so the answer's order can be checked. */
function vectorOf(text: string): number[] {
  let hash = 0;
  for (const ch of text) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
  }
  return [text.length, hash];
}

/** The provider behind the governor. With holdBatches, its batches wait for release(). */
function fakeProvider(opts: { holdBatches?: boolean } = {}) {
  let releaseHeld: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const batches: Array<{ texts: string[]; opts?: CallOpts }> = [];
  const queries: Array<{ text: string; opts?: CallOpts }> = [];
  const provider = {
    id: "ollama",
    model: "fake-embed",
    embedQuery: vi.fn(async (text: string, callOpts?: CallOpts) => {
      queries.push({ text, opts: callOpts });
      return vectorOf(text);
    }),
    embedBatch: vi.fn(async (texts: string[], callOpts?: CallOpts) => {
      batches.push({ texts, opts: callOpts });
      if (opts.holdBatches) {
        await held;
      }
      return texts.map(vectorOf);
    }),
  };
  h.createProvider.mockResolvedValue(provider);
  return { provider, batches, queries, release: () => releaseHeld() };
}

/** Drive the handler and return its answer; it must always answer ok. */
async function embed(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const box: { reply?: Record<string, unknown> } = {};
  await forkPrefrontalStateHandlers["fork.prefrontal.embed"]!({
    params,
    respond: (ok: boolean, result?: unknown) => {
      expect(ok).toBe(true);
      box.reply = result as Record<string, unknown>;
    },
    isWebchatConnect: () => false,
  } as never);
  if (!box.reply) {
    throw new Error("fork.prefrontal.embed did not answer");
  }
  return box.reply;
}

/** Let queued promise callbacks run, such as the first call of a fill. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** The promise's value, or a failure after `ms`: a hang fails fast instead of at the timeout. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Warm the cache: the first call starts the fill, and this waits it out. */
async function warm(): Promise<void> {
  expect(await embed({ texts: TEXTS })).toMatchObject({ warming: true, missing: RECIPES.length });
  await __prefrontalRecipeFillsForTest();
}

let stateDir = "";
let savedStateDir: string | undefined;

beforeAll(() => {
  // Nothing here should touch the state dir; a temp one keeps any slip off the real one.
  savedStateDir = process.env.OPENCLAW_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "prefrontal-embed-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterAll(() => {
  if (savedStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = savedStateDir;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetPrefrontalRecipeVectorsForTest();
  h.config = {};
  h.memorySearch = { provider: "ollama", model: "fake-embed" };
  h.createProvider.mockReset();
  h.noteTrial.mockReset();
  h.governOptions.length = 0;
  h.trial = { retired: false, n: Number.POSITIVE_INFINITY, invocations: 0, recoveries: 0 };
  h.trialStateCalls.length = 0;
  h.queryWindow = { n: 0 };
  h.expectedQueryMs = 0;
  h.batchRefusals.length = 0;
});

describe("fork.prefrontal.embed: the J13 semantic recipe lane", () => {
  it("answers 'embeddings off' at once and creates no provider on a words-only machine", async () => {
    for (const memorySearch of [{ provider: "none", model: "" }, null]) {
      h.memorySearch = memorySearch;
      expect(await embed({ texts: TEXTS })).toEqual({
        embeddings: [],
        armed: false,
        reason: "embeddings off",
      });
    }
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it("answers the first call with 101 texts 'warming' and starts exactly one background fill", async () => {
    const fake = fakeProvider({ holdBatches: true });
    expect(await embed({ texts: TEXTS })).toMatchObject({
      embeddings: [],
      warming: true,
      missing: 100,
    });
    await settle();
    // A second weak turn while the fill runs joins it instead of starting another.
    expect(await embed({ texts: TEXTS })).toMatchObject({ warming: true, missing: 100 });
    await settle();
    expect(fake.batches).toEqual([{ texts: RECIPES, opts: { priority: "background" } }]);
    expect(fake.queries).toEqual([]);
    fake.release();
    await __prefrontalRecipeFillsForTest();
  });

  it("embeds only the prompt once the recipe vectors are cached and answers 101 vectors", async () => {
    const fake = fakeProvider();
    await warm();
    h.queryWindow = { n: 30, meanMs: 120, p50Ms: 100, p95Ms: 200 };
    const reply = await embed({ texts: TEXTS, prevRecovered: 2 });
    // The fake sees one text, the prompt, in the foreground under the 1 s lane ceiling.
    expect(fake.queries).toEqual([
      { text: PROMPT, opts: { priority: "foreground", budgetMs: 1000 } },
    ]);
    expect(fake.batches).toHaveLength(1);
    expect(reply.embeddings).toEqual(TEXTS.map(vectorOf));
    // budgetMs = min(1,000 ms, 2 x the measured query p95 of 200 ms).
    expect(reply).toMatchObject({ model: "fake-embed", count: 101, budgetMs: 400 });
    // The client's two rescues count before the retire check; this answer is one invocation.
    expect(h.noteTrial.mock.calls).toEqual([
      ["prefrontal", { invoked: false, recovered: 2 }],
      ["prefrontal", { invoked: true, recovered: 0 }],
    ]);
    expect(h.trialStateCalls.at(-1)).toEqual([
      "prefrontal",
      { missCostMs: expect.closeTo(21_570, 6), meanQueryMs: 120, catalogKey: expect.any(String) },
    ]);
  });

  it("answers 'degraded' without waiting when the budget cannot be met", async () => {
    const fake = fakeProvider();
    await warm();
    // This provider never answers: only a refusal up front can end the call.
    fake.provider.embedQuery.mockImplementation(() => new Promise<number[]>(() => undefined));
    h.expectedQueryMs = 5_000;
    // The client asks for 60 s; the RPC clamps it to the 1 s ceiling, which 5 s cannot meet.
    const reply = await within(2_000, embed({ texts: TEXTS, budgetMs: 60_000 }));
    expect(reply).toEqual({ embeddings: [], degraded: "over-budget", budgetMs: 1000 });
    expect(fake.provider.embedQuery).not.toHaveBeenCalled();
    expect(h.noteTrial).not.toHaveBeenCalled();
  });

  it("answers armed:false for a retired trial and makes no provider call", async () => {
    const fake = fakeProvider();
    h.trial = { retired: true, n: 324, invocations: 324, recoveries: 0 };
    expect(await embed({ texts: TEXTS })).toEqual({
      embeddings: [],
      armed: false,
      reason: "retired: 0 recoveries in 324 invocations",
    });
    await settle();
    expect(fake.provider.embedBatch).not.toHaveBeenCalled();
    expect(fake.provider.embedQuery).not.toHaveBeenCalled();
  });

  it("ends a fill on a 'busy' refusal, and the next weak turn starts another", async () => {
    const fake = fakeProvider();
    h.batchRefusals.push("busy");
    expect(await embed({ texts: TEXTS })).toMatchObject({ warming: true, missing: 100 });
    await __prefrontalRecipeFillsForTest();
    expect(fake.batches).toHaveLength(0);
    await warm();
    expect(fake.batches).toHaveLength(1);
    expect((await embed({ texts: TEXTS })).embeddings).toHaveLength(101);
  });

  it("governs the provider as the prefrontal consumer, in fit mode only for an auto provider", async () => {
    fakeProvider();
    await embed({ texts: TEXTS });
    h.config = { agents: { defaults: { memorySearch: { provider: "ollama" } } } };
    await embed({ texts: TEXTS });
    expect(h.governOptions).toEqual([
      { consumer: "prefrontal", baseUrl: "http://127.0.0.1:11434", mode: "fit" },
      { consumer: "prefrontal", baseUrl: "http://127.0.0.1:11434", mode: "pin" },
    ]);
    await __prefrontalRecipeFillsForTest();
  });

  it("refuses more than 128 texts instead of embedding a cut list", async () => {
    fakeProvider();
    const texts = Array.from({ length: 129 }, (_, i) => `text ${i}`);
    expect(await embed({ texts })).toEqual({ embeddings: [], error: "too many inputs (max 128)" });
    expect(h.createProvider).not.toHaveBeenCalled();
  });
});
