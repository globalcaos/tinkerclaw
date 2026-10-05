/**
 * Keys for the learning loop (design doc §7.3): the context a false alarm is counted in, and the features a precedent
 * is matched on. Pure text processing over the situation record.
 */
import { basename } from "node:path";
import type { Situation } from "../types.js";

/** First two path components of the first target ("/work/demo/x/y" → "/work/demo"); "rel" for a relative path. */
export function dirBucket(s: Situation): string {
  const p = s.targets.value?.[0]?.path;
  if (!p) return "none";
  if (!p.startsWith("/")) return "rel";
  return `/${p.split("/").filter(Boolean).slice(0, 2).join("/")}`;
}

/** question × effect class × target kind × scratch × directory bucket: a false alarm is quieted only where it was false. */
export function contextKey(s: Situation, questionId: string): string {
  const effect = s.effectClass.value ?? "?";
  const kind = s.targets.value?.[0]?.kind ?? "none";
  const scratch = s.scratch.value === true ? "scratch" : "user";
  return `${questionId}|${effect}|${kind}|${scratch}|${dirBucket(s)}`;
}

/**
 * What novelty counts sightings of (2026-10-03): the tool and its exact first target, or the command's first word when
 * there is no target. Finer than `contextKey`, whose two-component directory bucket would make every file in a home
 * folder one "thing" and silence novelty after three steps.
 */
export function noveltyKey(s: Situation): string {
  const target = s.targets.value?.[0]?.path;
  const verb = (s.command.value ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return `${s.tool.value ?? "?"}|${target ?? verb}`;
}

/** effect class × target kind × the first word of the command: the exact-match part of a precedent. */
export function featureKey(s: Situation): string {
  const verb = (s.command.value ?? s.tool.value ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return `${s.effectClass.value ?? "?"}|${s.targets.value?.[0]?.kind ?? "none"}|${verb}`;
}

/** Normalised command tokens: lowercase words, flags dropped, paths reduced to their basename. */
export function commandTokens(s: Situation): string[] {
  const out = new Set<string>();
  for (const raw of (s.command.value ?? "").split(/\s+/)) {
    const w = raw.replace(/^["']+|["']+$/g, "");
    if (!w || w.startsWith("-")) continue;
    out.add((w.includes("/") ? basename(w) : w).toLowerCase());
  }
  for (const t of s.targets.value ?? []) out.add(basename(t.path).toLowerCase());
  return [...out].filter(Boolean).toSorted();
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}
