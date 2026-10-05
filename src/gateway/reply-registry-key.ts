import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { FOLLOWUP_QUEUES, getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import {
  getActiveReplyRunCount,
  type ReplyOperation,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../config/io.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolveSessionKey } from "../config/sessions/session-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

/**
 * FORK 2026-09-25 — the ONE owner, for gateway readers, of "under which key does the reply pipeline
 * hold this session's turns?" (TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 G5 and G6). The G6
 * reply-phase probe (server.impl.ts) carried this privately until then.
 *
 * THREE SPELLINGS of one session's key reach the gateway:
 *   - RAW: the key a message was dispatched with (`ctx.SessionKey`). The diagnostic session state
 *     is keyed by it (dispatch-from-config.ts markProcessing).
 *   - REGISTRY: the key initSessionState derives from the raw one (src/auto-reply/reply/session.ts:
 *     resolveSessionKey lowercases it and runs any channel plugin's explicit-key normaliser, then
 *     canonicalizeMainSessionAlias maps the main aliases for the agent resolveSessionAgentId reads
 *     off the raw key). The reply operation, its steered prompts, the follow-up queue and the run
 *     set are keyed by it (agent-runner's replySessionKey and queueKey), and initSessionState
 *     writes the session's store entry under it too.
 *   - STORE: resolveSessionStoreKey (session-store-key.ts), the key sessions.list rows,
 *     loadGatewaySessionRow, chat.send and sessions.reset / sessions.delete work with. It FOLDS
 *     spellings the registry keeps apart. With no `main` agent configured and a default agent
 *     `ops`, a legacy `agent:main:<mainKey>` is stored as `agent:ops:<mainKey>` while
 *     initSessionState registers `agent:main:<mainKey>`; and a bare `x` is stored as
 *     `agent:<default>:x` while initSessionState registers `x`.
 *
 * TWO QUESTIONS, two answers:
 *   - deriveReplyRegistryKey / findReplyOperation: where does the turn DISPATCHED with this key
 *     live? Raw to registry, nothing else. The reply-phase probe asks this: its key is one
 *     dispatch's raw key, and a folded spelling would name ANOTHER dispatch's turn.
 *   - resolveReplyRegistryKeys / resolveReplyHolderKey: which registry keys does the store fold
 *     into this ROW? sessions.list's pendingPrompts and chat.abort's settle ask this, so a row
 *     shows, and a Stop on it reaches, what the combined store folded into it. A candidate spelling
 *     counts only when resolveSessionStoreKey maps it to the SAME store key: the store's own rules
 *     decide, not a restatement of them here, so another agent's `x` or another session's
 *     `agent:main:x` never joins.
 *
 * NOT ROUTED HERE, on purpose: sessions.reset / sessions.delete (endSessionTurns). They rotate
 * only the store entries resolveGatewaySessionStoreTarget names, and initSessionState keys a store
 * entry and its turns alike, so those keys already reach every turn of what is rotated. A folded
 * entry the reset does not rotate goes on as its own session; ending its turn would send a
 * `session-reset` terminal to a session that was not reset.
 *
 * Out of reach, reads as "nothing held": a native command's or a bound conversation's retarget
 * (the turn lives on another session), and a channel normaliser keyed on the inbound provider
 * (only the key is known here).
 */

/** The key initSessionState registers a turn under when it is dispatched with `sessionKey`. */
export function deriveReplyRegistryKey(cfg: OpenClawConfig, sessionKey: string): string {
  const raw = sessionKey.trim();
  if (!raw) {
    return raw;
  }
  return canonicalizeMainSessionAlias({
    cfg,
    agentId: resolveSessionAgentId({ sessionKey: raw, config: cfg }),
    // An explicit key takes resolveSessionKey's first branch, which never reads mainKey or the
    // agent (config/sessions/session-key.ts), so initSessionState's extra arguments change nothing.
    sessionKey: resolveSessionKey(cfg.session?.scope ?? "per-sender", { SessionKey: raw }),
  });
}

/**
 * Every key the reply pipeline can hold the turns of the row `sessionKey` names under: the key as
 * given, its registry key, then the registry key of each spelling the store folds into the same
 * store key (that store key itself, its bare rest, and the legacy `agent:main:<rest>`), each kept
 * only when resolveSessionStoreKey agrees. Deduplicated, in that order; empty for an empty key. An
 * ordinary config adds nothing.
 */
export function resolveReplyRegistryKeys(cfg: OpenClawConfig, sessionKey: string): string[] {
  const given = sessionKey.trim();
  if (!given) {
    return [];
  }
  const keys = [given];
  const add = (key: string): void => {
    if (key && !keys.includes(key)) {
      keys.push(key);
    }
  };
  add(deriveReplyRegistryKey(cfg, given));
  const storeKey = resolveSessionStoreKey({ cfg, sessionKey: given });
  const parsed = parseAgentSessionKey(storeKey);
  const spellings = parsed
    ? [storeKey, parsed.rest, `agent:${DEFAULT_AGENT_ID}:${parsed.rest}`]
    : [storeKey];
  for (const spelling of spellings) {
    if (resolveSessionStoreKey({ cfg, sessionKey: spelling }) === storeKey) {
      add(deriveReplyRegistryKey(cfg, spelling));
    }
  }
  return keys;
}

/** Whether a reply operation or a follow-up queue is held under exactly `key`. */
function holdsReplyState(key: string): boolean {
  return replyRunRegistry.get(key) !== undefined || getExistingFollowupQueue(key) !== undefined;
}

/**
 * The reply operation of the turn dispatched with `sessionKey`: the key as given, then the key
 * initSessionState derives from it. Never a folded store spelling: that would be another
 * dispatch's turn. An exact hit reads no config, and neither does a gateway holding no operation.
 */
export function findReplyOperation(
  sessionKey: string | undefined,
  getConfig: () => OpenClawConfig = getRuntimeConfig,
): ReplyOperation | undefined {
  const given = sessionKey?.trim();
  if (!given) {
    return undefined;
  }
  const exact = replyRunRegistry.get(given);
  if (exact || getActiveReplyRunCount() === 0) {
    return exact;
  }
  const registeredKey = deriveReplyRegistryKey(getConfig(), given);
  return registeredKey === given ? undefined : replyRunRegistry.get(registeredKey);
}

/**
 * The ONE key a sessions.list row's reply holders are read under (deriveSessionPendingPrompts in
 * session-utils.ts): the row key itself when it holds a reply operation or a follow-up queue, else
 * the first of resolveReplyRegistryKeys that does, else the row key. One key, because agent-runner
 * registers the operation, its steered prompts and the queue under the same one. A row whose own
 * key holds something, or a gateway that holds nothing at all, reads no config and derives
 * nothing; otherwise an idle row pays one derivation (string work over the pinned config).
 */
export function resolveReplyHolderKey(
  sessionKey: string,
  getConfig: () => OpenClawConfig = getRuntimeConfig,
): string {
  const given = sessionKey.trim();
  if (
    !given ||
    holdsReplyState(given) ||
    (getActiveReplyRunCount() === 0 && FOLLOWUP_QUEUES.size === 0)
  ) {
    return given;
  }
  let cfg: OpenClawConfig;
  try {
    cfg = getConfig();
  } catch {
    // Called per sessions.list row with no seam above it: an unreadable config costs the derived
    // keys, never the row, which then reads its own key exactly as it did before this helper.
    return given;
  }
  return resolveReplyRegistryKeys(cfg, given).find(holdsReplyState) ?? given;
}
