#!/usr/bin/env node
// `pnpm test [targets…]` (FORK 2026-10-09).
//
// Since fork commit fe6588643b0 (2026-05-11) the script was
// `node scripts/test-projects.mjs && node scripts/test-invariants.mjs`. pnpm appends its arguments
// to the LAST command of a script, so `pnpm test <file>` ran the WHOLE suite and handed the file to
// the invariants: a 6-test bridge file ran past two minutes (2026-10-09, seen in the process's own
// command line). Targets now go to test-projects.mjs. The bible invariants still run after a full
// `pnpm test`, never after a targeted one.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function run(script, scriptArgs) {
  const res = spawnSync(process.execPath, [path.join(here, script), ...scriptArgs], {
    stdio: "inherit",
  });
  return res.status ?? 1;
}

const tests = run("test-projects.mjs", args);
if (tests !== 0 || args.length > 0) {
  process.exit(tests);
}
process.exit(run("test-invariants.mjs", []));
