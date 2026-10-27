/**
 * FORK 2026-10-25 — the markers that stand in for what left the desk.
 *
 * Total Recall's rule: whatever leaves the context leaves a marker that quotes the exact words and
 * points back to the rest. Three paths evict and each one writes its marker here, so the quote
 * rules live once:
 *   - junk-first eviction (fork/attempt-hooks.ts evictOldToolResults): one old, large tool result;
 *   - pointer compaction (agents/pi-extensions/pointer-compaction-runtime.ts renderManifest);
 *   - the EVICT button (gateway/session-eviction.ts): the oldest turns of a transcript.
 *
 * A quote is a PREFIX (or, for a last line, a SUFFIX) of one real line, never a paraphrase, so it
 * can be searched for verbatim. An ellipsis outside the quotation marks says the line goes on.
 */

/** Longest quoted span, in chars. Long enough to search for, short enough to keep a marker small. */
export const MARKER_QUOTE_CHARS = 80;

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** JSON-escapes the span so a quote mark or newline inside it cannot break the marker. */
function quoted(span: string): string {
  return JSON.stringify(span);
}

/** The first non-empty line, as an exact prefix: `"<prefix>"` or `"<prefix>"…`. */
export function quoteFirstLine(text: string, maxChars = MARKER_QUOTE_CHARS): string | undefined {
  const line = nonEmptyLines(text)[0];
  if (!line) {
    return undefined;
  }
  return line.length <= maxChars ? quoted(line) : `${quoted(line.slice(0, maxChars))}…`;
}

/** The last non-empty line, as an exact suffix: `"<suffix>"` or `…"<suffix>"`. */
export function quoteLastLine(text: string, maxChars = MARKER_QUOTE_CHARS): string | undefined {
  const line = nonEmptyLines(text).at(-1);
  if (!line) {
    return undefined;
  }
  return line.length <= maxChars ? quoted(line) : `…${quoted(line.slice(-maxChars))}`;
}

/** The text blocks of a message's content, joined the way a provider would read them. */
export function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => (block as { type?: unknown } | null)?.type === "text")
    .map((block) => {
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function countImages(content: unknown): number {
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.filter((block) => (block as { type?: unknown } | null)?.type === "image").length;
}

/**
 * The marker for one evicted tool result. The whole result stays in the session transcript; the
 * marker carries its exact first and last lines and the toolCallId that fetches it back.
 * Deterministic in its inputs, so the same result renders the same bytes on every call and an
 * eviction never moves the prompt-cache prefix twice.
 */
export function renderToolResultEvictionMarker(params: {
  toolName?: string;
  toolCallId?: string;
  content: unknown;
}): string {
  const text = contentText(params.content);
  const lines = nonEmptyLines(text).length;
  const images = countImages(params.content);
  const first = quoteFirstLine(text);
  const last = lines > 1 ? quoteLastLine(text) : undefined;
  const size =
    `${text.length.toLocaleString("en-US")} chars, ${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}` +
    (images > 0 ? `, ${images} image${images === 1 ? "" : "s"}` : "");
  const quotes = first ? (last ? `, from ${first} to ${last}` : `: ${first}`) : "";
  const back = params.toolCallId
    ? `recall({"id":${JSON.stringify(params.toolCallId)}})`
    : "recall(query) with words from it";
  return (
    `[Evicted ${params.toolName ?? "tool"} output (${size})${quotes}. ` +
    `The whole result is kept in this chat's transcript; ${back} brings it back.]`
  );
}

/**
 * The marker the EVICT button leaves where it dropped the oldest turns. They are gone from the
 * live transcript, so the marker points at the archived copy of the full chat.
 */
export function renderTurnEvictionMarker(params: {
  evicted: number;
  evictedTokens: number;
  firstUserText?: string;
  lastUserText?: string;
  archivePath: string;
}): string {
  const first = params.firstUserText ? quoteFirstLine(params.firstUserText) : undefined;
  const last = params.lastUserText ? quoteFirstLine(params.lastUserText) : undefined;
  const said =
    first && last && first !== last
      ? ` The user's words there ran from ${first} to ${last}.`
      : first
        ? ` The user's words there began ${first}.`
        : "";
  return (
    `[Evicted ${params.evicted} earlier message${params.evicted === 1 ? "" : "s"} ` +
    `(~${params.evictedTokens.toLocaleString("en-US")} tokens) with the Evict button.${said} ` +
    `The full chat before this point is saved at ${params.archivePath}; read or search that file to get them back.]`
  );
}
