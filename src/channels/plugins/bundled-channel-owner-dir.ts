// FORK 2026-10-29: fork-only module. The one derivation of which bundled plugin directory owns a
// channel id, for callers that must stay off the channel plugin runtime. Its only consumer is
// doctor-contract-api.ts; see the FORK note there for why it exists.
import fs from "node:fs";
import path from "node:path";
import { MANIFEST_KEY } from "../../compat/legacy-names.js";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import {
  normalizeBundledPluginStringList,
  rewriteBundledPluginEntryToBuiltPath,
  trimBundledPluginString,
} from "../../plugins/bundled-plugin-scan.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { isRecord } from "../../utils.js";

type BundledChannelOwnerCandidate = {
  dirName: string;
  pluginId: string;
  channels: readonly string[];
};

type BundledChannelOwnerIndex = {
  candidates: readonly BundledChannelOwnerCandidate[];
  ownerDirByChannelId: Map<string, string | null>;
};

const ownerIndexByPluginsDir = new Map<string, BundledChannelOwnerIndex>();

function parsePackageJson(raw: string): unknown {
  return JSON.parse(raw);
}

function readJsonObject(
  filePath: string,
  parse: (raw: string) => unknown,
): Record<string, unknown> | undefined {
  try {
    const parsed = parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// The candidates listBundledChannelMetadata in bundled.ts keeps: a directory whose manifest
// loadPluginManifest accepts and that declares at least one channel. The manifest is read by the
// same loadPluginManifest(dir, false) call bundled-plugin-metadata.ts makes, so its plugin-root
// boundary, regular-file and MAX_PLUGIN_MANIFEST_BYTES checks hold here too, and a manifest it
// refuses is skipped like a missing one. With a plain read, a directory sorting before the real
// owner could claim the channel through a manifest symlinked from outside it, and so choose the
// doctor contract that gets loaded. One manifest read per directory; no plugin code is loaded.
function listOwnerCandidates(pluginsDir: string): BundledChannelOwnerCandidate[] {
  let dirNames: string[];
  try {
    dirNames = fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const candidates: BundledChannelOwnerCandidate[] = [];
  for (const dirName of dirNames) {
    const loaded = loadPluginManifest(path.join(pluginsDir, dirName), false);
    if (!loaded.ok) {
      continue;
    }
    const channels = loaded.manifest.channels ?? [];
    if (channels.length === 0) {
      continue;
    }
    candidates.push({ dirName, pluginId: loaded.manifest.id, channels });
  }
  return candidates;
}

// bundled-plugin-metadata.ts also drops a directory whose package.json has no openclaw.extensions
// entry. Read only for the directories that claim the channel.
function hasBundledPluginEntry(pluginDir: string): boolean {
  const packageJson = readJsonObject(path.join(pluginDir, "package.json"), parsePackageJson);
  const packageManifest = packageJson?.[MANIFEST_KEY];
  const extensions = normalizeBundledPluginStringList(
    isRecord(packageManifest) ? packageManifest.extensions : undefined,
  );
  return Boolean(rewriteBundledPluginEntryToBuiltPath(trimBundledPluginString(extensions[0])));
}

// Names plugin discovery skips as not a plugin (shouldIgnoreScannedDirectory in
// src/plugins/discovery.ts), such as the dormant `*.disabled-hostver` copies of upstream plugins.
function isDormantPluginDirName(dirName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(dirName);
  return (
    normalized.endsWith(".bak") ||
    normalized.includes(".backup-") ||
    normalized.includes(".disabled")
  );
}

/**
 * Directory name, under the bundled plugins dir, of the bundled plugin that owns `channelId`.
 *
 * Same rule as resolveBundledChannelMetadata in bundled.ts: the first directory, in localeCompare
 * order of its name, whose manifest id equals the channel id or whose `channels` lists it, with
 * every manifest read through loadPluginManifest as bundled-plugin-metadata.ts reads it (see
 * listOwnerCandidates). One deliberate difference: a dormant owner (isDormantPluginDirName) gives
 * undefined rather than a different directory, so the caller keeps its old path.
 *
 * Memoized per process and bundled plugins dir, like bundled.ts's own metadata cache. Measured
 * 2026-10-29 on the reference host against the live bundled trees (166-167 directories), each run
 * a fresh process at background CPU priority, with the plain manifest read this module used
 * before: 28-47 ms for the first call, under 0.6 ms after it. Building bundled-plugin-metadata's
 * full list instead: 105-169 ms. With loadPluginManifest the first call takes 83-101 ms on the
 * same trees (3 runs each, every id resolving to the owner it had before); more than half of the
 * added time is the boundary-checked open itself, the rest the loader's field normalization.
 */
export function resolveBundledChannelOwnerDirName(channelId: string): string | undefined {
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    return undefined;
  }
  const pluginsDir = path.resolve(bundledPluginsDir);
  let index = ownerIndexByPluginsDir.get(pluginsDir);
  if (!index) {
    index = { candidates: listOwnerCandidates(pluginsDir), ownerDirByChannelId: new Map() };
    ownerIndexByPluginsDir.set(pluginsDir, index);
  }
  const cached = index.ownerDirByChannelId.get(channelId);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  // The minimum by localeCompare instead of sorting every directory name: the same winner as the
  // sorted find in bundled.ts (a tie keeps directory-listing order, as the stable sort does),
  // without comparing the directories that do not claim the channel.
  let ownerDirName: string | undefined;
  for (const candidate of index.candidates) {
    if (candidate.pluginId !== channelId && !candidate.channels.includes(channelId)) {
      continue;
    }
    if (ownerDirName !== undefined && candidate.dirName.localeCompare(ownerDirName) >= 0) {
      continue;
    }
    if (hasBundledPluginEntry(path.join(pluginsDir, candidate.dirName))) {
      ownerDirName = candidate.dirName;
    }
  }
  const resolved = ownerDirName && !isDormantPluginDirName(ownerDirName) ? ownerDirName : null;
  index.ownerDirByChannelId.set(channelId, resolved);
  return resolved ?? undefined;
}
