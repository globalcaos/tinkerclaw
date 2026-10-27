// FORK 2026-10-25 (the architect: "This chat should be linked to zen mail. In fact its icon should replace
// the tab's title and all zen mail requests show here, along with its reasoning"). Zen Mail hands
// every prompt typed on a card to ONE chat: `main_session` in ~/.local/share/zen-mail/settings.json
// (apps/zen-mail/server.py _to_main_chat). That file stays the only record of the link; the page
// reads it through tinker-prod-ui's /zen/ proxy (GET /zen/api/link) and draws the Zen Mail icon in
// place of that tab's title, on the desktop tab bar and in the phone header and dropdown.
//
// Pure module: no DOM, no fetch.

/** An envelope with a bonsai on top: the Zen Mail favicon, on the 24-unit line grid of the phone row. */
export const ZEN_ICON_PATHS =
  '<rect x="4" y="14.5" width="16" height="7" rx="1.3"/><path d="m4.6 15.2 7.4 4 7.4-4"/>' +
  '<path d="M12 14.5c0-1.3-1.4-1.7-1-3.1.3-1.1 1.7-1.4 1.5-2.8"/><path d="M11.3 11.6 8 11.2M11.9 9.6l3.4-.6"/>' +
  '<path d="M4 11.2h6.2a3.1 2.2 0 0 0-6.2 0z"/><path d="M14 9h6.2a3.1 2.2 0 0 0-6.2 0z"/>' +
  '<path d="M9.4 6.3h6.2a3.1 2.4 0 0 0-6.2 0z"/>';

/** The session key Zen Mail sends card prompts to, or "" when it has none. Never throws. */
export function parseZenLink(raw: unknown): string {
  const session = (raw as { session?: unknown } | null)?.session;
  return typeof session === "string" ? session.trim() : "";
}

/** Inner markup of a linked tab's title: the icon, with the real title kept for screen readers. */
export function zenTitleHtml(title: string, escape: (s: string) => string): string {
  return (
    `<svg class="zen-title-icon" viewBox="0 0 24 24" aria-hidden="true">${ZEN_ICON_PATHS}</svg>` +
    `<span class="zen-title-text">${escape(title)}</span>`
  );
}

/** Hover hint for a linked tab: says what the icon means, then the chat's own title. */
export function zenTabHint(title: string): string {
  return title ? `Zen Mail · ${title}` : "Zen Mail";
}
