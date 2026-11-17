// FORK 2026-10-29: tests for src/fork/embedder-governor.ts (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
// Fake timers and a fresh temp OPENCLAW_STATE_DIR in every test (the sandbox tests unset it and
// point HOME at a temp dir instead); fake providers stand in for the embedder, so nothing reaches a
// network or the real state dir. The record fixture is the reference host's bench
// (granite-embedding:30m at 338.2 tokens/s), the same numbers the fit-core tests use.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbedCallOptions, EmbeddingProvider } from "../memory/embeddings.js";
import {
  __resetEmbedderFitForTest,
  cheapFingerprint,
  embedderFitPaths,
  writeEmbedderFit,
  type EmbedderFitRecord,
  type FitDecision,
  type Measured,
} from "./embedder-fit.js";
import {
  __resetEmbedGovernorsForTest,
  EmbedderUnavailableError,
  getEmbedGovernor,
  governEmbeddingProvider,
  governorFor,
  httpStatusOf,
  isEndpointFailure,
  readEmbedGovernorSnapshots,
  setGovernorRemeasureHook,
  type EmbedGovernor,
  type EmbedGovernorEnv,
} from "./embedder-governor.js";

const BASE = "http://127.0.0.1:11434";
const MODEL = "granite-embedding:30m";
const DAY_MS = 86_400_000;
const MIB = 2 ** 20;

let stateDir = "";
const savedStateDir = process.env.OPENCLAW_STATE_DIR;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function resetGovernors(env: Partial<EmbedGovernorEnv> = {}): void {
  __resetEmbedGovernorsForTest({
    log: log as unknown as EmbedGovernorEnv["log"],
    loadavg: () => [0, 0, 0],
    logicalCores: () => 4,
    readPsi: null,
    ...env,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "embedder-governor-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  __resetEmbedderFitForTest();
  log = { info: vi.fn(), warn: vi.fn() };
  resetGovernors();
});

afterEach(() => {
  __resetEmbedGovernorsForTest();
  vi.useRealTimers();
  if (savedStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = savedStateDir;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** Let pending promise continuations run, without any timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

type FakeProvider = EmbeddingProvider & {
  calls: number;
  inFlight: number;
  maxInFlight: number;
  signals: AbortSignal[];
};

function fakeProvider(
  p: {
    id?: string;
    model?: string;
    embed?: (texts: string[], opts?: EmbedCallOptions) => Promise<number[][]>;
  } = {},
): FakeProvider {
  const fake: FakeProvider = {
    id: p.id ?? "ollama",
    model: p.model ?? MODEL,
    calls: 0,
    inFlight: 0,
    maxInFlight: 0,
    signals: [],
    async embedBatch(texts: string[], opts?: EmbedCallOptions): Promise<number[][]> {
      fake.calls += 1;
      fake.inFlight += 1;
      fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
      if (opts?.signal) {
        fake.signals.push(opts.signal);
      }
      try {
        if (p.embed) {
          return await p.embed(texts, opts);
        }
        await settle();
        return texts.map(() => [1, 0]);
      } finally {
        fake.inFlight -= 1;
      }
    },
    async embedQuery(text: string, opts?: EmbedCallOptions): Promise<number[]> {
      const [vector] = await fake.embedBatch([text], opts);
      return vector;
    },
  };
  return fake;
}

function measured(value: number, unit: string): Measured {
  return { value, unit, provenance: "local-measured", source: "test fixture" };
}

function fitRecord(decision: Partial<FitDecision> = {}): EmbedderFitRecord {
  return {
    schemaVersion: 1,
    createdAt: "2026-10-29T08:00:00.000Z",
    fingerprint: cheapFingerprint(),
    inventory: {
      ollama: { baseUrl: BASE, reachable: true, models: [{ name: MODEL, digest: "sha256:0" }] },
      nodeLlamaCpp: false,
      remoteKeys: [],
    },
    candidates: [
      {
        provider: "ollama",
        model: MODEL,
        coldLoadMs: 7200,
        queryP50Ms: 77,
        queryP95Ms: 1672,
        tokensPerSec: measured(338.2, "tokens/s"),
        tokensPerSecLow95: 300,
        tokensPerSecHigh95: 375,
        batchDispersion: 2,
        overheadMs: 60,
        rssBytes: 92 * MIB,
        sanityOk: true,
      },
    ],
    corpus: {
      files: 7719,
      tokens: measured(10_144_896, "tokens"),
      ingestTokensPerDay: measured(266_194, "tokens/day"),
      burstFactor: measured(6.12, "peak day / mean day"),
      chunkTokens: 400,
      overlapTokens: 80,
    },
    missCostSec: measured(21.57, "s"),
    nonEnglishShare: measured(0.022, "share"),
    fitWallSeconds: measured(150, "s"),
    decision: {
      mode: "memory",
      provider: "ollama",
      model: MODEL,
      dormantUntilDemand: true,
      reasons: ["fixture decision"],
      verdicts: [],
      ...decision,
    },
    consent: { remote: null },
    tool: { command: "openclaw embedder fit", version: "test" },
    history: [],
  };
}

function governorOf(provider: EmbeddingProvider): EmbedGovernor {
  const governor = governorFor(provider);
  if (!governor) {
    throw new Error("expected a governed provider");
  }
  return governor;
}

describe("the limiter", () => {
  it("keeps one request in flight on a local endpoint; the unwrapped fake sees all twenty (#24)", async () => {
    const control = fakeProvider();
    await Promise.all(Array.from({ length: 20 }, (_, i) => control.embedBatch([`text ${i}`])));
    expect(control.maxInFlight).toBe(20);

    const fake = fakeProvider();
    const governed = governEmbeddingProvider(fake, { consumer: "memory-index", baseUrl: BASE });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => governed.embedBatch([`text ${i}`])),
    );
    expect(results).toHaveLength(20);
    expect(fake.calls).toBe(20);
    expect(fake.maxInFlight).toBe(1);
  });

  it("runs a queued foreground call before queued background calls", async () => {
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const fake = fakeProvider({
      embed: async (texts) => {
        order.push(texts[0]);
        if (texts[0] === "first") {
          await gate;
        }
        return texts.map(() => [1, 0]);
      },
    });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-index", baseUrl: BASE });
    const first = governed.embedBatch(["first"]);
    await settle();
    const background = [
      governed.embedBatch(["background 1"]),
      governed.embedBatch(["background 2"]),
    ];
    const foreground = governed.embedQuery("foreground");
    await settle();
    expect(order).toEqual(["first"]);
    open();
    await Promise.all([first, ...background, foreground]);
    expect(order).toEqual(["first", "foreground", "background 1", "background 2"]);
  });

  it("is idempotent and keeps id, model and maxInputTokens", () => {
    const fake = { ...fakeProvider(), maxInputTokens: 512 };
    const governed = governEmbeddingProvider(fake, { consumer: "memory-index", baseUrl: BASE });
    expect(governEmbeddingProvider(governed, { consumer: "prefrontal" })).toBe(governed);
    expect(governed).toMatchObject({ id: "ollama", model: MODEL, maxInputTokens: 512 });
    expect(governed.endpointKey).toBe(`ollama|${BASE}`);
    expect(governorFor(fake)).toBeUndefined();
    expect(governorOf(governed).endpointClass).toBe("local-http");
  });
});

describe("deadlines", () => {
  it("aborts the signal the provider received at the deadline and rejects 'deadline', with no retry", async () => {
    const fake = fakeProvider({ embed: () => new Promise<number[][]>(() => undefined) });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-query", baseUrl: BASE });
    const outcome = governed.embedQuery("hello", { budgetMs: 1500 }).then(
      () => undefined,
      (err: unknown) => err,
    );
    await settle();
    expect(fake.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    const err = await outcome;
    expect(err).toBeInstanceOf(EmbedderUnavailableError);
    expect((err as EmbedderUnavailableError).reason).toBe("deadline");
    // The bible's diagnose_with greps this literal (failures.md, embedding backlog loop).
    expect((err as Error).message).toMatch(/^embedding deadline: /);
    expect(fake.signals[0]?.aborted).toBe(true);
    expect(fake.calls).toBe(1);
  });
});

// FORK 2026-10-30: the slot lifecycle, after a cross-provider review of the governor. Each test is
// red on the code before the fix: there the slot went free as soon as the caller was answered, a
// queued budget never expired, a caller's abort counted against the endpoint, every busy period was
// kept, and an abort-aware provider's own AbortError reached the caller.

/** An AbortError, as fetch rejects with when its signal aborts. */
function abortError(): Error {
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

/** A provider call that ends only when its signal aborts, and then rejects with an AbortError. */
function untilAborted(opts?: EmbedCallOptions): Promise<never> {
  return new Promise<never>((_, reject) => {
    opts?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

/**
 * How many busy intervals an endpoint's governor keeps. It reads the private field of the governor
 * in the cross-bundle store, so the same assertion also runs on the code before the fix, where it
 * is the red CONTROL. FORK 2026-10-30: through the store, by endpoint key, because governorFor now
 * hands out a per-consumer view, which holds no state of its own.
 */
function busyIntervalCount(governor: EmbedGovernor): number {
  const store = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embedGovernor.v1")
  ] as { governors: Map<string, { busyIntervals: unknown[] }> };
  return store.governors.get(governor.endpointKey)?.busyIntervals.length ?? Number.NaN;
}

describe("the slot lifecycle", () => {
  it("keeps the slot until a call given up at its deadline settles: one in flight at most (review finding 1)", async () => {
    // The provider ignores its signal and answers 90 s after it starts: past the 60 s query
    // deadline ceiling, inside the hold bound of one more deadline.
    const lateMs = 90_000;
    const starts: number[] = [];
    const fake = fakeProvider({
      embed: (texts) => {
        starts.push(Date.now());
        return new Promise<number[][]>((resolve) => {
          setTimeout(() => resolve(texts.map(() => [1, 0])), lateMs);
        });
      },
    });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-query", baseUrl: BASE });
    const t0 = Date.now();
    const first = governed.embedQuery("first").then(
      () => undefined,
      (err: unknown) => err,
    );
    const second = governed.embedQuery("second").then(
      () => undefined,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    // The caller hears back at its deadline, as before, while the slot stays taken.
    expect(await first).toMatchObject({ reason: "deadline" });
    expect(fake.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(lateMs - 60_000);
    // The first provider call settled at 90 s, and only then did the second start.
    expect(fake.calls).toBe(2);
    expect(starts.map((at) => at - t0)).toEqual([0, lateMs]);
    await vi.advanceTimersByTimeAsync(lateMs);
    expect(await second).toMatchObject({ reason: "deadline" });
    expect(fake.maxInFlight).toBe(1);
    expect(governorOf(governed).snapshot().days.at(-1)).toMatchObject({
      calls: 2,
      deadlines: 2,
      abandoned: 0,
    });
  });

  it("frees the slot one more deadline after a call that never settles, counts each and logs once a day (review finding 1)", async () => {
    const fake = fakeProvider({ embed: () => new Promise<number[][]>(() => undefined) });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-query", baseUrl: BASE });
    const governor = governorOf(governed);
    const first = governed.embedQuery("first").then(
      () => undefined,
      (err: unknown) => err,
    );
    const second = governed.embedQuery("second").then(
      () => undefined,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await first).toMatchObject({ reason: "deadline" });
    // The slot stays taken for one more of the call's 60 s deadline, then goes free.
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(fake.calls).toBe(1);
    expect(governor.snapshot().days.at(-1)?.abandoned).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls).toBe(2);
    expect(governor.snapshot().days.at(-1)?.abandoned).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/^embedder slot abandoned \(ollama\|/);
    // The second call goes the same way: counted again, not logged again the same day.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await second).toMatchObject({ reason: "deadline" });
    expect(governor.snapshot().days.at(-1)?.abandoned).toBe(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("refuses a queued foreground call when its budget runs out, while the slot is still busy (review finding 4)", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const fake = fakeProvider({
      embed: async (texts) => {
        await gate;
        return texts.map(() => [1, 0]);
      },
    });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-query", baseUrl: BASE });
    const busy = governed.embedQuery("holds the only slot");
    await settle();
    expect(fake.inFlight).toBe(1);
    let outcome: unknown = "pending";
    const query = governed.embedQuery("hello", { budgetMs: 10 }).then(
      () => {
        outcome = "answered";
      },
      (err: unknown) => {
        outcome = err;
      },
    );
    await vi.advanceTimersByTimeAsync(9);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(EmbedderUnavailableError);
    expect(outcome).toMatchObject({ reason: "over-budget" });
    expect(fake.inFlight).toBe(1);
    expect(fake.calls).toBe(1);
    expect(governorOf(governed).snapshot().days.at(-1)?.refusedOverBudget).toBe(1);
    open();
    await busy;
    await query;
  });

  it("never counts a caller's abort against the endpoint: five leave a fresh breaker closed (review finding 5)", async () => {
    const fake = fakeProvider({ embed: (_texts, opts) => untilAborted(opts) });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-query", baseUrl: BASE });
    const governor = governorOf(governed);
    for (let i = 0; i < 5; i++) {
      const caller = new AbortController();
      const pending = governed.embedQuery(`cancelled ${i}`, { signal: caller.signal });
      await settle();
      expect(fake.inFlight).toBe(1);
      caller.abort();
      await expect(pending).rejects.toMatchObject({ reason: "aborted" });
      await settle();
    }
    expect(fake.calls).toBe(5);
    const snapshot = governor.snapshot();
    // CONTROL: before the fix the fifth abort opened this breaker for 1,200 s.
    expect(snapshot.breaker).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      consecutiveTrips: 0,
    });
    expect(snapshot.days.at(-1)).toMatchObject({ calls: 5, aborted: 5, failures: 0 });
    expect(log.warn).not.toHaveBeenCalled();
    // The new counter survives a restart like the others.
    await governor.flush();
    resetGovernors();
    const again = getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE });
    expect(again.snapshot().days.at(-1)).toMatchObject({ aborted: 5 });
  });

  it("leaves the breaker half-open, cool-down unchanged, when the caller cancels its probe; the next call probes (review finding 5)", async () => {
    let mode: "fail" | "hang" | "answer" = "fail";
    const fake = fakeProvider({
      embed: async (texts, opts) => {
        if (mode === "fail") {
          throw new Error("Ollama embeddings HTTP 500: model runner has unexpectedly stopped");
        }
        if (mode === "hang") {
          return untilAborted(opts);
        }
        return texts.map(() => [1, 0]);
      },
    });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-query", baseUrl: BASE });
    const governor = governorOf(governed);
    // A fresh breaker has no clean calls, so it opens at its upper bound, F = 5.
    for (let i = 0; i < 5; i++) {
      await expect(governed.embedQuery("x")).rejects.toThrow(/HTTP 500/);
    }
    const opened = governor.snapshot().breaker;
    expect(opened.state).toBe("open");
    vi.advanceTimersByTime(opened.cooldownMs ?? 0);

    mode = "hang";
    const caller = new AbortController();
    const probe = governed.embedQuery("probe", { signal: caller.signal }).then(
      () => undefined,
      (err: unknown) => err,
    );
    await settle();
    expect(fake.inFlight).toBe(1);
    expect(governor.snapshot().breaker.state).toBe("half-open");
    caller.abort();
    const cancelled = await probe;
    await settle();
    // CONTROL: before the fix the cancelled probe re-opened the breaker and doubled its cool-down.
    expect(governor.snapshot().breaker).toMatchObject({
      state: "half-open",
      consecutiveTrips: opened.consecutiveTrips,
      cooldownMs: opened.cooldownMs,
    });
    expect(cancelled).toMatchObject({ reason: "aborted" });

    mode = "answer";
    const callsBefore = fake.calls;
    await expect(governed.embedQuery("next")).resolves.toEqual([1, 0]);
    expect(fake.calls).toBe(callsBefore + 1);
    expect(governor.snapshot().breaker.state).toBe("closed");
  });

  it("keeps no busy-interval history past the duty window (review finding 7)", async () => {
    const remote = governEmbeddingProvider(
      fakeProvider({ id: "openai", model: "text-embedding-3-small" }),
      { consumer: "memory-query" },
    );
    const local = governEmbeddingProvider(fakeProvider(), {
      consumer: "memory-query",
      baseUrl: BASE,
    });
    expect(governorOf(remote).endpointClass).toBe("remote");
    for (let i = 0; i < 100; i++) {
      await remote.embedQuery(`remote ${i}`);
      await local.embedQuery(`local ${i}`);
      // Past the 60 s window the idle gate measures its own duty over.
      vi.advanceTimersByTime(61_000);
    }
    // A remote endpoint has no idle gate and keeps no history; a local one keeps only the window's.
    expect(busyIntervalCount(governorOf(remote))).toBe(0);
    expect(busyIntervalCount(governorOf(local))).toBe(1);
  });

  it("reports an abort-aware provider's own rejection with the governor's reason and the raw error as cause (review finding 8)", async () => {
    // The provider rejects inside its abort listener, so its promise settles before the governor's.
    const raw: Error[] = [];
    const rejectOnAbort = (opts?: EmbedCallOptions): Promise<never> =>
      new Promise<never>((_, reject) => {
        opts?.signal?.addEventListener(
          "abort",
          () => {
            const err = abortError();
            raw.push(err);
            reject(err);
          },
          { once: true },
        );
      });
    const provider: EmbeddingProvider = {
      id: "ollama",
      model: MODEL,
      embedQuery: (_text, opts) => rejectOnAbort(opts),
      embedBatch: (_texts, opts) => rejectOnAbort(opts),
    };
    const governed = governEmbeddingProvider(provider, { consumer: "memory-query", baseUrl: BASE });

    const timedOut = governed.embedQuery("hello", { budgetMs: 1500 }).then(
      () => undefined,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(1500);
    const deadline = await timedOut;
    expect(deadline).toBeInstanceOf(EmbedderUnavailableError);
    expect(deadline).toMatchObject({ reason: "deadline" });
    expect((deadline as Error).message).toMatch(/^embedding deadline: /);
    expect((deadline as Error).cause).toBe(raw[0]);

    const caller = new AbortController();
    const cancelled = governed.embedQuery("hello", { signal: caller.signal }).then(
      () => undefined,
      (err: unknown) => err,
    );
    await settle();
    caller.abort();
    const aborted = await cancelled;
    expect(aborted).toBeInstanceOf(EmbedderUnavailableError);
    expect(aborted).toMatchObject({ reason: "aborted" });
    expect((aborted as Error).cause).toBe(raw[1]);
  });
});

describe("the breaker", () => {
  it("opens after F failures, fails fast, doubles its cool-down, and closes on a half-open success", async () => {
    let failing = false;
    const fake = fakeProvider({
      embed: async (texts) => {
        if (failing) {
          throw new Error("Ollama embeddings HTTP 500: model runner has unexpectedly stopped");
        }
        return texts.map(() => [1, 0]);
      },
    });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-query", baseUrl: BASE });
    const governor = governorOf(governed);
    for (let i = 0; i < 20; i++) {
      await governed.embedQuery(`clean ${i}`);
    }
    // p = 3/20 by the rule of three over 20 clean calls, N = 20 calls today: F = 2.
    const threshold = governor.snapshot().derived.failureThreshold;
    expect(threshold).toBe(2);

    failing = true;
    for (let i = 0; i < threshold; i++) {
      await expect(governed.embedQuery("x")).rejects.toThrow(/HTTP 500/);
    }
    expect(governor.snapshot().breaker.state).toBe("open");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/^embedder breaker open \(ollama\|/);
    expect(log.info).toHaveBeenCalledTimes(0);
    expect(governor.admit("index")).toEqual({ ok: false, reason: "breaker-open" });

    const callsWhenOpened = fake.calls;
    await expect(governed.embedQuery("x")).rejects.toMatchObject({ reason: "breaker-open" });
    expect(fake.calls).toBe(callsWhenOpened);

    // Cool-down = 2 x the 600 s batch deadline ceiling on the first trip, doubling per trip.
    const firstCooldown = governor.snapshot().breaker.cooldownMs ?? 0;
    expect(firstCooldown).toBe(1_200_000);
    vi.advanceTimersByTime(firstCooldown);
    await expect(governed.embedQuery("probe")).rejects.toMatchObject({ reason: "breaker-open" });
    expect(fake.calls).toBe(callsWhenOpened + 1);
    expect(governor.snapshot().breaker.cooldownMs).toBe(2 * firstCooldown);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(2);

    failing = false;
    vi.advanceTimersByTime(2 * firstCooldown);
    await expect(governed.embedQuery("probe")).resolves.toEqual([1, 0]);
    expect(governor.snapshot().breaker.state).toBe("closed");
    expect(log.info).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("probes a batch with its first input alone when half-open", async () => {
    let failing = true;
    const sizes: number[] = [];
    const fake = fakeProvider({
      embed: async (texts) => {
        sizes.push(texts.length);
        if (failing) {
          throw new Error("Ollama embeddings HTTP 503: busy");
        }
        return texts.map(() => [1, 0]);
      },
    });
    const governed = governEmbeddingProvider(fake, { consumer: "skill-search", baseUrl: BASE });
    const governor = governorOf(governed);
    for (let i = 0; i < 5; i++) {
      await governed.embedBatch(["a", "b", "c"]).catch(() => undefined);
    }
    expect(governor.snapshot().breaker.state).toBe("open");
    failing = false;
    sizes.length = 0;
    vi.advanceTimersByTime(governor.snapshot().breaker.cooldownMs ?? 0);
    await expect(governed.embedBatch(["a", "b", "c"])).resolves.toHaveLength(3);
    expect(sizes).toEqual([1, 2]);
    expect(governor.snapshot().breaker.state).toBe("closed");
  });

  it("never opens a breaker for a remote endpoint", async () => {
    const fake = fakeProvider({
      id: "openai",
      model: "text-embedding-3-small",
      embed: async () => {
        throw new Error("openai embeddings failed: 503 overloaded");
      },
    });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-query" });
    const governor = governorOf(governed);
    expect(governor.endpointClass).toBe("remote");
    for (let i = 0; i < 10; i++) {
      await expect(governed.embedQuery("x")).rejects.toThrow(/503/);
    }
    expect(fake.calls).toBe(10);
    expect(governor.snapshot().breaker.state).toBe("closed");
    expect(governor.admit("index")).toEqual({ ok: true });
    expect(governor.budget("index")).toMatchObject({
      concurrency: 4,
      retries5xx: 3,
      batchDeadlineMs: 120_000,
      source: "ceiling",
    });
  });
});

describe("refusals", () => {
  it("refuses an over-budget foreground call at once, without reaching the provider", async () => {
    writeEmbedderFit(fitRecord());
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const fake = fakeProvider({
      embed: async (texts) => {
        await gate;
        return texts.map(() => [1, 0]);
      },
    });
    const governed = governEmbeddingProvider(fake, { consumer: "memory-query", baseUrl: BASE });
    // About 10,000 tokens in flight: about 30 s of service at the measured 338.2 tokens/s.
    const long = governed.embedQuery("x".repeat(40_000));
    await settle();
    await expect(governed.embedQuery("hello", { budgetMs: 1000 })).rejects.toMatchObject({
      reason: "over-budget",
    });
    expect(fake.calls).toBe(1);
    open();
    await long;
  });

  it("refuses background calls 'busy' under high load and during a fresh fit; foreground is never gated", async () => {
    resetGovernors({ loadavg: () => [12, 12, 12] });
    const loaded = fakeProvider();
    const governed = governEmbeddingProvider(loaded, { consumer: "memory-index", baseUrl: BASE });
    await expect(governed.embedBatch(["a"])).rejects.toMatchObject({ reason: "busy" });
    expect(governorOf(governed).admit("index")).toEqual({ ok: false, reason: "busy" });
    await expect(governed.embedQuery("a")).resolves.toEqual([1, 0]);
    expect(loaded.calls).toBe(1);

    resetGovernors();
    const lock = embedderFitPaths().lock;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const at = new Date(Date.now());
    fs.utimesSync(lock, at, at);
    const locked = governEmbeddingProvider(fakeProvider(), {
      consumer: "memory-index",
      baseUrl: BASE,
    });
    await expect(locked.embedBatch(["a"])).rejects.toMatchObject({ reason: "busy" });
    vi.advanceTimersByTime(11 * 60_000);
    await expect(locked.embedBatch(["a"])).resolves.toEqual([[1, 0]]);
  });
});

describe("admission", () => {
  it("keeps a fit-decided index dormant until real demand reaches Q*; probes never count", () => {
    writeEmbedderFit(fitRecord({ dormantUntilDemand: true, demandBreakEvenPerDay: 10 }));
    const governed = governEmbeddingProvider(fakeProvider(), {
      consumer: "memory-index",
      baseUrl: BASE,
      mode: "fit",
    });
    const governor = governorOf(governed);
    expect(governor.admit("index")).toEqual({ ok: false, reason: "dormant" });
    governor.notePending("memory", 5_000_000);
    expect(governor.admit("index")).toEqual({ ok: false, reason: "dormant" });
    for (let i = 0; i < 50; i++) {
      governor.noteQuery("probe");
      governor.noteQuery("internal");
    }
    expect(governor.admit("index")).toEqual({ ok: false, reason: "dormant" });
    for (let i = 0; i < 10; i++) {
      governor.noteQuery("rpc", 3);
    }
    expect(governor.admit("index")).toEqual({ ok: true });
    expect(governor.admit("query")).toEqual({ ok: true });
    // One line per transition: dormant, then armed.
    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it("arms at once while the backlog takes less than one fit, and sleeps when it grows past it", () => {
    writeEmbedderFit(fitRecord({ dormantUntilDemand: false, demandBreakEvenPerDay: 400 }));
    const governor = governorOf(
      governEmbeddingProvider(fakeProvider(), {
        consumer: "memory-index",
        baseUrl: BASE,
        mode: "fit",
      }),
    );
    // 33,800 tokens at 338.2 tokens/s: 100 s, under the fit's 150 s wall time.
    governor.notePending("memory", 33_800);
    expect(governor.admit("index")).toEqual({ ok: true });
    // 371,800 tokens: about 1,100 s.
    governor.notePending("memory", 338_000);
    expect(governor.admit("index")).toEqual({ ok: false, reason: "dormant" });
  });

  it("never puts a pinned provider to sleep", () => {
    writeEmbedderFit(fitRecord({ dormantUntilDemand: true, demandBreakEvenPerDay: 10 }));
    const governor = governorOf(
      governEmbeddingProvider(fakeProvider(), {
        consumer: "memory-index",
        baseUrl: BASE,
        mode: "pin",
      }),
    );
    governor.notePending("memory", 5_000_000);
    expect(governor.admit("index")).toEqual({ ok: true });
  });

  it("answers 'off' with no decision for the model, and 'sessions-not-decided' for unlisted sessions", () => {
    const governor = governorOf(
      governEmbeddingProvider(fakeProvider(), {
        consumer: "memory-index",
        baseUrl: BASE,
        mode: "fit",
      }),
    );
    expect(governor.admit("index")).toEqual({ ok: false, reason: "off" });
    writeEmbedderFit(fitRecord({ dormantUntilDemand: false }));
    expect(governor.admit("index", "sessions")).toEqual({
      ok: false,
      reason: "sessions-not-decided",
    });
    expect(governor.admit("index", "memory")).toEqual({ ok: true });
  });

  it("steps down after two days that drained less than arrived, and asks for one re-measure", () => {
    const hook = vi.fn();
    setGovernorRemeasureHook(hook);
    const governor = getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE });
    for (let day = 0; day < 2; day++) {
      governor.notePending("memory", 1000);
      governor.noteDrained("memory", 100);
      vi.advanceTimersByTime(DAY_MS);
    }
    expect(governor.admit("index")).toEqual({ ok: false, reason: "stepped-down" });
    expect(governor.admit("query")).toEqual({ ok: true });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toMatchObject({ reason: "step-down", model: MODEL });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("budget", () => {
  it("takes its bounds from a matching fit record, else the ceilings", () => {
    const governor = getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE });
    expect(governor.budget("index")).toMatchObject({
      concurrency: 1,
      batchTokens: 8000,
      batchDeadlineMs: 600_000,
      queryDeadlineMs: 60_000,
      retries5xx: 0,
      source: "ceiling",
    });
    writeEmbedderFit(fitRecord());
    expect(governor.budget("index")).toMatchObject({
      concurrency: 1,
      batchTokens: 1128,
      retries5xx: 0,
      source: "fit-record",
    });
  });
});

// FORK 2026-10-30, Astra review R2 finding #3: a fit record counts only at the endpoint it was
// taken at. The reproduction: a record measured at a remote Ollama gave a machine-local Ollama the
// remote ceiling of 4 requests in flight, because the record's own URL set its concurrency.
describe("the record's endpoint", () => {
  const REMOTE = "https://embed.example.com";
  const OTHER_MODEL = "granite-embedding:278m";

  function recordMeasuredAt(baseUrl: string, parallelGain = false): EmbedderFitRecord {
    const record = fitRecord({ dormantUntilDemand: false });
    record.inventory.ollama.baseUrl = baseUrl;
    if (parallelGain) {
      // 2 in flight beat 1 in flight by 40 tokens/s, beyond 2 sigma (2 x 10).
      record.candidates = record.candidates.map((c) => ({
        ...c,
        parallelGain: { delta: 40, sigma: 10 },
      }));
    }
    return record;
  }

  it("keeps a machine-local endpoint at one request in flight under a record taken elsewhere", async () => {
    writeEmbedderFit(recordMeasuredAt(REMOTE));
    const fake = fakeProvider();
    const governed = governEmbeddingProvider(fake, {
      consumer: "memory-index",
      baseUrl: BASE,
      mode: "fit",
    });
    const governor = governorOf(governed);
    expect(governor.endpointClass).toBe("local-http");
    expect(governor.budget("index")).toMatchObject({
      concurrency: 1,
      batchTokens: 8000,
      source: "ceiling",
    });
    await Promise.all(Array.from({ length: 8 }, (_, i) => governed.embedBatch([`text ${i}`])));
    expect(fake.maxInFlight).toBe(1);
    // No record here, so a fit-decided consumer of this endpoint has no decision either.
    expect(governor.admit("query")).toEqual({ ok: false, reason: "off" });
  });

  it("takes the bounds of a record taken at this endpoint: two in flight on its measured gain", async () => {
    writeEmbedderFit(recordMeasuredAt(BASE, true));
    const fake = fakeProvider();
    const governed = governEmbeddingProvider(fake, {
      consumer: "memory-index",
      baseUrl: BASE,
      mode: "fit",
    });
    const governor = governorOf(governed);
    expect(governor.budget("index")).toMatchObject({
      concurrency: 2,
      batchTokens: 1128,
      source: "fit-record",
    });
    await Promise.all(Array.from({ length: 8 }, (_, i) => governed.embedBatch([`text ${i}`])));
    expect(fake.maxInFlight).toBe(2);
    expect(governor.admit("query")).toEqual({ ok: true });
  });

  it("holds the endpoint's slots at the smallest bound of the models in use", () => {
    writeEmbedderFit(recordMeasuredAt(BASE, true));
    const a = governorOf(
      governEmbeddingProvider(fakeProvider(), { consumer: "memory-index", baseUrl: BASE }),
    );
    expect(a.budget("index").concurrency).toBe(2);
    // The second model measured no gain here, and its calls take the same slots.
    const b = governorOf(
      governEmbeddingProvider(fakeProvider({ model: OTHER_MODEL }), {
        consumer: "memory-index",
        baseUrl: BASE,
      }),
    );
    expect(b.budget("index").concurrency).toBe(1);
    expect(a.budget("index").concurrency).toBe(1);
  });
});

// FORK 2026-10-30, Astra review R2 finding #6, the mode: it belongs to each consumer. Building
// another consumer's wrapper on the same endpoint and model, in either order, leaves the first
// consumer's admission as it was.
describe("each consumer's own mode", () => {
  it("keeps a fit wrapper's answer when a pinned wrapper is built after it", () => {
    const fit = governorOf(
      governEmbeddingProvider(fakeProvider(), {
        consumer: "memory-index",
        baseUrl: BASE,
        mode: "fit",
      }),
    );
    expect(fit.admit("index")).toEqual({ ok: false, reason: "off" });
    const pin = governorOf(
      governEmbeddingProvider(fakeProvider(), { consumer: "skill-search", baseUrl: BASE }),
    );
    expect(pin.endpointKey).toBe(fit.endpointKey);
    expect(fit.admit("index")).toEqual({ ok: false, reason: "off" });
    expect(fit.mode).toBe("fit");
    expect(pin.admit("index")).toEqual({ ok: true });
    expect(pin.mode).toBe("pin");
    // A caller that holds no provider reads the endpoint's reported mode: fit once any consumer is.
    expect(getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE }).mode).toBe(
      "fit",
    );
  });

  it("keeps a pinned wrapper's answer when a fit wrapper is built after it", () => {
    const pin = governorOf(
      governEmbeddingProvider(fakeProvider(), { consumer: "skill-search", baseUrl: BASE }),
    );
    expect(pin.admit("index")).toEqual({ ok: true });
    const fit = governorOf(
      governEmbeddingProvider(fakeProvider(), {
        consumer: "memory-index",
        baseUrl: BASE,
        mode: "fit",
      }),
    );
    expect(pin.admit("index")).toEqual({ ok: true });
    expect(pin.mode).toBe("pin");
    expect(fit.admit("index")).toEqual({ ok: false, reason: "off" });
    expect(fit.mode).toBe("fit");
  });
});

// FORK 2026-10-30, Astra review R2 finding #6, the model: one queue, slot pool and breaker per
// endpoint, and per model on it its own live measurements, backlog and trials.
describe("two models on one endpoint", () => {
  const MODEL_B = "granite-embedding:278m";
  const trial = { missCostMs: 1000, meanQueryMs: 1000, catalogKey: "catalog-1" };

  /** A fake that reports Ollama's counters, so each call is a timed sample: 10 tokens in 50 ms. */
  function measuredProvider(model: string): FakeProvider {
    return fakeProvider({
      model,
      embed: async (texts, opts) => {
        opts?.onMeasure?.({
          inputs: texts.length,
          chars: texts.join("").length,
          promptEvalCount: 10 * texts.length,
          totalDurationNs: 50_000_000,
          wallMs: 50,
        });
        return texts.map(() => [1, 0]);
      },
    });
  }

  it("keeps the first model's measurements, backlog and trials through the second's wrapper and calls", async () => {
    const a = governEmbeddingProvider(measuredProvider(MODEL), {
      consumer: "memory-query",
      baseUrl: BASE,
    });
    const govA = governorOf(a);
    for (let i = 0; i < 20; i++) {
      await a.embedQuery(`a ${i}`);
    }
    govA.notePending("memory", 1000);
    govA.trialState("prefrontal", trial);
    govA.noteTrial("prefrontal", { invoked: true, recovered: 0 });
    expect(govA.budget("query").source).toBe("live");

    const b = governEmbeddingProvider(measuredProvider(MODEL_B), {
      consumer: "memory-query",
      baseUrl: BASE,
    });
    const govB = governorOf(b);
    expect(govB.endpointKey).toBe(govA.endpointKey);
    for (let i = 0; i < 5; i++) {
      await b.embedQuery(`b ${i}`);
    }
    govB.notePending("memory", 7);
    govB.trialState("prefrontal", trial);
    govB.noteTrial("prefrontal", { invoked: true, recovered: 2 });
    // The first model's wrapper keeps calling it, and the sample lands in its own window.
    await a.embedQuery("a again");

    expect(govA.liveQueryWindow().n).toBe(21);
    expect(govA.budget("query").source).toBe("live");
    expect(govA.trialState("prefrontal", trial)).toMatchObject({ invocations: 1, recoveries: 0 });
    expect(govB.liveQueryWindow().n).toBe(5);
    expect(govB.budget("query").source).toBe("ceiling");
    expect(govB.trialState("prefrontal", trial)).toMatchObject({ invocations: 1, recoveries: 2 });
    const models = govA.snapshot().models ?? {};
    expect(models[MODEL]?.sources.memory.pendingTokens).toBe(1000);
    expect(models[MODEL_B]?.sources.memory.pendingTokens).toBe(7);
    // One endpoint: one day account for both models' calls.
    expect(govA.snapshot().days.at(-1)?.calls).toBe(26);
  });

  it("restores each model's own state after a restart, an older snapshot into the model it names", async () => {
    const before = getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE });
    before.notePending("memory", 1000);
    before.trialState("prefrontal", trial);
    before.noteTrial("prefrontal", { invoked: true, recovered: 0 });
    await before.flush();
    // The older shape: the model's state at the top level, and no per-model list.
    const file = path.join(stateDir, "memory", "embedder-governor.json");
    const body = JSON.parse(fs.readFileSync(file, "utf8")) as {
      governors: Record<string, Record<string, unknown>>;
    };
    for (const snapshot of Object.values(body.governors)) {
      delete snapshot.models;
    }
    fs.writeFileSync(file, JSON.stringify(body));

    resetGovernors(); // a gateway restart, where the other model's consumer starts first
    const b = governorOf(
      governEmbeddingProvider(fakeProvider({ model: MODEL_B }), {
        consumer: "skill-search",
        baseUrl: BASE,
      }),
    );
    const a = governorOf(
      governEmbeddingProvider(fakeProvider(), { consumer: "memory-index", baseUrl: BASE }),
    );
    expect(a.trialState("prefrontal", trial)).toMatchObject({ invocations: 1, recoveries: 0 });
    expect(a.snapshot().models?.[MODEL]?.sources.memory.pendingTokens).toBe(1000);
    expect(b.trialState("prefrontal", trial)).toMatchObject({ invocations: 0, recoveries: 0 });

    // The new shape keeps both models through the next restart.
    b.noteTrial("prefrontal", { invoked: true, recovered: 3 });
    await a.flush();
    resetGovernors();
    const b2 = getEmbedGovernor({ providerId: "ollama", model: MODEL_B, baseUrl: BASE });
    const a2 = getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE });
    expect(b2.trialState("prefrontal", trial)).toMatchObject({ invocations: 1, recoveries: 3 });
    expect(a2.trialState("prefrontal", trial)).toMatchObject({ invocations: 1, recoveries: 0 });
  });
});

describe("persistence", () => {
  it("keeps demand and trials across a restart", async () => {
    const governor = getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE });
    governor.noteQuery("rpc");
    governor.noteQuery("rpc");
    governor.noteQuery("agent");
    governor.noteQuery("probe");
    const trial = { missCostMs: 1000, meanQueryMs: 1000, catalogKey: "catalog-1" };
    governor.trialState("prefrontal", trial);
    governor.noteTrial("prefrontal", { invoked: true, recovered: 0 });
    await governor.flush();
    expect(fs.existsSync(path.join(stateDir, "memory", "embedder-governor.json"))).toBe(true);

    resetGovernors(); // a gateway restart: a new store over the same state dir
    const again = getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE });
    const snapshot = again.snapshot();
    expect(snapshot.days.at(-1)).toMatchObject({ agent: 1, rpc: 2, probe: 1 });
    expect(snapshot.derived.demandPerDay).toBe(3);
    expect(again.trialState("prefrontal", trial)).toMatchObject({ invocations: 1, recoveries: 0 });
  });
});

describe("trials", () => {
  it("retires after n zero-recovery invocations and starts over for a new catalog", () => {
    const governor = getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE });
    // n = ceil(3 x t_miss / mean_q) = ceil(3 x 1000 / 1000) = 3
    const p = { missCostMs: 1000, meanQueryMs: 1000, catalogKey: "catalog-1" };
    expect(governor.trialState("prefrontal", p)).toEqual({
      retired: false,
      n: 3,
      invocations: 0,
      recoveries: 0,
    });
    governor.noteTrial("prefrontal", { invoked: true, recovered: 0 });
    governor.noteTrial("prefrontal", { invoked: true, recovered: 0 });
    governor.noteTrial("prefrontal", { invoked: false, recovered: 0 });
    expect(governor.trialState("prefrontal", p).retired).toBe(false);
    governor.noteTrial("prefrontal", { invoked: true, recovered: 0 });
    expect(governor.trialState("prefrontal", p)).toEqual({
      retired: true,
      n: 3,
      invocations: 3,
      recoveries: 0,
    });
    expect(governor.trialState("prefrontal", { ...p, catalogKey: "catalog-2" })).toEqual({
      retired: false,
      n: 3,
      invocations: 0,
      recoveries: 0,
    });
  });

  it("stays armed once the lane recovered something", () => {
    const governor = getEmbedGovernor({ providerId: "ollama", model: MODEL, baseUrl: BASE });
    const p = { missCostMs: 1000, meanQueryMs: 1000, catalogKey: "catalog-1" };
    governor.trialState("prefrontal", p);
    governor.noteTrial("prefrontal", { invoked: true, recovered: 1 });
    for (let i = 0; i < 5; i++) {
      governor.noteTrial("prefrontal", { invoked: true, recovered: 0 });
    }
    expect(governor.trialState("prefrontal", p)).toMatchObject({ retired: false, recoveries: 1 });
  });
});

describe("the endpoint-failure predicate", () => {
  it("counts an HTTP 5xx and a network error as failing; a 4xx, any other error or an abort is not", () => {
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    const wrapped = new Error("batch", { cause: new Error("send", { cause: refused }) });
    const badGateway = Object.assign(new Error("bad gateway"), { status: 502 });
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isEndpointFailure(new Error("Ollama embeddings HTTP 500: stopped"))).toBe(true);
    expect(isEndpointFailure(new Error("openai embeddings failed: 503 overloaded"))).toBe(true);
    expect(isEndpointFailure(badGateway)).toBe(true);
    expect(isEndpointFailure(wrapped)).toBe(true);
    expect(isEndpointFailure(new Error("Ollama embeddings HTTP 404: not found"))).toBe(false);
    expect(isEndpointFailure(new Error("invalid input"))).toBe(false);
    // The governor counts its own aborts through its flags; the memory index adds its own rule
    // for the provider's AbortError (isGovernedAbort in src/memory/manager-embedding-ops.ts).
    expect(isEndpointFailure(abort)).toBe(false);
    expect(httpStatusOf(new Error("openai embeddings failed: 429 slow down"))).toBe(429);
    expect(httpStatusOf(abort)).toBeUndefined();
  });
});

// Design principle #20: tests are sandboxed by construction. Under a test runner, a snapshot read
// with no stateDir while OPENCLAW_STATE_DIR is unset never reaches the host's file. HOME points at
// a temp dir holding a valid snapshot file, so nothing here reads the real home, and the CONTROL
// shows the file sits exactly where the unguarded read would look.
describe("snapshot reads in a sandboxed test", () => {
  const savedHome = process.env.HOME;
  const savedOpenclawHome = process.env.OPENCLAW_HOME;
  const planted = { [`ollama|${BASE}`]: { endpointKey: `ollama|${BASE}`, model: MODEL } };
  let home = "";
  let defaultStateDir = "";

  function restoreEnv(key: "HOME" | "OPENCLAW_HOME", value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "embedder-governor-home-"));
    defaultStateDir = path.join(home, ".openclaw");
    process.env.HOME = home;
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_STATE_DIR;
    const file = path.join(defaultStateDir, "memory", "embedder-governor.json");
    const body = { schemaVersion: 1, savedAt: "2026-10-29T12:00:00.000Z", governors: planted };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv("HOME", savedHome);
    restoreEnv("OPENCLAW_HOME", savedOpenclawHome);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads no snapshot and touches no file when no state dir is given", () => {
    expect(process.env.VITEST).toBeTruthy();
    // CONTROL: the default path an unguarded read would use holds a snapshot file that parses.
    const wouldBe = embedderFitPaths().governor;
    expect(wouldBe).toBe(path.join(defaultStateDir, "memory", "embedder-governor.json"));
    expect(readEmbedGovernorSnapshots(defaultStateDir)).toEqual(planted);

    const touched = [
      vi.spyOn(fs, "existsSync"),
      vi.spyOn(fs, "statSync"),
      vi.spyOn(fs, "readFileSync"),
    ];
    expect(readEmbedGovernorSnapshots()).toEqual({});
    for (const spy of touched) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("reads the snapshot file once OPENCLAW_STATE_DIR names that state dir", () => {
    process.env.OPENCLAW_STATE_DIR = defaultStateDir;
    expect(readEmbedGovernorSnapshots()).toEqual(planted);
  });
});
