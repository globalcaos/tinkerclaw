// One ranked result per task (Broca retrieval v2, phase E).
//
// WHAT THIS IS FOR. The Thalamus short list and Broca's matcher hook used to read the same prompt and decide on their
// own. This module holds what both share: whether a prompt is owed any recommendation, which text is ranked, how long
// the lists may be, how a ranking becomes a short list, the one line the owner sees, and when a USE may seed a plan.
// It is pure: no clock, no I/O, no process state (the once-per-run slot is `src/infra/thalamus-task-ranking.ts`).
//
// DERIVED FROM the 2026-10-06 build charter, phase E: "one ranked result per task feeds BOTH ... a plan is seeded only
// from a USE with high confidence; INSPIRE never seeds anything ... never attach the block to a runtime-generated
// prompt ... cap the lists: USE at most 3, INSPIRE at most 3 ... a context-free follow-up is ranked on the previous user
// turn's text, or skipped."
//
// WHAT WOULD CHANGE IT. A week of ledger rows split by mode and source (phase F) that shows a cap or the seeding
// threshold costing hits; a gateway that hands hooks real provenance for every prompt, which would retire the text rules.

import type { RankedEntry, RankResult } from "./enhancement-rank.js";
import { isRuntimeNotice, taskText } from "./enhancement-text.js";
import type { Shortlist, ShortlistEntry } from "./thalamus-enhancements.js";

export const MAX_USE = 3;
export const MAX_INSPIRE = 3;
/** A USE seeds a plan only from a Jev answer at least this sure. Local order never seeds on its own. */
export const SEED_CONFIDENCE = 0.6;
/** A request with fewer words than this and no card named is a follow-up whose meaning is in the turn before it. */
export const FOLLOW_UP_WORDS = 6;

export type SkipWhy =
  | "off"
  | "subagent-or-cron"
  | "heartbeat"
  | "provenance"
  | "notice"
  | "empty"
  | "follow-up-no-context"
  | "no-candidates"
  /** Jev judged nothing and the old local list would show nothing: recall's order alone is no recommendation (phase E, replay section 11). */
  | "local-quiet"
  | "error";

// ─── is a recommendation owed to this prompt? ────────────────────────────────────────────────────────────────

export type PromptFacts = {
  text: string;
  sessionKey?: string;
  trigger?: string;
  /** `inputProvenance.kind` of the run when the gateway recorded one: external_user, inter_session, internal_system. */
  provenanceKind?: string;
};

/** A Tinker tab or the main chat: the only places a person types a task. `agent:main:tinker:<id>`, `agent:main:main`. */
export function isInteractiveSession(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  const kind = sessionKey.split(":")[2];
  return kind === undefined || kind === "tinker" || kind === "webchat" || kind === "main";
}

/**
 * Whether a recommendation block may be attached to this prompt. Provenance metadata decides first, where the gateway
 * recorded it. The text rules (`isRuntimeNotice`: `[System`, `⟦AGENT`, `<task-notification>`, internal-context blocks,
 * `System (untrusted):`, …) cover the prompts that carry no provenance.
 */
export function recommendable(p: PromptFacts): { ok: true } | { ok: false; why: SkipWhy } {
  if (!p.sessionKey || p.sessionKey.includes(":subagent:") || !isInteractiveSession(p.sessionKey))
    return { ok: false, why: "subagent-or-cron" };
  if (p.trigger === "cron") return { ok: false, why: "subagent-or-cron" };
  if (p.trigger === "heartbeat") return { ok: false, why: "heartbeat" };
  if (p.provenanceKind && p.provenanceKind !== "external_user")
    return { ok: false, why: "provenance" };
  if (!taskText(p.text)) return { ok: false, why: "empty" };
  if (isRuntimeNotice(p.text)) return { ok: false, why: "notice" };
  return { ok: true };
}

// ─── which text is ranked ────────────────────────────────────────────────────────────────────────────────────

const wordCount = (s: string): number => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/**
 * The text to rank. A request under `FOLLOW_UP_WORDS` words that names no card ("Make the update land") has no subject of
 * its own, so the previous user turn is ranked instead; with none to lean on it is skipped. A previous turn that is itself
 * a runtime notice is no help.
 */
export function rankTextFor(
  text: string,
  previousUserText: string | undefined,
  namesCard: (cleaned: string) => boolean,
): { text: string; basis: "own" | "previous" } | { skip: "follow-up-no-context" } {
  const cleaned = taskText(text);
  if (wordCount(cleaned) >= FOLLOW_UP_WORDS || namesCard(cleaned)) {
    return { text: cleaned, basis: "own" };
  }
  const prev = previousUserText ? taskText(previousUserText) : "";
  if (prev && !isRuntimeNotice(previousUserText ?? "") && wordCount(prev) >= FOLLOW_UP_WORDS)
    return { text: prev, basis: "previous" };
  return { skip: "follow-up-no-context" };
}

/** The text of a message's content: a string, or the text blocks of a block list. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      typeof b === "string"
        ? b
        : typeof (b as { text?: unknown })?.text === "string"
          ? (b as { text: string }).text
          : "",
    )
    .join("");
}

/**
 * The user turn before the current one, for a request that has no subject of its own. `messages` is the session history as a
 * hook is handed it; a last user message equal to the current prompt is the prompt itself and is passed over.
 */
export function previousUserTextOf(
  messages: unknown,
  currentPrompt: string,
  maxChars = 4000,
): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const now = norm(currentPrompt);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (!m || m.role !== "user") continue;
    const t = contentText(m.content);
    if (!t || norm(t) === now) continue;
    return t.slice(0, maxChars);
  }
  return undefined;
}

// ─── the lists ──────────────────────────────────────────────────────────────────────────────────────────────

export function capResult(r: RankResult): RankResult {
  return { ...r, use: r.use.slice(0, MAX_USE), inspire: r.inspire.slice(0, MAX_INSPIRE) };
}

/** The ranking the two readers share, or the reason there is none. */
export type TaskRanking =
  | { ranked: true; runId: string; basis: "own" | "previous"; result: RankResult }
  | { ranked: false; runId: string; why: SkipWhy };

const entryFit = (e: RankedEntry): ShortlistEntry["fit"] =>
  e.source === "jev"
    ? { value: e.mode === "USE" ? "made-for" : "by-structure", source: "jev", conf: e.modeScore }
    : undefined;

/**
 * The short list from a ranking: USE entries first, then INSPIRE, each with its mode, section and who chose it. The fit
 * kinds are the existing ones (a USE is `made-for`, an INSPIRE `by-structure`); nothing new is invented.
 */
export function shortlistFromResult(r: RankResult): Shortlist {
  const entries: ShortlistEntry[] = [...r.use, ...r.inspire].map((e, i) => ({
    cardId: e.cardId,
    rank: i + 1,
    prob: e.source === "jev" ? (e.mode === "USE" ? e.score : e.modeScore) : 0,
    ...(entryFit(e) ? { fit: entryFit(e) } : {}),
    mode: e.mode,
    source: e.source,
    ...(e.section ? { section: e.section } : {}),
  }));
  const topUse = r.use.find((e) => e.source === "jev");
  return {
    entries,
    noneFitsProb: entries.length === 0 ? 1 : topUse ? Math.max(0, 1 - topUse.score) : 1,
    shown: entries.length > 0,
    reason: entries.length > 0 ? "shown" : "empty",
    source: r.source === "local" ? "local" : "jev",
  };
}

// ─── the line the owner sees ────────────────────────────────────────────────────────────────────────────────

const label = (src: "jev" | "mixed" | "local"): string => (src === "local" ? "local" : "Jev");

/**
 * "Use: A, B · Inspiration: C (§ Section) · source: Jev". A group with nothing in it is left out; with nothing at all there
 * is no line. `source` is `Jev` when Jev made the list or any part of it, `local` when none of it is Jev's.
 */
export function adviceLine(r: RankResult, nameOf: (cardId: string) => string): string | undefined {
  const name = (id: string): string =>
    nameOf(id)
      .replace(/[\r\n]+/g, " ")
      .trim() || id;
  const parts: string[] = [];
  if (r.use.length > 0) parts.push(`Use: ${r.use.map((e) => name(e.cardId)).join(", ")}`);
  if (r.inspire.length > 0)
    parts.push(
      `Inspiration: ${r.inspire
        .map((e) =>
          e.section ? `${name(e.cardId)} (§ ${e.section.replace(/\s+/g, " ")})` : name(e.cardId),
        )
        .join(", ")}`,
    );
  if (parts.length === 0) return undefined;
  return [...parts, `source: ${label(r.source)}`].join(" · ");
}

// ─── when a plan may be seeded ──────────────────────────────────────────────────────────────────────────────

/**
 * The card ids a plan may be seeded from: USE entries, and only ones Jev chose with a share of at least `SEED_CONFIDENCE`.
 * An INSPIRE entry never seeds anything, and a local entry never does either: its order is recall's, not a judgement.
 */
export function seedableCards(r: RankResult): string[] {
  return r.use.filter((e) => e.source === "jev" && e.score >= SEED_CONFIDENCE).map((e) => e.cardId);
}

/** The slug a recipe card id (`recipe:acme-coding`) names, or undefined for a card that is not a recipe. */
export const recipeSlugOf = (cardId: string): string | undefined =>
  cardId.startsWith("recipe:") ? cardId.slice("recipe:".length) : undefined;
