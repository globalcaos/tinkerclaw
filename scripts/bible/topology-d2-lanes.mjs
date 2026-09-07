#!/usr/bin/env node
/**
 * topology.md D2 — the command-lane diagram — made executable.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/topology.md and is the authority.
 *
 *   --check=ids      every lane D2 draws is still NAMED in src/process/lanes.ts and still
 *                    CONFIGURED by applyGatewayLaneConcurrency in src/gateway/server-lanes.ts, and
 *                    all four concurrency sources still feed it. A lane the diagram draws but
 *                    nothing configures silently falls back to a default nobody chose.
 *   --check=nesting  the 2026-07-22 stuck-tabs don't-regress. The per-session lane is the OUTER
 *                    wrapper (ordering within one chat/tab) and the global lane the INNER one
 *                    (cross-session admission). A run therefore HOLDS its session slot while it
 *                    waits for a global slot, which is exactly what contains a wedge to its own
 *                    tab. Drawn inside-out, one wedged tab freezes every other tab — which is the
 *                    incident this rule was written after.
 *
 * The nesting check re-DERIVES the order from run.ts by comparing where `return enqueueSession(`
 * appears against `return enqueueGlobal(`, rather than trusting the line numbers quoted in the
 * prose. A line number in a document goes stale without anyone noticing; an offset comparison
 * cannot.
 *
 * Source-only: it reads files and never contacts a gateway. FOUNDATION.md §"Three different jobs,
 * three different homes" is why this encoding lives in scripts/bible/ and not in YAML frontmatter.
 *
 * When this script and topology.md disagree, topology.md is right and this file is the bug.
 *
 * Usage:
 *   node scripts/bible/topology-d2-lanes.mjs                 # both checks
 *   node scripts/bible/topology-d2-lanes.mjs --check=ids
 *   node scripts/bible/topology-d2-lanes.mjs --check=nesting
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SERVER_LANES = "src/gateway/server-lanes.ts";
const LANE_IDS = "src/process/lanes.ts";
const RUN = "src/agents/embedded-agent-runner/run.ts";
const RUNNER_LANES = "src/agents/embedded-agent-runner/lanes.ts";
const COMPACT = "src/agents/embedded-agent-runner/compact.queued.ts";

const problems = [];
const cache = new Map();

function read(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
  let text = null;
  try {
    text = readFileSync(path.join(repoRoot, relPath), "utf8");
  } catch {
    text = null;
  }
  cache.set(relPath, text);
  return text;
}

function mustContain(relPath, needle, whatBreaks) {
  const text = read(relPath);
  if (text === null) {
    problems.push(`${relPath} is unreadable — ${whatBreaks}`);
    return;
  }
  if (!text.includes(needle)) {
    problems.push(`${relPath} no longer contains \`${needle}\` — ${whatBreaks}`);
  }
}

function checkIds() {
  for (const sym of ["Sessions", "Main", "Cron", "CronNested", "Subagent"]) {
    mustContain(
      SERVER_LANES,
      `CommandLane.${sym}`,
      `applyGatewayLaneConcurrency no longer sets CommandLane.${sym} — D2 draws a lane nothing configures`,
    );
  }
  for (const [sym, id] of [
    ["Sessions", "sessions"],
    ["Main", "main"],
    ["CronNested", "cron-nested"],
    ["Subagent", "subagent"],
  ]) {
    mustContain(
      LANE_IDS,
      `${sym} = "${id}"`,
      `lane id '${id}' was renamed — every config key and log line D2 labels with it is stale`,
    );
  }
  for (const fn of [
    "resolveSessionsMaxConcurrent",
    "resolveAgentMaxConcurrent",
    "resolveSubagentMaxConcurrent",
  ]) {
    mustContain(
      SERVER_LANES,
      fn,
      `${fn} no longer feeds a lane — D2's config-key labels are stale`,
    );
  }
  mustContain(
    SERVER_LANES,
    "maxConcurrentRuns",
    "cron.maxConcurrentRuns no longer feeds the cron lanes — D2's LCRONN box is stale",
  );
}

function checkNesting() {
  const runSrc = read(RUN);
  if (runSrc === null) {
    problems.push(`${RUN} is unreadable — D2's nesting claim is unverifiable`);
  } else {
    const outer = runSrc.indexOf("return enqueueSession(");
    const inner = runSrc.indexOf("return enqueueGlobal(");
    if (outer < 0) {
      problems.push(`${RUN} no longer calls \`return enqueueSession(\` — D2's OUTER lane is gone`);
    } else if (inner < 0) {
      problems.push(`${RUN} no longer calls \`return enqueueGlobal(\` — D2's INNER lane is gone`);
    } else if (inner < outer) {
      problems.push(
        `${RUN} nests enqueueGlobal OUTSIDE enqueueSession — D2 is drawn inside-out. A run would ` +
          "release its session slot while waiting for admission, so a wedge stops being contained to " +
          "its own tab. This IS the 2026-07-22 stuck-tabs shape.",
      );
    }
  }
  mustContain(
    COMPACT,
    "enqueueCommandInLane(sessionLane, () =>",
    "compact.queued.ts no longer wraps the global lane inside the session lane — the second call site drifted from the first",
  );
  mustContain(
    RUNNER_LANES,
    "cleaned ? cleaned : CommandLane.Sessions",
    "tab runs no longer default to the 'sessions' lane — this IS the 2026-07-22 stuck-tabs regression: they would fall back to shared 'main' and one wedge would freeze every tab",
  );
  mustContain(
    RUNNER_LANES,
    "CommandLane.CronNested",
    "the cron -> cron-nested remap is gone — a cron job's inner LLM work would re-enter the lane the job already holds, which is the deadlock D2's anti-deadlock edge documents",
  );
}

const which = (process.argv.find((a) => a.startsWith("--check=")) ?? "").slice(8);
if (which && which !== "ids" && which !== "nesting") {
  console.error(`unknown --check=${which} (expected: ids | nesting, or omit for both)`);
  process.exit(2);
}

if (which !== "nesting") checkIds();
if (which !== "ids") checkNesting();

if (problems.length) {
  console.error("topology.md D2 drifted from the code it cites:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (which === "ids") {
  console.log(
    "D2 ids: every lane the diagram draws is still named and configured; all four concurrency sources match.",
  );
} else if (which === "nesting") {
  console.log(
    "D2 nesting: session-outer / global-inner intact (derived from run.ts, not from a line number); tab runs still default to 'sessions'.",
  );
} else {
  console.log(
    "D2: lane ids + concurrency sources match the diagram, and session-outer / global-inner nesting is intact.",
  );
}
