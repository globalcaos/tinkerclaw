import { isWarm, ledgerKey } from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it, vi } from "vitest";
import { NOW, OPUS, GROK } from "../../../src/shared/thalamus-v4.test-support.js";
import { createCacheFeed, newLedgerHolder, type AgentEventLike } from "../src/cache-feed.js";

const ev = (data: Record<string, unknown>, over: Partial<AgentEventLike> = {}): AgentEventLike => ({
  runId: "r1",
  stream: "call",
  ts: NOW,
  data,
  ...over,
});

function setup() {
  const holder = newLedgerHolder();
  const ends: unknown[] = [];
  const feed = createCacheFeed({ holder, onCallEnd: (e) => void ends.push(e) });
  feed.noteRun("r1", { conversationKey: "c", modelKey: OPUS });
  return { holder, feed, ends };
}

describe("the cache feed", () => {
  it("warms the model with what a call reports, from counts", () => {
    const { holder, feed } = setup();
    feed.handle(ev({ phase: "usage", input: 10, cacheRead: 0, cacheWrite: 4420 }));
    const e = holder.ledger.get(ledgerKey("c", OPUS))!;
    expect(e.warmTokens).toBe(4420);
    expect(isWarm(e, NOW + 1000)).toBe(true);
  });

  it("takes the final counts of `end` over those of `usage` without double counting", () => {
    const { holder, feed } = setup();
    feed.handle(ev({ phase: "usage", input: 10, cacheRead: 0, cacheWrite: 4000 }));
    feed.handle(
      ev({
        phase: "end",
        input: 10,
        cacheRead: 0,
        cacheWrite: 4420,
        output: 80,
        stopReason: "stop",
      }),
    );
    expect(holder.ledger.get(ledgerKey("c", OPUS))!.warmTokens).toBe(4420);
  });

  it("reports the end of a call once, with its counts and the model it was on", () => {
    const { feed, ends } = setup();
    feed.handle(ev({ phase: "usage", input: 1, cacheRead: 5, cacheWrite: 0 }));
    expect(ends).toHaveLength(0);
    feed.handle(
      ev({
        phase: "end",
        callIndex: 3,
        input: 1,
        cacheRead: 5,
        cacheWrite: 0,
        output: 7,
        stopReason: "stop",
      }),
    );
    expect(ends).toEqual([
      {
        runId: "r1",
        callIndex: 3,
        input: 1,
        cacheRead: 5,
        cacheWrite: 0,
        output: 7,
        stopReason: "stop",
        modelKey: OPUS,
      },
    ]);
  });

  it("ignores a run it was not told about: no guessing which model made a call", () => {
    const { holder, feed } = setup();
    feed.handle(
      ev({ phase: "usage", input: 1, cacheRead: 5, cacheWrite: 0 }, { runId: "unknown-run" }),
    );
    expect(holder.ledger.size).toBe(0);
  });

  it("ignores other streams, other phases, and events with no counts", () => {
    const { holder, feed, ends } = setup();
    feed.handle(ev({ phase: "usage", input: 1, cacheRead: 5 }, { stream: "tool" }));
    feed.handle(ev({ phase: "send" }));
    feed.handle(ev({ phase: "usage" }));
    feed.handle(ev({ phase: "usage", input: "x", cacheRead: -1, cacheWrite: Number.NaN }));
    expect(holder.ledger.size).toBe(0);
    expect(ends).toHaveLength(0);
  });

  it("keeps a separate ledger entry per model, so a switch starts cold", () => {
    const { holder, feed } = setup();
    feed.handle(ev({ phase: "usage", input: 1, cacheRead: 0, cacheWrite: 100 }));
    feed.noteRun("r1", { conversationKey: "c", modelKey: GROK });
    feed.handle(ev({ phase: "usage", input: 50, cacheRead: 0, cacheWrite: 0 }));
    expect(holder.ledger.has(ledgerKey("c", OPUS))).toBe(true);
    expect(holder.ledger.get(ledgerKey("c", GROK))!.warmTokens).toBe(50);
  });

  it("forgets a run and keeps the run table bounded", () => {
    const { feed } = setup();
    feed.forgetRun("r1");
    expect(feed.runCount()).toBe(0);
    for (let i = 0; i < 400; i++) feed.noteRun(`r${i}`, { conversationKey: "c", modelKey: OPUS });
    expect(feed.runCount()).toBeLessThanOrEqual(256);
  });

  it("prunes entries that have been cold for a long time", () => {
    const { holder, feed } = setup();
    feed.handle(ev({ phase: "usage", input: 1, cacheRead: 0, cacheWrite: 100 }));
    feed.prune(NOW + 10 * 3_600_000);
    expect(holder.ledger.size).toBe(0);
  });

  it("does not throw when the end callback does", () => {
    const holder = newLedgerHolder();
    const feed = createCacheFeed({
      holder,
      onCallEnd: vi.fn(() => {
        throw new Error("cb");
      }),
    });
    feed.noteRun("r1", { conversationKey: "c", modelKey: OPUS });
    expect(() =>
      feed.handle(ev({ phase: "end", input: 1, cacheRead: 0, cacheWrite: 1 })),
    ).toThrow();
  });
});
