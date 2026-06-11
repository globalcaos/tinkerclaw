import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { evaluateAegisEnforced, evaluateRuleBased } from "../src/rule-based-gate.js";
import { TrainingLog } from "../src/training-log.js";
import type { SituationTemplate } from "../src/types.js";

// better-sqlite3 may be absent in some CI envs; skip the DB tests gracefully.
let sqliteAvailable = true;
let Database: unknown;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  sqliteAvailable = false;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amy-mig-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stubSituation(): SituationTemplate {
  return {
    action_type: "modify",
    target_type: "file",
    target_id: "x",
    target_metadata: {
      age_hours: 1,
      size: 1,
      recent_commits: 0,
      recent_authors: 0,
      effort_hours: 0,
      last_human_ref: 0,
    },
    context: {
      session_topic: "t",
      recent_corrections: 0,
      emotional_signals: "calm",
      automation_depth: 1,
      topic_drift: 0,
    },
    scope: { reversible: "true", blast_radius: "self", human_in_loop: false, confirmation: "none" },
    timestamp: new Date().toISOString(),
  };
}

describe("AEGIS enforce tiers", () => {
  it("evaluateAegisEnforced hard-blocks destructive execution rules", () => {
    expect(evaluateAegisEnforced("Bash", "rm -rf /").decision).toBe("hard_block");
    expect(evaluateAegisEnforced("Bash", "DROP TABLE users").decision).toBe("hard_block");
  });

  it("evaluateAegisEnforced does NOT block credential-pattern rules (observe-only)", () => {
    // evaluateRuleBased (legacy) DOES block these; the enforce-aware one does not.
    expect(evaluateRuleBased("Read", "/home/u/.env").decision).toBe("hard_block");
    expect(evaluateAegisEnforced("Read", "/home/u/.env").decision).toBe("allow");
    expect(evaluateAegisEnforced("Bash", "echo my password is x").decision).toBe("allow");
  });
});

describe.skipIf(!sqliteAvailable)("training-log v3.1 migration", () => {
  it("migrates a legacy (NOT NULL ensemble) DB to user_version 1, preserving rows", async () => {
    const dbPath = join(dir, "training.sqlite");
    // Build the OLD schema by hand + one legacy row.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = new (Database as any)(dbPath);
    raw.exec(`
      CREATE TABLE amygdala_evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL, situation_json TEXT NOT NULL, serialized TEXT NOT NULL,
        embedding BLOB NOT NULL, gate_decision TEXT NOT NULL,
        prudence_combined TEXT NOT NULL, prudence_per_arch TEXT NOT NULL,
        prediction_set TEXT NOT NULL, ensemble_disagreement REAL NOT NULL DEFAULT 0,
        personality_combined BLOB, outcome TEXT, outcome_source TEXT, outcome_timestamp TEXT,
        outcome_weight REAL DEFAULT 1.0, user_override BOOLEAN DEFAULT FALSE,
        user_override_reason TEXT, latency_ms REAL NOT NULL DEFAULT 0,
        alpha_prudence REAL NOT NULL DEFAULT 0, alpha_personality REAL NOT NULL DEFAULT 0,
        phase INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    const emb = Buffer.from(new Float32Array(512).fill(0.1).buffer);
    raw
      .prepare(
        `INSERT INTO amygdala_evaluations
         (timestamp, situation_json, serialized, embedding, gate_decision,
          prudence_combined, prudence_per_arch, prediction_set, ensemble_disagreement)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), "{}", "legacy row", emb, "allow", "{}", "{}", "[]", 0);
    expect(raw.pragma("user_version", { simple: true })).toBe(0);
    raw.close();

    const tl = new TrainingLog({ db_path: dbPath, max_entries: 1000, rolling_window_days: 90 });
    await tl.initialize();
    expect(tl.available).toBe(true);

    // Append a v3.1 row with NULL ensemble fields (would violate the old NOT NULL).
    const id = await tl.append({
      situation: stubSituation(),
      serialized: "v3.1 novelty row",
      embedding: new Float32Array(512).fill(0.2),
      prudence_output: null,
      personality_output: null,
      gate_decision: "soft_block",
      timestamp: new Date().toISOString(),
      latency_ms: 3,
      outcome: null,
      alpha_prudence: 0.15,
      alpha_personality: 0.5,
      phase: 4,
      novelty: 0.42,
      disposition: "ask",
      signal: "novelty",
    });
    expect(id).toBeGreaterThan(0);

    // Verify the migration: version bumped, new columns present, old row intact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const check = new (Database as any)(dbPath);
    expect(check.pragma("user_version", { simple: true })).toBe(1);
    const cols = (check.pragma("table_info(amygdala_evaluations)") as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("novelty");
    expect(cols).toContain("disposition");
    expect(cols).toContain("signal");
    const legacy = check
      .prepare(`SELECT serialized FROM amygdala_evaluations WHERE serialized = 'legacy row'`)
      .get();
    expect(legacy).toBeTruthy();
    const v31 = check
      .prepare(`SELECT novelty, disposition, signal FROM amygdala_evaluations WHERE id = ?`)
      .get(id) as { novelty: number; disposition: string; signal: string };
    expect(v31.novelty).toBeCloseTo(0.42, 5);
    expect(v31.disposition).toBe("ask");
    expect(v31.signal).toBe("novelty");
    check.close();
    await tl.close();
  });

  it("getRecentEmbeddings + calibration round-trip", async () => {
    const dbPath = join(dir, "fresh.sqlite");
    const tl = new TrainingLog({ db_path: dbPath, max_entries: 1000, rolling_window_days: 90 });
    await tl.initialize();
    for (let i = 0; i < 5; i++) {
      await tl.append({
        situation: stubSituation(),
        serialized: `row ${i}`,
        embedding: new Float32Array(512).fill(i / 10),
        prudence_output: null,
        personality_output: null,
        gate_decision: "allow",
        timestamp: new Date().toISOString(),
        latency_ms: 1,
        outcome: null,
        alpha_prudence: 0,
        alpha_personality: 0,
        phase: 4,
        novelty: null,
        disposition: "proceed",
        signal: "none",
      });
    }
    const embs = tl.getRecentEmbeddings(10, 512);
    expect(embs.length).toBe(5);
    expect(embs[0].length).toBe(512);
    tl.setCalibration("novelty_threshold", 0.33);
    expect(tl.getCalibration("novelty_threshold")).toBeCloseTo(0.33, 5);
    await tl.close();
  });
});
