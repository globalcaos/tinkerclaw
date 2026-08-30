// FORK 2026-07-25 (the architect): the ORCA panel's policy view is served from orca-policy.md, and
// the architect's requirement was "the exact one that drives the real policy, so that there is never
// a drift between the two". A doc cannot literally BE the code, so this test is the joint:
// every load-bearing number in the md's `constants` block is asserted against the real
// source. Change one side only and this fails.
//
// Covers the two axes whose code lives in THIS repo (effort, fan-out) plus the routing
// constants from the Conductor, which lives in jarvis-icu — that half is checked when the
// file is present and skipped (loudly) when it is not, so the suite still runs on a clone.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = join(here, "..", "orca-policy.md");
const ALLOCATOR = join(here, "..", "..", "..", "src", "agents", "effort-allocator.ts");
const RUNTIME = join(here, "..", "orchestration-runtime.ts");
const CONDUCTOR = join(homedir(), "src", "jarvis-icu", "docs", "superpowers", "orca-conductor.mjs");

/** Parse the md's ```constants block into name → value. */
function policyConstants(): Record<string, string> {
  const md = readFileSync(POLICY, "utf-8");
  const block = /```constants\n([\s\S]*?)```/.exec(md);
  if (!block) {
    throw new Error("orca-policy.md has no ```constants block — the drift joint is missing");
  }
  const out: Record<string, string> = {};
  for (const line of block[1].split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Read `const NAME = <number>` out of a source file. */
function numericConst(file: string, name: string): number {
  const src = readFileSync(file, "utf-8");
  const m = new RegExp(
    `(?:const|export const)\\s+${name}\\s*(?::\\s*number)?\\s*=\\s*([0-9.]+)`,
  ).exec(src);
  if (!m) throw new Error(`${name} not found in ${file}`);
  return Number(m[1]);
}

describe("orca-policy.md ↔ code (no drift)", () => {
  const C = policyConstants();

  it("declares every constant the policy prose leans on", () => {
    for (const key of [
      "URGENCY_EXP",
      "BURN_AGGRO",
      "EFFORT_LADDER",
      "QUOTA_WINDOW_DAYS",
      "FANOUT_RESERVED_CORES",
      "FANOUT_HARD_CAP",
      "FANOUT_FLOOR",
      "PRIOR_STRENGTH",
      "CONTEST_MARGIN",
      "EXPLORE_BONUS",
      "MAX_STEPS",
    ]) {
      expect(C[key], `${key} missing from the constants block`).toBeDefined();
    }
  });

  // ── EFFORT axis — src/agents/effort-allocator.ts ──
  it("EFFORT: urgency exponent matches the allocator", () => {
    expect(Number(C.URGENCY_EXP)).toBe(numericConst(ALLOCATOR, "URGENCY_EXP"));
  });

  it("EFFORT: burn aggressiveness matches the allocator", () => {
    expect(Number(C.BURN_AGGRO)).toBe(numericConst(ALLOCATOR, "BURN_AGGRO"));
  });

  it("EFFORT: the ladder matches the allocator, in order", () => {
    const src = readFileSync(ALLOCATOR, "utf-8");
    const m = /const LADDER: ThinkLevel\[\] = \[([^\]]+)\]/.exec(src);
    expect(m, "LADDER not found in effort-allocator.ts").toBeTruthy();
    const code = m![1]
      .split(",")
      .map((s) => s.trim().replace(/['"]/g, ""))
      .filter(Boolean);
    expect(C.EFFORT_LADDER.split(",").map((s) => s.trim())).toEqual(code);
  });

  it("EFFORT: the quota window matches the allocator's WEEK_MS", () => {
    const src = readFileSync(ALLOCATOR, "utf-8");
    const m = /const WEEK_MS = (\d+) \* 24 \* 60 \* 60 \* 1000/.exec(src);
    expect(m, "WEEK_MS not found in effort-allocator.ts").toBeTruthy();
    expect(Number(C.QUOTA_WINDOW_DAYS)).toBe(Number(m![1]));
  });

  // ── FAN-OUT axis — orchestration-runtime.ts concurrencyCap() ──
  it("FAN-OUT: cap formula matches concurrencyCap()", () => {
    const src = readFileSync(RUNTIME, "utf-8");
    const m = /Math\.max\((\d+),\s*Math\.min\((\d+),\s*cores\s*-\s*(\d+)\)\)/.exec(src);
    expect(m, "the concurrencyCap() formula changed shape — update orca-policy.md").toBeTruthy();
    expect(Number(C.FANOUT_FLOOR)).toBe(Number(m![1]));
    expect(Number(C.FANOUT_HARD_CAP)).toBe(Number(m![2]));
    expect(Number(C.FANOUT_RESERVED_CORES)).toBe(Number(m![3]));
  });

  // ── MODEL axis — the Conductor (cross-repo) ──
  const hasConductor = existsSync(CONDUCTOR);
  it.skipIf(!hasConductor)(
    "MODEL: prior strength / contest margin / step ceiling match the Conductor",
    () => {
      expect(Number(C.PRIOR_STRENGTH)).toBe(numericConst(CONDUCTOR, "PRIOR_STRENGTH"));
      expect(Number(C.CONTEST_MARGIN)).toBe(numericConst(CONDUCTOR, "CONTEST_MARGIN"));
      expect(Number(C.MAX_STEPS)).toBe(numericConst(CONDUCTOR, "MAX_STEPS"));
      expect(Number(C.EXPLORE_BONUS)).toBe(numericConst(CONDUCTOR, "EXPLORE_BONUS"));
    },
  );

  it.skipIf(!hasConductor)(
    "MODEL: every domain named in the policy exists in the Conductor",
    () => {
      const src = readFileSync(CONDUCTOR, "utf-8");
      const m = /export const DOMAINS = \[([\s\S]*?)\]/.exec(src);
      expect(m, "DOMAINS not found in orca-conductor.mjs").toBeTruthy();
      const domains = [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
      const md = readFileSync(POLICY, "utf-8");
      const listed = /\(([^)]*debug[^)]*)\)/.exec(md);
      expect(listed, "the policy no longer lists the domain set").toBeTruthy();
      for (const d of listed![1].split(",").map((s) => s.trim())) {
        expect(domains, `policy names domain "${d}" that the Conductor does not have`).toContain(d);
      }
    },
  );
});

describe("orca-policy.md shape", () => {
  it("documents exactly the three axes the panel shows", () => {
    const md = readFileSync(POLICY, "utf-8");
    expect(md).toMatch(/^## MODEL/m);
    expect(md).toMatch(/^## EFFORT/m);
    expect(md).toMatch(/^## FAN-OUT/m);
  });

  it("states that a pinned effort is obeyed with no override", () => {
    expect(readFileSync(POLICY, "utf-8")).toMatch(/pinned effort is obeyed/i);
  });
});
