// THALAMUS v4 — the check by another family and the one writer (paper J19 v4.1 §5.4 rules 4 and 5, §8 step 8).
//
// WHAT THIS IS FOR. A check and a finish both start without a warm thread to lose, so the router may pick freely
// there. This file makes the two choices and writes the two briefs. It does not call a model and does not change
// what anyone sends: it answers "who would check this, and who would write it" from the options `routeCall` already
// priced, and the runtime records the answer (shadow) or acts on it (enforce).
//
// HOW IT WAS DERIVED. Rule 4: the checker gets the work and what it claims, not the thread, and comes from a
// different family from the builder's, because a checker that shares the builder's model shares its blind spots.
// Rule 5: the content can come from anywhere; the words the user reads come from one model, the same one for the
// whole run, so a reply is not stitched from several voices.
//
// WHAT WOULD CHANGE IT. The vendor-family table is data, edited when a new vendor appears. Which writer is best for
// which language has no public measure yet: `preferred` is the owner's list, and without one the best-quality option
// wins. The ledger's record of checks that caught something tunes when a check is worth its price (phase F).
//
// PURE. No clock, no I/O.

import { routeCall, type RouteCallParams } from "./thalamus-route-call.js";
import type {
  Answered,
  CallDecision,
  OutcomeState,
  PricedOption,
  StepRead,
} from "./thalamus-v4-types.js";

/** Model-id patterns to vendor lineage. The lineage, not the provider: `claude-code` and `anthropic` are one family. */
const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude/i, "anthropic"],
  [/(^|[^a-z])(gpt|o[134])([^a-z]|$)|codex|chatgpt/i, "openai"],
  [/grok/i, "xai"],
  [/gemini|gemma/i, "google"],
  [/kimi|moonshot/i, "moonshot"],
  [/qwen|qwq/i, "alibaba"],
  [/deepseek/i, "deepseek"],
  [/llama/i, "meta"],
  [/mistral|mixtral|codestral/i, "mistral"],
  [/glm|zhipu/i, "zhipu"],
  [/minimax/i, "minimax"],
];

/** The vendor lineage of a `provider/model` route key; the provider itself when the model id says nothing. */
export function vendorFamilyOf(routeKey: string): string {
  const slash = routeKey.indexOf("/");
  const provider = slash > 0 ? routeKey.slice(0, slash) : "";
  const model = slash >= 0 ? routeKey.slice(slash + 1) : routeKey;
  for (const [re, family] of FAMILY_PATTERNS) if (re.test(model)) return family;
  return provider || model;
}

const sure = <T>(value: T): Answered<T> => ({ value, conf: 1, source: "local" });

/**
 * The decision at a fresh point: a check or a finish is a new call that starts with a brief and no warm thread, so
 * the step is reshaped (kind, the item in hand, no run after it) and the feed is the brief alone. Everything else
 * (task read, vetoes, privacy, dial, supplies, cache) is the run's own.
 *
 * A hand-picked model gets nothing here: a check adds a second model's opinion the user did not ask for, and a
 * rewrite replaces the writer they chose. Undefined then, like `routeCall` when nothing survives the vetoes.
 */
export function freshPointDecision(
  base: RouteCallParams,
  kind: "check" | "write" | "read",
  briefTokens: number,
): CallDecision | undefined {
  if (base.handPicked) return undefined;
  const tokens = Math.max(1, Math.floor(briefTokens));
  return routeCall({
    ...base,
    id: `${base.id}:${kind}`,
    step: {
      ...base.step,
      id: `${base.step.id}:${kind}`,
      kind: sure(kind),
      // A reader only condenses; a check and a finish carry the weight of the answer.
      depth: sure(kind === "read" ? ("routine" as const) : ("deep" as const)),
      needs: sure("item" as const),
      runLength: sure(0 as const),
      commitsOrClaims: sure(false),
      parallelOk: {},
    },
    outcome: undefined,
    freshPoint: true,
    hasLongResult: false,
    feedTokens: { thread: tokens, brief: tokens },
  });
}

export type CheckNeed = {
  check: boolean;
  why: "commits-or-claims" | "outcome-check" | "is-a-check" | "none";
};

/**
 * Does this step need a check by another family? A step that commits to something outside the conversation or states
 * a fact others will rely on does. A step that IS a check is not checked again. An unsure read arrives here already
 * cautious (the cautious value of `commitsOrClaims` is true), so doubt leads to a check, never away from one.
 */
export function needsCheck(p: { step: StepRead; outcome?: OutcomeState }): CheckNeed {
  if (p.step.kind.value === "check") return { check: false, why: "is-a-check" };
  if (p.outcome === "check") return { check: true, why: "outcome-check" };
  if (p.step.commitsOrClaims.value) return { check: true, why: "commits-or-claims" };
  return { check: false, why: "none" };
}

export type CheckerPick = {
  option?: PricedOption;
  builderFamily: string;
  family?: string;
  reason: "picked" | "no-other-family" | "no-brief-option";
};

const byPrice = (a: PricedOption, b: PricedOption): number =>
  Number(a.parts.unanchored) - Number(b.parts.unanchored) ||
  a.runPrice - b.runPrice ||
  b.quality - a.quality;

/**
 * The cheapest option from a DIFFERENT family that clears the bar, fed the brief (the work and its claim). With no
 * other family among the options the answer is "none", never the builder's own family: an unchecked claim is
 * recorded as unchecked, not passed off as checked.
 */
export function pickChecker(p: {
  builderKey: string;
  options: readonly PricedOption[];
  /** The quality the unit needs, from the dial. */
  minQuality?: number;
}): CheckerPick {
  const builderFamily = vendorFamilyOf(p.builderKey);
  const brief = p.options.filter((o) => o.feed === "brief");
  if (brief.length === 0) return { builderFamily, reason: "no-brief-option" };
  const other = brief.filter((o) => vendorFamilyOf(o.rung.key) !== builderFamily);
  if (other.length === 0) return { builderFamily, reason: "no-other-family" };
  const bar = p.minQuality ?? 0;
  const clearing = other.filter((o) => o.quality >= bar).sort(byPrice);
  // If none clears the bar, the strongest other-family option: a weaker check still beats none, and the record says so.
  const option =
    clearing[0] ?? [...other].sort((a, b) => b.quality - a.quality || byPrice(a, b))[0];
  return { option, builderFamily, family: vendorFamilyOf(option.rung.key), reason: "picked" };
}

/** Keep the head and the tail of a long text; the middle is what a checker can best do without. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const mark = "\n[... clipped ...]\n";
  const keep = Math.max(0, max - mark.length);
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + mark + text.slice(text.length - (keep - head));
}

/** What the checker is handed: the work and what it claims. The thread is not part of it. */
export function checkBrief(p: { work: string; claim: string; maxChars?: number }): string {
  const max = p.maxChars ?? 12_000;
  const claim = clipMiddle(p.claim.trim(), Math.floor(max / 4));
  const work = clipMiddle(p.work.trim(), max - claim.length);
  return [
    "Another model produced the work below and makes the claim below. Check whether the work supports the claim.",
    "Begin your reply with the single word HOLDS if the work supports the claim, or PROBLEMS: followed by what is wrong, unsupported or missing, quoting the part of the work you mean. Do not rewrite the work.",
    `CLAIM:\n${claim}`,
    `WORK:\n${work}`,
  ].join("\n\n");
}

export type Language = "en" | "es" | "ca" | "unknown";

const STOP: Record<Exclude<Language, "unknown">, ReadonlySet<string>> = {
  en: new Set(
    "the and of to is in that it for with as was on are this be have not but you your at from".split(
      " ",
    ),
  ),
  es: new Set(
    "el la los las de que y en un una por con para es no se su al lo como más pero sus le ya o este".split(
      " ",
    ),
  ),
  ca: new Set(
    "el la els les de que i en un una per amb és no es seu al lo com més però seus ja o aquest això".split(
      " ",
    ),
  ),
};

/** A cheap guess at the language of a text, from stop words. "unknown" when nothing stands out. */
export function guessLanguage(text: string): Language {
  const words = text.toLowerCase().match(/[a-zàáâãäçèéêëìíîïñòóôõöùúûü·]+/g) ?? [];
  if (words.length < 6) return "unknown";
  const score: Record<string, number> = { en: 0, es: 0, ca: 0 };
  for (const w of words)
    for (const [lang, set] of Object.entries(STOP)) if (set.has(w)) score[lang] += 1;
  // "el", "la", "de", "que", "en" are shared by es and ca; the words only one has decide between them.
  const caOnly = words.filter((w) =>
    ["és", "això", "amb", "però", "aquest", "els", "les", "per", "i"].includes(w),
  ).length;
  const esOnly = words.filter((w) =>
    ["es", "está", "con", "pero", "este", "los", "las", "por", "y", "un"].includes(w),
  ).length;
  if (caOnly + esOnly >= 2 && score.es + score.ca >= score.en) return caOnly > esOnly ? "ca" : "es";
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] >= 2 ? (best[0] as Language) : "unknown";
}

export type WriterPick = {
  option?: PricedOption;
  basis: "already" | "preferred" | "best-quality" | "none";
};

/**
 * The one writer for a run. Once chosen it stays (`already`), as long as it is still an option, so a reply is never
 * stitched from several voices. Otherwise the owner's preferred list, in order; otherwise the best quality, price
 * breaking ties. Fed the brief: the content to put into words, not the thread.
 */
export function pickWriter(p: {
  options: readonly PricedOption[];
  already?: string;
  preferred?: readonly string[];
}): WriterPick {
  const brief = p.options.filter((o) => o.feed === "brief");
  if (brief.length === 0) return { basis: "none" };
  const strongestOf = (key: string) =>
    brief.filter((o) => o.rung.key === key).sort((a, b) => b.quality - a.quality)[0];
  if (p.already) {
    const kept = strongestOf(p.already);
    if (kept) return { option: kept, basis: "already" };
  }
  for (const key of p.preferred ?? []) {
    const hit = strongestOf(key);
    if (hit) return { option: hit, basis: "preferred" };
  }
  const best = [...brief].sort((a, b) => b.quality - a.quality || byPrice(a, b))[0];
  return { option: best, basis: "best-quality" };
}

/** What the writer is handed: the content, the language, and the rules that keep it faithful. */
export function finishBrief(p: { content: string; language: Language; maxChars?: number }): string {
  const lang =
    p.language === "unknown"
      ? "the language the content is already in"
      : { en: "English", es: "Spanish", ca: "Catalan" }[p.language];
  return [
    `Put the content below into the words the user will read, in ${lang}, in one plain voice.`,
    "Keep every fact, number, name, path, command and code block exactly as it is. Do not add claims. Do not shorten away detail the user asked for.",
    `CONTENT:\n${clipMiddle(p.content.trim(), p.maxChars ?? 16_000)}`,
  ].join("\n\n");
}

export type CheckVerdict = { verdict: "holds" | "problems" | "unclear"; detail: string };

/** The checker's answer as a decision. Anything that does not start with the agreed word is "unclear" and changes nothing. */
export function parseCheckVerdict(text: string): CheckVerdict {
  const t = text.trim();
  if (/^HOLDS\b/i.test(t))
    return { verdict: "holds", detail: t.replace(/^HOLDS\b[:.\s-]*/i, "").trim() };
  if (/^PROBLEMS?\b/i.test(t))
    return { verdict: "problems", detail: t.replace(/^PROBLEMS?\b[:\s-]*/i, "").trim() };
  return { verdict: "unclear", detail: t };
}

const FENCE = /```/g;
const LITERAL_FACTS = /https?:\/\/[^\s)\]>"']+|`[^`\n]{1,120}`/g;
const NUMBER = /\d[\d.,]*\d|\d/g;
/** The numbers of three digits or more in a text, as bare digits: "1,204" and "1204" are the same number. */
const bigNumbers = (t: string): Set<string> =>
  new Set((t.match(NUMBER) ?? []).map((n) => n.replace(/[.,]/g, "")).filter((n) => n.length >= 3));

/**
 * Did a rewrite keep what the original said? Every code fence, URL, inline code span and number of three digits or more
 * (compared as digits, so "1,204" and "1204" are one number) in the original must still be in the rewrite, and the length must stay within reason. A rewrite that fails is thrown
 * away and the original is sent: one writer is a matter of voice, never a licence to lose a fact.
 */
export function rewriteKeepsFacts(
  original: string,
  rewrite: string,
): { ok: boolean; reason?: string } {
  if (rewrite.trim().length === 0) return { ok: false, reason: "empty" };
  const fences = (t: string) => (t.match(FENCE) ?? []).length;
  if (fences(original) !== fences(rewrite)) return { ok: false, reason: "code-fences-differ" };
  const ratio = rewrite.length / Math.max(1, original.length);
  if (ratio < 0.4 || ratio > 2.5) return { ok: false, reason: "length-out-of-range" };
  for (const fact of new Set(original.match(LITERAL_FACTS) ?? [])) {
    if (!rewrite.includes(fact)) return { ok: false, reason: `lost:${fact.slice(0, 40)}` };
  }
  const kept = bigNumbers(rewrite);
  for (const n of bigNumbers(original)) {
    if (!kept.has(n)) return { ok: false, reason: `lost:number:${n.slice(0, 20)}` };
  }
  return { ok: true };
}
