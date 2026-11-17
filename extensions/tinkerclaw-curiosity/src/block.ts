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

/** Who the sense serves and what they are working towards. All optional: a fresh clone has neither. */
export type CuriosityOptions = {
  /** The principal's name. Default "your principal". */
  principal?: string;
  /** The principal's objectives, already cut to size by readProfile. Empty = no bridge rule. */
  objectives?: string;
  objectivesPath?: string;
};

export function buildCuriosityBlock(
  profile: string,
  path: string,
  opts: CuriosityOptions = {},
): string {
  const who = opts.principal?.trim() || "your principal";
  const objectives = opts.objectives?.trim() ?? "";
  const map = profile.trim()
    ? profile.trim()
    : "(empty: find out what they are most passionate about, one question at a time, and start the file)";
  const bridge = objectives
    ? [
        `4. The bridge. A passion is also where ${who}'s best projects come from: a wish for something that does not exist yet, met by a technology that just became possible. When the turn is calm, put one seed in the ${DEEPER_MARKER} section that links the passion to the objectives below: something they could build, own or earn from. One line, at most once per thread, offered and never pushed. Do not criticise the seed in the same breath; an idea starts unfinished and grows across turns. Keep their original wish fixed when you develop it, and let them be the last judge: a project that bores them is a bad project whatever it scores.`,
        "5. Keep the thread. When a passion runs over several turns, it climbs a ladder: data, pattern, leap, market, goal. End each turn on the next rung (one line) instead of closing the topic.",
      ]
    : [];
  const n = bridge.length;
  return [
    "## Curiosity sense: their passions",
    "",
    `You learn what ${who} is passionate about and, when one of those subjects comes up, you go further than the task.`,
    "",
    "On a turn that touches one of the passions below, or something that looks like a new one:",
    "1. Do what they asked first, fully. The extra never replaces the work.",
    `2. Then add a section that starts with the line \`${DEEPER_MARKER}\`, after the answer and before the closing summary card. The chat draws it as its own bubble with a yellow border. Put in it, at most:`,
    "   - one or two things you found for this turn: look them up now (a web search, a paper, a source you read), new to them, pitched at their level, each with its link;",
    "   - one teaching step: the next idea in the field, built on what they already know;",
    "   - one deep question that helps you understand exactly what they love about it. One question, not a list.",
    "3. Leave the section out when the turn is routine, when you have nothing new, or when they are in the middle of a problem. Never pad, never repeat what the map already lists as taught.",
    ...bridge,
    `${4 + n}. When they answer one of your questions or show a new interest, update the passion map in the same turn: \`${path}\`. Record what drives them, how deep they already are, and what you taught.`,
    `${5 + n}. Tinker chat only. On WhatsApp or any other channel, no ${DEEPER_MARKER} section.`,
    "",
    `### The passion map (\`${path}\`)`,
    "",
    map,
    ...(objectives
      ? [
          "",
          `### What ${who} is working towards (\`${opts.objectivesPath ?? "objectives"}\`)`,
          "",
          objectives,
        ]
      : []),
  ].join("\n");
}

/** The block for this session, or undefined when the sense does not apply to it. */
export function curiosityContextFor(
  sessionKey: string | undefined,
  o: { sessionPrefix: string; profile: string; profilePath: string } & CuriosityOptions,
): string | undefined {
  if (!sessionKey || !sessionKey.startsWith(o.sessionPrefix)) return undefined;
  return buildCuriosityBlock(o.profile, o.profilePath, o);
}
