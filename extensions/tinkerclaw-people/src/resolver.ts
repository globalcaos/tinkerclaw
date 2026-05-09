/**
 * FORK: tinkerclaw-people — name resolver.
 *
 * Maps a free-text query (email, E.164, LID, or name fragment) to a slug.
 * Match order: email → phone → LID → exact name (case-insensitive) → fuzzy
 * name (Levenshtein <= 2). Logs the chosen path for observability.
 */
import type { AliasMap } from "./store.js";

export type ResolveResult = { slug: string; displayName: string } | null;

export type ResolveLog = (msg: string) => void;

const NOOP_LOG: ResolveLog = () => {};

function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function digitsOnly(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const v0 = new Array<number>(bl + 1);
  const v1 = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) v0[j] = j;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a.charCodeAt(i) === b.charCodeAt(j) ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= bl; j++) v0[j] = v1[j];
  }
  return v0[bl];
}

export function resolveQuery(
  aliases: AliasMap,
  query: string,
  log: ResolveLog = NOOP_LOG,
): ResolveResult {
  const raw = query.trim();
  if (!raw) {
    log("[people-resolver] empty query");
    return null;
  }
  const lower = raw.toLowerCase();
  const norm = normalize(raw);
  const queryDigits = digitsOnly(raw);

  // 1) email match
  if (raw.includes("@") && !raw.includes("@s.whatsapp.net") && !raw.includes("@lid")) {
    for (const [slug, alias] of Object.entries(aliases)) {
      if (alias.emails?.some((e) => e.toLowerCase() === lower)) {
        log(`[people-resolver] email match: ${raw} -> ${slug}`);
        return { slug, displayName: alias.displayName };
      }
    }
  }

  // 2) phone match (digits-only compare; matches +34..., 34..., or any suffix overlap >= 9 digits)
  if (queryDigits.length >= 6) {
    for (const [slug, alias] of Object.entries(aliases)) {
      for (const phone of alias.phones ?? []) {
        const pd = digitsOnly(phone);
        if (
          pd === queryDigits ||
          (pd.length >= 9 && queryDigits.length >= 9 && pd.endsWith(queryDigits.slice(-9)))
        ) {
          log(`[people-resolver] phone match: ${raw} -> ${slug}`);
          return { slug, displayName: alias.displayName };
        }
      }
    }
  }

  // 3) LID match
  if (raw.includes("@lid") || raw.includes("@s.whatsapp.net")) {
    for (const [slug, alias] of Object.entries(aliases)) {
      if (alias.lids?.some((l) => l.toLowerCase() === lower)) {
        log(`[people-resolver] lid match: ${raw} -> ${slug}`);
        return { slug, displayName: alias.displayName };
      }
    }
  }

  // 4) exact name match (case-insensitive, accent-folded) against names + displayName
  for (const [slug, alias] of Object.entries(aliases)) {
    const candidates = [alias.displayName, ...(alias.names ?? [])];
    if (candidates.some((c) => c && normalize(c) === norm)) {
      log(`[people-resolver] exact name match: ${raw} -> ${slug}`);
      return { slug, displayName: alias.displayName };
    }
  }

  // 4b) substring/firstname (no fuzz, but tolerate e.g. "Iván" matching "Iván Núñez")
  for (const [slug, alias] of Object.entries(aliases)) {
    const candidates = [alias.displayName, ...(alias.names ?? [])];
    if (
      candidates.some(
        (c) => c && (normalize(c).split(/\s+/)[0] === norm || normalize(c).startsWith(norm + " ")),
      )
    ) {
      log(`[people-resolver] firstname match: ${raw} -> ${slug}`);
      return { slug, displayName: alias.displayName };
    }
  }

  // 5) fuzzy name (Levenshtein <= 2 over names)
  let best: { slug: string; displayName: string; dist: number } | null = null;
  for (const [slug, alias] of Object.entries(aliases)) {
    const candidates = [alias.displayName, ...(alias.names ?? [])];
    for (const c of candidates) {
      if (!c) continue;
      const d = levenshtein(norm, normalize(c));
      if (d <= 2 && (!best || d < best.dist)) {
        best = { slug, displayName: alias.displayName, dist: d };
      }
    }
  }
  if (best) {
    log(`[people-resolver] fuzzy match (dist=${best.dist}): ${raw} -> ${best.slug}`);
    return { slug: best.slug, displayName: best.displayName };
  }

  log(`[people-resolver] no match: ${raw}`);
  return null;
}
