/**
 * The memory write gate: one door, in code, in front of an agent's memory notes.
 *
 * FORK 2026-10-25 — WHY CODE. The memory post (thetinkerzone.com, "Why your AI assistant forgets what you told it",
 * chapter "Memories with context avoid misunderstandings") says every note wears its source, and that one gate decides
 * what happens to each new line: new is saved, a repeat is skipped, an update dates the old line, a clash with a rule
 * asks the owner, and someone else's words are kept as a quote only. Until today the only "contradiction gate" was a
 * log line in tinkerclaw-memory-enhancements, notes were written straight to disk with the Write tool, and the nightly
 * job's "probe before you store" was prompt text. This module is the gate. Both doors call it:
 *
 *   - Claude Code workers (chat workers, background reflections, plain Claude Code): the tinkerclaw-core PreToolUse
 *     hook memory-gate-hook.mjs, on Write, Edit and MultiEdit.
 *   - The gateway's embedded runner (crons such as the nightly consolidation, other providers): the
 *     tinkerclaw-memory-enhancements plugin's before_tool_call hook, on write and edit, through
 *     openclaw/plugin-sdk/memory-engram (core re-exports this file from src/memory/engram/write-gate.ts).
 *
 * It lives here, dependency-free, because a Claude Code plugin runs from its own folder (a marketplace install is a copy
 * of this directory and nothing else), so the hook cannot import the repo's TypeScript. This file is the decision and
 * its text outcomes, pure; memory-gate-door.mjs reads the folder and the rule files, applies the outcome and logs it.
 *
 * WHAT A WRITE IS. A Write, Edit or MultiEdit (Claude Code) or a write or edit (embedded runner) whose target sits under
 * a memory root: the Claude Code auto-memory folder and the agent workspace's MEMORY.md and memory/ by default. Files in
 * an excluded folder (archive, the nightly job's own logs) and anything that is not Markdown pass untouched.
 *
 * LABELS AND THEIR ONE OUTCOME. For each write the gate reads the notes in the same folder and the lines of the
 * always-loaded rule files, labels the new lines, and gives the label its fixed outcome:
 *
 *   new             saved; a note's missing `source:`, `date:` and `from:` are stamped into its frontmatter
 *   repeat          skipped: every new line is already in a note (named in the reason)
 *   update          saved, and the old line stays, struck and dated "(superseded YYYY-MM-DD)"; a new note that
 *                   replaces another one gets `supersedes:` and the old note gets `superseded:` plus a dated line
 *   correction      as update; the new line carries a correction cue ("actually", "wrong", "correction")
 *   clash           not saved: a new line contradicts an always-loaded rule; the owner is asked
 *   unsourced-rule  not saved: a rule (a note of type feedback) can only come from the owner's own words
 *   third-party     saved as a quote only: blockquoted, attributed, type reference; it can never read as an order
 *
 * The source caps what a note can become. `source:` in the note's frontmatter is the declaration (owner, chat, nightly,
 * third-party); undeclared, it is `nightly` in a cron session and `chat` elsewhere; `owner` declared inside a cron run is
 * capped to `nightly`, because no person typed anything in it.
 *
 * MODES. `enforce` applies the outcome. `watch` lets every write through unchanged and only logs what it would have
 * done. Both doors read the mode from <state dir>/memory-gate/config.json, which the memory-enhancements plugin
 * publishes from its `contradictionGate` config (`warn` = watch, `block` = enforce). No file, or mode off: no gate.
 * Every decision is one row in <state dir>/data/memory-gate/gate.jsonl (label, outcome, source, files and line numbers;
 * never the note's text). An enforced ask also queues a row in asks.jsonl with the clashing lines.
 *
 * A LEXICAL GATE. Labels come from normalized-text matches, token overlap and negation, not from a model. It is fast
 * (no network on the write path) and wrong in known ways: a paraphrase is not a repeat, and a clash needs shared words
 * with opposite polarity. That is why it ships in watch mode: read gate.jsonl before turning on enforce. A shell
 * redirect (`echo >> note.md`) is not a tool write and is not seen. Every error lets the write through: a gate bug must
 * never cost a note.
 */
import path from "node:path";

export const MEMORY_GATE_MODES = ["enforce", "watch"];
export const MEMORY_SOURCES = ["owner", "chat", "nightly", "third-party", "unknown"];
export const GATE_CONFIG_VERSION = 1;

/** Folders under a root that hold logs, not notes. */
export const DEFAULT_EXCLUDE_DIRS = ["archive", "consolidation-logs", "co-access"];

/** Index files: their lines are pointers, so only the repeat and quote checks apply. */
export const INDEX_NAMES = new Set(["memory.md", "memory-archive.md", "index.md", "readme.md"]);

/** Thresholds, chosen on the owner's 956 live notes (see memory-write-gate.test.ts for the cases). */
const REPEAT_NOTE_JACCARD = 0.85;
const SAME_SUBJECT_JACCARD = 0.6;
const PAIR_MIN_JACCARD = 0.4;
const CLASH_MIN_SHARED = 4;
const CLASH_MIN_JACCARD = 0.5;
const CLASH_MAX_WORDS = 30;
const MIN_CONTENT_WORDS = 4;
const MAX_RULE_LINE_CHARS = 600;

// ─── text ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "the a an and or but if then than that this these those there here is are was were be been being am do does did " +
    "doing have has had having of in on at by for with about against between into through during before after above " +
    "below to from up down out off over under again further once all any both each few more most other some such own " +
    "same so too very can will just should now it its it's itself i me my we our you your he him his she her they them " +
    "their what which who whom when where why how also as via per one two get got use used using make made like " +
    "always must only should shall every"
  ).split(" "),
);

/** Words that flip a line's polarity. "always" and "only" do not: they are positive directives. */
const NEGATIONS = new Set([
  "never",
  "not",
  "no",
  "don't",
  "dont",
  "doesn't",
  "didn't",
  "isn't",
  "aren't",
  "wasn't",
  "won't",
  "shouldn't",
  "mustn't",
  "cannot",
  "can't",
  "without",
  "avoid",
  "stop",
  "nor",
  "nunca",
]);

/** A rule line says what to do or not to do. */
const DIRECTIVES =
  /\b(never|always|must|only|don't|do not|should|shall|required?|every|forbidden|no)\b/i;

/** A new line that says it corrects the record. */
const CORRECTION_CUES =
  /\b(actually|correction|corrected|wrong|was mistaken|not \w+ but|in fact)\b/i;

/** A new note that says it replaces an older fact. */
const UPDATE_CUES =
  /\b(moved|now|no longer|instead|changed|replaces?|replaced|supersedes?|update[sd]?|from now|switched|renamed)\b/i;

/** Someone else's text posing as an instruction to the agent. */
const INJECTION_PATTERNS = [
  /\bignore (all |any |the |your )?(previous|prior|above|earlier|preceding) (instructions|rules|messages|prompts?)\b/i,
  /\bdisregard (all |any |the |your )?(previous|prior|above|earlier) \w+/i,
  /\bforget (all |everything |your )(previous |prior )?(instructions|rules|you were told)\b/i,
  /\byou are now (a|an|the|in)\b/i,
  /\b(new|updated|override) (system )?instructions?\s*:/i,
  /\breveal (your|the) (system prompt|instructions)\b/i,
];

/** A line with markdown decoration removed, lowercased, whitespace collapsed. */
export function normalizeLine(line) {
  return String(line)
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*|#{1,6}\s+)+/u, "")
    .replace(/~~|\*\*|__|`/g, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:,!]+$/u, "")
    .toLowerCase();
}

function words(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
}

function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) {
    return w.slice(0, -3);
  }
  if (w.length > 4 && w.endsWith("ed")) {
    return w.slice(0, -2);
  }
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) {
    return w.slice(0, -1);
  }
  return w;
}

/** The content words of a text: no stopwords, no negations, three letters or more, lightly stemmed. */
export function contentTokens(text) {
  const out = new Set();
  for (const w of words(text)) {
    if (w.length >= 3 && !STOPWORDS.has(w) && !NEGATIONS.has(w)) {
      out.add(stem(w));
    }
  }
  return out;
}

function isNegative(text) {
  const lower = String(text).toLowerCase();
  if (/\bdo not\b|\bdoes not\b|\bis not\b|\bmust not\b/.test(lower)) {
    return true;
  }
  return words(lower).some((w) => NEGATIONS.has(w));
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let shared = 0;
  for (const t of a) {
    if (b.has(t)) {
      shared++;
    }
  }
  return shared / (a.size + b.size - shared);
}

function sharedCount(a, b) {
  let n = 0;
  for (const t of a) {
    if (b.has(t)) {
      n++;
    }
  }
  return n;
}

/** A line's comparison key: normalized, or null when it is under four words or a frontmatter fence. */
function contentKey(line) {
  if (String(line).trim().length < 12) {
    return null;
  }
  const n = normalizeLine(line);
  return n !== "---" && n.split(" ").length >= MIN_CONTENT_WORDS ? n : null;
}

/** A line worth comparing: at least four words once decoration is gone, and not a frontmatter fence. */
function isContentLine(line) {
  return contentKey(line) !== null;
}

/** The short sentences of a line: a rule or a claim, one at a time (long run-on text never clashes). */
export function sentencesOf(line) {
  return String(line)
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`[^`]*`/g, " ")
    .split(/(?<=[.!?;])\s+|\s+[—–]\s+|\s+->\s+|\s+→\s+/u)
    .map((x) => x.trim())
    .filter((x) => x && x.split(/\s+/).length <= CLASH_MAX_WORDS);
}

function levenshteinAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) {
    return false;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) {
      return false;
    }
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** True when the two lines differ only by spelling slips (each changed word is within two letters of its partner). */
function isTypoFix(oldLine, newLine) {
  const a = words(normalizeLine(oldLine));
  const b = words(normalizeLine(newLine));
  const onlyA = a.filter((w) => !b.includes(w));
  const onlyB = b.filter((w) => !a.includes(w));
  if (onlyA.length === 0 && onlyB.length === 0) {
    return true;
  }
  if (onlyA.length !== onlyB.length) {
    return false;
  }
  return onlyA.every((w, i) => w.length >= 4 && levenshteinAtMost(w, onlyB[i], 2));
}

/** A line of an always-loaded file that can hold a rule: a directive word and enough content words to compare. */
export function isRuleLine(line) {
  return (
    line.length <= MAX_RULE_LINE_CHARS &&
    DIRECTIVES.test(line) &&
    contentTokens(line).size >= CLASH_MIN_SHARED
  );
}

// ─── notes and frontmatter ─────────────────────────────────────────────────────────────────────────────────────────

/** `{ fm: string[] | null, body }`: the frontmatter lines between the `---` fences, and the rest. */
export function splitFrontmatter(text) {
  const lines = String(text).split("\n");
  if (lines[0]?.trim() !== "---") {
    return { fm: null, body: String(text), bodyStart: 0 };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { fm: lines.slice(1, i), body: lines.slice(i + 1).join("\n"), bodyStart: i + 1 };
    }
  }
  return { fm: null, body: String(text), bodyStart: 0 };
}

function unquote(v) {
  const t = v.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Top-level `key: value` pairs, plus `type` from under `metadata:` (the auto-memory layout). */
export function readFrontmatter(fm) {
  const out = {};
  if (!fm) {
    return out;
  }
  let parent = "";
  for (const line of fm) {
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      parent = top[1];
      if (top[2].trim()) {
        out[top[1]] = unquote(top[2]);
      }
      continue;
    }
    const nested = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (nested && parent === "metadata" && nested[1] === "type" && !out.type) {
      out.type = unquote(nested[2]);
    }
  }
  return out;
}

/**
 * The text with each field set in its frontmatter (a top-level key replaced in place, else added before the closing
 * fence). A text without frontmatter is returned unchanged: the gate never invents a note layout.
 */
export function setFrontmatterFields(text, fields) {
  const lines = String(text).split("\n");
  const { fm } = splitFrontmatter(text);
  if (!fm) {
    return String(text);
  }
  const close = fm.length + 1;
  const body = lines.slice(1, close);
  const added = [];
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value === "") {
      continue;
    }
    const at = body.findIndex((l) => new RegExp(`^${key}:`).test(l));
    const row = `${key}: ${value}`;
    if (at >= 0) {
      body[at] = row;
    } else {
      added.push(row);
    }
  }
  return [lines[0], ...body, ...added, ...lines.slice(close)].join("\n");
}

/** A note's metadata type set to `reference` (nested or top-level), for a quote. */
function setTypeReference(text) {
  const { fm } = splitFrontmatter(text);
  if (!fm) {
    return text;
  }
  const lines = String(text).split("\n");
  let parent = "";
  for (let i = 1; i <= fm.length; i++) {
    const top = /^([A-Za-z_][\w-]*):/.exec(lines[i]);
    if (top) {
      parent = top[1];
      if (top[1] === "type") {
        lines[i] = "type: reference";
      }
      continue;
    }
    if (parent === "metadata" && /^\s+type:/.test(lines[i])) {
      lines[i] = lines[i].replace(/type:.*/, "type: reference");
    }
  }
  return lines.join("\n");
}

function noteOf(file, text) {
  const { fm, body } = splitFrontmatter(text);
  const meta = readFrontmatter(fm);
  return {
    file,
    name: meta.name ?? "",
    description: meta.description ?? "",
    type: meta.type ?? "",
    body,
    lines: String(text).split("\n"),
    lower: String(text).toLowerCase(),
  };
}

// ─── sources ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A cron session (`…:cron:<job>` or `…:cron:<job>:run:<id>`): nobody typed anything in it. */
export function isScheduledSession(sessionKey) {
  return typeof sessionKey === "string" && /(^|:)cron:/.test(sessionKey);
}

/** A declared `source:` value read as one of MEMORY_SOURCES (its first word), plus who it names after that word. */
export function parseSource(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  const t = raw.trim();
  const m = /^([A-Za-z-]+)\s*[:(,-]?\s*(.*?)\)?$/.exec(t);
  const head = (m?.[1] ?? t).toLowerCase();
  const rest = (m?.[2] ?? "").trim();
  const alias = {
    user: "owner",
    "third-party": "third-party",
    thirdparty: "third-party",
    external: "third-party",
  };
  const source = alias[head] ?? head;
  return MEMORY_SOURCES.includes(source) ? { source, who: rest } : null;
}

/** Who a write speaks for: the note's declaration, capped by the session; undeclared, nightly in a cron, else chat. */
export function resolveSource({ declared, sessionKey }) {
  const parsed = parseSource(declared);
  const scheduled = isScheduledSession(sessionKey);
  if (parsed && parsed.source === "owner" && scheduled) {
    return { source: "nightly", declared: true, capped: true, who: "" };
  }
  if (parsed && parsed.source !== "unknown") {
    return { source: parsed.source, declared: true, capped: false, who: parsed.who };
  }
  return { source: scheduled ? "nightly" : "chat", declared: false, capped: false, who: "" };
}

// ─── the decision ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Lines of `after` that `before` does not have (as a multiset), and the reverse. */
export function lineDiff(before, after) {
  const count = new Map();
  for (const l of String(before ?? "").split("\n")) {
    count.set(l, (count.get(l) ?? 0) + 1);
  }
  const added = [];
  for (const l of String(after).split("\n")) {
    const n = count.get(l) ?? 0;
    if (n > 0) {
      count.set(l, n - 1);
    } else {
      added.push(l);
    }
  }
  const removed = [];
  for (const [l, n] of count) {
    for (let i = 0; i < n; i++) {
      removed.push(l);
    }
  }
  return { added, removed };
}

/**
 * Removed lines paired with the added line that rewrites them: same subject, and at least one old word gone (a line that
 * only grows keeps its fact, so it is an addition, not an update), and not a spelling fix.
 */
export function pairUpdates(removed, added) {
  const pairs = [];
  const used = new Set();
  for (const r of removed) {
    if (!isContentLine(r)) {
      continue;
    }
    const rt = contentTokens(r);
    let best = null;
    for (let i = 0; i < added.length; i++) {
      if (used.has(i) || !isContentLine(added[i])) {
        continue;
      }
      if (normalizeLine(added[i]) === normalizeLine(r)) {
        continue;
      }
      const at = contentTokens(added[i]);
      const score = jaccard(rt, at);
      const lost = [...rt].some((t) => !at.has(t));
      if (lost && score >= PAIR_MIN_JACCARD && (!best || score > best.score)) {
        best = { i, score };
      }
    }
    if (best && !isTypoFix(r, added[best.i])) {
      used.add(best.i);
      pairs.push({ old: r, next: added[best.i] });
    }
  }
  return pairs;
}

function findLine(note, normalized) {
  const at = note.lines.findIndex((l) => normalizeLine(l) === normalized);
  return at >= 0 ? at + 1 : undefined;
}

/**
 * The gate's decision for one write. Pure: everything it reads is in `input`.
 *
 * input: { file, before (string | null when the file is new), after, sessionKey?, date (YYYY-MM-DD),
 *          notes: [{ file, text }] (the other notes in the folder), rules: [{ file, line, text }],
 *          isIndex?, rulesFileSelf? (the target is itself an always-loaded file) }
 *
 * returns: { label, outcome: "save" | "skip" | "supersede" | "ask" | "quote", source, reason, matches: [{file, line}],
 *            pairs (update), supersedes ({ file, name } of the note a new note replaces), clash ({ rule, line }) }
 */
export function gateMemoryWrite(input) {
  const before = input.before ?? null;
  const after = String(input.after ?? "");
  const isNew = before === null;
  const afterNote = noteOf(input.file, after);
  const afterMeta = readFrontmatter(splitFrontmatter(after).fm);
  const src = resolveSource({ declared: afterMeta.source, sessionKey: input.sessionKey });
  const { added, removed } = lineDiff(before ?? "", after);
  const bodyAdded = isNew ? splitFrontmatter(after).body.split("\n") : added;
  const contentAdded = bodyAdded.filter(isContentLine);
  const notes = (input.notes ?? []).map((n) => noteOf(n.file, n.text));
  const base = {
    source: src.source,
    sourceDeclared: src.declared,
    sourceCapped: src.capped,
    matches: [],
  };

  if (contentAdded.length === 0) {
    return { ...base, label: "new", outcome: "save", reason: "no new content lines" };
  }

  // repeat: every new content line is already in a note of this folder (or the file itself). A repeat needs every line
  // known, so lines are tried longest first and the first unknown one ends the search; a note's lines are normalized
  // only when it contains the line's two longest words.
  const pool = before !== null ? [...notes, noteOf(input.file, before)] : notes;
  const findKnown = (key) => {
    const [w1, w2] = key.split(" ").toSorted((a, b) => b.length - a.length);
    for (const n of pool) {
      if (!n.lower.includes(w1) || (w2 && !n.lower.includes(w2))) {
        continue;
      }
      n.keys ??= new Set(n.lines.map(contentKey).filter(Boolean));
      if (n.keys.has(key)) {
        return n;
      }
    }
    return null;
  };
  const addedKeys = contentAdded.map(contentKey);
  const knownBy = new Map();
  let allKnown = true;
  for (const k of [...new Set(addedKeys)].toSorted((a, b) => b.length - a.length)) {
    const n = findKnown(k);
    if (!n) {
      allKnown = false;
      break;
    }
    knownBy.set(k, n);
  }
  if (allKnown) {
    const matches = [];
    for (const k of addedKeys) {
      const n = knownBy.get(k);
      if (n && !matches.some((m) => m.file === n.file)) {
        matches.push({ file: n.file, line: findLine(n, k) });
      }
    }
    return {
      ...base,
      label: "repeat",
      outcome: "skip",
      reason: "every new line is already saved",
      matches,
    };
  }
  const unseen = contentAdded.filter((_, i) => !knownBy.has(addedKeys[i]));
  if (isNew && !input.isIndex) {
    const bodyTokens = contentTokens(afterNote.body);
    const bodyLen = afterNote.body.length;
    const firstKey = addedKeys[0] ?? "";
    const firstProbe = firstKey.split(" ").toSorted((a, b) => b.length - a.length)[0] ?? "";
    const desc = normalizeLine(afterNote.description);
    for (const n of notes) {
      const sameDesc =
        desc.split(" ").length >= MIN_CONTENT_WORDS && desc === normalizeLine(n.description);
      // Jaccard >= 0.85 cannot hold between bodies whose sizes differ by more than that.
      const ratio = Math.min(bodyLen, n.body.length) / Math.max(bodyLen, n.body.length, 1);
      const near = ratio >= REPEAT_NOTE_JACCARD && n.lower.includes(firstProbe);
      if (sameDesc || (near && jaccard(bodyTokens, contentTokens(n.body)) >= REPEAT_NOTE_JACCARD)) {
        return {
          ...base,
          label: "repeat",
          outcome: "skip",
          reason: sameDesc
            ? "a note with the same description exists"
            : "a note with the same content exists",
          matches: [{ file: n.file }],
        };
      }
    }
  }

  // third-party: declared, or someone else's text posing as an instruction in a note the owner did not write.
  const injected =
    src.source !== "owner" && unseen.some((l) => INJECTION_PATTERNS.some((re) => re.test(l)));
  if (src.source === "third-party" || injected) {
    return {
      ...base,
      label: "third-party",
      outcome: "quote",
      reason: injected
        ? "someone else's text posing as an instruction"
        : "declared third-party source",
      who: src.who || afterMeta.from || "",
    };
  }

  if (input.isIndex) {
    return { ...base, label: "new", outcome: "save", reason: "index line" };
  }

  // clash: a new line and an always-loaded rule share their words and disagree on polarity. An index line that points
  // at this very note is its summary, not an independent rule.
  const removedSet = new Set(removed.map(normalizeLine));
  const selfName = path.basename(input.file);
  const ruleSentences = [];
  for (const rule of input.rules ?? []) {
    if (
      input.rulesFileSelf &&
      rule.file === input.file &&
      removedSet.has(normalizeLine(rule.text))
    ) {
      continue;
    }
    if (rule.text.includes(selfName)) {
      continue;
    }
    for (const sentence of sentencesOf(rule.text)) {
      const tokens = contentTokens(sentence);
      if (tokens.size >= CLASH_MIN_SHARED && DIRECTIVES.test(sentence)) {
        ruleSentences.push({ rule, sentence, tokens, neg: isNegative(sentence) });
      }
    }
  }
  for (const l of unseen) {
    for (const claim of sentencesOf(l)) {
      const ct = contentTokens(claim);
      if (ct.size < CLASH_MIN_SHARED) {
        continue;
      }
      const neg = isNegative(claim);
      for (const r of ruleSentences) {
        if (
          r.neg === neg ||
          sharedCount(ct, r.tokens) < CLASH_MIN_SHARED ||
          jaccard(ct, r.tokens) < CLASH_MIN_JACCARD
        ) {
          continue;
        }
        return {
          ...base,
          label: "clash",
          outcome: "ask",
          reason: "a new line contradicts an always-loaded rule",
          matches: [{ file: r.rule.file, line: r.rule.line }],
          clash: { rule: r.sentence, line: claim },
        };
      }
    }
  }

  // update in place: an old line rewritten in the same file.
  if (!isNew) {
    const pairs = pairUpdates(removed, added);
    if (pairs.length > 0) {
      const correction = pairs.some((p) => CORRECTION_CUES.test(p.next));
      return {
        ...base,
        label: correction ? "correction" : "update",
        outcome: "supersede",
        reason: `${pairs.length} old line(s) kept, struck and dated`,
        pairs,
        matches: [{ file: input.file }],
      };
    }
  }

  // update by a new note: same name, a declared `supersedes:`, or the same subject with an update cue.
  if (isNew) {
    const declared = (afterMeta.supersedes ?? "").trim();
    const descTokens = contentTokens(afterNote.description);
    const cue =
      UPDATE_CUES.test(afterNote.description) || UPDATE_CUES.test(afterNote.body.slice(0, 600));
    for (const n of notes) {
      const stemName = path.basename(n.file, path.extname(n.file));
      const byName = afterNote.name && n.name && afterNote.name === n.name;
      const byDecl = declared && (declared === n.name || declared === stemName);
      const bySubject =
        cue &&
        descTokens.size >= 3 &&
        jaccard(descTokens, contentTokens(n.description)) >= SAME_SUBJECT_JACCARD;
      if (byName || byDecl || bySubject) {
        const correction =
          CORRECTION_CUES.test(afterNote.description) || CORRECTION_CUES.test(afterNote.body);
        return {
          ...base,
          label: correction ? "correction" : "update",
          outcome: "supersede",
          reason: byName
            ? "same note name"
            : byDecl
              ? "declared supersedes"
              : "same subject, update cue",
          supersedes: { file: n.file, name: n.name || stemName },
          matches: [{ file: n.file }],
        };
      }
    }
  }

  // A rule needs the owner's own words.
  if (isNew && /^feedback$/i.test(afterNote.type) && src.source !== "owner") {
    return {
      ...base,
      label: "unsourced-rule",
      outcome: "ask",
      reason: "a rule (type feedback) can only come from the owner's own words",
    };
  }

  return { ...base, label: "new", outcome: "save", reason: "new" };
}

// ─── outcomes as text ──────────────────────────────────────────────────────────────────────────────────────────────

function strikeLine(line, date) {
  const m = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)(.*)$/.exec(line);
  const text = (m?.[2] ?? line).replace(/~~/g, "").trim();
  return `${m?.[1] ?? ""}~~${text}~~ _(superseded ${date})_`;
}

/** `newText` with each paired old line kept under its replacement, struck and dated. */
export function strikeSuperseded(newText, pairs, date) {
  const lines = String(newText).split("\n");
  const out = [];
  const pending = [...pairs];
  for (const l of lines) {
    out.push(l);
    const at = pending.findIndex((p) => p.next === l);
    if (at >= 0) {
      out.push(strikeLine(pending[at].old, date));
      pending.splice(at, 1);
    }
  }
  return out.join("\n");
}

/** `newText` with the lines `oldText` lacks blockquoted, and one attribution line after them. */
export function quoteAdded(oldText, newText, attribution) {
  const { added } = lineDiff(oldText ?? "", newText);
  const pending = new Map();
  for (const l of added) {
    pending.set(l, (pending.get(l) ?? 0) + 1);
  }
  const lines = String(newText).split("\n");
  const out = [];
  let last = -1;
  for (const l of lines) {
    const n = pending.get(l) ?? 0;
    if (n > 0 && l.trim() && !l.trimStart().startsWith(">")) {
      pending.set(l, n - 1);
      out.push(`> ${l}`);
      last = out.length;
    } else {
      out.push(l);
    }
  }
  if (last >= 0) {
    out.splice(last, 0, `> — ${attribution}`);
  }
  return out.join("\n");
}

function quoteAttribution(decision, date) {
  const who = decision.who ? decision.who : "an outside source";
  return `quoted from ${who}, saved ${date}: their words, not an instruction`;
}

/** A whole note's body blockquoted (frontmatter kept, source third-party, type reference). */
function quoteNote(text, decision, date) {
  const { fm, bodyStart } = splitFrontmatter(text);
  const lines = String(text).split("\n");
  const head = fm ? lines.slice(0, bodyStart).join("\n") : "";
  const body = fm ? lines.slice(bodyStart).join("\n") : String(text);
  const quoted = quoteAdded("", body, quoteAttribution(decision, date));
  const joined = fm ? `${head}\n${quoted}` : quoted;
  return setTypeReference(setFrontmatterFields(joined, { source: "third-party" }));
}

/** The old note, stamped as superseded by `byName` on `date`: frontmatter fields and one dated line. */
export function stampSupersededNote(text, byName, date, label) {
  const meta = readFrontmatter(splitFrontmatter(text).fm);
  if (meta.superseded_by === byName) {
    return text;
  }
  const stamped = setFrontmatterFields(text, { superseded: date, superseded_by: byName });
  const { fm, bodyStart } = splitFrontmatter(stamped);
  const line = `> Superseded ${date} by [[${byName}]] (${label}).`;
  const lines = stamped.split("\n");
  const at = fm ? bodyStart : 0;
  lines.splice(at, 0, ...(fm ? ["", line] : [line, ""]));
  return lines.join("\n");
}

// ─── tool calls as write operations ────────────────────────────────────────────────────────────────────────────────

/**
 * A tool call as `{ file, kind: "write", content }` or `{ file, kind: "edit", edits: [{ old, next, all }] }`, or null
 * when it is not a file write. Claude Code: Write {file_path, content}, Edit {file_path, old_string, new_string,
 * replace_all}, MultiEdit {file_path, edits}. Embedded runner: write {path, content}, edit {path, edits: [{oldText,
 * newText}]} (an older single oldText/newText shape is read too).
 */
export function writeOpOf(toolName, input) {
  const t = String(toolName ?? "").toLowerCase();
  const i = input && typeof input === "object" ? input : {};
  const file =
    typeof i.file_path === "string" ? i.file_path : typeof i.path === "string" ? i.path : "";
  if (!file) {
    return null;
  }
  if (t === "write" && typeof i.content === "string") {
    return { file, kind: "write", content: i.content };
  }
  if (t === "edit" && typeof i.old_string === "string" && typeof i.new_string === "string") {
    return {
      file,
      kind: "edit",
      edits: [{ old: i.old_string, next: i.new_string, all: i.replace_all === true }],
    };
  }
  if ((t === "edit" || t === "multiedit") && Array.isArray(i.edits)) {
    const edits = [];
    for (const e of i.edits) {
      const old = typeof e?.old_string === "string" ? e.old_string : e?.oldText;
      const next = typeof e?.new_string === "string" ? e.new_string : e?.newText;
      if (typeof old !== "string" || typeof next !== "string") {
        return null;
      }
      edits.push({ old, next, all: e?.replace_all === true });
    }
    return edits.length ? { file, kind: "edit", edits } : null;
  }
  if (t === "edit" && typeof i.oldText === "string" && typeof i.newText === "string") {
    return { file, kind: "edit", edits: [{ old: i.oldText, next: i.newText, all: false }] };
  }
  return null;
}

/** The tool input with the operation's new text put back in the shape it came in. */
export function inputWithOp(toolName, input, op) {
  const t = String(toolName ?? "").toLowerCase();
  if (op.kind === "write") {
    return { ...input, content: op.content };
  }
  if (t === "edit" && typeof input.old_string === "string") {
    return { ...input, new_string: op.edits[0].next };
  }
  if (Array.isArray(input.edits)) {
    return {
      ...input,
      edits: input.edits.map((e, k) =>
        typeof e?.new_string === "string"
          ? { ...e, new_string: op.edits[k].next }
          : { ...e, newText: op.edits[k].next },
      ),
    };
  }
  return { ...input, newText: op.edits[0].next };
}

/** The file's text after the operation, or null when an edit's old text is not in it (the tool will fail anyway). */
export function applyOp(before, op) {
  if (op.kind === "write") {
    return op.content;
  }
  let text = before ?? "";
  for (const e of op.edits) {
    if (e.old === "") {
      text = e.next + text;
      continue;
    }
    if (!text.includes(e.old)) {
      return null;
    }
    text = e.all ? text.split(e.old).join(e.next) : text.replace(e.old, () => e.next);
  }
  return text;
}

/** The operation rewritten for an outcome (quote, strike, stamps), or the same operation. */
export function transformOp(op, before, decision, ctx) {
  const date = ctx.date;
  if (decision.outcome === "quote") {
    if (op.kind === "write") {
      return before === null
        ? { ...op, content: quoteNote(op.content, decision, date) }
        : { ...op, content: quoteAdded(before, op.content, quoteAttribution(decision, date)) };
    }
    return {
      ...op,
      edits: op.edits.map((e) => ({
        ...e,
        next: quoteAdded(e.old, e.next, quoteAttribution(decision, date)),
      })),
    };
  }
  if (decision.outcome === "supersede" && decision.pairs) {
    if (op.kind === "write") {
      return { ...op, content: strikeSuperseded(op.content, decision.pairs, date) };
    }
    return {
      ...op,
      edits: op.edits.map((e) => {
        const pairs = pairUpdates(lineDiff(e.old, e.next).removed, lineDiff(e.old, e.next).added);
        return pairs.length ? { ...e, next: strikeSuperseded(e.next, pairs, date) } : e;
      }),
    };
  }
  if ((decision.outcome === "save" || decision.outcome === "supersede") && op.kind === "write") {
    const meta = readFrontmatter(splitFrontmatter(op.content).fm);
    return {
      ...op,
      content: setFrontmatterFields(op.content, {
        source: meta.source ? undefined : decision.source,
        date: meta.date ? undefined : date,
        from: meta.from || !ctx.origin ? undefined : ctx.origin,
        supersedes: decision.supersedes && !meta.supersedes ? decision.supersedes.name : undefined,
      }),
    };
  }
  return op;
}
