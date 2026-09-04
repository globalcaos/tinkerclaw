// FORK 2026-08-28 (the architect: "sometimes, upon what I can assume was the use of a recipe, the
// whole text of the recipe was shown as if it was one of my prompts. This is a bug").
//
// WHAT THIS IS. Several subsystems APPEND a block of instructions-to-the-model to the architect's
// typed text before it is sent (the fractal doctrine, the morning briefing, a matched BROCA recipe).
// The gateway persists the resulting string as the USER turn — that is what was actually sent — so
// after a reload the chat had no way to tell the two apart and rendered the whole thing as the
// human's own bubble.
//
// Measured on the live transcripts (~/.openclaw/agents/main/sessions, 2026-08-01 → 08-28, 1114
// sessions): the architect's turn of 2026-08-28 12:06 was two typed lines and is stored as 15,747
// characters — his words plus the entire fractal doctrine. 697 further user turns carry a large
// appended block that matched NO sentinel at all.
//
// THE DEFECT this module replaces: app.ts's `reconstructInjectionFields` recognised an injection by
// testing the text against FOUR hard-coded sentence fragments. That is an allowlist, so it is wrong
// by construction — every injector not on the list (a recipe among them) wears the human's voice.
// Here the split is decided STRUCTURALLY: find the `---` rule that separates typed text from an
// appended block, then classify the block by what it *is*. Known sentinels remain, but only as
// labels, never as the admission test.
//
// THE ONE RULE THAT OUTRANKS COVERAGE: never mislabel a human. Folding a machine block the chat used
// to show is a visible improvement; folding a paragraph the architect actually typed is a
// regression worse than the bug. Every heuristic below is therefore biased to return null when
// unsure, and folding is non-destructive anyway — app.ts renders the block behind a labelled toggle,
// it never discards it.
//
// Kept pure and DOM-free so it is unit-testable; app.ts owns the markup.
// Sibling of ./system-notice.ts, which classifies a WHOLE user turn that the gateway injected.

export type InjectedKind = "briefing" | "fractal" | "recipe" | "system" | "directive";

export interface InjectedSplit {
  /** What the human actually typed — the only thing that belongs in their bubble. May be "". */
  visible: string;
  /** The machine-appended block, verbatim. Never empty when a split is returned. */
  injected: string;
  kind: InjectedKind;
  /** Human-facing label for the fold, e.g. "recipe instructions". */
  label: string;
  /** When kind is recipe, the matched kit's title — from `<active_recipe title="…">`. */
  recipeTitle?: string;
  /** Absolute path of the matched recipe.md — from `<active_recipe path="…">`. */
  recipePath?: string;
}

export type SkillNotice = { name: string; path: string; source: "read" | "skill" };

/** The matcher writes this tag into the appended block. Title + path survive a reload; the trail event does not. */
const ACTIVE_RECIPE_TAG = /<active_recipe\b([^>]*)>/i;

function attr(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  if (m) return decodeXml(m[1]);
  const s = attrs.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"));
  return s ? decodeXml(s[1]) : "";
}

function decodeXml(s: string): string {
  return s
    .replace(/\u0026quot;/g, '"')
    .replace(/\u0026lt;/g, "<")
    .replace(/\u0026gt;/g, ">")
    .replace(/\u0026amp;/g, "&");
}

/** Pull title + path off a recipe injection so the chat chip can be reconstructed after a reload. */
export function recipeNoticeFromInjected(injected: string): { title: string; path: string } | null {
  const m = injected.match(ACTIVE_RECIPE_TAG);
  if (!m) return null;
  const title = attr(m[1], "title");
  const path = attr(m[1], "path");
  if (title && path) return { title, path };
  const kits = attr(m[1], "kits");
  const slug = (kits.split(",")[0] ?? "").replace(/^.*\//, "").trim();
  if (!slug) return title || path ? { title: title || slug, path } : null;
  return {
    title: title || slug,
    path: path || `~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes/${slug}/recipe.md`,
  };
}

/** The harness prints this as the first line of a skill body (and, on some harnesses, the tool result). */
const SKILL_BASE_DIR_RE = /^\s*Base directory for this skill:\s*(.+?)\s*$/m;

/**
 * FORK 2026-09-02 — the third structural producer, and on Claude Code the only one that carries
 * the real path. After a `Skill` tool call the harness injects the skill's whole body as a
 * USER-role turn whose first line is `Base directory for this skill: <dir>`. Rendered naively
 * that turn paints as one of the architect's own bubbles (his 13:45 note: "I can see the recipe
 * itself, which is not correct"). It is machine-authored: fold it into the chip.
 *
 * Name: `<plugin>:<skill>` when the dir sits in a plugin cache
 * (`…/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>`), else the dir's last segment.
 */
export function skillNoticeFromInjectedBody(raw: unknown): SkillNotice | null {
  if (typeof raw !== "string" || !raw) return null;
  const firstLine = raw.trimStart().split("\n", 1)[0] ?? "";
  const m = firstLine.match(SKILL_BASE_DIR_RE);
  if (!m) return null;
  const dir = m[1].replace(/[\\/]+$/, "");
  const seg = dir.split(/[\\/]/);
  const skill = seg[seg.length - 1] ?? "";
  if (!skill) return null;
  const plugin = dir.match(
    /[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/]([^\\/]+)[\\/][^\\/]+[\\/]skills[\\/][^\\/]+$/,
  );
  const name = plugin ? `${plugin[1]}:${skill}` : skill;
  return { name, path: `${dir}/SKILL.md`, source: "skill" };
}

/**
 * Two structural producers for the skill chip, and only these two — never regex skill names out
 * of prose. Which skill applies is judgment; announcing that it was used is consistency (#22).
 *
 * 1. `read` (or equivalent) of …/skills/<name>/SKILL.md → `source: "read"`.
 * 2. The harness's own `Skill` tool (`input.skill`) → `source: "skill"`. Its path is read off
 *    the tool RESULT's "Base directory for this skill:" line (plugin-cache skills live under a
 *    versioned dir the UI cannot guess); without a result it falls back to the workspace skills
 *    dir, stripping any `plugin:` prefix. FORK 2026-09-02 — the architect saw the plain narration
 *    row and the whole skill body; he wants the icon, the outline, and a click-to-open link.
 */
export function skillNoticeFromTool(
  name: unknown,
  input: unknown,
  resultText?: unknown,
): SkillNotice | null {
  const tool = typeof name === "string" ? name.toLowerCase() : "";
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (tool === "skill") {
    const skill = typeof rec.skill === "string" ? rec.skill.trim() : "";
    if (!skill) return null;
    const base =
      typeof resultText === "string" ? resultText.match(SKILL_BASE_DIR_RE)?.[1] : undefined;
    // No base-directory line → no chip here. Claude Code's tool result is only "Launching
    // skill: …"; the body (and the real path) arrives as the NEXT user-role turn, which
    // `skillNoticeFromInjectedBody` owns. A guessed workspace path would be a confidently
    // wrong link for every plugin-cache skill — worse than no chip (same call as §5.8N).
    if (!base) return null;
    return { name: skill, path: `${base.replace(/[\\/]+$/, "")}/SKILL.md`, source: "skill" };
  }
  if (tool !== "read" && tool !== "read_file" && tool !== "view") return null;
  const raw = rec.path ?? rec.file_path ?? rec.filePath ?? rec.target;
  if (typeof raw !== "string" || !raw) return null;
  const path = raw.trim();
  const m = path.match(/(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i);
  if (!m) return null;
  return { name: m[1], path, source: "read" };
}

/**
 * The separator every injector writes between the typed text and its block.
 *
 * Matched leniently (`\n---\n` with optional surrounding blank lines / trailing spaces) because the
 * persistence layer is known to collapse `\n\n---\n\n` — the strict form missed real turns, which is
 * documented at the original briefing-detection site.
 */
const SEPARATOR = /\n[ \t]*-{3,}[ \t]*\n/g;

/** Below this, an appended block is a sign-off or a stray rule, not a doctrine. */
const MIN_DIRECTIVE_CHARS = 600;

/** Sentinels are LABELS here, not the admission test — see the header. */
const BRIEFING = [
  "Execute the morning briefing NOW",
  "Read and follow whichever of these briefing files exists",
];
const FRACTAL = [
  "Structure this turn's reply as labelled sections",
  "append a \u{1F33F} FRACTAL reflection section",
  "FRACTAL reflection section",
];
const RECIPE_PATTERNS = [
  /<active_recipe\b/,
  /\bkind:\s*["']?(?:kit|recipe)\/1\.0/,
  /^\s*#{1,3}\s*RECIPE\b/im,
  /\bBROCA recipe\b/i,
  /^\s*doneWhen:/m,
  /^\s*parallelism:\s*$/m,
];

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

/**
 * Is this block addressed to the MODEL rather than written by the human?
 *
 * Deliberately demanding: a block only qualifies as a generic directive when it is long AND
 * structured as a document AND speaks to the model in the second person. Any one of those alone is
 * something the architect writes all the time.
 */
function looksLikeDirectiveBlock(text: string): boolean {
  if (text.length < MIN_DIRECTIVE_CHARS) {
    return false;
  }
  const headings = (text.match(/^#{1,6}\s+\S/gm) ?? []).length;
  if (headings < 2) {
    return false;
  }
  // Second-person instruction to the model. "you are", "you must", "your job", "do not write"…
  return /\b(?:you are|you must|you will|you should|your job|your entire|do not (?:write|report|add))\b/i.test(
    text,
  );
}

function classify(block: string): { kind: InjectedKind; label: string } | null {
  const trimmed = block.trimStart();
  if (hasAny(block, BRIEFING)) {
    return { kind: "briefing", label: "briefing instructions" };
  }
  if (hasAny(block, FRACTAL)) {
    return { kind: "fractal", label: "fractal doctrine" };
  }
  if (RECIPE_PATTERNS.some((r) => r.test(block))) {
    return { kind: "recipe", label: "recipe instructions" };
  }
  if (trimmed.startsWith("[System]")) {
    return { kind: "system", label: "system instructions" };
  }
  if (looksLikeDirectiveBlock(block)) {
    return { kind: "directive", label: "appended instructions" };
  }
  return null;
}

/**
 * Split a stored user turn into the human's text and the machine's appended block.
 *
 * Returns null when the turn is entirely the human's — the ordinary bubble path is then untouched,
 * which is the safe default.
 *
 * Candidate rules are tried LAST-first, so the fold starts as late as possible and the human keeps
 * as much of their own text in their own voice as the evidence allows. That direction is safe
 * because an injected block carries no internal rule of its own: across the live transcripts, all
 * 342 fractal-injected user turns of 2026-08 contain exactly ONE `---`. Were a future injector to
 * embed one, the worst case is a slightly short fold — never a swallowed sentence.
 */
export function splitInjectedPrompt(raw: unknown): InjectedSplit | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  SEPARATOR.lastIndex = 0;
  const cuts: Array<{ index: number; length: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = SEPARATOR.exec(raw)) !== null) {
    cuts.push({ index: m.index, length: m[0].length });
  }
  for (let i = cuts.length - 1; i >= 0; i--) {
    const cut = cuts[i];
    const block = raw.slice(cut.index + cut.length);
    const hit = classify(block);
    if (hit) {
      const notice = hit.kind === "recipe" ? recipeNoticeFromInjected(block) : null;
      return {
        visible: raw.slice(0, cut.index).trim(),
        injected: block,
        kind: hit.kind,
        label: hit.label,
        ...(notice ? { recipeTitle: notice.title, recipePath: notice.path } : {}),
      };
    }
  }
  return null;
}
