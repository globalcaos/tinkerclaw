/**
 * The curiosity sense's turn block: the contract plus the passion map. Pure, so it is tested without a gateway.
 */
import { existsSync, readFileSync } from "node:fs";

export const DEEPER_MARKER = "✨ DEEPER";

/**
 * The part of the map that goes into a turn: the `## For the prompt` section when the file has one, else the whole
 * file, cut at a line boundary below `maxChars`. A missing or unreadable file is an empty map.
 */
export function readProfile(path: string, maxChars: number): string {
  let text: string;
  try {
    if (!existsSync(path)) return "";
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const m = /^##\s+For the prompt\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text);
  const body = (m ? m[1]! : text).trim();
  if (body.length <= maxChars) return body;
  const cut = body.slice(0, maxChars);
  const at = cut.lastIndexOf("\n");
  return `${(at > 0 ? cut.slice(0, at) : cut).trimEnd()}\n…(the rest is in the file)`;
}

export function buildCuriosityBlock(profile: string, path: string): string {
  const map = profile.trim()
    ? profile.trim()
    : "(empty: find out what he is most passionate about, one question at a time, and start the file)";
  return [
    "## Curiosity sense: his passions",
    "",
    "You learn what the architect is passionate about and, when one of those subjects comes up, you go further than the task.",
    "",
    "On a turn that touches one of the passions below, or something that looks like a new one:",
    "1. Do what he asked first, fully. The extra never replaces the work.",
    `2. Then add a section that starts with the line \`${DEEPER_MARKER}\`, after the answer and before the 🌿 FRACTAL block. The chat draws it as its own bubble with a yellow border. Put in it, at most:`,
    "   - one or two things you found for this turn: look them up now (a web search, a paper, a source you read), new to him, pitched at his level, each with its link;",
    "   - one teaching step: the next idea in the field, built on what he already knows;",
    "   - one deep question that helps you understand exactly what he loves about it. One question, not a list.",
    "3. Leave the section out when the turn is routine, when you have nothing new, or when he is in the middle of a problem. Never pad, never repeat what the map already lists as taught.",
    `4. When he answers one of your questions or shows a new interest, update the passion map in the same turn: \`${path}\`. Record what drives him, how deep he already is, and what you taught.`,
    `5. Tinker chat only. On WhatsApp or any other channel, no ${DEEPER_MARKER} section.`,
    "",
    `### The passion map (\`${path}\`)`,
    "",
    map,
  ].join("\n");
}

/** The block for this session, or undefined when the sense does not apply to it. */
export function curiosityContextFor(
  sessionKey: string | undefined,
  o: { sessionPrefix: string; profile: string; profilePath: string },
): string | undefined {
  if (!sessionKey || !sessionKey.startsWith(o.sessionPrefix)) return undefined;
  return buildCuriosityBlock(o.profile, o.profilePath);
}
