// THALAMUS v4 — the scheduler (charter phase E; design doc section 12; paper J19 v4.1 section 6).
//
// WHAT THIS IS FOR. Given a plan (units with declared inputs, outputs and changes) it decides which model runs each unit,
// when each starts, how many run at once on each provider, and when a slow unit on the critical path gets a second copy.
// It prices every unit by asking `routeCall` for a fresh point, so the scheduler adds no pricing of its own: quality bar,
// vetoes, privacy, cache state, the dial and the provider's pace all come from the same function the per-call router uses.
//
// ONE STATE MACHINE, THREE DRIVERS. A `PlanRun` holds the state of one plan (what is done, what runs where, the cache as
// the plan has warmed it). `simulate` drives it on a virtual clock from each unit's estimated time: that is the preview,
// and it is what shadow mode records. `execute` drives it on the real clock through a spawner and only exists in enforce.
// The decisions come from the same code either way, so what shadow records is what enforce would do.
//
// SHADOW SPENDS NOTHING AND CHANGES NOTHING. `simulate` calls no model and starts no process; a hedge it finds is written
// down as `sent: false`. `execute` refuses outside enforce, and sends a hedge only with `enforce.hedge` on.
//
// HOW EACH RULE WAS DERIVED (paper section 6).
//   Graph, slack       6.1, 6.2: from `thalamus-graph.ts`. Units that change the same thing never overlap. A unit's slack
//                      goes into its price, so off the critical path a slower, cheaper model wins without a special rule.
//   Shared start       6.3: siblings that share a long start run on one model so the start is written into the cache once.
//                      `fanOutChoice` compares that with each sibling on its own cheapest model, from the price table.
//   Provider caps      6.5: a provider never holds more calls than its cap; a unit that would queue behind a full provider
//                      is priced again without it and goes to another (`spilledFrom`).
//   Hedge              6.4: a critical-path unit that has run past its usual time times `hedge.margin` gets a copy on another
//                      provider; the first answer wins and the other is cancelled. At most a fifth of a plan's units.
//
// WHAT WOULD CHANGE IT. The usual time of a unit is its own estimate, and the margin is config; the ledger's recorded
// durations (phase F) replace the estimate with a measured p95.

import {
  applyCallUsage,
  buildGraph,
  cachePolicyFor,
  creditSharedStart,
  criticalPath,
  exploreOption,
  fanOutChoice,
  hedgeDue,
  isWarm,
  ledgerKey,
  pickChecker,
  priceFor,
  vendorFamilyOf,
  ready,
  routeCall,
  sharedStartGroups,
  supplyOfKey,
  thalamusRoute,
  unitsFor,
  withTiming,
  withinCaps,
  type Answered,
  type CacheLedger,
  type CallDecision,
  type Depth,
  type Feed,
  type Graph,
  type PolicyTable,
  type RouteCallParams,
  type Shape,
  type StepKind,
  type StepRead,
  type SubjectClass,
  type SupplyId,
  type TaskDomain,
  type TaskRead,
  type ThalamusBoardLike,
  type Unit,
  type Urgency,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusConfig } from "./config.js";
import type { PlanUnitRow, ThalamusStore } from "./store.js";

export type PlanTask = {
  kind: TaskDomain;
  topic?: SubjectClass;
  urgency: Urgency;
  private?: boolean;
  shape: Shape;
};

export type PlanRequest = { id: string; units: Unit[]; task: PlanTask };

export type Placement = {
  unitId: string;
  /** 0 the unit, 1 its hedge copy. */
  copy: 0 | 1;
  routeKey: string;
  effort: string;
  feed: Feed;
  price: number;
  money: number;
  /** Estimated seconds for this call. */
  timeSec: number;
  /** How long this call usually takes at its slow end: what a hedge waits past. Equal to `timeSec` with no measured time. */
  usualSec: number;
  /** An overnight unit that took an option the router would not normally take (`learning.explore`, enforce). */
  explored?: boolean;
  startSec: number;
  endSec: number;
  slackSec: number;
  onCritical: boolean;
  /** The provider the unit would have gone to, when that one was full. */
  spilledFrom?: string;
  /** The vendor family of the model, recorded so a check by another family can be seen in the plan. */
  family: string;
  /** A sibling of a shared start: whether it wrote the start into its model's cache or read it from there. */
  sharedStart?: "write" | "read";
  /** For a check unit: what the choice of checker came to (`picked`, `no-other-family`, `no-brief-option`). */
  checker?: string;
};

export type HedgeRecord = {
  unitId: string;
  atSec: number;
  from: string;
  to: string;
  /** True only when `execute` really started the copy. Shadow and preview never do. */
  sent: boolean;
  won?: "original" | "copy";
};

export type GroupRecord = {
  startId: string;
  n: number;
  mode: "shared-start" | "independent";
  sharedCost?: number;
  ownCost?: number;
  /** Why the mode is what it is when no comparison could be made. */
  note?: string;
};

export type PlanDecision = {
  planId: string;
  mode: "shadow" | "enforce" | "preview";
  graph: Graph;
  placements: Placement[];
  hedges: HedgeRecord[];
  groups: GroupRecord[];
  /** Seconds the plan takes, start of the first unit to end of the last. */
  lengthSec: number;
  criticalPath: string[];
  /** Units no option survived for: nothing was placed for them. */
  unplaced: Array<{ unitId: string; why: string }>;
  costEur: number;
  /** The plan was collapsed to one unit because the task read calls it an answer or a chain. */
  collapsed: boolean;
};

export type SchedulerDeps = {
  cfg: () => ThalamusConfig;
  board: (nowMs: number) => ThalamusBoardLike | undefined;
  /** The cache ledger as the gateway has it now. The plan works on its own copy. */
  ledger: () => CacheLedger;
  now: () => number;
  store?: () => ThalamusStore | undefined;
  broadcast?: (name: string, payload: unknown) => void;
  defer?: (fn: () => void) => void;
  timeFor?: RouteCallParams["timeFor"];
  onError?: (err: unknown) => void;
  /**
   * Phase F. What the ledger taught the router: learned strengths and the refusals that veto a family for a class. Absent
   * or empty: the public map alone, as before.
   */
  learned?: () => {
    strengthFor?: RouteCallParams["strengthFor"];
    refusals?: RouteCallParams["refusals"];
  };
  /**
   * The slow end of a rung's time (first token at p95, output speed at p5): what a hedge waits past. Absent: a unit's own
   * estimate is its usual time, as before.
   */
  slowTimeFor?: RouteCallParams["timeFor"];
  /** A number in [0, 1) per draw; exploration only. Default `Math.random`. */
  rand?: () => number;
};

const sure = <T>(value: T): Answered<T> => ({ value, conf: 1, source: "local" });

const STEP_KIND: Record<Unit["kind"], StepKind> = {
  read: "read",
  work: "tool",
  check: "check",
  combine: "write",
  write: "write",
};

const DEFAULT_DEPTH: Record<Unit["kind"], Depth> = {
  read: "routine",
  work: "routine",
  check: "deep",
  combine: "deep",
  write: "routine",
};

/** The provider of a route key: `claude-code` for `claude-code/claude-haiku-4-5`. */
export const providerOf = (routeKey: string): string => {
  const i = routeKey.indexOf("/");
  return i > 0 ? routeKey.slice(0, i) : routeKey;
};

const EXPECTED_TICK_SEC = 0.25;

type Running = { copies: Placement[]; startedSec: number };

export function createScheduler(d: SchedulerDeps) {
  const defer = d.defer ?? ((fn: () => void) => void setImmediate(fn));
  const onError = d.onError ?? (() => {});

  /** One unit priced as a fresh point. Undefined when no option survives the vetoes. */
  function priceUnit(
    plan: PlanRequest,
    unit: Unit,
    at: {
      nowMs: number;
      ledger: CacheLedger;
      conversationKey: string;
      slackSec: number;
      cooling?: ReadonlySet<SupplyId>;
      index: number;
    },
    board: ThalamusBoardLike,
  ): CallDecision | undefined {
    const cfg = d.cfg();
    const isPrivate = Boolean(plan.task.private || unit.private);
    const task: TaskRead = {
      id: `task:${plan.id}`,
      ts: at.nowMs,
      sessionKey: at.conversationKey,
      kind: sure(plan.task.kind),
      difficulty: sure(3 as const),
      topic: sure(plan.task.topic ?? ("none" as SubjectClass)),
      urgency: sure(unit.urgency ?? plan.task.urgency),
      shape: sure(plan.task.shape),
      private: isPrivate,
    };
    const step: StepRead = {
      id: `step:${plan.id}:${unit.id}`,
      ts: at.nowMs,
      sessionKey: at.conversationKey,
      callIndex: at.index,
      kind: sure(STEP_KIND[unit.kind]),
      depth: sure(unit.depth ?? DEFAULT_DEPTH[unit.kind]),
      needs: sure("item" as const),
      runLength: sure(0 as const),
      parallelOk: {},
      commitsOrClaims: sure(unit.kind === "write" || unit.writes.length > 0),
    };
    const dialBar =
      thalamusRoute({ rungs: board.rungs, biasIdx: board.dialIdx, domain: plan.task.kind })
        ?.target ?? 0;
    const tokens = Math.max(1, Math.floor(unit.estIn));
    const learnedNow = d.learned?.();
    const params: RouteCallParams = {
      id: `${plan.id}:${unit.id}:${at.index}`,
      ts: at.nowMs,
      runId: plan.id,
      callIndex: at.index,
      lane: "embedded",
      mode: cfg.mode === "enforce" ? "enforce" : "shadow",
      rungs: board.rungs,
      supplies: board.supplies,
      cache: at.ledger,
      conversationKey: at.conversationKey,
      task,
      step,
      incumbentKey: "",
      handPicked: false,
      dialIdx: board.dialIdx,
      dialBar,
      feedTokens: { thread: tokens, brief: tokens },
      expectedOutputTokens: () => Math.max(1, Math.floor(unit.estOut)),
      approvedProviders: cfg.privacy.approvedProviders,
      policy: cfg.policy.table as PolicyTable,
      contextWindowFor: board.contextWindowFor,
      confidenceFloor: cfg.reads.confidenceFloor,
      freshPoint: true,
      hasLongResult: false,
      slackSec: at.slackSec,
      ...(at.cooling && at.cooling.size > 0 ? { cooling: at.cooling } : {}),
      ...(d.timeFor ? { timeFor: d.timeFor } : {}),
      ...(learnedNow?.strengthFor ? { strengthFor: learnedNow.strengthFor } : {}),
      ...(learnedNow?.refusals ? { refusals: learnedNow.refusals } : {}),
    };
    return routeCall(params);
  }

  const placementOf = (
    dec: CallDecision,
    unitId: string,
    copy: 0 | 1,
    t: number,
    slackSec: number,
    onCritical: boolean,
  ): Placement => ({
    unitId,
    copy,
    routeKey: dec.chosen.rung.key,
    family: vendorFamilyOf(dec.chosen.rung.key),
    effort: dec.chosen.rung.effort,
    feed: dec.chosen.feed,
    price: dec.chosen.price,
    money: dec.chosen.parts.money,
    timeSec: dec.chosen.parts.timeSec,
    usualSec: dec.chosen.parts.timeSec,
    startSec: t,
    endSec: t + dec.chosen.parts.timeSec,
    slackSec,
    onCritical,
  });

  /** Begin a plan. Undefined when there is no board to price against. */
  function start(req: PlanRequest, mode: PlanDecision["mode"] = "shadow") {
    const t0 = d.now();
    const board = d.board(t0);
    if (!board) return undefined;
    const cfg = d.cfg();
    const planned = req.units;
    const whole: Unit = {
      id: "whole",
      task: planned.map((u) => u.task).join("\n"),
      kind: "work",
      inputs: [],
      outputs: [],
      writes: [...new Set(planned.flatMap((u) => u.writes))],
      estIn: planned.reduce((n, u) => n + u.estIn, 0),
      estOut: planned.reduce((n, u) => n + u.estOut, 0),
      model: "auto",
      urgency: planned[0]?.urgency ?? req.task.urgency,
      private: planned.some((u) => u.private),
    };
    const units = unitsFor(req.task.shape, planned, whole);
    const collapsed = units.length === 1 && planned.length > 1;
    const graph = buildGraph(units, req.id);
    const byId = new Map(units.map((u) => [u.id, u]));
    const baseLedger = d.ledger();
    const convOf = (u: Unit, groups: Map<string, GroupRecord>): string =>
      u.sharedStart && groups.get(u.sharedStart.id)?.mode === "shared-start"
        ? `plan:${req.id}:start:${u.sharedStart.id}`
        : `plan:${req.id}:${u.id}`;

    // Pass 1: every unit priced cold and on its own, to learn how long each takes and how much a group's siblings would
    // each pay for the start on their own cheapest model.
    let slack: Record<string, number> = {};
    let durations: Record<string, number> = {};
    let cold = new Map<string, CallDecision>();
    const priceAll = (groups: Map<string, GroupRecord>): void => {
      cold = new Map();
      durations = {};
      units.forEach((u, index) => {
        const dec = priceUnit(
          req,
          u,
          {
            nowMs: t0,
            ledger: baseLedger,
            conversationKey: convOf(u, groups),
            slackSec: slack[u.id] ?? 0,
            index,
          },
          board,
        );
        if (dec) {
          cold.set(u.id, dec);
          durations[u.id] = dec.chosen.parts.timeSec;
        }
      });
    };
    const noGroups = new Map<string, GroupRecord>();
    priceAll(noGroups);

    // The kind of fan-out each shared start gets: the cache decides.
    const groups = new Map<string, GroupRecord>();
    for (const [startId, members] of sharedStartGroups(units)) {
      const sharedTokens = Math.max(...members.map((m) => m.sharedStart?.tokens ?? 0));
      const first = cold.get(members[0].id);
      const row = first ? priceFor(first.chosen.rung.key) : undefined;
      const policy = first ? cachePolicyFor(first.chosen.rung.key) : undefined;
      const own = members.map((m) => {
        const dec = cold.get(m.id);
        return dec ? priceFor(dec.chosen.rung.key)?.inputPerMTok : undefined;
      });
      if (
        !first ||
        !row ||
        row.inputPerMTok == null ||
        !policy ||
        own.some((p) => p === undefined || p === null)
      ) {
        groups.set(startId, {
          startId,
          n: members.length,
          mode: "independent",
          note: "no price or no cache figure for the model",
        });
        continue;
      }
      const choice = fanOutChoice({
        n: members.length,
        sharedTokens,
        shared: {
          inputPerMTok: row.inputPerMTok,
          writeMult: policy.write1hMult,
          readMult: policy.readMult,
        },
        ownInputPerMTok: own as number[],
      });
      groups.set(startId, {
        startId,
        n: members.length,
        mode: choice.mode,
        sharedCost: choice.sharedCost,
        ownCost: choice.ownCost,
      });
    }

    // Pass 2..: slack feeds back into the price until the durations stop moving (at most three rounds).
    for (let round = 0; round < 3; round++) {
      const timing = criticalPath(graph, durations);
      const nextSlack = timing.slackSec;
      const same = units.every((u) => Math.abs((nextSlack[u.id] ?? 0) - (slack[u.id] ?? 0)) < 1e-9);
      slack = nextSlack;
      if (same && round > 0) break;
      priceAll(groups);
    }
    const timing = criticalPath(graph, durations);
    slack = timing.slackSec;
    // A unit is critical when delaying it delays the plan: zero slack. Many units can be (twelve equal readers all are),
    // so this is wider than the one longest path in `timing.criticalPath`.
    const critical = new Set(
      units.filter((u) => (timing.slackSec[u.id] ?? 0) <= 1e-9).map((u) => u.id),
    );

    // ─── the run ──────────────────────────────────────────────────────────────────────────────────────────────────
    let ledger: CacheLedger = baseLedger;
    const done = new Set<string>();
    const running = new Map<string, Running>();
    const placements: Placement[] = [];
    const hedges: HedgeRecord[] = [];
    const unplaced = new Map<string, string>();
    /** Units whose hedge was due but could not be placed (no other provider with room). The clock stops waiting on them. */
    const hedgeTried = new Set<string>();
    const runningByProvider = (): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of running.values()) {
        for (const c of r.copies)
          out[providerOf(c.routeKey)] = (out[providerOf(c.routeKey)] ?? 0) + 1;
      }
      return out;
    };
    const fullProviders = (): string[] => {
      const inFlight = runningByProvider();
      return Object.entries(cfg.scheduler.providerCaps)
        .filter(([p, cap]) => (inFlight[p] ?? 0) >= cap)
        .map(([p]) => p);
    };
    const coolingOf = (providers: string[]): ReadonlySet<SupplyId> =>
      new Set(providers.map((p) => supplyOfKey(`${p}/x`)));

    /** Fold a started sibling's shared start into the plan's own cache ledger, so the next sibling sees it warm. */
    function warm(unit: Unit, routeKey: string, nowMs: number): void {
      const s = unit.sharedStart;
      if (!s || groups.get(s.id)?.mode !== "shared-start") return;
      const conv = `plan:${req.id}:start:${s.id}`;
      const policy = cachePolicyFor(routeKey);
      const hot = ledger.get(ledgerKey(conv, routeKey));
      const read = hot && hot.warmTokens > 0 ? Math.min(hot.warmTokens, s.tokens) : 0;
      ledger = applyCallUsage(
        ledger,
        {
          conversationKey: conv,
          modelKey: routeKey,
          nowMs,
          input: Math.max(0, unit.estIn - s.tokens),
          cacheRead: read,
          cacheWrite: read > 0 ? 0 : s.tokens,
          writeTier: "1h",
        },
        policy,
      );
    }

    const groupModel = new Map<string, Map<string, string>>();
    // Exploration (phase F): overnight units, enforce only, at most a twentieth of the plan's calls.
    const exploring = mode === "enforce" && cfg.learning.explore;
    let exploreCalls = 0;
    let exploredCount = 0;
    let counter = 1000;
    const api = {
      graph,
      groups: [...groups.values()],
      collapsed,
      unitCount: units.length,

      /** Units to start now at `tSec`, most urgent first, within each provider's cap. */
      next(tSec: number): Placement[] {
        const nowMs = t0 + Math.round(tSec * 1000);
        const readyIds = ready(graph, { done, running: new Set(running.keys()) }, slack).filter(
          (id) => !unplaced.has(id),
        );
        const started: Placement[] = [];
        for (const id of readyIds) {
          const unit = byId.get(id) as Unit;
          const conv = convOf(unit, groups);
          const fullNow = fullProviders();
          const base = {
            nowMs,
            ledger,
            conversationKey: conv,
            slackSec: slack[id] ?? 0,
            index: counter++,
          };
          const dec0 = priceUnit(req, unit, base, board);
          if (!dec0) {
            unplaced.set(id, "no-option");
            continue;
          }
          let dec = dec0;
          let spilledFrom: string | undefined;
          const p0 = providerOf(dec0.chosen.rung.key);
          if (fullNow.includes(p0)) {
            const again = priceUnit(req, unit, { ...base, cooling: coolingOf(fullNow) }, board);
            if (!again) continue; // every lane is full: wait for one to free up
            dec = again;
            spilledFrom = p0;
          }
          // Siblings of a shared start run on ONE model per provider, so the start is written into each cache once.
          const sid = unit.sharedStart?.id;
          if (sid && groups.get(sid)?.mode === "shared-start" && unit.kind !== "check") {
            const lane = groupModel.get(sid) ?? new Map<string, string>();
            groupModel.set(sid, lane);
            const prov = providerOf(dec.chosen.rung.key);
            const pinned = lane.get(prov);
            if (pinned === undefined) {
              lane.set(prov, `${dec.chosen.rung.key}@${dec.chosen.rung.effort}`);
            } else {
              const same = dec.options
                .filter((o) => `${o.rung.key}@${o.rung.effort}` === pinned)
                .sort((a, b) => a.price - b.price)[0];
              if (same) dec = { ...dec, chosen: same, pick: same };
            }
          }
          let explored = false;
          if (exploring && unit.urgency === "whenever" && unit.kind !== "check" && !sid) {
            const alt = exploreOption({
              urgency: unit.urgency,
              options: dec.options.filter((o) => !fullNow.includes(providerOf(o.rung.key))),
              pick: dec.chosen,
              bar: dec.bar ?? dec.chosen.quality,
              calls: exploreCalls,
              explored: exploredCount,
              rand: (d.rand ?? Math.random)(),
            });
            exploreCalls += 1;
            if (alt) {
              dec = { ...dec, chosen: alt, pick: alt };
              exploredCount += 1;
              explored = true;
            }
          }
          let checker: string | undefined;
          if (unit.kind === "check") {
            // A check is made by another family than the unit it checks; with none available it says so.
            const builder = graph.edges
              .filter((e) => e.to === id)
              .map((e) => placements.find((p) => p.unitId === e.from && p.copy === 0))
              .find((p): p is Placement => !!p);
            if (builder) {
              const pick = pickChecker({
                builderKey: builder.routeKey,
                options: dec.options,
                minQuality: dec.pick.quality,
              });
              checker = pick.reason;
              if (pick.option) {
                dec = { ...dec, chosen: pick.option, pick: pick.option };
              }
            }
          }
          const pl = placementOf(dec, id, 0, tSec, slack[id] ?? 0, critical.has(id));
          if (checker) pl.checker = checker;
          if (explored) pl.explored = true;
          const slow = d.slowTimeFor?.(pl.routeKey, pl.effort);
          if (slow) {
            const depth = unit.depth ?? DEFAULT_DEPTH[unit.kind];
            const pred = dec.chosen.prediction;
            const warmCache = pred.cachedIn > 0 && pred.cachedIn >= dec.chosen.inputTokens / 2;
            const usual =
              (warmCache ? slow.ttftWarmSec : slow.ttftColdSec) +
              slow.thinkSec[depth] +
              dec.chosen.expectedOutputTokens / Math.max(1, slow.tokensPerSec);
            pl.usualSec = Math.max(pl.timeSec, usual);
          }
          // A sibling of a shared start pays the cache price for the start, not a brief's or a thread's (see
          // `thalamus-shared-start.ts`). The first sibling on a model writes the start; later ones read it.
          if (
            sid &&
            groups.get(sid)?.mode === "shared-start" &&
            unit.kind !== "check" &&
            unit.sharedStart
          ) {
            const wasWarm = isWarm(ledger.get(ledgerKey(conv, pl.routeKey)), nowMs);
            const c = creditSharedStart({
              routeKey: pl.routeKey,
              money: dec.chosen.parts.money,
              moneyKnown: dec.chosen.parts.moneyKnown,
              prediction: dec.chosen.prediction,
              expectedOutputTokens: dec.chosen.expectedOutputTokens,
              inputTokens: dec.chosen.inputTokens,
              sharedTokens: unit.sharedStart.tokens,
              warm: wasWarm,
            });
            if (c.credited) {
              pl.price += (c.money - pl.money) * (dec.chosen.parts.pace + dec.chosen.parts.pFail);
              pl.money = c.money;
              pl.sharedStart = wasWarm ? "read" : "write";
            }
          }
          // The caps are the last word: a pick that still lands on a full provider waits.
          const admit = withinCaps(
            [{ id, provider: providerOf(pl.routeKey) }],
            runningByProvider(),
            cfg.scheduler.providerCaps,
          );
          if (admit.admitted.length === 0) continue;
          if (spilledFrom) pl.spilledFrom = spilledFrom;
          warm(unit, pl.routeKey, nowMs);
          running.set(id, { copies: [pl], startedSec: tSec });
          placements.push(pl);
          started.push(pl);
        }
        // Units whose every option vanished with nothing running can never start: they are reported, not waited for.
        return started;
      },

      /** Hedge copies due at `tSec`. Each is a placement on another provider; the driver decides whether to send it. */
      hedgeCheck(tSec: number): Placement[] {
        const out: Placement[] = [];
        const nowMs = t0 + Math.round(tSec * 1000);
        for (const [id, r] of running) {
          if (r.copies.length > 1) continue;
          const original = r.copies[0];
          if (
            !hedgeDue({
              onCritical: original.onCritical,
              hedged: hedges.some((h) => h.unitId === id),
              elapsedSec: tSec - r.startedSec,
              usualSec: original.usualSec,
              margin: cfg.hedge.margin,
              hedgedSoFar: hedges.length,
              planUnits: graph.units.length,
            })
          )
            continue;
          const unit = byId.get(id) as Unit;
          const avoid = [providerOf(original.routeKey), ...fullProviders()];
          const dec = priceUnit(
            req,
            unit,
            {
              nowMs,
              ledger,
              conversationKey: `plan:${req.id}:${id}:hedge`,
              slackSec: 0,
              cooling: coolingOf(avoid),
              index: counter++,
            },
            board,
          );
          if (!dec || providerOf(dec.chosen.rung.key) === providerOf(original.routeKey)) {
            hedgeTried.add(id);
            continue;
          }
          const pl = placementOf(dec, id, 1, tSec, 0, true);
          hedges.push({
            unitId: id,
            atSec: tSec,
            from: original.routeKey,
            to: pl.routeKey,
            sent: false,
          });
          out.push(pl);
        }
        return out;
      },

      /** A hedge copy really started (enforce). */
      hedgeStarted(pl: Placement): void {
        const r = running.get(pl.unitId);
        if (!r) return;
        r.copies.push(pl);
        placements.push(pl);
        const h = hedges.find((x) => x.unitId === pl.unitId);
        if (h) h.sent = true;
      },

      /** A copy of a unit finished at `tSec`. The other copy, if any, is returned for the driver to cancel. */
      complete(unitId: string, tSec: number, copy: 0 | 1): Placement | undefined {
        const r = running.get(unitId);
        if (!r) return undefined;
        running.delete(unitId);
        done.add(unitId);
        let loser: Placement | undefined;
        for (const c of r.copies) {
          if (c.copy === copy) c.endSec = tSec;
          else loser = c;
        }
        const h = hedges.find((x) => x.unitId === unitId);
        if (h && r.copies.length > 1) h.won = copy === 1 ? "copy" : "original";
        if (loser) {
          loser.endSec = Math.min(loser.endSec, tSec);
        }
        return loser;
      },

      finished(): boolean {
        return units.every((u) => done.has(u.id) || unplaced.has(u.id));
      },
      runningCount: (): number => running.size,
      /** Nothing runs and nothing can start: what is left is waiting on units that were never placed. */
      stuck(): boolean {
        return (
          !api.finished() &&
          running.size === 0 &&
          ready(graph, { done, running: new Set() }, slack).filter((id) => !unplaced.has(id))
            .length === 0
        );
      },
      /** Give up on every unit not done: each is reported as unplaced with this reason; the one that failed, if any, as `failed`. */
      abort(why: string, failedUnit?: string): void {
        if (failedUnit && !done.has(failedUnit)) unplaced.set(failedUnit, "failed");
        for (const u of units) if (!done.has(u.id) && !unplaced.has(u.id)) unplaced.set(u.id, why);
        running.clear();
      },
      /** The earliest time a hedge could become due among what runs now, or undefined. */
      nextHedgeAt(): number | undefined {
        let at: number | undefined;
        for (const [id, r] of running) {
          if (r.copies.length > 1 || hedges.some((h) => h.unitId === id) || hedgeTried.has(id))
            continue;
          const original = r.copies[0];
          if (!original.onCritical) continue;
          const t = r.startedSec + original.usualSec * cfg.hedge.margin + EXPECTED_TICK_SEC / 100;
          if (at === undefined || t < at) at = t;
        }
        return at;
      },

      decision(): PlanDecision {
        const spans = placements.filter((p) => p.copy === 0);
        const endOf = (id: string): number => spans.find((p) => p.unitId === id)?.endSec ?? 0;
        const realDur: Record<string, number> = {};
        for (const p of spans) realDur[p.unitId] = Math.max(0, p.endSec - p.startSec);
        const final = withTiming(graph, realDur);
        return {
          planId: req.id,
          mode,
          graph: final,
          placements: [...placements],
          hedges: hedges.map((h) => ({ ...h })),
          groups: [...groups.values()],
          lengthSec: Math.max(0, ...units.map((u) => endOf(u.id))),
          criticalPath: final.criticalPath,
          unplaced: [...unplaced].map(([unitId, why]) => ({ unitId, why })),
          costEur: placements.reduce(
            (n, p) =>
              n +
              (p.copy === 0 || hedges.some((h) => h.unitId === p.unitId && h.sent) ? p.money : 0),
            0,
          ),
          collapsed,
        };
      },
    };
    return api;
  }

  /**
   * The plan on a virtual clock, from each unit's estimated time (or `actualSec` for the units a test or a replay wants
   * slow). Calls no model and starts nothing. With `hedge` on, a due hedge is applied to the timeline as a what-if and
   * written down as `sent: false`.
   */
  function simulate(
    req: PlanRequest,
    o: { actualSec?: Record<string, number>; hedge?: boolean; mode?: PlanDecision["mode"] } = {},
  ): PlanDecision | undefined {
    const run = start(req, o.mode ?? "preview");
    if (!run) return undefined;
    const wantHedge = o.hedge ?? true;
    type Ev = { at: number; unitId: string; copy: 0 | 1 };
    const pending: Ev[] = [];
    let t = 0;
    const launch = (pl: Placement): void => {
      const est = pl.copy === 0 ? (o.actualSec?.[pl.unitId] ?? pl.timeSec) : pl.timeSec;
      pl.endSec = pl.startSec + est;
      pending.push({ at: pl.endSec, unitId: pl.unitId, copy: pl.copy });
    };
    for (let guard = 0; guard < 50 + run.unitCount * 10; guard++) {
      for (const pl of run.next(t)) launch(pl);
      if (run.finished()) break;
      const nextDone = pending.reduce<number | undefined>(
        (m, e) => (m === undefined || e.at < m ? e.at : m),
        undefined,
      );
      const nextHedge = wantHedge ? run.nextHedgeAt() : undefined;
      if (nextDone === undefined && nextHedge === undefined) break;
      const hedgeFirst =
        nextHedge !== undefined && (nextDone === undefined || nextHedge < nextDone);
      t = hedgeFirst ? (nextHedge as number) : (nextDone as number);
      if (hedgeFirst) {
        for (const pl of run.hedgeCheck(t)) {
          // A what-if: the copy is placed on the timeline, but the record says it was not sent.
          run.hedgeStarted(pl);
          launch(pl);
        }
        continue;
      }
      const due = pending.filter((e) => e.at <= t).sort((a, b) => a.at - b.at);
      for (const e of due) {
        pending.splice(pending.indexOf(e), 1);
        const loser = run.complete(e.unitId, e.at, e.copy);
        if (loser) {
          const i = pending.findIndex((x) => x.unitId === loser.unitId && x.copy === loser.copy);
          if (i >= 0) pending.splice(i, 1);
        }
      }
      if (wantHedge) {
        for (const pl of run.hedgeCheck(t)) {
          run.hedgeStarted(pl);
          launch(pl);
        }
      }
    }
    // A unit that waited on one that could not be placed never starts; say so instead of leaving it out.
    if (!run.finished()) run.abort("blocked");
    const dec = run.decision();
    // Simulation never sends anything.
    for (const h of dec.hedges) h.sent = false;
    return dec;
  }

  /**
   * The plan on the real clock, through `spawn`. ENFORCE ONLY: in any other mode this returns undefined and starts
   * nothing. A hedge copy is started only with `enforce.hedge` on; the first copy to finish wins and the other is
   * cancelled. If a copy fails and no other copy of that unit is alive, everything still running is cancelled and the rest
   * of the plan is reported as aborted: a unit that never ran would hand its dependents a missing input.
   */
  async function execute(
    req: PlanRequest,
    spawn: Spawner,
    o: { clockMs?: () => number; sleep?: (ms: number) => Promise<void>; tickMs?: number } = {},
  ): Promise<PlanDecision | undefined> {
    const cfg = d.cfg();
    if (cfg.mode !== "enforce") return undefined;
    const run = start(req, "enforce");
    if (!run) return undefined;
    const clock = o.clockMs ?? d.now;
    const t0 = clock();
    const sec = (): number => (clock() - t0) / 1000;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const tick = o.tickMs ?? 250;
    const unitOf = new Map(run.graph.units.map((u) => [u.id, u]));
    const handles = new Map<string, UnitHandle>();
    const events: Array<{ unitId: string; copy: 0 | 1; ok: boolean }> = [];
    let wake: (() => void) | undefined;
    const launch = (pl: Placement): void => {
      const job: UnitJob = {
        planId: req.id,
        unit: unitOf.get(pl.unitId) as Unit,
        copy: pl.copy,
        routeKey: pl.routeKey,
        effort: pl.effort,
        feed: pl.feed,
      };
      const h = spawn(job);
      handles.set(`${pl.unitId}:${pl.copy}`, h);
      void h.done
        .then(
          () => events.push({ unitId: pl.unitId, copy: pl.copy, ok: true }),
          () => events.push({ unitId: pl.unitId, copy: pl.copy, ok: false }),
        )
        .finally(() => wake?.());
    };
    const cancelAll = (): void => {
      for (const h of handles.values()) {
        try {
          h.cancel();
        } catch (err) {
          onError(err);
        }
      }
      handles.clear();
    };
    try {
      while (!run.finished()) {
        for (const pl of run.next(sec())) launch(pl);
        if (cfg.enforce.hedge) {
          for (const pl of run.hedgeCheck(sec())) {
            run.hedgeStarted(pl);
            launch(pl);
          }
        }
        if (events.length === 0) {
          if (run.stuck()) break;
          await Promise.race([new Promise<void>((r) => (wake = r)), sleep(tick)]);
          wake = undefined;
        }
        for (const ev of events.splice(0)) {
          const key = `${ev.unitId}:${ev.copy}`;
          if (!handles.has(key)) continue; // a copy that was cancelled
          handles.delete(key);
          if (ev.ok) {
            const loser = run.complete(ev.unitId, sec(), ev.copy);
            if (loser) {
              const lk = `${loser.unitId}:${loser.copy}`;
              handles.get(lk)?.cancel();
              handles.delete(lk);
            }
          } else if (!handles.has(`${ev.unitId}:${ev.copy === 0 ? 1 : 0}`)) {
            cancelAll();
            run.abort("aborted", ev.unitId);
          }
        }
      }
      if (!run.finished()) run.abort("blocked");
    } finally {
      cancelAll();
    }
    const dec = run.decision();
    record(dec);
    return dec;
  }

  /** Write a decision down: the `units` rows and the `thalamus.plan` event. Off the caller's path. */
  function record(dec: PlanDecision): void {
    const at = d.now();
    defer(() => {
      try {
        const store = d.store?.();
        const hedged = new Set(dec.hedges.map((h) => h.unitId));
        const unitOf = new Map(dec.graph.units.map((u) => [u.id, u]));
        for (const p of dec.placements) {
          const u = unitOf.get(p.unitId);
          const h = dec.hedges.find((x) => x.unitId === p.unitId);
          const row: PlanUnitRow = {
            planId: dec.planId,
            unitId: p.unitId,
            copy: p.copy,
            ts: at,
            mode: dec.mode,
            deps: dec.graph.edges.filter((e) => e.to === p.unitId).map((e) => e.from),
            writes: u?.writes ?? [],
            model: p.routeKey,
            effort: p.effort,
            startSec: p.startSec,
            endSec: p.endSec,
            slackSec: p.slackSec,
            onCritical: p.onCritical,
            hedged: hedged.has(p.unitId),
            price: p.price,
            status: p.copy === 1 ? (h?.won === "copy" ? "won" : "lost") : "placed",
            detail: {
              feed: p.feed,
              money: p.money,
              family: p.family,
              usualSec: p.usualSec,
              ...(p.explored ? { explored: true } : {}),
              ...(p.sharedStart ? { sharedStart: p.sharedStart } : {}),
              ...(p.checker ? { checker: p.checker } : {}),
              ...(p.spilledFrom ? { spilledFrom: p.spilledFrom } : {}),
              ...(h ? { hedgeSent: h.sent } : {}),
            },
          };
          store?.insertPlanUnit(row);
        }
        for (const x of dec.unplaced) {
          store?.insertPlanUnit({
            planId: dec.planId,
            unitId: x.unitId,
            copy: 0,
            ts: at,
            mode: dec.mode,
            deps: [],
            writes: [],
            onCritical: false,
            hedged: false,
            status: x.why,
            detail: {},
          });
        }
        d.broadcast?.("thalamus.plan", {
          planId: dec.planId,
          mode: dec.mode,
          units: dec.graph.units.length,
          criticalPath: dec.criticalPath,
          lengthSec: dec.lengthSec,
          hedges: dec.hedges.map((h) => ({ unitId: h.unitId, to: h.to, sent: h.sent, won: h.won })),
        });
      } catch (err) {
        onError(err);
      }
    });
  }

  /** Shadow: work out the plan on a virtual clock and write it down. Sends nothing, calls no model. */
  function shadow(req: PlanRequest): PlanDecision | undefined {
    const cfg = d.cfg();
    if (cfg.mode === "off") return undefined;
    const dec = simulate(req, { mode: cfg.mode === "enforce" ? "enforce" : "shadow" });
    if (dec) record(dec);
    return dec;
  }

  return { start, simulate, execute, record, shadow, priceUnit };
}

export type UnitJob = {
  planId: string;
  unit: Unit;
  /** 0 the unit, 1 its hedge copy. */
  copy: 0 | 1;
  routeKey: string;
  effort: string;
  feed: Feed;
};

export type UnitHandle = { done: Promise<unknown>; cancel: () => void };

/** Starts one unit on the model the scheduler chose. The scheduler never calls a model itself. */
export type Spawner = (job: UnitJob) => UnitHandle;

export type Scheduler = ReturnType<typeof createScheduler>;
