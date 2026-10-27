/**
 * FORK 2026-10-09: the prompt-envelope cleaner as a declared plugin-SDK surface (J-series plan, Phase 1.1).
 *
 * The amygdala carried the only full copy (situation.ts `stripWrapper` / `isAgentPrompt`); the humour gate, the
 * effort router and the curiosity topic read the raw prompt. An extension cannot import another extension, so the
 * cleaner lives in `src/shared/prompt-envelope.ts` and is published here. Pure string functions, no state, no I/O.
 */
export {
  isAgentPrompt,
  isSlashCommandPrompt,
  ownerWords,
  stripPromptEnvelope,
} from "../shared/prompt-envelope.js";
// FORK 2026-10-22: the bridge's `<turn_context>` header in front of the owner's words (Rewind needs it off the prompt it
// hands back to the composer; `stripPromptEnvelope` leaves it on).
export { withoutLeadingPromptBlocks } from "../shared/appended-prompt-blocks.js";
