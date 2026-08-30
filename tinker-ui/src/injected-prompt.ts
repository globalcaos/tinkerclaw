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
      return {
        visible: raw.slice(0, cut.index).trim(),
        injected: block,
        kind: hit.kind,
        label: hit.label,
      };
    }
  }
  return null;
}
