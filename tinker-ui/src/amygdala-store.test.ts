import { describe, expect, it, vi } from "vitest";
import { AmygdalaStore } from "./amygdala-store.js";
import type {
  ChangeView,
  InterventionView,
  JevDecision,
  MarkerView,
  StatusView,
} from "./amygdala-types.js";

let seq = 0;
const dec = (o: Partial<JevDecision> = {}): JevDecision => ({
  id: `d${++seq}`,
  ts: 1000 + seq,
  sessionKey: "tab-a",
  turnId: "t1",
  stepLabel: "step",
  seam: "pre",
  questionId: "q1",
  questionName: "test-question",
  version: 1,
  answer: true,
  prob: 0.9,
  confidence: 0.9,
  cacheHit: false,
  latencyMs: 10,
  weak: false,
  codeDid: "ok",
  degraded: false,
  ...o,
});
const iv = (o: Partial<InterventionView> = {}): InterventionView => ({
  id: "i1",
  ts: 2000,
  sessionKey: "tab-a",
  turnId: "t1",
  kind: "hold",
  state: "open",
  title: "title",
  chips: ["a"],
  ...o,
});
const chg = (o: Partial<ChangeView> = {}): ChangeView => ({
  id: "c1",
  kind: "tighten",
  questionName: "test-question",
  from: 1,
  to: 2,
  exceptional: false,
  status: "applied",
  replaySummary: { cases: 1, relaxed: 0, tightened: 1, mustCatchLost: 0, controlsNewlyHeld: 0 },
  ts: 5,
  ...o,
});
const status = (o: Partial<StatusView> = {}): StatusView => ({
  ts: 1,
  state: "working",
  line: "ok",
  mode: "enforce",
  floorActive: false,
  seams: { prompt: { lastTs: 1 }, pre: { lastTs: 1 }, post: { lastTs: 1 }, stop: { lastTs: 1 } },
  rules: { n: 3, version: 1 },
  judge: { lastMs: 5, errors: 0 },
  spendEurToday: 0.5,
  checksToday: 10,
  heldToday: 2,
  askedToday: 1,
  waitingForYou: 0,
  notesDropped: 0,
  ...o,
});

describe("AmygdalaStore events", () => {
  it("dedupes decisions by id and creates the turn at the earliest ts, ordered by ts", () => {
    const s = new AmygdalaStore();
    const late = dec({ ts: 500 });
    const early = dec({ ts: 100 });
    expect(s.applyEvent("amygdala2.decision", late)).toBe(true);
    expect(s.applyEvent("amygdala2.decision", early)).toBe(true);
    expect(s.applyEvent("amygdala2.decision", early)).toBe(false);
    const t = s.turn("t1")!;
    expect(t.decisions.map((d) => d.id)).toEqual([early.id, late.id]);
    expect(t.ts).toBe(100);
    expect(t.sessionKey).toBe("tab-a");
  });

  it("upserts interventions (later state wins, chips and title replaced) and lists open ones newest first", () => {
    const s = new AmygdalaStore();
    s.applyEvent("amygdala2.intervention", iv({ id: "i1", ts: 10 }));
    s.applyEvent("amygdala2.intervention", iv({ id: "i2", ts: 20 }));
    expect(s.openInterventions().map((i) => i.id)).toEqual(["i2", "i1"]);
    expect(
      s.applyEvent(
        "amygdala2.intervention",
        iv({ id: "i1", ts: 10, state: "settled", chips: ["b"], title: "new" }),
      ),
    ).toBe(true);
    expect(
      s.applyEvent(
        "amygdala2.intervention",
        iv({ id: "i1", ts: 10, state: "settled", chips: ["b"], title: "new" }),
      ),
    ).toBe(false);
    expect(s.openInterventions().map((i) => i.id)).toEqual(["i2"]);
    const stored = s.turn("t1")!.interventions.find((i) => i.id === "i1")!;
    expect(stored.chips).toEqual(["b"]);
    expect(stored.title).toBe("new");
    expect(s.openInterventions("other")).toEqual([]);
  });

  it("attaches a refusal intervention to its turn and lets the user keep it", () => {
    const s = new AmygdalaStore();
    s.applyEvent("amygdala2.intervention", iv({ id: "r1", kind: "refusal" }));
    expect(s.turn("t1")!.interventions[0].kind).toBe("refusal");
    expect(s.turn("t1")!.refusalKept).toBeUndefined();
    s.keepRefusal("t1");
    expect(s.turn("t1")!.refusalKept).toBe(true);
  });

  it("attaches markers to the turn", () => {
    const s = new AmygdalaStore();
    const m: MarkerView = {
      kind: "unsupported-after-two",
      sessionKey: "tab-a",
      turnId: "t9",
      items: ["x"],
      ts: 7,
    };
    expect(s.applyEvent("amygdala2.marker", m)).toBe(true);
    expect(s.applyEvent("amygdala2.marker", m)).toBe(false);
    expect(s.turn("t9")!.markers).toEqual([m]);
  });

  it("upserts changes and splits pending from applied", () => {
    const s = new AmygdalaStore();
    s.applyEvent("amygdala2.change", chg({ id: "c1", ts: 1 }));
    s.applyEvent("amygdala2.change", chg({ id: "c2", ts: 9 }));
    s.applyEvent("amygdala2.change", chg({ id: "c3", status: "pending", exceptional: true }));
    expect(s.appliedChanges().map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(s.pendingChanges().map((c) => c.id)).toEqual(["c3"]);
    s.applyEvent("amygdala2.change", chg({ id: "c2", ts: 9, status: "undone" }));
    expect(s.appliedChanges().map((c) => c.id)).toEqual(["c1"]);
    expect(s.state.changes).toHaveLength(3);
  });

  it("status replaces status, spend.eur and counts, keeping the rest of spend", () => {
    const s = new AmygdalaStore();
    s.applyFeed({ spend: { eur: 1, eur30: 20, calls: 300 } });
    expect(
      s.applyEvent(
        "amygdala2.status",
        status({ spendEurToday: 2.5, checksToday: 7, heldToday: 3, askedToday: 4 }),
      ),
    ).toBe(true);
    expect(s.state.spend).toEqual({ eur: 2.5, eur30: 20, calls: 300 });
    expect(s.state.counts).toEqual({ checks: 7, held: 3, asked: 4 });
    expect(s.state.status?.state).toBe("working");
    expect(
      s.applyEvent(
        "amygdala2.status",
        status({ spendEurToday: 2.5, checksToday: 7, heldToday: 3, askedToday: 4 }),
      ),
    ).toBe(false);
  });

  it("the bare refusal event and unknown names change nothing", () => {
    const s = new AmygdalaStore();
    expect(s.applyEvent("amygdala2.refusal", { turnId: "t1" })).toBe(false);
    expect(s.applyEvent("amygdala2.nope", dec())).toBe(false);
    expect(s.applyEvent("something", {})).toBe(false);
  });

  it("ignores malformed payloads without throwing", () => {
    const s = new AmygdalaStore();
    for (const name of ["decision", "intervention", "change", "marker", "status"]) {
      for (const bad of [null, undefined, 5, "x", [], {}, { id: 3 }]) {
        expect(s.applyEvent(`amygdala2.${name}`, bad)).toBe(false);
      }
    }
    expect(s.applyEvent("amygdala2.status", { ...status(), state: "bogus" })).toBe(false);
    expect(s.turnsFor("tab-a")).toEqual([]);
    expect(s.state.status).toBeNull();
  });
});

describe("AmygdalaStore bounds and scoping", () => {
  it("keeps only the newest maxTurns turns, dropping interventions with them", () => {
    const s = new AmygdalaStore({ maxTurns: 2 });
    for (let n = 1; n <= 3; n++) {
      s.applyEvent("amygdala2.decision", dec({ turnId: `T${n}`, ts: n * 10 }));
      s.applyEvent("amygdala2.intervention", iv({ id: `iv${n}`, turnId: `T${n}`, ts: n * 10 }));
    }
    expect(s.turn("T1")).toBeUndefined();
    expect(s.turnsFor("tab-a").map((t) => t.turnId)).toEqual(["T2", "T3"]);
    expect(s.openInterventions().map((i) => i.id)).toEqual(["iv3", "iv2"]);
  });

  it("keeps the newest maxDecisionsPerTurn decisions", () => {
    const s = new AmygdalaStore({ maxDecisionsPerTurn: 3 });
    const ds = [1, 2, 3, 4, 5].map((n) => dec({ ts: n }));
    for (const d of ds) s.applyEvent("amygdala2.decision", d);
    expect(s.turn("t1")!.decisions.map((d) => d.id)).toEqual(ds.slice(2).map((d) => d.id));
    // a dropped id may come back (it is no longer remembered), a kept one may not
    expect(s.applyEvent("amygdala2.decision", ds[4])).toBe(false);
  });

  it("turnsFor returns only the tab's turns, oldest first", () => {
    const s = new AmygdalaStore();
    s.applyEvent("amygdala2.decision", dec({ turnId: "b", sessionKey: "tab-b", ts: 5 }));
    s.applyEvent("amygdala2.decision", dec({ turnId: "a2", ts: 50 }));
    s.applyEvent("amygdala2.decision", dec({ turnId: "a1", ts: 20 }));
    expect(s.turnsFor("tab-a").map((t) => t.turnId)).toEqual(["a1", "a2"]);
    expect(s.turnsFor("tab-b").map((t) => t.turnId)).toEqual(["b"]);
    expect(s.turnsFor("none")).toEqual([]);
    expect(s.openInterventions("tab-b")).toEqual([]);
  });
});

describe("AmygdalaStore feed", () => {
  it("seeds everything and is idempotent", () => {
    const s = new AmygdalaStore();
    const feed = {
      decisionEvents: [dec({ ts: 1 }), dec({ ts: 2 })],
      interventions: [iv()],
      changes: [chg()],
      questions: [
        {
          id: "q1",
          name: "test-question",
          version: 1,
          today: 3,
          right: null,
          status: "active" as const,
        },
      ],
      status: status(),
      spend: { eur: 1, eur30: 2, calls: 3 },
      counts: { checks: 4, held: 5, asked: 6 },
      precedents: 9,
    };
    const fn = vi.fn();
    s.subscribe(fn);
    s.applyFeed(feed);
    expect(fn).toHaveBeenCalledTimes(1);
    const snap = JSON.stringify([s.state, s.turnsFor("tab-a")]);
    s.applyFeed(feed);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([s.state, s.turnsFor("tab-a")])).toBe(snap);
    expect(s.state.precedents).toBe(9);
    expect(s.state.counts).toEqual({ checks: 4, held: 5, asked: 6 });
    expect(s.turn("t1")!.decisions).toHaveLength(2);
  });

  it("merges a partial feed and replaces questions", () => {
    const s = new AmygdalaStore();
    s.applyFeed({ precedents: 2 });
    expect(s.state.precedents).toBe(2);
    expect(s.state.status).toBeNull();
    s.applyFeed({ questions: [] });
    expect(s.state.questions).toEqual([]);
  });
});

describe("AmygdalaStore rewound state", () => {
  it("marks and clears a turn; unknown turns are ignored", () => {
    const s = new AmygdalaStore();
    s.applyEvent("amygdala2.decision", dec());
    s.markRewound("t1", { restoredPrompt: "p", forkSessionId: "f", ts: 9 });
    expect(s.turn("t1")!.rewound).toEqual({ ts: 9, restoredPrompt: "p", forkSessionId: "f" });
    s.clearRewound("t1");
    expect(s.turn("t1")!.rewound).toBeUndefined();
    expect(() => s.markRewound("nope", { ts: 1 })).not.toThrow();
    expect(s.turn("nope")).toBeUndefined();
  });
});

describe("AmygdalaStore dot", () => {
  it("is grey when unavailable, unprobed or without status", () => {
    const s = new AmygdalaStore();
    expect(s.dot()).toBe("grey");
    s.applyEvent("amygdala2.status", status());
    expect(s.dot()).toBe("grey");
    s.setAvailable(false);
    expect(s.dot()).toBe("grey");
    s.setAvailable(true);
    expect(s.dot()).toBe("green");
  });
  it("maps every status state", () => {
    const s = new AmygdalaStore();
    s.setAvailable(true);
    expect(s.dot()).toBe("grey");
    s.applyEvent("amygdala2.status", status({ state: "shadow" }));
    expect(s.dot()).toBe("amber");
    s.applyEvent("amygdala2.status", status({ state: "degraded" }));
    expect(s.dot()).toBe("red");
    s.applyEvent("amygdala2.status", status({ state: "working" }));
    expect(s.dot()).toBe("green");
  });
});

describe("AmygdalaStore hourStrip", () => {
  const at = (h: number, m = 0, day = 15) => new Date(2026, 0, day, h, m, 30).getTime();

  it("buckets by local hour, oldest first, classifying what the code did", () => {
    const s = new AmygdalaStore();
    const now = at(10, 20);
    s.applyEvent("amygdala2.decision", dec({ ts: at(10, 5), codeDid: "ok" }));
    s.applyEvent("amygdala2.decision", dec({ ts: at(10, 6), codeDid: "held" }));
    s.applyEvent("amygdala2.decision", dec({ ts: at(9, 59), codeDid: "note" }));
    s.applyEvent("amygdala2.decision", dec({ ts: at(9, 1), codeDid: "ask" }));
    s.applyEvent("amygdala2.decision", dec({ ts: at(8, 0), codeDid: "sent-back", turnId: "t2" }));
    s.applyEvent("amygdala2.decision", dec({ ts: at(6, 59), codeDid: "ok" })); // outside a 3 h window
    const strip = s.hourStrip(now, 3);
    expect(strip).toEqual([
      { hour: 8, ok: 0, noteAsk: 0, held: 1 },
      { hour: 9, ok: 0, noteAsk: 2, held: 0 },
      { hour: 10, ok: 1, noteAsk: 0, held: 1 },
    ]);
    expect(s.hourStrip(now)).toHaveLength(24);
  });

  it("crosses local midnight and excludes decisions after now's hour", () => {
    const s = new AmygdalaStore();
    const now = at(0, 10, 16);
    s.applyEvent("amygdala2.decision", dec({ ts: at(23, 30, 15), codeDid: "ok" }));
    s.applyEvent("amygdala2.decision", dec({ ts: at(0, 2, 16), codeDid: "held" }));
    s.applyEvent("amygdala2.decision", dec({ ts: at(1, 0, 16), codeDid: "ok" }));
    expect(s.hourStrip(now, 3)).toEqual([
      { hour: 22, ok: 0, noteAsk: 0, held: 0 },
      { hour: 23, ok: 1, noteAsk: 0, held: 0 },
      { hour: 0, ok: 0, noteAsk: 0, held: 1 },
    ]);
  });
});

describe("AmygdalaStore subscribe", () => {
  it("notifies once per changing call, not for no-ops, and stops after unsubscribe", () => {
    const s = new AmygdalaStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.applyEvent("amygdala2.decision", dec());
    expect(fn).toHaveBeenCalledTimes(1);
    s.applyEvent("amygdala2.decision", { bad: true });
    s.setAvailable(null);
    expect(fn).toHaveBeenCalledTimes(1);
    s.setAvailable(true);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    s.setAvailable(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a throwing listener does not stop the others", () => {
    const s = new AmygdalaStore();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = vi.fn();
    s.subscribe(() => {
      throw new Error("boom");
    });
    s.subscribe(ok);
    s.setAvailable(true);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith("[amygdala-ui] listener failed", expect.any(Error));
    err.mockRestore();
  });
});

describe("AmygdalaStore: explanations (2026-10-05)", () => {
  const ev = (status: "pending" | "done" | "failed", extra = {}) => ({
    decisionId: "D1",
    sessionKey: "s",
    turnId: "t1",
    ts: 1,
    status,
    ...extra,
  });

  it("keeps the explainer's words from events and the feed; a late pending never replaces them", () => {
    const st = new AmygdalaStore();
    expect(st.applyEvent("amygdala2.explanation", ev("pending"))).toBe(true);
    expect(st.explanation("D1")!.status).toBe("pending");
    const done = ev("done", {
      explanation: { doing: "a", jev: "b", risk: "low", suggest: -1, replies: [] },
    });
    expect(st.applyEvent("amygdala2.explanation", done)).toBe(true);
    expect(st.applyEvent("amygdala2.explanation", ev("pending"))).toBe(false);
    expect(st.explanation("D1")!.status).toBe("done");
    st.applyFeed({ explanations: [{ ...done, vote: 1, agreed: false }] } as never);
    expect(st.explanation("D1")).toMatchObject({ status: "done", vote: 1, agreed: false });
    expect(st.applyEvent("amygdala2.explanation", { status: "done" })).toBe(false);
  });
});
