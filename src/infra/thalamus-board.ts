// The board THALAMUS v4 routes over, read from the live system (design doc section 11.2, "shadow mode").
//
// WHAT THIS IS FOR. `routeCall` is pure: it needs the rungs on the board, the state of each supply, the context
// windows and the dial. In the gateway those come from the config and the usage snapshot. v2 builds the same board
// at `src/auto-reply/reply/model-selection.ts` (the `thalamusCandidates` / `frontierRungsFor` block); this calls
// the builder v2 also calls, so v4 being off cannot change a byte of v2.
//
// ONE BOARD. The rungs, supplies and windows come from `thalamus-board-build.ts`, the same function v2's
// per-request plan calls, so the chart, v2 and the per-call router cannot drift apart.
//
// It is a READ: nothing here writes the config, the session store or the usage snapshot.

import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStoreEntry } from "../config/sessions/store-load.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ThalamusBoardLike } from "../shared/thalamus-board-like.js";
import { thalamusCandidates } from "../shared/thalamus-candidates.js";
import { THALAMUS_DEFAULT_BIAS_IDX } from "../shared/thalamus-frontier.js";
import { readOrcaBias } from "./orca-bias-store.js";
import {
  buildThalamusBoardParts,
  buildThalamusCatalog,
  thalamusSuggestionFor,
} from "./thalamus-board-build.js";
import { readThalamusCooling } from "./thalamus-cooling.js";
import { getUsageSnapshot } from "./usage-snapshot-store.js";

export type ThalamusBoard = ThalamusBoardLike;

/** The rungs, supplies, windows and dial as v2 sees them, or undefined when no model has a published index. */
export function readThalamusBoard(
  cfg: OpenClawConfig,
  nowMs: number = Date.now(),
): ThalamusBoard | undefined {
  const catalog = buildThalamusCatalog(cfg.agents?.defaults?.models);
  if (Object.keys(catalog).length === 0) return undefined;

  const snapshot = getUsageSnapshot() ?? undefined;
  const dialIdx = readOrcaBias() ?? THALAMUS_DEFAULT_BIAS_IDX;
  const suggestion = thalamusSuggestionFor(dialIdx);
  const parts = buildThalamusBoardParts({
    catalog,
    thalamusCandidates,
    snapshot,
    nowMs,
    allowedModelKeys: undefined,
    suggestedModelKey: suggestion?.key,
    // The config's own provider list: the shadow router has no session-scoped catalog in hand.
    windowRows: Object.entries(cfg.models?.providers ?? {}).flatMap(([provider, p]) =>
      (p?.models ?? []).map((m) => ({ provider, id: m.id, contextWindow: m.contextWindow })),
    ),
  });

  // The same suggestion and the same cooling store the per-turn router reads (the architect, 2026-10-02).
  const cooled = readThalamusCooling({ nowMs });
  return {
    rungs: parts.rungs,
    supplies: parts.supplies,
    contextWindowFor: parts.contextWindowFor,
    dialIdx,
    ...(suggestion ? { suggestion } : {}),
    ...(cooled.set.size > 0 ? { cooling: cooled.set, coolingUntil: cooled.until } : {}),
    builtAtMs: nowMs,
  };
}

/**
 * Did the user pick this session's model by hand? The same line v2 draws (`hasExplicitModelSelection`): a stored
 * override counts unless the runner wrote it itself (`modelOverrideSource: "auto"`). Only Auto routes, so a
 * hand-picked model is never replaced.
 */
export function isHandPicked(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  sessionKey: string | undefined,
): boolean {
  if (!sessionKey) return false;
  try {
    const entry = loadSessionStoreEntry(
      resolveStorePath(cfg.session?.store, { agentId }),
      sessionKey,
    );
    return Boolean(entry?.modelOverride) && entry?.modelOverrideSource !== "auto";
  } catch {
    // Unknown is not "Auto": if reading the store THROWS, treat the model as picked and leave it alone. A store
    // that is missing or unparseable simply has no override in it.
    return true;
  }
}
