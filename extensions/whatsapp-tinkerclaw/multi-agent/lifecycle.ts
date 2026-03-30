/**
 * WhatsApp Protocol v2 — Conversation Lifecycle Manager
 *
 * Tracks staleness, topic steering, and objective completion for multi-agent conversations.
 * Uses cosine similarity of message embeddings to detect circular discussions.
 */

import { type ConversationState, DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from "./types.js";

/** Agreement-loop detection patterns. */
const AGREEMENT_PATTERNS = [
  /\bi agree\b/i,
  /\bgood point\b/i,
  /\bexactly\b/i,
  /\bthat'?s right\b/i,
  /\byou'?re right\b/i,
  /\babsolutely\b/i,
  /\bwell said\b/i,
  /\bcouldn'?t agree more\b/i,
  /\bspot on\b/i,
  /\bprecisely\b/i,
];

/** Cosine similarity between two vectors. Returns 0 if either is empty/zero-length. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export class ConversationLifecycleManager {
  private config: LifecycleConfig;
  private conversations = new Map<string, ConversationState>();

  constructor(config?: Partial<LifecycleConfig>) {
    this.config = { ...DEFAULT_LIFECYCLE_CONFIG, ...config };
  }

  /** Get or create conversation state for a chat. */
  private getState(chatId: string): ConversationState {
    let state = this.conversations.get(chatId);
    if (!state) {
      state = {
        chatId,
        objective: null,
        turnCount: 0,
        recentEmbeddings: [],
        recentTexts: [],
        closureProposedBy: null,
        closureAcks: new Set(),
        pivotAgentId: null,
        pivotExpiresAtTurn: 0,
      };
      this.conversations.set(chatId, state);
    }
    return state;
  }

  /** Record a new turn in the conversation. */
  recordTurn(chatId: string, agentId: string, text: string, embedding?: number[]): void {
    const state = this.getState(chatId);
    state.turnCount++;

    // Keep sliding window of recent texts and embeddings.
    state.recentTexts.push(text);
    if (state.recentTexts.length > this.config.stalenessWindow) {
      state.recentTexts.shift();
    }

    if (embedding) {
      state.recentEmbeddings.push(embedding);
      if (state.recentEmbeddings.length > this.config.stalenessWindow) {
        state.recentEmbeddings.shift();
      }
    }

    // Clear closure proposal if new substantive content arrives.
    if (state.closureProposedBy && state.closureProposedBy !== agentId) {
      // Another agent spoke after closure was proposed — might be dissent.
      // Don't auto-clear; let ackClosure or explicit rejection handle it.
    }
  }

  /** Compute average cosine similarity of consecutive recent embeddings. */
  getStalenessScore(chatId: string): number {
    const state = this.getState(chatId);
    const embeddings = state.recentEmbeddings;
    if (embeddings.length < 2) return 0;

    let totalSim = 0;
    let pairs = 0;
    for (let i = 1; i < embeddings.length; i++) {
      totalSim += cosineSimilarity(embeddings[i - 1], embeddings[i]);
      pairs++;
    }
    return pairs > 0 ? totalSim / pairs : 0;
  }

  /** Check if the conversation is stale (high similarity + enough turns). */
  isStale(chatId: string): boolean {
    const state = this.getState(chatId);
    if (state.recentEmbeddings.length < 3) return false;
    return this.getStalenessScore(chatId) > this.config.stalenessThreshold;
  }

  /** Detect agreement loops in recent texts (no new information being added). */
  detectAgreementLoop(chatId: string): boolean {
    const state = this.getState(chatId);
    if (state.recentTexts.length < 3) return false;

    // Check last 3 messages: if majority match agreement patterns, it's a loop.
    const lastN = state.recentTexts.slice(-3);
    const agreementCount = lastN.filter((text) =>
      AGREEMENT_PATTERNS.some((pattern) => pattern.test(text)),
    ).length;

    return agreementCount >= 2;
  }

  /**
   * Propose a topic pivot. Returns true if this agent claimed the pivot role.
   * Only one agent can pivot at a time (for N turns after pivot).
   */
  proposeTopicPivot(chatId: string, agentId: string): boolean {
    const state = this.getState(chatId);
    if (state.pivotAgentId && state.turnCount < state.pivotExpiresAtTurn) {
      return false; // Another agent is already pivoting.
    }
    state.pivotAgentId = agentId;
    state.pivotExpiresAtTurn = state.turnCount + this.config.stalenessWindow;
    return true;
  }

  /** Propose closing the conversation with a summary. */
  proposeClosure(chatId: string, agentId: string, _summary: string): void {
    const state = this.getState(chatId);
    state.closureProposedBy = agentId;
    state.closureAcks.clear();
    state.closureAcks.add(agentId); // Proposer auto-acks.
  }

  /** Acknowledge a closure proposal. */
  ackClosure(chatId: string, agentId: string): void {
    const state = this.getState(chatId);
    if (state.closureProposedBy) {
      state.closureAcks.add(agentId);
    }
  }

  /** Check if the conversation is complete (objective met or all agents acked closure). */
  isConversationComplete(chatId: string, totalAgents: number): boolean {
    const state = this.getState(chatId);

    // Hard cap: max turns exceeded.
    if (state.turnCount >= this.config.maxTurnsPerObjective) {
      return true;
    }

    // All agents acked closure.
    if (state.closureProposedBy && state.closureAcks.size >= totalAgents) {
      return true;
    }

    return false;
  }

  getObjective(chatId: string): string | null {
    return this.getState(chatId).objective;
  }

  setObjective(chatId: string, objective: string): void {
    this.getState(chatId).objective = objective;
  }

  getTurnCount(chatId: string): number {
    return this.getState(chatId).turnCount;
  }

  /** Reset conversation state (for starting a new topic). */
  reset(chatId: string): void {
    this.conversations.delete(chatId);
  }

  /**
   * Update lifecycle config dynamically (e.g., when budget mode changes).
   * Merges partial config with existing.
   */
  updateConfig(partial: Partial<LifecycleConfig>): void {
    this.config = { ...this.config, ...partial };
  }
}
