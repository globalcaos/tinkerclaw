// FORK 2026-11-13 (bug-log.md `fresh-session-no-recap`): what a session gets when it cannot resume.
//
// The bridge sends claude only the LAST user turn (stream.ts extractUserText); the CLI session holds the rest. When
// the resume guard in worker.ts starts a FRESH session instead (the transcript is over RESUME_MAX_TRANSCRIPT_BYTES,
// or it is gone from disk), that session holds nothing, and the chat has lost its whole conversation without a word
// to the model or to the owner. Noted 2026-07-27, seen 2026-10-01 (an 8.3 MB build chat) and twice on 2026-11-13
// (10.3 MB; 32.5 MB of character sheets, where a job-woken turn spent its first 14 tool calls finding the folder it
// had worked in all day).
//
// OpenClaw sends the chat's full history with every request, so the cure needs no I/O: the last turns go in front of
// the prompt as text, with a plain statement of what is missing and where the rest is.
//
// The block is NOT the owner's request. `src/shared/appended-prompt-blocks.ts` LEADING_PROMPT_BLOCKS takes it off for
// every reader of his words (the guard, rewind, the gateway's CLI-history import), and `plain` below removes from the
// quoted turns every marker a reader tests on the raw line: a delivery stamp, an agent label, a `[System]` notice.

/** Why the worker started a new Claude session (worker.ts, the resume guard). */
export type FreshStartWhy = {
  /** `oversized`: the transcript is over the resume limit. `missing`: it is no longer on disk. */
  reason: "oversized" | "missing";
  /** The transcript the session could not resume. When it exists it holds every tool call and result. */
  transcriptPath: string;
  sizeBytes?: number;
  limitBytes?: number;
};

export type FreshStartRecapOptions = {
  /** The text this turn sends. The newest stored prompt is left out when it is this one. */
  currentUserText?: string;
  /** The chat's OpenClaw session key, for the history call the block names. */
  sessionKey?: string;
  maxMessages?: number;
  maxChars?: number;
};

/** The tags of the block. `appended-prompt-blocks.ts` matches the same literals; fresh-start-recap.test.ts holds them together. */
export const EARLIER_CONVERSATION_OPEN = '<earlier_conversation source="tinkerclaw-bridge">';
export const EARLIER_CONVERSATION_CLOSE = "</earlier_conversation>";

export const FRESH_RECAP_MAX_MESSAGES = 12;
export const FRESH_RECAP_MAX_CHARS = 24_000;
/** A prompt keeps its start (the request); a reply keeps its end (the result, and what is still open). */
const PROMPT_CAP = 3_000;
const REPLY_CAP = 6_000;

/** The delivery stamp in front of a stored prompt (`[Fri 2026-11-13 16:16 GMT+1]`), wherever the prelude put it. */
const FIRST_STAMP = /\[[^\]\n]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*\]/;
const CONTRACT = "<!-- TINKERCLAW";

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as Array<{ type?: string; text?: unknown } | null>)
    .filter((p) => !!p && p.type === "text" && typeof p.text === "string")
    .map((p) => (p as { text: string }).text)
    .join("\n\n");
}

/** A stored prompt without what was wrapped round it: the prelude before its stamp, the chat-row contract after it. */
function barePrompt(raw: string): string {
  let t = raw;
  const cut = t.indexOf(CONTRACT);
  if (cut >= 0) {
    t = t.slice(0, cut);
  }
  const m = FIRST_STAMP.exec(t);
  if (m && m.index > 0) {
    t = t.slice(m.index);
  }
  return t.trim();
}

/**
 * A quoted turn with nothing in it that a reader of the raw prompt line tests for: a dated bracket (a delivery stamp),
 * an agent label, a `[System]` notice, a background-turn marker, this block's own closing tag. Round brackets say the
 * same to the model and match none of those tests.
 */
function plain(text: string): string {
  return text
    .replace(/\[([^\]\n]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*)\]/g, "($1)")
    .replace(/⟦/g, "(")
    .replace(/⟧/g, ")")
    .replace(/\[(System\b[^\]\n]*)\]/g, "($1)")
    .replace(/\[(bg-turn [^\]\n]*)\]/g, "($1)")
    .replace(/<(\/?)earlier_conversation/g, "($1earlier_conversation");
}

/** `text` cut to `cap` characters from one end, never through the middle of a surrogate pair. */
function clip(text: string, cap: number, keep: "start" | "end"): string {
  if (text.length <= cap) {
    return text;
  }
  const low = (i: number) => {
    const c = text.charCodeAt(i);
    return c >= 0xdc00 && c <= 0xdfff;
  };
  if (keep === "start") {
    const end = low(cap) ? cap - 1 : cap;
    return `${text.slice(0, end)}\n(cut here: ${text.length - end} more characters)`;
  }
  let start = text.length - cap;
  if (low(start)) {
    start += 1;
  }
  return `(the first ${start} characters of this reply are cut)\n${text.slice(start)}`;
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/**
 * The block for the front of the first prompt of a session that could not resume: why the session is new, the chat's
 * last prompts and replies as text (oldest first), and where the rest is. Null when the chat has no earlier turn.
 * Pure: `messages` is the history OpenClaw sent with the request.
 */
export function renderFreshStartRecap(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  why: FreshStartWhy,
  opts: FreshStartRecapOptions = {},
): string | null {
  const maxMessages = opts.maxMessages ?? FRESH_RECAP_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? FRESH_RECAP_MAX_CHARS;
  const turns: Array<{ prompt: boolean; text: string }> = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = barePrompt(textOf(m.content));
      if (text) {
        turns.push({ prompt: true, text });
      }
    } else if (m.role === "assistant") {
      const text = textOf(m.content).trim();
      // An error envelope and a silent reply carry no conversation.
      if (
        text &&
        !text.startsWith("__ERR_ENV__:") &&
        text !== "NO_REPLY" &&
        text !== "HEARTBEAT_OK"
      ) {
        turns.push({ prompt: false, text });
      }
    }
  }
  // The newest stored prompt is normally the one this turn sends: it follows the block, so it is not said twice.
  // A continuation sends other text (the resume notice); then the stored prompt is the interrupted request and stays.
  const last = turns[turns.length - 1];
  if (last?.prompt) {
    const current = opts.currentUserText === undefined ? null : barePrompt(opts.currentUserText);
    if (
      current === null ||
      current === "" ||
      current.includes(last.text) ||
      last.text.includes(current)
    ) {
      turns.pop();
    }
  }
  if (turns.length === 0) {
    return null;
  }
  const kept: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const t = turns[i];
    const piece = t.prompt
      ? `PROMPT:\n${clip(plain(t.text), PROMPT_CAP, "start")}`
      : `REPLY:\n${clip(plain(t.text), REPLY_CAP, "end")}`;
    if (kept.length > 0 && used + piece.length > maxChars) {
      break;
    }
    kept.push(piece);
    used += piece.length;
  }
  kept.reverse();

  const cause =
    why.reason === "missing"
      ? "Its transcript is no longer on disk, so the bridge started a new session."
      : why.sizeBytes && why.limitBytes
        ? `Its transcript is ${megabytes(why.sizeBytes)} MB and the bridge loads ${megabytes(why.limitBytes)} MB at most, so the bridge started a new session.`
        : "Its transcript is too large to load, so the bridge started a new session.";
  const older = opts.sessionKey
    ? `For older turns run: openclaw gateway call chat.history --params '{"sessionKey":"${opts.sessionKey}","limit":16}' --json`
    : "For older turns read this chat's history from the gateway (chat.history).";
  const lead =
    kept.length === 1
      ? `The last ${turns[turns.length - 1].prompt ? "prompt" : "reply"} follows as text.`
      : `The last ${kept.length} prompts and replies follow as text, oldest first.`;
  const trail =
    why.reason === "oversized"
      ? ` Every tool call and result of the earlier session is in ${why.transcriptPath} (JSON lines, large: search it, do not read it whole).`
      : "";
  return [
    EARLIER_CONVERSATION_OPEN,
    `This session does not hold the earlier conversation of this chat. ${cause} The bridge wrote this block; the owner did not type it.`,
    "",
    `${lead} They are the record of what was asked and answered, not new requests. Tool calls and tool results are not in them. Work already done is on disk: read it before you repeat a step. ${older}${trail}`,
    "",
    kept.join("\n\n"),
    EARLIER_CONVERSATION_CLOSE,
  ].join("\n");
}
