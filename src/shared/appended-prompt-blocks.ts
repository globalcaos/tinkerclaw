/**
 * Blocks the gateway appends AFTER the owner's words before a prompt reaches the model: the 🌿
 * FRACTAL reflection doctrine, and the tinker-bridge's chat-row contract (the bridge appends the
 * contract to every prose turn it forwards to claude-cli, so only the CLI's own copy carries it).
 * They are instructions to the model, never the request.
 *
 * FORK 2026-10-05 — one list instead of a copy per reader (session-rewind.ts kept its own). Since
 * 2026-10-09 the extensions read it through `prompt-envelope.ts` (plugin-sdk/fork-prompt-envelope),
 * which also takes off the wrappers in front of the owner's words.
 */

/**
 * FORK 2026-10-09 (Fractal v2, charter C4) — the neutral marker new prompts open the Fractal doctrine
 * with, in place of "**After your reply, append a 🌿 FRACTAL reflection section**" (the doctrine now
 * runs in its own background turn, so "after your reply" no longer describes it). Same seam position:
 * `\n\n---\n\n⟦FRACTAL-DOCTRINE⟧\n`. Old transcripts keep the old literal, so readers match both.
 */
export const FRACTAL_DOCTRINE_MARKER = "⟦FRACTAL-DOCTRINE⟧";

/** The bridge's chat-row contract, from its marker line to the end. CLI copies only. */
export const CHAT_ROW_CONTRACT_RE = /\n\s*<!-- TINKERCLAW chat-row contract -->/;

/**
 * FORK 2026-10-10 — blocks the tinker-bridge puts IN FRONT of the owner's words in the CLI's copy of a
 * prompt: the per-turn `<turn_context>` (turn-context.ts, since 5bc62f2b020) and the Fractal result of
 * the reverted 2026-10-10 inject (`[Background Fractal reflection …]` … `---`, still in that day's CLI
 * transcripts). Symptom: large stray green bubbles of Fractal text — an imported CLI prompt
 * carrying them no longer matched his typed one and drew as a second, 12 KB green bubble.
 */
export const LEADING_PROMPT_BLOCKS: readonly RegExp[] = [
  /^\s*<turn_context>[\s\S]*?<\/turn_context>\s*/,
  /^\s*\[Background Fractal reflection on an earlier turn of this chat\.[\s\S]*?\n---\n\s*/,
];

/** The owner's prompt without the leading blocks above (repeated: a prompt can carry both). */
export function withoutLeadingPromptBlocks(text: string): string {
  let out = text;
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of LEADING_PROMPT_BLOCKS) {
      const m = re.exec(out);
      if (m) {
        out = out.slice(m[0].length);
        changed = true;
      }
    }
  }
  return out;
}

/** Every appended block, in the order a prompt carries them. Cut a prompt at the first match. */
export const APPENDED_PROMPT_BLOCKS: readonly RegExp[] = [
  /\n\s*-{3,}\s*\n+\s*\*\*After your reply, append a 🌿 FRACTAL/,
  /\n\s*-{3,}\s*\n+\s*⟦FRACTAL-DOCTRINE⟧/,
  CHAT_ROW_CONTRACT_RE,
];
