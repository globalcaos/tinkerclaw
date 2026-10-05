/**
 * Context Anatomy — Per-turn prompt decomposition.
 *
 * Records what goes into every LLM call: system prompt, workspace files,
 * skills, tool schemas, conversation history, tool results, and user message.
 * Each record is tagged with a compaction cycle counter and context utilization.
 *
 * Events are returned on the attempt result for real-time consumption.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
// FORK 2026-09-24 (A9) — the ONE shared marker. `src/moral-code/contract.ts` is the published
// contract every harness reads; detecting the pack with a private copy of the literal is exactly how
// `tinker-ui/src/injected-context.ts` and `extensions/tinkerclaw-moral-code/src/pack.ts` already
// drifted into three copies (bible context-window-panel.md F6, B1).
import { MORAL_CODE_MARKER } from "../moral-code/contract.js";
import { estimateTokens } from "../shared/anatomy-token-estimate.js";
// FORK 2026-07-28: single owner of "is this a tool result?" — it handles the production
// `"toolResult"` role plus the `"tool"` / `type:"toolResult"` variants. Reusing it is the point:
// this file previously carried its own, differently-wrong role test.
import { isToolResultMessage } from "./embedded-agent-runner/tool-result-char-estimator.js";

const log = createSubsystemLogger("agents/context-anatomy");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextAnatomyFileEntry = {
  name: string;
  chars: number;
  tokens: number;
};

export type ContextAnatomyEvent = {
  /** Monotonically increasing turn number within this session. */
  turn: number;
  /** Round number within this turn (1-based). Each tool-use loop iteration is one round. */
  roundNumber?: number;
  /**
   * WHICH COMPOSITION THIS EVENT CARRIES — FORK 2026-09-24 (A9, bible context-window-panel.md F5).
   *
   * `pre-call`  — built from the messages snapshot as it was handed to the model, so the turn's own
   *               user prompt is still the LAST message and lands in `userMessageChars`.
   * `post-turn` — built after the reply committed, so the last message is the assistant's and the
   *               user prompt has already slid into `conversationHistoryChars`. That is F5: the
   *               post-turn snapshot structurally CANNOT itemise the prompt it was asked about, and
   *               the panel must badge it rather than present it as the composition that was sent.
   *
   * `undefined` means nothing stamped this row. Every row written before schema v6 is in that state,
   * and it is not the same as `post-turn` — it is "unknown", which is the honest reading.
   */
  snapshot?: "pre-call" | "post-turn";
  /** How many compactions have occurred in this session so far. */
  compactionCycle: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Epoch millis. */
  timestampMs: number;
  /** Model used for this turn. */
  model: string;
  /** Provider used for this turn. */
  provider: string;
  /** Session key (if available). */
  sessionKey?: string;
  /** Top 3-5 topic keywords extracted from this turn's context. */
  topics: string[];
  /** Topic transition from previous turn (undefined on first turn or no session key). */
  topicTransition?: { from: string[]; to: string[]; changed: boolean };
  /** Breakdown of context sent to the model. */
  contextSent: {
    /**
     * The TinkerClaw moral-code pack — FIRST, because it outranks everything after it (bible
     * context-window-panel.md P3: fixed order, moral code first, never truncated).
     *
     * Never counted twice. A pack found inside bytes a slab ALREADY counted (a message, or the part
     * of the system prompt the report measured) is CARVED OUT of that slab, so the total does not
     * move. A pack found in bytes NO slab counted is ADDED: the per-turn runtime context the gateway
     * appends to the system prompt after the report was built, and the cc-bridge case, where the
     * pack lives inside the CLI's own `--resume` transcript that the gateway never sees. Those bytes
     * were part of the unitemised gap to the billed prompt.
     */
    moralCodeChars: number;
    moralCodeTokens: number;
    systemPromptChars: number;
    systemPromptTokens: number;
    injectedFiles: ContextAnatomyFileEntry[];
    injectedFilesTotalChars: number;
    injectedFilesTotalTokens: number;
    skillsChars: number;
    skillsTokens: number;
    toolSchemasChars: number;
    toolSchemasTokens: number;
    conversationHistoryChars: number;
    conversationHistoryTokens: number;
    toolResultsChars: number;
    toolResultsTokens: number;
    userMessageChars: number;
    userMessageTokens: number;
    totalChars: number;
    totalTokens: number;
  };
  /** Context window utilization. */
  contextWindow: {
    maxTokens: number;
    usedTokens: number;
    utilizationPercent: number;
  };
  /** Auth profile used for this turn (e.g. "oauth-sv", "api", "cli-gm"). */
  authProfileId?: string;
  /** Output/response tokens from the model (if available). */
  responseTokens?: number;
  /** Which memory files were injected. */
  memoriesInjected: {
    /** Files injected as workspace bootstrap (MEMORY.md, SOUL.md, etc). */
    autoRecall: string[];
    /** Files retrieved via memory_search tool calls (populated later). */
    searched: string[];
  };

  // --- response breakdown (new) ---
  runId?: string;
  durationMs?: number;
  stopReason?: string;
  toolsTriggered?: Array<{
    name: string;
    toolCallId: string;
    inputChars?: number;
    outputChars?: number;
    durationMs?: number;
    isError?: boolean;
  }>;
  responseThinkingTokens?: number;
  responseTextTokens?: number;
  responseToolCallTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  responseContent?: {
    thinkingChars?: number;
    textChars?: number;
    toolCallChars?: number;
  };
  /** The user message that triggered this LLM turn (text only, max 50K chars). */
  userMessage?: string;
  /** The assistant's response text for this turn (max 50K chars). */
  assistantResponse?: string;
};

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

// The one anatomy estimator (P11) lives in src/shared so the UI's call timeline uses the same number.
export { estimateTokens };

// ---------------------------------------------------------------------------
// Moral code detection (FORK 2026-09-24 — A9, bible context-window-panel.md F6)
// ---------------------------------------------------------------------------

/**
 * The closing tag, DERIVED from the one shared opening constant rather than written out again.
 *
 * `</moral_code>` already exists as a bare literal in `extensions/tinkerclaw-moral-code/src/pack.ts`
 * and in `tinker-ui/src/injected-context.ts`. Adding a third would make the close tag a fact with no
 * owner, which is the same failure the open marker was hoisted into `src/moral-code/contract.ts` to
 * stop. Deriving it means a contract change moves both halves at once.
 *
 * The throw is deliberate and LOUD. If the marker ever stops being an opening tag, a silent fallback
 * literal would keep this module compiling while it measured the wrong span forever; a module-scope
 * throw fails the gateway's very first import with the reason printed.
 */
const MORAL_CODE_TAG_NAME = /^<([A-Za-z0-9_-]+)/.exec(MORAL_CODE_MARKER)?.[1];
if (!MORAL_CODE_TAG_NAME) {
  throw new Error(
    `[context-anatomy] MORAL_CODE_MARKER is not an opening tag and the closing tag cannot be derived from it: ${MORAL_CODE_MARKER}`,
  );
}
const MORAL_CODE_CLOSE = `</${MORAL_CODE_TAG_NAME}>`;

/**
 * The opening marker as it appears inside JSON-SERIALISED text (`source=\"tinkerclaw\"`).
 *
 * NOT optional. `buildContextAnatomy` measures a message whose content is a block array as
 * `JSON.stringify(msg.content)`, and every prompt pi-agent-core stores is a block array — so in the
 * messages this module actually sees, the marker's quotes are ESCAPED and a search for the raw
 * marker finds nothing, ever. `src/moral-code/contract.ts` makes the same distinction for the CLI
 * transcript (its private `MORAL_CODE_MARKER_JSON`); this is the same derivation from the same
 * constant, not a new literal. The closing tag has no quotes and no `/` escaping under
 * JSON.stringify, so it is identical in both forms.
 */
const MORAL_CODE_MARKER_JSON = JSON.stringify(MORAL_CODE_MARKER).slice(1, -1);

/** Next pack opening at or after `from`, in either form; -1 with length 0 when there is none. */
function findMoralCodeOpen(text: string, from: number): { at: number; length: number } {
  const raw = text.indexOf(MORAL_CODE_MARKER, from);
  const json = text.indexOf(MORAL_CODE_MARKER_JSON, from);
  if (raw < 0 && json < 0) {
    return { at: -1, length: 0 };
  }
  if (json < 0 || (raw >= 0 && raw <= json)) {
    return { at: raw, length: MORAL_CODE_MARKER.length };
  }
  return { at: json, length: MORAL_CODE_MARKER_JSON.length };
}

/**
 * Total chars of every moral-code pack span inside `text` (0 when there is none).
 *
 * Loops rather than measuring one span: the pack is re-delivered after EVERY compaction
 * (`extensions/tinkerclaw-moral-code/index.ts` returns `{prependContext: pack}` on the first turn and
 * after each compaction), so a long session's transcript legitimately carries several copies and
 * a single `indexOf` would under-report a resident cost the model keeps paying.
 *
 * An UNTERMINATED pack (truncated mid-injection) counts to the end of the text rather than to zero:
 * the bytes reached the model whether or not the closing tag survived, and reporting 0 there would
 * reproduce the "tool results 0" defect this file already carries a monument to.
 */
export function measureMoralCodeChars(text: string | null | undefined): number {
  if (!text) {
    return 0;
  }
  let total = 0;
  let from = 0;
  for (;;) {
    const open = findMoralCodeOpen(text, from);
    if (open.at < 0) {
      return total;
    }
    const close = text.indexOf(MORAL_CODE_CLOSE, open.at + open.length);
    const end = close < 0 ? text.length : close + MORAL_CODE_CLOSE.length;
    total += end - open.at;
    from = end;
  }
}

// ---------------------------------------------------------------------------
// Topic extraction
// ---------------------------------------------------------------------------

/** Common English stop words to filter during keyword extraction. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "it",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "but",
  "with",
  "from",
  "by",
  "as",
  "be",
  "was",
  "are",
  "were",
  "been",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "i",
  "me",
  "my",
  "we",
  "you",
  "he",
  "she",
  "they",
  "them",
  "this",
  "that",
  "these",
  "those",
  "what",
  "how",
  "why",
  "when",
  "where",
  "which",
  "who",
  "not",
  "no",
  "so",
  "if",
  "then",
  "up",
  "out",
  "now",
  "also",
  "just",
  "about",
  "into",
  "than",
  "its",
  "your",
  "our",
  "their",
  "there",
  "here",
  "get",
  "got",
  "let",
  "run",
  "want",
  "make",
  "like",
  "know",
  "look",
  "see",
  "use",
  "find",
  "give",
  "think",
  "tell",
  "show",
  "work",
]);

/** Regex to detect file paths (e.g. src/foo/bar.ts, /home/user/file.md). */
const FILE_PATH_REGEX = /(?:^|\s|["'`(])(\/?(?:[\w.-]+\/)+[\w.-]+\.[\w]+)/gm;

/**
 * Extract topic keywords from a messages snapshot.
 *
 * Sources (in order of priority):
 * 1. Last user message: key nouns/verbs via word frequency.
 * 2. Tool calls in assistant messages: tool names used.
 * 3. Tool result messages: file paths mentioned.
 *
 * Returns 3–5 topic keywords.
 */
export function extractTopics(messagesSnapshot: AgentMessage[]): string[] {
  const topics: string[] = [];

  // --- Source 1: keywords from last user message ---
  const lastUserMsg = [...messagesSnapshot]
    .toReversed()
    .find((m) => m.role === "user" && "content" in m);
  if (lastUserMsg && "content" in lastUserMsg) {
    const text =
      typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : JSON.stringify(lastUserMsg.content);
    const wordFreq = new Map<string, number>();
    for (const word of text.toLowerCase().split(/\W+/)) {
      if (word.length >= 4 && !STOP_WORDS.has(word)) {
        wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
      }
    }
    const sorted = [...wordFreq.entries()].toSorted((a, b) => b[1] - a[1]);
    for (const [word] of sorted.slice(0, 3)) {
      topics.push(word);
    }
  }

  // --- Source 2: tool names from assistant messages ---
  for (const msg of messagesSnapshot) {
    if (msg.role !== "assistant" || !("content" in msg)) {
      continue;
    }
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as unknown as Record<string, unknown>;
        if (b && typeof b === "object" && b.type === "tool_use" && typeof b.name === "string") {
          const toolName = b.name as string;
          if (!topics.includes(toolName)) {
            topics.push(toolName);
          }
        }
      }
    }
  }

  // --- Source 3: file paths from tool results ---
  for (const msg of messagesSnapshot) {
    if ((msg.role as string) !== "tool" || !("content" in msg)) {
      continue;
    }
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    for (const match of text.matchAll(FILE_PATH_REGEX)) {
      const filePath = match[1];
      if (filePath && !topics.includes(filePath)) {
        topics.push(filePath);
      }
    }
  }

  return topics.slice(0, 5);
}

/** Per-session topic history used to compute turn-to-turn transitions. */
const sessionTopicsState = new Map<string, string[]>();

/**
 * Compare two topic arrays to determine if the topic has meaningfully changed.
 * "Changed" when fewer than half of the new topics overlap with the previous ones.
 */
function computeTopicTransition(
  from: string[],
  to: string[],
): { from: string[]; to: string[]; changed: boolean } {
  if (from.length === 0 && to.length === 0) {
    return { from, to, changed: false };
  }
  const fromSet = new Set(from);
  const overlap = to.filter((t) => fromSet.has(t)).length;
  const threshold = Math.max(1, Math.floor(Math.min(from.length, to.length) / 2));
  return { from, to, changed: overlap < threshold };
}

// ---------------------------------------------------------------------------
// Build anatomy from attempt data
// ---------------------------------------------------------------------------

export function buildContextAnatomy(params: {
  turn: number;
  roundNumber?: number;
  compactionCycle: number;
  provider: string;
  model: string;
  sessionKey?: string;
  systemPromptReport: SessionSystemPromptReport;
  messagesSnapshot: AgentMessage[];
  contextWindowTokens: number;
  totalTokensUsed?: number;
  outputTokens?: number;
  authProfileId?: string;
  /**
   * The system-prompt bytes ACTUALLY SENT, when the caller has them. Used only to locate the moral
   * code: `SessionSystemPromptReport` carries char COUNTS, never text, so without this the pack can
   * never be attributed to the system prompt. Omitting it is safe — the messages are still scanned.
   */
  systemPromptText?: string;
  /**
   * cc-bridge only: TRUE when the Claude Code transcript for this turn carries the marker
   * (`transcriptHasMoralCode`, src/moral-code/contract.ts). The gateway cannot see inside the CLI's
   * own `--resume` transcript, so there is nothing local to measure.
   */
  moralCodeInTranscript?: boolean;
  /** cc-bridge only: size of the PUBLISHED pack (`readPublishedMoralCode(stateDir).length`). */
  moralCodePackChars?: number;
  /** Which composition this is — see `ContextAnatomyEvent.snapshot`. */
  snapshot?: "pre-call" | "post-turn";
}): ContextAnatomyEvent {
  const { systemPromptReport: report } = params;
  const now = Date.now();

  // System prompt (non-project-context = framework instructions, runtime info, etc)
  const rawSystemPromptChars = report.systemPrompt.nonProjectContextChars;
  // FORK 2026-09-24 (A9) — a pack in the system-prompt TEXT is either inside the bytes the report
  // measured (carve it out of the slab) or inside bytes appended AFTER the report was built (add
  // it). The second is the common case, not an edge: `buildSystemPromptReport` runs on the base
  // prompt, and the moral code arrives later as a `before_prompt_build` prependContext. When the
  // turn has a transcript prompt, attempt.ts moves that context into a turn-local system-prompt
  // override (`buildRuntimeContextSystemContext`). Those bytes are in `systemPromptText` and in no
  // report count. Carving 40k chars out of a slab that never held them would zero the system-prompt
  // slab (the clamp only hides the negative) and under-count the total by exactly the bytes wiped.
  //
  // The split uses the only evidence available: the sent text's length beyond what the report
  // measured (`report.systemPrompt.chars`) is bytes the report never saw. The pack claims that
  // excess first. Whatever remains must have been inside the report's count and is carved,
  // clamped so a slab can never go negative. It is an estimate — the remembered report can be a
  // turn old — and it errs by at most the drift in base-prompt length between two turns.
  const systemPromptPackChars = measureMoralCodeChars(params.systemPromptText);
  const unreportedSystemPromptChars =
    params.systemPromptText == null
      ? 0
      : Math.max(0, params.systemPromptText.length - report.systemPrompt.chars);
  const systemPromptAddedMoralCodeChars = Math.min(
    systemPromptPackChars,
    unreportedSystemPromptChars,
  );
  const systemPromptCarvedMoralCodeChars = Math.min(
    systemPromptPackChars - systemPromptAddedMoralCodeChars,
    rawSystemPromptChars,
  );
  const systemPromptChars = rawSystemPromptChars - systemPromptCarvedMoralCodeChars;

  // Injected workspace files
  const injectedFiles: ContextAnatomyFileEntry[] = report.injectedWorkspaceFiles
    .filter((f) => !f.missing && f.injectedChars > 0)
    .map((f) => ({
      name: f.name,
      chars: f.injectedChars,
      tokens: estimateTokens(f.injectedChars),
    }));
  const injectedFilesTotalChars = injectedFiles.reduce((sum, f) => sum + f.chars, 0);

  // Skills
  const skillsChars = report.skills.promptChars;

  // Tool schemas
  const toolSchemasChars = report.tools.listChars + report.tools.schemaChars;

  // Conversation history and tool results from messages snapshot
  let conversationHistoryChars = 0;
  let toolResultsChars = 0;
  let userMessageChars = 0;
  /** Moral-code chars found in the messages, removed from the slab each one rode in on. */
  let messageMoralCodeChars = 0;
  /** Chars matching no slab. Non-zero means the composition under-reads the real context. */
  let unattributedChars = 0;

  const messages = params.messagesSnapshot;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) {
      continue;
    }
    if (!("content" in msg)) {
      continue;
    }
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    // FORK 2026-09-24 (A9, bible F6 "the ethics are cut off from the bar"). On every non-Claude
    // provider the moral code arrives as `prependContext` at priority 1000 — i.e. as the HEAD of
    // this turn's user message — so without this carve-out the most important part of the prompt is
    // indistinguishable from whatever the human typed. `chars` is the message's NET size: the pack
    // moves to its own slab, the total does not move at all.
    const moralCodeInMessage = measureMoralCodeChars(content);
    messageMoralCodeChars += moralCodeInMessage;
    const chars = content.length - moralCodeInMessage;
    const isLast = i === messages.length - 1;

    // FORK 2026-07-28 — THIS CHAIN SILENTLY DROPPED EVERY TOOL RESULT.
    //
    // It tested `msg.role === ("tool" as string)`, but the production role literal is
    // `"toolResult"` (@mariozechner/pi-ai `types.d.ts:154`). A tool-result message therefore
    // matched NO branch and contributed ZERO to `totalChars` — and the `as string` cast is what
    // silenced the TypeScript error that would have caught it, which is the whole lesson.
    //
    // Consequence, and it reached published figures: the decoded composition read
    // "tool results 0", which was taken as "no tool results resident" when it actually meant
    // "tool results were not counted". Anything derived from that total under-reads the real
    // context. The correct predicate already existed three directories away, so we now use it
    // rather than re-deriving a second, differently-wrong role test.
    //
    // The terminal `else` is the other half: an unclassified message is ACCUMULATED and
    // reported rather than dropped, so the next role the union grows shows up as a visible
    // unattributed slab instead of silently shrinking the total.
    if (msg.role === "user" && isLast) {
      userMessageChars = chars;
    } else if (isToolResultMessage(msg as never)) {
      toolResultsChars += chars;
    } else if (msg.role === "user" || msg.role === "assistant") {
      conversationHistoryChars += chars;
    } else {
      unattributedChars += chars;
    }
  }

  if (unattributedChars > 0) {
    // Loud on purpose: a slab nobody can attribute is exactly how "tool results 0" happened.
    log.warn(
      `[context-anatomy] ${unattributedChars} chars did not match any composition slab — ` +
        `a message role is unaccounted for, so the reported total UNDER-reads the real context`,
    );
  }

  // FORK 2026-09-24 (A9) — three sources, ordered by how much the number can be trusted:
  //   1. the system-prompt bytes actually sent  -> split into carved / added above,
  //   2. the messages snapshot                  -> carved out of User/Conv/Results above,
  //   3. cc-bridge ONLY: the pack sits inside the Claude Code `--resume` transcript, which the
  //      gateway never sees. Nothing local to detect, nothing to carve out, so the caller that CAN
  //      see it passes the PUBLISHED pack size and it is ADDED — those bytes were in no slab (they
  //      were part of the unitemised gap between this total and the billed prompt).
  // (3) fires only when (1) and (2) found NOTHING, so a pack visible in the snapshot is never also
  // counted from the file. Guessing would be the easy error here: an added-AND-carved pack would
  // read as a 2x moral code and nothing downstream could tell.
  const detectedMoralCodeChars = systemPromptPackChars + messageMoralCodeChars;
  const transcriptMoralCodeChars =
    detectedMoralCodeChars === 0 && params.moralCodeInTranscript
      ? Math.max(0, params.moralCodePackChars ?? 0)
      : 0;
  const moralCodeChars = detectedMoralCodeChars + transcriptMoralCodeChars;

  const totalChars =
    moralCodeChars +
    systemPromptChars +
    injectedFilesTotalChars +
    skillsChars +
    toolSchemasChars +
    conversationHistoryChars +
    toolResultsChars +
    userMessageChars;

  const totalTokens = estimateTokens(totalChars);
  const maxTokens = params.contextWindowTokens;
  // FORK 2026-07-28 — `totalTokensUsed` is RUN-CUMULATIVE, not a context snapshot.
  //
  // It arrives from `embedded-agent-subscribe.ts` `usageTotals.total`, which accumulates
  // input+output+cacheRead+cacheWrite across EVERY committed assistant message of the run and
  // never resets — not even on compaction. Preferring it over the char estimate published an
  // accumulator as context fill, and this event is the SOURCE the timeline, the treemap and the
  // persisted anatomy DB all read, so one bad number reached three consumers.
  //
  // A used-figure larger than the whole window cannot be a context size. When that happens we
  // fall back to the honest local char estimate rather than clamping to 100%: clamping would
  // hide the same poison one layer down and still report a fabricated fill. Same rule as the
  // `deriveContextPromptTokens` chokepoint — reject, do not fabricate.
  const reportedUsed = params.totalTokensUsed;
  const reportedIsPlausible =
    typeof reportedUsed === "number" &&
    Number.isFinite(reportedUsed) &&
    reportedUsed > 0 &&
    (maxTokens <= 0 || reportedUsed <= maxTokens);
  const usedTokens = reportedIsPlausible ? (reportedUsed as number) : totalTokens;

  // Auto-recalled memories = injected workspace files that look like memory paths
  const autoRecall = report.injectedWorkspaceFiles
    .filter(
      (f) =>
        !f.missing &&
        f.injectedChars > 0 &&
        (f.path.includes("memory") ||
          f.path.includes("MEMORY") ||
          f.name === "MEMORY.md" ||
          f.name === "SOUL.md"),
    )
    .map((f) => f.path);

  // Topic extraction + transition tracking
  const topics = extractTopics(params.messagesSnapshot);
  const stateKey = params.sessionKey ?? "";
  const previousTopics = stateKey ? sessionTopicsState.get(stateKey) : undefined;
  const topicTransition =
    previousTopics !== undefined ? computeTopicTransition(previousTopics, topics) : undefined;
  // FORK 2026-09-24 (A9) — a PRE-CALL build reads the topic history but does not advance it. A
  // turn is now built twice (pre-call, then post-turn), and if both advanced the state the
  // post-turn transition would compare the turn against ITSELF (same last user message, so
  // `changed` false every time), and that transition is the one the upsert keeps. Advancing only
  // on the post-turn build keeps "previous" meaning the previous TURN for both builds.
  if (stateKey && params.snapshot !== "pre-call") {
    sessionTopicsState.set(stateKey, topics);
  }

  return {
    turn: params.turn,
    roundNumber: params.roundNumber,
    snapshot: params.snapshot,
    compactionCycle: params.compactionCycle,
    timestamp: new Date(now).toISOString(),
    timestampMs: now,
    model: params.model,
    provider: params.provider,
    sessionKey: params.sessionKey,
    topics,
    topicTransition,
    contextSent: {
      moralCodeChars,
      moralCodeTokens: estimateTokens(moralCodeChars),
      systemPromptChars,
      systemPromptTokens: estimateTokens(systemPromptChars),
      injectedFiles,
      injectedFilesTotalChars,
      injectedFilesTotalTokens: estimateTokens(injectedFilesTotalChars),
      skillsChars,
      skillsTokens: estimateTokens(skillsChars),
      toolSchemasChars,
      toolSchemasTokens: estimateTokens(toolSchemasChars),
      conversationHistoryChars,
      conversationHistoryTokens: estimateTokens(conversationHistoryChars),
      toolResultsChars,
      toolResultsTokens: estimateTokens(toolResultsChars),
      userMessageChars,
      userMessageTokens: estimateTokens(userMessageChars),
      totalChars,
      totalTokens,
    },
    contextWindow: {
      maxTokens,
      usedTokens,
      utilizationPercent: maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 1000) / 10 : 0,
    },
    authProfileId: params.authProfileId,
    responseTokens: params.outputTokens,
    memoriesInjected: {
      autoRecall,
      searched: [],
    },
  };
}
