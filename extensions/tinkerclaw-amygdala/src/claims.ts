/**
 * Claim splitter for the double-check family (design doc §5.2, paper §6.3). By code, never Jev: a reply is cut into
 * sentences and each sentence that says something was done, or how a running system is now, becomes a Claim. The
 * judge then decides whether the tool record supports it; `supportedBy` here is only a conservative hint used to
 * phrase the send-back and to test, never to decide.
 */
import { isShellTool } from "./effect-class.js";
import type { Claim, EffectClass, ToolRecordEntry } from "./types.js";

interface VerbInfo {
  /** English past form used in the `missingFor` phrase. */
  past: string;
  /** Effect class an entry must carry to support it; "shell" = any shell call; "write-or-shell"; "any" = any non-read. */
  need: EffectClass | "shell" | "write-or-shell" | "any";
  /** Tool-name stem that also supports it (a tool literally called `upload`). */
  stem?: string;
}

const VERBS: Record<string, VerbInfo> = {
  uploaded: { past: "uploaded", need: "send", stem: "upload" },
  sent: { past: "sent", need: "send", stem: "send" },
  enviat: { past: "sent", need: "send", stem: "send" },
  enviado: { past: "sent", need: "send", stem: "send" },
  saved: { past: "saved", need: "local-write" },
  guardat: { past: "saved", need: "local-write" },
  guardado: { past: "saved", need: "local-write" },
  deleted: { past: "deleted", need: "delete", stem: "delete" },
  removed: { past: "removed", need: "delete", stem: "remove" },
  eliminat: { past: "deleted", need: "delete", stem: "delete" },
  eliminado: { past: "deleted", need: "delete", stem: "delete" },
  created: { past: "created", need: "local-write" },
  wrote: { past: "wrote", need: "local-write" },
  written: { past: "wrote", need: "local-write" },
  pushed: { past: "pushed", need: "send", stem: "push" },
  committed: { past: "committed", need: "local-write" },
  merged: { past: "merged", need: "local-write" },
  deployed: { past: "deployed", need: "send", stem: "deploy" },
  installed: { past: "installed", need: "shell" },
  fixed: { past: "fixed", need: "write-or-shell" },
  arreglat: { past: "fixed", need: "write-or-shell" },
  arreglado: { past: "fixed", need: "write-or-shell" },
  tested: { past: "tested", need: "shell" },
  provat: { past: "tested", need: "shell" },
  probado: { past: "tested", need: "shell" },
  verified: { past: "verified", need: "shell" },
  built: { past: "built", need: "shell" },
  printed: { past: "printed", need: "shell" },
  paid: { past: "paid", need: "spend", stem: "pay" },
  restarted: { past: "restarted", need: "restart-own-system", stem: "restart" },
  renamed: { past: "renamed", need: "local-write" },
  moved: { past: "moved", need: "local-write" },
  copied: { past: "copied", need: "local-write" },
  published: { past: "published", need: "send", stem: "publish" },
  finished: { past: "finished", need: "any" },
  done: { past: "done", need: "any" },
  completed: { past: "completed", need: "any" },
  fet: { past: "done", need: "any" },
  hecho: { past: "done", need: "any" },
};

const B = String.raw`(?<![\p{L}\p{N}_-])`;
const E = String.raw`(?![\p{L}\p{N}_-])`;
const VERB_SRC = `${B}(?:${Object.keys(VERBS).join("|")})${E}`;
const VERB_RE = new RegExp(VERB_SRC, "iu");
const VERB_G = new RegExp(VERB_SRC, "giu");

// A negation, future, condition or proposal within four words before the verb turns the sentence into a non-claim.
// Proximity, not whole-sentence: "I uploaded it with no errors" is still a claim.
const GATE = String.raw`(?:\bnot\b|n['’]t\b|\bnever\b|\bnunca\b|\bmai\b|\bno\b|\bnothing\b|\bnone\b|\bneither\b|\bnada\b|\bres\b|\bwithout\b|\bsin\b|\bsense\b|\bfailed to\b|\bunable to\b|\bwill\b|['’]ll\b|\bshall\b|\bgoing to\b|\babout to\b|\bwould\b|\bshould\b|\bcould\b|\bmight\b|\bmay\b|\bmust\b|\bcan be\b|\bto be\b|\bneeds? to\b|\bhas to\b|\bhave to\b|\bwants? to\b|\bplans? to\b|\bprefer to\b|\bpropos(?:e|es|ed|al|ing)\b|\bsuggest(?:s|ed|ing|ion)?\b|\brecommend(?:s|ed|ing)?\b|\blet me\b|\bvoy a\b|\bvamos a\b|\bpodría\b|\bdebería\b|\bhauria\b|\bpodria\b|\bif\b|\bsi\b|\bwhether\b|\bonce\b|\bwhen\b|\bcuando\b|\bquan\b|\bunless\b|\buntil\b)`;
const GATE_GAP = String.raw`(?:\s+[\p{L}'’]+){0,4}?\s+`;
const BLOCKED_RE = new RegExp(`${GATE}${GATE_GAP}${VERB_SRC}`, "iu");
/** A sentence that opens as a condition or a proposal claims nothing, however far the verb sits from the opening word. */
const NOT_A_REPORT_RE =
  /^\W*(?:if|once|when|unless|until|whether|should|would|could|next|plan|proposal|proposed|suggestion|option|todo|si|quan|cuando)\b/iu;

const STATE_SRC = String.raw`(?:is running|are running|is up|are up|is down|is enabled|is disabled|now uses|is live|has restarted)`;
const STATE_RE = new RegExp(String.raw`\b${STATE_SRC}\b`, "gi");
const STATE_BLOCKED_RE = new RegExp(`${GATE}${GATE_GAP}${STATE_SRC}`, "iu");

const ABBREV = new Set(["e.g", "i.e", "etc", "vs", "mr", "mrs", "dr", "approx", "fig", "no", "st"]);

/** Cut a reply into sentences: `. ! ? ;` before whitespace or the end, plus newlines and bullets. */
export function splitSentences(reply: string): string[] {
  const out: string[] = [];
  for (const rawLine of String(reply ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i] as string;
      if (c !== "." && c !== "!" && c !== "?" && c !== ";") continue;
      let j = i + 1;
      while (j < line.length && /["')\]”’]/.test(line[j] as string)) j++;
      if (j < line.length && !/\s/.test(line[j] as string)) continue; // a.b, v2.3, paths
      if (c === ".") {
        const word = /([\p{L}.]+)$/u.exec(line.slice(start, i))?.[1]?.toLowerCase();
        if (word && ABBREV.has(word)) continue;
      }
      const piece = line.slice(start, j).trim();
      if (piece) out.push(piece);
      start = j;
      i = j - 1;
    }
    const rest = line.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out;
}

function stripStates(sentence: string): { rest: string; state: boolean } {
  let state = false;
  const rest = sentence.replace(STATE_RE, () => {
    state = true;
    return " ";
  });
  return { rest, state };
}

export function splitClaims(reply: string): Claim[] {
  const claims: Claim[] = [];
  for (const sentence of splitSentences(reply)) {
    if (sentence.endsWith("?") || NOT_A_REPORT_RE.test(sentence)) continue;
    const { rest, state } = stripStates(sentence);
    const done = VERB_RE.test(rest) && !BLOCKED_RE.test(rest);
    if (done) claims.push({ text: sentence, kind: "done", source: null, support: null });
    else if (state && !BLOCKED_RE.test(sentence) && !STATE_BLOCKED_RE.test(sentence))
      claims.push({ text: sentence, kind: "state", source: null, support: null });
  }
  return claims;
}

function verbsOf(text: string): VerbInfo[] {
  const out: VerbInfo[] = [];
  for (const m of text.matchAll(VERB_G)) {
    const v = VERBS[m[0].toLowerCase()];
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

const okEntries = (rec: ToolRecordEntry[]): ToolRecordEntry[] =>
  rec.filter((e) => e.exit === 0 || e.exit === null);

function verbSupported(v: VerbInfo, rec: ToolRecordEntry[]): boolean {
  return okEntries(rec).some((e) => {
    if (v.stem && new RegExp(`(^|[^a-z])${v.stem}`).test(e.tool.toLowerCase())) return true;
    switch (v.need) {
      case "shell":
        return isShellTool(e.tool);
      case "write-or-shell":
        return isShellTool(e.tool) || e.effects.includes("local-write");
      case "any":
        return e.effects.some((x) => x !== "read");
      case "local-write":
        return e.effects.includes("local-write") || e.effects.includes("other");
      default:
        return e.effects.includes(v.need);
    }
  });
}

/** Conservative code-side hint: does the record hold a matching successful action for every verb of the claim? */
export function supportedBy(claim: Claim, toolRecord: ToolRecordEntry[]): boolean {
  if (claim.kind === "state") return okEntries(toolRecord).some((e) => isShellTool(e.tool));
  const verbs = verbsOf(claim.text);
  if (verbs.length === 0) return false;
  return verbs.every((v) => verbSupported(v, toolRecord));
}

/** What a command's output or a job report says when the action behind a verb happened; other verbs say their own word. */
const OUTPUT_PROOF: Record<string, RegExp> = {
  deleted: /\b(?:deleted|removed|trashed)\b/i,
  removed: /\b(?:deleted|removed|trashed)\b/i,
  restarted: /\brestart(?:ed)?\b|\bhealthy on build\b|\bactive \(running\)/i,
  merged: /\bmerged?\b|\bfast-forward\b/i,
  committed: /^\[\S+ [0-9a-f]{7,}\]|\bcommitted\b/i,
  pushed: /\bpushed\b|\S\s+->\s+\S/,
  tested: /\b\d+ (?:tests? )?passed\b/i,
  verified: /\b\d+ (?:tests? )?passed\b|\bverified\b/i,
  built: /\bbuilt\b|\bbuild (?:ok|succeeded|complete)/i,
  done: /\b(?:done|finished|completed|succeeded)\b/i,
  finished: /\b(?:done|finished|completed|succeeded)\b/i,
  completed: /\b(?:done|finished|completed|succeeded)\b/i,
};
const proofOf = (v: VerbInfo): RegExp =>
  OUTPUT_PROOF[v.past] ?? new RegExp(String.raw`\b${v.past}\b`, "i");
const STATE_PROOF = /\b(?:active|running|healthy|enabled|listening|restarted|live)\b|\bup\b/i;
const ANY_PROOF = new RegExp(
  [...new Set(Object.values(VERBS).map((v) => proofOf(v).source)), STATE_PROOF.source].join("|"),
  "i",
);
/** "All", "both", "every": one line of output cannot speak for the whole set, so the judge keeps these. */
const WHOLE_SET = /\b(?:all|both|every|each|tots|todos|ambdós)\b/i;
const FILLER = new Set(
  "that this with from into have been were they them then also just here there your what which about after before over only some each still".split(
    " ",
  ),
);
const EVIDENCE_LINE_MAX = 240;

/** The lines of a command's output or a job report that could prove a claim. Stays on the machine: code reads it, Jev does not. */
export function evidenceLines(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (t && ANY_PROOF.test(t)) out.push(t.slice(0, EVIDENCE_LINE_MAX));
  }
  return out;
}

/** Words of a claim specific enough to tie it to a line of output: the thing named, not its verb. */
function claimWords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_.-]{3,}/gu) ?? [];
  return words
    .map((w) => w.replace(/[.-]+$/, ""))
    .filter((w) => w.length >= 4 && !FILLER.has(w) && !(w in VERBS));
}

/**
 * Does the output of this task show the claim true? Each verb needs a line that shows the action and names a thing the
 * claim names (a test count needs no name); at least one verb must be shown by a line, and any other verb must have a
 * matching action in the record. 2026-10-28 to 11-01: 348 of 483 claim flags were noise or harmful, largely because the
 * record held only the shape of a call, so `Deleted branch x` in the output counted for nothing.
 */
export function provenByOutput(
  claim: Claim,
  lines: readonly string[],
  toolRecord: ToolRecordEntry[],
): boolean {
  if (lines.length === 0) return false;
  const words = claimWords(claim.text);
  const named = (line: string): boolean => {
    const low = line.toLowerCase();
    return words.some((w) => low.includes(w));
  };
  if (claim.kind === "state") return lines.some((l) => STATE_PROOF.test(l) && named(l));
  const verbs = verbsOf(claim.text);
  if (verbs.length === 0) return false;
  const tested = (v: VerbInfo): boolean => v.past === "tested" || v.past === "verified";
  if (WHOLE_SET.test(claim.text) && !verbs.every(tested)) return false;
  const shown = verbs.filter((v) =>
    lines.some((l) => proofOf(v).test(l) && (named(l) || tested(v))),
  );
  return shown.length > 0 && verbs.every((v) => shown.includes(v) || verbSupported(v, toolRecord));
}

/** A line of output that shows the work was checked, whatever the reply says about it. */
export function showsACheck(lines: readonly string[]): boolean {
  return lines.some((l) => /\b\d+ (?:tests? )?passed\b|\bhealthy on build\b/i.test(l));
}

const DEFECT_LINE = /^\s*report-defect:\s*(\S.*)$/gim;

/** The agent's formal "this test is wrong": `report-defect: <file>: <why>`, each on its own line of the reply. */
export function reportedDefects(reply: string): string[] {
  return [...String(reply ?? "").matchAll(DEFECT_LINE)].map((m) => (m[1] as string).trim());
}

/**
 * Words by which a reply admits it states something it did not check (2026-11-10). Each is an admission by the writer,
 * never a description of someone else's code, as far as a pattern can tell.
 */
const UNCHECKED_RE = new RegExp(
  [
    String.raw`\((?:inferred|assumed|unverified|untested|not (?:checked|verified|confirmed|tested))\b[^)]*\)`,
    String.raw`\b(?:I|we)\s+(?:have\s+not|haven[’']t|did\s+not|didn[’']t)\s+(?:yet\s+)?(?:check|verif|confirm|test|measur|look)\w*`,
    String.raw`\bnot\s+(?:yet\s+)?(?:checked|verified|confirmed|tested|measured)\b`,
    String.raw`\b(?:unverified|untested)\b`,
    String.raw`\bfrom\s+(?:memory|general\s+knowledge)\b`,
    String.raw`\bI(?:[’']m|\s+am)\s+not\s+sure\b`,
    String.raw`\b(?:sin|sense)\s+compro[bv]ar\b`,
    String.raw`\bno\s+(?:lo\s+he\s+comprobado|ho\s+he\s+comprovat)\b`,
  ].join("|"),
  "iu",
);

/** Fenced blocks (code, html cards), quoted lines and text inside double quotes are not the writer's own claims. */
export function ownProse(reply: string): string {
  return String(reply ?? "")
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/"[^"\n]{0,400}"|“[^”\n]{0,400}”/g, " ");
}

/**
 * The sentences of a reply that say something was not checked (an inferred tag, a not-checked phrase, a from-memory phrase).
 * The stop seam sends the reply back once so the agent checks them (double-check family). Deterministic, no judge.
 */
export function uncheckedAdmissions(reply: string): string[] {
  return splitSentences(ownProse(reply)).filter((s) => UNCHECKED_RE.test(s));
}

/** A short phrase for the send-back template slot: what the tool record lacks. Deterministic, at most 90 chars. */
export function missingFor(claim: Claim, toolRecord: ToolRecordEntry[]): string {
  if (claim.kind === "state") return "no check of the running state in this task";
  const verbs = verbsOf(claim.text);
  const v = verbs.find((x) => !verbSupported(x, toolRecord));
  if (!v) {
    return verbs.length === 0
      ? "no tool call in this task shows it done"
      : "no entry in the record that covers all of it";
  }
  let phrase: string;
  if (v.past === "tested" || v.past === "verified")
    phrase = "no successful test or check run in this task";
  else if (v.need === "any") phrase = "no tool call in this task shows the work done";
  else if (toolRecord.length === 0) phrase = `no tool call in this task ${v.past} anything`;
  else phrase = `no successful call that ${v.past} anything`;
  return phrase.slice(0, 90);
}
