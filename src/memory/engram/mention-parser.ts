/**
 * U9 A-MEM Zettelkasten auto-linking: mention parser.
 *
 * Pure function module. Detects two ref classes in event content:
 *   1. Explicit `[[note-id]]` / `[[free text]]` wiki-links via /\[\[([^\]]+)\]\]/g.
 *   2. Entity refs (people / projects) by REUSING extractEntities() from
 *      entity-extraction.ts — we do not add a second NER pass.
 *
 * Output is a normalized Mention[] list. Normalization lowercases + trims
 * (mirroring the dedup() helper in entity-extraction.ts) so "Caixa Enginyers"
 * and "caixa enginyers" collapse to one target key.
 */

import { extractEntities } from "./entity-extraction.js";

export type MentionKind = "wikilink" | "entity";

export interface Mention {
  /** The raw mention text as written (wikilink inner text or entity surface form). */
  raw: string;
  /** Normalized target key: lowercased + trimmed. */
  normalized: string;
  /** Whether this came from an explicit [[wikilink]] or the entity extractor. */
  kind: MentionKind;
}

/** Match the inner text of `[[...]]`; non-greedy via [^\]] so `]]` terminates. */
const WIKILINK = /\[\[([^\]]+)\]\]/g;

/** Lowercase + trim (mirrors dedup() normalization in entity-extraction.ts). */
export function normalizeMention(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Parse all mentions out of an event's content.
 *
 * Wikilinks take precedence over entity refs when both normalize to the same
 * key (so an explicit [[link]] is never demoted to an entity). Results are
 * deduplicated by normalized key.
 */
export function parseMentions(content: string): Mention[] {
  const mentions: Mention[] = [];

  // 1. Explicit wiki-links.
  for (const match of content.matchAll(WIKILINK)) {
    const raw = match[1].trim();
    const normalized = normalizeMention(raw);
    if (!normalized) {
      continue;
    }
    mentions.push({ raw, normalized, kind: "wikilink" });
  }

  // 2. Entity refs — reuse the existing regex NER (people + projects only;
  //    dates / events / raw_keywords are too noisy to link on).
  const entities = extractEntities(content);
  for (const name of [...entities.people, ...entities.projects]) {
    const normalized = normalizeMention(name);
    if (!normalized) {
      continue;
    }
    mentions.push({ raw: name, normalized, kind: "entity" });
  }

  return dedupByNormalized(mentions);
}

/**
 * Collapse mentions sharing a normalized key. The first occurrence wins, so a
 * wikilink (parsed first) is preferred over an entity ref for the same target.
 */
function dedupByNormalized(mentions: Mention[]): Mention[] {
  const seen = new Set<string>();
  const result: Mention[] = [];
  for (const m of mentions) {
    if (seen.has(m.normalized)) {
      continue;
    }
    seen.add(m.normalized);
    result.push(m);
  }
  return result;
}
