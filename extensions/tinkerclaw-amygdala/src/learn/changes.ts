/**
 * The change engine (design doc §7.3 items 3-5, C11-C13): every change to a question is replayed two-sided against the
 * must-catch cases and the controls, gated by the always-trust policy, applied, and undoable exactly.
 *
 * Policy (the principal's): a tightening applies at once; a clean loosening applies itself under caps and shows up
 * with Undo; an EXCEPTIONAL loosening (danger 3, data leaving, external effect class) is the only kind that becomes a
 * card (`pending`); hard rules are code and are never proposable. Retune and the nightly lane reach questions only
 * through `propose`.
 */
import { createHash, randomUUID } from "node:crypto";
import { loadReplayCorpus } from "../cases.js";
import type { Family } from "../families/index.js";
import { type QuestionBook, validateQuestion } from "../question-book.js";
import { SEVERITY } from "../respond.js";
import { buildSituation } from "../situation.js";
import type { AmygdalaStore } from "../store.js";
import type { CaseFile, Change, Cutoff, Question, ReplayReport, Situation } from "../types.js";
import {
  caseDetail,
  caseSituation,
  replayCorpus,
  storedDetail,
  verdictCrosses,
  viewFrom,
  viewWith,
  type AnswerOverride,
} from "./replay.js";
import type { ChangeEngineApi, ChangeOutcome, Proposal, RejectReason } from "./types.js";

const DAY_MS = 86_400_000;
const EXTERNAL_EFFECTS = ["send", "spend", "restart-own-system", "delete"];
const HISTORY_DAYS = 30;

export interface ChangeEngineOptions {
  store: AmygdalaStore;
  book: QuestionBook;
  families: () => Family[];
  casesRoot: string;
  now?: () => number;
  idGen?: () => string;
  emit?: (event: string, payload: unknown) => void;
  autoLoosen: boolean;
  caps: { perWeek: number; perDay: number };
  blockDays?: number;
  /** Asks the judge the candidate question for a case (Jev in production, scripted in tests). null keeps the scripted answer. */
  live?: (q: Question, c: CaseFile) => Promise<AnswerOverride | null>;
  maxLiveCalls?: number;
}

/** What is stored in `Change.replay`: the report, the proposal it belongs to and what an undo must restore. */
interface StoredReplay extends ReplayReport {
  previousCutoff?: Cutoff | null;
}

interface Analysis {
  report: ReplayReport;
  exceptional: boolean;
  /** Reword only: the candidate did not pass validation. */
  invalid: boolean;
}

const isProposal = (v: unknown): v is Proposal =>
  typeof v === "object" && v !== null && typeof (v as { kind?: unknown }).kind === "string";

/** Stable 70/30 split: true = held-out (30 %). */
function heldOut(caseId: string): boolean {
  return createHash("sha256").update(caseId).digest()[0]! % 100 >= 70;
}

function scopeOf(p: Proposal): string {
  return p.kind === "cutoff" && p.scope === "context" ? `context:${p.contextKey}` : "global";
}

export class ChangeEngine implements ChangeEngineApi {
  private readonly o: ChangeEngineOptions;
  private readonly now: () => number;
  private readonly idGen: () => string;
  private readonly blockDays: number;
  /** When the last "pending" event went out; seeded from the store so a restart does not send a second one. */
  private lastPendingEvent: number;

  constructor(o: ChangeEngineOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.idGen = o.idGen ?? randomUUID;
    this.blockDays = o.blockDays ?? 30;
    const prior = o.store.listChanges().filter((c) => c.exceptional);
    this.lastPendingEvent = prior.length ? Math.max(...prior.map((c) => c.ts)) : -Infinity;
  }

  // ---- replay ----------------------------------------------------------------

  private probeSituation(): Situation {
    return buildSituation(
      {
        seam: "pre-tool",
        sessionKey: "replay",
        turnId: "replay#1",
        now: this.now(),
        originKind: "synthetic",
      },
      { workspaceRoot: "/work/demo", homeDir: "/home/demo" },
    );
  }

  private async analyse(p: Proposal): Promise<Analysis> {
    const { store, book } = this.o;
    const corpus = loadReplayCorpus(this.o.casesRoot); // a poisoned corpus throws: let it propagate
    const families = this.o.families();
    const before = viewFrom(book, store);
    const after = viewWith(before, p);

    let liveCalls = 0;
    let invalid = false;
    const overrides = new Map<string, Record<string, AnswerOverride>>();
    if (p.kind === "reword") {
      const q2 = after(p.questionId, this.probeSituation());
      invalid = !q2 || validateQuestion(q2).length > 0;
      if (!invalid && this.o.live) {
        const max = this.o.maxLiveCalls ?? 300;
        for (const c of corpus) {
          if (!c.answers?.[p.questionId]) continue;
          if (liveCalls >= max) break;
          const cq = after(p.questionId, caseSituation(c));
          if (!cq) continue;
          liveCalls++;
          const a = await this.o.live(cq, c);
          if (a) overrides.set(c.id, { [p.questionId]: a });
        }
      }
    }

    const beforeRes = replayCorpus(corpus, before, families);
    const afterRes = replayCorpus(corpus, after, families, overrides);
    let relaxed = 0;
    let tightened = 0;
    let mustCatchTotal = 0;
    let mustCatchLost = 0;
    let controlsTotal = 0;
    let controlsNewlyHeld = 0;
    let exceptional = false;
    let okBeforeHeld = 0;
    let okAfterHeld = 0;
    const isExceptional = (d: {
      effectClass: string | null;
      danger: number | null;
      egress: boolean;
    }) =>
      (d.danger ?? 0) >= 3 ||
      d.egress ||
      (d.effectClass !== null && EXTERNAL_EFFECTS.includes(d.effectClass));

    corpus.forEach((c, i) => {
      const b = beforeRes[i]!;
      const a = afterRes[i]!;
      const sb = SEVERITY[b.response];
      const sa = SEVERITY[a.response];
      if (sa < sb) {
        relaxed++;
        if (isExceptional(caseDetail(c))) exceptional = true;
      } else if (sa > sb) tightened++;
      if (c.kind === "must-catch") {
        mustCatchTotal++;
        if (b.ok && !a.ok) mustCatchLost++;
      } else if (c.kind === "control") {
        controlsTotal++;
        if (b.ok && !a.ok) controlsNewlyHeld++;
      }
      if (heldOut(c.id)) {
        if (b.ok) okBeforeHeld++;
        if (a.ok) okAfterHeld++;
      }
    });

    // The stored, labelled history of the question: which real verdicts would flip.
    let stored = 0;
    if (p.kind === "cutoff") {
      const since = this.now() - HISTORY_DAYS * DAY_MS;
      for (const v of store.queryVerdicts({ questionId: p.questionId, sinceTs: since })) {
        const rec = store.situationRecord(v.situationId);
        const s = rec ?? this.probeSituation();
        stored++;
        const wasIn = verdictCrosses(before, s, v);
        const isIn = verdictCrosses(after, s, v);
        if (wasIn && !isIn) {
          relaxed++;
          if (
            isExceptional(storedDetail(rec, store.queryVerdicts({ situationId: v.situationId })))
          ) {
            exceptional = true;
          }
        } else if (!wasIn && isIn) tightened++;
      }
    }

    const report: ReplayReport = {
      cases: corpus.length + stored,
      relaxed,
      tightened,
      mustCatchTotal,
      mustCatchLost,
      controlsTotal,
      controlsNewlyHeld,
      heldOutBetter: p.kind === "reword" ? okAfterHeld > okBeforeHeld : null,
      liveCalls,
      proposal: p,
    };
    return { report, exceptional, invalid };
  }

  // ---- change rows -----------------------------------------------------------

  private nextVersion(id: string): number {
    return Math.max(0, ...this.o.book.versions(id).map((q) => q.version)) + 1;
  }

  private kindOf(p: Proposal, report: ReplayReport): Change["kind"] {
    if (p.kind === "retire") return "retire";
    if (p.kind === "reword") return "reword";
    if (report.relaxed > 0) return p.scope === "context" ? "context-loosen" : "loosen";
    return "tighten";
  }

  private makeChange(
    p: Proposal,
    report: ReplayReport,
    status: Change["status"],
    exceptional: boolean,
    proposedBy: Change["proposedBy"],
  ): Change {
    const { book, store } = this.o;
    const from = book.get(p.questionId)?.version ?? 1;
    const context = p.kind === "cutoff" && p.scope === "context";
    const replay: StoredReplay = {
      ...report,
      ...(context
        ? { previousCutoff: store.getContextOverride(p.questionId, p.contextKey) ?? null }
        : {}),
    };
    return {
      id: this.idGen(),
      ts: this.now(),
      questionId: p.questionId,
      fromVersion: from,
      toVersion: context ? null : this.nextVersion(p.questionId),
      kind: this.kindOf(p, report),
      exceptional,
      status,
      replay,
      proposedBy,
    };
  }

  private summary(r: ReplayReport) {
    return {
      cases: r.cases,
      relaxed: r.relaxed,
      tightened: r.tightened,
      mustCatchLost: r.mustCatchLost,
      controlsNewlyHeld: r.controlsNewlyHeld ?? 0,
    };
  }

  private emitChange(c: Change): void {
    const p = (c.replay as StoredReplay).proposal;
    const name = this.o.book.get(c.questionId)?.name ?? c.questionId;
    const cut = (v: number) => this.o.book.get(c.questionId, v)?.cutoff ?? null;
    const proposed = isProposal(p) && p.kind === "cutoff" ? p.cutoff : null;
    const context = isProposal(p) && p.kind === "cutoff" && p.scope === "context";
    this.o.emit?.("amygdala2.change", {
      id: c.id,
      kind: c.kind,
      questionName: name,
      from: context
        ? ((c.replay as StoredReplay).previousCutoff ?? cut(c.fromVersion))
        : cut(c.fromVersion),
      to: proposed ?? (c.toVersion !== null ? `v${c.toVersion}` : null),
      exceptional: c.exceptional,
      status: c.status,
      replaySummary: this.summary(c.replay),
    });
  }

  /** Makes the change live and records it as applied. `persisted`: the row exists already (an approval). */
  private apply(c: Change, p: Proposal, persisted: boolean): Change {
    const { store, book } = this.o;
    const now = this.now();
    const applied: Change = { ...c, status: "applied" };
    if (persisted) store.updateChangeStatus(c.id, "applied");
    else store.saveChange(applied);
    if (p.kind === "cutoff" && p.scope === "context") {
      store.saveContextOverride({
        questionId: p.questionId,
        contextKey: p.contextKey,
        cutoff: p.cutoff,
        changeId: c.id,
      });
    } else {
      const active = book.get(p.questionId, c.fromVersion) as Question;
      const version = c.toVersion as number;
      let q2: Question = { ...active, version, parent: c.fromVersion };
      if (p.kind === "cutoff") q2 = { ...q2, cutoff: p.cutoff };
      else if (p.kind === "retire") q2 = { ...q2, status: "off" };
      else {
        const cand = p.candidate;
        q2 = {
          ...q2,
          ...(cand.instructions !== undefined ? { instructions: cand.instructions } : {}),
          ...(cand.criteria !== undefined ? { criteria: cand.criteria } : {}),
          ...(cand.fields !== undefined ? { fields: cand.fields } : {}),
          ...(cand.cutoff !== undefined ? { cutoff: cand.cutoff } : {}),
          origin: "learned",
        };
      }
      const problems = validateQuestion(q2);
      if (problems.length > 0) throw new Error(`invalid question version: ${problems.join("; ")}`);
      store.saveQuestionVersion(q2, "learning", now);
      book.register(q2);
      store.setActive(p.questionId, version, c.id, now);
      book.setActive(p.questionId, version);
    }
    this.emitChange(applied);
    return applied;
  }

  private reject(
    p: Proposal,
    a: Analysis,
    reason: RejectReason,
    by: Change["proposedBy"],
  ): ChangeOutcome {
    const change = this.makeChange(p, a.report, "rejected", false, by);
    this.o.store.saveChange(change);
    return { outcome: "rejected", change, reason };
  }

  // ---- policy ----------------------------------------------------------------

  private isLoosening(c: Change): boolean {
    return (
      c.kind === "loosen" ||
      c.kind === "context-loosen" ||
      (c.kind === "reword" && c.replay.relaxed > 0)
    );
  }

  private blocked(p: Proposal): boolean {
    const now = this.now();
    for (const c of this.o.store.listChanges({ questionId: p.questionId })) {
      if (c.status !== "undone" && c.status !== "rejected") continue;
      const until = this.o.store.getChange(c.id)?.blockedUntil ?? null;
      if (until === null || until <= now) continue;
      const cp = (c.replay as StoredReplay).proposal;
      if (isProposal(cp) && scopeOf(cp) === scopeOf(p)) return true;
    }
    return false;
  }

  async propose(
    p: Proposal,
    o: { proposedBy?: Change["proposedBy"] } = {},
  ): Promise<ChangeOutcome> {
    const by = o.proposedBy ?? "code";
    const { store, book } = this.o;
    // 1. Validate. Hard rules are code and are never changed by it; nothing is persisted for these two.
    if (p.questionId.startsWith("hard-rule")) {
      return { outcome: "rejected", change: null, reason: "hard-rule" };
    }
    if (!book.get(p.questionId))
      return { outcome: "rejected", change: null, reason: "unknown-question" };
    if (p.kind === "reword" && !this.o.live) {
      return { outcome: "rejected", change: null, reason: "no-effect" };
    }

    // 2-3. Two-sided replay and its gates.
    const a = await this.analyse(p);
    if (a.invalid) return { outcome: "rejected", change: null, reason: "no-effect" };
    const r = a.report;
    if (r.mustCatchLost > 0) return this.reject(p, a, "must-catch-lost", by);
    if ((r.controlsNewlyHeld ?? 0) > 0) return this.reject(p, a, "controls-held", by);
    if (p.kind === "reword" && r.heldOutBetter !== true) {
      return r.relaxed + r.tightened > 0
        ? this.reject(p, a, "no-effect", by)
        : { outcome: "rejected", change: null, reason: "no-effect" };
    }
    if (r.relaxed + r.tightened === 0)
      return { outcome: "rejected", change: null, reason: "no-effect" };

    // 4. Tightening: at once, no caps, no card.
    if (r.relaxed === 0)
      return {
        outcome: "applied",
        change: this.apply(this.makeChange(p, r, "applied", false, by), p, false),
      };

    // 5. Loosening (mixed counts as loosening).
    if (this.blocked(p)) return { outcome: "rejected", change: null, reason: "blocked" };
    const now = this.now();
    if (a.exceptional) {
      const change = this.makeChange(p, r, "pending", true, by);
      store.saveChange(change);
      if (now - this.lastPendingEvent >= DAY_MS) {
        this.lastPendingEvent = now;
        this.emitChange(change);
      }
      return { outcome: "pending", change };
    }
    if (!this.o.autoLoosen) return { outcome: "deferred", reason: "auto-loosen-off" };
    const clean = (sinceTs: number) =>
      store
        .listChanges({ status: "applied", sinceTs })
        .filter((c) => !c.exceptional && this.isLoosening(c));
    if (
      clean(now - 7 * DAY_MS).filter((c) => c.questionId === p.questionId).length >=
      this.o.caps.perWeek
    ) {
      return { outcome: "deferred", reason: "cap-week" };
    }
    if (clean(now - DAY_MS).length >= this.o.caps.perDay)
      return { outcome: "deferred", reason: "cap-day" };
    return {
      outcome: "applied",
      change: this.apply(this.makeChange(p, r, "applied", false, by), p, false),
    };
  }

  async approve(changeId: string, yes: boolean): Promise<ChangeOutcome> {
    const { store, book } = this.o;
    const c = store.getChange(changeId);
    if (!c) return { outcome: "rejected", change: null, reason: "no-effect" };
    if (c.status !== "pending") return { outcome: "rejected", change: c, reason: "no-effect" };
    const decline = (reason: RejectReason, blockedUntil?: number): ChangeOutcome => {
      store.updateChangeStatus(c.id, "rejected", blockedUntil);
      return { outcome: "rejected", change: { ...c, status: "rejected" }, reason };
    };
    if (!yes) return decline("blocked", this.now() + this.blockDays * DAY_MS);

    const stored = c.replay as StoredReplay;
    const p = stored.proposal;
    if (!isProposal(p)) return decline("no-effect");
    // The world may have moved since the card was made: a pending row can only be applied to the state it was made for.
    if (p.kind === "cutoff" && p.scope === "context") {
      const cur = store.getContextOverride(p.questionId, p.contextKey) ?? null;
      if (JSON.stringify(cur) !== JSON.stringify(stored.previousCutoff ?? null))
        return decline("no-effect");
    } else if (
      book.get(p.questionId)?.version !== c.fromVersion ||
      book.get(p.questionId, c.toVersion as number)
    ) {
      return decline("no-effect");
    }
    const a = await this.analyse(p);
    const r = a.report;
    if (a.invalid) return decline("no-effect");
    if (r.mustCatchLost > 0) return decline("must-catch-lost");
    if ((r.controlsNewlyHeld ?? 0) > 0) return decline("controls-held");
    if (r.relaxed + r.tightened === 0) return decline("no-effect");
    if (p.kind === "reword" && r.heldOutBetter !== true) return decline("no-effect");
    return { outcome: "applied", change: this.apply(c, p, true) };
  }

  undo(changeId: string): { ok: boolean; change?: Change; reason?: string } {
    const { store, book } = this.o;
    const c = store.getChange(changeId);
    if (!c) return { ok: false, reason: "unknown-change" };
    if (c.status !== "applied") return { ok: false, reason: "not-applied" };
    const stored = c.replay as StoredReplay;
    const p = stored.proposal;
    const now = this.now();
    if (isProposal(p) && p.kind === "cutoff" && p.scope === "context") {
      if (stored.previousCutoff) {
        store.saveContextOverride({
          questionId: c.questionId,
          contextKey: p.contextKey,
          cutoff: stored.previousCutoff,
          changeId: c.id,
        });
      } else store.removeContextOverride(c.questionId, p.contextKey);
    } else {
      // Undoing an older change under a newer one would silently drop the newer one too.
      if (book.get(c.questionId)?.version !== c.toVersion)
        return { ok: false, reason: "superseded" };
      store.setActive(c.questionId, c.fromVersion, null, now);
      book.setActive(c.questionId, c.fromVersion);
    }
    store.updateChangeStatus(c.id, "undone", now + this.blockDays * DAY_MS);
    return { ok: true, change: { ...c, status: "undone" } };
  }

  pending(): Change[] {
    return this.o.store.listChanges({ status: "pending" });
  }
}
