import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as coreApi from "../core-api.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

describe("browser extension install", () => {
  it("installs the bundled relay extension into the state dir (never node_modules)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ext-"));
    const { installChromeExtension } = await import("./browser-cli-extension.js");

    // No sourceDir on purpose: this exercises bundledExtensionRootDir(), which is the whole
    // reason the command moved to extensions/browser/src/cli/ on 2026-08-03. Its old home
    // under src/cli/ measured the relative walk from a directory that no longer hosts the
    // command, imported ../browser/trash.js (which had moved into this package), had zero
    // importers and never reached dist/ — the capability had silently stopped existing.
    const result = await installChromeExtension({ stateDir: tmp });

    expect(result.path).toBe(path.join(tmp, "browser", "chrome-extension"));
    expect(result.path.includes("node_modules")).toBe(false);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.path, "manifest.json"), "utf-8"),
    ) as { host_permissions?: string[] };
    // The tree that ships is the v1.0.0 <all_urls> relay, not the deleted v0.1.0
    // localhost-only twin that could not attach to a real site.
    expect(manifest.host_permissions).toContain("<all_urls>");
  });

  it("copies the installed extension path to the clipboard", async () => {
    const prev = process.env.OPENCLAW_STATE_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ext-path-"));
    process.env.OPENCLAW_STATE_DIR = tmp;
    const clipboard = vi.spyOn(coreApi, "copyToClipboard").mockResolvedValue(true);
    const log = vi.spyOn(coreApi.defaultRuntime, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(coreApi.defaultRuntime, "error").mockImplementation(() => {});

    try {
      const dir = path.join(tmp, "browser", "chrome-extension");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3 }));

      const { Command } = await import("commander");
      const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");

      const program = new Command();
      const browser = program.command("browser").option("--json", "Output JSON", false);
      registerBrowserExtensionCommands(browser, (cmd) => cmd.parent?.opts?.() as BrowserParentOpts);

      await program.parseAsync(["browser", "extension", "path"], { from: "user" });

      // The command resolves the state dir at CALL time, so the env override above is honoured
      // without a module reset — the old copy read a module-level STATE_DIR const instead.
      expect(clipboard).toHaveBeenCalledWith(dir);
    } finally {
      clipboard.mockRestore();
      log.mockRestore();
      errorLog.mockRestore();
      if (prev === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prev;
      }
    }
  });
});
