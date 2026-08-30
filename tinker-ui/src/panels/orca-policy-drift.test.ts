// FORK 2026-07-25 (the architect): the ORCA panel links to orca-policy.md as "the exact one that
// drives the real policy, so that there is never a drift between the two."
//
// A prose file cannot literally BE the code, so this test is the enforcement: every constant
// the policy quotes is asserted against the value the running code actually uses. Change
// URGENCY_EXP in the allocator, or the fan-out cap in the orchestration runtime, without
// updating the md (or the reverse) and this fails. The panel can then never send the architect to a
// page describing a policy we are not running.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const POLICY_MD = resolve(REPO, "extensions/tinkerclaw-prefrontal/orca-policy.md");
const ALLOCATOR = resolve(REPO, "src/agents/effort-allocator.ts");
const RUNTIME = resolve(REPO, "extensions/tinkerclaw-prefrontal/orchestration-runtime.ts");

/** Parse the ```constants block — `NAME = value` per line. */
function policyConstants(): Record<string, string> {
  const md = readFileSync(POLICY_MD, "utf-8");
  const block = /```constants\n([\s\S]*?)```/.exec(md);
  if (!block) {
    throw new Error(`orca-policy.md has no \`\`\`constants block — the drift test cannot run`);
  }
  const out: Record<string, string> = {};
  for (const line of block[1].split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) {
      out[m[1]] = m[2];
    }
  }
  return out;
}

const C = policyConstants();
const allocator = readFileSync(ALLOCATOR, "utf-8");
const runtime = readFileSync(RUNTIME, "utf-8");

/** Read `const NAME = <number>;` out of a source file. */
function numericConst(src: string, name: string): number {
  const m = new RegExp(`const\\s+${name}\\s*(?::\\s*number\\s*)?=\\s*([0-9.]+)`).exec(src);
  if (!m) {
    throw new Error(`could not find const ${name}`);
  }
  return Number(m[1]);
}

describe("orca-policy.md ↔ effort-allocator.ts", () => {
  it("quotes the real URGENCY_EXP", () => {
    expect(Number(C.URGENCY_EXP)).toBe(numericConst(allocator, "URGENCY_EXP"));
  });

  it("quotes the real BURN_AGGRO", () => {
    expect(Number(C.BURN_AGGRO)).toBe(numericConst(allocator, "BURN_AGGRO"));
  });

  it("lists the real effort ladder, in order", () => {
    const m = /const LADDER: ThinkLevel\[\] = \[([^\]]+)\]/.exec(allocator);
    expect(m, "LADDER not found in effort-allocator.ts").toBeTruthy();
    const real = m![1].match(/"([a-z]+)"/g)!.map((q) => q.replace(/"/g, ""));
    expect(C.EFFORT_LADDER.split(",").map((s) => s.trim())).toEqual(real);
  });

  it("quotes the real quota window", () => {
    const m = /const WEEK_MS = (\d+) \* 24 \* 60 \* 60 \* 1000/.exec(allocator);
    expect(m, "WEEK_MS not found").toBeTruthy();
    expect(Number(C.QUOTA_WINDOW_DAYS)).toBe(Number(m![1]));
  });
});

describe("orca-policy.md ↔ orchestration-runtime.ts", () => {
  it("quotes the real fan-out cap, reserved cores and floor", () => {
    // function concurrencyCap(): Math.max(FLOOR, Math.min(HARD_CAP, cores - RESERVED))
    const m = /Math\.max\((\d+),\s*Math\.min\((\d+),\s*cores\s*-\s*(\d+)\)\)/.exec(runtime);
    expect(m, "concurrencyCap shape not found in orchestration-runtime.ts").toBeTruthy();
    expect(Number(C.FANOUT_FLOOR)).toBe(Number(m![1]));
    expect(Number(C.FANOUT_HARD_CAP)).toBe(Number(m![2]));
    expect(Number(C.FANOUT_RESERVED_CORES)).toBe(Number(m![3]));
  });
});

describe("orca-policy.md ↔ the panel's mirrored constants", () => {
  it("the panel mirrors the same burn-down constants the policy quotes", () => {
    // routing-rationale.ts re-declares these to explain an Auto pick without a round trip;
    // if it drifts, the panel's numbers stop matching both the policy AND the allocator.
    const panel = readFileSync(resolve(HERE, "routing-rationale.ts"), "utf-8");
    expect(numericConst(panel, "URGENCY_EXP")).toBe(Number(C.URGENCY_EXP));
    expect(numericConst(panel, "BURN_AGGRO")).toBe(Number(C.BURN_AGGRO));
    const ladder = /const LADDER = \[([^\]]+)\]/.exec(panel)![1];
    expect(ladder.match(/"([a-z]+)"/g)!.map((q) => q.replace(/"/g, ""))).toEqual(
      C.EFFORT_LADDER.split(",").map((s) => s.trim()),
    );
  });
});

describe("orca-policy.md ↔ orca-conductor.mjs (cross-repo, best effort)", () => {
  // The Conductor lives in jarvis-icu, which may not exist on another machine. Skip rather
  // than fail there — but when it IS present, the routing constants must agree.
  const conductorPath = resolve(homedir(), "src/jarvis-icu/docs/superpowers/orca-conductor.mjs");
  let conductor: string | null = null;
  try {
    conductor = readFileSync(conductorPath, "utf-8");
  } catch {
    conductor = null;
  }

  it.skipIf(!conductor)("quotes the real PRIOR_STRENGTH, CONTEST_MARGIN and MAX_STEPS", () => {
    expect(numericConst(conductor!, "PRIOR_STRENGTH")).toBe(Number(C.PRIOR_STRENGTH));
    expect(numericConst(conductor!, "CONTEST_MARGIN")).toBe(Number(C.CONTEST_MARGIN));
    expect(numericConst(conductor!, "MAX_STEPS")).toBe(Number(C.MAX_STEPS));
  });
});

describe("the policy file itself", () => {
  it("documents all three axes the panel shows", () => {
    const md = readFileSync(POLICY_MD, "utf-8");
    expect(md).toMatch(/^## MODEL/m);
    expect(md).toMatch(/^## EFFORT/m);
    expect(md).toMatch(/^## FAN-OUT/m);
  });

  it("declares every constant the test checks", () => {
    for (const name of [
      "URGENCY_EXP",
      "BURN_AGGRO",
      "EFFORT_LADDER",
      "QUOTA_WINDOW_DAYS",
      "FANOUT_RESERVED_CORES",
      "FANOUT_HARD_CAP",
      "FANOUT_FLOOR",
      "PRIOR_STRENGTH",
      "CONTEST_MARGIN",
      "MAX_STEPS",
    ]) {
      expect(C[name], `${name} missing from the constants block`).toBeDefined();
    }
  });
});
