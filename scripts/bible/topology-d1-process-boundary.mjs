#!/usr/bin/env node
/**
 * topology.md D1 — "the process boundary" diagram — made executable.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/topology.md and is the authority. D1 draws four
 * ports and ATTRIBUTES each one to a source file; the claim this script defends is that
 * attribution, not the runtime:
 *
 *   --check=ports        18789 / 18790 / 18791 / 18792 are still declared where D1 says they are.
 *                        Three of them (18789, 18791, 18792) are surfaces of the SAME pid; 18790
 *                        belongs to a different one, the Vite dev server. Move a declaration and
 *                        the diagram starts lying about which process owns which surface.
 *   --check=relay-owner  18792 is bound by the CORE `browser` plugin, and the identically-named
 *                        fork twin `tinkerclaw-browser-relay` stays OUT of plugins.allow. Two
 *                        copies of the same server exist in this repo; only one is reachable, and
 *                        allowing both would put them in a race for one port.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: check that anything is LISTENING. "Is the gateway up?" is an
 * operational question owned by probes.md (`GET 127.0.0.1:18789/health`). It says nothing about
 * whether this document is true, and it would go yellow-SKIP on any machine without a running
 * daemon — which is precisely how a doc check turns into noise. See FOUNDATION.md §"Three
 * different jobs, three different homes".
 *
 * When this script and topology.md disagree, topology.md is right and this file is the bug.
 *
 * Usage:
 *   node scripts/bible/topology-d1-process-boundary.mjs                    # both checks
 *   node scripts/bible/topology-d1-process-boundary.mjs --check=ports
 *   node scripts/bible/topology-d1-process-boundary.mjs --check=relay-owner
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const problems = [];

/** Assert `needle` still appears in a repo-relative file, and say what D1 gets wrong if it does not. */
function mustContain(relPath, needle, whatBreaks) {
  let text;
  try {
    text = readFileSync(path.join(repoRoot, relPath), "utf8");
  } catch (err) {
    problems.push(`${relPath} is unreadable (${String(err)}) — ${whatBreaks}`);
    return;
  }
  if (!text.includes(needle)) {
    problems.push(`${relPath} no longer contains \`${needle}\` — ${whatBreaks}`);
  }
}

function checkPorts() {
  mustContain(
    "src/config/paths.ts",
    "DEFAULT_GATEWAY_PORT = 18789",
    "18789 is no longer the gateway default, so D1's GW box is attributed to the wrong file",
  );
  mustContain(
    "src/config/port-defaults.ts",
    "DEFAULT_BROWSER_CONTROL_PORT = 18791",
    "18791 is no longer the browser-control default, so D1's CTRL box is stale",
  );
  mustContain(
    "tinker-ui/vite.config.ts",
    "port: 18790",
    "the Vite dev server no longer binds 18790, so D1's SEPARATE-PROCESS box is stale",
  );
  mustContain(
    "extensions/browser/src/browser/server-lifecycle.ts",
    "DEFAULT_RELAY_PORT = 18792",
    "the CORE browser plugin no longer declares 18792, so D1 attributes the relay to the wrong owner",
  );
  mustContain(
    "extensions/tinkerclaw-browser-relay/chrome-extension/background.js",
    "18792",
    "the relay Chrome extension no longer dials 18792, so D1's inbound CHR -> RELAY edge is stale",
  );
}

function checkRelayOwner() {
  mustContain(
    "extensions/browser/src/browser/runtime-lifecycle.ts",
    "ensureExtensionRelayForProfiles",
    "nothing calls ensureExtensionRelayForProfiles, so nothing starts the relay D1 draws",
  );
  mustContain(
    "extensions/browser/src/browser/server-lifecycle.ts",
    "existing-session",
    "the relay no longer starts off an existing-session profile, so D1's attach-only note is stale",
  );
  mustContain(
    "extensions/tinkerclaw-browser-relay/index.ts",
    "const RELAY_PORT = 18792",
    "the fork relay twin changed shape — re-check which implementation actually binds 18792 before trusting the inventory row",
  );

  // Which of the two implementations is LOADED is a config fact, not a source fact, so this reads
  // the runtime config. It still contacts nothing: plugins.allow is a file.
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let allow;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    allow = new Set(config.plugins?.allow ?? []);
  } catch (err) {
    problems.push(
      `cannot read plugins.allow from ${configPath} (${String(err)}) — cannot tell which relay implementation is loaded`,
    );
    return;
  }
  if (!allow.has("browser")) {
    problems.push(
      "the core `browser` plugin left plugins.allow — nothing binds 18792 and D1's RELAY box has no owner",
    );
  }
  if (allow.has("tinkerclaw-browser-relay")) {
    problems.push(
      "the fork twin `tinkerclaw-browser-relay` joined plugins.allow — two implementations of the same relay " +
        "would race for 18792; topology.md's inventory row says NOT LOADED",
    );
  }
}

const which = (process.argv.find((a) => a.startsWith("--check=")) ?? "").slice(8);
if (which && which !== "ports" && which !== "relay-owner") {
  console.error(`unknown --check=${which} (expected: ports | relay-owner, or omit for both)`);
  process.exit(2);
}

if (which !== "relay-owner") checkPorts();
if (which !== "ports") checkRelayOwner();

if (problems.length) {
  console.error("topology.md D1 drifted from the code it cites:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (which === "ports") {
  console.log(
    "D1 ports: 18789 / 18790 / 18791 / 18792 all still declared where the diagram claims.",
  );
} else if (which === "relay-owner") {
  console.log(
    "D1 relay owner: the core browser plugin owns 18792; the tinkerclaw-browser-relay twin is still de-allowed.",
  );
} else {
  console.log(
    "D1: all four ports still declared where the diagram claims; the core browser plugin owns 18792 and the fork twin is still de-allowed.",
  );
}
