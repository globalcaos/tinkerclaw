/**
 * FORK 2026-10-02 (the owner: "Fix the moral code to be injected, in full, at the creation and after
 * compaction"). How the SessionStart hook cuts the pack into parts the claude CLI delivers whole.
 *
 * WHY. The CLI replaces any hook additionalContext over 10,000 chars with a ~2,000-char preview and a
 * file path (CLI 2.1.287: `L3o=1e4`, applied to each hook's additionalContext separately). The pack
 * is ~40k chars, so the model got its first 2 KB and a path: no closing tag, most rules never seen.
 * One hook slot per part (hooks.json registers PART_SLOTS of them), each part under the cap.
 *
 * WHAT A PART IS. A complete block on its own — the published opening marker, a label line, a run of
 * the pack's text, the closing tag — so it reads as the moral code wherever it lands: the CLI gathers
 * hook outputs as each process finishes, in any order, and the label says where a part goes. The
 * parts' texts, in order, are the pack's inner text byte for byte: this file decides HOW the pack is
 * carried, never WHAT it says (src/moral-code/contract.ts owns the pack, its marker and the parser of
 * this label, MORAL_CODE_PART_LABEL; delivery-parts.test.ts runs this hook to keep the two in step).
 *
 * WHERE IT CUTS. Before a `#` or `##` heading, so a part opens on a section; a section bigger than a
 * part at its blank lines, then at its lines, and only a single line longer than a part mid-line.
 * No dependencies, by design: this runs on every new session and every compaction.
 */

/** The pack's published opening marker (src/moral-code/contract.ts MORAL_CODE_MARKER). */
export const MORAL_CODE_MARKER = '<moral_code source="tinkerclaw">';
/** Its closing tag (contract.ts MORAL_CODE_CLOSE). */
export const MORAL_CODE_CLOSE = "</moral_code>";
/** One part, wrapper and label included, stays under this: the CLI's cap is 10,000 chars. */
export const PART_MAX_CHARS = 9_500;
/** Hook slots hooks.json registers, one part each: room for ~94k chars, the pack is ~40k. */
export const PART_SLOTS = 10;

/** The label line of part i of n (contract.ts MORAL_CODE_PART_LABEL parses it). */
export function partLabel(i, n) {
  return `[moral code, part ${i} of ${n}]`;
}

/** Part i of n, as delivered: marker, label, the part's text, closing tag. */
export function wrapPart(i, n, body) {
  return `${MORAL_CODE_MARKER}\n${partLabel(i, n)}\n${body}${MORAL_CODE_CLOSE}`;
}

/** Cut `text` just before every match of `re` (a heading line), keeping every character. */
function cutBefore(text, re) {
  const out = [];
  let from = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > from) {
      out.push(text.slice(from, m.index));
      from = m.index;
    }
  }
  out.push(text.slice(from));
  return out;
}

/** Cut `text` just after every match of `re` (a blank-line run, a newline), keeping every character. */
function cutAfter(text, re) {
  const out = [];
  let from = 0;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (end > from && end < text.length) {
      out.push(text.slice(from, end));
      from = end;
    }
  }
  out.push(text.slice(from));
  return out;
}

const CUTS = [
  (t) => cutBefore(t, /^#{1,2} /gm),
  (t) => cutAfter(t, /\n{2,}/g),
  (t) => cutAfter(t, /\n/g),
];

/** `text` as pieces of at most `budget` chars, cut at the coarsest boundary that works. */
function pieces(text, budget, level = 0) {
  if (text.length <= budget) {
    return [text];
  }
  if (level >= CUTS.length) {
    const out = [];
    for (let i = 0; i < text.length; i += budget) {
      out.push(text.slice(i, i + budget));
    }
    return out;
  }
  const segs = CUTS[level](text).filter((s) => s.length > 0);
  if (segs.length <= 1) {
    return pieces(text, budget, level + 1);
  }
  return segs.flatMap((s) => pieces(s, budget, level + 1));
}

/**
 * The pack as delivery parts. Returns the parts as delivered and their bodies (bodies.join("") is the
 * pack's inner text exactly). A pack published without the wrapper is carried whole the same way.
 */
export function splitMoralCode(pack, maxChars = PART_MAX_CHARS) {
  const wrapped = pack.startsWith(MORAL_CODE_MARKER) && pack.endsWith(MORAL_CODE_CLOSE);
  const inner = wrapped
    ? pack.slice(MORAL_CODE_MARKER.length, pack.length - MORAL_CODE_CLOSE.length)
    : pack;
  // The wrapper of a two-digit part number: every part below is measured against the worst case.
  const budget = maxChars - wrapPart(99, 99, "").length;
  const atoms = pieces(inner, budget);
  const bodies = [];
  let cur = [];
  let len = 0;
  for (const atom of atoms) {
    if (len + atom.length > budget && cur.length > 0) {
      // A `#` heading with nothing of its section after it moves on with its section, when it fits.
      let carry = [];
      while (cur.length > 1 && /^# [^\n]*\n+$/.test(cur[cur.length - 1])) {
        carry.unshift(cur.pop());
      }
      const carried = carry.reduce((a, s) => a + s.length, 0);
      if (carried + atom.length > budget) {
        cur.push(...carry);
        carry = [];
      }
      bodies.push(cur.join(""));
      cur = carry;
      len = carry.reduce((a, s) => a + s.length, 0);
    }
    cur.push(atom);
    len += atom.length;
  }
  if (cur.length > 0) {
    bodies.push(cur.join(""));
  }
  const n = bodies.length;
  return { bodies, parts: bodies.map((b, i) => wrapPart(i + 1, n, b)) };
}
