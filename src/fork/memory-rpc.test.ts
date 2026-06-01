/**
 * FORK — tests for the bi-temporal memory-search RPC (Upgrade 3, J14 read-path).
 *
 * Test target: src/fork/memory-rpc.ts → fork.memory.search. The RPC threads the
 * caller's temporalMode/asOfTime into MemoryIndexManager.search (the bi-temporal
 * predicate is already implemented in manager-search.ts). We stub the manager
 * resolver via the exported test hook so the test asserts the param-threading +
 * response shape without standing up a real embedding backend.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySearchManager, MemorySearchResult } from "../memory/types.js";
import { __setMemoryManagerResolverForTest, forkMemoryHandlers } from "./memory-rpc.js";

afterEach(() => {
  __setMemoryManagerResolverForTest(undefined);
});

type SearchOpts = {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
  temporalMode?: "current" | "valid-at" | "all";
  asOfTime?: number;
};

function stubManager(opts: {
  results?: MemorySearchResult[];
  onSearch?: (query: string, o?: SearchOpts) => void;
}): MemorySearchManager {
  return {
    async search(query: string, o?: SearchOpts) {
      opts.onSearch?.(query, o);
      return opts.results ?? [];
    },
    async readFile() {
      return { text: "", path: "" };
    },
    status() {
      return { provider: "stub", model: "stub-model", fallback: false } as never;
    },
    async probeEmbeddingAvailability() {
      return { available: true } as never;
    },
    async probeVectorAvailability() {
      return true;
    },
  } as MemorySearchManager;
}

/** Drive a handler and capture the respond() args. */
async function call(
  method: keyof typeof forkMemoryHandlers,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
  let captured: { ok: boolean; result?: unknown; error?: unknown } = { ok: false };
  const respond = (ok: boolean, result?: unknown, error?: unknown) => {
    captured = { ok, result, error };
  };
  await forkMemoryHandlers[method]!({
    params,
    respond,
    isWebchatConnect: () => false,
  } as never);
  return captured;
}

describe("fork.memory.search (Upgrade 3 bi-temporal read-path)", () => {
  it("requires a query", async () => {
    __setMemoryManagerResolverForTest(async () => ({ manager: stubManager({}) }));
    const { ok, error } = await call("fork.memory.search", { query: "  " });
    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message ?? error)).toMatch(/query/i);
  });

  it("defaults to 'current' temporal mode when none is given", async () => {
    let seen: SearchOpts | undefined;
    __setMemoryManagerResolverForTest(async () => ({
      manager: stubManager({ onSearch: (_q, o) => (seen = o) }),
    }));
    const { ok } = await call("fork.memory.search", { query: "tax rate" });
    expect(ok).toBe(true);
    expect(seen?.temporalMode).toBe("current");
  });

  it("threads temporalMode='valid-at' + asOfTime into the manager search", async () => {
    let seen: SearchOpts | undefined;
    __setMemoryManagerResolverForTest(async () => ({
      manager: stubManager({ onSearch: (_q, o) => (seen = o) }),
    }));
    const { ok } = await call("fork.memory.search", {
      query: "tax rate",
      temporalMode: "valid-at",
      asOfTime: 1700000000000,
      maxResults: 3,
    });
    expect(ok).toBe(true);
    expect(seen?.temporalMode).toBe("valid-at");
    expect(seen?.asOfTime).toBe(1700000000000);
    expect(seen?.maxResults).toBe(3);
  });

  it("threads temporalMode='all'", async () => {
    let seen: SearchOpts | undefined;
    __setMemoryManagerResolverForTest(async () => ({
      manager: stubManager({ onSearch: (_q, o) => (seen = o) }),
    }));
    await call("fork.memory.search", { query: "x", temporalMode: "all" });
    expect(seen?.temporalMode).toBe("all");
  });

  it("ignores an invalid temporalMode and falls back to 'current'", async () => {
    let seen: SearchOpts | undefined;
    __setMemoryManagerResolverForTest(async () => ({
      manager: stubManager({ onSearch: (_q, o) => (seen = o) }),
    }));
    await call("fork.memory.search", { query: "x", temporalMode: "bogus" });
    expect(seen?.temporalMode).toBe("current");
  });

  it("returns the manager's results", async () => {
    const results: MemorySearchResult[] = [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 4,
        score: 0.9,
        snippet: "the fact",
        source: "memory" as never,
      },
    ];
    __setMemoryManagerResolverForTest(async () => ({ manager: stubManager({ results }) }));
    const { ok, result } = await call("fork.memory.search", { query: "x" });
    expect(ok).toBe(true);
    const r = result as { results: MemorySearchResult[]; temporalMode: string };
    expect(r.results).toHaveLength(1);
    expect(r.results[0].path).toBe("MEMORY.md");
    expect(r.temporalMode).toBe("current");
  });

  it("surfaces a clean UNAVAILABLE error when memory search is unavailable", async () => {
    __setMemoryManagerResolverForTest(async () => ({ error: "memorySearch not configured" }));
    const { ok, error } = await call("fork.memory.search", { query: "x" });
    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message ?? error)).toMatch(/not configured/i);
  });

  it("never throws to the caller when the resolver rejects", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    __setMemoryManagerResolverForTest(async () => {
      throw new Error("boom");
    });
    const { ok, error } = await call("fork.memory.search", { query: "x" });
    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message ?? error)).toMatch(/boom/i);
    spy.mockRestore();
  });
});

describe("fork.engram.consolidate.run (Upgrade 4 cron runner RPC)", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.OPENCLAW_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "engram-consolidate-rpc-"));
    process.env.OPENCLAW_HOME = tmpHome;
  });
  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = prevHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("runs the consolidation job and returns a summary (no events dir → zero sessions)", async () => {
    const baseDir = path.join(tmpHome, "engram");
    const { ok, result } = await call("fork.engram.consolidate.run", { baseDir });
    expect(ok).toBe(true);
    const r = result as { ok: boolean; sessionsProcessed: number; baseDir: string };
    expect(r.ok).toBe(true);
    expect(r.sessionsProcessed).toBe(0);
    expect(r.baseDir).toBe(baseDir);
  });
});
