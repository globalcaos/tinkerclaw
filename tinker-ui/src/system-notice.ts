// FORK 2026-08-24 (the architect: the post-restart wake-up "should be clearly identified as coming
// from an automated system and be encased in blue").
//
// WHAT THIS IS. After a gateway restart, `recoverRestartAbortedMainSessions`
// (src/agents/main-session-restart-recovery.ts, boot+5s) re-dispatches every session that was
// mid-turn when the process died. It does so by injecting a prompt through the `agent` RPC — which
// means the transcript stores it as a USER turn, and the chat rendered it as an ordinary right-hand
// bubble. So the one message in the conversation that the human definitively did NOT write looked
// exactly like the ones they did, and its five numbered lines of instructions-to-the-model read as
// if the architect had typed them.
//
// The fix is the same shape the Overseer and Agent nudges already use in app.ts: a user-role message
// from an automated source keeps its role (the model must still see it as input) but renders as its
// own labelled bubble. This one gets a BLUE frame and an explicit "Automated system message" badge,
// and folds the instruction body away — the headline is the part a human needs ("the gateway
// restarted and picked your turn back up"); the numbered protocol is addressed to the model.
//
// Kept pure and DOM-free so it is unit-testable: app.ts owns only the markup.

/**
 * The prefix every injected system prompt carries.
 *
 * Both restart-resume paths use it, which is why the match is on the PREFIX rather than on one
 * exact sentence: Path A (main-session-restart-recovery, "The gateway restarted and interrupted
 * your previous turn…") and the legacy prefrontal Path B ("Gateway restarted at HH:MM — resume from
 * your current plan state.") are the same event to a reader, and a third wording should not silently
 * fall back to looking like the human typed it.
 */
export const SYSTEM_PROMPT_PREFIX = "[System]";

export type SystemNotice = {
  /** `restart-resume` when the text names the restart; `system` for any other injected prompt. */
  kind: "restart-resume" | "system";
  /** The one line a human needs, prefix stripped. */
  headline: string;
  /** Everything after the first line — the protocol addressed to the model. May be empty. */
  detail: string;
};

/** Cheap tell that this system prompt is the post-restart wake-up rather than some other injection. */
function looksLikeRestartResume(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("restart") && (t.includes("resume") || t.includes("interrupted"));
}

/**
 * Classify a user-role message that was actually injected by the gateway.
 *
 * Returns null for anything a human could have typed, so the ordinary bubble path is untouched.
 * Deliberately strict about the prefix: a message that merely MENTIONS a restart is a human talking
 * about one, and mislabelling that as machine-generated would be worse than the bug being fixed.
 */
export function detectSystemNotice(text: unknown): SystemNotice | null {
  if (typeof text !== "string") {
    return null;
  }
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(SYSTEM_PROMPT_PREFIX)) {
    return null;
  }
  const body = trimmed.slice(SYSTEM_PROMPT_PREFIX.length).trimStart();
  if (!body) {
    return null;
  }
  const newline = body.indexOf("\n");
  const headline = (newline < 0 ? body : body.slice(0, newline)).trim();
  const detail = newline < 0 ? "" : body.slice(newline + 1).trim();
  return {
    kind: looksLikeRestartResume(body) ? "restart-resume" : "system",
    headline,
    detail,
  };
}
