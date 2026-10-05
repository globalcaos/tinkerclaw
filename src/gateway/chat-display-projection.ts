import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import {
  classifyAssistantOutcome,
  ERROR_ENVELOPE_MARKER,
  isTurnOutcome,
  splitErrorEnvelope,
  type TurnOutcome,
} from "../fork/turn-outcome.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "../shared/chat-message-content.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { stripEnvelopeFromMessages } from "./chat-sanitize.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";

export const DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 8_000;

// FORK 2026-06-04: visible assistant/user TEXT must not be cut by the display
// char cap — that silently dropped the tail (🧠 AMYGDALA / 🌿 FRACTAL) of long
// structured answers, on the live stream AND on every reload. The 8_000 cap is
// kept for collapsed NOISE (thinking, tool partialJson/arguments). Visible text
// is bounded instead by the per-message byte backstop
// (CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 KB in server-methods/chat.ts) plus
// the overall history byte budget — those are the real ceilings. 100_000 chars
// sits comfortably under 128 KB so the byte cap stays authoritative and real
// answers are never truncated. See the response-truncation-bookmark memory.
export const DEFAULT_CHAT_HISTORY_ANSWER_MAX_CHARS = 100_000;

type RoleContentMessage = {
  role: string;
  content?: unknown;
};

export function resolveEffectiveChatHistoryMaxChars(
  cfg: { gateway?: { webchat?: { chatHistoryMaxChars?: number } } },
  maxChars?: number,
): number {
  if (typeof maxChars === "number") {
    return maxChars;
  }
  if (typeof cfg.gateway?.webchat?.chatHistoryMaxChars === "number") {
    return cfg.gateway.webchat.chatHistoryMaxChars;
  }
  return DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
}

function truncateChatHistoryText(
  text: string,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n...(truncated)...`,
    truncated: true,
  };
}

export function isToolHistoryBlockType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const normalized = type.trim().toLowerCase();
  return (
    normalized === "toolcall" ||
    normalized === "tool_call" ||
    normalized === "tooluse" ||
    normalized === "tool_use" ||
    normalized === "toolresult" ||
    normalized === "tool_result"
  );
}

function sanitizeChatHistoryContentBlock(
  block: unknown,
  opts?: { preserveExactToolPayload?: boolean; maxChars?: number },
): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  const preserveExactToolPayload =
    opts?.preserveExactToolPayload === true || isToolHistoryBlockType(entry.type);
  const maxChars = opts?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  // Visible text/content is bounded by the byte backstop, not the noise cap.
  const answerMax = Math.max(maxChars, DEFAULT_CHAT_HISTORY_ANSWER_MAX_CHARS);
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    if (preserveExactToolPayload) {
      entry.text = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, answerMax);
      entry.text = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }
  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    if (preserveExactToolPayload) {
      entry.content = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, answerMax);
      entry.content = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }
  if (typeof entry.partialJson === "string" && !preserveExactToolPayload) {
    const res = truncateChatHistoryText(entry.partialJson, maxChars);
    entry.partialJson = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.arguments === "string" && !preserveExactToolPayload) {
    const res = truncateChatHistoryText(entry.arguments, maxChars);
    entry.arguments = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking, maxChars);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }
  if (type === "audio" && entry.source && typeof entry.source === "object") {
    const source = { ...(entry.source as Record<string, unknown>) };
    if (source.type === "base64" && typeof source.data === "string") {
      const bytes = Buffer.byteLength(source.data, "utf8");
      delete source.data;
      source.omitted = true;
      source.bytes = bytes;
      entry.source = source;
      changed = true;
    }
  }
  return { block: changed ? entry : block, changed };
}

function sanitizeAssistantPhasedContentBlocks(content: unknown[]): {
  content: unknown[];
  changed: boolean;
} {
  const hasExplicitPhasedText = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    return (
      entry.type === "text" && Boolean(parseAssistantTextSignature(entry.textSignature)?.phase)
    );
  });
  if (!hasExplicitPhasedText) {
    return { content, changed: false };
  }
  const filtered = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    if (entry.type !== "text") {
      return true;
    }
    return parseAssistantTextSignature(entry.textSignature)?.phase === "final_answer";
  });
  return {
    content: filtered,
    changed: filtered.length !== content.length,
  };
}

function toFiniteNumber(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function sanitizeCost(raw: unknown): { total?: number } | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  const total = toFiniteNumber(c.total);
  return total !== undefined ? { total } : undefined;
}

function sanitizeUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  const knownFields = [
    "input",
    "output",
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "cacheRead",
    "cacheWrite",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ];

  for (const k of knownFields) {
    const n = toFiniteNumber(u[k]);
    if (n !== undefined) {
      out[k] = n;
    }
  }

  if ("cost" in u && u.cost != null && typeof u.cost === "object") {
    const sanitizedCost = sanitizeCost(u.cost);
    if (sanitizedCost) {
      (out as Record<string, unknown>).cost = sanitizedCost;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeChatHistoryMessage(
  message: unknown,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  const preserveExactToolPayload =
    role === "toolresult" ||
    role === "tool_result" ||
    role === "tool" ||
    role === "function" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string" ||
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string";

  if ("details" in entry) {
    delete entry.details;
    changed = true;
  }

  if (entry.role !== "assistant") {
    if ("usage" in entry) {
      delete entry.usage;
      changed = true;
    }
    if ("cost" in entry) {
      delete entry.cost;
      changed = true;
    }
  } else {
    if ("usage" in entry) {
      const sanitized = sanitizeUsage(entry.usage);
      if (sanitized) {
        entry.usage = sanitized;
      } else {
        delete entry.usage;
      }
      changed = true;
    }
    if ("cost" in entry) {
      const sanitized = sanitizeCost(entry.cost);
      if (sanitized) {
        entry.cost = sanitized;
      } else {
        delete entry.cost;
      }
      changed = true;
    }
  }

  const answerMax = Math.max(maxChars, DEFAULT_CHAT_HISTORY_ANSWER_MAX_CHARS);
  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    if (preserveExactToolPayload) {
      entry.content = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, answerMax);
      entry.content = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) =>
      sanitizeChatHistoryContentBlock(block, { preserveExactToolPayload, maxChars }),
    );
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      const sanitizedPhases = sanitizeAssistantPhasedContentBlocks(entry.content);
      if (sanitizedPhases.changed) {
        entry.content = sanitizedPhases.content;
        changed = true;
      }
    }
  }

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    if (preserveExactToolPayload) {
      entry.text = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, answerMax);
      entry.text = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }

  return { message: changed ? entry : message, changed };
}

function extractAssistantTextForSilentCheck(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant") {
    return undefined;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (!Array.isArray(entry.content) || entry.content.length === 0) {
    return undefined;
  }

  const texts: string[] = [];
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      return undefined;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function hasAssistantNonTextContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) => block && typeof block === "object" && (block as { type?: unknown }).type !== "text",
  );
}

// FORK 2026-06-22: when a turn is interrupted (gateway restart / stop command),
// `appendInjectedAssistantMessageToTranscript` records the in-flight streamed text
// as a `gateway-injected` assistant message carrying an `openclawAbort` marker.
// That echo holds only the display buffer — no thinking blocks. When the turn then
// resumes, the REAL model message (thinking + full text) is persisted separately,
// so the transcript ends up with two assistant turns: the partial echo and the
// complete message. The user sees the answer twice and the echo looks like the
// thinking got "deleted". This pass drops a superseded echo: an abort echo is
// hidden when the FIRST real (non-echo) assistant message that follows it begins
// with the echo's visible text (the echo is always a prefix of the resumed reply).
// A genuinely aborted turn that never resumed has no following real message, so its
// echo is kept — the user still sees what was said before the interruption.
function isAbortEchoMessage(message: Record<string, unknown>): boolean {
  const abort = message.openclawAbort;
  return Boolean(
    abort && typeof abort === "object" && (abort as { aborted?: unknown }).aborted === true,
  );
}

function extractAssistantVisibleText(message: Record<string, unknown>): string | undefined {
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const block of message.content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

// Collapse runs of whitespace to a single space (matches the cli-session-history
// merge layer's normalization). A bare .trim() is too brittle: a gateway respawn
// re-streams the resumed reply, so newlines/indentation between the partial echo
// and the completed message diverge even when the visible words are identical —
// which used to defeat the startsWith() prefix check and leak BOTH bubbles.
function collapseWhitespaceForEchoMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function suppressSupersededAbortEchoes(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const result: Array<Record<string, unknown>> = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (current.role === "assistant" && isAbortEchoMessage(current)) {
      const rawEcho = extractAssistantVisibleText(current);
      const echo = rawEcho ? collapseWhitespaceForEchoMatch(rawEcho) : undefined;
      if (echo) {
        // Only the FIRST following real (non-echo) assistant message decides — the
        // resumed reply. Earlier-restart echoes from the same turn are skipped so a
        // run of consecutive echoes all collapse into the one completed message.
        let superseded = false;
        for (let j = i + 1; j < messages.length; j++) {
          const other = messages[j];
          if (other.role !== "assistant" || isAbortEchoMessage(other)) {
            continue;
          }
          const rawReal = extractAssistantVisibleText(other);
          const real = rawReal ? collapseWhitespaceForEchoMatch(rawReal) : undefined;
          // Bidirectional: the echo is normally a prefix of the resumed reply (the
          // partial streamed buffer), but a respawn can coalesce the resume into a
          // SHORTER form than the captured partial — so a real message that is itself
          // a prefix of the echo is also a supersede. Either way the resume is
          // authoritative and the echo is a stale partial of the same turn.
          superseded = Boolean(real && (real.startsWith(echo) || echo.startsWith(real)));
          break;
        }
        if (superseded) {
          changed = true;
          continue;
        }
      }
    }
    result.push(current);
  }
  return changed ? result : messages;
}

function shouldDropAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as { role?: unknown };
  if (entry.role !== "assistant") {
    return false;
  }
  if (resolveAssistantMessagePhase(message) === "commentary") {
    return true;
  }
  const text = extractAssistantTextForSilentCheck(message);
  if (text === undefined || !isSuppressedControlReplyText(text)) {
    return false;
  }
  return !hasAssistantNonTextContent(message);
}

export function sanitizeChatHistoryMessages(
  messages: unknown[],
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    if (shouldDropAssistantHistoryMessage(message)) {
      changed = true;
      continue;
    }
    const res = sanitizeChatHistoryMessage(message, maxChars);
    changed ||= res.changed;
    if (shouldDropAssistantHistoryMessage(res.message)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}

function asRoleContentMessage(message: Record<string, unknown>): RoleContentMessage | null {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (!role) {
    return null;
  }
  return {
    role,
    ...(message.content !== undefined
      ? { content: message.content }
      : message.text !== undefined
        ? { content: message.text }
        : {}),
  };
}

function isEmptyTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return true;
  }
  let sawText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text") {
      return false;
    }
    sawText = true;
    if (typeof entry.text !== "string" || entry.text.trim().length > 0) {
      return false;
    }
  }
  return sawText;
}

function shouldHideProjectedHistoryMessage(message: Record<string, unknown>): boolean {
  const roleContent = asRoleContentMessage(message);
  if (!roleContent) {
    return false;
  }
  if (roleContent.role === "user" && isEmptyTextOnlyContent(message.content ?? message.text)) {
    return true;
  }
  if (roleContent.role === "assistant" && isEmptyTextOnlyContent(message.content ?? message.text)) {
    return false;
  }
  if (isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT)) {
    return true;
  }
  return isHeartbeatOkResponse(roleContent);
}

/**
 * FORK 2026-09-24 (ruling R36) — a transcript row the display projection shows as a USER row: role
 * user, and not hidden (empty text-only, a heartbeat prompt). chat-history-cursor.ts counts these
 * below a window (`cursor.userRowsBefore`) without projecting rows it does not serve.
 */
export function isShownHistoryUserRow(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const record = message as Record<string, unknown>;
  return (
    asRoleContentMessage(record)?.role === "user" && !shouldHideProjectedHistoryMessage(record)
  );
}

function toProjectedMessages(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      Boolean(message) && typeof message === "object" && !Array.isArray(message),
  );
}

function filterVisibleProjectedHistoryMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const visible: Array<Record<string, unknown>> = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (!current) {
      continue;
    }
    const currentRoleContent = asRoleContentMessage(current);
    const next = messages[i + 1];
    const nextRoleContent = next ? asRoleContentMessage(next) : null;
    if (
      currentRoleContent &&
      nextRoleContent &&
      isHeartbeatUserMessage(currentRoleContent, HEARTBEAT_PROMPT) &&
      isHeartbeatOkResponse(nextRoleContent)
    ) {
      changed = true;
      i++;
      continue;
    }
    if (shouldHideProjectedHistoryMessage(current)) {
      changed = true;
      continue;
    }
    visible.push(current);
  }
  return changed ? visible : messages;
}

// ── FORK 2026-09-29 — typed turn outcome on every projected assistant row ────────────────────────
//
// WHY. The 2026-09-29 census found 349 real failures rendering as plain answers after a reload:
// the UI guessed errors from prose, and its envelope renderer (`extractEnvelope`, an indexOf)
// drew a partial answer followed by an `__ERR_ENV__` envelope as the envelope ALONE, hiding the
// answer. This projection is the one display path for chat.history rows AND the chat.ts finals
// (`broadcastChatFinal` → projectChatDisplayMessage), so the gateway classifies ONCE here with
// src/fork/turn-outcome.ts and ships `outcome: TurnOutcome` for the UI to render from.
// Plan: jarvis-icu docs/superpowers/plans/2026-09-29-chat-usage-chips-and-typed-outcomes.md (U2).
//
// WHAT, per assistant row (every other row passes through untouched):
//   - a valid `outcome` already on the row → the row is returned as it is;
//   - otherwise classifyAssistantOutcome runs ONCE, on the text as persisted — BEFORE the display
//     truncation, which would cut an envelope trailing a 100k-char answer mid-JSON and leave
//     turn-outcome's unparseable-envelope fallback regexing the answer's prose. A non-null result
//     is attached as `outcome`; a malformed `outcome` field is removed, so the wire field is
//     always a TurnOutcome;
//   - an envelope-sourced outcome whose ONE envelope follows real answer text has the envelope cut
//     out of the text: the partial answer stays an answer and the envelope lives only in
//     `outcome.envelope`. The text is left as it is — the UI's legacy envelope renderer stays the
//     fallback — when the envelope is the whole text or follows only gateway lines
//     (NOT_ANSWER_LINE_RE); when the text holds two markers (on disk 2026-09-29: 2,654 assistant
//     rows carry a marker, every one exactly one — cutting one of two would drop the other from
//     the wire); and when the outcome did not come from an envelope (0 of 1,857 stopReason
//     "error" lines in the 400 newest sessions carry one — grafting the text's envelope onto such
//     an outcome would pair one error's headline with another's explanation);
//   - `empty` is withheld (a) from a row carrying any block other than text/thinking, or a
//     non-empty top-level `text`: an image or audio reply, or an imported claude-cli `toolcall`
//     (normalizeClaudeCliContent writes the type lowercase, which turn-outcome's tool check does
//     not recognise); (b) from every imported claude-cli row: Claude Code writes one transcript
//     entry per content block, so a text-less imported row is a step inside a turn, never the
//     turn's answer; (c) when the next SHOWN row is another assistant row, which answers or
//     explains it — census 2026-09-29 (110 sessions): 19 of 38 empty rows were followed within
//     60 s by the failure row that explains them, two bubbles for one failed turn. A writer that
//     knows better sets `outcome` itself, and the first rule keeps it.
// Never drops, never reorders, never mutates (the transcript cache hands out shared objects).
// Cost: every row reaching the projection is classified once — callers apply the window limit
// AFTER projecting, so this is the whole transcript, not the served window.

/**
 * Lines that are not answer text when they come before an envelope: turn-outcome's rule-6 skip set
 * (`[system]`, `Model set to …`), the two other directive acknowledgements found before an
 * envelope on disk (`Thinking level set to …`, `Model reset to …`, directive-handling.impl.ts),
 * and turn-outcome's error-shaped first lines. Mirrors SKIP_LINE_RE + ERROR_SHAPED_LINE_RE in
 * src/fork/turn-outcome.ts, which are not exported — keep them in step.
 */
const NOT_ANSWER_LINE_RE =
  /^(?:\[system\]|model set to\b|model reset to\b|thinking level set to\b|⚠️|⚠|🛑|❌|api error|error:|claude ai usage limit|you have hit your|all models are temporarily)/i;

/** Block types an `empty` outcome may sit on: nothing the user would read as an answer. */
const EMPTY_OUTCOME_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "thinking",
  "redacted_thinking",
]);

function hasAnswerTextBeforeEnvelope(before: string): boolean {
  for (const line of before.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !NOT_ANSWER_LINE_RE.test(t)) {
      return true;
    }
  }
  return false;
}

/** `text` with its one parseable envelope cut out, the text around it kept; else undefined. */
function cutEnvelope(text: string): string | undefined {
  const split = splitErrorEnvelope(text);
  if (!split.envelope) {
    return undefined;
  }
  return [split.before, split.after].filter((part) => part.trim()).join("\n\n");
}

/**
 * `text` without its envelope when it holds exactly ONE marker and that envelope parses and follows
 * real answer text; undefined means "leave the text alone".
 */
function textWithoutTrailingEnvelope(text: string): string | undefined {
  const at = text.indexOf(ERROR_ENVELOPE_MARKER);
  if (at === -1 || text.includes(ERROR_ENVELOPE_MARKER, at + ERROR_ENVELOPE_MARKER.length)) {
    return undefined;
  }
  const split = splitErrorEnvelope(text);
  if (!split.envelope || !hasAnswerTextBeforeEnvelope(split.before)) {
    return undefined;
  }
  return cutEnvelope(text);
}

function isTextBlockWithMarker(block: unknown): block is { type: "text"; text: string } {
  if (!block || typeof block !== "object") {
    return false;
  }
  const entry = block as { type?: unknown; text?: unknown };
  return (
    entry.type === "text" &&
    typeof entry.text === "string" &&
    entry.text.includes(ERROR_ENVELOPE_MARKER)
  );
}

/** Content without its trailing envelope (see textWithoutTrailingEnvelope); undefined = as is. */
function contentWithoutTrailingEnvelope(content: unknown): unknown {
  if (typeof content === "string") {
    return textWithoutTrailingEnvelope(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  // Decide on the text turn-outcome classified (text blocks joined by "\n"): the answer may sit in
  // an earlier block than the envelope.
  const joined = content
    .filter((block): block is { type: "text"; text: string } => {
      const entry = block as { type?: unknown; text?: unknown } | null;
      return Boolean(entry) && entry?.type === "text" && typeof entry?.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
  if (textWithoutTrailingEnvelope(joined) === undefined) {
    return undefined;
  }
  const blocks: unknown[] = [];
  for (const block of content) {
    if (!isTextBlockWithMarker(block)) {
      blocks.push(block);
      continue;
    }
    const cut = cutEnvelope(block.text);
    if (cut === undefined) {
      return undefined; // the JSON spans blocks — leave the row as persisted
    }
    // A block that held only the envelope goes; the answer lives in an earlier block.
    if (cut) {
      blocks.push({ ...block, text: cut });
    }
  }
  return blocks;
}

function isEmptyOutcomeEligible(message: Record<string, unknown>): boolean {
  if (isImportedChatDisplayMessage(message)) {
    return false;
  }
  if (typeof message.text === "string" && message.text.trim()) {
    return false;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return true;
  }
  return content.every((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const type = (block as { type?: unknown }).type;
    return typeof type === "string" && EMPTY_OUTCOME_BLOCK_TYPES.has(type);
  });
}

function projectAssistantOutcome(message: unknown, computedEmpty: Set<TurnOutcome>): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const row = message as Record<string, unknown>;
  if (row.role !== "assistant" || isTurnOutcome(row.outcome)) {
    return message;
  }
  // turn-outcome reads `content` only; a row whose text rides on a top-level `text` with no (or
  // empty) content must be classified on that text, never read as an empty stop.
  const content = row.content;
  const textCarriesIt =
    typeof row.text === "string" &&
    (content === undefined || content === null || (Array.isArray(content) && !content.length));
  let outcome = classifyAssistantOutcome(textCarriesIt ? { ...row, content: row.text } : row);
  if (outcome?.kind === "empty" && !isEmptyOutcomeEligible(row)) {
    outcome = null;
  }
  if (!outcome) {
    if (!("outcome" in row)) {
      return message;
    }
    const withoutMalformed = { ...row };
    delete withoutMalformed.outcome;
    return withoutMalformed;
  }
  const next: Record<string, unknown> = { ...row, outcome };
  if (outcome.kind === "empty") {
    computedEmpty.add(outcome);
  }
  if (outcome.envelope) {
    const cutContent = contentWithoutTrailingEnvelope(content);
    if (cutContent !== undefined) {
      next.content = cutContent;
    }
    if (typeof row.text === "string") {
      const cutText = textWithoutTrailingEnvelope(row.text);
      if (cutText !== undefined) {
        next.text = cutText;
      }
    }
  }
  return next;
}

function attachAssistantOutcomes(messages: unknown[]): {
  messages: unknown[];
  computedEmpty: Set<TurnOutcome>;
} {
  const computedEmpty = new Set<TurnOutcome>();
  let changed = false;
  const next = messages.map((message) => {
    const projected = projectAssistantOutcome(message, computedEmpty);
    changed ||= projected !== message;
    return projected;
  });
  return { messages: changed ? next : messages, computedEmpty };
}

/**
 * Rule (c) above, on the rows actually shown: an `empty` this projection computed is dropped when
 * the next shown row is another assistant row. Identity on the outcome object is safe — the
 * sanitize/filter passes copy rows shallowly and never the outcome.
 */
function withholdAnsweredEmptyOutcomes(
  rows: Array<Record<string, unknown>>,
  computedEmpty: ReadonlySet<TurnOutcome>,
): Array<Record<string, unknown>> {
  if (computedEmpty.size === 0) {
    return rows;
  }
  let changed = false;
  const next = rows.map((row, index) => {
    const outcome = row.outcome as TurnOutcome | undefined;
    if (!outcome || !computedEmpty.has(outcome) || rows[index + 1]?.role !== "assistant") {
      return row;
    }
    changed = true;
    const withoutEmpty = { ...row };
    delete withoutEmpty.outcome;
    return withoutEmpty;
  });
  return changed ? next : rows;
}

export function projectChatDisplayMessages(
  messages: unknown[],
  options?: { maxChars?: number; stripEnvelope?: boolean },
): Array<Record<string, unknown>> {
  const source = options?.stripEnvelope === false ? messages : stripEnvelopeFromMessages(messages);
  // Outcomes attach BEFORE sanitize, so classification and the envelope cut see the untruncated
  // text; the answered-empty pass runs last, on the rows actually shown.
  const typed = attachAssistantOutcomes(source);
  return withholdAnsweredEmptyOutcomes(
    filterVisibleProjectedHistoryMessages(
      suppressSupersededAbortEchoes(
        toProjectedMessages(
          sanitizeChatHistoryMessages(
            typed.messages,
            options?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
          ),
        ),
      ),
    ),
    typed.computedEmpty,
  );
}

// FORK 2026-08-26: a served chat.history window must NEVER be able to contain
// zero real turns. The merged history interleaves the local OpenClaw store (ONE
// coalesced message per completed turn) with imported claude-cli transcripts
// (one message per tool-loop STEP), so a single tool-heavy turn floods the tail
// with hundreds of import records carrying the newest timestamps. The old blind
// tail slice (`messages.slice(-maxMessages)`) then served windows that were
// 95-100% tool-loop import at every requested limit while the user's genuine
// conversation was entirely absent (measured live: 24 real turns on disk, ~0
// served from limit 5 through 1000). LOCAL_TAIL_FLOOR guarantees the newest N
// LOCAL messages — those carrying no `__openclaw.importedFrom` provenance —
// survive limitChatDisplayMessages; imported messages only fill whatever budget
// remains. The byte-budget passes downstream in server-methods/chat.ts are
// deliberately untouched: this floor applies ON TOP of them, and where honouring
// it costs bytes the floor still wins for local messages — a slower, larger
// window holding the real conversation beats a fast empty one.
export const LOCAL_TAIL_FLOOR = 24;

function isImportedChatDisplayMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const meta = (message as { __openclaw?: unknown }).__openclaw;
  if (!meta || typeof meta !== "object") {
    return false;
  }
  return (meta as { importedFrom?: unknown }).importedFrom != null;
}

export function limitChatDisplayMessages<T>(messages: T[], maxMessages?: number): T[] {
  if (
    typeof maxMessages !== "number" ||
    !Number.isFinite(maxMessages) ||
    maxMessages <= 0 ||
    messages.length <= maxMessages
  ) {
    return messages;
  }
  const limit = Math.floor(maxMessages);
  const localIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!isImportedChatDisplayMessage(messages[i])) {
      localIndices.push(i);
    }
  }
  // Pure inputs (all-local or all-imported) keep the exact legacy behaviour — a
  // plain tail slice. The floor only arbitrates when the two populations compete
  // for the same window.
  if (limit <= 0 || localIndices.length === 0 || localIndices.length === messages.length) {
    return messages.slice(-limit);
  }
  // Reserve the newest local messages first (the reservation is capped at the
  // window size, so maxMessages is always honoured), then fill the remaining
  // budget from the newest end of the merged array. The input is already
  // timestamp-ordered upstream (the merge layer sorts), so index order IS
  // chronological order — emitting selected indices in ascending order keeps
  // the output chronological.
  const selected = new Set<number>();
  const guaranteed = Math.min(localIndices.length, LOCAL_TAIL_FLOOR, limit);
  for (let k = localIndices.length - guaranteed; k < localIndices.length; k++) {
    selected.add(localIndices[k]);
  }
  for (let i = messages.length - 1; i >= 0 && selected.size < limit; i--) {
    selected.add(i);
  }
  const ordered = [...selected].sort((a, b) => a - b);
  return ordered.map((index) => messages[index]);
}

export function projectRecentChatDisplayMessages(
  messages: unknown[],
  options?: { maxChars?: number; maxMessages?: number; stripEnvelope?: boolean },
): Array<Record<string, unknown>> {
  return limitChatDisplayMessages(
    projectChatDisplayMessages(messages, options),
    options?.maxMessages,
  );
}

/**
 * One message through the same projection as chat.history, so a final that chat.ts broadcasts
 * (`broadcastChatFinal`) carries the same typed `outcome` a reload serves. A lone message has no
 * next row, so an empty stop here always keeps its `empty` outcome.
 */
export function projectChatDisplayMessage(
  message: unknown,
  options?: { maxChars?: number; stripEnvelope?: boolean },
): Record<string, unknown> | undefined {
  return projectChatDisplayMessages([message], options)[0];
}
