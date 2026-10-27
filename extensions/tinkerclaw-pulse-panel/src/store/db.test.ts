/**
 * FORK 2026-09-08 — the Pulse panel must not touch the task panel's tables.
 *
 * These tests pin the ownership split introduced when the plugin was audited:
 * opening the store creates the metric tables this plugin reads and writes, and
 * NOTHING else, unless the operator explicitly opts in with `manageTaskSchema`.
 * A regression here means a metrics panel silently rewriting another plugin's
 * task rows on boot, which is what the split exists to prevent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveControlPanelConfig, resolvePollerCredentials } from "../paths.js";
import { closeDb, getDb } from "./db.js";

const PULSE_TABLES = ["metric_definition", "observation", "alert_state", "panel_pin"];
const TASK_TABLES = [
  "task",
  "task_axis",
  "task_est_preset",
  "task_event",
  "briefing_pass",
  "calendar_event_cache",
];

let tmpDirs: string[] = [];

function freshConfig(overrides: Record<string, unknown> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-db-test-"));
  tmpDirs.push(dataDir);
  return resolveControlPanelConfig({ dataDir, ...overrides });
}

function tableNames(db: ReturnType<typeof getDb>): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

afterEach(() => {
  closeDb();
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("getDb table ownership", () => {
  it("creates the pulse-owned metric tables by default", () => {
    const names = tableNames(getDb(freshConfig()));
    for (const t of PULSE_TABLES) {
      expect(names).toContain(t);
    }
  });

  it("does NOT create the task-panel tables by default", () => {
    const names = tableNames(getDb(freshConfig()));
    for (const t of TASK_TABLES) {
      expect(names).not.toContain(t);
    }
  });

  it("creates and seeds the task tables only when manageTaskSchema is enabled", () => {
    const db = getDb(freshConfig({ manageTaskSchema: true }));
    const names = tableNames(db);
    for (const t of TASK_TABLES) {
      expect(names).toContain(t);
    }
    // seedTaxonomyDefaults ran: the axis taxonomy is populated.
    const axes = db.prepare("SELECT COUNT(*) AS n FROM task_axis").get() as { n: number };
    expect(axes.n).toBeGreaterThan(0);
  });
});

describe("resolved defaults", () => {
  it("defaults manageTaskSchema off and polling on", () => {
    const cfg = resolveControlPanelConfig({});
    expect(cfg.manageTaskSchema).toBe(false);
    expect(cfg.polling.enabled).toBe(true);
    expect(cfg.polling.tickSeconds).toBe(60);
  });

  it("ships no metrics, so a fresh install polls nothing", () => {
    expect(resolveControlPanelConfig({}).seedMetrics).toEqual([]);
  });

  it("floors tickSeconds so a typo cannot become a busy loop", () => {
    expect(resolveControlPanelConfig({ polling: { tickSeconds: 0 } }).polling.tickSeconds).toBe(10);
  });
});

describe("poller credentials", () => {
  it("has no default credential paths — unset stays unset", () => {
    const creds = resolvePollerCredentials(undefined);
    expect(creds.githubToken).toBeUndefined();
    expect(creds.moltbookApiKeyFile).toBeUndefined();
    expect(creds.youtubeApiKeyFile).toBeUndefined();
    expect(creds.ga4ServiceAccountFile).toBeUndefined();
  });

  it("reads credentials from config only, never from environment variables", () => {
    const env = { ...process.env };
    process.env.GITHUB_TOKEN = "env-token";
    process.env.PULSE_GA4_SERVICE_ACCOUNT_FILE = "/tmp/env-sa.json";
    try {
      const creds = resolvePollerCredentials(undefined);
      expect(creds.githubToken).toBeUndefined();
      expect(creds.ga4ServiceAccountFile).toBeUndefined();
    } finally {
      process.env = env;
    }
  });

  it("takes the operator-supplied path when one is configured", () => {
    const creds = resolvePollerCredentials({ ga4ServiceAccountFile: "/tmp/my-sa.json" });
    expect(creds.ga4ServiceAccountFile).toBe("/tmp/my-sa.json");
  });
});
