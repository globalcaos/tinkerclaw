#!/usr/bin/env node
/**
 * topology.md §"Fork RPC bundles (gateway server-methods)" — made executable, source-only.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/topology.md and is the authority. In words: every
 * fork RPC bundle is spread into `coreGatewayHandlers` in src/gateway/server-methods.ts (one
 * `...handlersObject` per bundle, the upstream pattern), and each bundle is a
 * `GatewayRequestHandlers` map whose string KEYS ARE the wire method names. This optic owns that
 * registration map; probes.md owns how to CALL each one; config-shape.md owns the config keys that
 * gate them.
 *
 * WHY THIS IS SOURCE-ONLY (2026-08-04). Until now the same three facts — U3 fork.memory.search,
 * U4 fork.strategy.switch.list, U6 fork.skill.search — were asserted by shelling out to
 * `openclaw gateway call …` from the optic's frontmatter. That coupled the truth of a DOCUMENT to
 * a running daemon: 4-18s per call, a yellow SKIP whenever the gateway was down, and — the actual
 * defect — a straight duplicate of probes.md, which already carries those exact live probes in its
 * own `verify:` block and its Live-probes table. Two owners for one fact is the drift the bible
 * exists to prevent. Registration is a source fact and is asserted here; "and it answers" is a
 * liveness fact and stays in probes.md, where it has a single owner.
 *
 * FOUNDATION.md §"Three different jobs, three different homes" is why this encoding lives in
 * scripts/bible/ instead of in YAML frontmatter.
 *
 * When this script and topology.md disagree, topology.md is right and this file is the bug.
 *
 * Usage:
 *   node scripts/bible/topology-fork-rpc-registration.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY = "src/gateway/server-methods.ts";

/**
 * One row per bundle in topology.md's "Fork RPC bundles" table. `methods` are the wire method
 * names the table claims — they must exist as quoted keys in the bundle's own source.
 */
const BUNDLES = [
  {
    exportName: "forkStrategyHandlers",
    source: "src/gateway/server-methods/engram-strategy.ts",
    upgrade: "U4 (J5)",
    methods: [
      "fork.strategy.switch.list",
      "fork.strategy.switch.apply",
      "fork.strategy.switch.review",
    ],
  },
  {
    exportName: "forkSkillHandlers",
    source: "src/fork/skill-rpc.ts",
    upgrade: "U6 (J5+J2) / SS3 (J16)",
    methods: ["fork.skill.search", "fork.skill.recordOutcome", "fork.skill.put"],
  },
  {
    exportName: "forkMemoryHandlers",
    source: "src/fork/memory-rpc.ts",
    upgrade: "U3 (J2+J14)",
    methods: ["fork.memory.search", "fork.engram.consolidate.run"],
  },
];

/**
 * The param contracts topology.md states in prose under "Param contracts". These are the guards
 * that make the difference between `{ok:true}` and INVALID_REQUEST, so the prose is only true for
 * as long as the guards are in the code.
 */
const PARAM_CONTRACTS = [
  {
    source: "src/fork/skill-rpc.ts",
    needle: "fork.skill.search: 'query' required.",
    claim: "fork.skill.search REQUIRES a query param",
  },
  {
    source: "src/fork/memory-rpc.ts",
    needle: "fork.memory.search: 'query' required.",
    claim: "fork.memory.search REQUIRES a query param",
  },
  {
    source: "src/fork/memory-rpc.ts",
    needle: "temporalMode",
    claim: "fork.memory.search threads temporalMode (the U3 bi-temporal read path)",
  },
];

/**
 * A bundle counts as REGISTERED only when its spread sits alone on its own line inside the
 * `coreGatewayHandlers` literal — `  ...forkMemoryHandlers,`. Matching the bare substring is not
 * enough and the negative test proved it: `// ...forkMemoryHandlers,` still contains the name, so
 * a commented-out registration read as green. Anchoring to the start of the line rejects both `//`
 * and a `*` continuation inside a block comment. If upstream ever moves these spreads inline this
 * goes red rather than quietly wrong, which is the correct failure direction for a gate.
 */
const spreadPattern = (exportName) =>
  new RegExp(String.raw`^[ \t]*\.\.\.${exportName}\s*,?\s*$`, "m");

/** Same idea for a wire method: it must be a KEY in the handlers map, not a mention in a comment. */
const methodKeyPattern = (method) =>
  new RegExp(String.raw`^[ \t]*"${method.replace(/\./g, "\\.")}"\s*:`, "m");

const problems = [];
const sources = new Map();

function read(relPath) {
  if (sources.has(relPath)) return sources.get(relPath);
  let text = null;
  try {
    text = readFileSync(path.join(repoRoot, relPath), "utf8");
  } catch {
    text = null;
  }
  sources.set(relPath, text);
  return text;
}

const registry = read(REGISTRY);
if (registry === null) {
  problems.push(`${REGISTRY} is unreadable — the registration map topology.md documents is gone`);
}

let methodCount = 0;
for (const bundle of BUNDLES) {
  if (registry !== null && !spreadPattern(bundle.exportName).test(registry)) {
    const commentedOut = registry.includes(`...${bundle.exportName}`);
    problems.push(
      `${bundle.exportName} (${bundle.upgrade}) is no longer spread into coreGatewayHandlers in ${REGISTRY} — ` +
        "topology.md's fork-RPC table lists a bundle the gateway never registers" +
        (commentedOut
          ? ". The name still appears in the file, so it looks COMMENTED OUT rather than deleted"
          : ""),
    );
  }
  const src = read(bundle.source);
  if (src === null) {
    problems.push(`${bundle.source} is unreadable — ${bundle.exportName} has no definition`);
    continue;
  }
  if (!src.includes(`export const ${bundle.exportName}`)) {
    problems.push(`${bundle.source} no longer exports ${bundle.exportName}`);
  }
  for (const method of bundle.methods) {
    methodCount += 1;
    if (!methodKeyPattern(method).test(src)) {
      problems.push(
        `${bundle.source} no longer defines the wire method "${method}" as a key in ${bundle.exportName} — ` +
          "topology.md's table claims it",
      );
    }
  }
}

for (const contract of PARAM_CONTRACTS) {
  const src = read(contract.source);
  if (src === null || !src.includes(contract.needle)) {
    problems.push(
      `${contract.source} no longer contains ${JSON.stringify(contract.needle)} — ` +
        `topology.md's stated param contract ("${contract.claim}") is stale`,
    );
  }
}

if (problems.length) {
  console.error("topology.md's fork-RPC registration map drifted from src/:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nNote this check never contacted a gateway. A failure here means the SOURCE changed, not that\n" +
      "the daemon is down — the live round-trips for these RPCs are owned by probes.md.",
  );
  process.exit(1);
}

console.log(
  `fork RPC bundles: ${BUNDLES.length} spread into coreGatewayHandlers, ${methodCount} wire methods defined, ` +
    `${PARAM_CONTRACTS.length} param contracts intact (source-only — liveness lives in probes.md).`,
);
