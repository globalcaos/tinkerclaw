// src/agents/effort-allocator.ts
// FORK 2026-06-14 (bible §5.84 Drop 3) + 2026-06-18 (§5.84a burn-down): the fluid effort allocator.
// When the user leaves effort on Auto, the true-Auto path calls chooseAutoEffort() to pick a
// CONCRETE thinking level per primary turn. An explicit slider/`/think`/persisted pick always wins
// and never reaches here.
//
// Policy (owner 2026-06-14 + 2026-06-18 burn-down): CONSUME the weekly token cap by its reset —
// arriving at the reset with tokens unused is the failure mode; a throttle/outage is acceptable.
// Effort is a burn-down FLOOR that rises CONVEXLY toward the weekly reset (chill early, through-the-
// roof Wed/Thu) scaled by remaining headroom, plus a behind-pace term, plus coarse task weight. We
// BURN THROUGH the 5h cap (no hard utilization ceiling). Exploration gathers data when NOT urgent and
// is suppressed near reset (exploit the burn). Each chosen level is logged with the live utilizations
// so a v2 can derive the true fastest sustained rate. An explicit pick always short-circuits upstream.

import fs from "node:fs";
import path from "node:path";
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import { resolveStateDir } from "../config/paths.js";
import { getUsageSnapshot } from "../infra/usage-snapshot-store.js";

// ── tunable bounds (design-principles #19: derived/documented, NOT frozen working values) ──
/** Anthropic weekly quota window — the burn-down target; `seven_day.resets_at` anchors its end. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Convexity of the urgency ramp toward the weekly reset. >1 ⇒ chill early, crank late (Wed/Thu). */
const URGENCY_EXP = 2.5;
/** How hard "late + headroom" lifts the burn floor. ≥1 ⇒ lean aggressive (under-consume is the sin). */
const BURN_AGGRO = 1.6;
/** allocations to reach "mature" (the anneal target where exploration → 0). Re-tune from the ledger. */
const CALIB_TARGET = 48;
/** max exploration probability when cold + not urgent. */
const EXPLORE_BASE = 0.9;
/** the levels the allocator chooses from, ascending (Auto/off excluded). */
const LADDER: ThinkLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const LEDGER_FILE = "effort-ledger.jsonl";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export interface QuotaPressure {
  /** −shouldBurn: magnitude = how hard we SHOULD burn the weekly cap down (0 chill → −1 max). */
  pressure: number;
  utilization5h: number; // 0-1, informational — we burn THROUGH the 5h cap (no ceiling)
  utilization7d: number; // 0-1 — BINDING (min across accounts = max-headroom, last to exhaust)
  weekElapsed: number; // 0-1, fraction of the 7-day window elapsed
  // FORK 2026-06-19 (§5.84b): per-account 7d util the binding choice was made from (logged for v2 rate).
  accounts7d?: Array<{ label: string; util7d: number }>;
  bindingAccount?: string; // which account governs the burn-down floor (the max-headroom one)
}

/** Live weekly burn-down signal (sync, fail-to-neutral). Reads the in-process usage snapshot the
 *  budget-panel publishes (`five_hour`/`seven_day` utilization + `resets_at`). shouldBurn rises
 *  convexly toward `seven_day.resets_at` while headroom remains, plus a behind-pace term. With no
 *  live weekly signal yet it returns 0 (no burn demand) so we degrade to the task-weighted exploit. */
export function deriveQuotaPressure(nowMs: number): QuotaPressure {
  const a = getUsageSnapshot()?.providers?.anthropic;
  const util5h = a ? clamp01(a.fiveHourUtilization / 100) : 0;

  // BINDING 7d constraint: the gateway round-robins + fails over across OAuth accounts,
  // so the pool throttles only when the LAST account exhausts ⇒ drive burn-down from the
  // account with the MOST headroom = MIN 7d utilization, using THAT account's own reset as
  // the deadline. Fall back to the collapsed MAX scalar when accounts[] is absent (back-compat).
  let util7d: number;
  let weeklyReset: number | undefined;
  let accounts7d: Array<{ label: string; util7d: number }> | undefined;
  let bindingAccount: string | undefined;
  const accts = a?.accounts?.filter((x) => Number.isFinite(x.sevenDayUtilization));
  if (accts && accts.length > 0) {
    accounts7d = accts.map((x) => ({
      label: x.label,
      util7d: clamp01(x.sevenDayUtilization / 100),
    }));
    const binding = accts.reduce((lo, x) =>
      x.sevenDayUtilization < lo.sevenDayUtilization ? x : lo,
    );
    bindingAccount = binding.label;
    util7d = clamp01(binding.sevenDayUtilization / 100);
    weeklyReset = binding.sevenDayResetAt;
  } else {
    util7d = a ? clamp01(a.sevenDayUtilization / 100) : 0;
    weeklyReset = a?.sevenDayResetAt;
  }

  if (typeof weeklyReset !== "number" || weeklyReset <= nowMs) {
    return {
      pressure: 0,
      utilization5h: util5h,
      utilization7d: util7d,
      weekElapsed: 0.5,
      accounts7d,
      bindingAccount,
    };
  }
  const weekElapsed = clamp01(1 - (weeklyReset - nowMs) / WEEK_MS);
  const urgency = Math.pow(weekElapsed, URGENCY_EXP); // convex: low Sun–Tue, high Wed/Thu
  const headroom = clamp01(1 - util7d); // unused weekly cap
  const behindPace = clamp01(weekElapsed - util7d); // under-consuming vs an even spend
  const shouldBurn = clamp01(BURN_AGGRO * urgency * headroom + behindPace);
  return {
    pressure: -shouldBurn,
    utilization5h: util5h,
    utilization7d: util7d,
    weekElapsed,
    accounts7d,
    bindingAccount,
  };
}

export interface EffortCalib {
  count: number;
  perLevel: Record<string, number>;
}

export interface AllocateInput {
  /** −shouldBurn from deriveQuotaPressure (more negative ⇒ burn harder). */
  pressure: number;
  calib: EffortCalib;
  /** prompt length — a coarse task-weight signal (v2: full task features + outcome-best). */
  taskLen: number;
  /** monotonic per-turn counter — drives explore frequency deterministically (testable; no Math.random). */
  tick: number;
}

/** PURE policy. Returns a concrete level — Auto now means "allocator-chosen", never uncapped.
 *  The weekly burn-down sets a rising FLOOR; coarse task weight can push higher; exploration fills
 *  data when not urgent but NEVER undercuts the floor. NO 5h hard ceiling — we burn through it. */
export function allocateEffort(input: AllocateInput): ThinkLevel {
  const { pressure, calib, taskLen, tick } = input;
  const burnDemand = clamp01(-pressure); // weekly shouldBurn: 0 chill → 1 max
  const maturity = clamp01(calib.count / CALIB_TARGET);
  const maxIdx = LADDER.length - 1;
  const burnFloorIdx = clamp(Math.round(burnDemand * maxIdx), 0, maxIdx);
  // explore to gather data when NOT urgent; suppress near reset so the burn is exploited
  const epsilon = clamp01(EXPLORE_BASE * (1 - maturity) * (1 - burnDemand));
  const period = epsilon <= 1e-6 ? Infinity : Math.max(1, Math.round(1 / epsilon));
  const exploring = Number.isFinite(period) && tick % period === 0;

  if (exploring) {
    // coverage: least-sampled level AT/ABOVE the burn floor (never undercut the burn-down)
    let bestIdx = burnFloorIdx;
    let bestN = Infinity;
    for (let i = burnFloorIdx; i <= maxIdx; i++) {
      const n = calib.perLevel[LADDER[i]] ?? 0;
      if (n < bestN) {
        bestN = n;
        bestIdx = i;
      }
    }
    return LADDER[bestIdx];
  }

  // EXPLOIT: coarse task-weighted default, floored by the weekly burn-down demand.
  const taskIdx = taskLen < 280 ? 1 /* low */ : taskLen < 1200 ? 2 /* medium */ : 3 /* high */;
  return LADDER[clamp(Math.max(taskIdx, burnFloorIdx), 0, maxIdx)];
}

// ── persistent calibration (fail-safe; in-memory cache seeded from the ledger) ──
let memCalib: EffortCalib | null = null;
let memTick = 0;

function ledgerPath(): string {
  return path.join(resolveStateDir(), LEDGER_FILE);
}

/** Aggregate the ledger into {count, perLevel}. Cached in-memory; fail-to-empty. */
export function readEffortCalibration(): EffortCalib {
  if (memCalib) return memCalib;
  const calib: EffortCalib = { count: 0, perLevel: {} };
  try {
    const raw = fs.readFileSync(ledgerPath(), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { level?: string };
        if (row.level) {
          calib.count++;
          calib.perLevel[row.level] = (calib.perLevel[row.level] ?? 0) + 1;
        }
      } catch {
        /* skip a malformed line */
      }
    }
  } catch {
    /* no ledger yet → empty calib */
  }
  memCalib = calib;
  return calib;
}

function recordAllocation(
  level: ThinkLevel,
  ctx: {
    pressure: number;
    taskLen: number;
    sessionKey?: string;
    util5h: number;
    util7d: number;
    weekElapsed: number;
    bindingAccount?: string;
    accounts7d?: Array<{ label: string; util7d: number }>;
  },
  nowMs: number,
): void {
  const calib = readEffortCalibration();
  calib.count++; // in-memory reflects coverage/maturity immediately
  calib.perLevel[level] = (calib.perLevel[level] ?? 0) + 1;
  try {
    const row = JSON.stringify({
      ts: nowMs,
      level,
      pressure: Number(ctx.pressure.toFixed(3)),
      taskLen: ctx.taskLen,
      sessionKey: ctx.sessionKey,
      // FORK 2026-06-18 (§5.84a): live utilizations for v2 fastest-sustained-rate analysis.
      util5h: Number(ctx.util5h.toFixed(3)),
      util7d: Number(ctx.util7d.toFixed(3)),
      weekElapsed: Number(ctx.weekElapsed.toFixed(3)),
      // FORK 2026-06-19 (§5.84b): per-account 7d + which account bound the burn floor.
      bindingAccount: ctx.bindingAccount,
      accounts7d: ctx.accounts7d,
    });
    fs.appendFileSync(ledgerPath(), row + "\n");
  } catch {
    /* best-effort persistence — in-memory calib still advances */
  }
}

// FORK 2026-07-26 (the architect: "when I move the effort level it magically hops to high") —
// the size heuristic must measure what the USER asked, not the envelope we wrap it in.
//
// The Tinker UI appends a fixed ~3,369-character FRACTAL reflection instruction to every
// single message (app.ts buildInjectedPrompt). allocateEffort buckets on
// `taskLen < 280 ? low : taskLen < 1200 ? medium : high`, so once that suffix is attached
// EVERY prompt — a five-word question included — measures >3,300 chars and lands in the
// `high` bucket. The allocator could not physically choose low or medium from the UI.
//
// Measured before this fix in ~/.openclaw/effort-ledger.jsonl: 17 of the last 18
// allocations were `high`, every one with taskLen 1,300-1,600; the single `medium` had
// taskLen 289 (a cron, which does not carry the suffix).
//
// Rather than hardcode that one boilerplate, strip the standard appended sections: the
// injected trailer starts at the first section marker we control. Anything left is what
// the user actually typed.
const APPENDED_SECTION_MARKERS = [
  "\n\n---\n\n**After your reply, append",
  "\n\n---\n\n**After your reply",
  "🌿 FRACTAL",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
];
/** Length of the user's own request, with our standard injected trailer removed. */
export function userTaskLength(prompt: string | undefined): number {
  let text = prompt ?? "";
  for (const marker of APPENDED_SECTION_MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0) {
      text = text.slice(0, at);
    }
  }
  return text.trim().length;
}

/** Entry point for the `?? chooseAutoEffort(...)` tails (true-Auto primary turns only). */
export function chooseAutoEffort(opts: {
  prompt?: string;
  sessionKey?: string;
  nowMs?: number;
}): ThinkLevel {
  const nowMs = opts.nowMs ?? Date.now();
  const qp = deriveQuotaPressure(nowMs);
  const calib = readEffortCalibration();
  const taskLen = userTaskLength(opts.prompt);
  const level = allocateEffort({ pressure: qp.pressure, calib, taskLen, tick: memTick++ });
  recordAllocation(
    level,
    {
      pressure: qp.pressure,
      taskLen,
      sessionKey: opts.sessionKey,
      util5h: qp.utilization5h,
      util7d: qp.utilization7d,
      weekElapsed: qp.weekElapsed,
      bindingAccount: qp.bindingAccount,
      accounts7d: qp.accounts7d,
    },
    nowMs,
  );
  return level;
}

/** Test-only: reset the in-memory caches so unit tests are isolated. */
export function __resetEffortAllocatorMemoForTests(): void {
  memCalib = null;
  memTick = 0;
}
