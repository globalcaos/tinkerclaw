/**
 * FORK 2026-05-24 (fourth pass) — shared fortune-cookie phrase pool.
 *
 * Bug task-mpjhzu3j-ma9ts ("Tabs behavior" part 1): the burned-in name
 * for every non-main session. The data lives in ./fortune-cookies.json
 * — 218 curated poetic greetings with emoji, all client-curated, used
 * for tab.title at addTab() / /clear AND for the server-side lazy-mint
 * at sessions.list.
 *
 * Single source of truth. Both client (`tinker-ui/src/app.ts`) and
 * server (`src/gateway/session-cookie-phrase.ts`) import from here.
 * Adding/removing phrases means editing the JSON; both sides pick up
 * the change at the next build.
 *
 * See bible session-naming.md for the full naming contract.
 */
import data from "./fortune-cookies.json" with { type: "json" };

export const FORTUNE_COOKIES: readonly string[] = data;

export function randomFortune(): string {
  if (FORTUNE_COOKIES.length === 0) return "(no fortune)";
  return FORTUNE_COOKIES[Math.floor(Math.random() * FORTUNE_COOKIES.length)];
}

/**
 * Deterministic phrase picker: the SAME sessionKey always maps to the
 * SAME phrase from FORTUNE_COOKIES. Used by both the client
 * (`tinker-ui/src/app.ts` createTab) and the server
 * (`src/gateway/session-cookie-phrase.ts` generateCookiePhrase via the
 * lazy-mint path) so that the client-side tab.title and the
 * server-side cookiePhrase converge automatically for any given key —
 * no patches, no race, no divergence on tab close.
 *
 * Bug 2026-05-25: previously both sides called randomFortune()
 * independently and got DIFFERENT phrases for the same key. The tab
 * showed phrase X while the session row in the side panel showed
 * phrase Y the moment the tab closed (tab.title fell out of the
 * priority chain, exposing the server's cookiePhrase). With
 * fortuneForKey, X === Y by construction.
 *
 * Hash: FNV-1a (32-bit, unseeded, well-distributed for short ASCII
 * strings — sessionKey tokens are exactly this).
 */
export function fortuneForKey(key: string): string {
  if (FORTUNE_COOKIES.length === 0) return "(no fortune)";
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return FORTUNE_COOKIES[h % FORTUNE_COOKIES.length];
}
