/**
 * Client store for the amygdala UI (design doc §9.1): a pure, DOM-free reducer that folds the `amygdala2.*` gateway
 * events and the `amygdala2.feed` snapshot into the state every renderer reads. It holds no wording of any question,
 * only the payload types from `amygdala-types.ts`. Interactive state (open rows, selections) does not live here.
 */
import type {
  ChangeView,
  DotState,
  FeedView,
  InterventionView,
  JevDecision,
  MarkerView,
  QuestionRow,
  StatusView,
  TurnView,
} from "./amygdala-types.js";

export type AmyEventName =
  | "amygdala2.status"
  | "amygdala2.decision"
  | "amygdala2.intervention"
  | "amygdala2.change"
  | "amygdala2.marker"
  | "amygdala2.refusal";

export interface AmygdalaState {
  /** null = not probed yet, false = `amygdala2.status` is an unknown method (the UI stays on v3.1), true = present. */
  available: boolean | null;
  status: StatusView | null;
  spend: { eur: number; eur30: number; calls: number } | null;
  counts: { checks: number; held: number; asked: number } | null;
  questions: QuestionRow[];
  precedents: number;
  changes: ChangeView[];
}

interface TurnRec {
  turnId: string;
  sessionKey: string;
  ts: number;
  decisions: JevDecision[];
  decisionIds: Set<string>;
  interventions: Map<string, InterventionView>;
  markers: MarkerView[];
  rewound?: TurnView["rewound"];
  refusalKept?: boolean;
}

const STATUS_STATES = new Set(["working", "shadow", "degraded"]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
// Payloads are plain JSON, so structural equality by serialisation is exact and keeps upserts idempotent.
const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

function validDecision(p: unknown): p is JevDecision {
  return isObj(p) && isStr(p.id) && isStr(p.turnId) && isStr(p.sessionKey) && isNum(p.ts);
}
function validIntervention(p: unknown): p is InterventionView {
  return (
    isObj(p) &&
    isStr(p.id) &&
    isStr(p.turnId) &&
    isStr(p.sessionKey) &&
    isNum(p.ts) &&
    typeof p.kind === "string" &&
    typeof p.state === "string"
  );
}
function validChange(p: unknown): p is ChangeView {
  return (
    isObj(p) && isStr(p.id) && typeof p.status === "string" && typeof p.exceptional === "boolean"
  );
}
function validMarker(p: unknown): p is MarkerView {
  return (
    isObj(p) && isStr(p.turnId) && isStr(p.sessionKey) && isNum(p.ts) && typeof p.kind === "string"
  );
}
function validStatus(p: unknown): p is StatusView {
  return (
    isObj(p) &&
    typeof p.state === "string" &&
    STATUS_STATES.has(p.state) &&
    isNum(p.spendEurToday) &&
    isNum(p.checksToday) &&
    isNum(p.heldToday) &&
    isNum(p.askedToday)
  );
}

export class AmygdalaStore {
  private readonly maxTurns: number;
  private readonly maxDecisionsPerTurn: number;
  private readonly turnMap = new Map<string, TurnRec>();
  private readonly changeMap = new Map<string, ChangeView>();
  private readonly listeners = new Set<() => void>();
  private st: AmygdalaState = {
    available: null,
    status: null,
    spend: null,
    counts: null,
    questions: [],
    precedents: 0,
    changes: [],
  };

  constructor(o?: { maxTurns?: number; maxDecisionsPerTurn?: number }) {
    this.maxTurns = Math.max(1, o?.maxTurns ?? 60);
    this.maxDecisionsPerTurn = Math.max(1, o?.maxDecisionsPerTurn ?? 400);
  }

  get state(): Readonly<AmygdalaState> {
    return this.st;
  }

  setAvailable(v: boolean | null): void {
    if (this.st.available === v) return;
    this.st = { ...this.st, available: v };
    this.notify();
  }

  applyEvent(name: string, payload: unknown): boolean {
    let changed = false;
    try {
      switch (name) {
        case "amygdala2.decision":
          changed = this.mergeDecision(payload);
          break;
        case "amygdala2.intervention":
          changed = this.mergeIntervention(payload);
          break;
        case "amygdala2.marker":
          changed = this.mergeMarker(payload);
          break;
        case "amygdala2.change":
          changed = this.mergeChange(payload);
          break;
        case "amygdala2.status":
          changed = this.replaceStatus(payload);
          break;
        // The refusal strip is the `refusal` intervention; the bare event carries nothing more.
        default:
          return false;
      }
    } catch (err) {
      console.error("[amygdala-ui] event failed", name, err);
      return false;
    }
    if (changed) this.notify();
    return changed;
  }

  applyFeed(feed: Partial<FeedView>): void {
    let changed = false;
    try {
      if (!isObj(feed)) return;
      if (Array.isArray(feed.decisionEvents))
        for (const d of feed.decisionEvents) changed = this.mergeDecision(d) || changed;
      if (Array.isArray(feed.interventions))
        for (const i of feed.interventions) changed = this.mergeIntervention(i) || changed;
      if (Array.isArray(feed.changes))
        for (const c of feed.changes) changed = this.mergeChange(c) || changed;
      if (Array.isArray(feed.questions) && !same(feed.questions, this.st.questions)) {
        this.st = { ...this.st, questions: feed.questions };
        changed = true;
      }
      if (isNum(feed.precedents) && feed.precedents !== this.st.precedents) {
        this.st = { ...this.st, precedents: feed.precedents };
        changed = true;
      }
      if (
        isObj(feed.spend) &&
        isNum(feed.spend.eur) &&
        isNum(feed.spend.eur30) &&
        isNum(feed.spend.calls)
      ) {
        const spend = { eur: feed.spend.eur, eur30: feed.spend.eur30, calls: feed.spend.calls };
        if (!same(spend, this.st.spend)) {
          this.st = { ...this.st, spend };
          changed = true;
        }
      }
      if (
        isObj(feed.counts) &&
        isNum(feed.counts.checks) &&
        isNum(feed.counts.held) &&
        isNum(feed.counts.asked)
      ) {
        const counts = {
          checks: feed.counts.checks,
          held: feed.counts.held,
          asked: feed.counts.asked,
        };
        if (!same(counts, this.st.counts)) {
          this.st = { ...this.st, counts };
          changed = true;
        }
      }
      if (validStatus(feed.status) && !same(feed.status, this.st.status)) {
        this.st = { ...this.st, status: feed.status };
        changed = true;
      }
    } catch (err) {
      console.error("[amygdala-ui] feed failed", err);
    }
    if (changed) this.notify();
  }

  turnsFor(sessionKey: string): TurnView[] {
    const out: TurnView[] = [];
    for (const t of this.turnMap.values()) if (t.sessionKey === sessionKey) out.push(this.view(t));
    return out.sort((a, b) => a.ts - b.ts);
  }

  turn(turnId: string): TurnView | undefined {
    const t = this.turnMap.get(turnId);
    return t ? this.view(t) : undefined;
  }

  openInterventions(sessionKey?: string): InterventionView[] {
    const out: InterventionView[] = [];
    for (const t of this.turnMap.values()) {
      if (sessionKey !== undefined && t.sessionKey !== sessionKey) continue;
      for (const i of t.interventions.values()) if (i.state === "open") out.push(i);
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  pendingChanges(): ChangeView[] {
    return this.st.changes.filter((c) => c.status === "pending");
  }

  appliedChanges(): ChangeView[] {
    return this.st.changes
      .filter((c) => c.status === "applied")
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  }

  markRewound(
    turnId: string,
    info: { restoredPrompt?: string; forkSessionId?: string; ts: number },
  ): void {
    const t = this.turnMap.get(turnId);
    if (!t) return;
    const rewound = {
      ts: info.ts,
      restoredPrompt: info.restoredPrompt,
      forkSessionId: info.forkSessionId,
    };
    if (same(t.rewound, rewound)) return;
    t.rewound = rewound;
    this.notify();
  }

  clearRewound(turnId: string): void {
    const t = this.turnMap.get(turnId);
    if (!t || !t.rewound) return;
    t.rewound = undefined;
    this.notify();
  }

  keepRefusal(turnId: string): void {
    const t = this.turnMap.get(turnId);
    if (!t || t.refusalKept) return;
    t.refusalKept = true;
    this.notify();
  }

  dot(): DotState {
    if (this.st.available !== true || !this.st.status) return "grey";
    switch (this.st.status.state) {
      case "degraded":
        return "red";
      case "shadow":
        return "amber";
      case "working":
        return "green";
      default:
        return "grey";
    }
  }

  /** `hour` is the local hour of day (0..23) of each bucket; buckets end at the hour containing `now`. */
  hourStrip(
    now: number,
    hours = 24,
  ): { hour: number; ok: number; noteAsk: number; held: number }[] {
    const n = Math.max(1, Math.floor(hours));
    const cur = new Date(now);
    cur.setMinutes(0, 0, 0);
    const starts: number[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(cur.getTime());
      d.setHours(d.getHours() - i); // Date arithmetic, so DST shifts stay on local hour boundaries
      starts.push(d.getTime());
    }
    const end = new Date(cur.getTime());
    end.setHours(end.getHours() + 1);
    const buckets = starts.map((s) => ({
      hour: new Date(s).getHours(),
      ok: 0,
      noteAsk: 0,
      held: 0,
    }));
    for (const t of this.turnMap.values()) {
      for (const d of t.decisions) {
        if (d.ts < starts[0] || d.ts >= end.getTime()) continue;
        let idx = starts.length - 1;
        while (idx > 0 && starts[idx] > d.ts) idx--;
        const b = buckets[idx];
        if (d.codeDid === "ok") b.ok++;
        else if (d.codeDid === "note" || d.codeDid === "ask") b.noteAsk++;
        else b.held++;
      }
    }
    return buckets;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (err) {
        console.error("[amygdala-ui] listener failed", err);
      }
    }
  }

  private view(t: TurnRec): TurnView {
    const v: TurnView = {
      turnId: t.turnId,
      sessionKey: t.sessionKey,
      ts: t.ts,
      decisions: [...t.decisions],
      interventions: [...t.interventions.values()],
      markers: [...t.markers],
    };
    if (t.rewound) v.rewound = t.rewound;
    if (t.refusalKept) v.refusalKept = true;
    return v;
  }

  private ensureTurn(turnId: string, sessionKey: string, ts: number): TurnRec {
    let t = this.turnMap.get(turnId);
    if (!t) {
      t = {
        turnId,
        sessionKey,
        ts,
        decisions: [],
        decisionIds: new Set(),
        interventions: new Map(),
        markers: [],
      };
      this.turnMap.set(turnId, t);
    }
    return t;
  }

  /** Drops the oldest turns beyond the cap. Returns true when the turn just touched survived. */
  private evict(keepId: string): boolean {
    while (this.turnMap.size > this.maxTurns) {
      let oldest: TurnRec | undefined;
      for (const t of this.turnMap.values()) if (!oldest || t.ts < oldest.ts) oldest = t;
      if (!oldest) break;
      this.turnMap.delete(oldest.turnId);
      if (oldest.turnId === keepId) return false;
    }
    return true;
  }

  private mergeDecision(p: unknown): boolean {
    if (!validDecision(p)) return false;
    const existing = this.turnMap.get(p.turnId);
    if (existing?.decisionIds.has(p.id)) return false;
    const t = this.ensureTurn(p.turnId, p.sessionKey, p.ts);
    // A turn first seen through a non-decision event keeps the earliest decision's ts once one arrives.
    if (t.decisions.length === 0) t.ts = p.ts;
    else t.ts = Math.min(t.ts, p.ts);
    t.decisionIds.add(p.id);
    let at = t.decisions.length;
    while (at > 0 && t.decisions[at - 1].ts > p.ts) at--;
    t.decisions.splice(at, 0, p);
    while (t.decisions.length > this.maxDecisionsPerTurn) {
      const gone = t.decisions.shift();
      if (gone) t.decisionIds.delete(gone.id);
    }
    this.evict(p.turnId);
    return true;
  }

  private mergeIntervention(p: unknown): boolean {
    if (!validIntervention(p)) return false;
    const t = this.ensureTurn(p.turnId, p.sessionKey, p.ts);
    const prev = t.interventions.get(p.id);
    if (prev && same(prev, p)) return false;
    t.interventions.set(p.id, p);
    this.evict(p.turnId);
    return true;
  }

  private mergeMarker(p: unknown): boolean {
    if (!validMarker(p)) return false;
    const t = this.ensureTurn(p.turnId, p.sessionKey, p.ts);
    if (t.markers.some((m) => same(m, p))) return false;
    t.markers.push(p);
    this.evict(p.turnId);
    return true;
  }

  private mergeChange(p: unknown): boolean {
    if (!validChange(p)) return false;
    const prev = this.changeMap.get(p.id);
    if (prev && same(prev, p)) return false;
    this.changeMap.set(p.id, p);
    this.st = { ...this.st, changes: [...this.changeMap.values()] };
    return true;
  }

  private replaceStatus(p: unknown): boolean {
    if (!validStatus(p)) return false;
    const counts = { checks: p.checksToday, held: p.heldToday, asked: p.askedToday };
    const spend = { eur30: 0, calls: 0, ...this.st.spend, eur: p.spendEurToday };
    if (same(p, this.st.status) && same(counts, this.st.counts) && same(spend, this.st.spend))
      return false;
    this.st = { ...this.st, status: p, counts, spend };
    return true;
  }
}
