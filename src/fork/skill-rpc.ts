/**
 * FORK — Skill-library RPC handlers (Upgrade 6, J5 Voyager skill-library-as-code).
 *
 * Gateway RPC surface over the versioned, never-delete Skill library
 * (src/memory/engram/skill-library.ts). Styled exactly like src/fork/curiosity-rpc.ts:
 * the same GatewayRequestHandlers shape, the same readStr/readNum/readBool param guards,
 * the same errorShape responses. Every method is fork-only — no upstream path is patched.
 *
 * Handlers:
 *   fork.skill.search(query, k)            — semantic (or keyword-fallback) search of the
 *                                            live library; returns top-k SkillRefs by
 *                                            relevance. Wraps SkillLibrary.search.
 *   fork.skill.recordOutcome(skillId, success)
 *                                          — record one execution outcome into a skill's
 *                                            successMetrics (monotonic Laplace-smoothed
 *                                            fitness). Wraps SkillLibrary.recordOutcome,
 *                                            with a read-back so an unknown skillId is a
 *                                            clean INVALID_REQUEST rather than a silent no-op.
 *
 * Persistence + dedup + versioning all live in createSkillLibrary; this surface is a thin,
 * stateless adapter. The ENGRAM root is resolved exactly like failure-tracking-store.ts
 * (the sibling Upgrade-4 store): `baseDir ?? ~/.openclaw/engram`, with an optional `baseDir`
 * param so tests can redirect to a temp dir.
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 6).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveSkillEmbedFn } from "../memory/engram/skill-embed.js";
import { recordSkillOutcome } from "../memory/engram/skill-invocation.js";
import { createSkillLibrary } from "../memory/engram/skill-library.js";
import type { Skill } from "../memory/storage/types.js";

const log = createSubsystemLogger("fork-skill");

function readStr(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function readNum(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function readBool(p: Record<string, unknown>, k: string): boolean {
  const v = p[k];
  return v === true || v === "true" || v === 1;
}

/**
 * Resolve the ENGRAM root the skill library is rooted at. Mirrors
 * failure-tracking-store.failureStatePath: `baseDir` overrides the default
 * `~/.openclaw/engram` (pass a temp dir in tests).
 */
function engramRoot(baseDir?: string): string {
  return baseDir ?? join(process.env.OPENCLAW_HOME ?? homedir(), ".openclaw", "engram");
}

/**
 * SS3 live-margin promotion bar (J16: derived from the library's CURRENT fitness
 * distribution, never a frozen N). A promotion candidate clears the bar when its
 * already-MEASURED success rate (e.g. replay / recipe-fitness) strictly exceeds the
 * mean of existing skills' rates by at least one population standard deviation — the
 * spread itself sets the bar (a tight, high-performing library demands more; a
 * sparse/new one is permissive). Empty library → permissive.
 */
export function clearsPromotionBar(candidateRate: number, existingRates: number[]): boolean {
  if (existingRates.length === 0) return true;
  const mean = existingRates.reduce((a, b) => a + b, 0) / existingRates.length;
  const variance = existingRates.reduce((a, b) => a + (b - mean) ** 2, 0) / existingRates.length;
  const std = Math.sqrt(variance);
  return candidateRate > mean + std;
}

interface SkillDepositInput {
  name: string;
  description?: string;
  steps: string[];
  prerequisites?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  verifiedCode?: string;
  composedSkills?: string[];
  composedRecipes?: string[];
  sourceQuery?: string;
  composedFrom?: "compose" | "extraction" | "promotion";
}

/** Build a complete Skill from caller-supplied deposit input (the handler does the
 * fail-closed validation before this runs). Fresh skillId + Laplace-neutral metrics
 * — a deposited skill begins its own invocation history. */
function buildDepositedSkill(input: SkillDepositInput, atISO: string): Skill {
  const skill: Skill = {
    skillId: `dep-${randomUUID()}`,
    version: 1,
    name: input.name,
    description: input.description ?? "",
    prerequisites: input.prerequisites ?? [],
    steps: input.steps,
    testCases: [],
    successMetrics: { invocations: 0, successes: 0, successRate: 0.5, lastInvoked: null },
    sourceEpisodeIds: [],
    created: atISO,
    deprecated: false,
    lineage: {
      composedFrom: input.composedFrom ?? "compose",
      ...(input.composedSkills ? { composedSkills: input.composedSkills } : {}),
      ...(input.composedRecipes ? { composedRecipes: input.composedRecipes } : {}),
      ...(input.sourceQuery ? { sourceQuery: input.sourceQuery } : {}),
    },
  };
  if (input.inputSchema) skill.inputSchema = input.inputSchema;
  if (input.outputSchema) skill.outputSchema = input.outputSchema;
  if (input.verifiedCode !== undefined) skill.verifiedCode = input.verifiedCode;
  return skill;
}

export const forkSkillHandlers: GatewayRequestHandlers = {
  // U6 — semantic/keyword search of the live skill library.
  "fork.skill.search": async ({ params, respond }) => {
    const p = params ?? {};
    const query = readStr(p, "query");
    if (!query) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fork.skill.search: 'query' required."),
      );
      return;
    }
    const k = readNum(p, "k") ?? 5;
    const excludeDeprecated = "excludeDeprecated" in p ? readBool(p, "excludeDeprecated") : true;
    const baseDir = readStr(p, "baseDir");

    try {
      // SS3: resolve the in-process embed fn (same path as the consolidation cron)
      // so search is SEMANTIC when a provider is configured; undefined → the
      // library's keyword fallback (tests/clones/headless), unchanged behavior.
      const embedFn = await resolveSkillEmbedFn();
      const lib = createSkillLibrary({
        baseDir: engramRoot(baseDir),
        ...(embedFn ? { embedFn } : {}),
      });
      const skills = await lib.search(query, k, { excludeDeprecated });
      log.info(
        `fork.skill.search query="${query}" k=${k} embed=${embedFn ? "semantic" : "keyword"} returned=${skills.length}`,
      );
      respond(true, { ok: true, skills }, undefined);
    } catch (err) {
      console.error("[fork.skill.search] search failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.skill.search: failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  // U6 — record one execution outcome into a skill's success metrics.
  "fork.skill.recordOutcome": async ({ params, respond }) => {
    const p = params ?? {};
    const skillId = readStr(p, "skillId");
    if (!skillId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fork.skill.recordOutcome: 'skillId' required."),
      );
      return;
    }
    const success = readBool(p, "success");
    const baseDir = readStr(p, "baseDir");

    try {
      const lib = createSkillLibrary({ baseDir: engramRoot(baseDir) });
      // Read-back so an unknown skillId is a clean error rather than a silent no-op
      // (recordOutcome itself returns void and no-ops on a missing skill).
      if (!lib.read(skillId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `fork.skill.recordOutcome: skill '${skillId}' not found.`,
          ),
        );
        return;
      }
      // Route through the Cerebellum-side skill-invocation seam (recordSkillOutcome)
      // — the canonical "externally-observed outcome" recorder the Wire phase hands
      // to whoever ran the skill (e.g. the Prefrontal recipe-runner) — rather than
      // poking the library directly, so the fitness-update path is single-owner.
      recordSkillOutcome(lib, skillId, success);
      const updated = lib.read(skillId);
      log.info(
        `fork.skill.recordOutcome skillId=${skillId} success=${success} invocations=${updated?.successMetrics.invocations ?? "?"}`,
      );
      respond(
        true,
        {
          ok: true,
          skillId,
          successMetrics: updated?.successMetrics,
        },
        undefined,
      );
    } catch (err) {
      console.error("[fork.skill.recordOutcome] failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.skill.recordOutcome: failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  // SS3 — deposit a composed/promoted skill into the never-delete library. This is
  // the genuine flywheel gap: lib.put exists but was unexposed, so "deposit a
  // reusable skill" was unimplementable via RPC. Caller-driven (compose /
  // consolidation call it). Deposit gate (Oscar delegated, bible-principled):
  //  - fail-closed on a malformed skill (no silent failure);
  //  - reversible for free (never-delete archive; dedup/version-bump on a same name);
  //  - overwrite guard: a curated/promoted seed is not auto-clobbered (allowReplace);
  //  - promote:true applies a LIVE-MARGIN fitness bar (clearsPromotionBar, J16 — the
  //    replay-before-promote check is the caller's pre-step). bar + replay are
  //    parameters, not hardcoded.
  "fork.skill.put": async ({ params, respond }) => {
    const p = params ?? {};
    const rawSkill = p.skill;
    if (!rawSkill || typeof rawSkill !== "object") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fork.skill.put: 'skill' object required."),
      );
      return;
    }
    const s = rawSkill as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name.trim() : "";
    const steps = Array.isArray(s.steps)
      ? s.steps.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    if (!name || steps.length === 0) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "fork.skill.put: skill needs a non-empty 'name' and at least one 'steps' entry.",
        ),
      );
      return;
    }
    const allowReplace = readBool(p, "allowReplace");
    const promote = readBool(p, "promote");
    const candidateRate = readNum(p, "candidateRate");
    const baseDir = readStr(p, "baseDir");

    try {
      const lib = createSkillLibrary({ baseDir: engramRoot(baseDir) });

      // Overwrite guard — never silently clobber a CURATED/promoted seed.
      const existingRef = lib.list().find((r) => r.name === name && !r.deprecated);
      if (existingRef && !allowReplace) {
        const existing = lib.read(existingRef.skillId);
        if (existing?.lineage?.composedFrom === "promotion") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `fork.skill.put: "${name}" is a curated/promoted skill — pass allowReplace:true to overwrite.`,
            ),
          );
          return;
        }
      }

      // Promotion fitness arm (J16 live margin). The caller supplies a MEASURED
      // candidateRate (e.g. from a replay re-run / recipe fitness).
      if (promote) {
        if (typeof candidateRate !== "number") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "fork.skill.put: promote:true requires a measured 'candidateRate'.",
            ),
          );
          return;
        }
        const existingRates = lib
          .list()
          .filter((r) => !r.deprecated)
          .map((r) => r.successRate);
        if (!clearsPromotionBar(candidateRate, existingRates)) {
          respond(
            true,
            {
              ok: false,
              promoted: false,
              note: `candidate rate ${candidateRate.toFixed(3)} did not clear the live promotion bar`,
            },
            undefined,
          );
          return;
        }
      }

      const asStrArr = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
      const skill = buildDepositedSkill(
        {
          name,
          description: typeof s.description === "string" ? s.description : "",
          steps,
          prerequisites: asStrArr(s.prerequisites),
          inputSchema:
            s.inputSchema && typeof s.inputSchema === "object"
              ? (s.inputSchema as Record<string, unknown>)
              : undefined,
          outputSchema:
            s.outputSchema && typeof s.outputSchema === "object"
              ? (s.outputSchema as Record<string, unknown>)
              : undefined,
          verifiedCode: typeof s.verifiedCode === "string" ? s.verifiedCode : undefined,
          composedSkills: asStrArr(s.composedSkills),
          composedRecipes: asStrArr(s.composedRecipes),
          sourceQuery: typeof s.sourceQuery === "string" ? s.sourceQuery : undefined,
          composedFrom:
            s.composedFrom === "extraction" || s.composedFrom === "promotion"
              ? s.composedFrom
              : "compose",
        },
        new Date().toISOString(),
      );

      const ref = await lib.put(skill);
      log.info(
        `fork.skill.put name="${name}" skillId=${ref.skillId} version=${ref.version} promote=${promote}`,
      );
      respond(
        true,
        { ok: true, promoted: promote, skillId: ref.skillId, version: ref.version, name: ref.name },
        undefined,
      );
    } catch (err) {
      console.error("[fork.skill.put] failed", err);
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `fork.skill.put: failed (devtools console has full error): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};
