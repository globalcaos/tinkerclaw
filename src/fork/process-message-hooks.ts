/**
 * FORK: custom wiring for process-message.ts.
 *
 * - Offline recovery annotation
 *
 * 2026-08-04 — the thinking-reaction pass-through was REMOVED. This module used to
 * `import { createThinkingReaction }` from
 * `../../extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/thinking-reaction.js`
 * purely to re-export it one line later. That was a `src/` -> `extensions/` reverse
 * dependency with ZERO consumers: the only real caller,
 * `extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/process-message.ts:73`,
 * imports it directly from its own sibling module and always did.
 *
 * It was not free. Because `src/plugin-sdk/fork-message-hooks.ts` re-exports from
 * THIS module, that one line dragged the entire WhatsApp extension into the
 * `tsconfig.plugin-sdk.dts.json` project (whose `include` is only `src/plugin-sdk/**`)
 * and broke `pnpm build` at `build:plugin-sdk:dts` with a TS2339 in
 * `extensions/tinkerclaw-whatsapp/src/accounts.ts:162` — a file that project had never
 * compiled before. Deploy rc=12, 2026-08-04; the gateway was left untouched.
 *
 * FOUNDATION #9: a symbol is bounded where it lives. Forwarding it through the host
 * adds a dependency instead of declaring one.
 */

// ---------------------------------------------------------------------------
// Hook: Offline recovery annotation
// ---------------------------------------------------------------------------

/**
 * Prepend an advisory annotation to messages recovered while offline,
 * telling the agent to batch-review before acting.
 */
export function annotateOfflineRecovery(
  body: string,
  isOfflineRecovery: boolean | undefined,
  timestamp: number | undefined,
): string {
  if (!isOfflineRecovery) {
    return body;
  }
  const ageMs = timestamp ? Date.now() - timestamp : undefined;
  const ageLabel = ageMs != null ? `${Math.round(ageMs / 60_000)} minutes` : "unknown time";
  return (
    `[OFFLINE RECOVERY — This message was sent ${ageLabel} ago while you were offline. ` +
    `Read ALL recovered messages before responding. Do NOT act on each one individually. ` +
    `Summarize what was missed, acknowledge receipt, and ask for confirmation before taking action.]\n` +
    body
  );
}

// The thinking reaction (WhatsApp progress indicator) is NOT re-exported here — see the
// header. It lives at
// extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/thinking-reaction.ts
// and its callers import it from there.
