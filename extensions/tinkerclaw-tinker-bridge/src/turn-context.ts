/**
 * FORK 2026-10-10 (J-series Phase 1.5, C6) — the system prompt a warm worker keeps, and the part that travels with
 * each turn.
 *
 * WHY. Core builds the system prompt in two halves around a cache boundary: a stable prefix (persona, workspace
 * files, skills, tool rules) and a volatile suffix (channel and sender metadata, the `## Runtime` line with this
 * turn's model and thinking level). The provider transport strips the marker before this bridge sees the prompt
 * (stream-resolution.ts), so `stableSystemPromptPrefix` never found it and the worker key hashed the WHOLE prompt.
 * Measured on Tinker chats 10-09 → 10-10: the prompt changed on 160 of 163 consecutive turns (`## Runtime` on 142),
 * and 155 of 181 turns spawned a fresh `claude` under a new key, each one re-writing ~90% of its context into the
 * prompt cache (median 104K tokens). Core now says where the prefix ends (`__openclawStablePromptChars`); the worker
 * is keyed and spawned on the prefix alone, and the suffix rides in front of every prompt, so a warm worker reads
 * this turn's metadata instead of the metadata it was spawned with.
 *
 * Sent every turn, not only when it changes: the CLI's own compaction can summarise an earlier copy away, and a
 * respawned or forked worker would otherwise start without one. It is ~1.5 KB on a Tinker chat.
 *
 * Subagents keep the whole prompt: their task block (`# Subagent Context`, `## Your Role`) sits below the boundary
 * and their first prompt points at it "in the system prompt".
 */

export type WorkerSystemPrompt = {
  /** What the worker is keyed on and spawned with (`--append-system-prompt-file`). */
  stable: string;
  /** What travels in front of each prompt; empty when the prompt is not split. */
  volatile: string;
};

/**
 * Splits the (marker-stripped) system prompt at `stableChars`. Anything that does not look like core's split (no
 * count, a count out of range, or no newline where the stripped marker left one) keeps today's behaviour: the whole
 * prompt is the system prompt and nothing travels per turn.
 */
export function splitWorkerSystemPrompt(
  systemPrompt: string | undefined,
  stableChars: unknown,
  opts: { subagent?: boolean } = {},
): WorkerSystemPrompt {
  const full = systemPrompt ?? "";
  if (
    opts.subagent ||
    typeof stableChars !== "number" ||
    !Number.isInteger(stableChars) ||
    stableChars <= 0 ||
    stableChars >= full.length ||
    full.charAt(stableChars) !== "\n"
  ) {
    return { stable: full, volatile: "" };
  }
  return { stable: full.slice(0, stableChars).trimEnd(), volatile: full.slice(stableChars).trim() };
}

/** The volatile section as the worker reads it in front of a prompt; empty when there is none. */
export function formatTurnContext(volatile: string): string {
  if (!volatile) {
    return "";
  }
  return [
    "<turn_context>",
    "The per-turn section of your system prompt (channel, sender and runtime metadata). It applies to the message",
    "after it and replaces any earlier one.",
    "",
    volatile,
    "</turn_context>",
    "",
    "",
  ].join("\n");
}
