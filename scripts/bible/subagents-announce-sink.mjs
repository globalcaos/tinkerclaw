#!/usr/bin/env node
/**
 * subagents-and-recipes.md — "announce-misdelivery fix pinned (2026-08-04)".
 *
 * The optic is the AUTHORITY; this script is one ENCODING of it. When they disagree, the optic is
 * right and this file is the bug.
 *
 * THE INVARIANT. A subagent spawned without a parent tab must announce into a headless
 * `agent:<agentId>:orchestrator` sink, never onto the human's live Main tab. Three things hold it up:
 *   1. src/agents/headless-requester-session-key.ts still mints the orchestrator sink shape;
 *   2. neither spawn CLI carries a default `agent:main:main` parent IN CODE;
 *   3. the server side references headless-requester-session-key, so the alias fallback cannot
 *      silently land announcements on Main.
 *
 * WHY THIS IS A SCRIPT AND NOT A SUBSTRING TEST. The inline version asserted
 * `"agent:main:main" not in source`, and on 2026-08-04 it went red against a tree where the
 * invariant HELD — because both CLIs contain that literal inside a COMMENT that documents its
 * removal:
 *
 *     scripts/openclaw-spawn-subagent.mjs:61
 *       // NO default parent (2026-08-04). The old literal "agent:main:main" made every ...
 *     scripts/openclaw-orchestrate.mjs:87
 *       // sink rather than the old "agent:main:main", which silently claimed the human ...
 *
 * A check that cannot tell code from prose punishes the very comment that explains the fix, and
 * teaches the next author to delete the explanation to get green. This is the third instance of
 * that shape in one day: the ONNX execution-provider guard matched the comment describing the bug
 * it guarded, and fork-integrity asserted on source TEXT so a header mentioning a symbol satisfied
 * it vacuously. Strip comments, then match.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(path.join(repoRoot, p), "utf8");

/** Remove block and line comments so a literal in prose cannot trip a code assertion. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // the [^:] guard keeps "https://" intact
}

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};

// 1 — the sink module still mints the orchestrator shape.
const sink = read("src/agents/headless-requester-session-key.ts");
check(
  sink.includes("orchestrator"),
  "headless-requester-session-key.ts lost the agent:<agentId>:orchestrator sink shape",
);

// 2 — no default main-tab parent in the spawn CLIs' CODE (comments about it are welcome).
for (const cli of ["scripts/openclaw-spawn-subagent.mjs", "scripts/openclaw-orchestrate.mjs"]) {
  const code = stripComments(read(cli));
  check(
    !code.includes("agent:main:main"),
    `${cli} re-grew the agent:main:main literal in CODE — tab-less spawns would announce onto the human Main tab again`,
  );
}

// 3 — the server side routes through the sink resolver.
const rpc = read("src/fork/subagents-rpc.ts");
const spawn = read("src/agents/subagent-spawn.ts");
check(
  rpc.includes("headless-requester-session-key") ||
    spawn.includes("headless-requester-session-key"),
  "neither subagents-rpc.ts nor subagent-spawn.ts references headless-requester-session-key — the server-side alias fallback would land announcements on the live Main tab again",
);

if (failures.length) {
  console.error("announce-misdelivery invariant broken:\n");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  "announce sink: orchestrator shape intact, no default main-tab parent in CLI code, server-side resolver wired.",
);
