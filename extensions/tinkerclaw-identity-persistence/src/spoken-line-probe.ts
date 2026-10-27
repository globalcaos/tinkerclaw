/**
 * J4 Level 1, first marker: the spoken line (gap note J4 §4.1 and §8 action 1).
 *
 * Every persona correction the owner gave since 08-31 names a discrete, checkable marker, and the
 * first of them is the spoken line: `**<Name>:** *…*` in every home-chat answer, the shape the
 * Tinker UI paints purple (tinker-ui/src/app.ts renderMarkdown: `**Name:**`, spaces, then an
 * italic opener; the name case-insensitive; anywhere in the text). A regex finds it at no cost and
 * with no judge, so each finished answer writes one `j.cortex.probe` row: label `spoken-line`,
 * n1 = 1 when the line is there, 0 when it is missing.
 *
 * Scope, so a row means what it says:
 * - only when the persona file itself names the marker (it contains `**<Name>:**`): a persona
 *   without that convention gets no rows, not a 0% pass rate it never promised;
 * - only typed home-chat turns: session `agent:<id>:main` or `agent:<id>:tinker:…`, trigger `user`
 *   (or none recorded), never a background Fractal run (`fractal-*`);
 * - only finished answers: a turn with no text (it ended on a tool call), or only NO_REPLY /
 *   HEARTBEAT_OK, has nothing to judge.
 */

import { emitEvent } from "openclaw/plugin-sdk/fork-telemetry";

export const SPOKEN_LINE_PROBE_ID = "spoken-line";

const HOME_CHAT_SESSION = /^agent:[^:]+:(?:main$|tinker:)/;
const SILENT_REPLIES: ReadonlySet<string> = new Set(["NO_REPLY", "HEARTBEAT_OK"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The persona declares the marker when its own text carries `**<Name>:**`. */
export function personaDeclaresSpokenLine(personaText: string, name: string): boolean {
  return personaText.toLowerCase().includes(`**${name.toLowerCase()}:**`);
}

/**
 * The UI's purple test on raw text: `**Name:**`, spaces or tabs, then a single `*` that opens
 * italics. A line break before the italics, or bold instead of italics, does not paint.
 */
export function hasSpokenLine(text: string, name: string): boolean {
  return new RegExp(String.raw`\*\*${escapeRegExp(name)}:\*\*[ \t]*\*(?!\*)`, "i").test(text);
}

/**
 * Checks one finished answer and writes its row. Returns the score written, or null when the turn
 * is out of scope and nothing was written.
 */
export function probeSpokenLine(params: {
  readonly assistantTexts: readonly string[] | undefined;
  readonly name: string;
  readonly context: { sessionKey?: string; runId?: string; trigger?: string };
}): 0 | 1 | null {
  const { sessionKey, runId, trigger } = params.context;
  if (!sessionKey || !HOME_CHAT_SESSION.test(sessionKey)) {
    return null;
  }
  if ((trigger !== undefined && trigger !== "user") || runId?.startsWith("fractal-")) {
    return null;
  }
  const text = (params.assistantTexts ?? []).join("\n\n").trim();
  if (!text || SILENT_REPLIES.has(text)) {
    return null;
  }
  const score = hasSpokenLine(text, params.name) ? 1 : 0;
  emitEvent("j.cortex.probe", {
    label: SPOKEN_LINE_PROBE_ID,
    n1: score,
    sessionKey,
    runId: runId ?? null,
  });
  return score;
}
