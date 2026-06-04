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

import { homedir } from "node:os";
import { join } from "node:path";
import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveSkillEmbedFn } from "../memory/engram/skill-embed.js";
import { recordSkillOutcome } from "../memory/engram/skill-invocation.js";
import { createSkillLibrary } from "../memory/engram/skill-library.js";

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
};
