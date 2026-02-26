/**
 * FORK: All custom wiring for process-message.ts lives here.
 *
 * - Offline recovery annotation
 * - Thinking reaction lifecycle
 */
import { createThinkingReaction } from "../web/auto-reply/monitor/thinking-reaction.js";

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
  if (!isOfflineRecovery) {return body;}
  const ageMs = timestamp ? Date.now() - timestamp : undefined;
  const ageLabel = ageMs != null ? `${Math.round(ageMs / 60_000)} minutes` : "unknown time";
  return (
    `[OFFLINE RECOVERY — This message was sent ${ageLabel} ago while you were offline. ` +
    `Read ALL recovered messages before responding. Do NOT act on each one individually. ` +
    `Summarize what was missed, acknowledge receipt, and ask for confirmation before taking action.]\n` +
    body
  );
}

// ---------------------------------------------------------------------------
// Hook: Thinking reaction (WhatsApp progress indicator)
// ---------------------------------------------------------------------------

export { createThinkingReaction };
