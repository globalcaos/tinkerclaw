#!/usr/bin/env node
/**
 * session-naming.md u7 — a tab name has an ORIGIN (fortune / auto / manual) and the origin, not
 * the string, decides whether the turn-end auto-titler may touch it.
 *
 * The CONTRACT lives in TINKER_UI_DESIGN_BIBLE/session-naming.md and is the authority; this file is
 * only its executable encoding (FOUNDATION.md, "Three different jobs, three different homes": the
 * bible EXPLAINS, the running code ENFORCES, `scripts/bible/*.mjs` CHECKS that the two agree).
 *
 * WHY (2026-09-15, the architect: "If I rename manually one tab to be called something, it should not
 * change magically later"): before u7 one boolean, `titleLocked`, covered BOTH a hand-typed name
 * and a model-generated one, so the turn-end trigger (`tabTurns % TAB_TITLE_INTERVAL === 0`)
 * renamed both every 5 turns. u7 adds `Tab.titleKind` and a pure policy module:
 *   fortune → name at the first prompt (retry on any turn while still wearing the cookie)
 *   auto    → re-ask every interval; land the answer ONLY if the subject shifted
 *   manual  → never; only the explicit right-click Auto-name moves it back to auto
 *
 * Usage: node scripts/bible/session-naming-title-kind.mjs
 * Exit 0 = the bible still matches the code. Exit 1 = drift, with the reason on stderr.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const appPath = path.join(repoRoot, "tinker-ui", "src", "app.ts");
const policyPath = path.join(repoRoot, "tinker-ui", "src", "tab-title-policy.ts");
const testPath = path.join(repoRoot, "tinker-ui", "src", "tab-title-policy.test.ts");

const failures = [];
const check = (ok, msg) => {
  if (!ok) {
    failures.push(msg);
  }
  return ok;
};

check(
  existsSync(testPath),
  "tinker-ui/src/tab-title-policy.test.ts is gone — the rule is untested",
);

if (
  check(existsSync(policyPath), "tinker-ui/src/tab-title-policy.ts is gone (session-naming.md u7)")
) {
  const policy = readFileSync(policyPath, "utf8");
  check(
    /export type TitleKind = "fortune" \| "auto" \| "manual"/.test(policy),
    "TitleKind must be exactly fortune | auto | manual",
  );
  check(
    policy.includes("export function turnEndTitleAction"),
    "turnEndTitleAction (the turn-end trigger rule) missing",
  );
  // manual → never. The rule must short-circuit on manual before any turn arithmetic.
  const fn = /export function turnEndTitleAction\([\s\S]*?\n\}/.exec(policy);
  if (check(fn, "turnEndTitleAction body not found")) {
    check(
      /if \(kind === "manual"\)\s*\{?\s*return null;/.test(fn[0]),
      "turnEndTitleAction must return null for a manual name before anything else",
    );
  }
  check(policy.includes("export function sameSubject"), "sameSubject (auto refresh no-op) missing");
  check(
    policy.includes("export function resolveTitleKind"),
    "resolveTitleKind (legacy-tab migration, locked ⇒ manual) missing",
  );
}

if (check(existsSync(appPath), "tinker-ui/src/app.ts is gone")) {
  const app = readFileSync(appPath, "utf8");
  check(app.includes("titleKind?: TitleKind"), "Tab.titleKind field missing from the Tab model");
  check(
    app.includes('from "./tab-title-policy.js"'),
    "app.ts must import the policy module, not re-encode the rule inline",
  );
  // The turn-end handler decides through the policy, never through the old bare arithmetic.
  check(app.includes("turnEndTitleAction({"), "turn-end handler must call turnEndTitleAction");
  check(
    !/tabTurns === 1 \|\| tabTurns % TAB_TITLE_INTERVAL === 0/.test(app),
    "the pre-u7 bare trigger (turn 1 || every 5 turns, blind to origin) is back",
  );
  // The three transitions, each at its write site.
  check(app.includes('tab.titleKind = "manual"'), "openTabRename must stamp titleKind = manual");
  check(
    app.includes('tab.titleKind = "auto"'),
    "generateTabTitle must stamp titleKind = auto on success",
  );
  check(app.includes('titleKind: "fortune"'), "createTab must stamp titleKind = fortune");
  // An auto refresh keeps the name when the subject did not shift.
  check(
    app.includes("isRefresh && sameSubject(tab.title, title)"),
    "generateTabTitle must treat a same-subject answer on refresh as a no-op",
  );
  // The explicit menu action is the one manual→auto path.
  check(
    app.includes('generateTabTitle(t, { reason: "menu" })'),
    'the right-click Auto-name action must call generateTabTitle with reason "menu"',
  );
}

if (failures.length) {
  console.error(
    "session-naming.md u7: the title-origin contract drifted.\n" +
      "A manual name is never auto-renamed; an auto name refreshes only on a subject shift;\n" +
      "a fortune cookie is named at the first prompt.\n",
  );
  for (const f of failures) {
    console.error(`  ✗ ${f}`);
  }
  process.exit(1);
}
