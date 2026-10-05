// THALAMUS v4 — the plan preview's input (charter phase E; design doc section 12, `thalamus.plan.preview`).
//
// WHAT THIS IS FOR. The preview RPC takes a plan from outside the gateway, so nothing in it is trusted: every field is
// checked, clipped and defaulted here, and a plan that is too large or malformed is refused with the reason. The
// scheduler only ever sees what this returns.
//
// WHAT WOULD CHANGE IT. The limits (units, name lengths, list lengths) are starting values.

import type {
  Depth,
  Shape,
  SubjectClass,
  TaskDomain,
  Unit,
  Urgency,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { PlanRequest } from "./scheduler.js";

export const MAX_PLAN_UNITS = 64;
const MAX_ID = 64;
const MAX_TASK = 2000;
const MAX_LIST = 64;
const MAX_NAME = 200;
const MAX_TOKENS = 5_000_000;

const KINDS: readonly Unit["kind"][] = ["read", "work", "check", "combine", "write"];
const URGENCIES: readonly Urgency[] = ["waiting", "today", "whenever"];
const SHAPES: readonly Shape[] = ["answer", "parts", "chain"];
const DEPTHS: readonly Depth[] = ["mechanical", "routine", "deep"];

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const tokens = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(MAX_TOKENS, Math.floor(v)) : d;
const names = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .slice(0, MAX_LIST)
        .map((x) => x.slice(0, MAX_NAME))
    : [];

export type ParsedPlan = { ok: true; req: PlanRequest } | { ok: false; error: string };

export function parsePlanRequest(raw: Record<string, unknown>): ParsedPlan {
  const unitsRaw = raw.units;
  if (!Array.isArray(unitsRaw) || unitsRaw.length === 0)
    return { ok: false, error: "units: a non-empty list is required" };
  if (unitsRaw.length > MAX_PLAN_UNITS)
    return { ok: false, error: `units: at most ${MAX_PLAN_UNITS}` };
  const task = obj(raw.task);
  const taskUrgency = pick(task.urgency, URGENCIES, "today");
  const units: Unit[] = [];
  for (const [i, r] of unitsRaw.entries()) {
    const u = obj(r);
    const id = typeof u.id === "string" && u.id.length > 0 ? u.id.slice(0, MAX_ID) : "";
    if (!id) return { ok: false, error: `units[${i}]: an id is required` };
    const text = typeof u.task === "string" ? u.task.slice(0, MAX_TASK) : "";
    const shared = obj(u.sharedStart);
    units.push({
      id,
      task: text,
      kind: pick(u.kind, KINDS, "work"),
      inputs: names(u.inputs),
      outputs: names(u.outputs),
      writes: names(u.writes),
      estIn: tokens(u.estIn, Math.max(1, Math.ceil(text.length / 4) + 500)),
      estOut: tokens(u.estOut, 1500),
      ...(DEPTHS.includes(u.depth as Depth) ? { depth: u.depth as Depth } : {}),
      ...(typeof shared.id === "string" && shared.id
        ? { sharedStart: { id: shared.id.slice(0, MAX_ID), tokens: tokens(shared.tokens, 0) } }
        : {}),
      model: "auto",
      urgency: pick(u.urgency, URGENCIES, taskUrgency),
      private: u.private === true,
    });
  }
  return {
    ok: true,
    req: {
      id:
        typeof raw.planId === "string" && raw.planId
          ? raw.planId.slice(0, MAX_ID)
          : `preview:${Date.now()}`,
      units,
      task: {
        kind: (typeof task.kind === "string" && task.kind ? task.kind : "general") as TaskDomain,
        ...(typeof task.topic === "string" ? { topic: task.topic as SubjectClass } : {}),
        urgency: taskUrgency,
        shape: pick(task.shape, SHAPES, "parts"),
        private: task.private === true,
      },
    },
  };
}
