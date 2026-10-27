/**
 * FORK 2026-10-05 (bug-log `steer-written-twice`) — the user message pi persists for a steered
 * prompt carries that prompt's own key.
 *
 * A prompt sent while a pi-native turn runs had two writers. pi wrote the row when it injected the
 * steer at the next turn boundary, with no key (AgentSession.steer builds the message from text
 * alone), and the steer's delivery callback wrote a keyed copy under chat.send's marker, which the
 * running turn's next append stranded on a dead fork. The reader served both: one prompt shown
 * twice (agent:main:tinker:mue2cvin 2026-10-05 08:25, and two more since 09-23). pi persists the
 * steered object by reference, so a key set here reaches the row on disk, and the delivery callback
 * no longer writes for a run that persists it (runs.ts `persistsSteeredPrompt`).
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * The key a steered message carries, or undefined to leave it to AgentSession.steer: the buffer's
 * last caller's key, the one the delivery row carried. A slash command or prompt template keeps
 * pi's own path, which expands it before queueing.
 */
export function steerPromptKey(
  text: string,
  promptKeys: readonly string[] | undefined,
): string | undefined {
  if (text.trimStart().startsWith("/")) {
    return undefined;
  }
  const key = promptKeys?.at(-1);
  return typeof key === "string" && key !== "" ? key : undefined;
}

/** The message AgentSession.steer would queue for `text`, keyed. */
export function buildKeyedSteerMessage(text: string, key: string, now = Date.now()): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: now,
    idempotencyKey: key,
  } as unknown as AgentMessage;
}
