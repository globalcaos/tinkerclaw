// FORK 2026-09-25 — context-window-panel.md §6.2 B3: every branch of the THIS SESSION counters
// (context-counters.ts), the cells the renderer paints from them, and the app.ts host.
//
// CONTROLS. `preB3Tally` below is the pre-change app.ts logic, transcribed from the parent commit
// (sessionStatsFor's zero start, the button reply's increment, the A1 `end` consumer's
// increment). The defects this unit ends are asserted on it first (one press counted twice, a 61×
// saving from the engram `end`, "0" painted before anything was read), so each assertion on the
// new path is shown to be one that CAN fail. The app.ts source pins at the bottom fail on the
// parent commit by design.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCachePanelHtml, type CachePanelState } from "./context-cache.js";
import {
  compactionDrop,
  DROP_PAIR_WINDOW_MS,
  EMPTY_COUNTERS,
  readRowCounters,
  reduceCounters,
  rowCountersKey,
  savedTokens,
  sessionCounters,
  type CounterEvent,
  type CountersState,
} from "./context-counters.js";

const fold = (events: CounterEvent[], from: CountersState = EMPTY_COUNTERS): CountersState =>
  events.reduce((s, e) => reduceCounters(s, e), from);

/** An A1 payload as src/infra/compaction-telemetry.ts builds it. */
const a1 = (
  phase: "start" | "end",
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  phase,
  trigger: "manual",
  lane: "embedded",
  provenance: "estimated",
  ...(phase === "end" ? { completed: true } : {}),
  ...over,
});
/** When a press's A1 `end` arrives; its reply lands 50 ms later unless a test says otherwise. */
const T0 = 1_758_760_000_000;
const compaction = (data: unknown, at = T0): CounterEvent => ({ kind: "compaction", data, at });
const calls = (added: number): CounterEvent => ({ kind: "calls", added });
const replyTo = (act: "evict" | "compact", reply: unknown, at = T0 + 50): CounterEvent => ({
  kind: "reply",
  act,
  reply,
  at,
});

// The shapes the live producers send, read off their source rather than invented.
// src/gateway/session-eviction.ts — the EVICT button: tokensDropped is the eviction's own estimate.
const EVICT_END = a1("end", {
  trigger: "evict",
  tokensBefore: 180_213,
  tokensAfter: 92_104,
  tokensDropped: 88_109,
});
const EVICT_REPLY = {
  ok: true,
  compacted: true,
  evictedTokens: 88_109,
  tokensBefore: 180_213,
  tokensAfter: 92_104,
};
// compact.queued.ts on the engram path — the COMPACT button: tokensBefore is the store-wide running
// total sessions.ts measured (7,855,029 on a 175,850-token session), and no tokensDropped. The
// reply carries the engine's own count as evictedTokens.
const COMPACT_END = a1("end", { trigger: "manual", tokensBefore: 7_855_029, tokensAfter: 47_590 });
const COMPACT_REPLY = {
  ok: true,
  compacted: true,
  evictedTokens: 128_260,
  tokensAfter: 47_590,
  result: { tokensBefore: 7_855_029 },
};
// The bridge's A3, from a compact_boundary: the claude CLI's own figures.
const cliEnd = (before: number, after: number) =>
  a1("end", {
    trigger: "cli-internal",
    lane: "cc-bridge",
    provenance: "exact",
    tokensBefore: before,
    tokensAfter: after,
  });

/** CONTROL — the pre-B3 app.ts THIS SESSION logic, transcribed (see the header). */
function preB3Tally() {
  const st = { turns: 0, compactions: 0, evictedTokens: 0 };
  return {
    st,
    reply(r: { compacted?: unknown; evictedTokens?: unknown }) {
      const evictedTokens = typeof r.evictedTokens === "number" ? r.evictedTokens : 0;
      if (r.compacted) {
        st.compactions += 1;
        if (evictedTokens > 0) {
          st.evictedTokens += evictedTokens;
        }
      }
    },
    stream(d: Record<string, unknown>) {
      if (d.phase === "end" && d.completed) {
        st.compactions += 1;
        const before = typeof d.tokensBefore === "number" ? d.tokensBefore : undefined;
        const after = typeof d.tokensAfter === "number" ? d.tokensAfter : undefined;
        if (before !== undefined && after !== undefined && before > after) {
          st.evictedTokens += before - after;
        }
      }
    },
  };
}

/** A panel state with a billed call, so the renderer draws the stat sections at all. */
const panel = (over: Partial<CachePanelState> = {}): CachePanelState => ({
  promptTokens: 1_000,
  maxWindow: 200_000,
  ...over,
});

/** ONE stat cell as painted (not "the first dash anywhere after its key"). */
function cell(html: string, key: string): { title: string; label: string; value: string } | null {
  const m = html.match(
    new RegExp(
      `data-stat="${key}" title="([^"]*)"><span class="cache-stat-k">([^<]*)</span><span class="cache-stat-v">([^<]*)</span>`,
    ),
  );
  return m ? { title: m[1], label: m[2], value: m[3] } : null;
}

const SESSION_KEYS = ["turns", "calls", "compactions", "evictions", "evicted-total", "saved"];

describe("CONTROL — the pre-B3 tally had the defects B3 ends", () => {
  it("one manual COMPACT press counted twice, and its engram `end` booked a 61× saving", () => {
    const t = preB3Tally();
    t.stream(COMPACT_END);
    t.reply(COMPACT_REPLY);
    expect(t.st.compactions).toBe(2);
    expect(t.st.evictedTokens).toBe(7_855_029 - 47_590 + 128_260);
  });

  it("one EVICT press counted twice too", () => {
    const t = preB3Tally();
    t.stream(EVICT_END);
    t.reply(EVICT_REPLY);
    expect(t.st.compactions).toBe(2);
    expect(t.st.evictedTokens).toBe(2 * 88_109);
  });

  it("painted 0 compactions before anything had been read", () => {
    const html = renderCachePanelHtml(panel({ sessionStats: preB3Tally().st }));
    expect(cell(html, "compactions")?.value).toBe("0");
    expect(cell(html, "turns")?.value).toBe("0");
  });
});

describe("readRowCounters — A7's fields, absent not zero (P10)", () => {
  it("reads the five fields a row carries, the ledger's count apart from the entry's", () => {
    expect(
      readRowCounters({
        key: "agent:main:tinker:abc",
        compactions: 4,
        compactionCount: 3,
        evictions: 1,
        droppedTokens: 186_900,
        lastCompactionAt: 1_758_700_000_000,
      }),
    ).toEqual({
      compactions: 4,
      compactionCount: 3,
      evictions: 1,
      droppedTokens: 186_900,
      lastCompactionAt: 1_758_700_000_000,
    });
  });

  it("keeps a measured 0 and drops everything that is not a finite count", () => {
    expect(
      readRowCounters({
        compactionCount: 0,
        evictions: -1,
        droppedTokens: Number.NaN,
        lastCompactionAt: "1758700000000",
      }),
    ).toEqual({ compactionCount: 0 });
    expect(readRowCounters({ evictions: Number.POSITIVE_INFINITY })).toEqual({});
  });

  it("a row without A7 (an older gateway), no row, or a non-object is nothing known", () => {
    for (const row of [{ key: "k", totalTokens: 5 }, undefined, null, "row", 42]) {
      expect(readRowCounters(row)).toEqual({});
    }
  });
});

describe("rowCountersKey", () => {
  it("tells unknown from 0, and moves with every field", () => {
    expect(rowCountersKey({})).not.toBe(rowCountersKey({ compactionCount: 0 }));
    expect(rowCountersKey({ compactionCount: 1 })).not.toBe(rowCountersKey({ compactionCount: 2 }));
    expect(rowCountersKey({ evictions: 1 })).not.toBe(rowCountersKey({ droppedTokens: 1 }));
    // The LEDGER count is what the panel paints, and it moves on its own: a compaction whose `end`
    // carried no measured drop moves it and nothing else. Before it joined ROW_COUNTER_FIELDS both
    // of these read "-|-|-|-", so the host never repainted and the stale number stayed on screen.
    expect(rowCountersKey({ compactions: 1 })).not.toBe(rowCountersKey({ compactions: 2 }));
    expect(rowCountersKey({ compactions: 1 })).not.toBe(rowCountersKey({ compactionCount: 1 }));
    expect(rowCountersKey({ lastCompactionAt: 5 })).not.toBe(rowCountersKey({}));
    expect(rowCountersKey(readRowCounters({ compactionCount: 1, other: 9 }))).toBe(
      rowCountersKey({ compactionCount: 1 }),
    );
  });
});

describe("compactionDrop — what one A1 payload dropped (rule 4)", () => {
  it("a start is not a result", () => {
    expect(compactionDrop(a1("start", { tokensBefore: 500 }))).toBeNull();
  });

  it("an `end` with completed:false dropped nothing (A3's failed status line, pi's retry)", () => {
    expect(
      compactionDrop(a1("end", { trigger: "cli-internal", provenance: "exact", completed: false })),
    ).toBeNull();
    expect(compactionDrop(a1("end", { completed: false, tokensDropped: 5_000 }))).toBeNull();
  });

  it("an `end` whose completed is missing or merely truthy is not a completed compaction", () => {
    expect(compactionDrop({ phase: "end", tokensDropped: 5_000 })).toBeNull();
    expect(compactionDrop(a1("end", { completed: 1, tokensDropped: 5_000 }))).toBeNull();
    expect(compactionDrop(a1("end", { completed: "true", tokensDropped: 5_000 }))).toBeNull();
  });

  it("anything that is not the contract drops nothing", () => {
    for (const data of [undefined, null, "end", 7, {}, { phase: "compacting" }]) {
      expect(compactionDrop(data)).toBeNull();
    }
  });

  it("an `end` with no `start` before it still counts: nothing here reads the start", () => {
    expect(compactionDrop(cliEnd(971_000, 12_400))).toEqual({
      trigger: "cli-internal",
      provenance: "exact",
      tokens: 958_600,
    });
  });

  it("tokensDropped wins whenever the executor measured it (EVICT)", () => {
    expect(compactionDrop(EVICT_END)).toEqual({
      trigger: "evict",
      provenance: "estimated",
      tokens: 88_109,
    });
    // Even over an exact pair: a figure the executor measured itself is never re-derived.
    expect(compactionDrop({ ...cliEnd(900, 100), tokensDropped: 7 })?.tokens).toBe(7);
  });

  it("NEVER subtracts estimated parts: the engram COMPACT `end` is a 61× lie", () => {
    expect(compactionDrop(COMPACT_END)).toEqual({ trigger: "manual", provenance: "estimated" });
    // pi-auto's parts are estimates too, on a chars/4 ladder (P11).
    expect(
      compactionDrop(a1("end", { trigger: "pi-auto", tokensBefore: 180_000, tokensAfter: 40_000 }))
        ?.tokens,
    ).toBeUndefined();
  });

  it("an exact pair that grew, or lacks a part, is unknown; an exact equal pair is a real 0", () => {
    expect(compactionDrop(cliEnd(100, 200))?.tokens).toBeUndefined();
    expect(compactionDrop({ ...cliEnd(100, 50), tokensAfter: undefined })?.tokens).toBeUndefined();
    expect(compactionDrop(cliEnd(40, 40))?.tokens).toBe(0);
  });

  it("a missing provenance claims the weaker; the trigger is trimmed, a blank one dropped", () => {
    const d = compactionDrop({
      phase: "end",
      completed: true,
      trigger: "  overflow ",
      tokensDropped: 3,
    });
    expect(d).toEqual({ trigger: "overflow", provenance: "estimated", tokens: 3 });
    expect(compactionDrop(a1("end", { trigger: "   " }))?.trigger).toBeUndefined();
  });
});

describe("reduceCounters — one drop per press, sized once, counted by nobody here (rules 3, 4)", () => {
  const drops = (s: CountersState) => ({
    dropsWatched: s.dropsWatched,
    droppedWatched: s.droppedWatched,
    lastDropped: s.lastDropped,
    lastDroppedProvenance: s.lastDroppedProvenance,
  });

  it("COMPACT, `end` first: the unsized `end` waits and the reply sizes it — ONE drop", () => {
    const s = fold([compaction(COMPACT_END), replyTo("compact", COMPACT_REPLY)]);
    expect(drops(s)).toEqual({
      dropsWatched: 1,
      droppedWatched: 128_260,
      lastDropped: 128_260,
      lastDroppedProvenance: "estimated",
    });
    expect(s.pending).toBeUndefined();
  });

  it("COMPACT, reply first: the same one drop, and the late `end` adds nothing", () => {
    const replyFirst = fold([replyTo("compact", COMPACT_REPLY), compaction(COMPACT_END)]);
    expect(replyFirst).toEqual(fold([compaction(COMPACT_END), replyTo("compact", COMPACT_REPLY)]));
  });

  it("EVICT, either order: the `end`'s tokensDropped sizes it once, the reply adds nothing", () => {
    const endFirst = fold([compaction(EVICT_END), replyTo("evict", EVICT_REPLY)]);
    const replyFirst = fold([replyTo("evict", EVICT_REPLY), compaction(EVICT_END)]);
    expect(drops(endFirst)).toEqual({
      dropsWatched: 1,
      droppedWatched: 88_109,
      lastDropped: 88_109,
      lastDroppedProvenance: "estimated",
    });
    expect(replyFirst).toEqual(endFirst);
  });

  it("the claude CLI's own compaction: exact, and no reply is waited for", () => {
    const s = fold([compaction(cliEnd(971_000, 12_400))]);
    expect(drops(s)).toEqual({
      dropsWatched: 1,
      droppedWatched: 958_600,
      lastDropped: 958_600,
      lastDroppedProvenance: "exact",
    });
    expect(s.pending).toBeUndefined();
  });

  it("an unsized automatic `end` blanks THIS CALL's `evicted` rather than keep the last one", () => {
    const before = fold([compaction(cliEnd(500, 100))]);
    const s = reduceCounters(
      before,
      compaction(a1("end", { trigger: "overflow", tokensBefore: 90_000, tokensAfter: 30_000 })),
    );
    expect(s.lastDropped).toBeUndefined();
    expect(s.lastDroppedProvenance).toBeUndefined();
    expect(s.dropsWatched).toBe(1);
    expect(s.pending).toBeUndefined();
  });

  it("two presses are two drops", () => {
    const s = fold([
      compaction(EVICT_END),
      replyTo("evict", EVICT_REPLY),
      compaction(COMPACT_END),
      replyTo("compact", COMPACT_REPLY),
    ]);
    expect(s.dropsWatched).toBe(2);
    expect(s.droppedWatched).toBe(88_109 + 128_260);
  });

  it("an EVICT and a COMPACT in flight together each pair with their own half", () => {
    const s = fold([
      compaction(COMPACT_END, T0),
      replyTo("evict", EVICT_REPLY, T0 + 10),
      compaction(EVICT_END, T0 + 20),
      replyTo("compact", COMPACT_REPLY, T0 + 30),
    ]);
    expect(s.dropsWatched).toBe(2);
    expect(s.droppedWatched).toBe(88_109 + 128_260);
    expect(s.pending).toBeUndefined();
  });

  it("a model call between the halves does not split a press: EVICT is still ONE drop", () => {
    // A press may interrupt a busy run (the confirm path), whose last call can land between the
    // halves; EVICT sizes BOTH of them, so an unpaired reply would count the eviction twice.
    const s = fold([compaction(EVICT_END, T0), calls(1), replyTo("evict", EVICT_REPLY, T0 + 800)]);
    expect(s.dropsWatched).toBe(1);
    expect(s.droppedWatched).toBe(88_109);
    expect(s.pending).toBeUndefined();
  });

  it("a stale half cannot swallow a later press (DROP_PAIR_WINDOW_MS)", () => {
    // A runner compaction that fell through to "manual" WITH a size, an hour before the press.
    const later = T0 + 3_600_000;
    const s = fold([
      compaction(a1("end", { trigger: "manual", tokensDropped: 5_000 }), T0),
      replyTo("compact", COMPACT_REPLY, later),
      compaction(COMPACT_END, later + 20),
    ]);
    expect(s.dropsWatched).toBe(2);
    expect(s.droppedWatched).toBe(5_000 + 128_260);
    expect(s.lastDropped).toBe(128_260);
    expect(s.pending).toBeUndefined();
  });

  it("the pairing window is inclusive at its edge; past it the reply still sizes once", () => {
    const edge = fold([
      compaction(COMPACT_END, T0),
      replyTo("compact", COMPACT_REPLY, T0 + DROP_PAIR_WINDOW_MS),
    ]);
    expect(edge.pending).toBeUndefined();
    expect(edge.dropsWatched).toBe(1);
    const past = fold([
      compaction(COMPACT_END, T0),
      replyTo("compact", COMPACT_REPLY, T0 + DROP_PAIR_WINDOW_MS + 1),
    ]);
    expect(past.pending?.manual?.half).toBe("reply");
    expect(past.dropsWatched).toBe(1);
    expect(past.droppedWatched).toBe(128_260);
  });

  it("without a usable arrival time the button alone pairs the halves (never a double count)", () => {
    const s = fold([
      compaction(EVICT_END, Number.NaN),
      replyTo("evict", EVICT_REPLY, Number.POSITIVE_INFINITY),
    ]);
    expect(s.dropsWatched).toBe(1);
    expect(s.pending).toBeUndefined();
  });

  it("a reply that did not compact is not half of a drop: the same object comes back", () => {
    const s = fold([compaction(COMPACT_END)]);
    for (const r of [
      { ok: false, compacted: false, reason: "the lane owns its context" },
      { ok: true, compacted: false, reason: "too few messages to evict" },
      { ok: true },
      { ok: false, compacted: true, evictedTokens: 5 },
      null,
      undefined,
    ]) {
      expect(reduceCounters(s, replyTo("compact", r))).toBe(s);
    }
  });

  it("a measured zero drop: THIS CALL says 0, and it is not a watched drop", () => {
    const s = fold([compaction(cliEnd(40_000, 40_000))]);
    expect(s.lastDropped).toBe(0);
    expect(s.lastDroppedProvenance).toBe("exact");
    expect(s.dropsWatched).toBe(0);
    expect(s.droppedWatched).toBe(0);
  });

  it("events that change nothing return the same object", () => {
    for (const e of [
      calls(0),
      calls(-3),
      calls(Number.NaN),
      compaction(a1("start", { tokensBefore: 1 })),
      compaction(a1("end", { completed: false })),
      compaction(null),
    ]) {
      expect(reduceCounters(EMPTY_COUNTERS, e)).toBe(EMPTY_COUNTERS);
    }
  });

  it("calls: only whole, positive growth counts", () => {
    expect(fold([calls(2.9), calls(1)]).liveCalls).toBe(3);
  });

  it("history: read once, calls summed, the row-limit floor sticky", () => {
    const s = fold([
      { kind: "history", calls: 40, truncated: true },
      { kind: "history", calls: 2, truncated: false },
    ]);
    expect(s).toMatchObject({ historyRead: true, historyCalls: 42, historyTruncated: true });
    expect(s.liveCalls).toBe(0);
    const read = fold([{ kind: "history", calls: 0, truncated: false }]);
    expect(read.historyRead).toBe(true);
    expect(reduceCounters(read, { kind: "history", calls: 0, truncated: false })).toBe(read);
  });

  it("EMPTY_COUNTERS is frozen: the reducer never mutates a state", () => {
    expect(Object.isFrozen(EMPTY_COUNTERS)).toBe(true);
    fold([compaction(EVICT_END), calls(3), replyTo("evict", EVICT_REPLY)]);
    expect(EMPTY_COUNTERS.dropsWatched).toBe(0);
  });
});

describe("savedTokens — each drop × the model calls made since it (F4)", () => {
  it("integrates per drop, never over the calls before it", () => {
    const s = fold([
      calls(2),
      compaction(cliEnd(100_000, 0)), // 100k at call 2
      calls(3),
      compaction(a1("end", { trigger: "evict", tokensDropped: 50_000 })), // 50k at call 5
      calls(2),
    ]);
    // 100k × (7 − 2) + 50k × (7 − 5)
    expect(savedTokens(s)).toBe(600_000);
    // CONTROL: the pre-B3 cell was the dropped total × ALL turns, the ones before each drop too.
    expect(s.droppedWatched * s.liveCalls).toBe(1_050_000);
  });

  it("is 0 until a call follows the drop, and a press's drop integrates like any other", () => {
    const s = fold([compaction(COMPACT_END), replyTo("compact", COMPACT_REPLY)]);
    expect(savedTokens(s)).toBe(0);
    expect(savedTokens(reduceCounters(s, calls(2)))).toBe(256_520);
  });
});

describe("sessionCounters — the projection", () => {
  const twoPresses = fold([
    compaction(EVICT_END),
    replyTo("evict", EVICT_REPLY),
    compaction(COMPACT_END),
    replyTo("compact", COMPACT_REPLY),
  ]);

  it("the counts are the row's and nothing else's (rules 1 and 3)", () => {
    expect(sessionCounters({ state: twoPresses })).toMatchObject({
      compactions: undefined,
      evictions: undefined,
      evictedTokens: undefined,
    });
    expect(
      sessionCounters({
        row: { compactions: 4, evictions: 1, droppedTokens: 216_369, lastCompactionAt: 9 },
        state: twoPresses,
      }),
    ).toMatchObject({
      compactions: 4,
      compactionsLifetime: false,
      evictions: 1,
      evictedTokens: 216_369,
      lastCompactionAt: 9,
    });
  });

  it("`compactions` is the LEDGER's count, never the entry's lifetime counter (A7)", () => {
    // Two different quantities. `compactionCount` is the session entry's own counter, which only
    // gateway-side executors bump, so the claude CLI's own compactions (trigger "cli-internal") and
    // the EVICT button never reach it; the ledger counts every executor except EVICT.
    expect(
      sessionCounters({ row: { compactions: 7, compactionCount: 2, evictions: 3 } }),
    ).toMatchObject({ compactions: 7, compactionsLifetime: false });
    // CONTROL: `compactions: row.compactionCount` — what this projection did until 2026-09-25 —
    // paints 2 for that row, so the five compactions the ledger counted never reached the panel.
    expect(readRowCounters({ compactions: 7, compactionCount: 2 }).compactionCount).toBe(2);
    // A seeded ledger's measured 0 is a real 0, and it still wins over a non-zero entry counter.
    expect(
      sessionCounters({ row: { compactions: 0, compactionCount: 5, evictions: 0 } }),
    ).toMatchObject({ compactions: 0, compactionsLifetime: false });
  });

  it("falls back to the lifetime counter only for a row with no ledger, and flags it", () => {
    // The reachable case is NOT an old gateway: `compactionCount` and the four ledger fields landed
    // on the row in the SAME A7 commit, so a gateway without the ledger has no compactionCount to
    // fall back to either. It is the PRE-SEED window — the first sessions.list after a gateway
    // start builds its rows before the ledger is seeded for the session.
    expect(sessionCounters({ row: { compactionCount: 2 } })).toMatchObject({
      compactions: 2,
      compactionsLifetime: true,
    });
    // Neither count: unknown, never a fabricated 0 (P10), and nothing to flag.
    expect(sessionCounters({ row: { evictions: 1 } })).toMatchObject({
      compactions: undefined,
      compactionsLifetime: false,
    });
  });

  it("absent is not zero: with nothing known, nothing is claimed (P10)", () => {
    expect(sessionCounters({})).toEqual({
      turns: undefined,
      turnsAtLeast: false,
      calls: undefined,
      callsAtLeast: false,
      compactions: undefined,
      compactionsLifetime: false,
      evictions: undefined,
      evictedTokens: undefined,
      saved: undefined,
      lastCompactionAt: undefined,
    });
  });

  it("turns and calls: the store's 0 is 'not loaded' until the history was read", () => {
    const empty = { turns: 0, calls: 0 };
    expect(sessionCounters({ totals: empty })).toMatchObject({
      turns: undefined,
      calls: undefined,
    });
    const read = fold([{ kind: "history", calls: 0, truncated: false }]);
    expect(sessionCounters({ state: read, totals: empty })).toMatchObject({
      turns: 0,
      turnsAtLeast: false,
      calls: 0,
      callsAtLeast: false,
    });
  });

  it("turns and calls are floors while the history is unread, cut, or drawn one call per turn", () => {
    expect(sessionCounters({ totals: { turns: 3, calls: 5 } })).toMatchObject({
      turns: 3,
      turnsAtLeast: true,
      calls: 5,
      callsAtLeast: true,
    });
    const cut = fold([{ kind: "history", calls: 40, truncated: true }]);
    expect(sessionCounters({ state: cut, totals: { turns: 41, calls: 44 } })).toMatchObject({
      turnsAtLeast: true,
      callsAtLeast: true,
    });
    const whole = fold([{ kind: "history", calls: 0, truncated: false }, calls(4)]);
    expect(sessionCounters({ state: whole, totals: { turns: 1, calls: 4 } })).toMatchObject({
      turns: 1,
      turnsAtLeast: false,
      calls: 4,
      callsAtLeast: false,
    });
  });

  it("totals that are not counts are unknown", () => {
    expect(sessionCounters({ totals: { turns: Number.NaN, calls: 2 } }).turns).toBeUndefined();
    expect(sessionCounters({ totals: { turns: 2, calls: -1 } }).calls).toBeUndefined();
  });

  it("saved: the per-drop integral, a real 0 when the row says nothing was ever dropped", () => {
    expect(sessionCounters({ row: { droppedTokens: 88_000 } }).saved).toBeUndefined();
    expect(sessionCounters({ row: { droppedTokens: 0 } }).saved).toBe(0);
    const s = reduceCounters(twoPresses, calls(3));
    expect(sessionCounters({ state: s }).saved).toBe(savedTokens(s));
    expect(sessionCounters({ state: s }).saved).toBe((88_109 + 128_260) * 3);
  });
});

describe("painted by renderCachePanelHtml (context-cache.ts)", () => {
  it("nothing known paints a dash in every THIS SESSION cell, never a 0 (CONTROL above)", () => {
    const html = renderCachePanelHtml(panel({ sessionStats: sessionCounters({}) }));
    for (const key of SESSION_KEYS) {
      expect(cell(html, key)?.value, key).toBe("—");
    }
  });

  it("the cells, in order: turns, calls, compactions, evictions, dropped, saved", () => {
    const html = renderCachePanelHtml(panel({ sessionStats: sessionCounters({}) }));
    const at = SESSION_KEYS.map((k) => html.indexOf(`data-stat="${k}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    for (let i = 1; i < at.length; i++) {
      expect(at[i], SESSION_KEYS[i]).toBeGreaterThan(at[i - 1]);
    }
    expect(cell(html, "evicted-total")?.label).toBe("dropped");
  });

  it("a floor is painted with ≥, and the dash never is", () => {
    const html = renderCachePanelHtml(
      panel({ sessionStats: sessionCounters({ totals: { turns: 12, calls: 30 } }) }),
    );
    expect(cell(html, "turns")?.value).toBe("≥12");
    expect(cell(html, "calls")?.value).toBe("≥30");
    const dash = renderCachePanelHtml(
      panel({ sessionStats: { turnsAtLeast: true, callsAtLeast: true } }),
    );
    expect(cell(dash, "turns")?.value).toBe("—");
    expect(cell(dash, "calls")?.value).toBe("—");
  });

  it("the row's counts paint as plain counts, the dropped total on the token ladder", () => {
    const html = renderCachePanelHtml(
      panel({
        sessionStats: sessionCounters({
          row: { compactions: 1200, evictions: 0, droppedTokens: 216_369 },
        }),
      }),
    );
    expect(cell(html, "compactions")?.value).toBe("1200");
    expect(cell(html, "evictions")?.value).toBe("0");
    expect(cell(html, "evicted-total")?.value).toBe("216.4k");
  });

  it("saved is the per-drop integral, never the dropped × turns product (F4)", () => {
    const html = renderCachePanelHtml(
      panel({
        sessionStats: sessionCounters({
          row: { droppedTokens: 100_000 },
          state: fold([{ kind: "history", calls: 0, truncated: false }]),
          totals: { turns: 4, calls: 4 },
        }),
      }),
    );
    // The pre-B3 cell painted 400.0k here: 100k × 4 turns, for drops this page never saw.
    expect(cell(html, "saved")?.value).toBe("—");
    expect(cell(html, "saved")?.title).toContain("over the drops this page has watched");
  });

  it("the compactions tooltip names the last one, in UTC", () => {
    const html = renderCachePanelHtml(
      panel({
        sessionStats: sessionCounters({
          row: { compactions: 2, evictions: 0, lastCompactionAt: Date.UTC(2026, 8, 24, 21, 5) },
        }),
      }),
    );
    expect(cell(html, "compactions")?.title).toContain("2026-09-24 21:05 UTC");
    const none = renderCachePanelHtml(panel({ sessionStats: sessionCounters({}) }));
    expect(cell(none, "compactions")?.title).not.toContain("UTC");
  });

  it("THIS CALL's evicted says where its size came from (P5)", () => {
    const exact = renderCachePanelHtml(
      panel({ lastEvictedTokens: 958_600, lastEvictedProvenance: "exact" }),
    );
    expect(cell(exact, "evicted")?.value).toBe("958.6k");
    expect(cell(exact, "evicted")?.title).toContain("Exact");
    const est = renderCachePanelHtml(
      panel({ lastEvictedTokens: 88_109, lastEvictedProvenance: "estimated" }),
    );
    expect(cell(est, "evicted")?.title).toContain("ESTIMATE");
  });
});

describe("app.ts host — one increment path, no zero seed (CONTROL: fails on the parent commit)", () => {
  // Resolved from the run root, NOT from import.meta.url: under jsdom that is an http:// URL.
  const srcRoot = ["tinker-ui/src", "src"]
    .map((p) => join(process.cwd(), p))
    .find((p) => existsSync(join(p, "app.ts")));
  const app = srcRoot ? readFileSync(join(srcRoot, "app.ts"), "utf8") : "";

  it("finds app.ts", () => {
    expect(srcRoot, `app.ts not found from ${process.cwd()}`).toBeTruthy();
  });

  it("no client tally: nothing increments a compaction count, nothing starts one at 0", () => {
    // Parent commit: `st.compactions += 1` in the RPC reply AND in the A1 `end` consumer (the
    // double count), and sessionStatsFor's zero-filled start (the fabricated 0).
    expect(app.match(/compactions \+= 1/g) ?? []).toEqual([]);
    expect(app).not.toMatch(/compactions: 0/);
    expect(app).not.toMatch(/sessionStatsFor|cacheSessionStats/);
  });

  it("the counts are not seeded from the anatomy row's per-attempt counter (F3d)", () => {
    expect(app).not.toMatch(/compactionCycle/);
  });

  it("every counter event goes through the one reducer; the panel reads the one projection", () => {
    expect(app.match(/reduceCounters\(/g) ?? []).toHaveLength(1);
    expect(app.match(/sessionCounters\(/g) ?? []).toHaveLength(1);
  });

  it("no anatomy poll pushes a row into the ctx-timeline without its runId", () => {
    // Parent commit: `timelineCtrl!.pushEvent(ev)` in the run-start AND the turn-end poll.
    expect(app.match(/pushEvent\(ev\)/g) ?? []).toEqual([]);
  });
});
