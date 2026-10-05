/**
 * FORK 2026-10-01 (the architect): humor lives only in the purple spoken line (`**Jarvis:** *…*`), in Data's deadpan
 * register (J7 v4.9 §9). Pure helpers for the live loop: find the line in a reply, read the principal's reaction
 * to it, tell when jokes are off, and build the per-turn block.
 */

export type Reaction = "laughed" | "not-funny" | "no-reaction";

export interface SpokenLineAttempt {
  ts: number;
  sessionKey: string;
  line: string;
  reaction: Reaction;
}

const SPOKEN_LINE_RE = /\*\*Jarvis:\*\*\s*\*([^*\n][^*]*?)\*/g;

/** The purple spoken line of a reply (the last one, which belongs to the final answer), or undefined. */
export function extractSpokenLine(reply: string | undefined): string | undefined {
  if (!reply) return undefined;
  const all = [...reply.matchAll(SPOKEN_LINE_RE)];
  const line = all.at(-1)?.[1]?.trim();
  return line ? line : undefined;
}

const NEGATIVE_RE =
  /\bnot funny\b|\bstop (?:the )?jok|\bno (?:more )?jokes\b|\btoo soon\b|\bcringe\b|\bunfunny\b/i;
const POSITIVE_RE =
  /\b(?:ha){2,}\b|\bja(?:ja)+\b|\bje(?:je)+\b|\blol\b|\blmao\b|😂|🤣|😆|😄|😁|\bgood one\b|\bnice one\b|\bthat'?s funny\b|\bfunny\b/i;

/** Explicit reactions only (J7 §8.6 tiers 1 and 4); anything else counts as no reaction. */
export function reactionTo(message: string | undefined): Reaction {
  const m = message ?? "";
  if (NEGATIVE_RE.test(m)) return "not-funny";
  if (POSITIVE_RE.test(m)) return "laughed";
  return "no-reaction";
}

const FRUSTRATION_RE =
  /\b(?:again|still)\b[^.?!]{0,60}\b(?:not|doesn'?t|isn'?t|broken|fail(?:s|ed|ing)?|wrong|stuck)\b|!{2,}|\b(?:wtf|dammit|damn it|come on|seriously\?|why (?:the hell|on earth))\b|^\s*(?:nope|no)\s*[.!]*\s*$/im;

/** Frustration, urgency or distress in the principal's message: no joke this turn (J7 v4.9 §9.2). */
export function jokesOff(message: string | undefined): boolean {
  const m = message ?? "";
  if (FRUSTRATION_RE.test(m)) return true;
  const caps = m.match(/\b[A-Z]{3,}\b/g) ?? [];
  return (
    caps.filter(
      (w) =>
        !/^(?:AI|API|URL|PDF|CSS|JSON|HTML|SQL|GPU|CPU|TTS|LLM|USB|SSH|VPN|IDE|ERP|AGV|OK)$/.test(
          w,
        ),
    ).length >= 3
  );
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && (c as { type?: unknown }).type === "text"
        ? String((c as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * All assistant text of the previous turn: every assistant message after the last user message. A turn with tool
 * calls holds several assistant messages, and the purple line sits in the final answer, not always the last one.
 */
export function lastTurnReplyText(messages: unknown[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (!m) continue;
    if (m.role === "user") break;
    if (m.role === "assistant") parts.unshift(textOf(m.content));
  }
  const joined = parts.join("\n");
  return joined ? joined : undefined;
}

const REACTION_WORDS: Record<Reaction, string> = {
  laughed: "he laughed",
  "not-funny": "he said it was not funny",
  "no-reaction": "no reaction",
};

/** The per-turn block: whether a joke is welcome now, and the last lines with how he took them. */
export function buildHumorBlock(o: { jokesOff: boolean; recent: SpokenLineAttempt[] }): string {
  const lines = [
    "## Humor: the purple line only",
    "",
    o.jokesOff
      ? "This turn: NO JOKE. He sounds frustrated or rushed. Make the purple line a plain one-sentence summary."
      : "This turn: a joke is welcome in the purple line if one is there. Aim for about one line in three; the others are a plain summary. The body stays plain.",
  ];
  if (o.recent.length > 0) {
    lines.push(
      "",
      "Your last spoken lines and how he took them (never repeat one; lean on what worked):",
    );
    for (const a of o.recent) lines.push(`- "${a.line}" → ${REACTION_WORDS[a.reaction]}`);
  }
  return lines.join("\n");
}
