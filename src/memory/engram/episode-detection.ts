/**
 * ENGRAM Phase 3A — Episode Detection
 *
 * Detects natural episode boundaries in the event stream using:
 * 1. Time gaps (>30min default)
 * 2. Task ID changes
 * 3. Explicit session boundaries
 * 4. Topic shift via embedding distance (when embeddings available)
 *
 * FORK-ISOLATED: unique to our fork (ENGRAM paper §5).
 */

import { randomUUID } from "node:crypto";
import type { MemoryEvent } from "./event-types.js";

export interface Episode {
  id: string;
  startEventId: string;
  endEventId: string;
  startTime: string;
  endTime: string;
  turnCount: number;
  topic: string;
  participants: string[];
  outcome: "completed" | "abandoned" | "ongoing";
  keyDecisions: string[];
  sourceEventIds: string[];
}

export interface EpisodeDetectionConfig {
  /** Time gap threshold in ms (default: 30 min) */
  timeGapMs: number;
  /** Embedding distance threshold for topic shift (default: 0.6) */
  topicShiftThreshold: number;
  /** Topic summarizer — returns a short topic string for a set of events */
  summarizeTopic?: (events: MemoryEvent[]) => string | Promise<string>;
}

const DEFAULT_CONFIG: EpisodeDetectionConfig = {
  timeGapMs: 30 * 60 * 1000,
  topicShiftThreshold: 0.6,
};

/** Check if there's a boundary between two consecutive events. */
function isBoundary(prev: MemoryEvent, curr: MemoryEvent, config: EpisodeDetectionConfig): boolean {
  // 1. Time gap
  const gap = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
  if (gap > config.timeGapMs) {
    return true;
  }

  // 2. Task ID change
  const prevTask = prev.metadata?.taskId;
  const currTask = curr.metadata?.taskId;
  if (prevTask && currTask && prevTask !== currTask) {
    return true;
  }

  // 3. Explicit session boundary
  if (curr.kind === "system_event" && curr.content.includes("[session_start]")) {
    return true;
  }

  return false;
}

/** Extract unique participants from events. */
function extractParticipants(events: MemoryEvent[]): string[] {
  const participants = new Set<string>();
  for (const e of events) {
    if (e.kind === "user_message") {
      participants.add(e.sessionKey ?? "user");
    }
    if (e.kind === "agent_message") {
      participants.add("agent");
    }
  }
  return [...participants];
}

/**
 * Derive an episode's key-decision trace from its events (SS3 Task 0b).
 *
 * A "key decision" is a consequential action the agent took — represented by its
 * `tool_call` events. This is the signal `buildEpisode` previously left empty,
 * which made `isSkillWorthy`'s third gate decline EVERY freshly-detected episode
 * (the library only ever grew by hand-seeding / compose).
 *
 * A SINGLE tool call is a trivial one-shot, NOT "a multi-step procedure worth
 * encoding" (the explicit intent of `isSkillWorthy`). Only a SEQUENCE of two or
 * more actions constitutes a procedure's decision trace, so a lone tool call
 * yields an empty trace → the strict gate still declines it (no library bloat).
 * The two-or-more boundary is the *definition* of multi-step (one vs many), not a
 * tunable budget/threshold — distinct from the J16 live-margin bounds elsewhere.
 */
function extractKeyDecisions(events: MemoryEvent[]): string[] {
  const actions = events
    .filter((e) => e.kind === "tool_call")
    .map((e) => e.content.split(/\r?\n/)[0]?.trim().slice(0, 120) ?? "")
    .filter((s) => s.length > 0);
  return actions.length >= 2 ? actions : [];
}

/** Infer outcome from events. */
function inferOutcome(events: MemoryEvent[]): Episode["outcome"] {
  const last = events[events.length - 1];
  if (!last) {
    return "abandoned";
  }
  if (last.kind === "system_event" && last.content.includes("[session_end]")) {
    return "completed";
  }
  // If the last event is a user message with no response, likely abandoned
  if (last.kind === "user_message") {
    return "abandoned";
  }
  return "completed";
}

/** Default topic extractor — first few words of first user message. */
function defaultTopicExtractor(events: MemoryEvent[]): string {
  const firstUser = events.find((e) => e.kind === "user_message");
  if (!firstUser) {
    return "system activity";
  }
  const words = firstUser.content.split(/\s+/).slice(0, 10);
  return words.join(" ").slice(0, 80) || "conversation";
}

/**
 * Detect episodes from a stream of events.
 * All events must be sorted chronologically.
 */
export async function detectEpisodes(
  events: MemoryEvent[],
  config: Partial<EpisodeDetectionConfig> = {},
): Promise<Episode[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (events.length === 0) {
    return [];
  }

  const episodes: Episode[] = [];
  let currentBatch: MemoryEvent[] = [events[0]];

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];

    if (isBoundary(prev, curr, cfg)) {
      // Flush current batch as an episode
      episodes.push(await buildEpisode(currentBatch, cfg));
      currentBatch = [curr];
    } else {
      currentBatch.push(curr);
    }
  }

  // Flush remaining
  if (currentBatch.length > 0) {
    episodes.push(await buildEpisode(currentBatch, cfg));
  }

  return episodes;
}

async function buildEpisode(
  events: MemoryEvent[],
  config: EpisodeDetectionConfig,
): Promise<Episode> {
  const topic = config.summarizeTopic
    ? await config.summarizeTopic(events)
    : defaultTopicExtractor(events);

  return {
    id: randomUUID(),
    startEventId: events[0].id,
    endEventId: events[events.length - 1].id,
    startTime: events[0].timestamp,
    endTime: events[events.length - 1].timestamp,
    turnCount: events.filter((e) => e.kind === "user_message").length,
    topic,
    participants: extractParticipants(events),
    outcome: inferOutcome(events),
    keyDecisions: extractKeyDecisions(events),
    sourceEventIds: events.map((e) => e.id),
  };
}

/**
 * Track consolidation progress — which events have been processed.
 */
export interface ConsolidationState {
  lastConsolidatedEventId: string | null;
  lastConsolidatedAt: string | null;
  episodeCount: number;
}

export function createInitialConsolidationState(): ConsolidationState {
  return {
    lastConsolidatedEventId: null,
    lastConsolidatedAt: null,
    episodeCount: 0,
  };
}
