import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for the `engram.search` gateway RPC respond ARITY.
 *
 * The handler used to call `respond({ results, ... })`, but the gateway's
 * RespondFn is `(ok: boolean, payload?, error?, meta?)`
 * (src/gateway/server-methods/shared-types.ts:33-38). The results object landed
 * in the `ok` slot, `payload` stayed undefined, and the ws layer's res frame
 * (`send({ type: "res", id, ok, payload, error })`,
 * src/gateway/server/ws-connection/message-handler.ts:1531-1537) carried nothing
 * usable -- so every `engram.search` caller hung until its own timeout
 * (measured: 150 s client timeout, while an UNKNOWN method errored instantly).
 *
 * These assertions FAIL against the old single-argument arity: with
 * `respond({ results })`, arg 0 is an object (not `true`) and arg 1 is
 * undefined (no payload).
 */

const recallMock = vi.fn();

// Keep the handler off the real ~/.openclaw/engram store: ENGRAM_BASE_DIR is
// hardcoded to homedir() with no env override, so the store factory and the
// search itself are both stubbed.
// One mock, because there is now one seam: the plugin reaches ENGRAM only
// through openclaw/plugin-sdk/memory-engram. It used to mock two private copies
// under ./src/, which is gone — see canonical-derivations.md.
vi.mock("openclaw/plugin-sdk/memory-engram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/memory-engram")>();
  return {
    ...actual,
    createEventStore: vi.fn(() => ({}) as never),
    recall: (...args: unknown[]) => recallMock(...args),
  };
});

/** One captured `respond(...)` call, positionally, exactly as the gateway sees it. */
type RespondCall = {
  ok: unknown;
  payload: unknown;
  error: unknown;
};

function createRespondSpy() {
  const calls: RespondCall[] = [];
  const respond = vi.fn((ok?: unknown, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  });
  return { respond, calls };
}

async function loadHandler() {
  const mod = await import("../index.js");
  return mod.handleEngramSearch;
}

describe("engram.search respond arity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers with ok===true and the results payload in the PAYLOAD slot", async () => {
    recallMock.mockResolvedValue({
      events: [
        {
          event: {
            id: "evt-1",
            timestamp: "2026-08-02T10:00:00.000Z",
            kind: "user_message",
            content: "the engram search never responded",
            sessionKey: "main",
            // FORK 2026-10-09 — totalTokens is summed over the hits returned, from each event's
            // own `tokens`, no longer copied from recall's packed total.
            tokens: 42,
          },
          score: 0.87654,
        },
      ],
      totalTokens: 42,
      queryCount: 1,
      truncated: false,
    });

    const handleEngramSearch = await loadHandler();
    const { respond, calls } = createRespondSpy();

    await handleEngramSearch({
      params: { query: "engram", sessionKey: "main", limit: 5 },
      respond: respond as never,
    });

    // Exactly one response frame per request id.
    expect(respond).toHaveBeenCalledTimes(1);

    const [call] = calls;
    // ok slot: a literal boolean true, NOT the results object.
    expect(call.ok).toBe(true);
    // payload slot: the actual data. Undefined here is the exact old-arity bug.
    expect(call.payload).toBeDefined();
    const payload = call.payload as { results: unknown[]; totalTokens: number; truncated: boolean };
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toMatchObject({
      id: "evt-1",
      kind: "user_message",
      sessionKey: "main",
      score: 0.877,
    });
    expect(payload.totalTokens).toBe(42);
    expect(payload.truncated).toBe(false);
    expect(call.error).toBeUndefined();
  });

  it("rejects an empty query with ok===false and a protocol ErrorShape", async () => {
    const handleEngramSearch = await loadHandler();
    const { respond, calls } = createRespondSpy();

    await handleEngramSearch({ params: { query: "   " }, respond: respond as never });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(calls[0].ok).toBe(false);
    expect(calls[0].payload).toBeUndefined();
    expect(calls[0].error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("reports a search failure as ok===false instead of hanging", async () => {
    recallMock.mockRejectedValue(new Error("sqlite is on fire"));

    const handleEngramSearch = await loadHandler();
    const { respond, calls } = createRespondSpy();

    await handleEngramSearch({ params: { query: "engram" }, respond: respond as never });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(calls[0].ok).toBe(false);
    expect(calls[0].error).toMatchObject({ code: "UNAVAILABLE" });
    expect((calls[0].error as { message: string }).message).toContain("sqlite is on fire");
  });

  // FORK 2026-10-09 — `limit` no longer becomes a token budget (`limit * 400` emptied the answer
  // whenever the top hit was long); recall is asked for everything it ranks and the answer is cut
  // by COUNT, so the clamp now bounds the number of results, at the 20 recall can select.
  it("clamps limit to the 20 results recall can return", async () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      event: {
        id: `evt-${i}`,
        timestamp: "2026-08-02T10:00:00.000Z",
        kind: "user_message",
        content: `hit ${i}`,
        sessionKey: "agent:main:main",
        tokens: 2,
      },
      score: 1 - i / 100,
    }));
    recallMock.mockResolvedValue({ events, totalTokens: 60, queryCount: 1, truncated: false });

    const handleEngramSearch = await loadHandler();
    const { respond, calls } = createRespondSpy();

    await handleEngramSearch({
      params: { query: "engram", limit: 10_000_000 },
      respond: respond as never,
    });

    expect(calls[0].ok).toBe(true);
    const [opts] = recallMock.mock.calls[0] as [{ maxTokens: number }];
    expect(opts.maxTokens).toBe(Number.POSITIVE_INFINITY);
    const payload = calls[0].payload as {
      results: unknown[];
      totalTokens: number;
      truncated: boolean;
    };
    expect(payload.results).toHaveLength(20);
    expect(payload.totalTokens).toBe(40);
    expect(payload.truncated).toBe(true);
  });

  // FORK 2026-10-09 — with no token budget, the answer stays bounded per result: long content is
  // cut at 4,000 chars and marked, short content passes untouched.
  it("clips a long result's content and marks it, leaving short content alone", async () => {
    const long = "x".repeat(10_000);
    recallMock.mockResolvedValue({
      events: [
        {
          event: {
            id: "big",
            timestamp: "t",
            kind: "user_message",
            content: long,
            sessionKey: "k",
            tokens: 2500,
          },
          score: 0.9,
        },
        {
          event: {
            id: "small",
            timestamp: "t",
            kind: "user_message",
            content: "short",
            sessionKey: "k",
            tokens: 2,
          },
          score: 0.5,
        },
      ],
      totalTokens: 2502,
      queryCount: 1,
      truncated: false,
    });

    const handleEngramSearch = await loadHandler();
    const { respond, calls } = createRespondSpy();
    await handleEngramSearch({ params: { query: "engram", limit: 5 }, respond: respond as never });

    const payload = calls[0].payload as {
      results: Array<{ id: string; content: string; clipped?: boolean }>;
    };
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0].content.length).toBe(4_001);
    expect(payload.results[0].clipped).toBe(true);
    expect(payload.results[1].content).toBe("short");
    expect(payload.results[1].clipped).toBeUndefined();
  });
});
