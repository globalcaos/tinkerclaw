#!/usr/bin/env node
/**
 * architecture.md §The central mechanisms — "every row's canonical module is real, and still
 * exposes what the row claims" — made executable.
 *
 * The TABLE lives in TINKER_UI_DESIGN_BIBLE/architecture.md and is the authority. This file is only
 * one ENCODING of it, deliberately kept out of the markdown (FOUNDATION.md, "Three different jobs,
 * three different homes": explain in the bible, enforce in running code, CHECK in
 * scripts/bible/*.mjs behind a one-line `cmd:` pointer).
 *
 * Two rungs, because they fail for different reasons and want different repairs:
 *
 *   RUNG 1 — the module EXISTS. A row whose file is gone means either the mechanism moved (update
 *            the row) or a problem class lost its owner, which is worse: the next agent reads a
 *            table that points nowhere and writes the second implementation.
 *   RUNG 2 — the module still exposes the ENTRY POINT the row names. Surviving a refactor that
 *            renamed the export is the quieter failure: the table still looks true.
 *
 * ONE table, two rungs, on purpose. The paths and the symbols are the same fact at two grains, and
 * architecture.md exists to say that a fact has exactly one derivation (design-principles.md #18).
 * Shipping two scripts would mean maintaining the module list twice — this optic's own golden rule,
 * broken by its own check. Not every row carries an entry point: directories, JSON manifests and
 * the ledger optic are asserted at rung 1 only.
 *
 * When this script and architecture.md disagree, architecture.md is right and this file is the bug.
 *
 * Usage:
 *   node scripts/bible/architecture-central-mechanisms.mjs           # both rungs
 *   node scripts/bible/architecture-central-mechanisms.mjs --rung=1  # existence only
 *   node scripts/bible/architecture-central-mechanisms.mjs --rung=2  # entry points only
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Same contract as Python's `assert cond, msg`: message to stderr, non-zero exit. */
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * One entry per canonical module named in architecture.md §The central mechanisms, in table order.
 * `entry` is the symbol (or literal fragment) the table claims that module exposes; rows without
 * one are asserted to exist and nothing more.
 */
const MECHANISMS = [
  {
    path: "src/process/command-queue.ts",
    entry: ["enqueueCommandInLane", "setCommandLaneConcurrency"],
  },
  { path: "src/process/lanes.ts" },
  { path: "src/gateway/server-lanes.ts", entry: ["applyGatewayLaneConcurrency"] },
  {
    path: "src/agents/embedded-agent-runner/lanes.ts",
    entry: ["resolveSessionLane", "resolveGlobalLane"],
  },
  {
    path: "src/routing/session-key.ts",
    entry: ["buildAgentMainSessionKey", "classifySessionKeyShape"],
  },
  { path: "src/config/sessions/session-key.ts", entry: ["deriveSessionKey"] },
  { path: "src/sessions/session-key-utils.ts", entry: ["parseAgentSessionKey"] },
  { path: "src/gateway/server-chat.ts", entry: ["emitChatFinal"] },
  { path: "src/gateway/server-methods/chat.ts", entry: ["broadcastChatFinal"] },
  { path: "src/memory/engram/event-store.ts", entry: ["createEventStore", "appendFileSync"] },
  { path: "src/shared/global-singleton.ts", entry: ["resolveGlobalSingleton", "resolveGlobalMap"] },
  { path: "src/infra/instrument-liveness.ts", entry: ["declareInstrument", "noteInstrumentFired"] },
  {
    path: "src/infra/algorithm-metrics.ts",
    entry: ["recordAlgorithmOutcome", "MetricProvenance"],
  },
  { path: "src/infra/agent-events.ts", entry: ["emitAgentEvent", "onAgentEvent"] },
  { path: "src/gateway/server-maintenance.ts", entry: ["logInstrumentLivenessSummary"] },
  { path: "src/agents/usage.ts", entry: ["deriveContextPromptTokens"] },
  { path: "src/config/io.ts", entry: ["createConfigIO"] },
  {
    path: "src/agents/plugin-provider-config-overlay.ts",
    entry: ["registerPluginProviderConfigOverlay"],
  },
  {
    path: "src/fork/pipeline.ts",
    entry: ["export function compose", "export function withRetry", "export function withTimeout"],
  },
  { path: "src/gateway/server-cron.ts", entry: ["resolveCronWakeTarget"] },
  { path: "src/cron/service/timer.ts" },
  { path: "src/fork/subagents-rpc.ts", entry: ["fork.subagents.spawn"] },
  // UI session-activity indication. Six reports between 2026-07-29 and 2026-08-17 came from this
  // problem class having no registered owner: each fix moved ONE surface and the next report was
  // the mirror image. The four parts are listed separately because each was, at some point, the
  // one that had drifted — a predicate, a repaint trigger, a clock, and the two client-side lanes
  // that cover what the gateway's run set structurally cannot see.
  {
    path: "tinker-ui/src/run-state.ts",
    entry: ["resolveSessionRunState", "liveRunCountsByModel", "clientRunIsFresh"],
  },
  {
    path: "tinker-ui/src/background-runs.ts",
    entry: ["noteBackgroundRunEvent", "dropBackgroundRunsForSession", "touchBackgroundRuns"],
  },
  {
    path: "tinker-ui/src/pre-model-window.ts",
    entry: ["sessionPending", "clearPreModelFor", "openPreModelWindow"],
  },
  {
    path: "tinker-ui/src/app.ts",
    entry: [
      "function repaintActivitySurfaces",
      "function activityTick",
      "const ACTIVITY_TICK_MS",
      "function tabsRunningNow",
    ],
  },
  { path: "src/plugin-sdk/memory-engram.ts" },
  { path: "scripts/lib/plugin-sdk-entrypoints.json" },
  { path: "scripts/check-no-extension-src-imports.ts" },
  { path: "extensions/tinkerclaw-tinker-bridge" },
  { path: "extensions/tinkerclaw-orca/lease-core.mjs", entry: ["linkSync", "renameSync"] },
  { path: "scripts/pii-pre-push.sh", entry: ["PII_RE"] },
  { path: "TINKER_UI_DESIGN_BIBLE/canonical-derivations.md" },
];

const rung = (process.argv.find((a) => a.startsWith("--rung=")) ?? "").slice(7);

if (rung !== "2") {
  const missing = MECHANISMS.map((m) => m.path).filter((p) => !existsSync(path.join(repoRoot, p)));
  must(
    !missing.length,
    `architecture.md names central mechanisms whose canonical module is gone: ${JSON.stringify(missing)} — ` +
      "either the mechanism moved (update the row) or a problem class lost its owner, which is worse.",
  );
  console.log(
    `architecture rung 1: ${MECHANISMS.length} canonical module(s) named in the table, all present.`,
  );
}

if (rung !== "1") {
  const claimed = MECHANISMS.filter((m) => m.entry?.length);
  const drift = [];
  for (const m of claimed) {
    const full = path.join(repoRoot, m.path);
    if (!existsSync(full)) {
      drift.push(`${m.path} is gone`);
      continue;
    }
    const src = readFileSync(full, "utf8");
    for (const needle of m.entry) {
      if (!src.includes(needle)) drift.push(`${m.path} no longer contains ${needle}`);
    }
  }
  must(!drift.length, `a central-mechanism claim drifted from the code: || ${drift.join(" || ")}`);
  console.log(
    `architecture rung 2: ${claimed.length} module(s) still expose the entry point the table claims.`,
  );
}
