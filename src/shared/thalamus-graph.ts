// THALAMUS v4 — the plan graph (design doc section 12; paper J19 v4.1 section 6).
//
// WHAT THIS IS FOR. A task the planner cuts into units is a graph: a unit waits for the units that make its inputs, and
// two units that change the same thing never run together. This file builds that graph, finds the critical path and
// every unit's slack, says which units may start now, how a fan-out should share its start, where to cut a long input,
// and when a slow critical-path unit deserves a second copy. It prices nothing and starts nothing: the scheduler
// (`extensions/tinkerclaw-thalamus/src/scheduler.ts`) asks `routeCall` for the model of each ready unit.
//
// HOW IT WAS DERIVED. Paper 6.1: "units that change the same thing never run at the same time; everything else may.
// Independence is checked from those declared changes, never assumed." So the same-write edges come from the `writes`
// the planner declared and nothing else, and a declared change is all the check has: a unit that changes something it
// did not declare is the planner's fault, and the scheduler cannot see it. Paper 6.2: slack is how much later a unit
// could finish without delaying the task; time is charged only on the critical path, which `slackSec` in the price
// already does. Paper 6.3: a shared start is written once and read cheaply by every sibling; the cache decides which
// kind of fan-out a task gets. Paper 6.4: a hedge is a copy of a slow critical-path call, once, and few.
//
// WHAT WOULD CHANGE IT. `HEDGE_MAX_SHARE` (a plan hedges at most a fifth of its units) and `DEFAULT_SPLIT_TOKENS` are
// starting values; the ledger's hedge outcomes tune the first, the readers' measured speed the second.
//
// PURE. No clock, no I/O. Durations, prices and provider names are arguments.

import { approxTokens } from "./thalamus-digest.js";
import type { PlanGraph, Unit } from "./thalamus-v4-types.js";

/** A plan hedges at most this share of its units (design doc section 12). */
export const HEDGE_MAX_SHARE = 0.2;

/** A long input is cut into pieces of about this many tokens (the contract of paper section 9 uses 50,000). */
export const DEFAULT_SPLIT_TOKENS = 50_000;

export class GraphError extends Error {}

export type Graph = PlanGraph & {
  /** Unit ids in an order where every unit comes after the units it waits for. */
  order: string[];
};

/** The unit that makes each declared output, by the output's name. An output made twice is an error. */
function producers(units: readonly Unit[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const u of units) {
    for (const name of u.outputs) {
      const prior = out.get(name);
      if (prior !== undefined && prior !== u.id) {
        throw new GraphError(`output "${name}" is made by both "${prior}" and "${u.id}"`);
      }
      out.set(name, u.id);
    }
  }
  return out;
}

const reaches = (succ: ReadonlyMap<string, Set<string>>, from: string, to: string): boolean => {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const at = stack.pop() as string;
    if (at === to) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const next of succ.get(at) ?? []) stack.push(next);
  }
  return false;
};

/**
 * Build the graph. Edges:
 *  - `input`: from the unit that makes an output to each unit that declares it as an input. An input nobody makes is
 *    outside the plan (a file, the user's request) and adds no edge.
 *  - `same-write`: between two units whose `writes` intersect and that are not already ordered by the edges above,
 *    from the earlier in the unit list to the later, so they run one after the other, never together.
 * Throws `GraphError` on a duplicate id, an output made twice, a unit that waits for itself, or a cycle.
 */
export function buildGraph(units: readonly Unit[], id = "plan"): Graph {
  const byId = new Map<string, Unit>();
  for (const u of units) {
    if (byId.has(u.id)) throw new GraphError(`duplicate unit id "${u.id}"`);
    byId.set(u.id, u);
  }
  const made = producers(units);
  const edges: Graph["edges"] = [];
  const succ = new Map<string, Set<string>>(units.map((u) => [u.id, new Set<string>()]));
  const addEdge = (from: string, to: string, why: "input" | "same-write"): void => {
    if (succ.get(from)?.has(to)) return;
    succ.get(from)?.add(to);
    edges.push({ from, to, why });
  };
  for (const u of units) {
    for (const name of u.inputs) {
      const from = made.get(name);
      if (from === undefined) continue;
      if (from === u.id) throw new GraphError(`unit "${u.id}" waits for its own output "${name}"`);
      addEdge(from, u.id, "input");
    }
  }
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i];
      const b = units[j];
      if (!writesCollide(a, b)) continue;
      if (reaches(succ, a.id, b.id) || reaches(succ, b.id, a.id)) continue;
      addEdge(a.id, b.id, "same-write");
    }
  }
  // A cycle among the input edges shows here. Same-write edges join only units that are not already ordered, so they
  // cannot make one.
  return {
    id,
    units: [...units],
    edges,
    criticalPath: [],
    slackSec: {},
    order: topoOrder(
      units.map((u) => u.id),
      succ,
    ),
  };
}

/** Do two units declare a change to the same thing? */
export function writesCollide(a: Pick<Unit, "writes">, b: Pick<Unit, "writes">): boolean {
  if (a.writes.length === 0 || b.writes.length === 0) return false;
  const mine = new Set(a.writes);
  return b.writes.some((w) => mine.has(w));
}

function topoOrder(ids: readonly string[], succ: ReadonlyMap<string, Set<string>>): string[] {
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  for (const tos of succ.values()) for (const t of tos) indeg.set(t, (indeg.get(t) ?? 0) + 1);
  const queue = ids.filter((i) => (indeg.get(i) ?? 0) === 0);
  const out: string[] = [];
  while (queue.length) {
    const at = queue.shift() as string;
    out.push(at);
    for (const t of succ.get(at) ?? []) {
      const n = (indeg.get(t) ?? 0) - 1;
      indeg.set(t, n);
      if (n === 0) queue.push(t);
    }
  }
  if (out.length !== ids.length) {
    const stuck = ids.filter((i) => !out.includes(i));
    throw new GraphError(`the plan has a cycle among: ${stuck.join(", ")}`);
  }
  return out;
}

export type Timing = {
  /** The longest chain of units, first to last. */
  criticalPath: string[];
  /** Seconds the whole plan takes with unlimited lanes. */
  length: number;
  earliestStart: Record<string, number>;
  /** Seconds each unit could start later without delaying the plan; 0 on the critical path. */
  slackSec: Record<string, number>;
};

/**
 * The critical path and every unit's slack, from each unit's duration in seconds (a unit with no duration counts as 0).
 * Ties break toward the unit listed first, so the answer is the same every time.
 */
export function criticalPath(graph: Graph, durations: Readonly<Record<string, number>>): Timing {
  const dur = (id: string): number => Math.max(0, durations[id] ?? 0);
  const preds = new Map<string, string[]>(graph.units.map((u) => [u.id, []]));
  const succs = new Map<string, string[]>(graph.units.map((u) => [u.id, []]));
  for (const e of graph.edges) {
    preds.get(e.to)?.push(e.from);
    succs.get(e.from)?.push(e.to);
  }
  const earliestStart: Record<string, number> = {};
  const via = new Map<string, string | undefined>();
  for (const id of graph.order) {
    let start = 0;
    let from: string | undefined;
    for (const p of preds.get(id) ?? []) {
      const end = earliestStart[p] + dur(p);
      if (end > start) {
        start = end;
        from = p;
      }
    }
    earliestStart[id] = start;
    via.set(id, from);
  }
  let length = 0;
  let last: string | undefined;
  for (const id of graph.order) {
    const end = earliestStart[id] + dur(id);
    if (end > length) {
      length = end;
      last = id;
    }
  }
  const path: string[] = [];
  for (let at = last; at !== undefined; at = via.get(at)) path.unshift(at);
  const latestStart: Record<string, number> = {};
  for (const id of [...graph.order].reverse()) {
    let latestEnd = length;
    for (const s of succs.get(id) ?? []) latestEnd = Math.min(latestEnd, latestStart[s]);
    latestStart[id] = latestEnd - dur(id);
  }
  const slackSec: Record<string, number> = {};
  for (const id of graph.order)
    slackSec[id] = Math.max(0, round(latestStart[id] - earliestStart[id]));
  return { criticalPath: path, length: round(length), earliestStart, slackSec };
}

const round = (n: number): number => Math.round(n * 1e9) / 1e9;

/** The graph with its timing filled in, in the shape the store and the events carry. */
export function withTiming(graph: Graph, durations: Readonly<Record<string, number>>): Graph {
  const t = criticalPath(graph, durations);
  return { ...graph, criticalPath: t.criticalPath, slackSec: t.slackSec };
}

export type RunState = {
  done: ReadonlySet<string>;
  running: ReadonlySet<string>;
};

/**
 * The units that may start now: not started, every unit they wait for done, and no declared change in common with a
 * unit that is running right now (the edges already order such units; this is the same check again at the moment of
 * starting, so a plan edited while it runs cannot slip two writers together). Most urgent first: least slack, then
 * plan order.
 */
export function ready(
  graph: Graph,
  state: RunState,
  slackSec: Readonly<Record<string, number>> = graph.slackSec,
): string[] {
  const preds = new Map<string, string[]>(graph.units.map((u) => [u.id, []]));
  for (const e of graph.edges) preds.get(e.to)?.push(e.from);
  const byId = new Map(graph.units.map((u) => [u.id, u]));
  const runningUnits = [...state.running].map((id) => byId.get(id)).filter((u): u is Unit => !!u);
  const pos = new Map(graph.order.map((id, i) => [id, i]));
  return graph.units
    .filter((u) => !state.done.has(u.id) && !state.running.has(u.id))
    .filter((u) => (preds.get(u.id) ?? []).every((p) => state.done.has(p)))
    .filter((u) => !runningUnits.some((r) => writesCollide(r, u)))
    .map((u) => u.id)
    .sort(
      (a, b) => (slackSec[a] ?? 0) - (slackSec[b] ?? 0) || (pos.get(a) ?? 0) - (pos.get(b) ?? 0),
    );
}

export type Candidate = { id: string; provider: string };

/**
 * Admit candidates in the order given while each provider stays under its cap of concurrent calls. A provider with no
 * cap listed is not limited here. The rest are deferred, in order, for the next round. `running` is how many calls each
 * provider has in flight now.
 */
export function withinCaps(
  candidates: readonly Candidate[],
  running: Readonly<Record<string, number>>,
  caps: Readonly<Record<string, number>>,
): { admitted: Candidate[]; deferred: Candidate[] } {
  const used: Record<string, number> = { ...running };
  const admitted: Candidate[] = [];
  const deferred: Candidate[] = [];
  for (const c of candidates) {
    const cap = caps[c.provider];
    if (cap !== undefined && (used[c.provider] ?? 0) >= cap) {
      deferred.push(c);
      continue;
    }
    used[c.provider] = (used[c.provider] ?? 0) + 1;
    admitted.push(c);
  }
  return { admitted, deferred };
}

/** Siblings that share a long start, by the start's id. Groups of one are not groups. */
export function sharedStartGroups(units: readonly Unit[]): Map<string, Unit[]> {
  const groups = new Map<string, Unit[]>();
  for (const u of units) {
    if (!u.sharedStart) continue;
    const list = groups.get(u.sharedStart.id) ?? [];
    list.push(u);
    groups.set(u.sharedStart.id, list);
  }
  for (const [k, v] of groups) if (v.length < 2) groups.delete(k);
  return groups;
}

export type FanOutInput = {
  /** How many siblings share the start. */
  n: number;
  /** Tokens of the shared start. */
  sharedTokens: number;
  /** The one model that would run them all: EUR per million input tokens and its cache multipliers. */
  shared: { inputPerMTok: number; writeMult: number; readMult: number };
  /** What each sibling would pay per million input tokens on its own cheapest model, one entry per sibling. */
  ownInputPerMTok: readonly number[];
};

export type FanOutChoice = {
  mode: "shared-start" | "independent";
  /** EUR for the start's input over the whole fan-out, each way. */
  sharedCost: number;
  ownCost: number;
};

/**
 * The cache decides which kind of fan-out a task gets (paper 6.3). Shared start: the first sibling writes the start
 * (`writeMult` x the input price) and each of the other n-1 reads it (`readMult` x). Independent: every sibling pays
 * the plain input price of its own cheapest model for the same tokens. Whichever costs less for the start wins; a tie
 * keeps the shared start, because it also keeps the siblings on one model, which is what makes their answers alike.
 * Only the shared start's input is compared: the briefs and the answers cost the same either way.
 */
export function fanOutChoice(p: FanOutInput): FanOutChoice {
  const S = Math.max(0, p.sharedTokens) / 1e6;
  const n = Math.max(0, Math.floor(p.n));
  const sharedCost =
    n === 0 ? 0 : S * p.shared.inputPerMTok * (p.shared.writeMult + (n - 1) * p.shared.readMult);
  const ownCost = p.ownInputPerMTok.slice(0, n).reduce((sum, q) => sum + S * q, 0);
  return { mode: sharedCost <= ownCost ? "shared-start" : "independent", sharedCost, ownCost };
}

/**
 * The fewest siblings at which a shared start beats paying plain input on one cheaper model each, for a uniform
 * `ownInputPerMTok`. `Infinity` when a read is never cheaper than that plain price. Used to show the threshold the
 * choice flips at.
 */
export function sharedStartBreakEven(p: {
  shared: { inputPerMTok: number; writeMult: number; readMult: number };
  ownInputPerMTok: number;
}): number {
  const perRead = p.shared.inputPerMTok * p.shared.readMult;
  const saved = p.ownInputPerMTok - perRead;
  if (saved <= 0) return Number.POSITIVE_INFINITY;
  const extraWrite = p.shared.inputPerMTok * (p.shared.writeMult - p.shared.readMult);
  return Math.max(1, Math.ceil(extraWrite / saved));
}

/**
 * Cut a long text at natural boundaries into pieces of at most about `maxTokens` each. A boundary is, in order of
 * preference, a heading line, a blank line, a line end, a sentence end; the cut falls on the latest preferred boundary
 * inside the budget and never inside a word unless the text has no boundary at all. Joining the pieces gives the text
 * back exactly.
 */
export function splitAtBoundaries(text: string, maxTokens = DEFAULT_SPLIT_TOKENS): string[] {
  const budget = Math.max(1, Math.floor(maxTokens)) * 4;
  if (text.length <= budget || approxTokens(text) <= maxTokens) return text.length ? [text] : [];
  const boundaries: RegExp[] = [/\n(?=#{1,6} )/g, /\n\n/g, /\n/g, /[.!?]["')\]]?\s/g];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    const window = rest.slice(0, budget);
    let cut = -1;
    for (const re of boundaries) {
      let last = -1;
      for (const m of window.matchAll(re)) last = (m.index ?? 0) + m[0].length;
      // A boundary in the first tenth of the window would make a sliver; look for a later one first.
      if (last > budget / 10) {
        cut = last;
        break;
      }
    }
    if (cut < 0) {
      const space = window.lastIndexOf(" ");
      cut = space > budget / 10 ? space + 1 : budget;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) pieces.push(rest);
  return pieces;
}

export type HedgeInput = {
  onCritical: boolean;
  /** This unit already has a copy. */
  hedged: boolean;
  elapsedSec: number;
  /** How long the unit's rung usually takes (its p95). */
  usualSec: number;
  /** Multiple of the usual time to wait before a copy (config `hedge.margin`). */
  margin: number;
  /** Units of this plan hedged so far, and how many units the plan has. */
  hedgedSoFar: number;
  planUnits: number;
};

/**
 * Is a copy due? Only for a critical-path unit (off the path a slow call costs nothing), once per unit, after the usual
 * time times the margin, and never past a fifth of the plan's units (paper 6.4, design doc section 12).
 */
export function hedgeDue(p: HedgeInput): boolean {
  if (!p.onCritical || p.hedged) return false;
  if (!(p.usualSec > 0) || !(p.margin > 0)) return false;
  if (p.hedgedSoFar >= Math.floor(p.planUnits * HEDGE_MAX_SHARE)) return false;
  return p.elapsedSec > p.usualSec * p.margin;
}

/**
 * A request the task read calls a chain, or a single answer, stays one unit (paper 6.1, last sentence): the planner's
 * units are discarded and the task runs as a whole. Only `parts` may be a graph.
 */
export function unitsFor(
  shape: "answer" | "parts" | "chain",
  planned: readonly Unit[],
  whole: Unit,
): Unit[] {
  return shape === "parts" && planned.length > 0 ? [...planned] : [whole];
}
