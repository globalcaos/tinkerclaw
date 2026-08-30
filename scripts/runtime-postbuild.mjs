import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";
import { stageBundledPluginRuntimeDeps } from "./stage-bundled-plugin-runtime-deps.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_RUNTIME_ALIAS_PATTERN = /^(?<base>.+\.(?:runtime|contract))-[A-Za-z0-9_-]+\.js$/u;

/**
 * Copy static (non-transpiled) runtime assets that are referenced by their
 * source-relative path inside bundled extension code.
 *
 * Each entry: { src: repo-root-relative source, dest: dist-relative dest }
 */
export const STATIC_EXTENSION_ASSETS = [
  // acpx MCP proxy — co-deployed alongside the acpx index bundle so that
  // `path.resolve(dirname(import.meta.url), "mcp-proxy.mjs")` resolves correctly
  // at runtime from the built ACPX extension directory.
  {
    src: "extensions/acpx/src/runtime-internals/mcp-proxy.mjs",
    dest: "dist/extensions/acpx/mcp-proxy.mjs",
  },
  // diffs viewer runtime bundle — co-deployed inside the plugin package so the
  // built bundle can resolve `./assets/viewer-runtime.js` from dist.
  {
    src: "extensions/diffs/assets/viewer-runtime.js",
    dest: "dist/extensions/diffs/assets/viewer-runtime.js",
  },
  // FORK: tinkerclaw-fractal-reflection reads fractal-prompt.md via
  // readFileSync(join(extensionDir, "fractal-prompt.md")) at load time. Without
  // this entry the staging pipeline silently drops the prompt and the plugin
  // falls back to a one-line hard-coded stub that breaks the UI formatting and
  // lets HEARTBEAT_OK leak into fractal responses.
  //
  // NOTE: the first line of this comment is the idempotency marker that
  // scripts/merge-drivers/apply-fork-wiring.mjs greps for
  // ("FORK: tinkerclaw-fractal-reflection reads fractal-prompt.md"). Keep it
  // byte-identical or the merge driver will try to re-inject this block, fail
  // its anchor, and skip the copyStaticExtensionAssets reorder patch with it.
  {
    src: "extensions/tinkerclaw-fractal-reflection/fractal-prompt.md",
    dest: "dist/extensions/tinkerclaw-fractal-reflection/fractal-prompt.md",
  },
  // FORK: the v3 doctrine pair. src/fractal-run.ts:300-313 (loadTriagePrompt)
  // reads triage-prompt.md straight out of the extension dir at run time, and
  // the fix lane reads fix-prompt.md the same way. Both files shipped in the
  // repo from day one but were NEVER declared here, so they never reached
  // dist/ or dist-runtime/ — which is what the gateway actually loads. Result:
  // 2026-06-11 → 2026-08-04, every single fractal run failed with
  // "triage-prompt.md missing or unreadable in the extension dir" (2,067 of
  // 2,379 ledger rows; 245 of 245 in August; zero successes ever). The repo
  // copy is not the deployed copy — declare the asset or it does not ship.
  {
    src: "extensions/tinkerclaw-fractal-reflection/triage-prompt.md",
    dest: "dist/extensions/tinkerclaw-fractal-reflection/triage-prompt.md",
  },
  {
    src: "extensions/tinkerclaw-fractal-reflection/fix-prompt.md",
    dest: "dist/extensions/tinkerclaw-fractal-reflection/fix-prompt.md",
  },
];

export function listStaticExtensionAssetOutputs(params = {}) {
  const assets = params.assets ?? STATIC_EXTENSION_ASSETS;
  return assets
    .map(({ dest }) => dest.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

export function copyStaticExtensionAssets(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const assets = params.assets ?? STATIC_EXTENSION_ASSETS;
  const fsImpl = params.fs ?? fs;
  const warn = params.warn ?? console.warn;
  for (const { src, dest } of assets) {
    const srcPath = path.join(rootDir, src);
    const destPath = path.join(rootDir, dest);
    if (fsImpl.existsSync(srcPath)) {
      fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
      fsImpl.copyFileSync(srcPath, destPath);
    } else {
      warn(`[runtime-postbuild] static asset not found, skipping: ${src}`);
    }
  }
}

export function writeStableRootRuntimeAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(ROOT_RUNTIME_ALIAS_PATTERN);
    if (!match?.groups?.base) {
      continue;
    }
    const aliasPath = path.join(distDir, `${match.groups.base}.js`);
    writeTextFileIfChanged(aliasPath, `export * from "./${entry.name}";\n`);
  }
}

export function runRuntimePostBuild(params = {}) {
  copyPluginSdkRootAlias(params);
  copyBundledPluginMetadata(params);
  writeOfficialChannelCatalog(params);
  stageBundledPluginRuntimeDeps(params);
  // FORK: copyStaticExtensionAssets must run BEFORE stageBundledPluginRuntime,
  // not after. Upstream ordering placed it at the end, which meant assets in
  // STATIC_EXTENSION_ASSETS landed in dist/extensions/ but were never mirrored
  // into dist-runtime/extensions/ — silently breaking every extension that
  // relies on a runtime asset (acpx/mcp-proxy.mjs, diffs/viewer-runtime.js,
  // tinkerclaw-fractal-reflection/fractal-prompt.md). Moving it up fixes all
  // three through a single code path.
  copyStaticExtensionAssets(params);
  stageBundledPluginRuntime(params);
  writeStableRootRuntimeAliases(params);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
