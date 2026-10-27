/**
 * FORK 2026-10-10 (J7 §8.6, plan Phase 1.4): one-tap reactions on the purple spoken line.
 *
 * Over ~620 follow-ups the architect never typed a laugh, so reading his text gives the humour loop no labels. Three small
 * chips under the reply (laughed / neutral / not now) send `limbic.reaction.set`, which writes the outcome on that
 * line's attempt row in the computational-humor store.
 *
 * The line is found exactly as the plugin finds it (`extensions/tinkerclaw-computational-humor/src/spoken-line.ts`
 * `extractSpokenLine`: the last `**<name>:** *…*` of the reply), so the row matches by text.
 */

export const VOICE_REACTIONS = [
  { reaction: "laughed", label: "laughed", title: "It made me laugh" },
  { reaction: "neutral", label: "neutral", title: "Fine, nothing more" },
  { reaction: "not-now", label: "not now", title: "Wrong moment for a joke" },
] as const;

export type VoiceReaction = (typeof VOICE_REACTIONS)[number]["reaction"];

/** The purple line of a reply as the plugin records it (the last one), or undefined. */
export function spokenLineOf(text: string, speaker: string): string | undefined {
  const name = speaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(String.raw`\*\*${name}:\*\*\s*\*([^*\n][^*]*?)\*`, "g");
  const line = [...text.matchAll(re)].at(-1)?.[1]?.trim();
  return line ? line : undefined;
}

/** Key for the taps this page has seen: one chat, one line. */
export function voiceTapKey(sessionKey: string, line: string): string {
  return `${sessionKey}\u0000${line}`;
}

/** The chip row for a line; `selected` marks the tap already given. `esc` escapes for an attribute and for text. */
export function voiceReactionChips(
  line: string,
  selected: VoiceReaction | undefined,
  esc: (s: string) => string,
): string {
  const chips = VOICE_REACTIONS.map((c) => {
    const on = c.reaction === selected;
    return (
      `<button type="button" class="voice-react-chip${on ? " is-on" : ""}" data-reaction="${c.reaction}" ` +
      `aria-pressed="${on}" title="${esc(c.title)}">${esc(c.label)}</button>`
    );
  }).join("");
  return `<div class="voice-react" data-line="${esc(line)}" aria-label="How did the spoken line land?">${chips}</div>`;
}
