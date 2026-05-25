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

import { fortuneForKey, randomFortune } from "../shared/fortune-cookies.js";

/**
 * Generate one fortune-cookie phrase.
 *
 * Preferred path (FORK 2026-05-25): pass `sessionKey` so the phrase is
 * picked deterministically by FNV-1a hash. Client (`createTab` at
 * tinker-ui/src/app.ts) and server both use `fortuneForKey(key)` from
 * `src/shared/fortune-cookies.ts`, so the SAME key produces the SAME
 * phrase on both sides — the tab.title the client mints at session
 * creation and the cookiePhrase the server lazy-mints on next
 * sessions.list converge by construction, with no patches and no race.
 *
 * Bug pre-2026-05-25: each side called `randomFortune()` independently
 * and picked a DIFFERENT element. While the tab was open, tab.title
 * (= client's pick) won the side-panel priority chain; the moment the
 * tab closed, the lookup fell through to cookiePhrase (= server's
 * pick) and the displayed phrase flipped. After that the cookiePhrase
 * stayed "stuck" because reopening just spawned another fresh
 * client-side random that still didn't match the persisted server one.
 * Deterministic keying eliminates the divergence at the source.
 *
 * Fallback path (no key): non-deterministic `randomFortune()` with
 * collision retry against `taken`. Used only when the caller doesn't
 * have a sessionKey context — currently no live caller hits this.
 *
 * NOTE on collisions: with 218 phrases, the birthday-paradox 50%
 * collision threshold is at ~17 sessions. For a user with 150+
 * sessions, collisions are EXPECTED — they're not bugs. Each session
 * still gets a meaningful phrase; uniqueness is best-effort.
 */
const MAX_RETRIES = 8;

export function generateCookiePhrase(taken?: ReadonlySet<string>, sessionKey?: string): string {
  if (sessionKey) {
    return fortuneForKey(sessionKey);
  }
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const phrase = randomFortune();
    if (!taken || !taken.has(phrase)) {
      return phrase;
    }
  }
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
