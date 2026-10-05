// THALAMUS v4 — condense a long tool result instead of carrying it (paper J19 v4.1 §5.2, switch rule 2).
//
// WHAT THIS IS FOR. A tool result of S tokens that stays in the thread is written into the incumbent's cache once
// and re-read on every later step. A reader can take the result alone, with a brief of what the thread is looking
// for, and hand back a digest of d tokens. This file decides whether that pays, names the raw copy that stays on disk,
// and writes the two texts around it: the brief the reader gets and the note that replaces the result in the thread.
//
// HOW IT WAS DERIVED. The inequality is the paper's, through B's `digestPays`:
//   (1 - d/S)(w + r_b L) > q
// with w the incumbent's cache write and r_b its cached read (both as multiples of the incumbent's input price),
// L the later steps that would re-read the result, and q the reader's input price over the incumbent's (1 when the
// reader is the incumbent's own model: the saving is not carrying the raw result).
//
// WHAT WOULD CHANGE IT. The default digest size and the minimum result length are starting values; the ledger's
// record of digests that had to be recalled tunes them (phase F). An unpriced model on either side means "do not
// digest": nothing is invented.
//
// PURE. No clock, no I/O, no crypto: the raw name is a hash of the text and its length.

import { cachePolicyFor, priceFor } from "./thalamus-price-table.js";
import { digestPays } from "./thalamus-switch.js";

/** Results shorter than this are not worth a reader call whatever the arithmetic says. */
export const DEFAULT_MIN_RESULT_TOKENS = 2_000;
/** The digest is asked to stay under this many tokens, or a sixth of the result, whichever is smaller. */
export const DEFAULT_DIGEST_TOKENS = 1_200;
/** Later steps assumed to re-read a result when the step read gave no run length. */
export const DEFAULT_LATER_STEPS = 3;

export type DigestReason =
  | "pays"
  | "does-not-pay"
  | "short"
  | "needs-full"
  | "unpriced"
  | "hand-picked";

export type DigestDecision = {
  digest: boolean;
  reason: DigestReason;
  resultTokens: number;
  /** The digest size the arithmetic assumed. */
  digestTokens?: number;
  dOverS?: number;
  w?: number;
  rb?: number;
  q?: number;
  laterSteps?: number;
  /** (1 - d/S)(w + r_b L) - q: positive pays. */
  margin?: number;
};

export type DigestInput = {
  resultTokens: number;
  incumbentKey: string;
  readerKey: string;
  /** Later steps expected to re-read the result. */
  laterSteps?: number;
  /** What the reader is asked to stay under. */
  digestTokens?: number;
  minResultTokens?: number;
  /** The step read says the item in hand is needed in full: keep it raw. */
  needsFull?: boolean;
  /** A hand-picked model is never replaced; the reader is a second model, so a hand-picked thread is left as it is. */
  handPicked?: boolean;
  tier?: "5m" | "1h";
};

export function digestTokenBudget(resultTokens: number, cap = DEFAULT_DIGEST_TOKENS): number {
  return Math.max(1, Math.min(cap, Math.ceil(resultTokens / 6)));
}

/** Does condensing this result pay, and on what numbers? */
export function decideDigest(i: DigestInput): DigestDecision {
  const S = Math.max(0, Math.floor(i.resultTokens));
  const base = { resultTokens: S };
  if (i.handPicked) return { ...base, digest: false, reason: "hand-picked" };
  if (i.needsFull) return { ...base, digest: false, reason: "needs-full" };
  if (S < (i.minResultTokens ?? DEFAULT_MIN_RESULT_TOKENS)) {
    return { ...base, digest: false, reason: "short" };
  }
  const inc = priceFor(i.incumbentKey);
  const reader = priceFor(i.readerKey);
  const policy = cachePolicyFor(i.incumbentKey);
  if (
    !inc ||
    !reader ||
    !policy ||
    inc.inputPerMTok === null ||
    reader.inputPerMTok === null ||
    !(inc.inputPerMTok > 0)
  ) {
    return { ...base, digest: false, reason: "unpriced" };
  }
  const d = digestTokenBudget(S, i.digestTokens);
  const L = Math.max(0, i.laterSteps ?? DEFAULT_LATER_STEPS);
  const w = i.tier === "5m" ? policy.write5mMult : policy.write1hMult;
  const q = i.incumbentKey === i.readerKey ? 1 : reader.inputPerMTok / inc.inputPerMTok;
  const dOverS = d / S;
  const pays = digestPays({ dOverS, w, rb: policy.readMult, L, q });
  return {
    ...base,
    digest: pays,
    reason: pays ? "pays" : "does-not-pay",
    digestTokens: d,
    dOverS,
    w,
    rb: policy.readMult,
    q,
    laterSteps: L,
    margin: (1 - dOverS) * (w + policy.readMult * L) - q,
  };
}

/** FNV-1a over UTF-16 code units, 32 bit. Deterministic, dependency free; a name, not a security boundary. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let n = 0; n < text.length; n++) {
    h ^= text.charCodeAt(n);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The name the raw result is kept under: stable for the same text, different for different texts and lengths.
 * It carries no path and nothing from the conversation.
 */
export function rawResultName(text: string): string {
  return `res-${fnv1a(text)}-${text.length.toString(36)}`;
}

/** What the reader is told. The brief is the thread's aim in the user's own words, never the whole thread. */
export function digestBrief(p: { aim: string; toolName: string; digestTokens: number }): string {
  const aim = p.aim.replace(/\s+/g, " ").trim().slice(0, 600);
  return [
    `A tool called "${p.toolName}" returned the text below. Condense it for a piece of work that is trying to do this:`,
    aim.length > 0 ? aim : "(no aim was given; keep what a careful reader would need)",
    `Keep every name, number, identifier, path, error message, decision and open question that could matter. Drop repetition and boilerplate. Do not add anything that is not in the text. Stay under about ${p.digestTokens} tokens.`,
  ].join("\n\n");
}

/** The note that takes the raw result's place in the thread. It says where the full text is and how to get it. */
export function digestNote(p: {
  toolName: string;
  rawTokens: number;
  rawName: string;
  rawPath?: string;
  digest: string;
}): string {
  const where = p.rawPath
    ? `The full result is kept at ${p.rawPath}; read that file if a detail below is not enough.`
    : `The full result is kept under the name ${p.rawName}; ask for it if a detail below is not enough.`;
  return [
    `[Condensed: "${p.toolName}" returned about ${p.rawTokens} tokens; this is a digest.`,
    `${where}]`,
    p.digest.trim(),
  ].join("\n");
}

/** A rough token count from characters (about four per token), for callers that have only text. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
