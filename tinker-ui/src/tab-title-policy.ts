// FORK 2026-09-15 (the architect: "if I rename manually one tab, it should not change magically
// later") — u7-tab-naming. A tab's name has exactly one of three ORIGINS, and the origin, not
// the string, decides whether the turn-end auto-titler may touch it:
//
//   fortune — the deterministic cookie phrase minted at creation / `/clear` / server sync.
//             A placeholder. Name it at the FIRST prompt, and keep retrying on every
//             turn-end while it still wears the cookie (a missed turn-1 window used to
//             leave it unnamed until turn 5 or forever).
//   auto    — a model-generated title. Re-ask every TAB_TITLE_INTERVAL turns, but the
//             answer only lands if the SUBJECT shifted (the model is handed the current
//             title and told to return it verbatim otherwise; an unchanged answer is a
//             no-op — see `sameSubject`).
//   manual  — typed by the user. NEVER touched automatically. Only the right-click
//             "Auto-name" action moves it back to `auto`, after which refreshing resumes.
//
// Before this the single boolean `titleLocked` covered both auto and manual, so the trigger
// could not tell a hand-typed name from a generated one and renamed both every 5 turns.
// `titleLocked` stays: it is the "never let loadSessions() clobber this" bit, and both
// auto and manual keep it set. `titleKind` answers a different question — WHO named it.
//
// Pure helpers only (no DOM, no app state) so they run under the tinker-ui vitest project.

export type TitleKind = "fortune" | "auto" | "manual";

export type TitleKindSource = {
  titleKind?: TitleKind;
  titleLocked?: boolean;
  title?: string;
};

/**
 * Resolve the effective kind of a tab, including tabs persisted BEFORE `titleKind`
 * existed. The migration is deliberately conservative: a locked legacy title is
 * treated as MANUAL (the state that must never be clobbered) unless it visibly
 * carries the auto-name sentinel icon. Misreading auto as manual only pauses the
 * refresh until the user hits "Auto-name"; misreading manual as auto is the bug
 * this module exists to stop.
 */
export function resolveTitleKind(tab: TitleKindSource, autoIcon: string): TitleKind {
  if (tab.titleKind === "fortune" || tab.titleKind === "auto" || tab.titleKind === "manual") {
    return tab.titleKind;
  }
  if (!tab.titleLocked) {
    return "fortune";
  }
  const title = (tab.title ?? "").trim();
  return autoIcon && title.startsWith(autoIcon) ? "auto" : "manual";
}

export type TurnEndTitleInput = {
  kind: TitleKind;
  /** Number of USER turns in the tab after this assistant turn ended. */
  tabTurns: number;
  /** The tab still shows exactly the deterministic cookie phrase for its key. */
  wearsDefaultName: boolean;
  /** TAB_TITLE_INTERVAL — refresh cadence for auto names. */
  interval: number;
};

/**
 * The turn-end trigger rule. Returns the reason the titler should run, or null.
 *   fortune → "first" at turn 1, or "retry" on any later turn while still on the cookie.
 *   auto    → "refresh" every `interval` turns.
 *   manual  → never.
 */
export function turnEndTitleAction(input: TurnEndTitleInput): "first" | "retry" | "refresh" | null {
  const { kind, tabTurns, wearsDefaultName, interval } = input;
  if (kind === "manual") {
    return null;
  }
  if (kind === "fortune") {
    if (tabTurns === 1) {
      return "first";
    }
    if (wearsDefaultName) {
      return "retry";
    }
    // A fortune tab that is NOT wearing its cookie any more is a legacy/edge state
    // (e.g. a server phrase adopted without a kind). Treat it like the cookie: name it.
    return tabTurns > 0 ? "retry" : null;
  }
  // auto
  if (interval > 0 && tabTurns > 0 && tabTurns % interval === 0) {
    return "refresh";
  }
  return null;
}

/**
 * Strip a leading emoji/symbol cluster and normalise for comparison. Kept regex-only
 * (no Intl segmenter) so it is cheap and deterministic in tests. Mirrors what the
 * app's `leadingEmoji` splits off, generously: any run of non-letter/non-digit
 * symbols at the start, plus surrounding whitespace.
 */
export function titleWords(title: string): string {
  return (title ?? "")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[\s ]+/g, " ")
    .replace(/[.!?…]+$/u, "")
    .trim()
    .toLowerCase();
}

/**
 * Did the model say "same subject"? True when the proposed title's words equal the
 * current title's words (emoji, case, whitespace and trailing punctuation ignored).
 * Also true for an empty proposal — nothing to rename to.
 */
export function sameSubject(
  currentTitle: string,
  proposedTitle: string | null | undefined,
): boolean {
  const proposed = titleWords(proposedTitle ?? "");
  if (!proposed) {
    return true;
  }
  return proposed === titleWords(currentTitle);
}

/**
 * The extra instruction handed to the title model on an AUTO refresh: anchor on the
 * current name, and only move when the subject genuinely moved.
 */
export function refreshAnchorInstruction(currentTitle: string): string {
  const words = titleWords(currentTitle);
  const shown = words || currentTitle.trim();
  return [
    `This tab is currently named "${shown}".`,
    `If my messages below are still about that same subject, reply with EXACTLY that current name (you may keep or change only its emoji).`,
    `Propose a different name ONLY if the subject of my recent messages has genuinely shifted to something the current name no longer describes.`,
  ].join(" ");
}
