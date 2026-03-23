// ============================================================
// src/amygdala/situation-template.ts
// Builds SituationTemplate from ActionRequest + SessionContext.
// ALL I/O is async — no execSync, no statSync, no blocking calls.
// ============================================================

import { promises as fs } from "fs";
import * as path from "path";
import type { GitCache } from "./git-cache.js";
import type {
  SituationTemplate,
  ActionType,
  TargetType,
  Reversibility,
  BlastRadius,
  EmotionalSignal,
  ConfirmationLevel,
  AmygdalaConfig,
} from "./types.js";

// ── Public interfaces ─────────────────────────────────────────

export interface ActionRequest {
  /** The raw action type string from the runtime */
  type: string;
  /** The target identifier (file path, recipient, table name, etc.) */
  target: string;
  /** Additional metadata from the action request */
  metadata?: Record<string, unknown>;
}

export interface SessionContext {
  /** Current session topic (LLM-provided) */
  topic: string;
  /** Emotional state estimate (LLM-provided) */
  emotionalState: EmotionalSignal;
  /** Effort hours estimate (LLM-provided) */
  effortHoursEstimate: number;
  /** Number of user corrections in last 24h */
  correctionCount24h: number;
  /** Automation depth (call stack depth from human-initiated action) */
  automationDepth: number;
  /** Whether a confirmation step is configured */
  confirmationEnabled: boolean;
  /** Confirmation level */
  confirmationLevel: ConfirmationLevel;
  /** Session duration in hours */
  sessionDuration: number;
  /** Action count this session */
  actionCount: number;
  /** Topic centroid embedding (running EMA, τ=0.9) */
  topicCentroid: Float32Array | null;
  /** Recent transcript messages for mention searching */
  recentTranscripts: string[];
}

// ── Core builder ──────────────────────────────────────────────

/**
 * Builds a SituationTemplate from an ActionRequest and SessionContext.
 *
 * 16 slots total:
 *   13 programmatic (P): action_type, target_type, target_id, age_hours, size,
 *     recent_commits, recent_authors, last_human_ref, recent_corrections,
 *     automation_depth, topic_drift, reversible, blast_radius, human_in_loop,
 *     confirmation, timestamp
 *   3 LLM-estimated (L): effort_hours, session_topic, emotional_signals
 *
 * LLM-estimated slots receive 0.3x training weight. Cross-checks are applied
 * to catch obviously wrong estimates (e.g. "calm" despite 5 corrections).
 *
 * All I/O (stat, git) is async. embedFn is called once for topic_drift.
 */
export async function buildSituation(
  action: ActionRequest,
  context: SessionContext,
  config: AmygdalaConfig,
  gitCache: GitCache,
  embedFn: (text: string) => Promise<Float32Array>,
): Promise<SituationTemplate> {
  // ── Slot 1-3: classify action and target (programmatic) ────
  const actionType = classifyActionType(action.type, config);
  const targetType = classifyTargetType(action.target, config);
  const targetId = action.target;

  // ── Slots 4-5: target file stats (async, programmatic) ─────
  const [ageHours, size] = await Promise.all([
    getTargetAgeHours(targetId, targetType),
    getTargetSize(targetId, targetType),
  ]);

  // ── Slots 6-7: git metadata (async, programmatic) ──────────
  const [recentCommits, recentAuthors] = await Promise.all([
    gitCache.getRecentCommits(targetId, 72),
    gitCache.getRecentAuthors(targetId, 72),
  ]);

  // ── Slot 8: last human reference (programmatic) ────────────
  const lastHumanRef = getLastHumanReference(targetId, context.recentTranscripts);

  // ── Slots 9-10: corrections and automation depth (programmatic) ─
  const recentCorrections = context.correctionCount24h;
  const automationDepth = context.automationDepth;

  // ── Slot 11: topic drift (programmatic, but uses embedFn) ───
  let topicDrift = 0.0;
  if (context.topicCentroid !== null) {
    try {
      const actionEmbedding = await embedFn(`${actionType} ${targetType} ${targetId}`);
      topicDrift = 1.0 - cosineSimilarity(context.topicCentroid, actionEmbedding);
      // Clamp to [0, 1] — cosine similarity can be slightly outside due to float rounding
      topicDrift = Math.max(0.0, Math.min(1.0, topicDrift));
    } catch {
      // embedFn not available yet (e.g. models not loaded) — default to neutral
      topicDrift = 0.0;
    }
  }

  // ── Slots 12-15: scope (programmatic lookup tables) ─────────
  const reversible = getReversibility(actionType, targetType, config);
  const blastRadius = getBlastRadius(targetType, config);
  const humanInLoop = context.confirmationEnabled;
  const confirmation = context.confirmationLevel;

  // ── Slot 16 (LLM-estimated): effort_hours with cross-check ──
  const effortHours = crossCheckEffort(
    context.effortHoursEstimate,
    context.sessionDuration,
    context.actionCount,
    recentCommits,
  );

  // ── Slot 17 (LLM-estimated): emotional_signals with cross-check ─
  const emotionalSignals = crossCheckEmotion(
    context.emotionalState,
    recentCorrections,
    context.recentTranscripts,
  );

  // ── Slot 18 (LLM-estimated): session_topic ──────────────────
  const sessionTopic = context.topic || "unknown";

  // ── Assemble template ────────────────────────────────────────
  const template: SituationTemplate = {
    action_type: actionType,
    target_type: targetType,
    target_id: targetId,
    target_metadata: {
      age_hours: ageHours,
      size,
      recent_commits: recentCommits,
      recent_authors: recentAuthors,
      effort_hours: effortHours,
      last_human_ref: lastHumanRef,
    },
    context: {
      session_topic: sessionTopic,
      recent_corrections: recentCorrections,
      emotional_signals: emotionalSignals,
      automation_depth: automationDepth,
      topic_drift: topicDrift,
    },
    scope: {
      reversible,
      blast_radius: blastRadius,
      human_in_loop: humanInLoop,
      confirmation,
    },
    timestamp: new Date().toISOString(),
    _slot_sources: {
      // Programmatic slots
      action_type: "programmatic",
      target_type: "programmatic",
      target_id: "programmatic",
      age_hours: "programmatic",
      size: "programmatic",
      recent_commits: "programmatic",
      recent_authors: "programmatic",
      last_human_ref: "programmatic",
      recent_corrections: "programmatic",
      automation_depth: "programmatic",
      topic_drift: "programmatic",
      reversible: "programmatic",
      blast_radius: "programmatic",
      human_in_loop: "programmatic",
      confirmation: "programmatic",
      // LLM-estimated slots (0.3x training weight)
      effort_hours: "llm_estimated",
      session_topic: "llm_estimated",
      emotional_signals: "llm_estimated",
    },
  };

  return template;
}

// ── Deterministic serializer ──────────────────────────────────

/**
 * Serialize a SituationTemplate to a natural language string for embedding.
 *
 * Deterministic — given the same template, produces identical output.
 * No LLM involvement. Used as input to the sentence encoder.
 *
 * Format matches the paper example (§6.4 README debacle):
 *   'Action: overwrite file "README.md". Target: 14200 bytes, 2160h old, ...'
 */
export function serializeSituation(template: SituationTemplate): string {
  const m = template.target_metadata;
  const c = template.context;
  const s = template.scope;

  const parts = [
    `Action: ${template.action_type} ${template.target_type} "${template.target_id}".`,
    `Target: ${m.size} bytes, ${Math.round(m.age_hours)}h old, ${m.recent_commits} commits by ${m.recent_authors} authors in 72h.`,
    `Effort: ~${m.effort_hours.toFixed(1)}h invested, last mentioned ${Math.round(m.last_human_ref)}h ago.`,
    `Context: ${c.session_topic}. ${c.recent_corrections} corrections in 24h. Mood: ${c.emotional_signals}. Topic drift: ${c.topic_drift.toFixed(2)}.`,
    `Automation depth: ${c.automation_depth}.`,
    `Reversible: ${s.reversible}. Blast: ${s.blast_radius}. Human in loop: ${s.human_in_loop}. Confirmation: ${s.confirmation}.`,
  ];

  return parts.join(" ");
}

// ── Action classification ─────────────────────────────────────

/**
 * Classify raw action type string into a typed ActionType.
 * Checks config overrides first, then falls back to built-in defaults.
 */
export function classifyActionType(raw: string, config: AmygdalaConfig): ActionType {
  const lower = raw.toLowerCase();
  const mapped = config.action_type_map[lower];
  if (mapped) {
    return mapped;
  }

  // Built-in defaults for common runtime action names
  const defaults: Record<string, ActionType> = {
    write: "overwrite",
    write_file: "overwrite",
    create_file: "create",
    delete_file: "delete",
    rm: "delete",
    send_message: "send",
    send_email: "send",
    git_merge: "merge",
    git_push: "deploy",
    exec: "execute",
    run: "execute",
    mv: "move",
    cp: "copy",
    edit: "modify",
    patch: "modify",
  };

  return (defaults[lower] as ActionType) || "execute";
}

/**
 * Classify target identifier into a typed TargetType.
 * Checks config overrides first, then falls back to heuristic patterns.
 */
export function classifyTargetType(target: string, config: AmygdalaConfig): TargetType {
  // Check config overrides first
  for (const [pattern, type] of Object.entries(config.target_type_map)) {
    if (target.includes(pattern)) {
      return type as TargetType;
    }
  }

  // Heuristic classification based on target string shape
  if (target.match(/^https?:\/\//)) {
    return "api_call";
  }
  if (target.startsWith("git ") || target.startsWith("git/")) {
    return "git_operation";
  }
  if (target.includes("@") && target.includes(".")) {
    return "email";
  }
  if (target.match(/^\+?\d{7,}/)) {
    return "message";
  } // Phone numbers
  if (target.toLowerCase().includes("whatsapp") || target.toLowerCase().includes("telegram")) {
    return "message";
  }
  if (
    target.includes(".sqlite") ||
    target.includes("database") ||
    target.toLowerCase().includes("table")
  ) {
    return "database";
  }
  if (target.match(/^\//) || target.match(/^[~/.]/) || target.includes(".")) {
    return "file";
  }
  if (
    target.includes("config") ||
    target.includes("settings") ||
    target.includes(".json") ||
    target.includes(".yaml")
  ) {
    return "configuration";
  }
  if (target.includes("deploy") || target.includes("prod") || target.includes("staging")) {
    return "deployment";
  }

  return "system_command";
}

// ── Async stat helpers ────────────────────────────────────────

/**
 * Get age of target in hours from last modification time.
 * Returns -1 for non-file targets or files that don't exist.
 * ASYNC: uses fs.promises.stat — never blocks the event loop.
 */
export async function getTargetAgeHours(targetId: string, targetType: TargetType): Promise<number> {
  if (targetType !== "file") {
    return -1;
  }
  try {
    const stat = await fs.stat(targetId); // async — never statSync
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs / (1000 * 60 * 60);
  } catch {
    return -1; // File doesn't exist yet (create action) or not accessible
  }
}

/**
 * Get size of target in bytes.
 * Returns 0 for non-file targets or files that don't exist.
 * ASYNC: uses fs.promises.stat — never blocks the event loop.
 */
export async function getTargetSize(targetId: string, targetType: TargetType): Promise<number> {
  if (targetType !== "file") {
    return 0;
  }
  try {
    const stat = await fs.stat(targetId); // async — never statSync
    return stat.size;
  } catch {
    return 0;
  }
}

// ── Context helpers ───────────────────────────────────────────

/**
 * Find how many hours ago the human last referenced this target in the transcript.
 * Searches backwards through transcripts (each entry ≈ 5 minutes apart).
 * Returns 999 if never mentioned.
 */
export function getLastHumanReference(targetId: string, transcripts: string[]): number {
  const targetName = path.basename(targetId);

  // Search backwards through transcripts for a mention
  for (let i = transcripts.length - 1; i >= 0; i--) {
    const text = transcripts[i];
    if (text.includes(targetName) || (targetId.length > 3 && text.includes(targetId))) {
      // Each transcript entry represents ~5 minutes
      const stepsBack = transcripts.length - 1 - i;
      return (stepsBack * 5) / 60; // Convert to hours
    }
  }

  return 999; // Never mentioned in current transcript window
}

// ── LLM-estimated slot cross-checks ──────────────────────────

/**
 * Cross-check LLM's effort estimate against heuristic signals.
 *
 * The LLM may underestimate effort. We compute a heuristic from:
 *   - Session duration × (action rate vs expected)
 *   - Recent commits × estimated effort per commit
 *
 * We take max(llmEstimate, 0.7 × heuristic) — erring on caution.
 * This means we only override upward, never downward.
 */
export function crossCheckEffort(
  llmEstimate: number,
  sessionDurationHours: number,
  actionCount: number,
  recentCommits: number,
): number {
  // Heuristic: session effort ≈ sessionDuration × (actionCount / expectedActionsPerHour)
  const expectedActionsPerHour = 10;
  const sessionHeuristic =
    sessionDurationHours * (actionCount / Math.max(expectedActionsPerHour, 1));

  // Commit heuristic: each commit ≈ 0.5h of invested effort
  const commitHeuristic = recentCommits * 0.5;

  const combinedHeuristic = Math.max(sessionHeuristic, commitHeuristic);

  // If LLM says low but heuristic says high → use heuristic (conservative)
  // If LLM says high → trust it (already erring on caution side)
  return Math.max(llmEstimate, combinedHeuristic * 0.7);
}

/**
 * Cross-check LLM's emotional state estimate against behavioral signals.
 *
 * Overrides:
 *   - ≥3 corrections + 'calm' estimate → 'frustrated' (corrections imply frustration)
 *   - Very short recent messages + 'calm' estimate → 'terse'
 *
 * Never downgrades a non-calm estimate (conservative — we don't dismiss frustration).
 */
export function crossCheckEmotion(
  llmEstimate: EmotionalSignal,
  recentCorrections: number,
  transcripts: string[],
): EmotionalSignal {
  // High correction count strongly indicates frustration
  if (recentCorrections >= 3 && llmEstimate === "calm") {
    return "frustrated";
  }

  // Check recent message length — very short messages suggest terse/frustrated mood
  const recentMessages = transcripts.slice(-10);
  if (recentMessages.length > 0) {
    const avgLength = recentMessages.reduce((sum, t) => sum + t.length, 0) / recentMessages.length;
    if (avgLength < 20 && llmEstimate === "calm") {
      return "terse";
    }
  }

  return llmEstimate;
}

// ── Scope helpers ─────────────────────────────────────────────

/**
 * Determine reversibility from action + target type combination.
 * Checks config map first, then falls back to built-in defaults.
 */
export function getReversibility(
  actionType: ActionType,
  targetType: TargetType,
  config: AmygdalaConfig,
): Reversibility {
  const key = `${actionType}:${targetType}`;
  if (config.reversibility_map[key]) {
    return config.reversibility_map[key];
  }

  // Default lookup: conservative estimates
  const defaults: Record<ActionType, Reversibility> = {
    overwrite: "true", // git can recover local files
    delete: "partial", // may be recoverable from trash/git
    send: "false", // messages cannot be unsent
    merge: "true", // git revert
    create: "true", // can delete the created file
    modify: "true", // git can recover
    execute: "partial", // depends on what the command does
    deploy: "partial", // can rollback but may have external side effects
    revert: "true", // reverting a revert is just another commit
    move: "true", // can move back
    copy: "true", // can delete the copy
  };

  return defaults[actionType] || "partial";
}

/**
 * Determine blast radius from target type.
 * Checks config map first, then falls back to built-in defaults.
 */
export function getBlastRadius(targetType: TargetType, config: AmygdalaConfig): BlastRadius {
  if (config.blast_radius_map[targetType]) {
    return config.blast_radius_map[targetType];
  }

  const defaults: Record<TargetType, BlastRadius> = {
    file: "persistent",
    email: "external",
    message: "external",
    database: "persistent",
    api_call: "external",
    git_operation: "persistent",
    system_command: "session",
    configuration: "persistent",
    deployment: "external",
  };

  return defaults[targetType] || "session";
}

// ── Math helpers ──────────────────────────────────────────────

/**
 * Compute cosine similarity between two Float32Arrays.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
