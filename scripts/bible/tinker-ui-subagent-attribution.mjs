#!/usr/bin/env node
/**
 * tinker-ui.md §5.8L — subagent→tab attribution has ONE derivation.
 *
 * The RULE lives in TINKER_UI_DESIGN_BIBLE/tinker-ui.md §5.8L and is the authority; this file is
 * only its executable encoding. It lives here rather than in that file's YAML frontmatter per
 * FOUNDATION.md, "Three different jobs, three different homes": the bible EXPLAINS, the running
 * code ENFORCES, and `scripts/bible/*.mjs` CHECKS that the two still agree. Job 3 is CI — it wants
 * linting, review and its own negative test, none of which a program pasted into frontmatter can
 * have. When this script and tinker-ui.md disagree, tinker-ui.md is right and this file is the bug.
 *
 * WHY IT ASSERTS WHAT IT ASSERTS (2026-08-03 rewrite — do not undo):
 *   The previous version asserted the rule was INLINED in chatEventIsSubagentOfView's body
 *   (`subagentOwnerTab.get(evtKey)` and friends, read straight out of that function). On
 *   2026-07-28b the rule was extracted into the shared, tested module subagent-attribution.ts and
 *   the lookups became INJECTED deps — which is design principle #18 being obeyed. The check was
 *   asserting the SHAPE OF THE BUG it had been written to catch, so the very refactor that fixed
 *   the bug turned the gate red. It now asserts the INVARIANT, not the layout:
 *     1. the shared module exists and exports the one derivation;
 *     2. BOTH call sites delegate to it and neither re-derives the rule;
 *     3. the deps object is wired to the real ownership map and the sibling-tab-count guard,
 *        so delegation is not cosmetic.
 *   Cross-tab bleed (a subagent event painted into a tab that does not own it) is the failure this
 *   guards; see reference_tab_bleed_subagent_attribution.
 *
 * Usage: node scripts/bible/tinker-ui-subagent-attribution.mjs
 * Exit 0 = the bible still matches the code. Exit 1 = drift, with the reason on stderr.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from THIS file's location, never from $HOME: the check must hold in a git worktree or a
// clone on another machine, which is FOUNDATION #9 (bounded in space) applied to the gate itself.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const uiSrc = path.join(repoRoot, "tinker-ui", "src");

const failures = [];
const check = (ok, msg) => {
  if (!ok) {
    failures.push(msg);
  }
  return ok;
};

const modPath = path.join(uiSrc, "subagent-attribution.ts");
if (check(existsSync(modPath), "the shared attribution module is gone (bible 5.8L)")) {
  const mod = readFileSync(modPath, "utf8");
  check(
    mod.includes("export function subagentBelongsToViewedTab"),
    "subagentBelongsToViewedTab missing",
  );
}

const appPath = path.join(uiSrc, "app.ts");
if (check(existsSync(appPath), "tinker-ui/src/app.ts is gone (bible 5.8L)")) {
  const app = readFileSync(appPath, "utf8");

  for (const sym of [
    "subagentOwnerTab",
    "function recordSubagentOwner",
    "recordSubagentOwner(",
    "attachedTabCountForRoot",
  ]) {
    check(app.includes(sym), `${sym} missing in app.ts (bible 5.8L)`);
  }

  // BOTH call sites must delegate; neither may re-derive the rule.
  for (const fn of ["chatEventIsSubagentOfView", "isSubagentOfViewedSession"]) {
    const body = new RegExp(`function ${fn}\\([\\s\\S]{0,1200}?\\n\\}`).exec(app);
    if (!check(body, `${fn} not found (bible 5.8L)`)) {
      continue;
    }
    check(
      body[0].includes("subagentBelongsToViewedTab("),
      `${fn} must delegate to the shared rule, not re-derive it (design principle #18)`,
    );
  }

  // …and the shared rule must be fed the real ownership + sibling-count lookups, or "delegation"
  // is a call that decides nothing.
  const deps = /subagentAttributionDeps[\s\S]{0,600}?\n\};/.exec(app);
  if (check(deps, "subagentAttributionDeps object not found (bible 5.8L)")) {
    check(
      deps[0].includes("subagentOwnerTab.get("),
      "deps must resolve ownership from subagentOwnerTab",
    );
    check(
      deps[0].includes("attachedTabCountForRoot("),
      "deps must supply the sibling-tab count guard",
    );
  }
}

if (failures.length) {
  console.error(
    "tinker-ui.md §5.8L: subagent→tab attribution drifted from the bible.\n" +
      "The rule must have ONE derivation (tinker-ui/src/subagent-attribution.ts) that both call\n" +
      "sites delegate to; re-deriving it inline is how cross-tab bleed came back.\n",
  );
  for (const f of failures) {
    console.error(`  ✗ ${f}`);
  }
  process.exit(1);
}

console.log(
  "§5.8L: one shared rule, both call sites delegate, deps wired to ownership + sibling count.",
);
