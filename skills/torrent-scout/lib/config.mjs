// config.mjs — persistent config + the cross-turn search state that makes
// "download number 3" resolve to the same thing the user was just shown.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIR =
  process.env.TORRENT_SCOUT_HOME || path.join(os.homedir(), ".torrent-scout");
export const CONFIG_PATH = path.join(STATE_DIR, "config.json");
export const LAST_SEARCH = path.join(STATE_DIR, "last-search.json");

export const DEFAULT_CONFIG = {
  // Generic Torznab endpoints. Prowlarr/Jackett both speak this.
  // Ships EMPTY on purpose: the user decides which indexers to point it at.
  indexers: [],
  // Internet Archive is on by default: public-domain, fully legal, HTTP-webseeded.
  useArchiveOrg: true,
  downloadDir: path.join(os.homedir(), "Downloads", "torrent-scout"),
  profile: "best",
  // Hard default, and the reason this skill exists in this shape.
  neverSeed: true,
  // Explicit opt-in list of infohashes the user WANTS to redistribute.
  seedAllowlist: [],
  timeoutMs: 25000,
};

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  return CONFIG_PATH;
}

export function saveSearch(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${LAST_SEARCH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, LAST_SEARCH);
  return LAST_SEARCH;
}

export function loadSearch() {
  try {
    return JSON.parse(fs.readFileSync(LAST_SEARCH, "utf8"));
  } catch {
    return null;
  }
}

/** Resolve a user-facing reference ("3", an infohash, a title fragment). */
export function resolveRef(ref) {
  const state = loadSearch();
  if (!state) throw new Error("No previous search. Run search.mjs first.");
  const all = [...(state.kept || []), ...(state.rejected || [])];
  if (/^\d+$/.test(String(ref))) {
    const hit = (state.kept || [])[Number(ref) - 1];
    if (!hit)
      throw new Error(
        `No candidate #${ref} in the last search (${(state.kept || []).length} shown).`,
      );
    return hit;
  }
  const lower = String(ref).toLowerCase();
  const byHash = all.find((c) => (c.infoHash || "").toLowerCase() === lower);
  if (byHash) return byHash;
  const byTitle = all.find((c) => (c.title || "").toLowerCase().includes(lower));
  if (byTitle) return byTitle;
  throw new Error(`Could not resolve "${ref}" against the last search.`);
}
