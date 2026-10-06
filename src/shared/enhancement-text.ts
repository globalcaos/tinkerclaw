// What a retriever should read of a prompt, shared by the replay harness and the recall stage (Broca retrieval v2).
//
// WHAT THIS IS FOR. The text the gateway hands a hook is not the text the person typed: a sender block, a delivery
// stamp, an abort note and, on Tinker, about 1,500 characters of reflection instructions travel with it. Word
// matching over that envelope scores the envelope. The house rules, which every retriever and every statistic must
// treat apart, are named here for the same reason: one list, read by all of them. `taskText` takes it off; `isRuntimeNotice` says when the whole
// prompt was injected by the gateway or an agent, so no recommendation is owed to it.

const STAMP = /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b(?:\[number\]|[^\]])*\]\s*/;
const ABORT_NOTE = /^Note: The previous agent run was aborted by the user\.[^\n]*\n+/;
const SENDER_BLOCK = /^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/;
const FRACTAL_TAIL = /\n+---\n+\*\*After your reply, append a 🌿 FRACTAL[\s\S]*$/;

/**
 * The request as the person wrote it: the sender block, the delivery stamp, the abort note and the reflection
 * instructions the harness appends are removed. Left alone, those instructions (about 1,500 characters in a
 * 2,000-character record) outweigh a one-line request in any word matching.
 */
export function taskText(raw: string): string {
  let t = raw;
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.trimStart().replace(ABORT_NOTE, "").replace(SENDER_BLOCK, "").replace(STAMP, "");
    if (t === before) break;
  }
  return t.replace(FRACTAL_TAIL, "").trim();
}

/**
 * The injected-notice markers the short-list seam already refuses (shortlist-seam.ts INJECTED_PROMPT), plus the
 * internal ones, plus `<task-notification>` and `System (untrusted):`: the background-task and exec-completion notices the gateway puts in a chat. The seam's own
 * pattern does not name that last one (9 of 611 Tinker rows in the ledger carry it), so it still gets a list today.
 */
const RUNTIME_MARKER =
  /^\s*(?:\[System\b|System \(untrusted\):|\[inject(?:ed)?\b|<cross-session-message\b|⟦(?:AGENT|OVERSEER)\b|<task-notification\b|<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>|\[Subagent Context\])/i;

/** True when the (cleaned) prompt is a notice the gateway or an agent put in the chat, not a request from the person. */
export function isRuntimeNotice(text: string): boolean {
  return RUNTIME_MARKER.test(taskText(text));
}

/** The rules that apply to every turn; they are listed on their own and never counted as task choices. */
export const HOUSE_RULES: readonly string[] = [
  "human-voice",
  "tinker-rebuild",
  "longjob",
  "exec-display",
  "gateway-restart",
];

/** `skill:human-voice`, `skill:jarvis-skills:human-voice` and `recipe:human-voice` all name the same house rule. */
export function isHouseRule(cardId: string): boolean {
  const name = cardId.slice(cardId.indexOf(":") + 1);
  return HOUSE_RULES.includes(name.slice(name.lastIndexOf(":") + 1));
}
