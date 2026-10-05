/**
 * FORK 2026-09-03 — the cold-session retrieval pack must not block the gateway loop.
 *
 * `before_prompt_build` used to `await assembleRetrievalPack(...)`, which returns a STRING.
 * Awaiting a non-promise never hands the event loop back, so the gateway froze for the whole
 * build: `pack rebuilt … tookMs=20312 / 22496 / 24516 / 28392`, with no other line
 * interleaved. These tests pin the two claims the fix rests on:
 *
 *   1. `assembleRetrievalPackAsync` yields — a task queued before it runs BEFORE it resolves
 *      — while producing byte-identical output to the synchronous twin. The synchronous twin
 *      is exercised in the same shape as a CONTROL, so the assertion cannot pass vacuously
 *      (it would pass for any async function otherwise).
 *   2. the hook returns within the SAME TICK on a cold session, schedules the rebuild, and
 *      the next turn serves the finished pack — including across a restart, via the pack
 *      persisted to disk.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  assembleRetrievalPack,
  assembleRetrievalPackAsync,
  createEventStore,
} from "openclaw/plugin-sdk/memory-engram";
import { describe, it, expect, beforeEach, vi } from "vitest";

// test/setup.extensions.ts installs an isolated HOME before this module is imported, so this
// is a temp dir — never the architect's real 15MB store.
const ENGRAM_BASE_DIR = join(homedir(), ".openclaw", "engram");

/** Every seeded event carries these words, so the query matches the whole corpus. */
const QUERY = "retrieval pack assembly engram corpus";

function seedStoreFile(sessionKey: string, count: number): void {
  const dir = join(ENGRAM_BASE_DIR, "events");
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const content =
      `turn ${i}: retrieval pack assembly walked the engram corpus and ranked ` +
      `candidate events against the system prompt injection budget`;
    lines.push(
      JSON.stringify({
        id: `evt-${String(i).padStart(6, "0")}`,
        timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        turnId: i,
        sessionKey,
        kind: "user_message",
        content,
        tokens: Math.ceil(content.length / 4),
        metadata: { importance: 5 },
      }),
    );
  }
  writeFileSync(join(dir, `${sessionKey}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
}

async function waitForLog(lines: string[], needle: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lines.some((l) => l.includes(needle))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for a log line containing ${JSON.stringify(needle)}`);
}

// ─── the yielding assembler ─────────────────────────────────────────────────

describe("assembleRetrievalPackAsync", () => {
  const sessionKey = "cold-pack-async";
  let store: ReturnType<typeof createEventStore>;

  beforeEach(() => {
    // 2,000 events is ten default slices, so the chunk boundary is crossed repeatedly and the
    // merge-then-sort path is what produces the result, not the small-corpus shortcut.
    seedStoreFile(sessionKey, 2000);
    store = createEventStore({ baseDir: ENGRAM_BASE_DIR, sessionKey });
  });

  it("lets a task queued before it run BEFORE it resolves", async () => {
    const order: string[] = [];
    const probe = yieldToEventLoop().then(() => {
      order.push("loop");
    });

    const pack = await assembleRetrievalPackAsync(QUERY, store, { maxTokens: 4096 });
    order.push("pack");
    await probe;

    expect(pack).not.toBe("");
    expect(order).toEqual(["loop", "pack"]);
  });

  it("CONTROL: the synchronous twin does not — the queued task waits for the whole build", () => {
    // Without this the test above proves nothing about yielding.
    const order: string[] = [];
    const probe = yieldToEventLoop().then(() => {
      order.push("loop");
    });

    const pack = assembleRetrievalPack(QUERY, store, { maxTokens: 4096 });
    order.push("pack");

    expect(pack).not.toBe("");
    return probe.then(() => {
      expect(order).toEqual(["pack", "loop"]);
    });
  });

  it("produces byte-identical output to the synchronous twin", async () => {
    // The equivalence claim in ftsSearchChunked's header. Near-identical event content makes
    // this a tie-order stress test, which is where a chunked-then-merged sort would diverge.
    const options = { maxTokens: 4096 };
    expect(await assembleRetrievalPackAsync(QUERY, store, options)).toBe(
      assembleRetrievalPack(QUERY, store, options),
    );
  });

  it("agrees with the synchronous twin on an empty store and on a non-matching query", async () => {
    const empty = createEventStore({ baseDir: ENGRAM_BASE_DIR, sessionKey: "cold-pack-empty" });
    await expect(assembleRetrievalPackAsync(QUERY, empty, { maxTokens: 4096 })).resolves.toBe("");
    await expect(
      assembleRetrievalPackAsync("zzz quantum xyzzy", store, { maxTokens: 4096 }),
    ).resolves.toBe(assembleRetrievalPack("zzz quantum xyzzy", store, { maxTokens: 4096 }));
  });
});

// ─── the hook ───────────────────────────────────────────────────────────────

type HookResult = { prependSystemContext?: string } | undefined;
type Hook = (
  payload: { userMessage?: string },
  context: { sessionKey?: string; runId?: string },
) => Promise<HookResult>;

describe("before_prompt_build on a cold session", () => {
  beforeEach(() => {
    vi.resetModules();
    // The isolated HOME survives between runs, and a cold session is only cold if no pack
    // was persisted for it. Without this, the first run of this file passes and every run
    // after it fails -- the plugin correctly serves the pack its predecessor left behind.
    rmSync(join(ENGRAM_BASE_DIR, "packs"), { recursive: true, force: true });
  });

  async function mountHook(): Promise<{ handler: Hook; info: string[]; warn: string[] }> {
    const hooks = new Map<string, Array<(...args: never[]) => unknown>>();
    const info: string[] = [];
    const warn: string[] = [];
    const noop = () => {};
    const api = {
      logger: {
        info: (m: string) => {
          info.push(m);
        },
        warn: (m: string) => {
          warn.push(m);
        },
        error: noop,
        debug: noop,
      },
      pluginConfig: { budgetTokens: 2000 },
      rootDir: ".",
      registerTool: noop,
      registerGatewayMethod: noop,
      registerHook: noop,
      registerHttpRoute: noop,
      registerChannel: noop,
      registerCli: noop,
      registerService: noop,
      registerProvider: noop,
      registerCommand: noop,
      registerContextEngine: noop,
      resolvePath: (p: string) => p,
      on: (event: string, handler: (...args: never[]) => unknown) => {
        const list = hooks.get(event) ?? [];
        list.push(handler);
        hooks.set(event, list);
      },
      config: {},
      id: "tinkerclaw-total-recall",
      name: "Total Recall",
      source: "local" as const,
      runtime: {},
    };

    const mod = await import("./index.js");
    mod.default.register(api as unknown as Parameters<typeof mod.default.register>[0]);
    const handler = hooks.get("before_prompt_build")?.[0] as unknown as Hook;
    expect(handler, "before_prompt_build must be registered").toBeTypeOf("function");
    return { handler, info, warn };
  }

  it("returns within the same tick, schedules the rebuild, and the NEXT turn is warm", async () => {
    const sessionKey = "cold-pack-hook-first";
    seedStoreFile(sessionKey, 300);
    const { handler, info } = await mountHook();

    const order: string[] = [];
    const probe = yieldToEventLoop().then(() => {
      order.push("loop");
    });
    const first = await handler({ userMessage: QUERY }, { sessionKey });
    order.push("hook");
    await probe;

    // THE claim: the hook finished before the event loop turned even once.
    expect(order).toEqual(["hook", "loop"]);
    // Nothing held in memory for this session and nothing on disk, so nothing is injected.
    expect(first).toBeUndefined();
    expect(info.some((m) => m.includes("pack cold-start") && m.includes("rebuild=scheduled"))).toBe(
      true,
    );

    await waitForLog(info, "pack refreshed OFF-PATH");

    const second = await handler({ userMessage: QUERY }, { sessionKey });
    expect(second?.prependSystemContext).toContain("## Retrieved Memory Context");
  });

  it("a restarted gateway serves the persisted pack on its first turn, still within a tick", async () => {
    const sessionKey = "cold-pack-hook-persist";
    seedStoreFile(sessionKey, 300);

    const firstRun = await mountHook();
    await firstRun.handler({ userMessage: QUERY }, { sessionKey });
    await waitForLog(firstRun.info, "pack refreshed OFF-PATH");

    // A fresh module instance IS a restarted gateway: packCache is empty, the disk is not.
    vi.resetModules();
    const secondRun = await mountHook();

    const order: string[] = [];
    const probe = yieldToEventLoop().then(() => {
      order.push("loop");
    });
    const result = await secondRun.handler({ userMessage: QUERY }, { sessionKey });
    order.push("hook");
    await probe;

    expect(order).toEqual(["hook", "loop"]);
    expect(result?.prependSystemContext).toContain("## Retrieved Memory Context");
    expect(secondRun.info.some((m) => m.includes("source=persisted"))).toBe(true);
  });
});
