/**
 * FORK: Situation template builder for AMYGDALA.
 *
 * Builds SituationTemplate from ActionRequest + SessionContext.
 * All I/O is async -- no execSync, no statSync, no blocking calls.
 * Self-contained: no imports from upstream src/.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
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

// -- Public interfaces --

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
  /** Topic centroid embedding (running EMA) */
  topicCentroid: Float32Array | null;
  /** Recent transcript messages for mention searching */
  recentTranscripts: string[];
}

// -- Core builder --

/**
 * Builds a SituationTemplate from an ActionRequest and SessionContext.
 * All I/O (stat, git) is async.
 */
export async function buildSituation(
  action: ActionRequest,
  context: SessionContext,
  config: AmygdalaConfig,
  gitCache: GitCache,
  embedFn: (text: string) => Promise<Float32Array>,
): Promise<SituationTemplate> {
  const actionType = classifyActionType(action.type, config);
  const targetType = classifyTargetType(action.target, config);
  const targetId = action.target;

  const [ageHours, size] = await Promise.all([
    getTargetAgeHours(targetId, targetType),
    getTargetSize(targetId, targetType),
  ]);

  // Same guard as getTargetAgeHours/getTargetSize above. classifyTargetType
  // falls back to "file" for anything containing a ".", so a Bash command like
  // `grep -c foo bar.md` classifies as a file and used to be handed to git as a
  // path — see 2026-08-05, when that path reached a shell and launched Orca.
  const [recentCommits, recentAuthors] =
    targetType === "file"
      ? await Promise.all([
          gitCache.getRecentCommits(targetId, 72),
          gitCache.getRecentAuthors(targetId, 72),
        ])
      : [0, 0];

  const lastHumanRef = getLastHumanReference(targetId, context.recentTranscripts);
  const recentCorrections = context.correctionCount24h;
  const automationDepth = context.automationDepth;

  let topicDrift = 0.0;
  if (context.topicCentroid !== null) {
    try {
      const actionEmbedding = await embedFn(`${actionType} ${targetType} ${targetId}`);
      topicDrift = 1.0 - cosineSimilarity(context.topicCentroid, actionEmbedding);
      topicDrift = Math.max(0.0, Math.min(1.0, topicDrift));
    } catch {
      topicDrift = 0.0;
    }
  }

  const reversible = getReversibility(actionType, targetType, config);
  const blastRadius = getBlastRadius(targetType, config);
  const humanInLoop = context.confirmationEnabled;
  const confirmation = context.confirmationLevel;

  const effortHours = crossCheckEffort(
    context.effortHoursEstimate,
    context.sessionDuration,
    context.actionCount,
    recentCommits,
  );

  const emotionalSignals = crossCheckEmotion(
    context.emotionalState,
    recentCorrections,
    context.recentTranscripts,
  );

  const sessionTopic = context.topic || "unknown";

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
      effort_hours: "llm_estimated",
      session_topic: "llm_estimated",
      emotional_signals: "llm_estimated",
    },
  };

  return template;
}

// -- Deterministic serializer --

/**
 * Serialize a SituationTemplate to a natural language string for embedding.
 * Deterministic -- given the same template, produces identical output.
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

// -- Action classification --

export function classifyActionType(raw: string, config: AmygdalaConfig): ActionType {
  const lower = raw.toLowerCase();
  const mapped = config.action_type_map[lower];
  if (mapped) {
    return mapped;
  }

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

export function classifyTargetType(target: string, config: AmygdalaConfig): TargetType {
  for (const [pattern, type] of Object.entries(config.target_type_map)) {
    if (target.includes(pattern)) {
      return type as TargetType;
    }
  }

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
  }
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

// -- Async stat helpers --

export async function getTargetAgeHours(targetId: string, targetType: TargetType): Promise<number> {
  if (targetType !== "file") {
    return -1;
  }
  try {
    const stat = await fs.stat(targetId);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs / (1000 * 60 * 60);
  } catch {
    return -1;
  }
}

export async function getTargetSize(targetId: string, targetType: TargetType): Promise<number> {
  if (targetType !== "file") {
    return 0;
  }
  try {
    const stat = await fs.stat(targetId);
    return stat.size;
  } catch {
    return 0;
  }
}

// -- Context helpers --

export function getLastHumanReference(targetId: string, transcripts: string[]): number {
  const targetName = path.basename(targetId);

  for (let i = transcripts.length - 1; i >= 0; i--) {
    const text = transcripts[i];
    if (text.includes(targetName) || (targetId.length > 3 && text.includes(targetId))) {
      const stepsBack = transcripts.length - 1 - i;
      return (stepsBack * 5) / 60;
    }
  }

  return 999;
}

// -- LLM-estimated slot cross-checks --

export function crossCheckEffort(
  llmEstimate: number,
  sessionDurationHours: number,
  actionCount: number,
  recentCommits: number,
): number {
  const expectedActionsPerHour = 10;
  const sessionHeuristic =
    sessionDurationHours * (actionCount / Math.max(expectedActionsPerHour, 1));
  const commitHeuristic = recentCommits * 0.5;
  const combinedHeuristic = Math.max(sessionHeuristic, commitHeuristic);

  return Math.max(llmEstimate, combinedHeuristic * 0.7);
}

export function crossCheckEmotion(
  llmEstimate: EmotionalSignal,
  recentCorrections: number,
  transcripts: string[],
): EmotionalSignal {
  if (recentCorrections >= 3 && llmEstimate === "calm") {
    return "frustrated";
  }

  const recentMessages = transcripts.slice(-10);
  if (recentMessages.length > 0) {
    const avgLength = recentMessages.reduce((sum, t) => sum + t.length, 0) / recentMessages.length;
    if (avgLength < 20 && llmEstimate === "calm") {
      return "terse";
    }
  }

  return llmEstimate;
}

// -- Scope helpers --

export function getReversibility(
  actionType: ActionType,
  targetType: TargetType,
  config: AmygdalaConfig,
): Reversibility {
  const key = `${actionType}:${targetType}`;
  if (config.reversibility_map[key]) {
    return config.reversibility_map[key];
  }

  const defaults: Record<ActionType, Reversibility> = {
    overwrite: "true",
    delete: "partial",
    send: "false",
    merge: "true",
    create: "true",
    modify: "true",
    execute: "partial",
    deploy: "partial",
    revert: "true",
    move: "true",
    copy: "true",
  };

  return defaults[actionType] || "partial";
}

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

// -- Math helpers --

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
