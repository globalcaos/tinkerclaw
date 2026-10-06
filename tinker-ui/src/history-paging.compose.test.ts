import { beforeEach, describe, expect, it } from "vitest";
import {
  applyOlderReply,
  foldTailReply,
  HOLE_FILL_MAX_PAGES,
  holeFillAfterFold,
  holeFillAfterTrim,
  holeFillRequest,
  holeFillStillOwed,
  holeFillWaitsForTrim,
  type HoleFill,
  legacyReadAfterRejectedCursor,
  nextHoleFill,
  planTrim,
  removeRowsInPlace,
  replyFitsPage,
  stubTrimCutoff,
  tailRequestForPage,
  turnNumberOf,
  viewedTrimCutoff,
  windowToFold,
} from "./history-paging.js";
import {
  DEFAULT_HISTORY_RECONCILE_DEPS as deps,
  reconcileHistoryIntoPage,
} from "./history-reconcile.js";
import {
  BG_STUB_ROWS,
  buildOlderRequest,
  emptyWindow,
  type HistoryWindow,
} from "./history-window.js";
import { __resetMsgOrderForTests, renderOrder, stampOrder } from "./msg-order.js";

// FORK 2026-09-23 (plan task 8, fix round 1: review finding M6) — COMPOSITION tests. The unit tests
// pin each helper alone; these chain the REAL reconcile (identity, watermark and watched-window
// rules) with the fold / older-page / trim helpers exactly as app.ts does, against a fake gateway
// that follows chat.history's cursor rules. Each probe from the review is reproduced here.

const T0 = Date.parse("2026-09-23T00:00:00Z");
const MIN = 60_000;

type Entry =
  | { kind: "local"; seq: number; ts: number; user?: boolean }
  | { kind: "import"; n: number; ts: number };
type Row = Record<string, unknown>;
type Reply = { sessionId: string; messages: Row[]; cursor?: Record<string, unknown> };

/** Local rows seq `from..to`, one minute apart (seq N at T0 + N minutes). */
const locals = (from: number, to: number): Entry[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    kind: "local",
    seq: from + i,
    ts: T0 + (from + i) * MIN,
  }));

const textOf = (m: unknown): string =>
  String(((m as Row).content as Array<{ text?: unknown }>)[0]?.text ?? "?");

/** A row as the wire serves it: a fresh object every time, like a JSON reply. */
function wire(e: Entry): Row {
  if (e.kind === "local") {
    return {
      role: e.user ? "user" : "assistant",
      content: [{ type: "text", text: `L${e.seq}` }],
      timestamp: e.ts,
      __openclaw: { id: `id-${e.seq}`, seq: e.seq },
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: `I${e.n}` }],
    timestamp: e.ts,
    __openclaw: { externalId: `x-${e.n}`, importedFrom: "claude-cli" },
  };
}

/**
 * chat.history's window rules (server-methods/chat.ts + chat-history-cursor.ts), reduced to what the
 * client can observe: default limit 200, hard max 1000; a cursor under another epoch, or a delta
 * longer than its limit, is answered `reset` with the tail; a before-page carries the imports that
 * sit between its first local row and the row it was paged from. `cursors: false` is the gateway
 * before its restart (ruling R7): the same rows, no `cursor` field.
 */
class FakeGateway {
  /** Every request handled, in order (hole-fill tests count the older pages). */
  requests: Array<Record<string, unknown>> = [];
  /** Ruling R36: the cursor counts the user rows before its firstSeq (off = an older gateway). */
  countsUsers = true;

  constructor(
    public entries: Entry[],
    public epoch: string,
    public cursors = true,
  ) {}

  private localRows(): Array<Extract<Entry, { kind: "local" }>> {
    return this.entries.filter((e): e is Extract<Entry, { kind: "local" }> => e.kind === "local");
  }

  lastSeq(): number {
    return this.localRows().reduce((max, e) => Math.max(max, e.seq), 0);
  }

  private tsOf(seq: number): number {
    return this.localRows().find((e) => e.seq === seq)?.ts ?? Number.NaN;
  }

  private reply(rows: Entry[], cursor: Record<string, unknown>, plainDelta = false): Reply {
    const out: Reply = { sessionId: "sid-1", messages: rows.map(wire) };
    if (this.cursors) {
      out.cursor = { epoch: this.epoch, ...cursor };
      if (this.countsUsers && !plainDelta) {
        const firstSeq = cursor.firstSeq as number;
        out.cursor.userRowsBefore = this.localRows().filter(
          (e) => e.user === true && e.seq < firstSeq,
        ).length;
      }
    }
    return out;
  }

  private tail(limit: number, reset: boolean): Reply {
    const served = this.localRows().slice(-limit);
    const first = served[0];
    const fromTs = !first || first.seq <= 1 ? Number.NEGATIVE_INFINITY : first.ts;
    const rows = this.entries.filter((e) =>
      e.kind === "local" ? served.includes(e) : e.ts >= fromTs,
    );
    const firstSeq = first ? first.seq : 0;
    return this.reply(rows, {
      firstSeq,
      lastSeq: this.lastSeq(),
      hasMoreBefore: firstSeq > 1,
      reset,
    });
  }

  handle(req: Record<string, unknown>): Reply {
    this.requests.push(req);
    const limit = Math.min(1000, typeof req.limit === "number" ? req.limit : 200);
    const { afterSeq, beforeSeq } = req as { afterSeq?: number; beforeSeq?: number };
    if (afterSeq === undefined && beforeSeq === undefined) {
      return this.tail(limit, false);
    }
    if (!this.cursors) {
      throw new Error("invalid chat.history params: must NOT have additional properties");
    }
    if (req.epoch !== this.epoch) {
      return this.tail(limit, true);
    }
    const last = this.lastSeq();
    if (afterSeq !== undefined) {
      if (afterSeq > last || last - afterSeq > limit) {
        return this.tail(limit, true);
      }
      const anchorTs = afterSeq === 0 ? Number.NEGATIVE_INFINITY : this.tsOf(afterSeq);
      const rows = this.entries.filter((e) =>
        e.kind === "local" ? e.seq > afterSeq : e.ts > anchorTs,
      );
      return this.reply(
        rows,
        {
          firstSeq: last > afterSeq ? afterSeq + 1 : afterSeq,
          lastSeq: last,
          hasMoreBefore: afterSeq >= 1,
          reset: false,
        },
        true,
      );
    }
    const b = beforeSeq as number;
    const served = this.localRows()
      .filter((e) => e.seq < b)
      .slice(-limit);
    const first = served[0];
    const reachesStart = !first || first.seq <= 1;
    const fromTs = reachesStart ? Number.NEGATIVE_INFINITY : first.ts;
    const toTs = b <= last ? this.tsOf(b) : Number.POSITIVE_INFINITY;
    const rows = this.entries.filter((e) =>
      e.kind === "local" ? served.includes(e) : e.ts >= fromTs && e.ts <= toTs,
    );
    const firstSeq = first ? first.seq : b - 1;
    return this.reply(rows, {
      firstSeq,
      lastSeq: served.length > 0 ? served[served.length - 1].seq : b - 1,
      hasMoreBefore: firstSeq > 1,
      reset: false,
    });
  }
}

/** One tab, glued exactly as app.ts glues the helpers (loadChat's merge + fold, loadOlderPage). */
class Tab {
  page: unknown[] = [];
  window: HistoryWindow = emptyWindow();
  /**
   * The hole-fill plan the last lower-edge-moving fold, or a pinned trim under an older epoch's
   * rows, left (app.ts TabState.holeFill).
   */
  hole: HoleFill | null = null;

  constructor(public gw: FakeGateway) {}

  /** A tail read (loadChat / hydrateTab): the request comes from the page and its window. */
  tailRead(): void {
    const { request, base } = tailRequestForPage("k", this.window, this.page);
    this.merge(request, base, this.gw.handle(request));
  }

  /**
   * app.ts loadChat / hydrateTab around a rejected read (ruling R33): a gateway that throws on the
   * cursor params gets the window forgotten and ONE legacy-shaped read of the same page at once.
   */
  tailReadSurvivingRejection(): void {
    const { request, base } = tailRequestForPage("k", this.window, this.page);
    let reply: Reply;
    try {
      reply = this.gw.handle(request);
    } catch {
      const retry = legacyReadAfterRejectedCursor(request, true, this.page);
      if (retry === null) {
        return;
      }
      this.window = emptyWindow();
      this.merge(retry.request, retry.base, this.gw.handle(retry.request));
      return;
    }
    this.merge(request, base, reply);
  }

  /** A tail read whose request the test chooses (e.g. the shape a later ruling mandates). */
  tailReadWith(request: Record<string, unknown>): void {
    this.merge(request, this.window, this.gw.handle(request));
  }

  private merge(request: Record<string, unknown>, base: HistoryWindow, reply: Reply): void {
    if (!replyFitsPage(request, reply, this.page)) {
      this.window = emptyWindow();
      return;
    }
    const r = reconcileHistoryIntoPage(this.page, reply.messages, deps);
    if (r.mode === "fresh") {
      this.page.splice(0, this.page.length, ...reply.messages);
    } else {
      this.page.push(...r.added);
    }
    const into = windowToFold(base, this.window);
    this.window = foldTailReply(into, reply, this.page);
    this.hole = holeFillAfterFold(this.page, into, this.window) ?? this.hole;
    stampOrder(this.page); // the repaint
  }

  /**
   * app.ts fillHoleIfOwed: older pages from the window's lower edge while the hole is owed.
   * `pinned` = the owner follows the latest row: the viewed trim's cutoff is then the floor a fill
   * page would land under, and the plan WAITS — kept, not discarded (R32 residual).
   */
  fillHole(pinned = false): number {
    let pages = 0;
    while (this.hole !== null) {
      if (!holeFillStillOwed(this.hole, this.page, this.window)) {
        this.hole = null;
        break;
      }
      if (holeFillWaitsForTrim(this.window, viewedTrimCutoff(this.page, this.window, pinned))) {
        break;
      }
      const w = this.window;
      const request = holeFillRequest("k", w, this.hole);
      if (request === null) {
        break;
      }
      const outcome = applyOlderReply(this.page, w, this.gw.handle(request));
      this.window = outcome.window;
      stampOrder(this.page);
      pages++;
      this.hole = nextHoleFill(this.hole, outcome);
    }
    return pages;
  }

  /** One scroll-to-top older page (loadOlderPage). False when there is nothing older to ask. */
  olderRead(): boolean {
    const w = this.window;
    const request = buildOlderRequest("k", w);
    if (request === null) {
      return false;
    }
    const outcome = applyOlderReply(this.page, w, this.gw.handle(request));
    this.window = outcome.window;
    stampOrder(this.page);
    return outcome.kind === "written";
  }

  /** Scroll to the top until the window says there is nothing older (bounded). */
  pageAllTheWayUp(): void {
    for (let i = 0; i < 30 && this.olderRead(); i++) {
      /* keep paging */
    }
  }

  labels(): string[] {
    return renderOrder(this.page).map(textOf);
  }
}

const range = (from: number, to: number, prefix = "L") =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

beforeEach(() => {
  __resetMsgOrderForTests();
});

describe("C1 — a re-initialised window claims only what the page holds", () => {
  it("probe: page 401..500 (e0); after a restart the reset reply carries 301..500 (e1) — every row comes back in order", () => {
    const gw = new FakeGateway(locals(1, 500), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // first open: the last WINDOW_PAGE rows
    expect(tab.labels()).toEqual(range(401, 500));
    gw.epoch = "e1"; // the gateway restarted: every old cursor is stale
    tab.tailReadWith({ sessionKey: "k", afterSeq: 500, epoch: "e0" }); // answered reset, 301..500
    // The merge kept 401..500 (known) and skipped 301..400 as behind the page's newest row.
    expect(tab.labels()).toEqual(range(401, 500));
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(range(1, 500));
  });

  it("probe: the FIRST cursor fold onto a page loaded before the restart (R7) keeps older rows pageable", () => {
    const gw = new FakeGateway(locals(1, 500), "e1", false); // the gateway before its restart
    const tab = new Tab(gw);
    tab.tailRead();
    expect(tab.labels()).toEqual(range(401, 500));
    expect(tab.window).toEqual(emptyWindow()); // R7: no cursor, no window
    gw.cursors = true; // restarted
    tab.tailReadWith({ sessionKey: "k", limit: 1000 }); // a legacy-shaped read of a loaded page
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(range(1, 500));
  });
});

/** Bubbles the live writer painted while the owner watched run `runId` write rows `from..to`. */
function watchLive(
  tab: Tab,
  runId: string,
  from: number,
  to: number,
  watchedFromSeq?: number,
): void {
  for (let seq = from; seq <= to; seq++) {
    tab.page.push({
      role: "assistant",
      content: [{ type: "text", text: `LIVE${seq}` }],
      _runId: runId,
      _bubbleStartedAt: T0 + seq * MIN,
      _bubbleEndedAt: T0 + seq * MIN + 1_000,
      // A page that JOINED the run mid-way: the live writer stamps the run's prompt time on its
      // first bubble (live-continuation.ts), so the watched window starts at that prompt.
      ...(seq === from && watchedFromSeq !== undefined
        ? { _watchedFrom: T0 + watchedFromSeq * MIN }
        : {}),
    });
  }
  stampOrder(tab.page);
}

/** The background stub (app.ts trimIdleBackgroundTabs). */
function stub(tab: Tab): void {
  const cutoff = stubTrimCutoff(tab.page, tab.window);
  const plan =
    cutoff === null ? null : planTrim(tab.page, tab.window, cutoff, { seqlessServerRows: true });
  if (plan !== null) {
    removeRowsInPlace(tab.page, plan.remove);
    tab.window = plan.window;
  }
}

describe("C2 — an older page never re-adds a run the page watched live", () => {
  it("probe (reset path): the server copies of a watched run stay out; nothing moves around the live bubbles", () => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // 301..400
    gw.entries.push(...locals(401, 450));
    watchLive(tab, "R", 401, 450); // the owner watched this run being written
    gw.entries.push(...locals(451, 460));
    gw.epoch = "e1"; // restart: the next tail read is answered reset
    tab.tailRead();
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([
      ...range(1, 400),
      ...range(401, 450, "LIVE"),
      ...range(451, 460),
    ]);
  });
});

// FORK 2026-10-05 (the architect: "Some tabs appear without history. I should be able to scroll back until
// the beginning") — app.ts loadOlderPage no longer refuses a scroll to the top while the session
// runs (AcmeVision's turns run 30-45 min). What makes that safe is here, in the helpers it calls.
describe("an older page under a live run", () => {
  it("pages all the way up while the run writes; its server copies stay out, its bubbles stay put", () => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // first open: 301..400
    gw.entries.push(...locals(401, 420)); // the running turn's rows, as the gateway serves them
    watchLive(tab, "R", 401, 420, 401); // the page joined it: its first bubble names the prompt time
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([...range(1, 400), ...range(401, 420, "LIVE")]);
  });
});

/** The viewed tab's trim while pinned to the latest row (app.ts trimViewedPageIfPinned). */
function trimPinned(tab: Tab): void {
  const cutoff = viewedTrimCutoff(tab.page, tab.window, true);
  const plan = cutoff === null ? null : planTrim(tab.page, tab.window, cutoff);
  if (plan !== null) {
    removeRowsInPlace(tab.page, plan.remove);
    tab.window = plan.window;
    tab.hole = holeFillAfterTrim(tab.hole, tab.page, plan.remove, plan.window);
  }
}

describe("C2 — rows paged back in land where they were, around rows that carry no identity", () => {
  it("probe (trim path): page 1..100, a watched run, 151..600; a pinned trim, then paging up restores it exactly", () => {
    const gw = new FakeGateway(locals(1, 100), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // 1..100
    gw.entries.push(...locals(101, 150));
    watchLive(tab, "R", 101, 150);
    gw.entries.push(...locals(151, 600));
    tab.tailReadWith({ sessionKey: "k", afterSeq: 100, epoch: "e0", limit: 1000 });
    expect(tab.page).toHaveLength(600);
    trimPinned(tab);
    expect(tab.page.length).toBeLessThan(600);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([
      ...range(1, 100),
      ...range(101, 150, "LIVE"),
      ...range(151, 600),
    ]);
  });

  it("a client note (turn timing) keeps its place when the rows around it are trimmed and paged back", () => {
    const gw = new FakeGateway(locals(1, 50), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // 1..50
    const noteAt = T0 + 50 * MIN + 30_000;
    tab.page.push({
      role: "assistant",
      content: [{ type: "text", text: "NOTE" }],
      _isPhaseTiming: true,
      ts: noteAt,
      _anchorAt: noteAt,
    });
    stampOrder(tab.page);
    gw.entries.push(...locals(51, 500));
    tab.tailReadWith({ sessionKey: "k", afterSeq: 50, epoch: "e0", limit: 1000 });
    trimPinned(tab);
    expect(tab.labels()[0]).toBe("NOTE"); // the rows above it are out of memory now
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([...range(1, 50), "NOTE", ...range(51, 500)]);
  });
});

describe("R25 — a read of a page that already holds server rows asks up to 1000 rows", () => {
  it("I1 probe: a 300-row gap arrives as one delta, not a reset that leaves a mid-page hole", () => {
    const gw = new FakeGateway(locals(1, 100), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // first open of an EMPTY page: the last WINDOW_PAGE rows
    gw.entries.push(...locals(101, 400));
    tab.tailRead(); // the tab was away for 300 rows
    expect(tab.labels()).toEqual(range(1, 400));
  });

  it("I2 probe (R7, gateway before its restart): a gap > 100 rows arrives whole, no hole R7 cannot page back", () => {
    const gw = new FakeGateway(locals(1, 400), "e0", false);
    const tab = new Tab(gw);
    tab.tailRead(); // 301..400
    gw.entries.push(...locals(401, 600));
    tab.tailRead();
    expect(tab.labels()).toEqual(range(301, 600));
  });
});

describe("I1 — a trim never makes a mid-page hole permanent", () => {
  it("probe: a same-epoch reset left 401..500 out; a pinned trim below the hole must keep it pageable", () => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    tab.pageAllTheWayUp(); // 1..400 on the page
    gw.entries.push(...locals(401, 700));
    // A read that still hits the gateway's 200 cap (a gap over 1000 rows does the same under R25):
    // answered reset with 501..700, so 401..500 is a hole between two runs of the same epoch.
    tab.tailReadWith({ sessionKey: "k", afterSeq: 400, epoch: "e0", limit: 200 });
    expect(tab.labels()).toEqual([...range(1, 400), ...range(501, 700)]);
    trimPinned(tab); // cutoff 700 - 400 = 300: drops 1..299, below the hole
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(range(1, 700));
  });
});

describe("I3 / R26 — the background stub leaves no orphan imports above its first prompt", () => {
  /** A cc-bridge transcript: every local row (the prompt) is followed by two claude-cli imports. */
  const bridgeTranscript = (n: number): Entry[] =>
    locals(1, n).flatMap((e) => [
      e,
      { kind: "import" as const, n: 2 * (e as { seq: number }).seq - 1, ts: e.ts + 20_000 },
      { kind: "import" as const, n: 2 * (e as { seq: number }).seq, ts: e.ts + 40_000 },
    ]);
  const bridgeLabels = (from: number, to: number) =>
    range(from, to).flatMap((l) => {
      const s = Number(l.slice(1));
      return [l, `I${2 * s - 1}`, `I${2 * s}`];
    });

  it("probe: stubbed to the newest 30 prompts, the page starts at a prompt; paging up restores it all", () => {
    const gw = new FakeGateway(bridgeTranscript(100), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    expect(tab.labels()).toEqual(bridgeLabels(1, 100));
    const cutoff = stubTrimCutoff(tab.page, tab.window);
    const plan =
      cutoff === null ? null : planTrim(tab.page, tab.window, cutoff, { seqlessServerRows: true });
    expect(plan).not.toBeNull();
    removeRowsInPlace(tab.page, plan!.remove);
    tab.window = plan!.window;
    expect(tab.labels()).toEqual(bridgeLabels(71, 100));
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(bridgeLabels(1, 100));
  });

  it("never trims client-only notes or live bubbles, even above the lowest kept prompt", () => {
    const gw = new FakeGateway(bridgeTranscript(40), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    const note = { role: "assistant", content: [{ type: "text", text: "NOTE" }], _isWarning: true };
    tab.page.splice(3, 0, note); // after the first prompt's imports
    stampOrder(tab.page);
    const cutoff = stubTrimCutoff(tab.page, tab.window);
    const plan = planTrim(tab.page, tab.window, cutoff as number, { seqlessServerRows: true });
    expect(plan!.remove.has(note)).toBe(false);
  });
});

describe("R27 — a trim keeps rows the page watched in place, and nothing else stops it", () => {
  /** Page 1..55 from history; run R (prompt = row 51) joined mid-way, bubbles 56..60; then 61..last. */
  const joinedRun = (last: number) => {
    const gw = new FakeGateway(locals(1, 55), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    gw.entries.push(...locals(56, 60));
    watchLive(tab, "R", 56, 60, 51);
    gw.entries.push(...locals(61, last));
    tab.tailRead();
    return tab;
  };
  const joinedLabels = (last: number) => [
    ...range(1, 55),
    ...range(56, 60, "LIVE"),
    ...range(61, last),
  ];

  it("N1 probe (joined run, background stub): the run's prompt and its history rows come back", () => {
    const tab = joinedRun(200);
    expect(tab.labels()).toEqual(joinedLabels(200));
    stub(tab);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(joinedLabels(200));
  });

  it("N1 probe (joined run, pinned viewed trim)", () => {
    const tab = joinedRun(600);
    trimPinned(tab);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(joinedLabels(600));
  });

  it("N1 probe (the owner's own prompt): a history row 10 s before the optimistic prompt comes back", () => {
    const gw = new FakeGateway(locals(1, 50), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    tab.page.push({
      role: "user",
      content: [{ type: "text", text: "PROMPT" }],
      _clientMsgId: "c1",
      _promptStartedAt: T0 + 50 * MIN + 10_000,
    });
    stampOrder(tab.page);
    gw.entries.push(...locals(51, 200));
    tab.tailRead();
    const all = [...range(1, 50), "PROMPT", ...range(51, 200)];
    expect(tab.labels()).toEqual(all);
    stub(tab);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(all);
  });

  it("N2 probe: after the owner's first watched run the stub still bounds memory to ~BG_STUB_ROWS", () => {
    const gw = new FakeGateway(locals(1, 5), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    gw.entries.push(...locals(6, 10));
    watchLive(tab, "R", 6, 10);
    gw.entries.push(...locals(11, 1000));
    tab.tailRead();
    expect(tab.page).toHaveLength(1000);
    stub(tab);
    // The newest BG_STUB_ROWS local rows plus the 5 live bubbles — not everything after the run.
    expect(tab.page).toHaveLength(BG_STUB_ROWS + 5);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([...range(1, 5), ...range(6, 10, "LIVE"), ...range(11, 1000)]);
  });
});

describe("M-c — a reset window reaches past the rows of a run the page watched", () => {
  it("probe: after a restart the window starts below the watched run, so the next older page is not a no-op", () => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // 301..400
    gw.entries.push(...locals(401, 450));
    watchLive(tab, "R", 401, 450);
    gw.entries.push(...locals(451, 460));
    gw.epoch = "e1";
    tab.tailRead(); // reset: 1..460; 401..450 skipped as watched, 1..300 as behind
    // The page holds 301..460 (401..450 as live bubbles): the window must start at 301, not 451.
    expect(tab.window.firstSeq).toBe(301);
    expect(tab.olderRead()).toBe(true);
    expect(tab.labels()[0]).toBe("L201"); // the first older page wrote rows
  });
});

/** The owner sends a prompt: the optimistic user row, 10 s after row `afterSeq`. */
function send(tab: Tab, label: string, afterSeq: number): void {
  tab.page.push({
    role: "user",
    content: [{ type: "text", text: label }],
    _clientMsgId: `c-${label}`,
    _promptStartedAt: T0 + afterSeq * MIN + 10_000,
  });
  stampOrder(tab.page);
}

describe("R28 — each optimistic prompt is its own instant, never a span between two sends", () => {
  /** L1..L5, send P1, then rows 6..last from a tail read. */
  const oneSend = (last: number) => {
    const gw = new FakeGateway(locals(1, 5), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    send(tab, "P1", 5);
    gw.entries.push(...locals(6, last));
    tab.tailRead();
    return tab;
  };

  it("NEW-1 probe (pinned trim, then a second send): every trimmed row comes back", () => {
    const tab = oneSend(600);
    trimPinned(tab);
    send(tab, "P2", 600);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([...range(1, 5), "P1", ...range(6, 600), "P2"]);
  });

  it("NEW-1 probe (background stub, then a second send): every stubbed row comes back", () => {
    const tab = oneSend(300);
    stub(tab);
    send(tab, "P2", 300);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([...range(1, 5), "P1", ...range(6, 300), "P2"]);
  });

  it("control: with one send the same stub + paging round trip was already whole", () => {
    const tab = oneSend(300);
    stub(tab);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([...range(1, 5), "P1", ...range(6, 300)]);
  });

  it("N2 probe (two sends): the stub keeps ~BG_STUB_ROWS plus the rows each prompt watched", () => {
    const tab = oneSend(1000);
    send(tab, "P2", 1000);
    expect(tab.page).toHaveLength(1002);
    stub(tab);
    // Newest BG_STUB_ROWS local rows, the two prompts, and L5 (inside P1's own instant window).
    expect(tab.page.length).toBeLessThanOrEqual(BG_STUB_ROWS + 3);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([...range(1, 5), "P1", ...range(6, 1000), "P2"]);
  });
});

describe("R28.2 — no trim while a run can still be joined (the _watchedFrom backward extension)", () => {
  /** Rows 1..600 on the page; run R's prompt is row 150 and it is still running, not yet joined. */
  const longRunLoaded = () => {
    const gw = new FakeGateway(locals(1, 600), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    tab.pageAllTheWayUp();
    gw.entries.push(...locals(601, 601));
    return tab;
  };

  it("CONTROL (the order the guard forbids): a trim BEFORE the page joins the run loses rows the join then covers", () => {
    const tab = longRunLoaded();
    trimPinned(tab); // drops 1..199 — nothing is watched yet
    watchLive(tab, "R", 601, 601, 150); // the first live bubble: the run is covered from row 150
    tab.pageAllTheWayUp();
    expect(tab.labels()).not.toContain("L150"); // 150..199 are skipped as watched, for good
  });

  it("the guarded order — the trim waits for the run, which the page joins first — loses nothing", () => {
    const tab = longRunLoaded();
    watchLive(tab, "R", 601, 601, 150);
    trimPinned(tab); // after the run: R27 keeps the rows the run covers, drops the rest
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual([...range(1, 600), "LIVE601"]);
  });
});

describe("R32 — a hole a fold leaves is filled without scrolling to the top", () => {
  const olderReads = (gw: FakeGateway) => gw.requests.filter((r) => r.beforeSeq !== undefined);

  /** Page 1..400 under e0, then `grown` rows written and the gateway restarted (e1). */
  const restartedWithGap = (grown: number) => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(range(1, 400));
    gw.entries.push(...locals(401, 400 + grown));
    gw.epoch = "e1";
    gw.requests = [];
    tab.tailRead(); // answered reset with the last 1000 rows
    return { gw, tab };
  };

  it("a restart reset leaving a 150-row hole: filled in the background, in order", () => {
    const { gw, tab } = restartedWithGap(1150);
    // CONTROL: the fold alone leaves 401..550 out — before R32 only a scroll to the top filled it.
    expect(tab.labels()).toEqual([...range(1, 400), ...range(551, 1550)]);
    expect(tab.hole).not.toBeNull();
    const pages = tab.fillHole();
    expect(tab.labels()).toEqual(range(1, 1550));
    // Page 1 = 451..550; page 2 = 351..450 reaches rows the page held (351..400): the hole closed.
    expect(pages).toBe(2);
    expect(olderReads(gw)).toHaveLength(2);
  });

  it("a same-epoch reset (a delta longer than its limit) leaving a hole: filled the same way", () => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    tab.pageAllTheWayUp();
    gw.entries.push(...locals(401, 700));
    tab.tailReadWith({ sessionKey: "k", afterSeq: 400, epoch: "e0", limit: 200 }); // reset: 501..700
    expect(tab.labels()).toEqual([...range(1, 400), ...range(501, 700)]);
    expect(tab.fillHole()).toBe(1); // 401..500: the window now meets the held seqs, nothing owed
    expect(tab.labels()).toEqual(range(1, 700));
  });

  it("a 5,000-row hole: HOLE_FILL_MAX_PAGES pages, then it is left to scroll-to-top", () => {
    const { gw, tab } = restartedWithGap(6000); // reset tail 5401..6400; hole 401..5400
    expect(tab.fillHole()).toBe(HOLE_FILL_MAX_PAGES);
    expect(HOLE_FILL_MAX_PAGES).toBe(3);
    expect(olderReads(gw)).toHaveLength(3);
    expect(tab.labels()).toEqual([...range(1, 400), ...range(5101, 6400)]);
    // Nothing more is asked by itself…
    expect(tab.fillHole()).toBe(0);
    expect(olderReads(gw)).toHaveLength(3);
    // …and a scroll to the top still pages the rest of the hole in.
    expect(tab.olderRead()).toBe(true);
    expect(tab.labels()).toEqual([...range(1, 400), ...range(5001, 6400)]);
  });

  it("control: a fold that only extends the window forward owes nothing", () => {
    const gw = new FakeGateway(locals(1, 100), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    gw.entries.push(...locals(101, 400));
    tab.tailRead(); // a plain 300-row delta
    expect(tab.hole).toBeNull();
    expect(tab.fillHole()).toBe(0);
  });

  it("control: a reset whose rows the page already reaches (C1) leaves no hole to fill", () => {
    const gw = new FakeGateway(locals(1, 500), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // 401..500
    gw.epoch = "e1";
    tab.tailReadWith({ sessionKey: "k", afterSeq: 500, epoch: "e0" }); // reset 301..500
    expect(tab.hole).toBeNull(); // 301..400 were never on the page: that is "more before", not a hole
    expect(olderReads(gw)).toHaveLength(0);
  });
});

describe("R32 residual — a pinned tab's hole fill waits for the owner to scroll up, then fills", () => {
  const olderReads = (gw: FakeGateway) => gw.requests.filter((r) => r.beforeSeq !== undefined);

  /**
   * Page 1..400 under e0, then 1150 rows written and the gateway restarted (e1): the reset tail is
   * 551..1550, so a 150-row CROSS-EPOCH hole sits under e0's rows — which hold no e1 seq, so no trim
   * can take them. The page holds 1400 rows: over WINDOW_MAX_ROWS, pinned, the trim floor is 1150.
   */
  const restart = () => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    tab.pageAllTheWayUp();
    gw.entries.push(...locals(401, 1550));
    gw.epoch = "e1";
    gw.requests = [];
    tab.tailRead(); // reset: 551..1550
    expect(tab.labels()).toEqual([...range(1, 400), ...range(551, 1550)]);
    expect(tab.hole).toEqual({ epoch: "e1", pagesLeft: HOLE_FILL_MAX_PAGES, floor: 551 });
    return { gw, tab };
  };

  /** app.ts loadChat on a pinned tab: the merge's trim runs before fillHoleIfOwed. */
  const pinnedRestart = () => {
    const r = restart();
    trimPinned(r.tab); // drops 551..1149: the hole under L400 is now 401..1149
    expect(r.tab.window.firstSeq).toBe(1150);
    expect(r.tab.labels()).toEqual([...range(1, 400), ...range(1150, 1550)]);
    return r;
  };

  it("probe: pinned + a restart reset leaving a 150-row cross-epoch hole — no fill while pinned, whole after the first scroll up", () => {
    const { gw, tab } = pinnedRestart();
    // Pinned: every row a fill page brings back is under the trim floor. The plan WAITS.
    expect(tab.fillHole(true)).toBe(0);
    expect(olderReads(gw)).toHaveLength(0);
    expect(tab.hole).not.toBeNull(); // kept — before the fix it was discarded here, for good
    const shown = [...tab.page];
    // The owner scrolls up: the trim no longer runs, the fill resumes from the window's lower edge.
    const pages = tab.fillHole(false);
    expect(tab.labels()).toEqual(range(1, 1550));
    // Page 1 asks back the 599 rows the trim took plus one page (451..1149); page 2 (351..450)
    // reaches e0's rows. 100-row pages would have spent all three on 850..1149 and left 401..849.
    expect(pages).toBe(2);
    expect(olderReads(gw).map((r) => [r.beforeSeq, r.limit])).toEqual([
      [1150, 699],
      [451, 100],
    ]);
    expect(tab.hole).toBeNull();
    // The paper rule: a fill only writes; every row the page showed is still on it.
    expect(shown.every((m) => tab.page.includes(m))).toBe(true);
  });

  it("re-pinned: the next pinned trim opens the gap under e0's rows again — owed, waiting, filled on the next scroll up", () => {
    const { gw, tab } = pinnedRestart();
    tab.fillHole(false);
    gw.entries.push(...locals(1551, 1560));
    tab.tailRead(); // a plain delta: no fold owes anything
    expect(tab.hole).toBeNull();
    trimPinned(tab); // cutoff 1160: 351..1159 hold e1 seqs now and go; 1..350 hold only e0's
    expect(tab.labels()).toEqual([...range(1, 350), ...range(1160, 1560)]);
    expect(tab.hole).toEqual({ epoch: "e1", pagesLeft: HOLE_FILL_MAX_PAGES, floor: 351 });
    gw.requests = [];
    expect(tab.fillHole(true)).toBe(0);
    expect(tab.fillHole(false)).toBe(1); // 251..1159 in one read: it reaches e0's 251..350
    expect(tab.labels()).toEqual(range(1, 1560));
    expect(olderReads(gw)).toHaveLength(1);
  });

  it("pinned while the trim is held off (R28.2, a live run): the plan still waits, then fills in plain pages", () => {
    const { gw, tab } = restart();
    expect(viewedTrimCutoff(tab.page, tab.window, true)).toBe(1150);
    expect(tab.fillHole(true)).toBe(0);
    expect(tab.hole).not.toBeNull();
    expect(tab.fillHole(false)).toBe(2); // 451..550, then 351..450 reaches e0's rows
    expect(olderReads(gw).map((r) => r.limit)).toEqual([100, 100]);
    expect(tab.labels()).toEqual(range(1, 1550));
  });

  it("same epoch (unchanged): the pinned trim takes the rows above the hole too, so nothing is owed", () => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    tab.pageAllTheWayUp();
    gw.entries.push(...locals(401, 1550));
    gw.requests = [];
    tab.tailRead(); // a 1150-row delta over the 1000 limit: reset under e0, 551..1550
    expect(tab.labels()).toEqual([...range(1, 400), ...range(551, 1550)]);
    expect(tab.hole).not.toBeNull();
    trimPinned(tab); // cutoff 1150: 1..400 hold e0 seqs, so they go with 551..1149
    expect(tab.labels()).toEqual(range(1150, 1550));
    expect(tab.fillHole(true)).toBe(0);
    expect(tab.hole).toBeNull(); // no hole left to owe: dropped, not kept
    expect(tab.fillHole(false)).toBe(0);
    expect(olderReads(gw)).toHaveLength(0);
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(range(1, 1550));
  });

  it("control (same epoch, trim floor below the hole): pinned, the fill is asked at once", () => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead();
    tab.pageAllTheWayUp();
    gw.entries.push(...locals(401, 700));
    gw.requests = [];
    tab.tailReadWith({ sessionKey: "k", afterSeq: 400, epoch: "e0", limit: 200 }); // reset: 501..700
    trimPinned(tab); // cutoff 300: drops 1..299, below the hole
    expect(tab.labels()).toEqual([...range(300, 400), ...range(501, 700)]);
    expect(tab.fillHole(true)).toBe(1); // 401..500: nothing to wait for
    expect(tab.labels()).toEqual(range(300, 700));
    expect(olderReads(gw)).toHaveLength(1);
  });
});

describe("R33 — a rolled-back gateway rejects the cursor read; the tab re-reads legacy-shaped at once", () => {
  it("probe: cursor window e0 over 301..400, the gateway rolls back and writes 401..450", () => {
    const gw = new FakeGateway(locals(1, 400), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // 301..400, window e0
    gw.cursors = false; // rolled back: cursor params are rejected
    gw.entries.push(...locals(401, 450));
    gw.requests = [];
    tab.tailReadSurvivingRejection();
    expect(tab.labels()).toEqual(range(301, 450));
    expect(gw.requests).toEqual([
      { sessionKey: "k", afterSeq: 400, epoch: "e0", limit: 1000 },
      { sessionKey: "k", limit: 1000 },
    ]);
    expect(tab.window).toEqual(emptyWindow()); // R7 from here on: legacy reads, no cursor
  });
});

describe("R36 — turn numbers count from the transcript's start, not from the page", () => {
  /** Local rows from..to, odd seqs are the owner's prompts (user rows). */
  const turns = (from: number, to: number): Entry[] =>
    locals(from, to).map((e) => ({ ...e, user: (e as { seq: number }).seq % 2 === 1 }));
  const usersUpTo = (n: number) => Math.ceil(n / 2);
  const turnNumber = (tab: Tab) => turnNumberOf(tab.page, tab.window);

  it("a 100-row first open, an older page, a delta, a pinned trim and a restart all agree", () => {
    const gw = new FakeGateway(turns(1, 600), "e0");
    const tab = new Tab(gw);
    tab.tailRead(); // first open: 501..600
    expect(tab.labels()).toEqual(range(501, 600));
    expect(turnNumber(tab)).toBe(usersUpTo(600));
    expect(tab.olderRead()).toBe(true); // 401..500
    expect(turnNumber(tab)).toBe(usersUpTo(600));
    gw.entries.push(...turns(601, 1000));
    tab.tailRead(); // a plain delta: no count on the wire, the window keeps its own
    expect(tab.page).toHaveLength(600);
    expect(turnNumber(tab)).toBe(usersUpTo(1000));
    trimPinned(tab); // drops < 600
    expect(tab.page.length).toBeLessThan(600);
    expect(turnNumber(tab)).toBe(usersUpTo(1000));
    gw.epoch = "e1";
    tab.tailRead(); // restart: reset reply 1..1000, the window claims only what the page holds
    expect(turnNumber(tab)).toBe(usersUpTo(1000));
    tab.pageAllTheWayUp();
    expect(tab.labels()).toEqual(range(1, 1000));
    expect(turnNumber(tab)).toBe(usersUpTo(1000));
  });

  it("with a gateway that does not count, the page's own count (today's behavior)", () => {
    const gw = new FakeGateway(turns(1, 600), "e0");
    gw.countsUsers = false;
    const tab = new Tab(gw);
    tab.tailRead();
    expect(turnNumber(tab)).toBe(50); // 501..600 only
    expect(tab.olderRead()).toBe(true);
    expect(turnNumber(tab)).toBe(100);
  });
});
