#!/usr/bin/env node
/**
 * session-naming.md u4 — a clone KEEPS its parent's title. This check is INVERTED on purpose.
 *
 * The CONTRACT lives in TINKER_UI_DESIGN_BIBLE/session-naming.md and is the authority; this file is
 * only its executable encoding. It lives here rather than in that file's YAML frontmatter per
 * FOUNDATION.md, "Three different jobs, three different homes": the bible EXPLAINS, the running
 * code ENFORCES, and `scripts/bible/*.mjs` CHECKS that the two still agree. When this script and
 * session-naming.md disagree, session-naming.md is right and this file is the bug.
 *
 * HISTORY — why the assertion points the other way now (do not "restore" it):
 *   u4 (2026-06-25) shipped clone auto-naming as an explicit kick: a freshly cloned tab emits no
 *   turn-end event, so it was never titled, and `cloneTab()` set a module-level
 *   `pendingTitleKickTabId` that `loadChat()` cashed in once the buffer refilled.
 *   On 2026-06-26 that kick was REMOVED ON PURPOSE: it fired before the user had said anything in
 *   the clone and so "wiped the clone's identity before the user had even used it"
 *   (tinker-ui/src/app.ts:10083). The contract inverted — a clone now inherits its parent's
 *   doubled-icon title and renames later through the ordinary turn-end titler, like any other tab.
 *   The frontmatter check did NOT invert with it: it went on asserting `pendingTitleKickTabId`,
 *   i.e. demanding the deliberately reverted behaviour back, until it was flipped on 2026-08-03.
 *   A check that outlives its decision is worse than no check — it argues for the bug.
 *
 * So this asserts the REMOVAL stays removed, plus the positive half that still holds (the client
 * titles through the sessions.suggestTitle RPC).
 *
 * Usage: node scripts/bible/session-naming-clone-title.mjs
 * Exit 0 = the bible still matches the code. Exit 1 = drift, with the reason on stderr.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from THIS file's location, never from $HOME: the check must hold in a git worktree or a
// clone on another machine, which is FOUNDATION #9 (bounded in space) applied to the gate itself.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const appPath = path.join(repoRoot, "tinker-ui", "src", "app.ts");

const failures = [];
const check = (ok, msg) => {
  if (!ok) {
    failures.push(msg);
  }
  return ok;
};

if (check(existsSync(appPath), "tinker-ui/src/app.ts is gone (session-naming.md u4)")) {
  const app = readFileSync(appPath, "utf8");

  check(
    app.includes("spawnTitleViaBridge") && app.includes("sessions.suggestTitle"),
    "client must title via the sessions.suggestTitle RPC",
  );

  // The reverted behaviour must not come back under its old name…
  check(
    !app.includes("pendingTitleKickTabId"),
    "the clone auto-title kick is back — it wiped clone identity on creation (2026-06-26)",
  );

  // …and cloneTab must not title the clone it just made.
  const cloneTab = /function cloneTab\([\s\S]{0,4000}?\n\}/.exec(app);
  if (check(cloneTab, "cloneTab not found")) {
    check(
      !cloneTab[0].includes("spawnTitleViaBridge"),
      "cloneTab must not kick a title; the clone renames at turn end (app.ts:10083)",
    );
  }
}

if (failures.length) {
  console.error(
    "session-naming.md u4: the clone-title contract drifted.\n" +
      "A clone KEEPS its parent's doubled-icon title and renames at turn end. The 2026-06-26\n" +
      "removal of the creation-time kick is the contract, not an accident to be repaired.\n",
  );
  for (const f of failures) {
    console.error(`  ✗ ${f}`);
  }
  process.exit(1);
}

console.log("u4: clone keeps its parent title (no creation-time kick); titling runs via the RPC.");
