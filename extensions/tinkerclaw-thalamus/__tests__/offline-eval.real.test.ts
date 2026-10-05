import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localStepRead,
  localTaskRead,
  type ThalamusBoardLike,
} from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it } from "vitest";
import type { CallRouteCall } from "../../../src/infra/thalamus-call-router.js";
import {
  DIGESTERS,
  digestLoss,
  evaluateCacheLedger,
  syntheticLongResult,
  type CallRow,
} from "../../../src/shared/thalamus-offline-eval.js";
import { routeCall } from "../../../src/shared/thalamus-route-call.js";
import {
  callParams,
  NOW,
  R,
  rung,
  supplies,
} from "../../../src/shared/thalamus-v4.test-support.js";
import { createCacheFeed, newLedgerHolder } from "../src/cache-feed.js";
import { parseConfig } from "../src/config.js";
import { viewContext } from "../src/context-view.js";
import { createRawStore } from "../src/raw-store.js";
import { createRunStates } from "../src/run-state.js";
import { createShadowRouter } from "../src/shadow.js";
import { ThalamusStore } from "../src/store.js";

// THE OFFLINE RUNNER. Skipped unless THALAMUS_OFFLINE_DATA points at a file of call rows (counts and timestamps only, no
// bodies) and THALAMUS_OFFLINE_OUT names where the report goes. It is how the figures in a status file are produced; the
// synthetic tests of the same functions run every time in offline-eval.test.ts.

const DATA = process.env.THALAMUS_OFFLINE_DATA;
const OUT = process.env.THALAMUS_OFFLINE_OUT;

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return {
    n: s.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

function time(n: number, warm: number, fn: (i: number) => void): ReturnType<typeof stats> {
  for (let i = 0; i < warm; i++) fn(i);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn(i);
    out.push(performance.now() - t);
  }
  return stats(out);
}

describe.skipIf(!DATA || !OUT)("offline runner", () => {
  const report: Record<string, unknown> = {};

  it("test 3: the cache ledger against recorded history", () => {
    const rows: CallRow[] = readFileSync(DATA as string, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CallRow);
    const slice = (src: string) => rows.filter((r) => r.src === src);
    const all = evaluateCacheLedger(rows);
    // What the cache does after a long idle gap: a call that finds SOME cache although its own conversation went cold has
    // read a prefix another conversation wrote (the system prompt and tools), which a per-conversation ledger cannot see.
    const cc = slice("cc").sort((a, b) => a.ts - b.ts);
    const lastAt = new Map<string, number>();
    const longGap: CallRow[] = [];
    for (const r of cc) {
      const k = `${r.conv}\u0000${r.model}`;
      const prev = lastAt.get(k);
      if (prev !== undefined && r.ts - prev > 3_600_000) longGap.push(r);
      lastAt.set(k, r.ts);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const warmAfterIdle = longGap.filter((r) => r.cacheRead > 0);
    report.test3 = {
      rows: rows.length,
      idleResume: {
        callsAfterOverAnHourIdle: longGap.length,
        stillReadSomeCache: warmAfterIdle.length,
        medianCacheReadTokens: median(warmAfterIdle.map((r) => r.cacheRead)),
        medianPromptTokens: median(warmAfterIdle.map((r) => r.input + r.cacheRead + r.cacheWrite)),
        medianShareOfPromptRead: median(
          warmAfterIdle.map((r) => r.cacheRead / Math.max(1, r.input + r.cacheRead + r.cacheWrite)),
        ),
      },
      // The bridge's ledger rows are per TURN (counts summed over the turn's API calls); the others are per call.
      ledgerPerCallProviders: evaluateCacheLedger(
        slice("ledger").filter((r) => !r.model.startsWith("claude-code/")),
      ),
      ledgerBridgeTurnSums: evaluateCacheLedger(
        slice("ledger").filter((r) => r.model.startsWith("claude-code/")),
      ),
      ledger: evaluateCacheLedger(slice("ledger")),
      claudeCode: evaluateCacheLedger(slice("cc")),
      both: all,
      claudeCodeFiveMinuteAssumed: evaluateCacheLedger(
        slice("cc").map((r) => ({ ...r, cache5m: null, cache1h: null })),
        { defaultTier: "5m" },
      ),
    };
    expect(all.scored).toBeGreaterThan(0);
  });

  it("test 4: digests on synthetic long results, through the real raw store's recall", () => {
    const dir = mkdtempSync(join(tmpdir(), "thalamus-raw-"));
    const store = new ThalamusStore(":memory:");
    const raw = createRawStore({ dir, store: () => store, now: () => NOW });
    const out: Record<string, unknown> = {};
    for (const at of [0.05, 0.5, 0.95]) {
      const cases = Array.from({ length: 200 }, (_, i) => syntheticLongResult(i + 1, 600, at));
      const viaStore = (text: string): string => {
        const kept = raw.put({
          session: "s",
          tool: "read",
          text,
          tokens: Math.ceil(text.length / 4),
        });
        return kept ? (raw.recall(kept.name) ?? "") : "";
      };
      out[`needleAt${at}`] = {
        headTail30: digestLoss(cases, DIGESTERS.headTail(0.3), viaStore),
        headTail10: digestLoss(cases, DIGESTERS.headTail(0.1), viaStore),
        extractive: digestLoss(cases, DIGESTERS.extractive, viaStore),
      };
    }
    report.test4 = out;
    rmSync(dir, { recursive: true, force: true });
    store.close();
  });

  it("test 7: what the router and the local reads cost per call", () => {
    const rungs = [
      R.opus,
      R.sonnet,
      R.haiku,
      R.grok,
      rung("openai-codex/gpt-5.6-sol", "high", 68, 4),
      rung("openai-codex/gpt-5.6-terra", "medium", 60, 2),
      rung("xai/grok-4.6", "high", 58, 2),
      rung("claude-code/claude-fable-5-1", "max", 82, 10),
    ];
    const params = callParams({ rungs, feedTokens: { thread: 150_000, brief: 4000 } });
    const route = time(3000, 300, () => void routeCall(params));

    const text =
      "Fix the failing unit test in this TypeScript function and refactor the code so it passes";
    const reads = time(3000, 300, (i) => {
      localTaskRead({
        id: `t${i}`,
        ts: NOW,
        sessionKey: "s",
        text,
        trigger: "user",
        private: false,
        floor: 0.6,
      });
      localStepRead({
        id: `s${i}`,
        ts: NOW,
        sessionKey: "s",
        callIndex: i,
        toolName: "exec",
        floor: 0.6,
      });
    });

    const ctx = (n: number) => ({
      systemPrompt: "You are helpful. ".repeat(200),
      messages: Array.from({ length: n }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `${text} ${i}`.repeat(6),
      })),
    });
    const view20 = time(2000, 200, () => void viewContext(ctx(20)));
    const view400 = time(500, 50, () => void viewContext(ctx(400)));

    const board: ThalamusBoardLike = {
      rungs,
      supplies: supplies(),
      contextWindowFor: () => 1_000_000,
      dialIdx: 3,
      builtAtMs: NOW,
    };
    const holder = newLedgerHolder();
    const shadowFor = (messages: number) => {
      const store = new ThalamusStore(":memory:");
      const queue: Array<() => void> = [];
      const shadow = createShadowRouter({
        cfg: () => parseConfig({ mode: "shadow" }),
        board: () => board,
        handPicked: () => false,
        holder,
        feed: createCacheFeed({ holder }),
        store: () => store,
        broadcast: () => {},
        now: () => NOW,
        defer: (fn) => void queue.push(fn),
        runs: createRunStates(),
      });
      const c = ctx(messages);
      return (i: number) => {
        const call: CallRouteCall = {
          model: { id: "m" },
          context: c,
          meta: {
            runId: `run-${i % 50}`,
            sessionKey: `agent:main:tinker:${i % 50}`,
            agentId: "main",
            trigger: "user",
            provider: "claude-code",
            model: "claude-opus-5",
            thinkLevel: "high",
          },
          callIndex: Math.floor(i / 50),
        };
        shadow.router.observe(call);
        if (queue.length > 500) queue.length = 0; // the deferred writes run off the call's path; not timed here
      };
    };
    const shadow20 = time(2000, 200, shadowFor(20));
    const shadow400 = time(500, 50, shadowFor(400));
    report.test7 = {
      unit: "milliseconds per call",
      routeCall8Rungs: route,
      localReadsTaskAndStep: reads,
      viewContext20Messages: view20,
      viewContext400Messages: view400,
      shadowObserve20Messages: shadow20,
      shadowObserve400Messages: shadow400,
    };
    expect(route.p95).toBeLessThan(1000);
  });

  it("writes the report", () => {
    writeFileSync(OUT as string, JSON.stringify(report, null, 1));
    expect(Object.keys(report).sort()).toEqual(["test3", "test4", "test7"]);
  });
});
