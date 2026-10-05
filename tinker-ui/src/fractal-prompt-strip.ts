// Pure, DOM-free helper: cut the injected FRACTAL doctrine off a user turn.
//
// FORK 2026-09-07 (the architect: "a nonesense-bubble as if I was prompting in strange html").
//
// The reflection doctrine is APPENDED to every prompt the architect types — his `keep going`
// became a 22,548-character user turn. app.ts hides a fractal prompt at six separate sites, and
// every one of them tests for the literal `# FRACTAL REFLECTION`. The injected doctrine has never
// contained that string: the template's own heading is `# FRACTAL — the slow thinker`, and
// `grep -c 'FRACTAL REFLECTION'` over it returns 0. Producer and consumer drifted apart when the
// template was retitled, and nothing failed loudly — the block simply painted, inside the user's
// own bubble, carrying the angle-bracket placeholders that read as stray HTML
// (`<details>`, `<dir>`, `<slug>`, `<commit>`, `<a distinctive phrase from the reply>`).
//
// Hiding the whole message — what those six sites do — is the wrong remedy now: the doctrine is
// appended to what the human actually wrote, so it would take his words with it. The boundary is
// the cut, and it is anchored on the marker the SERVER already uses to find the same seam
// (`src/agents/effort-allocator.ts:244`, `"\n\n---\n\n**After your reply, append"`).

/** The stable half of the server's injection seam. Kept deliberately narrow: the words alone are
 *  ordinary English, so the `**` bold opener is what makes this a marker rather than a phrase. */
export const FRACTAL_DOCTRINE_MARKER = "**After your reply, append";

/**
 * The text with the appended doctrine removed, trimmed of the separator that introduced it.
 * Returns the input unchanged when no doctrine is present, and "" when the text is nothing but
 * doctrine — which lets a caller hide the bubble entirely rather than paint an empty one.
 */
export function stripInjectedFractalDoctrine(text: string): string {
  if (!text) {
    return text;
  }
  const at = text.indexOf(FRACTAL_DOCTRINE_MARKER);
  if (at < 0) {
    return text;
  }
  // Drop a trailing horizontal rule that exists only to introduce the doctrine. The server writes
  // "\n\n---\n\n", but the separator has varied, so this tolerates spacing rather than demanding it.
  const head = text.slice(0, at).replace(/\n+\s*-{3,}\s*\n*\s*$/, "");
  return head.trim();
}

/**
 * FORK 2026-09-07 — the SAME drift, one branch away.
 *
 * After a gateway restart, main-session-restart-recovery injects a resume prompt as a role:"user"
 * message, so it wears the architect's bubble. app.ts already meant to catch that and paint it as
 * an orange centered notice — but it tested `userText.startsWith("⚠️ Gateway restarted")`, and the
 * text actually injected is:
 *
 *   [Mon 2026-09-07 15:39 GMT+2] [System] The gateway restarted and interrupted your previous
 *   turn. Resume it, and make the resume legible to the user: 1. ORIENT FIRST — ...
 *
 * A timestamp prefix and different wording, so the branch never fired and ~1,400 characters of the
 * agent instructing itself rendered as something the architect apparently typed. Measured on the
 * 2026-09-07 15:38 restart: the ClawHub tab got it twice inside 41 seconds.
 *
 * Matched on the sentence rather than the line start, because the timestamp prefix is added by a
 * different layer and will keep moving.
 */
const GATEWAY_RESTART_RESUME_RE =
  /(?:⚠️?\s*Gateway restarted|\[System\]\s*The gateway restarted|The gateway restarted and interrupted your previous turn)/i;

export function isGatewayRestartResume(text: string): boolean {
  return Boolean(text) && GATEWAY_RESTART_RESUME_RE.test(text);
}
