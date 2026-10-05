import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadReplayCorpus } from "../src/cases.js";
import { FAMILY_FACTORIES, FAMILY_ORDER } from "../src/families/index.js";
import { ChangeEngine, type ChangeEngineOptions } from "../src/learn/changes.js";
import { contextKey } from "../src/learn/keys.js";
import { caseSituation, replayCorpus, viewFrom } from "../src/learn/replay.js";
import { syncBookFromStore } from "../src/learn/sync.js";
import type { ChangeOutcome, Proposal } from "../src/learn/types.js";
import { QuestionBook } from "../src/question-book.js";
import { buildSituation } from "../src/situation.js";
import { AmygdalaStore } from "../src/store.js";
import type { CaseFile, Cutoff, Verdict } from "../src/types.js";
import { casesRoot, loadCaseFile, seedDir } from "./helpers/family-harness.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---- fixtures -------------------------------------------------------------------------------------------------------

const noveltyMust = loadCaseFile("must-catch", "personality").find(
  (c) => c.id === "mc-pe-novel-io-log",
) as CaseFile;

/** A control that answers `novelty` (post-tool, personality family); the seed cut-off is 0.7. */
function novelCtl(
  id: string,
  answer: number,
  ceiling: "note" | "proceed" = "note",
  effect?: string,
): CaseFile {
  const c = structuredClone(noveltyMust) as CaseFile;
  c.id = id;
  c.kind = "control";
  c.description = "test control";
  delete c.mustBeAtLeast;
  c.mustBeAtMost = ceiling;
  c.answers = { novelty: { answer, prob: answer } };
  if (effect) c.situation.effectClass = { value: effect as never, origin: "derived" };
  return c;
}

/** A temp copy of cases/ with extra controls and must-catch cases; a poisoned eval folder that must never be opened. */
function corpusWith(extraControls: CaseFile[] = [], extraMust: CaseFile[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "amyg-e2-"));
  tmps.push(dir);
  const root = join(dir, "cases");
  cpSync(casesRoot, root, { recursive: true });
  if (extraControls.length) {
    writeFileSync(
      join(root, "controls", "zz-extra.json"),
      JSON.stringify({ cases: extraControls }),
    );
  }
  if (extraMust.length) {
    writeFileSync(join(root, "must-catch", "zz-extra.json"), JSON.stringify({ cases: extraMust }));
  }
  mkdirSync(join(root, "eval"), { recursive: true });
  writeFileSync(join(root, "eval", "poison.json"), "{ this is not json");
  return root;
}

const fams = (book: QuestionBook) => () => FAMILY_ORDER.map((id) => FAMILY_FACTORIES[id]({ book }));

function setup(root: string, o: Partial<ChangeEngineOptions> = {}) {
  const store = new AmygdalaStore(":memory:");
  const book = new QuestionBook({ seedDir });
  const clock = { now: T0 };
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  let n = 0;
  const engine = new ChangeEngine({
    store,
    book,
    families: fams(book),
    casesRoot: root,
    now: () => clock.now,
    idGen: () => `chg-${++n}`,
    emit: (event, payload) => events.push({ event, payload: payload as Record<string, unknown> }),
    autoLoosen: true,
    caps: { perWeek: 10, perDay: 10 },
    ...o,
  });
  return { store, book, clock, events, engine };
}

const cut = (at: number): Proposal => ({
  kind: "cutoff",
  scope: "global",
  questionId: "novelty",
  cutoff: { kind: "prob", at },
});
const changeEvents = (e: { event: string }[]) => e.filter((x) => x.event === "amygdala2.change");
const expectKind = <K extends ChangeOutcome["outcome"]>(o: ChangeOutcome, k: K) => {
  expect(o.outcome).toBe(k);
  return o as Extract<ChangeOutcome, { outcome: K }>;
};

/** A stored, real-looking history item: novelty answered 0.75 on a situation, with the danger/egress verdicts beside it. */
function storeHistory(
  store: AmygdalaStore,
  o: { effect: string; danger: number; tier?: string; dest?: string; ts?: number },
): void {
  const ts = o.ts ?? T0 - DAY;
  const s = buildSituation(
    { seam: "post-tool", sessionKey: "s", turnId: "s#1", now: ts, originKind: "synthetic" },
    { workspaceRoot: "/work/demo", homeDir: "/home/demo" },
  );
  s.effectClass = { value: o.effect as never, origin: "derived" };
  store.saveSituation(s);
  const v = (
    id: string,
    answer: string | number,
    type: Verdict["type"],
    prob: number,
  ): Verdict => ({
    id: `${s.id}-${id}`,
    situationId: s.id,
    questionId: id,
    questionVersion: 1,
    type,
    answer,
    prob,
    confidence: 0.9,
    cacheHit: false,
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    ts,
  });
  const vs = [v("novelty", 0.75, "noul", 0.75), v("danger-level", o.danger, "score", o.danger / 3)];
  if (o.tier) vs.push(v("data-tier", o.tier, "choice", 0.9));
  if (o.dest) vs.push(v("destination-privacy", o.dest, "choice", 0.9));
  store.saveVerdicts(vs);
}

const activeOf = (s: { book: QuestionBook; store: AmygdalaStore }) => ({
  book: s.book.activeVersion("novelty"),
  store: s.store.activeVersion("novelty"),
});

// ---- 1. two-sided replay --------------------------------------------------------------------------------------------

describe("two-sided replay on the real corpus", () => {
  it("a tightening that would hold three controls is rejected and nothing is applied", async () => {
    const t = setup(casesRoot);
    const o = expectKind(
      await t.engine.propose({
        kind: "cutoff",
        scope: "global",
        questionId: "dodged-work",
        cutoff: { kind: "choice", option: "complete", at: 0.05, negate: true },
      }),
      "rejected",
    );
    expect(o.reason).toBe("controls-held");
    expect(o.change?.status).toBe("rejected");
    expect(o.change?.replay.controlsNewlyHeld).toBeGreaterThanOrEqual(3);
    expect(t.book.activeVersion("dodged-work")).toBe(1);
    expect(t.store.activeVersion("dodged-work")).toBeUndefined();
    expect(t.store.listChanges({ status: "applied" })).toHaveLength(0);
    expect(changeEvents(t.events)).toHaveLength(0);
  });

  it("a change that would lose a must-catch case is rejected", async () => {
    const t = setup(casesRoot);
    const o = expectKind(
      await t.engine.propose({
        kind: "cutoff",
        scope: "global",
        questionId: "misreading-screen",
        cutoff: { kind: "prob", at: 0.95 },
      }),
      "rejected",
    );
    expect(o.reason).toBe("must-catch-lost");
    expect(o.change?.replay.mustCatchLost).toBeGreaterThan(0);
    expect(o.change?.replay.mustCatchTotal).toBeGreaterThan(0);
    expect(t.store.activeVersion("misreading-screen")).toBeUndefined();
    expect(t.store.listChanges({ status: "rejected" })).toHaveLength(1);
  });

  it("retiring a question a must-catch case depends on is rejected", async () => {
    const t = setup(casesRoot);
    const o = expectKind(
      await t.engine.propose({ kind: "retire", questionId: "novelty" }),
      "rejected",
    );
    expect(o.reason).toBe("must-catch-lost");
  });

  it("an unknown question and a hard-rule id are rejected and persist nothing", async () => {
    const t = setup(casesRoot);
    const bad = expectKind(
      await t.engine.propose({ kind: "retire", questionId: "no-such-question" }),
      "rejected",
    );
    expect(bad).toMatchObject({ reason: "unknown-question", change: null });
    for (const id of ["hard-rule-delete", "hard-rule"]) {
      for (const p of [
        { kind: "retire", questionId: id },
        { kind: "cutoff", scope: "global", questionId: id, cutoff: { kind: "prob", at: 0.1 } },
        { kind: "reword", questionId: id, candidate: { instructions: "test-instructions" } },
      ] as Proposal[]) {
        expect(expectKind(await t.engine.propose(p), "rejected")).toMatchObject({
          reason: "hard-rule",
          change: null,
        });
      }
    }
    expect(t.store.listChanges().filter((c) => c.questionId.startsWith("hard-rule"))).toHaveLength(
      0,
    );
  });
});

// ---- 2. the always-trust policy -------------------------------------------------------------------------------------

describe("always-trust policy", () => {
  it("a clean loosening applies itself, creates no pending and interrupts nothing", async () => {
    const root = corpusWith([novelCtl("ctl-test-mid", 0.75, "note", "local-write")]);
    const t = setup(root);
    const o = expectKind(await t.engine.propose(cut(0.8)), "applied");
    expect(o.change).toMatchObject({
      kind: "loosen",
      status: "applied",
      exceptional: false,
      fromVersion: 1,
      toVersion: 2,
    });
    expect(o.change.replay.relaxed).toBe(1);
    expect(o.change.replay.mustCatchLost).toBe(0);
    expect(activeOf(t)).toEqual({ book: 2, store: 2 });
    expect(t.book.get("novelty")?.cutoff).toEqual({ kind: "prob", at: 0.8 });
    expect(t.book.get("novelty")?.parent).toBe(1);
    expect(t.engine.pending()).toHaveLength(0);
    const ev = changeEvents(t.events);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ kind: "loosen", exceptional: false, status: "applied" });
  });

  it("a scratch-folder cleanup at danger 1 in the stored history is clean", async () => {
    const t = setup(corpusWith());
    storeHistory(t.store, { effect: "local-write", danger: 1 });
    const o = expectKind(await t.engine.propose(cut(0.8)), "applied");
    expect(o.change.replay.relaxed).toBe(1);
    expect(o.change.exceptional).toBe(false);
  });

  it("danger level 3 in the stored history makes it exceptional: pending, one event", async () => {
    const t = setup(corpusWith());
    storeHistory(t.store, { effect: "local-write", danger: 3 });
    const o = expectKind(await t.engine.propose(cut(0.8)), "pending");
    expect(o.change).toMatchObject({ status: "pending", exceptional: true, kind: "loosen" });
    expect(t.book.activeVersion("novelty")).toBe(1);
    expect(t.store.activeVersion("novelty")).toBeUndefined();
    expect(t.engine.pending().map((c) => c.id)).toEqual([o.change.id]);
    const ev = changeEvents(t.events);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ status: "pending", exceptional: true });
  });

  it("data leaving (egress) makes it exceptional", async () => {
    const t = setup(corpusWith());
    storeHistory(t.store, {
      effect: "local-write",
      danger: 1,
      tier: "harmful-if-seen",
      dest: "public",
    });
    expectKind(await t.engine.propose(cut(0.8)), "pending");
    const t2 = setup(corpusWith());
    storeHistory(t2.store, {
      effect: "local-write",
      danger: 1,
      tier: "harmless-if-seen",
      dest: "public",
    });
    expectKind(await t2.engine.propose(cut(0.8)), "applied");
  });

  it.each(["send", "spend", "restart-own-system", "delete"])(
    "an external effect class (%s) in the replay corpus makes it exceptional",
    async (effect) => {
      const t = setup(corpusWith([novelCtl("ctl-test-ext", 0.75, "note", effect)]));
      expectKind(await t.engine.propose(cut(0.8)), "pending");
      expect(changeEvents(t.events)).toHaveLength(1);
    },
  );

  it("a stored external effect class makes it exceptional; a local write does not", async () => {
    const t = setup(corpusWith());
    storeHistory(t.store, { effect: "send", danger: 1 });
    expectKind(await t.engine.propose(cut(0.8)), "pending");
  });

  it("emits the pending event at most once per 24 hours; later pendings stay in pending()", async () => {
    const t = setup(corpusWith([novelCtl("ctl-test-ext", 0.75, "note", "send")]));
    const a = expectKind(await t.engine.propose(cut(0.8)), "pending");
    t.clock.now += 3 * 3_600_000;
    const b = expectKind(await t.engine.propose(cut(0.82)), "pending");
    expect(changeEvents(t.events)).toHaveLength(1);
    expect(
      t.engine
        .pending()
        .map((c) => c.id)
        .toSorted(),
    ).toEqual([a.change.id, b.change.id].toSorted());
    t.clock.now += 22 * 3_600_000;
    expectKind(await t.engine.propose(cut(0.84)), "pending");
    expect(changeEvents(t.events)).toHaveLength(2);
    expect(t.engine.pending()).toHaveLength(3);
  });

  it("the once-per-day limit survives a restart (seeded from the store)", async () => {
    const root = corpusWith([novelCtl("ctl-test-ext", 0.75, "note", "send")]);
    const t = setup(root);
    expectKind(await t.engine.propose(cut(0.8)), "pending");
    const events2: unknown[] = [];
    const again = new ChangeEngine({
      store: t.store,
      book: t.book,
      families: fams(t.book),
      casesRoot: root,
      now: () => t.clock.now + 1000,
      emit: (e) => events2.push(e),
      autoLoosen: true,
      caps: { perWeek: 10, perDay: 10 },
    });
    expectKind(await again.propose(cut(0.82)), "pending");
    expect(events2).toHaveLength(0);
  });

  it("caps: the 3rd loosening of one question within 7 days is deferred (cap-week), and passes after 7 days", async () => {
    const root = corpusWith([
      novelCtl("ctl-a", 0.72),
      novelCtl("ctl-b", 0.77),
      novelCtl("ctl-c", 0.82),
      novelCtl("ctl-d", 0.86),
    ]);
    const t = setup(root, { caps: { perWeek: 2, perDay: 50 } });
    expectKind(await t.engine.propose(cut(0.75)), "applied");
    expectKind(await t.engine.propose(cut(0.8)), "applied");
    expect(expectKind(await t.engine.propose(cut(0.85)), "deferred").reason).toBe("cap-week");
    expect(t.book.activeVersion("novelty")).toBe(3);
    expect(t.store.listChanges({ status: "applied" })).toHaveLength(2);
    t.clock.now += 8 * DAY;
    expectKind(await t.engine.propose(cut(0.85)), "applied");
  });

  it("caps: the daily cap counts every clean loosening and lifts after 24 hours", async () => {
    const root = corpusWith([
      novelCtl("ctl-a", 0.72),
      novelCtl("ctl-b", 0.77),
      novelCtl("ctl-c", 0.82),
    ]);
    const t = setup(root, { caps: { perWeek: 50, perDay: 2 } });
    expectKind(await t.engine.propose(cut(0.75)), "applied");
    expectKind(await t.engine.propose(cut(0.8)), "applied");
    expect(expectKind(await t.engine.propose(cut(0.85)), "deferred").reason).toBe("cap-day");
    t.clock.now += 25 * 3_600_000;
    expectKind(await t.engine.propose(cut(0.85)), "applied");
  });

  it("an exceptional loosening does not count against the caps", async () => {
    const root = corpusWith([novelCtl("ctl-a", 0.72), novelCtl("ctl-ext", 0.77, "note", "send")]);
    const t = setup(root, { caps: { perWeek: 1, perDay: 1 } });
    expectKind(await t.engine.propose(cut(0.75)), "applied");
    // the send-class control now relaxes, so this one is exceptional and waits for a person, cap or no cap
    expectKind(await t.engine.propose(cut(0.8)), "pending");
  });

  it("autoLoosen off defers a clean loosening; a tightening still applies", async () => {
    const root = corpusWith([novelCtl("ctl-a", 0.75), novelCtl("ctl-t", 0.65)]);
    const t = setup(root, { autoLoosen: false });
    expect(expectKind(await t.engine.propose(cut(0.8)), "deferred").reason).toBe("auto-loosen-off");
    expect(t.store.listChanges()).toHaveLength(0);
    expect(t.book.activeVersion("novelty")).toBe(1);
    const tight = expectKind(await t.engine.propose(cut(0.6)), "applied");
    expect(tight.change.kind).toBe("tighten");
  });

  it("is blocked for 30 days after an undo, allowed after", async () => {
    const t = setup(corpusWith([novelCtl("ctl-a", 0.72), novelCtl("ctl-b", 0.77)]));
    const a = expectKind(await t.engine.propose(cut(0.75)), "applied");
    expect(t.engine.undo(a.change.id).ok).toBe(true);
    const row = t.store.getChange(a.change.id);
    expect(row?.status).toBe("undone");
    expect(row?.blockedUntil).toBe(T0 + 30 * DAY);
    // the same scope, even a different cut-off, is blocked
    expect(expectKind(await t.engine.propose(cut(0.75)), "rejected")).toMatchObject({
      reason: "blocked",
      change: null,
    });
    expect(expectKind(await t.engine.propose(cut(0.8)), "rejected").reason).toBe("blocked");
    t.clock.now += 29 * DAY;
    expect(expectKind(await t.engine.propose(cut(0.75)), "rejected").reason).toBe("blocked");
    t.clock.now += 2 * DAY;
    expectKind(await t.engine.propose(cut(0.75)), "applied");
    // the immutable version the undo left behind stays; the next one is numbered above it
    expect(t.book.activeVersion("novelty")).toBe(3);
    expect(t.book.get("novelty", 2)).toBeDefined();
  });

  it("the block is per scope: a global undo does not block a context loosening", async () => {
    const ctl = novelCtl("ctl-a", 0.72);
    const t = setup(corpusWith([ctl]));
    const a = expectKind(await t.engine.propose(cut(0.75)), "applied");
    t.engine.undo(a.change.id);
    const key = contextKey(caseSituation(ctl, "post-tool"), "novelty");
    expectKind(
      await t.engine.propose({
        kind: "cutoff",
        scope: "context",
        questionId: "novelty",
        contextKey: key,
        cutoff: { kind: "prob", at: 0.75 },
      }),
      "applied",
    );
  });
});

// ---- 3. undo is exact -----------------------------------------------------------------------------------------------

describe("undo is exact", () => {
  it("a global change: the whole corpus replays identically after apply then undo", async () => {
    const root = corpusWith([novelCtl("ctl-a", 0.75)]);
    const t = setup(root);
    const corpus = loadReplayCorpus(root);
    const run = () =>
      JSON.stringify(replayCorpus(corpus, viewFrom(t.book, t.store), fams(t.book)()));
    const before = run();
    const o = expectKind(await t.engine.propose(cut(0.8)), "applied");
    expect(run()).not.toBe(before);
    expect(t.engine.undo(o.change.id).ok).toBe(true);
    expect(run()).toBe(before);
    expect(activeOf(t)).toEqual({ book: 1, store: 1 });
    expect(t.book.get("novelty")?.cutoff).toEqual({ kind: "prob", at: 0.7 });
    // the new version stays stored, immutable, and is not active
    expect(t.store.getQuestionVersion("novelty", 2)?.cutoff).toEqual({ kind: "prob", at: 0.8 });
    expect(t.book.get("novelty", 2)).toBeDefined();
    expect(t.store.activeVersion("novelty")).not.toBe(2);
    // and it comes back the same way after a restart
    const fresh = new QuestionBook({ seedDir });
    syncBookFromStore(fresh, t.store);
    expect(fresh.activeVersion("novelty")).toBe(1);
    expect(fresh.get("novelty", 2)).toBeDefined();
  });

  it("a context change: the override row is removed and the corpus replays identically", async () => {
    const ctl = novelCtl("ctl-a", 0.75);
    const root = corpusWith([ctl]);
    const t = setup(root);
    const key = contextKey(caseSituation(ctl, "post-tool"), "novelty");
    const corpus = loadReplayCorpus(root);
    const run = () =>
      JSON.stringify(replayCorpus(corpus, viewFrom(t.book, t.store), fams(t.book)()));
    const before = run();
    const o = expectKind(
      await t.engine.propose({
        kind: "cutoff",
        scope: "context",
        questionId: "novelty",
        contextKey: key,
        cutoff: { kind: "prob", at: 0.8 },
      }),
      "applied",
    );
    expect(o.change).toMatchObject({ kind: "context-loosen", toVersion: null });
    expect(t.store.getContextOverride("novelty", key)).toEqual({ kind: "prob", at: 0.8 });
    expect(t.book.activeVersion("novelty")).toBe(1);
    expect(run()).not.toBe(before);
    expect(t.engine.undo(o.change.id).ok).toBe(true);
    expect(t.store.getContextOverride("novelty", key)).toBeUndefined();
    expect(run()).toBe(before);
  });

  it("a context change over an earlier override restores that override", async () => {
    const ctl = novelCtl("ctl-a", 0.75);
    const t = setup(corpusWith([ctl, novelCtl("ctl-b", 0.72)]));
    const key = contextKey(caseSituation(ctl, "post-tool"), "novelty");
    const earlier: Cutoff = { kind: "prob", at: 0.74 };
    t.store.saveContextOverride({
      questionId: "novelty",
      contextKey: key,
      cutoff: earlier,
      changeId: "old",
    });
    const o = expectKind(
      await t.engine.propose({
        kind: "cutoff",
        scope: "context",
        questionId: "novelty",
        contextKey: key,
        cutoff: { kind: "prob", at: 0.8 },
      }),
      "applied",
    );
    t.engine.undo(o.change.id);
    expect(t.store.getContextOverride("novelty", key)).toEqual(earlier);
  });

  it("a tightening is undone and the undo is recorded", async () => {
    const t = setup(corpusWith([novelCtl("ctl-t", 0.65)]));
    const o = expectKind(await t.engine.propose(cut(0.6)), "applied");
    expect(t.engine.undo(o.change.id).ok).toBe(true);
    expect(t.store.getChange(o.change.id)?.status).toBe("undone");
    expect(t.book.get("novelty")?.cutoff).toEqual({ kind: "prob", at: 0.7 });
  });

  it("only an applied change can be undone, and not under a newer one", async () => {
    const t = setup(corpusWith([novelCtl("ctl-a", 0.72), novelCtl("ctl-b", 0.77)]));
    expect(t.engine.undo("nope")).toMatchObject({ ok: false, reason: "unknown-change" });
    const a = expectKind(await t.engine.propose(cut(0.75)), "applied");
    const b = expectKind(await t.engine.propose(cut(0.8)), "applied");
    expect(t.engine.undo(a.change.id)).toMatchObject({ ok: false, reason: "superseded" });
    expect(t.engine.undo(b.change.id).ok).toBe(true);
    expect(t.engine.undo(b.change.id)).toMatchObject({ ok: false, reason: "not-applied" });
    expect(t.engine.undo(a.change.id).ok).toBe(true);
    expect(t.book.activeVersion("novelty")).toBe(1);
  });
});

// ---- 4. approve / reject --------------------------------------------------------------------------------------------

describe("approve and reject", () => {
  const exceptionalRoot = () => corpusWith([novelCtl("ctl-ext", 0.75, "note", "send")]);

  it("approving a pending change re-checks the replay and applies it", async () => {
    const t = setup(exceptionalRoot());
    const p = expectKind(await t.engine.propose(cut(0.8)), "pending");
    const a = expectKind(await t.engine.approve(p.change.id, true), "applied");
    expect(a.change.status).toBe("applied");
    expect(t.store.getChange(p.change.id)?.status).toBe("applied");
    expect(activeOf(t)).toEqual({ book: 2, store: 2 });
    expect(t.engine.pending()).toHaveLength(0);
    expect(changeEvents(t.events).map((e) => e.payload.status)).toEqual(["pending", "applied"]);
    expect(t.engine.undo(p.change.id).ok).toBe(true);
    expect(t.book.activeVersion("novelty")).toBe(1);
  });

  it("approving after the world changed so a must-catch case would now be lost is rejected", async () => {
    const root = exceptionalRoot();
    const t = setup(root);
    const p = expectKind(await t.engine.propose(cut(0.8)), "pending");
    // a new must-catch case appears that the looser cut-off would lose
    const late = structuredClone(noveltyMust) as CaseFile;
    late.id = "mc-late-arrival";
    late.answers = { novelty: { answer: 0.75, prob: 0.75 } };
    writeFileSync(join(root, "must-catch", "zz-late.json"), JSON.stringify({ cases: [late] }));
    const r = expectKind(await t.engine.approve(p.change.id, true), "rejected");
    expect(r.reason).toBe("must-catch-lost");
    expect(t.store.getChange(p.change.id)?.status).toBe("rejected");
    expect(t.book.activeVersion("novelty")).toBe(1);
    expect(t.store.activeVersion("novelty")).toBeUndefined();
  });

  it("approving after the question moved on is rejected as stale", async () => {
    const t = setup(
      corpusWith([novelCtl("ctl-ext", 0.75, "note", "send"), novelCtl("ctl-t", 0.65)]),
    );
    const p = expectKind(await t.engine.propose(cut(0.8)), "pending");
    expectKind(await t.engine.propose(cut(0.6)), "applied"); // a tightening lands meanwhile
    const r = expectKind(await t.engine.approve(p.change.id, true), "rejected");
    expect(r.reason).toBe("no-effect");
    expect(t.book.get("novelty")?.cutoff).toEqual({ kind: "prob", at: 0.6 });
  });

  it("rejecting sets the 30-day block and applies nothing", async () => {
    const t = setup(exceptionalRoot());
    const p = expectKind(await t.engine.propose(cut(0.8)), "pending");
    const r = expectKind(await t.engine.approve(p.change.id, false), "rejected");
    expect(r.change?.status).toBe("rejected");
    const row = t.store.getChange(p.change.id);
    expect(row?.status).toBe("rejected");
    expect(row?.blockedUntil).toBe(T0 + 30 * DAY);
    expect(t.book.activeVersion("novelty")).toBe(1);
    expect(expectKind(await t.engine.propose(cut(0.8)), "rejected").reason).toBe("blocked");
    t.clock.now += 31 * DAY;
    expectKind(await t.engine.propose(cut(0.8)), "pending");
  });

  it("only a pending change can be approved", async () => {
    const t = setup(corpusWith([novelCtl("ctl-a", 0.75)]));
    const a = expectKind(await t.engine.propose(cut(0.8)), "applied");
    expect(expectKind(await t.engine.approve(a.change.id, true), "rejected").reason).toBe(
      "no-effect",
    );
    expect(expectKind(await t.engine.approve("missing", true), "rejected").change).toBeNull();
    expect(t.book.activeVersion("novelty")).toBe(2);
  });
});

// ---- 5. the eval set never leaks -----------------------------------------------------------------------------------

describe("the eval set never enters replay", () => {
  it("an eval case planted in must-catch/ makes propose reject with the loader's error", async () => {
    const root = corpusWith();
    const planted = structuredClone(noveltyMust) as CaseFile;
    planted.id = "eval-planted";
    planted.kind = "eval";
    writeFileSync(
      join(root, "must-catch", "zz-planted.json"),
      JSON.stringify({ cases: [planted] }),
    );
    const t = setup(root);
    await expect(t.engine.propose(cut(0.8))).rejects.toThrow(/eval-planted.*eval/);
    expect(t.store.listChanges()).toHaveLength(0);
  });

  it("the eval folder is never opened (a poisoned file there changes nothing)", async () => {
    const t = setup(corpusWith([novelCtl("ctl-a", 0.75)]));
    // corpusWith writes an unparseable file into eval/; opening it would throw
    expectKind(await t.engine.propose(cut(0.8)), "applied");
  });
});

// ---- 6. direction, no-effect, reword --------------------------------------------------------------------------------

describe("direction and reword", () => {
  it("a tightening applies with no caps and no card", async () => {
    const t = setup(corpusWith([novelCtl("ctl-t", 0.65)]), {
      autoLoosen: false,
      caps: { perWeek: 0, perDay: 0 },
    });
    const o = expectKind(await t.engine.propose(cut(0.6)), "applied");
    expect(o.change).toMatchObject({ kind: "tighten", exceptional: false });
    expect(o.change.replay).toMatchObject({ relaxed: 0, tightened: 1 });
    expect(t.engine.pending()).toHaveLength(0);
  });

  it("a proposal that changes nothing is rejected as no-effect and persists nothing", async () => {
    const t = setup(corpusWith());
    const o = expectKind(await t.engine.propose(cut(0.7)), "rejected");
    expect(o).toMatchObject({ reason: "no-effect", change: null });
    expect(t.store.listChanges()).toHaveLength(0);
  });

  // a case id on the held-out (30 %) or the training (70 %) side of the stable split
  const idOn = (heldOut: boolean, prefix: string) => {
    for (let i = 0; ; i++) {
      const id = `${prefix}-${i}`;
      if (createHash("sha256").update(id).digest()[0]! % 100 >= 70 === heldOut) return id;
    }
  };
  const reword: Proposal = {
    kind: "reword",
    questionId: "novelty",
    candidate: { instructions: "test-instructions" },
  };

  it("without a live judge a reword is rejected as no-effect", async () => {
    const t = setup(corpusWith());
    expect(expectKind(await t.engine.propose(reword), "rejected")).toMatchObject({
      reason: "no-effect",
      change: null,
    });
  });

  it("a reword is accepted only when strictly better on the held-out part", async () => {
    // fails its ceiling now (a note where nothing was wanted); the candidate answers it low
    const better = novelCtl(idOn(true, "ctl-better"), 0.75, "proceed");
    const root = corpusWith([better]);
    const asked: string[] = [];
    const t = setup(root, {
      live: async (q, c) => {
        asked.push(`${c.id}@v${q.version}`);
        return c.id === better.id ? { answer: 0.1, prob: 0.1 } : null;
      },
    });
    const o = expectKind(await t.engine.propose(reword), "applied");
    expect(o.change).toMatchObject({
      kind: "reword",
      fromVersion: 1,
      toVersion: 2,
      status: "applied",
    });
    expect(o.change.replay.heldOutBetter).toBe(true);
    expect(o.change.replay.liveCalls).toBe(asked.length);
    expect(asked).toContain(`${better.id}@v2`);
    const q2 = t.book.get("novelty");
    expect(q2).toMatchObject({
      version: 2,
      origin: "learned",
      instructions: "test-instructions",
      parent: 1,
    });
    expect(t.store.getQuestionVersion("novelty", 2)?.instructions).toBe("test-instructions");
    expect(t.store.activeVersion("novelty")).toBe(2);
  });

  it("a reword that is better only on the training part is rejected (and recorded)", async () => {
    const trainOnly = novelCtl(idOn(false, "ctl-train"), 0.75, "proceed");
    const t = setup(corpusWith([trainOnly]), {
      live: async (_q, c) => (c.id === trainOnly.id ? { answer: 0.1, prob: 0.1 } : null),
    });
    const o = expectKind(await t.engine.propose(reword), "rejected");
    expect(o.reason).toBe("no-effect");
    expect(o.change?.status).toBe("rejected");
    expect(o.change?.replay.heldOutBetter).toBe(false);
    expect(t.book.activeVersion("novelty")).toBe(1);
    expect(t.store.getQuestionVersion("novelty", 2)).toBeUndefined();
  });

  it("a reword whose answers do not change anything is rejected as no-effect and persists nothing", async () => {
    const t = setup(corpusWith(), { live: async () => null });
    expect(expectKind(await t.engine.propose(reword), "rejected")).toMatchObject({
      reason: "no-effect",
      change: null,
    });
    expect(t.store.listChanges()).toHaveLength(0);
  });

  it("stops asking the live judge at maxLiveCalls", async () => {
    let calls = 0;
    const t = setup(
      corpusWith([novelCtl("ctl-a", 0.75), novelCtl("ctl-b", 0.72), novelCtl("ctl-c", 0.71)]),
      {
        maxLiveCalls: 2,
        live: async () => {
          calls++;
          return null;
        },
      },
    );
    await t.engine.propose(reword);
    expect(calls).toBe(2);
  });

  it("a reword that loses a must-catch case is rejected", async () => {
    const t = setup(casesRoot, {
      live: async (_q, c) => (c.id === "mc-pe-novel-io-log" ? { answer: 0.05, prob: 0.05 } : null),
    });
    const o = expectKind(await t.engine.propose(reword), "rejected");
    expect(o.reason).toBe("must-catch-lost");
  });

  it("a mixed reword (one case relaxed, another tightened) is treated as a loosening", async () => {
    const relaxes = novelCtl(idOn(true, "ctl-relax"), 0.75, "proceed");
    const tightens = novelCtl("ctl-tighten", 0.65, "note");
    const live: ChangeEngineOptions["live"] = async (_q, c) =>
      c.id === relaxes.id
        ? { answer: 0.1, prob: 0.1 }
        : c.id === tightens.id
          ? { answer: 0.95, prob: 0.95 }
          : null;
    // autoLoosen off would defer a loosening but never a tightening: it defers, so mixed counted as loosening
    const off = setup(corpusWith([relaxes, tightens]), { autoLoosen: false, live });
    expect(expectKind(await off.engine.propose(reword), "deferred").reason).toBe("auto-loosen-off");
    const on = setup(corpusWith([relaxes, tightens]), { live });
    const o = expectKind(await on.engine.propose(reword), "applied");
    expect(o.change.replay).toMatchObject({ relaxed: 1, tightened: 1 });
  });

  it("retiring a question that no case and no stored answer uses has no effect", async () => {
    const t = setup(casesRoot);
    const o = expectKind(
      await t.engine.propose({ kind: "retire", questionId: "request-difficulty" }),
      "rejected",
    );
    expect(o).toMatchObject({ reason: "no-effect", change: null });
  });
});
