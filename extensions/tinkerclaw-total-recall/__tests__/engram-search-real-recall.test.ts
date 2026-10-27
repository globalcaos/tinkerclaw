/**
 * FORK 2026-10-09 — `engram.search` and the agent `recall` tool against the REAL `recall`.
 *
 * gateway-respond-arity.test.ts mocks `recall`, so it could not see the bug these pin: both
 * callers asked recall for `limit * 400` tokens, and recall's packer stops at the first ranked hit
 * that does not fit. One long top hit (a pasted log, a whole memory file) emptied the answer: 16,
 * 5 and 3 of 24 real queries came back with nothing at limit 5, 10 and 20.
 *
 * Only the store factory is redirected, to a temp directory, because the plugin roots its stores
 * in the home directory. The search, the ranking and the packing are the library's own.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ baseDir: "", opened: [] as string[] }));

vi.mock("openclaw/plugin-sdk/memory-engram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/memory-engram")>();
  return {
    ...actual,
    createEventStore: (options: Parameters<typeof actual.createEventStore>[0]) => {
      if (!h.baseDir) {
        throw new Error("the temp store directory is not set up yet");
      }
      h.opened.push(options.sessionKey);
      return actual.createEventStore({ ...options, baseDir: h.baseDir });
    },
  };
});

const QUERY = "engram search answers nothing";

/** ~3,000 tokens matching every query term many times over: the top hit, by a wide margin. */
const BIG_HIT = "engram search answers nothing. ".repeat(390).trim();

function seedStore(sessionKey: string, contents: readonly string[]): void {
  const dir = join(h.baseDir, "events");
  mkdirSync(dir, { recursive: true });
  const lines = contents.map((content, i) =>
    JSON.stringify({
      id: `${sessionKey}-${String(i).padStart(4, "0")}`,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      turnId: i,
      sessionKey,
      kind: "user_message",
      content,
      tokens: Math.ceil(content.length / 4),
      metadata: { importance: 5 },
    }),
  );
  writeFileSync(join(dir, `${sessionKey}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
}

/** Short events that match the query once each. */
function smallHits(count: number, tag: string): string[] {
  return Array.from({ length: count }, (_, i) => `${tag} ${i}: the engram search answers nothing`);
}

type SearchPayload = {
  results: Array<{ id: string; content: string; sessionKey: string }>;
  totalTokens: number;
  truncated: boolean;
};

async function search(params: Record<string, unknown>): Promise<{
  ok: unknown;
  payload: SearchPayload;
}> {
  const { handleEngramSearch } = await import("../index.js");
  let ok: unknown;
  let payload: unknown;
  await handleEngramSearch({
    params,
    respond: ((answer: unknown, data?: unknown) => {
      ok = answer;
      payload = data;
    }) as never,
  });
  return { ok, payload: payload as SearchPayload };
}

describe("engram.search with the real recall", () => {
  beforeAll(() => {
    h.baseDir = mkdtempSync(join(tmpdir(), "engram-search-real-"));
    // The old default store, with hits of its own, present from the start: a search that still
    // defaulted to it would answer from it instead of coming back empty, and no test depends on
    // which test happened to open it first.
    seedStore("main", smallHits(2, "old default store"));
  });

  afterAll(() => {
    rmSync(h.baseDir, { recursive: true, force: true });
  });

  it("returns the top `limit` hits when the top hit alone is bigger than the old budget", async () => {
    const sessionKey = "real-recall-big-top-hit";
    const hits = [BIG_HIT, ...smallHits(7, "small hit")];
    seedStore(sessionKey, hits);

    const { ok, payload } = await search({ query: QUERY, sessionKey, limit: 5 });

    expect(ok).toBe(true);
    // The fixture really has the failing shape: the handler used to ask for 5 * 400 tokens, this
    // hit alone is over that, and it ranks first.
    expect(Math.ceil(BIG_HIT.length / 4)).toBeGreaterThan(5 * 400);
    // The big hit arrives first, clipped to 4,000 chars and marked (the answer stays bounded).
    expect(payload.results[0]?.content.startsWith(BIG_HIT.slice(0, 4_000))).toBe(true);
    expect((payload.results[0] as { clipped?: boolean } | undefined)?.clipped).toBe(true);
    expect(payload.results.length).toBe(Math.min(hits.length, 5));
    expect(payload.results.length).toBeGreaterThan(0);
    // recall ranked all eight; the answer is cut by count, and says so.
    expect(payload.truncated).toBe(true);
    expect(payload.totalTokens).toBe(
      payload.results.reduce((sum, r) => sum + Math.ceil(r.content.length / 4), 0),
    );
  });

  it("searches the main chat's store (agent:main:main) when no sessionKey is given", async () => {
    seedStore("agent:main:main", smallHits(3, "main chat"));
    h.opened.length = 0;

    const { ok, payload } = await search({ query: QUERY });

    expect(ok).toBe(true);
    expect(payload.results).toHaveLength(3);
    expect(payload.results.every((r) => r.sessionKey === "agent:main:main")).toBe(true);
    // Not the old "main" default, which names a different, stale store.
    expect(h.opened).toEqual(["agent:main:main"]);
  });

  it('still searches the store the caller names, "main" included', async () => {
    const { payload } = await search({ query: QUERY, sessionKey: "main" });

    expect(payload.results).toHaveLength(2);
    expect(payload.results.every((r) => r.sessionKey === "main")).toBe(true);
  });

  // The agent `recall` tool no longer reads this store: since 2026-10-09 it searches the session
  // transcripts (develop 49c27c73dfb), covered by __tests__/recall-transcripts.test.ts.
});
