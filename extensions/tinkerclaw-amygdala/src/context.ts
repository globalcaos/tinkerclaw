/**
 * Per-turn and per-session state (design doc §3 M9): notes already given, send-back counter, recent holds with goal
 * fingerprints, standing facts, the "hurry" flag. In memory, with the send-back counter mirrored to the store so a
 * gateway restart cannot let the agent be sent back more than twice.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { SessionContext } from "./situation.js";
import type { AmygdalaStore } from "./store.js";
import type { Situation } from "./types.js";

export interface TurnState {
  sessionKey: string;
  turnId: string;
  seenNotes: Set<string>;
  notesThisCall: number;
  sendBackAttempts: number;
  /** Extra danger floor from precedents for this step (0 or 1). */
  precedentFloor: number;
  /** Tools denied wholesale after a second futility warning (design doc 5.4 "stop-task"). */
  stopTask: boolean;
  scheduledJobs: string[];
  /** Misreading risk of the current request, set by the second-opinion family, read by safety (paper §6.1). */
  misreadingRisk: "low" | "medium" | "high";
  /** Open readings of the request and what the evidence says of each (second-opinion). */
  readings: { id: string; label: string; status: "open" | "confirmed" | "ruled-out" }[];
  /** Futility warnings already given this task; a second one stops the task (efficiency). */
  futilityWarnings: number;
  /** Path of the Claude Code transcript for this turn (Stop hook payload); double-check reads only its tail. */
  transcriptPath?: string;
  /** A hold was decided earlier this turn: a refusal then gets no Rewind strip (the request itself is held). */
  turnHeld: boolean;
  /** The last three prompts arrived under 20 s apart: mutes curiosity notes. */
  hurry: boolean;
  /** Decisions taken this turn, and the step at which the last curiosity note was given (rationing). */
  stepCount: number;
  curiosityStep: number;
}

/** A fresh turn state, for replay and tests that have no store. */
export function newTurnState(sessionKey: string, turnId: string, sendBackAttempts = 0): TurnState {
  return {
    sessionKey,
    turnId,
    seenNotes: new Set(),
    notesThisCall: 0,
    sendBackAttempts,
    precedentFloor: 0,
    stopTask: false,
    scheduledJobs: [],
    misreadingRisk: "low",
    readings: [],
    futilityWarnings: 0,
    turnHeld: false,
    hurry: false,
    stepCount: 0,
    curiosityStep: -100,
  };
}

export interface TurnContextsOptions {
  store: AmygdalaStore;
  now?: () => number;
  /** JSON array of strings; missing file → no standing facts. */
  standingFactsPath?: string;
  maxTurns?: number;
}

const HURRY_GAP_MS = 20_000;

export class TurnContexts {
  private turns = new Map<string, TurnState>();
  private holds = new Map<string, { goalFp: string; ts: number }[]>();
  private prompts = new Map<string, number[]>();
  private facts: { mtime: number; list: string[] } | null = null;
  private scheduled: string[] = [];
  private readonly now: () => number;
  private readonly max: number;

  constructor(private readonly o: TurnContextsOptions) {
    this.now = o.now ?? Date.now;
    this.max = o.maxTurns ?? 200;
  }

  get(sessionKey: string, turnId: string): TurnState {
    const key = `${sessionKey}|${turnId}`;
    let s = this.turns.get(key);
    if (!s) {
      s = newTurnState(sessionKey, turnId, this.o.store.sendBackAttempts(sessionKey, turnId));
      s.scheduledJobs = this.scheduled;
      this.turns.set(key, s);
      if (this.turns.size > this.max) {
        const oldest = this.turns.keys().next().value;
        if (oldest !== undefined) this.turns.delete(oldest);
      }
    }
    return s;
  }

  /** Call at the start of every tool call: "at most one note per tool call". */
  beginCall(s: TurnState): void {
    s.notesThisCall = 0;
    s.precedentFloor = 0;
  }

  bumpSendBack(s: TurnState): number {
    s.sendBackAttempts = this.o.store.bumpSendBack(s.sessionKey, s.turnId);
    return s.sendBackAttempts;
  }

  setScheduledJobs(jobs: string[]): void {
    this.scheduled = jobs;
    for (const t of this.turns.values()) t.scheduledJobs = jobs;
  }

  recordHold(sessionKey: string, goalFp: string, ts = this.now()): void {
    const list = this.holds.get(sessionKey) ?? [];
    list.push({ goalFp, ts });
    this.holds.set(sessionKey, list.slice(-20));
  }

  recentHolds(sessionKey: string, windowMs = 3_600_000): { goalFp: string; ts: number }[] {
    const cut = this.now() - windowMs;
    return (this.holds.get(sessionKey) ?? []).filter((h) => h.ts >= cut);
  }

  standingFacts(): string[] {
    const p = this.o.standingFactsPath;
    if (!p || !existsSync(p)) return [];
    const mtime = statSync(p).mtimeMs;
    if (this.facts && this.facts.mtime === mtime) return this.facts.list;
    let list: string[] = [];
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown;
      if (Array.isArray(raw)) list = raw.filter((x): x is string => typeof x === "string");
    } catch {
      list = [];
    }
    this.facts = { mtime, list };
    return list;
  }

  notePrompt(sessionKey: string, ts = this.now()): void {
    const list = this.prompts.get(sessionKey) ?? [];
    list.push(ts);
    this.prompts.set(sessionKey, list.slice(-3));
  }

  /** The last three prompts arrived under 20 s apart: mutes curiosity notes. */
  hurry(sessionKey: string): boolean {
    const l = this.prompts.get(sessionKey) ?? [];
    if (l.length < 3) return false;
    return l[1] - l[0] < HURRY_GAP_MS && l[2] - l[1] < HURRY_GAP_MS;
  }

  /** Merge the tracked state into the caller's base context. Caller-supplied values win. */
  buildSessionContext(
    base: Pick<SessionContext, "workspaceRoot" | "homeDir"> & Partial<SessionContext>,
    sessionKey: string,
    turnId: string,
  ): SessionContext {
    const s = this.get(sessionKey, turnId);
    const facts = this.standingFacts();
    const holds = this.recentHolds(sessionKey);
    return {
      recentHolds: holds.length ? holds : undefined,
      standingFacts: facts.length ? facts : undefined,
      scheduledJobs: s.scheduledJobs.length ? s.scheduledJobs : undefined,
      ...base,
    };
  }
}

/** Fingerprint of a step's goal: target + effect class + verb stem. A rephrased retry keeps it. */
export function goalFingerprint(s: Situation): string {
  const targets = (s.targets.value ?? [])
    .map((t) => t.path)
    .sort()
    .join("|");
  const effect = s.effectClass.value ?? "?";
  const verb = (s.command.value ?? s.tool.value ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return createHash("sha256").update(`${targets}#${effect}#${verb}`).digest("hex").slice(0, 16);
}
