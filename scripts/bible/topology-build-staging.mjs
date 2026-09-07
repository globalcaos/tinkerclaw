#!/usr/bin/env node
/**
 * topology.md §"Build staging: what reaches dist, and how" — made executable.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/topology.md and is the authority. When this
 * script and that file disagree, topology.md is right and this script is the bug.
 *
 *   --check=dest       every STATIC_EXTENSION_ASSETS entry stages into dist/, never dist-runtime/.
 *                      dist-runtime is an OVERLAY: it symlinks unknown file types back into dist/,
 *                      so a dest pointed there would have nothing to point AT.
 *   --check=mirrored   every fork-owned entry is ALSO present in the fork-wiring merge driver.
 *                      The list has two homes; an entry declared in only one survives exactly
 *                      until the next upstream merge rebuilds the block from the driver's copy.
 *   --check=markers    the two idempotency marker comments are byte-identical in both files.
 *                      The driver greps for these strings to decide it has already run; reword
 *                      one and it re-injects, misses its anchor, and skips the ordering patch.
 *   --check=order      copyStaticExtensionAssets still runs BEFORE stageBundledPluginRuntime
 *                      inside runRuntimePostBuild. DERIVED by comparing call offsets, never by
 *                      line number — a line number in prose goes stale silently, an offset
 *                      comparison cannot.
 *
 * SCOPE, deliberately narrow. The "is every prompt this extension reads actually declared"
 * half is NOT here: extensions/tinkerclaw-fractal-reflection/__tests__/scaffold.test.ts already
 * derives it from source and from disk, and re-deriving it here would make a third copy of a
 * fact — the exact failure canonical-derivations.md exists to stop. What this script covers is
 * what no unit test can see: the SECOND declaration site (a merge driver), the marker strings it
 * keys off, and the call ordering that decides whether the overlay has a file to link to.
 *
 * FOUNDATION.md §"Three different jobs, three different homes" is why this encoding lives in
 * scripts/bible/ and the frontmatter carries only a one-line pointer at it.
 *
 * Usage:
 *   node scripts/bible/topology-build-staging.mjs                  # all checks
 *   node scripts/bible/topology-build-staging.mjs --check=order
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const POSTBUILD = "scripts/runtime-postbuild.mjs";
const DRIVER = "scripts/merge-drivers/apply-fork-wiring.mjs";

/** The two comment strings apply-fork-wiring.mjs greps for to decide it already ran. */
const IDEMPOTENCY_MARKERS = [
  "FORK: tinkerclaw-fractal-reflection reads fractal-prompt.md",
  "FORK: copyStaticExtensionAssets must run BEFORE stageBundledPluginRuntime",
];

/** Prefix identifying fork-owned assets, i.e. the ones the merge driver must re-inject. */
const FORK_ASSET_PREFIX = "extensions/tinkerclaw-";

const problems = [];
const notes = [];

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/**
 * STATIC_EXTENSION_ASSETS has exactly one owner (scripts/runtime-postbuild.mjs). Read the list
 * OUT OF that owner rather than restating it, so this gate can never drift from what it guards.
 *
 * Parsed, not imported, on purpose: `import`ing runtime-postbuild.mjs drags in its whole build
 * chain (copy-bundled-plugin-metadata.mjs → json5 → …), so the gate would only run in a checkout
 * with node_modules installed and would execute build code to answer a question about text.
 * Every other scripts/bible/ check is source-only for the same reason.
 */
function loadAssets() {
  const source = read(POSTBUILD);
  const open = source.indexOf("export const STATIC_EXTENSION_ASSETS = [");
  const close = open === -1 ? -1 : source.indexOf("\n];", open);
  if (open === -1 || close === -1) {
    problems.push(
      `${POSTBUILD}: cannot locate the STATIC_EXTENSION_ASSETS array — either it was renamed or ` +
        `this parser has rotted. Refusing to pass vacuously.`,
    );
    return [];
  }
  const assets = [
    ...source.slice(open, close).matchAll(/\{\s*src:\s*"([^"]+)",\s*dest:\s*"([^"]+)",\s*\}/gu),
  ].map(([, src, dest]) => ({ src, dest }));
  if (assets.length === 0) {
    problems.push(
      `${POSTBUILD}: STATIC_EXTENSION_ASSETS parsed to zero entries. An empty list makes every ` +
        `check below pass trivially, which is the blind spot this gate exists to close.`,
    );
  }
  return assets;
}

function checkDest(assets) {
  for (const { src, dest } of assets) {
    if (!dest.startsWith("dist/")) {
      problems.push(
        `${POSTBUILD}: ${src} stages to "${dest}" — every dest must start with "dist/". ` +
          `dist-runtime/ only symlinks back into dist/, so it cannot hold the bytes.`,
      );
    }
  }
  notes.push(`${assets.length} static asset(s) declared, all staging into dist/`);
}

function checkMirrored(assets) {
  const driver = read(DRIVER);
  const forkAssets = assets.filter(({ src }) => src.startsWith(FORK_ASSET_PREFIX));
  if (forkAssets.length === 0) {
    problems.push(
      `${POSTBUILD}: no fork-owned (${FORK_ASSET_PREFIX}*) assets found — the mirror check would ` +
        `pass vacuously, which is the blind spot it exists to close`,
    );
    return;
  }
  for (const { src, dest } of forkAssets) {
    // Match the DECLARATION form, not a bare substring: `dest` always contains `src` as a
    // substring ("dist/" + src), so a plain includes(src) is satisfied by the entry's own dest
    // line and would stay green through a typo in src.
    if (!driver.includes(`src: "${src}"`) || !driver.includes(`dest: "${dest}"`)) {
      problems.push(
        `${DRIVER}: fork asset "${src}" is declared in ${POSTBUILD} but NOT mirrored here. ` +
          `The next upstream merge rebuilds the block from this file and drops it silently.`,
      );
    }
  }
  notes.push(`${forkAssets.length} fork-owned asset(s) mirrored in the merge driver`);
}

function checkMarkers() {
  const postbuild = read(POSTBUILD);
  const driver = read(DRIVER);
  for (const marker of IDEMPOTENCY_MARKERS) {
    for (const [file, text] of [
      [POSTBUILD, postbuild],
      [DRIVER, driver],
    ]) {
      if (!text.includes(marker)) {
        problems.push(
          `${file}: idempotency marker missing or reworded — "${marker}". ` +
            `${DRIVER} greps for this exact string; it is load-bearing source, not a comment.`,
        );
      }
    }
  }
  notes.push(`${IDEMPOTENCY_MARKERS.length} marker string(s) byte-identical in both files`);
}

function checkOrder() {
  const postbuild = read(POSTBUILD);
  const body = /export function runRuntimePostBuild\([^)]*\)\s*\{([\s\S]*?)\n\}/u.exec(postbuild);
  if (!body) {
    problems.push(`${POSTBUILD}: cannot locate runRuntimePostBuild — the ordering is unprovable`);
    return;
  }
  const copyAt = body[1].indexOf("copyStaticExtensionAssets(");
  const stageAt = body[1].indexOf("stageBundledPluginRuntime(");
  if (copyAt === -1 || stageAt === -1) {
    problems.push(
      `${POSTBUILD}: runRuntimePostBuild no longer calls both copyStaticExtensionAssets and ` +
        `stageBundledPluginRuntime — the staging contract has changed shape`,
    );
    return;
  }
  if (copyAt > stageAt) {
    problems.push(
      `${POSTBUILD}: copyStaticExtensionAssets runs AFTER stageBundledPluginRuntime. The overlay ` +
        `walk finishes before the asset exists, so dist-runtime/ gets no symlink for it — the ` +
        `upstream ordering bug, silently reintroduced.`,
    );
    return;
  }
  notes.push("copyStaticExtensionAssets precedes stageBundledPluginRuntime (derived by offset)");
}

const requested = process.argv
  .filter((arg) => arg.startsWith("--check="))
  .map((arg) => arg.slice("--check=".length));
const wanted = (name) => requested.length === 0 || requested.includes(name);

const assets = loadAssets();
if (assets.length > 0) {
  if (wanted("dest")) checkDest(assets);
  if (wanted("mirrored")) checkMirrored(assets);
}
if (wanted("markers")) checkMarkers();
if (wanted("order")) checkOrder();

for (const note of notes) {
  console.log(`  ok: ${note}`);
}
if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`  FAIL: ${problem}`);
  }
  process.exit(1);
}
console.log("build-staging invariants hold");
