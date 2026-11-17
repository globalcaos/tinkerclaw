import { describe, expect, it, vi } from "vitest";

/**
 * After tinkerclaw-forget rewrites files it moves a process-wide epoch
 * (Symbol.for("openclaw.memory.forget-epoch")). total-recall memoises one event store per session
 * and never re-reads its file, so without this it kept serving the forgotten fact until a restart.
 * The store factory is stubbed: the handler never opens the real ~/.openclaw/engram.
 */
const createEventStore = vi.fn(() => ({}) as never);
vi.mock("openclaw/plugin-sdk/memory-engram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/memory-engram")>();
  return {
    ...actual,
    createEventStore: (...args: unknown[]) => createEventStore(...(args as [])),
    recall: vi.fn(async () => ({ events: [], queryCount: 1 })),
  };
});

describe("total-recall after a forget", () => {
  it("re-opens a memoised store once forget has rewritten files", async () => {
    const { handleEngramSearch } = await import("../index.js");
    const search = () =>
      handleEngramSearch({
        params: { query: "phone", sessionKey: "agent:t:forget-epoch" },
        respond: vi.fn(),
      } as never);
    await search();
    await search();
    expect(createEventStore).toHaveBeenCalledTimes(1);
    const g = globalThis as Record<symbol, number | undefined>;
    const key = Symbol.for("openclaw.memory.forget-epoch");
    g[key] = (g[key] ?? 0) + 1; // what an apply that rewrote files does
    await search();
    expect(createEventStore).toHaveBeenCalledTimes(2);
    await search();
    expect(createEventStore).toHaveBeenCalledTimes(2);
  });
});
