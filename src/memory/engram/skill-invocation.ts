/**
 * ENGRAM — Skill invocation outcome tracking (Upgrade 6, J5 Voyager).
 *
 * The Cerebellum owns skill FITNESS; the Prefrontal recipe-runner owns skill
 * EXECUTION (the same split as Upgrade 1's recipe archive). This module is the
 * Cerebellum-side seam: given a skill, it (1) checks prerequisites and validates
 * inputs against the skill's testCases, then (2) wraps the actual execution
 * (performed by an injected runner — in production the Prefrontal recipe-runner)
 * and RECORDS the success/failure back into the SkillLibrary's successMetrics so
 * future `rank()`/`search()` reflect empirical performance.
 *
 * It deliberately does NOT dispatch execution itself — `runner` is injected so
 * the actual recipe-runner call lives in the Prefrontal layer (a cross-subsystem
 * step out of scope here). When no runner is given, this module still records an
 * externally-observed outcome via {@link recordSkillOutcome} — the callback the
 * Wire phase hands to whoever ran the skill.
 *
 * STALE-SKILL mitigation (risk #4): recordOutcome on the library updates the
 * Laplace-smoothed successRate so a skill that starts failing (e.g. encodes an
 * obsolete API) sinks in the ranking and becomes deprecation-reachable.
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 6).
 */

import type { Skill, SkillTestCase } from "../storage/types.js";
import type { SkillLibrary } from "./skill-library.js";

/** Outcome of attempting to invoke a skill. */
export interface SkillInvocationResult {
  skillId: string;
  /** Whether the skill executed successfully. */
  success: boolean;
  /** Why it could not run / why it failed (empty on clean success). */
  reason?: string;
  /** Which prerequisites were unmet (empty when all satisfied). */
  unmetPrerequisites?: string[];
}

/**
 * The execution callback. In production this is the Prefrontal recipe-runner; in
 * tests a deterministic stub. Returns whether the run succeeded (and an optional
 * reason on failure).
 */
export type SkillRunner = (
  skill: Skill,
  input: Record<string, unknown>,
) => Promise<{ success: boolean; reason?: string }> | { success: boolean; reason?: string };

/**
 * Check a skill's prerequisites against a set the caller declares satisfied.
 * Returns the prerequisites NOT in the satisfied set (empty ⇒ all met).
 * Prerequisites are free-text procedural conditions; matching is exact-string by
 * default (the caller normalizes). This is intentionally simple — the Cerebellum
 * does not interpret prerequisite semantics.
 */
export function checkPrerequisites(skill: Skill, satisfied: Iterable<string>): string[] {
  const have = new Set(satisfied);
  return skill.prerequisites.filter((p) => !have.has(p));
}

/** Validate that an input object names every key the skill's testCases reference. */
export function validateInputs(
  testCases: SkillTestCase[],
  input: Record<string, unknown>,
): boolean {
  for (const tc of testCases) {
    for (const key of Object.keys(tc.input)) {
      if (!(key in input)) {
        return false;
      }
    }
  }
  return true;
}

export interface InvokeSkillOptions {
  /** Prerequisites the caller declares satisfied (default: none ⇒ strict gate). */
  satisfiedPrerequisites?: Iterable<string>;
  /** Skip the prerequisite gate entirely (default false). */
  skipPrerequisiteCheck?: boolean;
}

/**
 * Invoke a skill: gate on prerequisites, run it via the injected runner, and
 * record the outcome back into the library. The outcome is ALWAYS recorded when
 * the runner ran (success or failure) so fitness reflects reality; a
 * prerequisite/validation refusal does NOT record an outcome (the skill never
 * ran, so it should not be penalized).
 */
export async function invokeSkill(
  library: SkillLibrary,
  skillId: string,
  input: Record<string, unknown>,
  runner: SkillRunner,
  opts: InvokeSkillOptions = {},
): Promise<SkillInvocationResult> {
  const skill = library.read(skillId);
  if (!skill) {
    return { skillId, success: false, reason: "skill not found" };
  }
  if (skill.deprecated) {
    return { skillId, success: false, reason: "skill is deprecated" };
  }

  if (!opts.skipPrerequisiteCheck) {
    const unmet = checkPrerequisites(skill, opts.satisfiedPrerequisites ?? []);
    if (unmet.length > 0) {
      // Refusal, not a failure — do not record an outcome.
      return { skillId, success: false, reason: "unmet prerequisites", unmetPrerequisites: unmet };
    }
  }

  if (!validateInputs(skill.testCases, input)) {
    return { skillId, success: false, reason: "invalid inputs for skill testCases" };
  }

  const ran = await runner(skill, input);
  // The skill genuinely executed → record the empirical outcome.
  library.recordOutcome(skillId, ran.success);
  return {
    skillId,
    success: ran.success,
    ...(ran.reason ? { reason: ran.reason } : {}),
  };
}

/**
 * Record an externally-observed skill outcome (when execution happened outside
 * this module, e.g. the Prefrontal recipe-runner reports back). This is the
 * recordOutcome CALLBACK the Wire phase hands to the runner.
 */
export function recordSkillOutcome(
  library: SkillLibrary,
  skillId: string,
  success: boolean,
  atISO?: string,
): void {
  library.recordOutcome(skillId, success, atISO);
}

/** Build a bound recordOutcome callback for a single skill (Wire-phase convenience). */
export function makeOutcomeRecorder(
  library: SkillLibrary,
  skillId: string,
): (success: boolean) => void {
  return (success: boolean) => library.recordOutcome(skillId, success);
}
