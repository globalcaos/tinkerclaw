#!/usr/bin/env node
/**
 * architecture.md V3 — "the cron wake target is reachable ONLY through the injected resolver" —
 * made executable.
 *
 * The RULE lives in TINKER_UI_DESIGN_BIBLE/architecture.md and is the authority. This file is only
 * one ENCODING of it, deliberately kept out of the markdown (FOUNDATION.md, "Three different jobs,
 * three different homes": explain in the bible, enforce in running code, CHECK in
 * scripts/bible/*.mjs behind a one-line `cmd:` pointer).
 *
 * What makes this check unusual, and why it lives in architecture.md rather than the duplicate
 * ledger: the defect it guards leaves NO duplicate symbol to grep for. `resolveCronWakeTarget`
 * existed and was correct on 2026-08-03; a new cron wake lane simply called `runCronWakeOnce`
 * directly and re-broke the 2026-07-25 wake-target defect (repaired in e09ba8d4c1e). The defence is
 * not the helper's existence — it is the helper being the only reachable path. A symbol ledger
 * cannot express an unreachability property, so both halves are asserted here:
 *
 *   POSITIVE — every wake dep server-cron.ts hands out resolves its target through the helper. The
 *              floor is 4 because 4 deps take `opts` today (requestCronWakeNow, runCronWakeOnce and
 *              the two above them). It is a FLOOR, not a target: a fifth wake dep that routes
 *              correctly keeps this green, and one that does not turns it red.
 *   NEGATIVE — the timer never acquires the wake functions for itself. `src/cron/service/timer.ts`
 *              must reach them only through `state.deps.*`; the moment it can import them, the
 *              shortcut is one keystroke away and nothing downstream would notice.
 *
 * Ported from architecture.md's frontmatter 2026-08-04 with the negative half widened: the inline
 * version scanned only braced `import { … } from "…"` statements, so a default import, a namespace
 * import or a dynamic `import("…/heartbeat-wake.js")` would have walked straight past it. Same
 * invariant, no longer dependent on which import form the next author happens to type.
 *
 * When this script and architecture.md disagree, architecture.md is right and this file is the bug.
 *
 * Usage:
 *   node scripts/bible/architecture-cron-wake-injection.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Same contract as Python's `assert cond, msg`: message to stderr, non-zero exit. */
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

const MIN_ROUTED_DEPS = 4;
const WAKE_FNS = /\b(?:runCronWakeOnce|requestCronWake)\b/;
/** Any import STATEMENT form — braced, default, namespace, type-only — up to its own specifier. */
const IMPORT_STMT = /(?:^|\n)[ \t]*import\b[^;]*?from\s*["'][^"']+["']/g;
const DYNAMIC_WAKE_IMPORT = /import\s*\(\s*["']([^"']*heartbeat-wake[^"']*)["']\s*\)/g;

const cron = readFileSync(path.join(repoRoot, "src/gateway/server-cron.ts"), "utf8");
const routed = cron.match(/resolveCronWakeTarget\(opts\)/g)?.length ?? 0;
must(
  routed >= MIN_ROUTED_DEPS,
  `only ${routed} wake dep(s) route through resolveCronWakeTarget (expected >= ${MIN_ROUTED_DEPS}). ` +
    "A lane that resolves its own target re-breaks the 2026-07-25 defect — see architecture.md V3.",
);

const timerRel = "src/cron/service/timer.ts";
const timer = readFileSync(path.join(repoRoot, timerRel), "utf8");

const bound = (timer.match(IMPORT_STMT) ?? []).filter((stmt) => WAKE_FNS.test(stmt));
must(
  !bound.length,
  `${timerRel} now IMPORTS the wake functions: ${JSON.stringify(bound)} — that is exactly what ` +
    "re-broke the fixed bug on 2026-08-03. Injected deps only (state.deps.*).",
);

const dynamic = [...timer.matchAll(DYNAMIC_WAKE_IMPORT)].map((m) => m[1]);
must(
  !dynamic.length,
  `${timerRel} dynamically imports the wake module: ${JSON.stringify(dynamic)} — deferring the ` +
    "import does not make the shortcut legal. Injected deps only (state.deps.*).",
);

console.log(
  `architecture V3: ${routed} wake dep(s) route through resolveCronWakeTarget; ${timerRel} ` +
    "imports none of them, statically or dynamically.",
);
