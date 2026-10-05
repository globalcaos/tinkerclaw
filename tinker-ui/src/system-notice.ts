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
  /** Who put it in the chat, shown on the badge (the architect 2026-10-03: "with the identity of the agent"). */
  who: string;
  /** Thalamus's enhancement advice that rode in front of it, when there was one. */
  advice?: string;
};

/**
 * FORK 2026-10-03 — what can stand in front of the `[System]` prefix in the STORED text. On 2026-10-02 18:20 a restart
 * resume reached the agent as `<Thalamus advice>\n\n[Fri … GMT+2] [System] The gateway restarted…`, the prefix test
 * failed, and the architect saw a prompt he never wrote in his own bubble. The gateway stamps each inbound turn with its
 * delivery time; Thalamus (src/shared/thalamus-shortlist-text.ts) writes a fixed head and a fixed last line.
 */
const DELIVERY_STAMP = /^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} [^\]]*\]\s*/;
const THALAMUS_ADVICE =
  /^\s*(These enhancements may fit this task[\s\S]*?None of these may fit; use your own judgment\.)\s*/;
/** `[System]`, or `[System · name]` from a producer that names itself. */
const SYSTEM_MARK = /^\[System(?:\s*[·:]\s*([^\]]+))?\]/;

/** The gateway's own notes keep the bare `[System]` (tinker-bridge's cli-command checks for it): named by what they say. */
const KNOWN_SENDERS: [RegExp, string][] = [
  [/^The gateway restart you requested\b/, "the gateway-restart skill"],
  [
    /^(The gateway restarted and interrupted|The machine was shut down or rebooted|Your previous turn stopped while the tool)/,
    "the gateway · restart recovery",
  ],
  [/^Your previous turn was interrupted by a gateway reload\b/, "the gateway · subagent recovery"],
  [/^Gateway restarted at\b/, "prefrontal · restart resume"],
];

/** The text after an optional delivery stamp and Thalamus advice, and the advice itself. */
function unwrap(text: string): { rest: string; advice?: string } {
  let rest = text.replace(DELIVERY_STAMP, "").trimStart();
  const a = THALAMUS_ADVICE.exec(rest);
  if (!a) return { rest };
  rest = rest.slice(a[0].length).replace(DELIVERY_STAMP, "").trimStart();
  return { rest, advice: a[1] };
}

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
  const { rest, advice } = unwrap(text);
  const mark = SYSTEM_MARK.exec(rest);
  if (!mark) {
    return null;
  }
  const body = rest.slice(mark[0].length).trimStart();
  if (!body) {
    return null;
  }
  const newline = body.indexOf("\n");
  const headline = (newline < 0 ? body : body.slice(0, newline)).trim();
  const detail = newline < 0 ? "" : body.slice(newline + 1).trim();
  const who = mark[1]?.trim() || KNOWN_SENDERS.find(([re]) => re.test(body))?.[1] || "the system";
  return {
    kind: looksLikeRestartResume(body) ? "restart-resume" : "system",
    headline,
    detail,
    who,
    ...(advice ? { advice } : {}),
  };
}

export type AgentMessage = { who: string; headline: string; detail: string; advice?: string };

/**
 * FORK 2026-10-03 — a message another agent sent into this chat (Claude Code's `<cross-session-message from-name=…>`),
 * named by the sending agent. Null for anything else.
 */
export function detectAgentMessage(text: unknown): AgentMessage | null {
  if (typeof text !== "string") return null;
  const { rest, advice } = unwrap(text);
  const m =
    /^<cross-session-message\b([^>]*)>\s*([\s\S]*?)\s*(?:<\/cross-session-message>\s*)?$/.exec(
      rest.trim(),
    );
  if (!m) return null;
  const who =
    /from-name="([^"]+)"/.exec(m[1]!)?.[1] ?? /from="([^"]+)"/.exec(m[1]!)?.[1] ?? "another agent";
  const body = m[2]!.trim();
  const newline = body.indexOf("\n");
  return {
    who,
    headline: (newline < 0 ? body : body.slice(0, newline)).trim(),
    detail: newline < 0 ? "" : body.slice(newline + 1).trim(),
    ...(advice ? { advice } : {}),
  };
}
