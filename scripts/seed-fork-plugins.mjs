#!/usr/bin/env -S node --import tsx
/**
 * Seed the fork plugins a cloner needs to actually SEE the product.
 *
 * The files already travel with git clone. Loading them does not. A fresh
 * gateway leaves tinkerclaw-* disabled until someone runs `plugins enable`,
 * which is tribal knowledge — the same hole the cron seeder used to be.
 * Found 2026-09-08 on Goku: the left rail had one panel because an operator
 * allow-list silently excluded the other two.
 *
 * This writes plugins.entries.<id>.enabled = true into openclaw.json.
 * It NEVER writes plugins.allow. An allow-list is a trap: a short one hides
 * the rest of the tree (Goku, 13 → 0 plugins). If an allow-list already
 * exists and does not include a bundled id, that id is skipped with a warning.
 * Existing entries are never overwritten — an operator who switched a panel
 * off keeps it off.
 *
 * Usage:
 *   node --import tsx scripts/seed-fork-plugins.mjs
 *   node --import tsx scripts/seed-fork-plugins.mjs --list|--dry-run [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigPath } from "../src/config/paths.ts";
import { withFileLock } from "../src/infra/file-lock.ts";

const FORK_PLUGIN_IDS = [
  "tinkerclaw-tinker",
  "tinkerclaw-tinker-bridge",
  "tinkerclaw-cron-panel",
  "tinkerclaw-pulse-panel",
  "tinkerclaw-task-panel",
  "tinkerclaw-control-panel",
  "tinkerclaw-prefrontal",
  "tinkerclaw-fractal-reflection",
  "tinkerclaw-identity-persistence",
];

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const LIST = has("--list");
const DRY = has("--dry-run");
const JSON_OUT = has("--json");
const SUPPORTED_FLAGS = new Set(["--list", "--dry-run", "--json"]);
const unknownFlags = argv.filter((arg) => !SUPPORTED_FLAGS.has(arg));
if (unknownFlags.length > 0) {
  console.error(`seed-fork-plugins: unknown option(s): ${unknownFlags.join(", ")}`);
  process.exit(2);
}

const CONFIG_PATH = resolveConfigPath();
const LOCK_OPTIONS = {
  retries: { retries: 20, factor: 1.5, minTimeout: 25, maxTimeout: 250, randomize: true },
  stale: 30_000,
};

function readConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, cfg: {} };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const cfg = JSON.parse(raw);
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error(`seed-fork-plugins: ${filePath} is not a JSON object`);
  }
  return { exists: true, cfg };
}

function inspect(cfg) {
  const allow = cfg.plugins?.allow;
  const allowSet = Array.isArray(allow) && allow.length > 0 ? new Set(allow) : null;
  const entries =
    cfg.plugins?.entries && typeof cfg.plugins.entries === "object" ? cfg.plugins.entries : {};
  const rows = FORK_PLUGIN_IDS.map((id) => {
    const entry = entries[id];
    const present = entry && typeof entry === "object";
    const blockedByAllow = allowSet ? !allowSet.has(id) : false;
    return {
      id,
      present,
      enabled: present ? entry.enabled !== false : false,
      blockedByAllow,
      action: present ? "keep" : blockedByAllow ? "skip-allowlist" : "enable",
    };
  });
  return { rows, toEnable: rows.filter((r) => r.action === "enable").map((r) => r.id) };
}

function apply(cfg, toEnable) {
  const next = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...(cfg.plugins?.entries ?? {}),
      },
    },
  };
  for (const id of toEnable) {
    next.plugins.entries[id] = { enabled: true };
  }
  return next;
}

function printInventory(rows, toEnable) {
  if (JSON_OUT) {
    console.log(
      JSON.stringify({ configPath: CONFIG_PATH, plugins: rows, wouldEnable: toEnable }, null, 2),
    );
    return;
  }
  console.log(`Fork plugins this installer enables (${FORK_PLUGIN_IDS.length}):\n`);
  for (const row of rows) {
    const mark =
      row.action === "enable"
        ? "MISSING  "
        : row.action === "skip-allowlist"
          ? "BLOCKED  "
          : "present  ";
    console.log(`  ${mark}  ${row.id}`);
  }
  if (DRY && toEnable.length > 0) {
    console.log(`\n--dry-run: would enable ${toEnable.length} plugin(s).`);
  }
}

const { exists, cfg } = readConfig(CONFIG_PATH);
const { rows, toEnable } = inspect(cfg);

if (LIST || DRY) {
  printInventory(rows, toEnable);
  process.exit(0);
}

if (toEnable.length === 0) {
  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        { configPath: CONFIG_PATH, added: [], skipped: FORK_PLUGIN_IDS, created: !exists },
        null,
        2,
      ),
    );
  } else {
    console.log("All bundled fork plugins are already present in config. Nothing to do.");
  }
  process.exit(0);
}

const result = await withFileLock(CONFIG_PATH, LOCK_OPTIONS, async () => {
  const latest = readConfig(CONFIG_PATH);
  const again = inspect(latest.cfg);
  if (again.toEnable.length === 0) {
    return { added: [], created: !latest.exists };
  }
  const next = apply(latest.cfg, again.toEnable);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
  return { added: again.toEnable, created: !latest.exists };
});

const skippedAllow = rows.filter((r) => r.action === "skip-allowlist").map((r) => r.id);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { configPath: CONFIG_PATH, added: result.added, skippedAllow, created: result.created },
      null,
      2,
    ),
  );
} else {
  console.log(`Enabled ${result.added.length} fork plugin(s) in ${CONFIG_PATH}:`);
  for (const id of result.added) console.log(`  - ${id}`);
  if (result.created) {
    console.log(
      "Created a new config with only plugin entries (no allow-list). Restart the gateway to load them.",
    );
  } else {
    console.log("Restart the gateway to load them.");
  }
  if (skippedAllow.length > 0) {
    console.log(
      `\nSkipped ${skippedAllow.length} plugin(s) because plugins.allow is set and does not include them.`,
    );
    console.log(
      "This installer never writes an allow-list — a short one hides the rest of the tree.",
    );
    for (const id of skippedAllow) console.log(`  - ${id}`);
  }
}
