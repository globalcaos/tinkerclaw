/**
 * FORK 2026-05-24 (fourth pass) — Fortune-cookie session-name generator.
 *
 * Bug task-mpjhzu3j-ma9ts ("Tabs behavior" part 1). The history:
 *
 *   1st pass (cb0a6b4e1e) — invented a server-side 2-word generator
 *      (adjective × noun, "ivory anvil"). Wrong shape; the user already
 *      had FORTUNE_COOKIES curated client-side.
 *   2nd pass (000c7a0b7d) — deleted the 2-word generator. Made
 *      cookiePhrase storage-only; client patched via sessions.patch.
 *   3rd pass (69f31f6e87) — client walked ALL sessions and patched
 *      missing ones. But all patches were rejected: the server's
 *      `rejectWebchatSessionMutation` guard blocks sessions.patch from
 *      webchat clients by design.
 *   4th pass (this file) — server-side lazy-mint, drawing from the
 *      same FORTUNE_COOKIES pool the client uses (shared via
 *      src/shared/fortune-cookies.ts). The output shape matches what
 *      the client mints at addTab, so the side-panel resolution chain
 *      converges automatically. No client-side patches needed.
 *
 * See bible session-naming.md for the full contract.
 */

import { randomFortune } from "../shared/fortune-cookies.js";

/**
 * Generate one fortune-cookie phrase. Optional `taken` set lets the
 * caller pre-empt collisions by passing in phrases already in use —
 * with 218 fortunes in the pool, collisions are unlikely but the
 * collision-retry path makes them deterministic when they do happen.
 *
 * NOTE: with 218 phrases, the birthday-paradox 50% collision threshold
 * is at ~17 sessions. For a user with 150+ sessions, collisions are
 * EXPECTED — they're not bugs. Each session still gets a meaningful
 * phrase; uniqueness is best-effort, not invariant.
 */
const MAX_RETRIES = 8;

export function generateCookiePhrase(taken?: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const phrase = randomFortune();
    if (!taken || !taken.has(phrase)) {
      return phrase;
    }
  }
  // After MAX_RETRIES the pool is genuinely depleted (or close). Accept
  // a duplicate rather than block the mint. The session still gets a
  // meaningful name; in practice the user won't notice unless they have
  // 218+ sessions AND happen to compare two with the same phrase.
  return randomFortune();
}

/**
 * Convenience for the lazy-mint site: collects all phrases already in
 * a session store into a Set so the caller can pass it into
 * generateCookiePhrase.
 */
export function collectExistingPhrases(
  store: Record<string, { cookiePhrase?: string | null }>,
): Set<string> {
  const taken = new Set<string>();
  for (const entry of Object.values(store)) {
    if (typeof entry?.cookiePhrase === "string" && entry.cookiePhrase.trim()) {
      taken.add(entry.cookiePhrase.trim());
    }
  }
  return taken;
}

/**
 * Detect the legacy 2-word shape (`"ivory anvil"`) from the WRONG first
 * pass. Used by the server lazy-mint to identify entries that need
 * re-minting — a session.json with `cookiePhrase: "ivory anvil"` from
 * the first pass should be replaced with a proper FORTUNE_COOKIES entry
 * on next sessions.list.
 */
const LEGACY_2WORD_RE = /^[a-z]+ [a-z]+( \d{2})?$/;
export function isLegacy2WordPhrase(value: string | undefined): boolean {
  return Boolean(value && LEGACY_2WORD_RE.test(value.trim()));
}
