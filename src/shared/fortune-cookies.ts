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
