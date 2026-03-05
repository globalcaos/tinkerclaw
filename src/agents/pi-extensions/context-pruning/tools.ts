/**
 * FORK: context-pruning/tools — Tool name matching predicate for pruning eligibility
 *
 * Builds a predicate function that determines whether a given tool's results are
 * eligible for pruning, based on allow/deny glob patterns from the pruning config.
 * Deny patterns take priority; if no allow patterns are specified, all non-denied
 * tools are prunable. Tool names are normalized to lowercase before matching.
 *
 * Wired in by: imported by pruner.ts as the default tool predicate, and by runtime.ts
 * when constructing the per-session runtime value via makeToolPrunablePredicate().
 */
import { compileGlobPatterns, matchesAnyGlobPattern } from "../../glob-pattern.js";
import type { ContextPruningToolMatch } from "./settings.js";

function normalizeGlob(value: string) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function makeToolPrunablePredicate(
  match: ContextPruningToolMatch,
): (toolName: string) => boolean {
  const deny = compileGlobPatterns({ raw: match.deny, normalize: normalizeGlob });
  const allow = compileGlobPatterns({ raw: match.allow, normalize: normalizeGlob });

  return (toolName: string) => {
    const normalized = normalizeGlob(toolName);
    if (matchesAnyGlobPattern(normalized, deny)) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return matchesAnyGlobPattern(normalized, allow);
  };
}
