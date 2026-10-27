/**
 * The owner's words inside a prompt, and whether a person wrote the prompt at all.
 *
 * WHAT THIS IS FOR. A hook receives the prompt as the gateway built it, not as the owner typed it. In front: the web
 * chat's sender block, the gateway's queued system-event lines, the abort note and the delivery stamp. Behind: the
 * reflection doctrine and the bridge's chat-row contract (appended-prompt-blocks.ts). And some turns have no owner at
 * all: the gateway, a long job, the Overseer or another agent wrote them. A reader that judges the OWNER (the humour
 * gate, the curiosity topic, the effort router, the amygdala's request) must judge only his words.
 *
 * WHY ONE COPY. Each reader used to carry its own cleaner or none. On 2026-10-09, 296 of 319 curiosity gap topics were
 * the stamp ("fri 2026-10-09"), the humour gate read the doctrine's "again … not" as frustration on 619 of 619 armed
 * prompts, and the amygdala took a gateway restart notice for the owner's request (J7 §8, J8 §7). Extensions import
 * this file as `openclaw/plugin-sdk/fork-prompt-envelope`.
 */

import { APPENDED_PROMPT_BLOCKS } from "./appended-prompt-blocks.js";

/** The web chat's header in front of a prompt it relays: `Sender (untrusted metadata):` and a fenced JSON block. */
const SENDER_BLOCK = /^\s*Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/;
/**
 * The gateway's queued system events, one prefixed line each (auto-reply/reply/session-system-events.ts). The block
 * opens with a trusted `System:` line or a dated untrusted one: a line the owner typed as `System:` arrives rewritten
 * to `System (untrusted):` with no date (inbound-text.ts), and stays his.
 */
const SYSTEM_EVENT_LINES =
  /^\s*(?:System: |System \(untrusted\): \[[^\]\n]*\d{4}-\d{2}-\d{2})[^\n]*(?:\nSystem(?: \(untrusted\))?: [^\n]*)*/;
/** The note in front of the next prompt after the owner stopped a run (auto-reply/reply/body.ts). */
const ABORT_NOTE = /^\s*Note: The previous agent run was aborted by the user\.[^\n]*/;
/**
 * The delivery stamp `[Fri 2026-10-09 20:56 GMT+2]`, or a channel envelope with a date: the same test the gateway uses
 * to leave an already-stamped message alone (agent-timestamp.ts). A bracket with no date is the owner's own text.
 */
const STAMP = /^\s*\[[^\]\n]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*\]/;
/** The label an agent's turn wears: `⟦AGENT:🌿 Fractal · prompt 3⟧`, `⟦OVERSEER⟧`. */
const AGENT_LABEL = /^\s*⟦[^⟧\n]*⟧/;

/**
 * A turn no person wrote, by its opening once the envelope is off: an agent's or the Overseer's label, a gateway
 * notice (`[System]`, `[System · who]`), an injection, another session's message, a background-task notice, the
 * runtime's internal context, a subagent's task, or an agent's older 🤖 self-wake. The set tinker-ui paints blue.
 */
const AGENT_OPENING =
  /^(?:⟦(?:AGENT|OVERSEER)\b|\[System\b|\[inject(?:ed)?\b|<cross-session-message\b|<task-notification\b|<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>|\[Subagent Context\]|🤖)/i;
/** The marker a worker's own background turn carries to the chat that takes it (tinker-bridge unprompted-turn.ts). */
const BG_TURN = /\[bg-turn bgt-[a-z0-9-]+\]/;

/** Takes the wrappers in front off, in whatever order they come; the agent label too when `label` is set. */
function dropHead(prompt: string, label: boolean): string {
  let s = prompt;
  for (;;) {
    let next = s
      .replace(SENDER_BLOCK, "")
      .replace(SYSTEM_EVENT_LINES, "")
      .replace(ABORT_NOTE, "")
      .replace(STAMP, "");
    if (label) {
      next = next.replace(AGENT_LABEL, "");
    }
    if (next === s) {
      return s.trimStart();
    }
    s = next;
  }
}

/** True when the gateway, a job or an agent wrote this prompt, so no word of it is the owner's. */
export function isAgentPrompt(prompt: string | undefined): boolean {
  if (!prompt) {
    return false;
  }
  return AGENT_OPENING.test(dropHead(prompt, false)) || BG_TURN.test(prompt);
}

/**
 * The prompt without its envelope: the blocks appended after the words are cut, and the wrappers in front are taken
 * off. An agent's prompt keeps its words and loses only its label.
 */
export function stripPromptEnvelope(prompt: string): string {
  let s = prompt;
  for (const re of APPENDED_PROMPT_BLOCKS) {
    const m = re.exec(s);
    if (m) {
      s = s.slice(0, m.index);
    }
  }
  return dropHead(s, true).trim();
}

/** What the owner wrote in this prompt; undefined when nobody did (an agent's turn) or nothing is left. */
export function ownerWords(prompt: string | undefined): string | undefined {
  if (!prompt || isAgentPrompt(prompt)) {
    return undefined;
  }
  const words = stripPromptEnvelope(prompt);
  return words === "" ? undefined : words;
}

/**
 * True when the prompt, once its envelope is off, is a slash command (`/compact`, `/compact: keep the plan`). A hook
 * that prepends per-turn context (`prependContext`) skips such a turn: text in front of the command moves the slash off
 * position 0, and the Claude Code CLI then reads `/compact` as prose (tinker-bridge cli-command.ts). A path such as
 * `/home/x` is not a command.
 */
export function isSlashCommandPrompt(prompt: string | undefined): boolean {
  return !!prompt && /^\/[A-Za-z][\w-]*(?:[\s:]|$)/.test(stripPromptEnvelope(prompt));
}
