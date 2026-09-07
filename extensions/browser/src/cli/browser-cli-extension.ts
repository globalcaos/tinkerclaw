import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { movePathToTrash } from "../browser/trash.js";
import { copyToClipboard, resolveStateDir } from "../core-api.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import {
  danger,
  defaultRuntime,
  formatCliCommand,
  formatDocsLink,
  info,
  shortenHomePath,
  theme,
} from "./core-api.js";

// FORK 2026-08-03: moved here from src/cli/browser-cli-extension.ts, where it had quietly
// stopped shipping. That file imported ../browser/trash.js, which moved into THIS package in
// 29cd96385a7 ("remove legacy browser bridge entrypoints"); from src/cli/ the import no longer
// resolved, the file had ZERO importers, it never reached dist/, and its command group was
// never registered anywhere — so `openclaw browser extension install` had ceased to exist
// while extensions/tinkerclaw-browser-relay/chrome-extension/README.md still told users to run
// it. Three independent signals (no importers + absent from dist + no registration) and none
// of them was a test failure. The browser command tree lives in this directory now, so the
// capability lives with it and is registered from browser-cli.ts.
//
// FORK 2026-08-03: repointed from assets/chrome-extension to the browser-relay extension.
// There were TWO chrome-extension trees and the CLI installed the wrong one: assets/ was
// version 0.1.0, last touched 2026-05-09, with host_permissions limited to 127.0.0.1 and
// localhost — so it could not relay a real website at all. The copy below is version 1.0.0,
// carries <all_urls> plus the tabGroups/alarms permissions, and holds every relay feature the
// bible documents (§5.81 per-tab consent, tab persistence + auto-reconnect, cross-site
// Page.navigate blocking). It had ZERO references, so six weeks of relay work never shipped.
// assets/chrome-extension has been deleted; this is now the single source.
function bundledExtensionRootDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // extensions/browser/src/cli -> extensions/. A dist/cli/ build sits at the same depth, so
  // the walk holds whether this module is loaded from source or from a build.
  return path.resolve(here, "../../../tinkerclaw-browser-relay/chrome-extension");
}

function installedExtensionRootDir() {
  return path.join(resolveStateDir(), "browser", "chrome-extension");
}

function hasManifest(dir: string) {
  return fs.existsSync(path.join(dir, "manifest.json"));
}

export async function installChromeExtension(opts?: {
  stateDir?: string;
  sourceDir?: string;
}): Promise<{ path: string }> {
  const src = opts?.sourceDir ?? bundledExtensionRootDir();
  if (!hasManifest(src)) {
    throw new Error("Bundled Chrome extension is missing. Reinstall OpenClaw and try again.");
  }

  const stateDir = opts?.stateDir ?? resolveStateDir();
  const dest = path.join(stateDir, "browser", "chrome-extension");
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest)) {
    await movePathToTrash(dest).catch(() => {
      const backup = `${dest}.old-${Date.now()}`;
      fs.renameSync(dest, backup);
    });
  }

  await fs.promises.cp(src, dest, { recursive: true });
  if (!hasManifest(dest)) {
    throw new Error("Chrome extension install failed (manifest.json missing). Try again.");
  }

  return { path: dest };
}

export function registerBrowserExtensionCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const ext = browser.command("extension").description("Chrome extension helpers");

  ext
    .command("install")
    .description("Install the Chrome extension to a stable local path")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      let installed: { path: string };
      try {
        installed = await installChromeExtension();
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
        // defaultRuntime.exit is typed `(code: number) => void`, not `never`, and test runtimes
        // stub it out — without this return the failure path falls through and reports success.
        return;
      }

      if (parent?.json) {
        defaultRuntime.log(JSON.stringify({ ok: true, path: installed.path }, null, 2));
        return;
      }
      const displayPath = shortenHomePath(installed.path);
      defaultRuntime.log(displayPath);
      const copied = await copyToClipboard(installed.path).catch(() => false);
      defaultRuntime.error(
        info(
          [
            copied ? "Copied to clipboard." : "Copy to clipboard unavailable.",
            "Next:",
            `- Chrome → chrome://extensions → enable “Developer mode”`,
            `- “Load unpacked” → select: ${displayPath}`,
            `- Pin “OpenClaw Browser Relay”, then click it on the tab (badge shows ON)`,
            "",
            `${theme.muted("Docs:")} ${formatDocsLink("/tools/chrome-extension", "docs.openclaw.ai/tools/chrome-extension")}`,
          ].join("\n"),
        ),
      );
    });

  ext
    .command("path")
    .description("Print the path to the installed Chrome extension (load unpacked)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const dir = installedExtensionRootDir();
      if (!hasManifest(dir)) {
        defaultRuntime.error(
          danger(
            [
              `Chrome extension is not installed. Run: "${formatCliCommand("openclaw browser extension install")}"`,
              `Docs: ${formatDocsLink("/tools/chrome-extension", "docs.openclaw.ai/tools/chrome-extension")}`,
            ].join("\n"),
          ),
        );
        defaultRuntime.exit(1);
        return;
      }
      if (parent?.json) {
        defaultRuntime.log(JSON.stringify({ path: dir }, null, 2));
        return;
      }
      const displayPath = shortenHomePath(dir);
      defaultRuntime.log(displayPath);
      const copied = await copyToClipboard(dir).catch(() => false);
      if (copied) {
        defaultRuntime.error(info("Copied to clipboard."));
      }
    });
}
