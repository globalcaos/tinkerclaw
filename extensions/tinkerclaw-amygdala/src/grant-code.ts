/**
 * The owner's one-click release of a held step (2026-10-29: copying a confirmation code into the chat was slow;
 * a button under the reply now sends the same words). A proof hold carries a short code derived from the step's goal
 * fingerprint, so a retry of the same step (rephrased or not) maps to the same code. The release is the owner's own
 * message containing `allow <code>`: the page's Allow button sends exactly that as his prompt, the same evidence the
 * AEGIS hard rules already accept for `allow AEGIS-…`. An agent cannot put words in the owner's prompt.
 */

/** `JEV-` and six base-36 characters from the goal fingerprint (a hex digest). */
export function proofGrantCode(goalFp: string): string {
  const n = Number.parseInt(goalFp.slice(0, 10), 16);
  const body = (Number.isFinite(n) ? n : 0).toString(36).toUpperCase().padStart(6, "0").slice(-6);
  return `JEV-${body}`;
}

/** The owner's request says `allow <code>` (any case, as a whole word). */
export function requestAllows(request: string | null | undefined, code: string): boolean {
  if (!request || !code) return false;
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\ballow\\s+${esc}\\b`, "i").test(request);
}
