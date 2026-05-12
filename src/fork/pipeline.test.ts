/**
 * FORK 2026-05-12 — unit tests for the pipeline composition helpers.
 *
 * Test target: src/fork/pipeline.ts
 * Bible anchor: TINKER_UI_DESIGN_BIBLE/unit-tests.md (fork-side test strategy).
 *
 * What this catches: regressions in wrapper composition order, retry
 * counting, timeout enforcement, structured logging shape. None of these
 * are deeply tested today; every existing fork wrapper (idle timeout,
 * heartbeat, etc.) is its own bespoke closure with no shared invariants.
 */

import { describe, expect, it, vi } from "vitest";
import {
  compose,
  mintCorrelationId,
  withCompletionTracking,
  withCorrelationId,
  withRetry,
  withTimeout,
  withTrace,
  type AsyncFn,
  type AsyncWrapper,
  type StructuredLogger,
} from "./pipeline.js";

describe("compose", () => {
  it("calls wrappers outer-first (FIRST argument is outermost)", async () => {
    const calls: string[] = [];
    const wrap =
      (label: string): AsyncWrapper<number, number> =>
      (next) =>
      async (n) => {
        calls.push(`${label}.before`);
        const result = await next(n);
        calls.push(`${label}.after`);
        return result;
      };
    const work: AsyncFn<number, number> = async (n) => {
      calls.push("work");
      return n * 2;
    };
    const wrapped = compose(wrap("A"), wrap("B"), wrap("C"))(work);
    const result = await wrapped(5);
    expect(result).toBe(10);
    expect(calls).toEqual([
      "A.before",
      "B.before",
      "C.before",
      "work",
      "C.after",
      "B.after",
      "A.after",
    ]);
  });

  it("passes through with zero wrappers", async () => {
    const work: AsyncFn<number, number> = async (n) => n + 1;
    const wrapped = compose<number, number>()(work);
    expect(await wrapped(41)).toBe(42);
  });
});

describe("withRetry", () => {
  it("succeeds on first try without retrying", async () => {
    const next = vi.fn<AsyncFn<void, string>>().mockResolvedValue("ok");
    const wrapped = withRetry<void, string>({ attempts: 3 })(next);
    await expect(wrapped()).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("retries on failure up to `attempts` times then throws", async () => {
    const err = new Error("transient");
    const next = vi.fn<AsyncFn<void, string>>().mockRejectedValue(err);
    const wrapped = withRetry<void, string>({ attempts: 3 })(next);
    await expect(wrapped()).rejects.toBe(err);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it("succeeds after one transient failure", async () => {
    const next = vi
      .fn<AsyncFn<void, string>>()
      .mockRejectedValueOnce(new Error("first try"))
      .mockResolvedValue("second try ok");
    const wrapped = withRetry<void, string>({ attempts: 3 })(next);
    await expect(wrapped()).resolves.toBe("second try ok");
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("honours isRetryable: stops retrying on non-retryable error", async () => {
    const fatalErr = new Error("non-retryable");
    const next = vi.fn<AsyncFn<void, string>>().mockRejectedValue(fatalErr);
    const wrapped = withRetry<void, string>({
      attempts: 5,
      isRetryable: (e) => e instanceof Error && e.message.includes("transient"),
    })(next);
    await expect(wrapped()).rejects.toBe(fatalErr);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("supports per-attempt backoff via function", async () => {
    const sleeps: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    // capture sleep durations without actually waiting in the test
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      return realSetTimeout(cb, 0);
    }) as typeof setTimeout);
    const next = vi
      .fn<AsyncFn<void, string>>()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValue("ok");
    const wrapped = withRetry<void, string>({
      attempts: 3,
      backoffMs: (attempt) => attempt * 100,
    })(next);
    await expect(wrapped()).resolves.toBe("ok");
    // two retries → two sleeps with backoff 100ms, 200ms
    expect(sleeps).toEqual([100, 200]);
    vi.restoreAllMocks();
  });

  it("rejects attempts < 1 at construction", () => {
    expect(() => withRetry({ attempts: 0 })).toThrow(/attempts must be >= 1/);
  });
});

describe("withTimeout", () => {
  it("resolves when inner call completes within the window", async () => {
    const next: AsyncFn<void, string> = () => new Promise((r) => setTimeout(() => r("ok"), 5));
    const wrapped = withTimeout<void, string>(100, "fast")(next);
    await expect(wrapped()).resolves.toBe("ok");
  });

  it("rejects when inner call exceeds the window", async () => {
    const next: AsyncFn<void, string> = () => new Promise((r) => setTimeout(() => r("late"), 200));
    const wrapped = withTimeout<void, string>(20, "slow")(next);
    await expect(wrapped()).rejects.toThrow(/slow timed out after 20ms/);
  });

  it("rejects ms <= 0 at construction", () => {
    expect(() => withTimeout<void, void>(0)).toThrow(/ms must be > 0/);
  });
});

describe("withTrace", () => {
  it("logs label.start and label.ok on success", async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      info: (event, fields) => events.push({ event, fields }),
    };
    const next: AsyncFn<number, number> = async (n) => n + 1;
    const wrapped = withTrace<number, number>({ label: "test.op", logger })(next);
    const result = await wrapped(41);
    expect(result).toBe(42);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("test.op.start");
    expect(events[1]?.event).toBe("test.op.ok");
    expect(events[1]?.fields.durationMs).toEqual(expect.any(Number));
  });

  it("logs label.fail on error and re-throws", async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      info: (event, fields) => events.push({ event, fields }),
      warn: (event, fields) => events.push({ event, fields }),
    };
    const next: AsyncFn<void, void> = async () => {
      throw new Error("boom");
    };
    const wrapped = withTrace<void, void>({ label: "test.op", logger })(next);
    await expect(wrapped()).rejects.toThrow("boom");
    expect(events.find((e) => e.event === "test.op.fail")?.fields.errorMessage).toBe("boom");
  });

  it("threads includeInput fields into every log line", async () => {
    const events: Array<Record<string, unknown>> = [];
    const logger: StructuredLogger = {
      info: (event, fields) => events.push({ event, ...fields }),
    };
    const wrapped = withTrace<{ runId: string }, string>({
      label: "turn",
      logger,
      includeInput: (input) => ({ runId: input.runId }),
    })(async () => "ok");
    await wrapped({ runId: "abc123" });
    for (const evt of events) {
      expect(evt.runId).toBe("abc123");
    }
  });
});

describe("mintCorrelationId", () => {
  it("mints distinct IDs across rapid calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) ids.add(mintCorrelationId());
    expect(ids.size).toBe(1000);
  });

  it("honours the prefix argument", () => {
    expect(mintCorrelationId("xyz-")).toMatch(/^xyz-/);
  });
});

describe("withCorrelationId", () => {
  it("mints a fresh ID when input lacks one", async () => {
    let observed: { correlationId: string } | undefined;
    const next: AsyncFn<object, void> = async (input) => {
      observed = input as { correlationId: string };
    };
    const wrapped = withCorrelationId<object, void>()(next);
    await wrapped({ foo: "bar" });
    expect(observed?.correlationId).toMatch(/^t/);
  });

  it("preserves an existing correlationId", async () => {
    let observed: { correlationId: string } | undefined;
    const next: AsyncFn<object, void> = async (input) => {
      observed = input as { correlationId: string };
    };
    const wrapped = withCorrelationId<object, void>()(next);
    await wrapped({ correlationId: "existing-id" });
    expect(observed?.correlationId).toBe("existing-id");
  });

  it("exposes attach() for callers that need the ID before invoking", async () => {
    const wrapper = withCorrelationId<{ foo: string }, void>();
    const attached = wrapper.attach({ foo: "bar" });
    expect(attached.correlationId).toMatch(/^t/);
    expect(attached.foo).toBe("bar");
  });
});

describe("withCompletionTracking", () => {
  it("does not warn when the inner call completes in time", async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      info: (event, fields) => events.push({ event, fields }),
      warn: (event, fields) => events.push({ event, fields }),
    };
    const next: AsyncFn<{ runId: string }, string> = async () => "ok";
    const wrapped = withCompletionTracking<{ runId: string }, string>({
      label: "turn",
      timeoutMs: 100,
      logger,
    })(next);
    await wrapped({ runId: "abc" });
    expect(events.find((e) => e.event === "turn.unfinished")).toBeUndefined();
  });

  it("warns when the inner call hangs past the timeout", async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      info: (event, fields) => events.push({ event, fields }),
      warn: (event, fields) => events.push({ event, fields }),
    };
    // inner hangs for 100ms; tracker fires at 20ms.
    const next: AsyncFn<{ runId: string }, string> = () =>
      new Promise((r) => setTimeout(() => r("late"), 100));
    const wrapped = withCompletionTracking<{ runId: string }, string>({
      label: "turn",
      timeoutMs: 20,
      logger,
      includeInput: (i) => ({ runId: i.runId }),
    })(next);
    const promise = wrapped({ runId: "abc" });
    // Allow the tracker to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(events.find((e) => e.event === "turn.unfinished")?.fields.runId).toBe("abc");
    // Make sure we also unblock the original promise so vitest doesn't dangle
    await promise;
  });

  it("does not abort the inner call — observation only", async () => {
    const logger: StructuredLogger = { info: () => {}, warn: () => {} };
    const next: AsyncFn<void, string> = () =>
      new Promise((r) => setTimeout(() => r("eventually"), 50));
    const wrapped = withCompletionTracking<void, string>({
      label: "op",
      timeoutMs: 10,
      logger,
    })(next);
    await expect(wrapped()).resolves.toBe("eventually");
  });

  it("rejects timeoutMs <= 0 at construction", () => {
    expect(() => withCompletionTracking({ label: "x", timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});

describe("compose + withRetry + withTimeout (real-world chain)", () => {
  it("retries on timeout, succeeds eventually", async () => {
    let attempt = 0;
    const flaky: AsyncFn<void, string> = () =>
      new Promise((resolve) => {
        attempt += 1;
        if (attempt < 3) {
          setTimeout(() => resolve("late"), 50);
        } else {
          resolve("ok");
        }
      });
    const wrapped = compose<void, string>(
      withRetry({ attempts: 5 }),
      withTimeout(20, "flaky"),
    )(flaky);
    await expect(wrapped()).resolves.toBe("ok");
    expect(attempt).toBe(3);
  });
});
