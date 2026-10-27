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
 *
 * FORK 2026-10-09 — moved here from the plugin root, where it was index.cold-pack.test.ts:
 * scaffold.test.ts keeps that root to index.ts alone, and this file was turning it red. Plus a
 * third claim:
 *
 *   3. a brand-new session (no store, no persisted pack) gets the latest shared-bank section on
 *      its first turn, still within the same tick: from memory, and after a restart from the
 *      seed on disk. With no bank, or a seed more than a day old, nothing is served.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** The shared memory bank's store, one for every session (CC_EXPERIENCE_SESSION_KEY in index.ts). */
const BANK_KEY = "cc-experience";
const BANK_HEADING = "## From the Shared Memory Bank";
/** Where the plugin keeps the latest bank section between runs (SHARED_BANK_SEED_PATH). */
const SEED_FILE = join(ENGRAM_BASE_DIR, "packs", "_shared-bank.json");
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Leave a shared-bank seed on disk, as an earlier gateway run would have. */
function writeSeedFile(section: string, builtAtMs: number): void {
  mkdirSync(join(ENGRAM_BASE_DIR, "packs"), { recursive: true });
  writeFileSync(SEED_FILE, JSON.stringify({ section, builtAtMs }), "utf-8");
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

type HookResult = { prependContext?: string; prependSystemContext?: string } | undefined;
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
    // FORK 2026-10-09 — the shared bank too, for the same reason: a bank store an earlier run
    // or test left behind would hand every "new" session in this file a bank section.
    rmSync(join(ENGRAM_BASE_DIR, "events", `${BANK_KEY}.jsonl`), { force: true });
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

    const mod = await import("../index.js");
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
    expect(second?.prependContext).toContain("## Retrieved Memory Context");
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
    expect(result?.prependContext).toContain("## Retrieved Memory Context");
    expect(secondRun.info.some((m) => m.includes("source=persisted"))).toBe(true);
  });

  // FORK 2026-10-09 — 190 of 230 measured empty packs were this turn: the first one of a session
  // with no store and no persisted pack. The bank is the same for every session, so it starts there.
  it("a /compact turn gets no pack: text in front of the command would turn it into prose (Phase 1.5)", async () => {
    const sessionKey = "cold-pack-slash";
    seedStoreFile(sessionKey, 50);
    const { handler, info } = await mountHook();
    expect(
      await handler({ userMessage: "[Sat 2026-10-10 11:32 GMT+2] /compact" }, { sessionKey }),
    ).toBeUndefined();
    expect(info.some((m) => m.includes(`session=${sessionKey} `))).toBe(false);
  });

  it("a brand-new session's first turn carries the shared memory bank, still within a tick", async () => {
    seedStoreFile(BANK_KEY, 50);
    const sessionA = "cold-pack-bank-a";
    const sessionB = "cold-pack-bank-b";
    seedStoreFile(sessionA, 50);
    const { handler, info } = await mountHook();

    // Session A's refresh renders a bank section, and that is what records the seed.
    await handler({ userMessage: QUERY }, { sessionKey: sessionA });
    await waitForLog(info, `pack refreshed OFF-PATH session=${sessionA} `);

    const order: string[] = [];
    const probe = yieldToEventLoop().then(() => {
      order.push("loop");
    });
    const first = await handler({ userMessage: QUERY }, { sessionKey: sessionB });
    // A second turn before the loop turns: B's rebuild has not even started, so this is the
    // warm path serving the placeholder, byte for byte, and its log line says so.
    const second = await handler({ userMessage: QUERY }, { sessionKey: sessionB });
    order.push("hook");
    await probe;

    expect(order).toEqual(["hook", "loop"]);
    expect(first?.prependContext).toContain(BANK_HEADING);
    // FORK 2026-10-10 (Phase 1.5): the pack rides the turn; the system prompt stays as it was.
    expect(first?.prependSystemContext).toBeUndefined();
    // Only the shared section: session A's own conversation is not B's to see.
    expect(first?.prependContext).not.toContain("## Retrieved Memory Context");
    expect(
      info.some(
        (m) =>
          m.includes(`pack cold-start session=${sessionB} `) && m.includes("source=shared-bank"),
      ),
    ).toBe(true);
    expect(second?.prependContext).toBe(first?.prependContext);
    expect(
      info.some(
        (m) => m.includes(`pack served warm session=${sessionB} `) && m.includes(" placeholder"),
      ),
    ).toBe(true);

    // Let B's own rebuild land, so nothing of this test is still running in the next one.
    await waitForLog(info, `pack refreshed OFF-PATH session=${sessionB} `);
  });

  // FORK 2026-10-09 — seen live after deploy: the seed served a new session's first turn (2,773
  // chars), then its rebuild ranked nothing for "hello" and the second turn was served chars=0.
  it("a rebuild that ranks nothing for its query keeps the shared bank section", async () => {
    seedStoreFile(BANK_KEY, 50);
    const sessionA = "cold-pack-bank-keep-a";
    const sessionB = "cold-pack-bank-keep-b";
    seedStoreFile(sessionA, 50);
    const { handler, info } = await mountHook();
    await handler({ userMessage: QUERY }, { sessionKey: sessionA });
    await waitForLog(info, `pack refreshed OFF-PATH session=${sessionA} `);

    // Words nothing in the bank (or B's absent store) contains.
    const NOTHING = "zebra quokka xylophone";
    const first = await handler({ userMessage: NOTHING }, { sessionKey: sessionB });
    expect(first?.prependContext).toContain(BANK_HEADING);
    await waitForLog(info, `pack refreshed OFF-PATH session=${sessionB} `);
    const refreshed = info.find((m) => m.includes(`pack refreshed OFF-PATH session=${sessionB} `));
    expect(refreshed).toContain("source=shared-bank");

    const second = await handler({ userMessage: NOTHING }, { sessionKey: sessionB });
    expect(second?.prependContext).toContain(BANK_HEADING);
  });

  it("after a restart, a brand-new session starts from the seed persisted to disk", async () => {
    seedStoreFile(BANK_KEY, 50);
    const sessionA = "cold-pack-bank-restart-a";
    const sessionC = "cold-pack-bank-restart-c";
    seedStoreFile(sessionA, 50);

    const firstRun = await mountHook();
    await firstRun.handler({ userMessage: QUERY }, { sessionKey: sessionA });
    await waitForLog(firstRun.info, `pack refreshed OFF-PATH session=${sessionA} `);
    expect(existsSync(SEED_FILE)).toBe(true);

    // A fresh module instance IS a restarted gateway: the seed in memory is gone, the file is not.
    vi.resetModules();
    const secondRun = await mountHook();

    const order: string[] = [];
    const probe = yieldToEventLoop().then(() => {
      order.push("loop");
    });
    const result = await secondRun.handler({ userMessage: QUERY }, { sessionKey: sessionC });
    order.push("hook");
    await probe;

    expect(order).toEqual(["hook", "loop"]);
    expect(result?.prependContext).toContain(BANK_HEADING);
    expect(
      secondRun.info.some(
        (m) =>
          m.includes(`pack cold-start session=${sessionC} `) && m.includes("source=shared-bank"),
      ),
    ).toBe(true);

    await waitForLog(secondRun.info, `pack refreshed OFF-PATH session=${sessionC} `);
  });

  it("invents nothing: with no bank store, a seed left on disk is not served", async () => {
    const sessionKey = "cold-pack-bank-none";
    seedStoreFile(sessionKey, 50);
    writeSeedFile(`${BANK_HEADING}\n\nleft behind by a bank that is gone\n`, Date.now());
    const { handler, info } = await mountHook();

    const first = await handler({ userMessage: QUERY }, { sessionKey });

    expect(first).toBeUndefined();
    expect(
      info.some(
        (m) => m.includes(`pack cold-start session=${sessionKey} `) && m.includes("source=empty"),
      ),
    ).toBe(true);
    await waitForLog(info, `pack refreshed OFF-PATH session=${sessionKey} `);
  });

  it("does not serve a seed more than a day old", async () => {
    seedStoreFile(BANK_KEY, 50);
    const sessionKey = "cold-pack-bank-stale";
    writeSeedFile(
      `${BANK_HEADING}\n\nfrom a bank refresh 25 hours ago\n`,
      Date.now() - DAY_MS - 60 * 60 * 1000,
    );
    const { handler, info } = await mountHook();

    const first = await handler({ userMessage: QUERY }, { sessionKey });

    expect(first).toBeUndefined();
    expect(
      info.some(
        (m) => m.includes(`pack cold-start session=${sessionKey} `) && m.includes("source=empty"),
      ),
    ).toBe(true);
    await waitForLog(info, `pack refreshed OFF-PATH session=${sessionKey} `);
  });
});
