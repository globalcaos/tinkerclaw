/**
 * ENGRAM — Skill extraction (Upgrade 6, J5 Voyager skill-library-as-code).
 *
 * Post-episode skill synthesis: from a COMPLETED, skill-worthy episode, distil a
 * generalizable, reusable PROCEDURE — the Voyager move of turning today's
 * hard-won episode into tomorrow's reflexive skill. A `Skill` is a STRUCTURED
 * PROCEDURE (named steps + prerequisites + successMetrics) with an OPTIONAL
 * `verifiedCode` field; in this fork recipes are already markdown procedures run
 * by the Prefrontal kit-runner, so the default skill shape is "skill-as-recipe"
 * (steps[]) and `verifiedCode` is the true-Voyager opt-in when the extractor
 * synthesized a runnable, verified snippet.
 *
 * GRANULARITY: one skill per worthy episode. Clustering many episodes into a
 * higher-order skill during a weekly REM phase is DEFERRED (see improvement_notes
 * §Upgrade 6 open question on granularity).
 *
 * The Cerebellum only EXTRACTS — it never executes a skill. The body is produced
 * by an injected LLM callback (same dependency-injection style as
 * SleepConsolidationConfig.summarizeEpisode), so tests inject a deterministic
 * stub. A strict `isSkillWorthy` gate keeps the library from filling with
 * trivial/non-general "skills" that would pollute retrieval (risk #1).
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 6).
 */

import type { Skill, SkillSuccessMetrics, SkillTestCase } from "../storage/types.js";
import type { Episode } from "./episode-detection.js";
import { generateULID } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";

/**
 * The structured body an extractor LLM must return for a skill. The library
 * fields (skillId, version, successMetrics, created, deprecated, sourceEpisodeIds)
 * are stamped by {@link extractSkill}, not the LLM — the callback only supplies
 * the human-meaningful procedure.
 */
export interface SkillBody {
  name: string;
  description: string;
  prerequisites: string[];
  steps: string[];
  testCases: SkillTestCase[];
  /** OPTIONAL true-Voyager runnable snippet (skill-as-code). */
  verifiedCode?: string;
}

/**
 * Injected synthesis callback. Returns a {@link SkillBody}, or null when it
 * declines to extract a skill from this episode. LLM-backed in production,
 * a deterministic stub in tests (mirrors summarizeEpisode injection).
 */
export type SkillExtractor = (
  episode: Episode,
  episodeEvents: MemoryEvent[],
) => SkillBody | null | Promise<SkillBody | null>;

/** Fresh success metrics for a never-invoked skill (Laplace-smoothed). */
function initialSuccessMetrics(): SkillSuccessMetrics {
  return {
    invocations: 0,
    successes: 0,
    // Laplace: (0 + 1) / (0 + 2) = 0.5 — a fresh skill is not claimed perfect.
    successRate: laplaceSkillRate(0, 0),
    lastInvoked: null,
  };
}

/** Laplace-smoothed success rate, matching the recipe-fitness convention. */
export function laplaceSkillRate(successes: number, invocations: number): number {
  return (successes + 1) / (invocations + 2);
}

/**
 * Strict skill-worthiness gate. A skill is only extracted from an episode that:
 *   1. COMPLETED (never learn a skill from an abandoned/ongoing attempt), AND
 *   2. used a tool (the procedure has an executable core, not pure chat), AND
 *   3. recorded at least one key decision (there is a generalizable choice to
 *      encode, not a trivial one-shot tool call).
 *
 * Keeping this gate strict is the primary defense against library bloat /
 * retrieval pollution (risk #1).
 */
export function isSkillWorthy(episode: Episode, episodeEvents: MemoryEvent[]): boolean {
  if (episode.outcome !== "completed") {
    return false;
  }
  const hasToolCall = episodeEvents.some((e) => e.kind === "tool_call");
  if (!hasToolCall) {
    return false;
  }
  if (episode.keyDecisions.length === 0) {
    return false;
  }
  return true;
}

/** A SkillBody is well-formed only with a name and at least one step. */
function isWellFormed(body: SkillBody): boolean {
  return (
    typeof body.name === "string" &&
    body.name.length > 0 &&
    Array.isArray(body.steps) &&
    body.steps.length > 0
  );
}

/**
 * Extract a Skill from a completed episode. Returns null when the episode is not
 * skill-worthy, when the LLM declines, or when the synthesized body is malformed
 * (no spurious or empty skills enter the library).
 *
 * The returned Skill is version 1 with fresh (un-invoked) success metrics; the
 * library's `put` handles versioning + dedup when a same-named skill recurs.
 */
export async function extractSkill(
  episode: Episode,
  episodeEvents: MemoryEvent[],
  llm: SkillExtractor,
  atISO: string = new Date().toISOString(),
): Promise<Skill | null> {
  if (!isSkillWorthy(episode, episodeEvents)) {
    return null;
  }

  const body = await llm(episode, episodeEvents);
  if (!body || !isWellFormed(body)) {
    return null;
  }

  const skill: Skill = {
    skillId: generateULID(),
    version: 1,
    name: body.name,
    description: body.description ?? "",
    prerequisites: body.prerequisites ?? [],
    steps: body.steps,
    testCases: body.testCases ?? [],
    successMetrics: initialSuccessMetrics(),
    sourceEpisodeIds: [episode.id],
    created: atISO,
    deprecated: false,
  };
  if (body.verifiedCode !== undefined) {
    skill.verifiedCode = body.verifiedCode;
  }
  return skill;
}

export { initialSuccessMetrics };
