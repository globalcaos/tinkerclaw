import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Tests for the TIER1 fork-wiring replay. Dependency-free; run with:
//   node --test scripts/merge-drivers/apply-fork-wiring.test.mjs
//
// WHY THIS EXISTS: `.gitattributes` marks a set of files `merge=tier1`, and
// tier1-driver.sh resolves those by taking UPSTREAM WHOLESALE (`cp "$THEIRS"
// "$OURS"`) and then re-running apply-fork-wiring.mjs. Every line of fork
// wiring in a tier-1 file therefore survives the next upstream merge ONLY if
// this script puts it back. A fork edit landed in a tier-1 file with no
// matching patch here is not "wired" — it is scheduled for deletion, silently,
// at the next merge, with no conflict to warn anyone.
//
// Each test below feeds the script an UPSTREAM-SHAPED file (the fork hunk
// absent, the surrounding anchors present — exactly what `cp "$THEIRS"` leaves
// behind) and asserts the hunk comes back; then re-runs on the result and
// asserts it is byte-identical, because the driver runs on every merge and a
// patch that re-injects on each pass corrupts the file instead of wiring it.
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "apply-fork-wiring.mjs");

/**
 * Run apply-fork-wiring.mjs against a throwaway tree.
 *
 * The per-hunk tests do NOT assert the EXIT CODE: the script's structural
 * guards (checkPreservePaths / checkTier1ForkMarkers) legitimately set
 * exitCode 1 on a fixture that does not carry the whole repo, and every patch
 * for a file the fixture omits warns and continues by design. Their contract
 * is what lands ON DISK. The post-condition tests at the bottom are the
 * exception — they build a tree in which the exit code means one thing only.
 */
function runWiring(root) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, TINKERCLAW_DIR: root },
    encoding: "utf-8",
  });
}

function freshRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-wiring-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
  return root;
}

/**
 * The core contract, asserted the same way for every hunk:
 *   1. upstream-shaped input gets the hunk back  (re-applied)
 *   2. running again changes nothing             (idempotent)
 *   3. a tree already carrying it is untouched   (idempotent from the start)
 */
function assertRewires({ rel, upstream, wired, expect }) {
  const root = freshRoot({ [rel]: upstream, ...FILLER });
  const first = runWiring(root);
  const after = fs.readFileSync(path.join(root, rel), "utf-8");
  for (const needle of expect) {
    assert.ok(
      after.includes(needle),
      `${rel}: fork wiring NOT re-applied — missing ${JSON.stringify(needle)}\n` +
        `--- stdout ---\n${first.stdout}\n--- stderr ---\n${first.stderr}`,
    );
  }

  runWiring(root);
  const twice = fs.readFileSync(path.join(root, rel), "utf-8");
  assert.equal(twice, after, `${rel}: second run changed the file — patch is not idempotent`);

  const pristine = freshRoot({ [rel]: wired, ...FILLER });
  runWiring(pristine);
  assert.equal(
    fs.readFileSync(path.join(pristine, rel), "utf-8"),
    wired,
    `${rel}: an already-wired file was modified — patch is not idempotent`,
  );
}

// package.json is read by patchDevDeps on every run; give every fixture one
// that is already satisfied so an unrelated patch cannot perturb the file
// under test.
const SATISFIED_PKG = `${JSON.stringify(
  {
    name: "openclaw",
    devDependencies: { "@types/better-sqlite3": "^7.6.12" },
    exports: {},
  },
  null,
  2,
)}\n`;
const FILLER = { "package.json": SATISFIED_PKG };

// ---------------------------------------------------------------------------
// attempt.ts — recordRunDone (logging.md §4.6 turn rows)
// ---------------------------------------------------------------------------
const ATTEMPT_UPSTREAM = `import { foo } from "./foo.js";
import * as _forkAttemptHooks from "../../../fork/attempt-hooks.js"; // FORK: single hook entry point
import { wrapStreamFnWithLedger } from "../../../forensic/llm-ledger.js";

export async function runEmbeddedAttempt() {
    const effectiveTools = [...tools, ...filteredBundledTools];
      activeSession.agent.streamFn = wrapStreamFnWithLedger(activeSession.agent.streamFn, {
        source: "agent",
        runId: params.runId,
      });
    const diagnosticRunStartedAt = Date.now();
    let diagnosticRunCompleted = false;
    emitDiagnosticRunCompleted = (outcome, err) => {
      if (diagnosticRunCompleted) {
        return;
      }
      diagnosticRunCompleted = true;
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        ...diagnosticRunBase,
        durationMs: Date.now() - diagnosticRunStartedAt,
        outcome,
      });
    };
}
`;

test("attempt.ts — recordRunDone import + call survive an upstream merge", () => {
  assertRewires({
    rel: "src/agents/embedded-agent-runner/run/attempt.ts",
    upstream: ATTEMPT_UPSTREAM,
    wired: ATTEMPT_UPSTREAM.replace(
      "// FORK: single hook entry point\n",
      '// FORK: single hook entry point\nimport { recordRunDone } from "../../../infra/events/turn-events.js"; // FORK: run.done row\n',
    )
      .replace(
        "      diagnosticRunCompleted = true;\n",
        "      diagnosticRunCompleted = true;\n      recordRunDone(diagnosticRunBase, diagnosticRunStartedAt, outcome, err);\n",
      )
      .replace(
        'import { wrapStreamFnWithLedger } from "../../../forensic/llm-ledger.js";',
        'import { wrapStreamFnWithLedger } from "../../../forensic/llm-ledger.js";\nimport { wrapStreamFnWithCallRouter } from "../call-router.js";',
      )
      .replace(
        "        runId: params.runId,\n      });\n",
        "        runId: params.runId,\n      });\n" + ROUTER_BLOCK,
      )
      .replace(
        'import { wrapStreamFnWithCallRouter } from "../call-router.js";',
        'import { wrapStreamFnWithCallRouter } from "../call-router.js";\nimport { wrapToolsWithDigest } from "../tool-result-digest.js";',
      )
      .replace("    const effectiveTools = [...tools, ...filteredBundledTools];\n", DIGEST_BLOCK),
    expect: [
      'import { recordRunDone } from "../../../infra/events/turn-events.js";',
      "recordRunDone(diagnosticRunBase, diagnosticRunStartedAt, outcome, err);",
    ],
  });
});

// The THALAMUS v4 tool-result seam, as the patch writes it.
const DIGEST_BLOCK = `    // FORK 2026-09-30 (THALAMUS v4, unit D3): a registered digester may condense a long text tool result before it
    // enters the thread. Returns the same array when none is registered.
    const effectiveTools = wrapToolsWithDigest([...tools, ...filteredBundledTools], {
      runId: params.runId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
      trigger: params.trigger,
      provider: params.provider,
      model: params.modelId,
      api: params.model.api,
      thinkLevel: params.thinkLevel,
    });
`;

// The THALAMUS v4 per-call seam, as the patch writes it.
const ROUTER_BLOCK = `      // FORK 2026-09-30 (THALAMUS v4): a registered call router sees every call before it goes out. Returns
      // the same function when none is registered.
      activeSession.agent.streamFn = wrapStreamFnWithCallRouter(activeSession.agent.streamFn, {
        runId: params.runId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: params.agentId,
        trigger: params.trigger,
        provider: params.provider,
        model: params.modelId,
        api: params.model.api,
        thinkLevel: params.thinkLevel,
      });
`;

test("attempt.ts — the call router wrap and its import come back after the ledger wrap, once", () => {
  const rel = "src/agents/embedded-agent-runner/run/attempt.ts";
  const root = freshRoot({ [rel]: ATTEMPT_UPSTREAM, ...FILLER });
  const first = runWiring(root);
  const after = fs.readFileSync(path.join(root, rel), "utf-8");
  assert.ok(
    after.includes('import { wrapStreamFnWithCallRouter } from "../call-router.js";'),
    `import NOT restored\n${first.stdout}`,
  );
  assert.equal(
    after.split("wrapStreamFnWithCallRouter(activeSession.agent.streamFn,").length - 1,
    1,
  );
  assert.ok(
    after.indexOf("wrapStreamFnWithLedger(activeSession") <
      after.indexOf("wrapStreamFnWithCallRouter(activeSession"),
    "the router wrap must come after the ledger wrap",
  );
  runWiring(root);
  assert.equal(
    fs.readFileSync(path.join(root, rel), "utf-8"),
    after,
    "second run changed the file",
  );
});

test("attempt.ts — the tool digest wrap and its import come back, once, in place of the bare effectiveTools line", () => {
  const rel = "src/agents/embedded-agent-runner/run/attempt.ts";
  const root = freshRoot({ [rel]: ATTEMPT_UPSTREAM, ...FILLER });
  const first = runWiring(root);
  const after = fs.readFileSync(path.join(root, rel), "utf-8");
  assert.ok(
    after.includes('import { wrapToolsWithDigest } from "../tool-result-digest.js";'),
    `import NOT restored\n${first.stdout}`,
  );
  assert.equal(
    after.split("wrapToolsWithDigest([...tools, ...filteredBundledTools],").length - 1,
    1,
  );
  assert.ok(
    !after.includes("const effectiveTools = [...tools, ...filteredBundledTools];"),
    "the bare line must be replaced",
  );
  runWiring(root);
  assert.equal(
    fs.readFileSync(path.join(root, rel), "utf-8"),
    after,
    "second run changed the file",
  );
});

// ---------------------------------------------------------------------------
// package.json — ./plugin-sdk/fork-telemetry subpath export
// ---------------------------------------------------------------------------
function pkgWith(exportsObj) {
  return `${JSON.stringify(
    {
      name: "openclaw",
      devDependencies: { "@types/better-sqlite3": "^7.6.12" },
      exports: exportsObj,
    },
    null,
    2,
  )}\n`;
}

const PKG_OVERSEER = {
  "./plugin-sdk/fork-overseer-budget": {
    types: "./dist/plugin-sdk/fork-overseer-budget.d.ts",
    default: "./dist/plugin-sdk/fork-overseer-budget.js",
  },
};
const PKG_TELEMETRY = {
  "./plugin-sdk/fork-telemetry": {
    types: "./dist/plugin-sdk/fork-telemetry.d.ts",
    default: "./dist/plugin-sdk/fork-telemetry.js",
  },
};

test("package.json — ./plugin-sdk/fork-telemetry export survives an upstream merge", () => {
  const root = freshRoot({
    "package.json": pkgWith({ ...PKG_OVERSEER, "./extension-api": "./dist/extensionAPI.js" }),
  });
  const first = runWiring(root);
  const after = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  assert.deepEqual(
    after.exports["./plugin-sdk/fork-telemetry"],
    PKG_TELEMETRY["./plugin-sdk/fork-telemetry"],
    `fork-telemetry export NOT re-applied\n--- stdout ---\n${first.stdout}`,
  );
  // Position matters: the fork keeps its plugin-sdk subpaths grouped, so the
  // entry goes back beside its siblings rather than after ./extension-api.
  assert.deepEqual(Object.keys(after.exports), [
    "./plugin-sdk/fork-overseer-budget",
    "./plugin-sdk/fork-telemetry",
    "./plugin-sdk/fork-jev",
    "./plugin-sdk/fork-thalamus",
    "./plugin-sdk/fork-thalamus-runtime",
    "./extension-api",
  ]);

  const raw = fs.readFileSync(path.join(root, "package.json"), "utf-8");
  runWiring(root);
  assert.equal(
    fs.readFileSync(path.join(root, "package.json"), "utf-8"),
    raw,
    "package.json: second run changed the file — patch is not idempotent",
  );
});

// ---------------------------------------------------------------------------
// package.json + plugin-sdk-entrypoints.json — the THALAMUS v4 subpaths (2026-09-30)
// ---------------------------------------------------------------------------
test("package.json — ./plugin-sdk/fork-jev and fork-thalamus exports survive an upstream merge", () => {
  const root = freshRoot({
    "package.json": pkgWith({
      ...PKG_OVERSEER,
      ...PKG_TELEMETRY,
      "./extension-api": "./dist/extensionAPI.js",
    }),
  });
  const first = runWiring(root);
  const after = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  for (const name of ["fork-jev", "fork-thalamus", "fork-thalamus-runtime"]) {
    assert.deepEqual(
      after.exports[`./plugin-sdk/${name}`],
      { types: `./dist/plugin-sdk/${name}.d.ts`, default: `./dist/plugin-sdk/${name}.js` },
      `${name} export NOT re-applied\n--- stdout ---\n${first.stdout}`,
    );
  }
  // Beside its fork siblings, in the order the fork keeps them.
  assert.deepEqual(Object.keys(after.exports), [
    "./plugin-sdk/fork-overseer-budget",
    "./plugin-sdk/fork-telemetry",
    "./plugin-sdk/fork-jev",
    "./plugin-sdk/fork-thalamus",
    "./plugin-sdk/fork-thalamus-runtime",
    "./extension-api",
  ]);
  const raw = fs.readFileSync(path.join(root, "package.json"), "utf-8");
  runWiring(root);
  assert.equal(
    fs.readFileSync(path.join(root, "package.json"), "utf-8"),
    raw,
    "second run changed package.json",
  );
});

test("package.json — a tree that already carries both exports is left byte-identical", () => {
  const exportsObj = {
    ...PKG_TELEMETRY,
    "./plugin-sdk/fork-jev": {
      types: "./dist/plugin-sdk/fork-jev.d.ts",
      default: "./dist/plugin-sdk/fork-jev.js",
    },
    "./plugin-sdk/fork-thalamus": {
      types: "./dist/plugin-sdk/fork-thalamus.d.ts",
      default: "./dist/plugin-sdk/fork-thalamus.js",
    },
    "./plugin-sdk/fork-thalamus-runtime": {
      types: "./dist/plugin-sdk/fork-thalamus-runtime.d.ts",
      default: "./dist/plugin-sdk/fork-thalamus-runtime.js",
    },
  };
  const root = freshRoot({ "package.json": pkgWith(exportsObj) });
  const before = fs.readFileSync(path.join(root, "package.json"), "utf-8");
  runWiring(root);
  assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf-8"), before);
});

test("plugin-sdk-entrypoints.json — the two entries come back beside fork-telemetry, once", () => {
  const rel = "scripts/lib/plugin-sdk-entrypoints.json";
  const root = freshRoot({
    [rel]: `${JSON.stringify(["a", "fork-telemetry", "z"], null, 2)}\n`,
    ...FILLER,
  });
  runWiring(root);
  const after = JSON.parse(fs.readFileSync(path.join(root, rel), "utf-8"));
  assert.deepEqual(after, [
    "a",
    "fork-telemetry",
    "fork-jev",
    "fork-thalamus",
    "fork-thalamus-runtime",
    "z",
  ]);
  const raw = fs.readFileSync(path.join(root, rel), "utf-8");
  runWiring(root);
  assert.equal(fs.readFileSync(path.join(root, rel), "utf-8"), raw, "second run changed the file");
});

// ---------------------------------------------------------------------------
// tsdown.config.ts — structured-events writer worker dist entry
// ---------------------------------------------------------------------------
const TSDOWN_UPSTREAM = `function buildCoreDistEntries(): Record<string, string> {
  return {
    "memory/engram/fts-worker": "src/memory/engram/fts-worker.ts",
    "memory/engram/fts-worker-client": "src/memory/engram/fts-worker-client.ts",
  };
}
`;

test("tsdown.config.ts — writer-worker dist entry survives an upstream merge", () => {
  assertRewires({
    rel: "tsdown.config.ts",
    upstream: TSDOWN_UPSTREAM,
    wired: TSDOWN_UPSTREAM.replace(
      '    "memory/engram/fts-worker-client": "src/memory/engram/fts-worker-client.ts",\n',
      '    "memory/engram/fts-worker-client": "src/memory/engram/fts-worker-client.ts",\n' +
        "    // FORK 2026-09-24 (logging.md §9 step 3): the structured-events writer thread is started BY\n" +
        "    // PATH too (emit.ts resolveWriterWorkerEntry looks for infra/events/writer-worker.js).\n" +
        '    "infra/events/writer-worker": "src/infra/events/writer-worker.ts",\n',
    ),
    expect: ['"infra/events/writer-worker": "src/infra/events/writer-worker.ts",'],
  });
});

// ---------------------------------------------------------------------------
// sessions.ts — eviction delegation + chatAbortOps
// ---------------------------------------------------------------------------
const SESSIONS_UPSTREAM = `import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { chatHandlers } from "./chat.js";

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.reset": async () => {
    const result = await performGatewaySessionReset({
      key,
      reason,
      commandSource: "gateway:sessions.reset",
    });
  },
  "sessions.delete": async () => {
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-delete",
    });
  },
  "sessions.compact": async () => {
    if (maxLines === undefined) {
      const interruptResult = await interruptSessionRunIfActive({
        req,
        context,
      });
    }
  },
};
`;

test("sessions.ts — eviction delegation + chatAbortOps survive an upstream merge", () => {
  const root = freshRoot({
    "src/gateway/server-methods/sessions.ts": SESSIONS_UPSTREAM,
    ...FILLER,
  });
  const first = runWiring(root);
  const after = fs.readFileSync(path.join(root, "src/gateway/server-methods/sessions.ts"), "utf-8");
  const ctx = `\n--- stdout ---\n${first.stdout}\n--- stderr ---\n${first.stderr}`;
  for (const needle of [
    'import { evictSessionTranscript } from "../session-eviction.js";',
    'import { chatHandlers, createChatAbortOps } from "./chat.js";',
    "const eviction = await evictSessionTranscript({",
    "interruptRun: () =>",
  ]) {
    assert.ok(after.includes(needle), `sessions.ts: missing ${JSON.stringify(needle)}${ctx}`);
  }
  // Both mutation call sites must get the abort ops, not just the first.
  assert.equal(
    after.split("chatAbortOps: createChatAbortOps(context),").length - 1,
    2,
    `sessions.ts: expected chatAbortOps at BOTH reset and delete call sites${ctx}`,
  );

  runWiring(root);
  assert.equal(
    fs.readFileSync(path.join(root, "src/gateway/server-methods/sessions.ts"), "utf-8"),
    after,
    "sessions.ts: second run changed the file — patch is not idempotent",
  );

  const pristine = freshRoot({ "src/gateway/server-methods/sessions.ts": after, ...FILLER });
  runWiring(pristine);
  assert.equal(
    fs.readFileSync(path.join(pristine, "src/gateway/server-methods/sessions.ts"), "utf-8"),
    after,
    "sessions.ts: an already-wired file was modified — patch is not idempotent",
  );
});

// ---------------------------------------------------------------------------
// UPSTREAM'S REAL SHAPE. The fixtures above carry lines the FORK owns (the
// fts-worker dist entries, the fork-hooks import), so a patch anchored on one
// of those passes them while failing on the file a merge actually leaves.
// These shapes are trimmed from upstream/main 244450952c0 (2026-09-20).
// ---------------------------------------------------------------------------
const TSDOWN_UPSTREAM_MAIN = `function buildCoreDistEntries(): Record<string, string> {
  return {
    "llm-slug-generator": "src/hooks/llm-slug-generator.ts",
    "mcp/plugin-tools-serve": "src/mcp/plugin-tools-serve.ts",
    "mcp/openclaw-tools-serve": "src/mcp/openclaw-tools-serve.ts",
  };
}
`;

test("tsdown.config.ts — writer-worker entry comes back on upstream/main's shape (no fork fts entries)", () => {
  assertRewires({
    rel: "tsdown.config.ts",
    upstream: TSDOWN_UPSTREAM_MAIN,
    wired: TSDOWN_UPSTREAM_MAIN.replace(
      '    "mcp/plugin-tools-serve": "src/mcp/plugin-tools-serve.ts",\n',
      '    "mcp/plugin-tools-serve": "src/mcp/plugin-tools-serve.ts",\n' +
        "    // FORK 2026-09-24 (logging.md §9 step 3): the structured-events writer thread is started BY\n" +
        "    // PATH too (emit.ts resolveWriterWorkerEntry looks for infra/events/writer-worker.js).\n" +
        '    "infra/events/writer-worker": "src/infra/events/writer-worker.ts",\n',
    ),
    expect: ['"infra/events/writer-worker": "src/infra/events/writer-worker.ts",'],
  });
});

// upstream/main moved the whole run-diagnostics block behind
// startEmbeddedAttemptDiagnostics(): there is no emitDiagnosticRunCompleted
// left for the recordRunDone call to sit in, so no anchor can restore it.
const ATTEMPT_UPSTREAM_MAIN = `import { startEmbeddedAttemptDiagnostics } from "./attempt-diagnostics.js";

export async function runEmbeddedAttempt(params) {
    const { diagnosticTrace, runTrace, emitCompleted } = startEmbeddedAttemptDiagnostics(params);
    return { diagnosticTrace, runTrace, emitCompleted };
}
`;

// ---------------------------------------------------------------------------
// POST-CONDITION — the exit code tier1-driver.sh trusts.
//
// A tree holding every wave-0924 tier-1 file plus the PRESERVE paths, and no
// packages/ dir (the cross-package guard then skips). In it, a non-zero exit
// can only come from checkTier1ForkMarkers — the positive control proves it.
// ---------------------------------------------------------------------------
function postMergeTree({ attempt, sessions }) {
  const files = {
    "src/agents/embedded-agent-runner/run/attempt.ts": attempt,
    "package.json": SATISFIED_PKG,
    "scripts/lib/plugin-sdk-entrypoints.json": `${JSON.stringify(["fork-telemetry"], null, 2)}\n`,
    "tsdown.config.ts": TSDOWN_UPSTREAM_MAIN,
    "extensions/tinkerclaw-whatsapp/src/backfill/index.ts": "export {};\n",
    "extensions/tinkerclaw-whatsapp/src/history/index.ts": "export {};\n",
  };
  if (sessions !== undefined) {
    files["src/gateway/server-methods/sessions.ts"] = sessions;
  }
  return freshRoot(files);
}

test("post-condition — exits 0 when every wave hunk is restored (positive control)", () => {
  const root = postMergeTree({ attempt: ATTEMPT_UPSTREAM, sessions: SESSIONS_UPSTREAM });
  const res = runWiring(root);
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, `driver exited ${res.status} on a restorable tree\n${out}`);
  assert.ok(out.includes("TIER1 fork wiring markers all present"), out);
  assert.ok(!out.includes("TIER1 fork wiring MISSING"), out);
});

test("post-condition — exits non-zero, naming each hunk, when upstream refactored it away", () => {
  // Both hazards are real on upstream/main today: attempt.ts restructured,
  // and src/gateway/server-methods/sessions.ts no longer shipped at all.
  const root = postMergeTree({ attempt: ATTEMPT_UPSTREAM_MAIN, sessions: undefined });
  const res = runWiring(root);
  const out = `${res.stdout}${res.stderr}`;
  assert.notEqual(res.status, 0, `driver exited 0 over lost fork wiring\n${out}`);
  assert.ok(out.includes("TIER1 fork wiring MISSING"), out);
  assert.ok(
    out.includes("recordRunDone call inside emitDiagnosticRunCompleted"),
    `must name the attempt.ts hunk it could not restore\n${out}`,
  );
  assert.ok(
    out.includes("src/gateway/server-methods/sessions.ts is not readable"),
    `must name the missing sessions.ts\n${out}`,
  );
  assert.ok(out.includes("git show ORIG_HEAD:<file>"), `must say how to restore\n${out}`);
});

test("without TINKERCLAW_DIR it patches the tree it runs in, never ~/src/tinkerclaw", () => {
  // 2026-10-01: run from a build worktree without the variable, the script patched the shared checkout twice
  // (20:08, 00:27); develop's working tree then imported two files it did not have, for about ten hours.
  const root = freshRoot({
    "src/agents/embedded-agent-runner/run/attempt.ts": ATTEMPT_UPSTREAM,
    ...FILLER,
  });
  fs.mkdirSync(path.join(root, ".git"));
  const decoyHome = fs.mkdtempSync(path.join(os.tmpdir(), "fork-wiring-home-"));
  const env = { ...process.env, HOME: decoyHome };
  delete env.TINKERCLAW_DIR;
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, env, encoding: "utf-8" });
  const after = fs.readFileSync(
    path.join(root, "src/agents/embedded-agent-runner/run/attempt.ts"),
    "utf-8",
  );
  assert.ok(
    after.includes("recordRunDone("),
    `the tree it ran in was not patched\n${r.stdout}\n${r.stderr}`,
  );
  assert.equal(fs.readdirSync(decoyHome).length, 0, "it wrote under HOME");
});
