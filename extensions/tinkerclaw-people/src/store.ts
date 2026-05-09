/**
 * FORK: tinkerclaw-people — alias map + state store.
 *
 * Pure file IO on `_aliases.json` and `_state.json`. No LLM, no SQLite —
 * those live in seed.mjs / cron-people-profiles.sh respectively.
 */
import fs from "node:fs";
import path from "node:path";
import type { PeopleResolvedConfig } from "./paths.js";

export type PersonAlias = {
  displayName: string;
  emails: string[];
  phones: string[];
  lids: string[];
  names: string[];
};

export type AliasMap = Record<string, PersonAlias>;

export type PersonState = {
  lastWaMessageId?: string;
  lastWaTimestamp?: number;
  lastSummaryAt?: string;
  messagesSinceLastSummary?: number;
  lastConsultedByOwner?: string;
  lastInteraction?: string;
};

export type StateMap = Record<string, PersonState>;

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readAliases(cfg: PeopleResolvedConfig): AliasMap {
  try {
    const raw = fs.readFileSync(cfg.aliasesPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AliasMap;
    }
  } catch {
    // missing or invalid → start fresh
  }
  return {};
}

export function writeAliases(cfg: PeopleResolvedConfig, aliases: AliasMap) {
  ensureDir(path.dirname(cfg.aliasesPath));
  fs.writeFileSync(cfg.aliasesPath, JSON.stringify(aliases, null, 2) + "\n", "utf-8");
}

export function readState(cfg: PeopleResolvedConfig): StateMap {
  try {
    const raw = fs.readFileSync(cfg.statePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StateMap;
    }
  } catch {
    // missing or invalid → start fresh
  }
  return {};
}

export function writeState(cfg: PeopleResolvedConfig, state: StateMap) {
  ensureDir(path.dirname(cfg.statePath));
  fs.writeFileSync(cfg.statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function profilePath(cfg: PeopleResolvedConfig, slug: string): string {
  return path.join(cfg.peopleDir, `${slug}.md`);
}

export function readProfile(cfg: PeopleResolvedConfig, slug: string): string | null {
  try {
    return fs.readFileSync(profilePath(cfg, slug), "utf-8");
  } catch {
    return null;
  }
}

export function writeProfile(cfg: PeopleResolvedConfig, slug: string, content: string) {
  ensureDir(cfg.peopleDir);
  fs.writeFileSync(profilePath(cfg, slug), content, "utf-8");
}
