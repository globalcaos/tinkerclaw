/**
 * WhatsApp Protocol v2 — Multi-Agent Types
 *
 * Shared type definitions for router, congestion, lifecycle, and budget modules.
 */

export type AgentConfig = {
  id: string;
  name: string;
  icon: string;
  soulPath?: string;
  model?: string;
};

export type ChatMode = "broadcast" | "addressed" | "round-robin";

export type IntraAgentChat = {
  chatId: string;
  participants: string[];
  owner: string;
  mode: ChatMode;
  defaultObjective?: string;
};

export type CongestionConfig = {
  enabled: boolean;
  /** Base delay factor in ms (multiplied by agentCount²). */
  baseDelayFactor: number;
  /** Maximum delay cap in ms. */
  maxDelay: number;
  /** Backpressure threshold as ratio above fair share. */
  backpressureThreshold: number;
  /** Sliding window in ms for recent message tracking. */
  windowMs: number;
};

export const DEFAULT_CONGESTION_CONFIG: CongestionConfig = {
  enabled: true,
  baseDelayFactor: 150,
  maxDelay: 30_000,
  backpressureThreshold: 1.5,
  windowMs: 60_000,
};

export type LifecycleConfig = {
  /** Number of recent messages to compare for staleness. */
  stalenessWindow: number;
  /** Cosine similarity threshold for staleness detection. */
  stalenessThreshold: number;
  /** Max turns per conversation objective. */
  maxTurnsPerObjective: number;
  /** Auto-close conversation when objective is met. */
  autoClose: boolean;
};

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  stalenessWindow: 5,
  stalenessThreshold: 0.85,
  maxTurnsPerObjective: 30,
  autoClose: true,
};

export type BudgetMode = "conservative" | "moderate" | "aggressive" | "burn";

export type BudgetConfig = {
  provider: string;
  windowDays: number;
  burnModeEnabled: boolean;
  burnTriggerHours: number;
  burnUsageThreshold: number;
};

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  provider: "anthropic",
  windowDays: 7,
  burnModeEnabled: true,
  burnTriggerHours: 24,
  burnUsageThreshold: 0.2,
};

export type MessageRecord = {
  agentId: string;
  timestamp: number;
};

export type ConversationState = {
  chatId: string;
  objective: string | null;
  turnCount: number;
  recentEmbeddings: number[][];
  recentTexts: string[];
  closureProposedBy: string | null;
  closureAcks: Set<string>;
  pivotAgentId: string | null;
  pivotExpiresAtTurn: number;
};

export type RoutingDecision = {
  respond: boolean;
  delayMs: number;
  reason: string;
};
