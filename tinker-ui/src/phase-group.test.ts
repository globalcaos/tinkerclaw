/**
 * FORK 2026-08-24 — the block replaces a row-per-stage list that crawled down the transcript.
 *
 * Every test here is a way the crawl could come back, or a way a measurement could be lost while
 * preventing it. The load-bearing one is `upsertPhaseEntry`: if a completion ever APPENDS instead
 * of filling its own slot, the block grows a second copy of every stage and the old shape is back.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_PHASE_ENTRIES,
  PHASE_DECOMPOSE_THRESHOLD_MS,
  needsDecomposition,
  phaseChildrenInOrder,
  phaseGroupCountLabel,
  phaseGroupIsLive,
  phaseGroupMeasuredMs,
  phaseGroupSpanMs,
  resolveAutoDisclosure,
  upsertPhaseEntry,
  type PhaseEntry,
} from "./phase-group.js";

const running = (label: string, startedAt: number): PhaseEntry => ({
  label,
  ms: 0,
  done: false,
  startedAt,
});
const finished = (label: string, ms: number, startedAt?: number): PhaseEntry => ({
  label,
  ms,
  done: true,
  ...(startedAt === undefined ? {} : { startedAt }),
});

describe("a stage occupies one slot for its whole life", () => {
  it("completes in place rather than appending a second row", () => {
    let e: PhaseEntry[] = [];
    e = upsertPhaseEntry(e, running("recalling memories", 1000), 1000);
    e = upsertPhaseEntry(e, finished("recalling memories", 12700), 13700);
    expect(e).toHaveLength(1);
    expect(e[0].done).toBe(true);
    expect(e[0].ms).toBe(12700);
  });

  it("keeps the original startedAt when the completion carries its own", () => {
    let e: PhaseEntry[] = [];
    e = upsertPhaseEntry(e, running("choosing a model", 1000), 1000);
    e = upsertPhaseEntry(e, { ...finished("choosing a model", 40), startedAt: 9999 }, 1040);
    // A completion that reset the clock would make the live counter jump backwards on the
    // frame before it settles.
    expect(e[0].startedAt).toBe(1000);
  });

  it("opens a new slot when the same label genuinely re-announces after completing", () => {
    let e: PhaseEntry[] = [];
    e = upsertPhaseEntry(e, running("compacting context", 0), 0);
    e = upsertPhaseEntry(e, finished("compacting context", 100), 100);
    e = upsertPhaseEntry(e, running("compacting context", 500), 500);
    expect(e).toHaveLength(2);
    expect(e[1].done).toBe(false);
  });
});

describe("a stage whose completion never arrives is closed, never dropped", () => {
  it("infers the duration from the next stage's start", () => {
    let e: PhaseEntry[] = [];
    e = upsertPhaseEntry(e, running("preparing the turn", 1000), 1000);
    e = upsertPhaseEntry(e, running("recalling memories", 3500), 3500);
    expect(e).toHaveLength(2);
    expect(e[0].done).toBe(true);
    expect(e[0].ms).toBe(2500);
    // Tagged, because it is NOT the same measurement as a server-timed stage.
    expect(e[0].inferred).toBe(true);
    expect(e[1].inferred).toBeUndefined();
  });

  it("never marks a genuinely measured completion as inferred", () => {
    let e: PhaseEntry[] = [];
    e = upsertPhaseEntry(e, running("assembling the prompt", 0), 0);
    e = upsertPhaseEntry(e, finished("assembling the prompt", 11), 11);
    expect(e[0].inferred).toBeUndefined();
  });
});

describe("liveness and totals", () => {
  it("is live exactly while one stage is unfinished", () => {
    let e: PhaseEntry[] = [];
    expect(phaseGroupIsLive(e)).toBe(false);
    e = upsertPhaseEntry(e, running("sending", 0), 0);
    expect(phaseGroupIsLive(e)).toBe(true);
    e = upsertPhaseEntry(e, finished("sending", 800), 800);
    expect(phaseGroupIsLive(e)).toBe(false);
  });

  it("counts a running stage against the clock", () => {
    const e = upsertPhaseEntry([], running("recalling memories", 1000), 1000);
    expect(phaseGroupMeasuredMs(e, 4000)).toBe(3000);
  });

  it("spans first start to last finish without double-counting nested windows", () => {
    // "preparing context" is a CLIENT window that CONTAINS the gateway stages. Summing would
    // report ~2x the wall time; the span is the honest headline.
    const e: PhaseEntry[] = [
      { label: "preparing context", ms: 10000, done: true, startedAt: 1000, client: true },
      { label: "recalling memories", ms: 6000, done: true, startedAt: 2000 },
      { label: "choosing a model", ms: 40, done: true, startedAt: 8000 },
    ];
    expect(phaseGroupMeasuredMs(e, 20000)).toBe(16040);
    expect(phaseGroupSpanMs(e, 20000)).toBe(10000);
  });

  it("falls back to the sum when nothing carries a start time", () => {
    const e: PhaseEntry[] = [finished("a", 100), finished("b", 200)];
    expect(phaseGroupSpanMs(e, 0)).toBe(300);
  });
});

describe("the 1s decomposition rule (2026-08-24)", () => {
  it("flags a childless measurement over 1s", () => {
    expect(needsDecomposition(1001, false)).toBe(true);
    expect(needsDecomposition(5678, false)).toBe(true);
  });

  it("does not flag one that already has children — that IS the decomposition", () => {
    // Total Recall averages 5.7s and is the worst offender, but once it carries its own two
    // stages the rule is satisfied by the children, not by the parent's own size.
    expect(needsDecomposition(5678, true)).toBe(false);
  });

  it("does not flag at or under the threshold", () => {
    expect(needsDecomposition(PHASE_DECOMPOSE_THRESHOLD_MS, false)).toBe(false);
    expect(needsDecomposition(999, false)).toBe(false);
    expect(needsDecomposition(0, false)).toBe(false);
  });

  it("treats a non-finite duration as not-flagged rather than throwing", () => {
    expect(needsDecomposition(Number.NaN, false)).toBe(false);
    expect(needsDecomposition(Number.POSITIVE_INFINITY, false)).toBe(false);
  });
});

describe("children render in the order they RAN", () => {
  it("does not sort by duration — the sequence is the point", () => {
    // The 2026-08-22 renderer sorted slowest-first. That answers "which is expensive", which the
    // bar widths answer anyway, and destroys the one thing a timeline is for.
    const kids = [
      { id: "session-lock", ms: 1 },
      { id: "bootstrap-context", ms: 5252 },
      { id: "mcp-tools", ms: 1311 },
      { id: "system-prompt-build", ms: 3 },
    ];
    expect(phaseChildrenInOrder(kids).map((k) => k.id)).toEqual([
      "session-lock",
      "bootstrap-context",
      "mcp-tools",
      "system-prompt-build",
    ]);
  });

  it("returns a copy, so a render cannot mutate the stored block", () => {
    const kids = [{ id: "a", ms: 1 }];
    const out = phaseChildrenInOrder(kids);
    out.push({ id: "b", ms: 2 });
    expect(kids).toHaveLength(1);
  });
});

describe("a child can itself be a parent", () => {
  it("carries nested children through the entry shape", () => {
    // "Total Recall" is a member of the before_prompt_build chain AND measures its own halves.
    const e = upsertPhaseEntry(
      [],
      {
        label: "recalling memories",
        ms: 6000,
        done: true,
        startedAt: 0,
        kind: "plugin",
        plugins: [
          {
            id: "tinkerclaw-total-recall",
            ms: 5678,
            kind: "plugin",
            children: [
              { id: "store-load", ms: 2000, kind: "stage" },
              { id: "pack-build", ms: 3000, kind: "stage" },
            ],
            childKind: "stage",
          },
          { id: "tinkerclaw-prefrontal", ms: 1, kind: "plugin" },
        ],
      },
      6000,
    );
    const tr = e[0].plugins?.[0];
    expect(tr?.children).toHaveLength(2);
    expect(tr?.childKind).toBe("stage");
    // The nested parent is NOT flagged: it has children, so it is already decomposed.
    expect(needsDecomposition(tr?.ms ?? 0, (tr?.children?.length ?? 0) > 0)).toBe(false);
  });
});

describe("automatic disclosure (2026-08-24)", () => {
  const A = "ph-1/recalling memories";
  const B = "ph-1/preparing context";

  it("opens every collapsible row while the task is running", () => {
    const r = resolveAutoDisclosure({
      tids: [A, B],
      live: true,
      autoOpened: new Set(),
      autoCollapsed: new Set(),
    });
    expect(r.toOpen).toEqual([A, B]);
    expect(r.toClose).toEqual([]);
  });

  it("collapses them into the task row once the task completes", () => {
    const r = resolveAutoDisclosure({
      tids: [A, B],
      live: false,
      autoOpened: new Set([A, B]),
      autoCollapsed: new Set(),
    });
    expect(r.toClose).toEqual([A, B]);
    expect(r.toOpen).toEqual([]);
  });

  it("re-opens nothing on the repaints that follow the auto-open", () => {
    // A live turn repaints once a second. Without this, a row closed by hand mid-turn would flap
    // back open under the cursor on the very next tick.
    const r = resolveAutoDisclosure({
      tids: [A],
      live: true,
      autoOpened: new Set([A]),
      autoCollapsed: new Set(),
    });
    expect(r.toOpen).toEqual([]);
  });

  it("collapses only once, so a row re-opened by hand afterwards stays open", () => {
    const r = resolveAutoDisclosure({
      tids: [A],
      live: false,
      autoOpened: new Set([A]),
      autoCollapsed: new Set([A]),
    });
    expect(r.toClose).toEqual([]);
  });

  it("never touches a block it did not open", () => {
    // A block restored from client-rows after a page reload is already complete. It must render
    // collapsed with no transition — and must NOT be closed by this mechanism, which would
    // otherwise fight a user who opened it to read an old turn.
    const r = resolveAutoDisclosure({
      tids: [A, B],
      live: false,
      autoOpened: new Set(),
      autoCollapsed: new Set(),
    });
    expect(r).toEqual({ toOpen: [], toClose: [] });
  });

  it("handles a block with nothing collapsible", () => {
    expect(
      resolveAutoDisclosure({
        tids: [],
        live: true,
        autoOpened: new Set(),
        autoCollapsed: new Set(),
      }),
    ).toEqual({ toOpen: [], toClose: [] });
  });

  it("opens a row that appears mid-turn, after its siblings were already opened", () => {
    // 'recalling memories' only becomes collapsible when its completion event brings its eight
    // children — long after 'sending' and the first phases were rendered.
    const r = resolveAutoDisclosure({
      tids: [B, A],
      live: true,
      autoOpened: new Set([B]),
      autoCollapsed: new Set(),
    });
    expect(r.toOpen).toEqual([A]);
  });
});

describe("bounds and labels", () => {
  it("truncates rather than growing an unbounded chat row", () => {
    let e: PhaseEntry[] = [];
    for (let i = 0; i < MAX_PHASE_ENTRIES + 10; i++) {
      e = upsertPhaseEntry(e, finished(`stage-${i}`, 1), i);
    }
    expect(e).toHaveLength(MAX_PHASE_ENTRIES);
    // The TAIL is kept: the most recent stages are the ones being looked at.
    expect(e[e.length - 1].label).toBe(`stage-${MAX_PHASE_ENTRIES + 9}`);
  });

  it("pluralises the count", () => {
    expect(phaseGroupCountLabel([finished("a", 1)])).toBe("1 stage");
    expect(phaseGroupCountLabel([finished("a", 1), finished("b", 1)])).toBe("2 stages");
  });
});
