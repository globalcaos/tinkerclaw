#!/usr/bin/env node
/**
 * ENGRAM Sleep Consolidation CLI
 *
 * Runs the sleep consolidation pipeline on all session event stores.
 * Designed for cron execution (e.g. nightly at 4:00 AM).
 *
 * Usage:
 *   bun src/memory/engram/consolidate-cli.ts [--dry-run] [--session KEY]
 *
 * FORK-ISOLATED: unique to our fork.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createArtifactStore } from "./artifact-store.js";
import type { ConsolidationState } from "./episode-detection.js";
import { createEventStore } from "./event-store.js";
import { runSleepConsolidation, createInitialConsolidationState } from "./sleep-consolidation.js";

const ENGRAM_DIR = join(homedir(), ".openclaw", "engram");
const STATE_FILE = join(ENGRAM_DIR, "consolidation-state.json");
const EVENTS_DIR = join(ENGRAM_DIR, "events");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sessionFilter = args.includes("--session") ? args[args.indexOf("--session") + 1] : null;

function loadState(): Record<string, ConsolidationState> {
  if (!existsSync(STATE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: Record<string, ConsolidationState>): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  if (!existsSync(EVENTS_DIR)) {
    console.log("No events directory found. Nothing to consolidate.");
    process.exit(0);
  }

  const sessionFiles = readdirSync(EVENTS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => basename(f, ".jsonl"));

  const sessions = sessionFilter ? sessionFiles.filter((s) => s === sessionFilter) : sessionFiles;

  if (sessions.length === 0) {
    console.log("No sessions to consolidate.");
    process.exit(0);
  }

  console.log(`Sleep consolidation: ${sessions.length} session(s)${dryRun ? " [DRY RUN]" : ""}`);

  const allState = loadState();
  const artifactStore = createArtifactStore({ baseDir: ENGRAM_DIR });
  let totalEpisodes = 0;
  let totalEvents = 0;

  for (const sessionKey of sessions) {
    const store = createEventStore({ baseDir: ENGRAM_DIR, sessionKey });
    const eventCount = store.count();
    if (eventCount === 0) {
      continue;
    }

    const sessionState = allState[sessionKey] ?? createInitialConsolidationState();

    if (dryRun) {
      console.log(
        `  ${sessionKey}: ${eventCount} events (last consolidated: ${sessionState.lastConsolidatedEventId ?? "never"})`,
      );
      continue;
    }

    const result = await runSleepConsolidation(store, artifactStore, sessionState);

    if (result.newEpisodes.length > 0) {
      console.log(
        `  ${sessionKey}: ${result.newEpisodes.length} episodes, ${result.eventsProcessed} events, ${result.durationMs}ms`,
      );
      for (const ep of result.newEpisodes) {
        console.log(`    - "${ep.topic}" (${ep.turnCount} turns, ${ep.outcome})`);
      }
    }

    allState[sessionKey] = sessionState;
    totalEpisodes += result.newEpisodes.length;
    totalEvents += result.eventsProcessed;
  }

  if (!dryRun) {
    saveState(allState);
    console.log(`\nTotal: ${totalEpisodes} episodes from ${totalEvents} events.`);
  }
}

main().catch((err) => {
  console.error("Sleep consolidation failed:", err);
  process.exit(1);
});
