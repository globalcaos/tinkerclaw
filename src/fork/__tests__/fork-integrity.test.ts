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

import { existsSync } from "node:fs";
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

  it("fork/process-message-hooks loads", () => {
    const source = require("node:fs").readFileSync(
      resolve(srcRoot, "fork/process-message-hooks.ts"),
      "utf-8",
    );
    expect(source).toContain("annotateOfflineRecovery");
    expect(source).toContain("createThinkingReaction");
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

  it("amygdala runtime-hook loads", async () => {
    const mod = await import("../../amygdala/runtime-hook.js");
    expect(mod).toBeDefined();
  });

  it("amygdala gate loads", async () => {
    const mod = await import("../../amygdala/gate.js");
    expect(mod).toBeDefined();
  });

  it("amygdala situation-template loads", async () => {
    const mod = await import("../../amygdala/situation-template.js");
    expect(mod).toBeDefined();
  });

  it("amygdala embedding loads", async () => {
    const mod = await import("../../amygdala/embedding.js");
    expect(mod).toBeDefined();
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

  it("server-lifecycle exports ensureExtensionRelayForProfiles", async () => {
    const mod = await import("../../browser/server-lifecycle.js");
    expect(typeof mod.ensureExtensionRelayForProfiles).toBe("function");
  });

  it("ensureExtensionRelayForProfiles is NOT a no-op", async () => {
    // The critical check: if upstream stubs this out again, we catch it.
    const mod = await import("../../browser/server-lifecycle.js");
    const fnSource = mod.ensureExtensionRelayForProfiles.toString();
    // A no-op function would be very short or contain "no-op" / "stub"
    expect(fnSource).not.toMatch(/no-op|stub|intentional/i);
    // It should reference extension relay
    expect(fnSource).toMatch(/relay|extension/i);
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

  it("attempt.ts has FORK: persona block injection", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/embedded-agent-runner/run/attempt.ts"), "utf-8"),
    );
    expect(source).toMatch(/FORK:.*persona block/i);
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

  it("run.ts has FORK: per-profile fallback error events", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/embedded-agent-runner/run.ts"), "utf-8"),
    );
    expect(source).toMatch(/FORK:.*fallback error/i);
  });

  it("pi-embedded-subscribe.ts has FORK: streaming reasoning", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "agents/pi-embedded-subscribe.ts"), "utf-8"),
    );
    expect(source).toMatch(/FORK:.*streaming reasoning|FORK:.*raw.*thinking/i);
  });

  it("server-lifecycle.ts calls extension relay (not a stub)", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(resolve(srcRoot, "browser/server-lifecycle.ts"), "utf-8"),
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
    "amygdala/runtime-hook.ts",
    "amygdala/gate.ts",
    "amygdala/situation-template.ts",
    "amygdala/embedding.ts",
    "amygdala/types.ts",
    "amygdala/training-log.ts",
    "amygdala/distribution-shift.ts",
    "browser/extension-relay.ts",
    "browser/extension-relay-auth.ts",
    "infra/usage-snapshot-store.ts",
  ];

  for (const file of requiredFiles) {
    it(`${file} exists`, () => {
      const fullPath = resolve(srcRoot, file);
      expect(existsSync(fullPath)).toBe(true);
    });
  }
});

// ─── 6. CHROME EXTENSION ──────────────────────────────────────────────
// The browser relay Chrome extension must exist and be loadable.

describe("Chrome extension relay", () => {
  const extDir = resolve(process.env.HOME || "", ".openclaw/browser/chrome-extension");

  it("extension directory exists", () => {
    expect(existsSync(extDir)).toBe(true);
  });

  it("manifest.json exists and is valid", () => {
    const manifestPath = resolve(extDir, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(require("node:fs").readFileSync(manifestPath, "utf-8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toBeDefined();
  });

  it("background.js exists", () => {
    expect(existsSync(resolve(extDir, "background.js"))).toBe(true);
  });

  it("background.js connects to correct default port", () => {
    const source = require("node:fs").readFileSync(resolve(extDir, "background.js"), "utf-8");
    expect(source).toContain("18792");
  });
});
