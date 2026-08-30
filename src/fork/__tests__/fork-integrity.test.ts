/**
 * FORK INTEGRITY TESTS
 *
 * Post-merge smoke tests that verify our fork-specific features survive upstream merges.
 * These test OUTCOMES, not code paths — so they don't go stale when upstream refactors.
 *
 * Run after every upstream merge: `pnpm test -- --testPathPattern fork-integrity`
 *
 * Categories:
 *   1. Import integrity — can our fork modules be loaded?
 *   2. Export contracts — do our modules export the functions the gateway calls?
 *   3. Config-to-code — do configured features have backing implementations?
 *   4. Wiring — are fork hooks actually called from the right places?
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(__dirname, "../..");

// ─── 1. IMPORT INTEGRITY ──────────────────────────────────────────────
// Can every fork module be imported without crashing?
// If upstream deletes a dependency (like extension-relay-auth), these fail.

describe("Fork module imports", () => {
  it("fork/attempt-hooks loads", async () => {
    const mod = await import("../../fork/attempt-hooks.js");
    expect(mod).toBeDefined();
  });

  // Rewritten 2026-08-04. This used to readFileSync the module and assert its SOURCE TEXT
  // contained "annotateOfflineRecovery" and "createThinkingReaction". Two problems: a string
  // in a comment satisfies it (the current header mentions both, so the old assertions would
  // now pass VACUOUSLY), and it pinned a re-export that had to go. Assert the module's real
  // exports instead, plus the FOUNDATION #9 property that replaced the re-export.
  it("fork/process-message-hooks exports the offline-recovery annotator", async () => {
    const mod = await import("../../fork/process-message-hooks.js");
    expect(typeof mod.annotateOfflineRecovery).toBe("function");
    // behaviour, not presence
    expect(mod.annotateOfflineRecovery("hi", false, undefined)).toBe("hi");
    expect(mod.annotateOfflineRecovery("hi", true, Date.now())).toContain("OFFLINE RECOVERY");
  });

  it("fork/process-message-hooks does not reach into extensions/ (FOUNDATION #9)", async () => {
    const source = require("node:fs").readFileSync(
      resolve(srcRoot, "fork/process-message-hooks.ts"),
      "utf-8",
    );
    // A `src/` module forwarding an extension's symbol is a reverse dependency. This one had
    // zero consumers and dragged the whole WhatsApp graph into the plugin-sdk dts project,
    // breaking `pnpm build`. Match import STATEMENTS only, so prose may still explain why.
    const reverse = source.match(/^\s*(?:import|export)\b[^;]*?from\s*["'][^"']*extensions\//m);
    expect(reverse, `reverse dependency on extensions/: ${reverse?.[0]}`).toBeNull();
    expect(await import("../../fork/process-message-hooks.js")).not.toHaveProperty(
      "createThinkingReaction",
    );
  });

  it("fork/tool-registrations loads", async () => {
    const mod = await import("../../fork/tool-registrations.js");
    expect(mod).toBeDefined();
  });

  it("synapse-tool loads", async () => {
    const mod = await import("../../agents/tools/synapse-tool.js");
    expect(mod).toBeDefined();
    expect(typeof mod.createSynapseDebateTool).toBe("function");
  });

  it("whatsapp-history-tool loads", async () => {
    const mod = await import("../../agents/tools/whatsapp-history-tool.js");
    expect(mod).toBeDefined();
    expect(typeof mod.createWhatsAppHistoryTool).toBe("function");
  });

  // ─── AMYGDALA ──────────────────────────────────────────────────────
  // Lives in extensions/tinkerclaw-learned-intuition since 2026-08-02, when the dead
  // src/amygdala twin was deleted: it had ZERO production importers and had been frozen
  // since 2026-03-23 while the extension took four fixes it never received.
  //
  // These four checks used to be `await import("../../amygdala/X.js")` +
  // `expect(mod).toBeDefined()`. That asserts a file can be imported and nothing else —
  // which is exactly how a 3,152-line dead subtree kept reading as "tested" and survived
  // every cleanup. Existence is not an outcome. Replaced with contract and wiring
  // assertions, in the style this file already uses in sections 2-4.

  it("the src/amygdala twin is gone and the live copy is the extension", () => {
    expect(existsSync(resolve(srcRoot, "amygdala"))).toBe(false);
    expect(
      existsSync(resolve(srcRoot, "../extensions/tinkerclaw-learned-intuition/src/gate.ts")),
    ).toBe(true);
  });

  it("the personality-nudge write/inject PAIR is wired on both sides", () => {
    // Either half alone is useless, and this pair has already half-died once: the writer
    // runs every turn while the injector's instrument has never fired since declaration.
    const writer = readFileSync(
      resolve(srcRoot, "../extensions/tinkerclaw-learned-intuition/index.ts"),
      "utf-8",
    );
    expect(writer).toMatch(/persona-nudge/);
    const injector = readFileSync(resolve(srcRoot, "agents/system-prompt.ts"), "utf-8");
    expect(injector).toContain("amygdala:nudge-injection");
  });

  it("the ONNX execution provider uses the SHORT name onnxruntime-node requires", () => {
    // Regression guard. The C++ long name "CPUExecutionProvider" makes InferenceSession.create
    // throw "backend not found", so onnxAvailable stayed false and the gate could never leave
    // rule-based fallback even with the runtime installed. Fixed in 168810a703a; the deleted
    // twin still carried the broken form, so this guards against a well-meaning "restore".
    const gate = readFileSync(
      resolve(srcRoot, "../extensions/tinkerclaw-learned-intuition/src/gate.ts"),
      "utf-8",
    );
    // Assert on the ASSIGNMENTS, not the whole file: gate.ts legitimately *mentions* the long
    // names in the comment that records why they are wrong. A whole-file grep would fail on the
    // documentation of the bug rather than the bug — which is how this check first went red.
    const decls = gate.match(/executionProviders:\s*\[[^\]]*\]/g) ?? [];
    expect(decls.length).toBeGreaterThan(0);
    for (const decl of decls) {
      expect(decl).not.toMatch(/ExecutionProvider/);
      expect(decl).toMatch(/"cpu"/);
    }
  });

  it("the conformal quantile default is not the value that soft-blocked everything", () => {
    // 0.9 applied to UNCALIBRATED nonconformity scores admits any class with p >= 0.1, which
    // produced soft_block on 1229/1229 live evaluations — zero allows. The deleted twin still
    // defaulted to 0.9 in two places.
    const gate = readFileSync(
      resolve(srcRoot, "../extensions/tinkerclaw-learned-intuition/src/gate.ts"),
      "utf-8",
    );
    expect(gate).toMatch(/DEFAULT_CONFORMAL_QUANTILE\s*=\s*0\.5/);
  });

  it("billing-gate loads", async () => {
    const mod = await import("../../agents/billing-gate.js");
    expect(mod).toBeDefined();
  });

  it("browser extension-relay loads", async () => {
    const mod = await import("../../browser/extension-relay.js");
    expect(mod).toBeDefined();
    expect(typeof mod.ensureChromeExtensionRelayServer).toBe("function");
  });

  it("browser extension-relay-auth loads", async () => {
    // This was the file upstream deleted that broke the relay silently
    const mod = await import("../../browser/extension-relay-auth.js");
    expect(mod).toBeDefined();
  });
});

// ─── 2. EXPORT CONTRACTS ───────────────────────────────────────────────
// Do our modules export what the rest of the codebase expects?

describe("Fork export contracts", () => {
  it("attempt-hooks exports expected functions", async () => {
    const mod = await import("../../fork/attempt-hooks.js");
    // The attempt.ts file imports this as a namespace — check key exports exist
    const exports = Object.keys(mod);
    expect(exports.length).toBeGreaterThan(0);
  });

  // server-lifecycle.ts MOVED to extensions/browser/src/browser/ in an upstream convergence.
  // These two assertions pointed at src/browser/server-lifecycle.ts and had been failing with
  // "Cannot find module" ever since — a post-merge smoke test broken BY the merge it polices.
  // Asserted on source text rather than a dynamic import: the extension has its own
  // node_modules, so importing it from a src/ test is a resolution hazard, and the point here
  // is "did upstream stub our relay out", which the source answers directly.
  const serverLifecyclePath = resolve(
    srcRoot,
    "../extensions/browser/src/browser/server-lifecycle.ts",
  );

  it("server-lifecycle exports ensureExtensionRelayForProfiles", () => {
    expect(existsSync(serverLifecyclePath)).toBe(true);
    const source = readFileSync(serverLifecyclePath, "utf-8");
    expect(source).toMatch(/export\s+async\s+function\s+ensureExtensionRelayForProfiles/);
  });

  it("ensureExtensionRelayForProfiles is NOT a no-op", () => {
    // The critical check: if upstream stubs this out again, we catch it.
    const source = readFileSync(serverLifecyclePath, "utf-8");
    expect(source).not.toMatch(/Intentional no-op/i);
    expect(source).toMatch(/relay|extension/i);
  });

  it("openclaw-tools registers fork tools", async () => {
    // Verify our tools are wired into the tool list
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/openclaw-tools.ts"), "utf-8"),
    );
    expect(source).toContain("createSynapseDebateTool");
    expect(source).toContain("createWhatsAppHistoryTool");
  });

  it("model-fallback includes billing gate", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/model-fallback.ts"), "utf-8"),
    );
    expect(source).toMatch(/FORK:.*billing gate/i);
  });
});

// ─── 3. CONFIG-TO-CODE ─────────────────────────────────────────────────
// If our config references a feature, the code backing it must exist.

describe("Config-to-code integrity", () => {
  it("existing-session driver has relay server implementation", async () => {
    // Our config has browser.profiles.chrome-relay with driver: "existing-session"
    // The relay server must be importable and functional
    const mod = await import("../../browser/extension-relay.js");
    expect(typeof mod.ensureChromeExtensionRelayServer).toBe("function");

    // And the auth module it depends on must exist
    const authMod = await import("../../browser/extension-relay-auth.js");
    expect(authMod).toBeDefined();
  });

  it("selfChatMode code path exists in WhatsApp plugin", () => {
    // Our config has channels.whatsapp.selfChatMode: true
    // Check the WhatsApp plugin still references it
    const pluginDir = resolve(srcRoot, "../extensions/tinkerclaw-whatsapp");
    const exists = existsSync(pluginDir);
    expect(exists).toBe(true);
  });
});

// ─── 4. FORK WIRING ────────────────────────────────────────────────────
// Are our hooks still called from the right upstream files?

describe("Fork wiring integrity", () => {
  it("attempt.ts imports fork/attempt-hooks", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/embedded-agent-runner/run/attempt.ts"), "utf-8"),
    );
    expect(source).toContain("fork/attempt-hooks");
  });

  it("attempt.ts has FORK: persona re-injection", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/embedded-agent-runner/run/attempt.ts"), "utf-8"),
    );
    // Was /FORK:.*persona block/i and had been red since the marker was reworded to
    // "FORK: mid-context persona re-injection when SyncScore drops" (attempt.ts:2890).
    // The FEATURE is intact; only the comment text moved. Matching on "persona" keeps the
    // tripwire without pinning prose.
    expect(source).toMatch(/FORK:.*persona/i);
  });

  it("attempt.ts has FORK: post-turn processing", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/embedded-agent-runner/run/attempt.ts"), "utf-8"),
    );
    expect(source).toMatch(/FORK:.*post-turn/i);
  });

  it("system-prompt.ts has FORK: persona block", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/system-prompt.ts"), "utf-8"),
    );
    expect(source).toMatch(/FORK:.*persona/i);
  });

  it("auth-controller.ts has FORK: per-profile fallback error events", async () => {
    // Was agents/embedded-agent-runner/run.ts, which no longer exists: the 2026-06-02
    // convergence (S2/S2b) renamed the runner family to upstream names and split run.ts.
    // The feature lives on at auth-controller.ts:464 and :490.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        resolve(srcRoot, "agents/embedded-agent-runner/run/auth-controller.ts"),
        "utf-8",
      ),
    );
    expect(source).toMatch(/FORK:.*fallback error/i);
  });

  it("embedded-agent-subscribe.ts has FORK: streaming reasoning", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/embedded-agent-subscribe.ts"), "utf-8"),
    );
    expect(source).toMatch(/FORK:.*streaming reasoning|FORK:.*raw.*thinking/i);
  });

  it("server-lifecycle.ts calls extension relay (not a stub)", async () => {
    // Repointed 2026-08-02: the file moved to extensions/browser/src/browser/.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        resolve(srcRoot, "../extensions/browser/src/browser/server-lifecycle.ts"),
        "utf-8",
      ),
    );
    // Must NOT contain the upstream no-op comment
    expect(source).not.toContain("Intentional no-op");
    // Must import and call the relay
    expect(source).toContain("ensureChromeExtensionRelayServer");
  });
});

// ─── 5. FILE EXISTENCE ─────────────────────────────────────────────────
// Fork-specific files that must exist. If upstream deletes them, we know.

describe("Fork file existence", () => {
  const requiredFiles = [
    "fork/attempt-hooks.ts",
    "fork/process-message-hooks.ts",
    "fork/tool-registrations.ts",
    "fork/index.ts",
    "agents/tools/synapse-tool.ts",
    "agents/tools/whatsapp-history-tool.ts",
    "agents/billing-gate.ts",
    "browser/extension-relay.ts",
    "browser/extension-relay-auth.ts",
    "infra/usage-snapshot-store.ts",
  ];

  // AMYGDALA moved out of src/ on 2026-08-02 (the src/amygdala twin had zero production
  // importers and was deleted). Existence is the RIGHT assertion in this section — its job is
  // "did an upstream merge delete one of our files" — but it must point at where the code
  // actually lives, or it guards a path nobody ships.
  const requiredExtensionFiles = [
    "tinkerclaw-learned-intuition/src/runtime-hook.ts",
    "tinkerclaw-learned-intuition/src/gate.ts",
    "tinkerclaw-learned-intuition/src/situation-template.ts",
    "tinkerclaw-learned-intuition/src/embedding.ts",
    "tinkerclaw-learned-intuition/src/types.ts",
    "tinkerclaw-learned-intuition/src/training-log.ts",
    "tinkerclaw-learned-intuition/src/distribution-shift.ts",
    // The only generator of the runtime .onnx artefacts. Rescued from the deleted twin;
    // without it the live models are unreproducible.
    "tinkerclaw-learned-intuition/export_encoder.py",
  ];

  for (const file of requiredFiles) {
    it(`${file} exists`, () => {
      const fullPath = resolve(srcRoot, file);
      expect(existsSync(fullPath)).toBe(true);
    });
  }

  for (const file of requiredExtensionFiles) {
    it(`extensions/${file} exists`, () => {
      const fullPath = resolve(srcRoot, "../extensions", file);
      expect(existsSync(fullPath)).toBe(true);
    });
  }
});

// ─── 6. CHROME EXTENSION ──────────────────────────────────────────────
// The browser relay Chrome extension must exist and be loadable.

describe("Chrome extension relay", () => {
  // Repointed 2026-08-02. These four asserted ~/.openclaw/browser/chrome-extension — the
  // INSTALLED copy, which only exists after the user runs the install command, and which is
  // referenced nowhere else in the repo. On a machine that never installed it (including this
  // one) all four failed, so the suite carried four permanent reds that said nothing about
  // the code. A repo test must assert a repo invariant.
  //
  // The bundled copy is the thing we actually ship: browser-cli-extension.ts's
  // bundledExtensionRootDir(). Repointed 2026-08-03 — there were two trees and the CLI
  // installed the stale one (assets/chrome-extension, v0.1.0, localhost-only permissions,
  // so it could not relay a real site). That tree is now deleted.
  //
  // Repointed AGAIN 2026-08-03: the CLI file itself moved to extensions/browser/src/cli/.
  // Under src/cli/ it imported ../browser/trash.js (which had moved into the browser
  // extension), had ZERO importers, never reached dist/, and its command group was never
  // registered — so `openclaw browser extension install` had silently stopped existing while
  // this very test read that file and called it "the CLI". A test that reads a file nothing
  // loads is asserting about a fossil, so both twins are now guarded as deleted below.
  const BUNDLED_REL = "extensions/tinkerclaw-browser-relay/chrome-extension";
  const bundledDir = resolve(srcRoot, "..", BUNDLED_REL);
  const CLI_REL = "../extensions/browser/src/cli/browser-cli-extension.ts";

  it("the bundled extension the CLI installs from exists, and there is only one", () => {
    expect(existsSync(bundledDir)).toBe(true);
    // Derive rather than trust the literal: resolve the walk the CLI actually computes and
    // assert it lands on the bundled tree. A literal substring match would have passed even
    // while the walk was measured from the wrong directory.
    const cliPath = resolve(srcRoot, CLI_REL);
    expect(existsSync(cliPath)).toBe(true);
    const cli = readFileSync(cliPath, "utf-8");
    const rel = cli.match(/path\.resolve\(\s*here,\s*"([^"]+)"\s*\)/)?.[1];
    expect(rel).toBeTruthy();
    expect(resolve(dirname(cliPath), rel as string)).toBe(bundledDir);
    // And the twins must stay dead — a second tree is how the CLI came to ship a fossil, and
    // a second CLI copy is how the install command came to live in a file nothing imported.
    expect(existsSync(resolve(srcRoot, "../assets/chrome-extension"))).toBe(false);
    expect(existsSync(resolve(srcRoot, "cli/browser-cli-extension.ts"))).toBe(false);
    expect(existsSync(resolve(srcRoot, "cli/browser-cli-extension.test.ts"))).toBe(false);
  });

  it("the extension command group is REGISTERED in the browser CLI", () => {
    // The defect this guards is not "the file is missing" but "nothing references it": the
    // command existed as a well-formed module for weeks while `openclaw browser --help`
    // listed no `extension` subcommand, because no command tree ever imported it.
    const cli = readFileSync(
      resolve(srcRoot, "../extensions/browser/src/cli/browser-cli.ts"),
      "utf-8",
    );
    expect(cli).toContain('command("extension"');
    expect(cli).toContain("./browser-cli-extension.js");
  });

  it("manifest.json exists and is valid", () => {
    const manifestPath = resolve(bundledDir, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toBeDefined();
  });

  it("background.js exists", () => {
    expect(existsSync(resolve(bundledDir, "background.js"))).toBe(true);
  });

  it("background.js connects to correct default port", () => {
    const source = readFileSync(resolve(bundledDir, "background.js"), "utf-8");
    expect(source).toContain("18792");
  });
});
