/**
 * ENGRAM — Daily evolution manifest writer (Upgrades 1 + 4, human-in-the-loop).
 *
 * All procedural-evolution outputs (recipe-mutation proposals, strategy-switch
 * proposals) are GATED, not applied. They land in a daily JSONL manifest for
 * human review — the single audit surface (paper §7.1).
 *
 * Path: <baseDir>/recipe-mutations/<YYYY-MM-DD>.jsonl  (per the consolidate-cli
 * path convention; reused for strategy switches with a `type` discriminator).
 *
 * FORK-ISOLATED: unique to our fork.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MutationProposal } from "./recipe-evolution.js";
import type { SwitchDecision } from "./strategy-switch.js";

export type ManifestEntry =
  | { type: "recipe_mutation"; at: string; proposal: MutationProposal }
  | { type: "strategy_switch"; at: string; decision: SwitchDecision };

function manifestPath(baseDir: string, dateISO: string): string {
  const dateStr = dateISO.slice(0, 10);
  return join(baseDir, "recipe-mutations", `${dateStr}.jsonl`);
}

export function appendManifestEntries(
  baseDir: string,
  entries: ManifestEntry[],
  dateISO: string = new Date().toISOString(),
): string | null {
  if (entries.length === 0) {
    return null;
  }
  const path = manifestPath(baseDir, dateISO);
  mkdirSync(join(baseDir, "recipe-mutations"), { recursive: true });
  for (const entry of entries) {
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  }
  return path;
}

export function recipeMutationEntries(
  proposals: MutationProposal[],
  at: string = new Date().toISOString(),
): ManifestEntry[] {
  return proposals.map((proposal) => ({ type: "recipe_mutation", at, proposal }));
}

export function strategySwitchEntries(
  decisions: SwitchDecision[],
  at: string = new Date().toISOString(),
): ManifestEntry[] {
  return decisions.map((decision) => ({ type: "strategy_switch", at, decision }));
}
