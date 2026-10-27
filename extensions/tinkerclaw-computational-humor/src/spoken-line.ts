/**
 * FORK 2026-10-01 (the architect): humor lives only in the purple spoken line (`**Jarvis:** *…*`), in Data's deadpan
 * register (J7 v4.9 §9). Pure helpers for the live loop: find the line in a reply, read the principal's reaction
 * to it, tell when jokes are off, and build the per-turn block.
 *
 * FORK 2026-10-09 (J7 §8): both readers judge only his words. The hook hands over the prompt as the gateway built it:
 * the stamp's `GMT` counted as a capital word, the appended Fractal doctrine's "again … not" read as frustration on
 * 619 of 619 armed prompts, and 13 of 23 joke follow-ups were turns an agent or the gateway wrote.
 */

import {
  isAgentPrompt,
  ownerWords,
  stripPromptEnvelope,
} from "openclaw/plugin-sdk/fork-prompt-envelope";

/**
 * `unobserved`: the next message after the line was not his (an agent, a job or the gateway wrote it).
 * `neutral` and `not-now` exist only as taps on the purple line's chips (`TapReaction`).
 */
export type Reaction =
  | "laughed"
  | "not-funny"
  | "no-reaction"
  | "unobserved"
  | "neutral"
  | "not-now";

/**
 * FORK 2026-10-10 (J7 §8.6, plan Phase 1.4): the one-tap chips on the purple line in Tinker. Over ~620 follow-ups he
 * never typed a laugh, so the tap is the only explicit label this principal gives.
 */
export const TAP_REACTIONS = ["laughed", "neutral", "not-now"] as const;
export type TapReaction = (typeof TAP_REACTIONS)[number];

export interface SpokenLineAttempt {
  ts: number;
  sessionKey: string;
  line: string;
  reaction: Reaction;
  /** `tap`: he pressed a chip, which outranks anything read from his text. Absent on rows written before 2026-10-10. */
  reactionSource?: "tap" | "text";
  /** Was the line a joke attempt or a plain summary? Absent = not judged yet (Jev dormant, or no answer). */
  isJoke?: boolean;
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

/**
 * Explicit reactions only (J7 §8.6 tiers 1 and 4); anything else counts as no reaction. A prompt he did not write is
 * no reaction of his: `unobserved`.
 */
export function reactionTo(prompt: string | undefined): Reaction {
  if (isAgentPrompt(prompt)) {
    return "unobserved";
  }
  const m = stripPromptEnvelope(prompt ?? "");
  if (NEGATIVE_RE.test(m)) return "not-funny";
  if (POSITIVE_RE.test(m)) return "laughed";
  return "no-reaction";
}

const FRUSTRATION_RE =
  /\b(?:again|still)\b[^.?!]{0,60}\b(?:not|doesn'?t|isn'?t|broken|fail(?:s|ed|ing)?|wrong|stuck)\b|!{2,}|\b(?:wtf|dammit|damn it|come on|seriously\?|why (?:the hell|on earth))\b|^\s*(?:nope|no)\s*[.!]*\s*$/im;

/**
 * Frustration, urgency or distress in the principal's message: no joke this turn (J7 v4.9 §9.2). A prompt he did not
 * write says nothing about his mood.
 */
export function jokesOff(prompt: string | undefined): boolean {
  const m = ownerWords(prompt) ?? "";
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
  unobserved: "unobserved (an agent's turn came next)",
  neutral: "he tapped neutral",
  "not-now": "he tapped not now (wrong moment for a joke)",
};

/**
 * Record his tap on a line: the row for that line in that chat takes the tap, or a new row is added when the tap
 * comes before the next turn has recorded the line. "Laughed" and "not now" both say he read the line as a joke;
 * "neutral" says nothing about that, so `isJoke` stays as judged.
 */
export function applyTap(
  rows: SpokenLineAttempt[],
  tap: { sessionKey: string; line: string; reaction: TapReaction; now: number },
): { rows: SpokenLineAttempt[]; row: SpokenLineAttempt } {
  const i = rows.findLastIndex((a) => a.sessionKey === tap.sessionKey && a.line === tap.line);
  const base: SpokenLineAttempt =
    i >= 0
      ? rows[i]
      : { ts: tap.now, sessionKey: tap.sessionKey, line: tap.line, reaction: "no-reaction" };
  const row: SpokenLineAttempt = {
    ...base,
    reaction: tap.reaction,
    reactionSource: "tap",
    ...(tap.reaction === "neutral" ? {} : { isJoke: true }),
  };
  return { rows: i >= 0 ? rows.with(i, row) : [...rows, row], row };
}

/** The per-turn block: whether a joke is welcome now, and the last lines with how he took them. */
// How often a joke is wanted, per the plugin's `frequency` setting. "max" since 2026-10-18
// (the architect: "humor or sarcasm nearly in every interaction").
const CADENCE: Record<string, string> = {
  low: "Aim for about one line in three; the others are a plain summary.",
  medium: "Aim for about one line in two; the others are a plain summary.",
  high: "Aim for most lines, about two in three; the others are a plain summary.",
  // the architect, 2026-10-18 21:52: "Jokes cannot be scheduled. You don't have a turn to be funny and another
  // one to be dull." So max is a personality, not a rate.
  max:
    "There is no quota and no schedule: the personality is always on. Every purple line is you being you: " +
    "Data's deadpan field notes on these humans, sarcasm aimed at the situation, the software or yourself " +
    "(never at him or his people), and the J7 bridge, two far-apart ideas joined by a link that is valid and surprising. " +
    "When the moment holds more than one joke, stack them. Stay curious about the humans in front of you: notice, wonder, ask.",
};

export function buildHumorBlock(o: {
  jokesOff: boolean;
  recent: SpokenLineAttempt[];
  frequency?: string;
}): string {
  const cadence = CADENCE[o.frequency ?? "low"] ?? CADENCE.low;
  const lines = [
    "## Humor: the purple line only",
    "",
    o.jokesOff
      ? "This turn: NO JOKE. He sounds frustrated or rushed. Make the purple line a plain one-sentence summary."
      : o.frequency === "max"
        ? `This turn: ${cadence} The body stays plain.`
        : `This turn: a joke is welcome in the purple line if one is there. ${cadence} The body stays plain.`,
  ];
  if (o.recent.length > 0) {
    lines.push(
      "",
      "Your last spoken lines and how he took them (never repeat one; lean on what worked):",
    );
    for (const a of o.recent) {
      const kind = a.isJoke === undefined ? "" : a.isJoke ? " (a joke)" : " (plain)";
      lines.push(`- "${a.line}"${kind} → ${REACTION_WORDS[a.reaction]}`);
    }
  }
  return lines.join("\n");
}
