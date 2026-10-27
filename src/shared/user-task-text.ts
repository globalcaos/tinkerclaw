// FORK 2026-10-09 — the user's own words, with the gateway's injected trailer removed.
//
// Lifted from src/agents/effort-allocator.ts (FORK 2026-07-26, "when I move the effort level it
// magically hops to high"): the Tinker UI appends a fixed ~3,369-character FRACTAL reflection
// instruction to every message, so anything that measures a prompt — the allocator's size
// buckets, the local task read behind THALAMUS's task effort (src/shared/thalamus-effort.ts) —
// must first cut the envelope off. One copy, pure and browser-safe, so the two readers of
// "what did the user type" cannot drift.
//
// The trailer starts at the first section marker we control. Anything before it is what the
// user actually typed. `src/shared/appended-prompt-blocks.ts` holds the regex form the rewind
// path uses; these literal markers are the allocator's list, kept verbatim so the allocator's
// behaviour is unchanged byte for byte.

import { FRACTAL_DOCTRINE_MARKER } from "./appended-prompt-blocks.js";

/** Where our injected trailer starts, in the order the markers are tried. */
export const APPENDED_SECTION_MARKERS: readonly string[] = [
  "\n\n---\n\n**After your reply, append",
  "\n\n---\n\n**After your reply",
  // FORK 2026-10-09 (Fractal v2, charter C4): new prompts open the doctrine with a neutral marker.
  `\n\n---\n\n${FRACTAL_DOCTRINE_MARKER}`,
  "🌿 FRACTAL",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
];

/** The user's own request, trimmed, with our standard injected trailer removed. */
export function userTaskText(prompt: string | undefined): string {
  let text = prompt ?? "";
  for (const marker of APPENDED_SECTION_MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0) {
      text = text.slice(0, at);
    }
  }
  return text.trim();
}
