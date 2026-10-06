/**
 * Blocks the gateway appends AFTER the owner's words before a prompt reaches the model: the 🌿
 * FRACTAL reflection doctrine, and the tinker-bridge's chat-row contract (the bridge appends the
 * contract to every prose turn it forwards to claude-cli, so only the CLI's own copy carries it).
 * They are instructions to the model, never the request.
 *
 * FORK 2026-10-05 — one list instead of a copy per reader (session-rewind.ts kept its own). The
 * amygdala extension still carries a copy (extensions/tinkerclaw-amygdala/src/situation.ts) because
 * it does not import core modules.
 */

/** The bridge's chat-row contract, from its marker line to the end. CLI copies only. */
export const CHAT_ROW_CONTRACT_RE = /\n\s*<!-- TINKERCLAW chat-row contract -->/;

/** Every appended block, in the order a prompt carries them. Cut a prompt at the first match. */
export const APPENDED_PROMPT_BLOCKS: readonly RegExp[] = [
  /\n\s*-{3,}\s*\n+\s*\*\*After your reply, append a 🌿 FRACTAL/,
  CHAT_ROW_CONTRACT_RE,
];
