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

// A negation, future or condition marker within three words before the verb turns the sentence into a non-claim.
// Proximity, not whole-sentence: "I uploaded it with no errors" is still a claim.
const GATE = String.raw`(?:\bnot\b|n['’]t\b|\bnever\b|\bnunca\b|\bmai\b|\bno\b|\bwithout\b|\bfailed to\b|\bunable to\b|\bwill\b|['’]ll\b|\bshall\b|\bgoing to\b|\babout to\b|\bwould\b|\blet me\b|\bvoy a\b|\bvamos a\b|\bif\b|\bonce\b|\bunless\b|\buntil\b)`;
const BLOCKED_RE = new RegExp(`${GATE}(?:\\s+[\\p{L}'’]+){0,3}?\\s+${VERB_SRC}`, "iu");

const STATE_RE =
  /\b(?:is running|are running|is up|are up|is down|is enabled|is disabled|now uses|is live|has restarted)\b/gi;

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
    if (sentence.endsWith("?")) continue;
    const { rest, state } = stripStates(sentence);
    const done = VERB_RE.test(rest) && !BLOCKED_RE.test(rest);
    if (done) claims.push({ text: sentence, kind: "done", source: null, support: null });
    else if (state && !BLOCKED_RE.test(sentence))
      claims.push({ text: sentence, kind: "state", source: null, support: null });
  }
  return claims;
}

/** Does any sentence carry a completion verb, negated or not? The family's whole-reply fallback. */
export function hasCompletionVerb(reply: string): boolean {
  return splitSentences(reply).some((x) => !x.endsWith("?") && VERB_RE.test(x));
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
