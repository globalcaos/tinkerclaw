/**
 * FORK: tinkerclaw-control-panel — test helpers.
 *
 * Spins up an isolated SQLite store in a tmpdir for vitest suites. The store
 * runs through getDb() so all migrations + seeds fire normally, then we clear
 * the seeded taxonomy rows so tests start with an empty task_axis table.
 *
 * Tests MUST call cleanup() in afterEach() to close the singleton connection
 * (db.ts caches the connection at module scope) and remove the tmpdir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ControlPanelResolvedConfig } from "../paths.js";
import { closeDb, getDb } from "./db.js";

export type InMemoryConfigHandle = ControlPanelResolvedConfig & {
  cleanup: () => void;
};

export function setupInMemoryConfig(): InMemoryConfigHandle {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-test-"));
  const dbPath = path.join(dir, "store.db");
  const cfg: ControlPanelResolvedConfig = {
    dataDir: dir,
    dbPath,
    calendarSync: { enabled: false, cadenceSeconds: 1800, sources: ["google.primary"] },
    briefingImport: false,
    execMode: {
      leftPanelWidthPx: 360,
      splitGraphsPct: 40,
      splitCalendarPct: 10,
      defaultModeOnLaunch: "dev",
    },
  };
  // Warm getDb so the schema + migrations + seeds run, then wipe seeded
  // taxonomies so each test starts from a blank task_axis / task_est_preset.
  const db = getDb(cfg);
  db.exec("DELETE FROM task_axis");
  db.exec("DELETE FROM task_est_preset");
  return {
    ...cfg,
    cleanup: () => {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
