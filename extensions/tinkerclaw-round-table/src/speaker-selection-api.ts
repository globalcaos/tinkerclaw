/**
 * SYNAPSE 7A: Pluggable speaker-selection hook (AG2-compliant).
 *
 * Today role->model assignment is a hardcoded greedy bipartite match (raac-protocol
 * `assignRoles`). AG2's contribution is that *who speaks next* (and in what role) is
 * a first-class, swappable policy — not baked into the protocol. Exposing a
 * speaker-selection hook lets a CORTEX persona, a cron, or an external AG2 manager
 * drive role assignment, which is exactly the "different brain regions weighted
 * differently per decision" framing in the human-brain grounding.
 *
 * The INTERFACE lives here; the PROVIDER can live in a sibling plugin (resolved via
 * the gateway) — keeping the substrate open without coupling this extension to any
 * one manager.
 */

import type { ProviderProfile } from "./cognitive-diversity.js";
import { assignRoles } from "./raac-protocol.js";

export interface SpeakerSelectionContext {
  /** Candidate participants. */
  profiles: ProviderProfile[];
  /** All assignable roles (raac-protocol ALL_ROLES). */
  roles: string[];
  /** Existing assignment, for rebalance / multi-turn resume. */
  existingAssignment?: Record<string, string>;
  /** The debate task/topic, so heuristic hooks can specialize. */
  task: string;
}

export interface SpeakerSelectionHook {
  id: string;
  /**
   * Returns modelId -> role. An empty/invalid map => the caller falls back to the
   * builtin `assignRoles`. May be sync or async.
   */
  assign(ctx: SpeakerSelectionContext): Promise<Record<string, string>> | Record<string, string>;
}

export type SpeakerSelectionMode = "builtin" | "ag2-hook" | "auto";

/**
 * The builtin hook wraps `assignRoles` so the default behaviour is byte-identical to
 * the original protocol.
 */
export const builtinSpeakerSelectionHook: SpeakerSelectionHook = {
  id: "builtin",
  assign: (ctx) => assignRoles(ctx.profiles.map((p) => p.modelId)),
};

/**
 * Resolve the active hook from config mode.
 * - "builtin": always the builtin hook.
 * - "ag2-hook": use the supplied external hook; null if none was provided.
 * - "auto": prefer the external hook when present, else builtin.
 *
 * Returns null only when mode demands an external hook that is absent — the caller
 * then falls back to `assignRoles` directly (recon Risk 4: an absent/empty hook must
 * never hard-fail the debate).
 */
export function resolveSpeakerSelection(
  mode: SpeakerSelectionMode,
  externalHook?: SpeakerSelectionHook | null,
): SpeakerSelectionHook | null {
  switch (mode) {
    case "builtin":
      return builtinSpeakerSelectionHook;
    case "ag2-hook":
      return externalHook ?? null;
    case "auto":
      return externalHook ?? builtinSpeakerSelectionHook;
    default:
      return builtinSpeakerSelectionHook;
  }
}

/**
 * Validate a hook's result: every key must be a known modelId in the context, every
 * value a role in ctx.roles, roles must be unique, and (critical for the synthesize
 * phase, raac-protocol `runDebateRound`) exactly one model must hold "synthesizer"
 * when that role is assignable. Returns the normalized map, or null on any violation.
 */
export function validateAssignment(
  ctx: SpeakerSelectionContext,
  assignment: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!assignment || typeof assignment !== "object") return null;

  const knownIds = new Set(ctx.profiles.map((p) => p.modelId));
  const validRoles = new Set(ctx.roles);
  const usedRoles = new Set<string>();

  const entries = Object.entries(assignment);
  if (entries.length === 0) return null;

  for (const [modelId, role] of entries) {
    if (!knownIds.has(modelId)) return null; // unknown participant
    if (!validRoles.has(role)) return null; // unknown/invalid role
    if (usedRoles.has(role)) return null; // duplicate role (e.g. two critics)
    usedRoles.add(role);
  }

  // Synthesizer guarantee: if "synthesizer" is an assignable role, exactly one model
  // must hold it, otherwise runDebateRound silently falls back to participants[0].
  if (validRoles.has("synthesizer") && !usedRoles.has("synthesizer")) {
    return null;
  }

  return assignment;
}

/**
 * 7A entry point: produce the role assignment via the hook, with a guaranteed
 * builtin fallback on null hook / throw / empty / invalid result. Never throws.
 * `onWarn` is invoked (hook id + reason) whenever the fallback path is taken.
 */
export async function assignRolesViaHook(
  ctx: SpeakerSelectionContext,
  hook: SpeakerSelectionHook | null,
  onWarn?: (msg: string) => void,
): Promise<Record<string, string>> {
  const builtin = () => assignRoles(ctx.profiles.map((p) => p.modelId));
  if (!hook) {
    return builtin();
  }
  try {
    const raw = await hook.assign(ctx);
    const validated = validateAssignment(ctx, raw);
    if (validated) {
      return validated;
    }
    onWarn?.(
      `[round-table] speaker-selection hook "${hook.id}" returned an empty/invalid ` +
        `assignment; falling back to builtin assignRoles`,
    );
    return builtin();
  } catch (err) {
    onWarn?.(
      `[round-table] speaker-selection hook "${hook.id}" threw (${
        err instanceof Error ? err.message : String(err)
      }); falling back to builtin assignRoles`,
    );
    return builtin();
  }
}
