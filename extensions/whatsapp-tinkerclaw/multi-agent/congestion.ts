/**
 * WhatsApp Protocol v2 — Congestion Control
 *
 * Exponential Courtesy Protocol: prevents message explosion in multi-agent chats.
 * Quadratic base delay, random jitter, backpressure for over-talkers, yield on collision.
 */

import { type CongestionConfig, DEFAULT_CONGESTION_CONFIG, type MessageRecord } from "./types.js";

export class CongestionController {
  private config: CongestionConfig;
  /** chatId → recent messages within sliding window */
  private recentMessages = new Map<string, MessageRecord[]>();
  /** chatId → timestamp of last message seen (for yield detection) */
  private lastMessageTimestamp = new Map<string, number>();

  constructor(config?: Partial<CongestionConfig>) {
    this.config = { ...DEFAULT_CONGESTION_CONFIG, ...config };
  }

  /** Record that an agent sent a message in a chat. */
  recordMessage(chatId: string, agentId: string): void {
    const now = Date.now();
    const records = this.recentMessages.get(chatId) ?? [];
    records.push({ agentId, timestamp: now });
    this.recentMessages.set(chatId, records);
    this.lastMessageTimestamp.set(chatId, now);
    this.pruneWindow(chatId);
  }

  /**
   * Compute the delay (ms) an agent should wait before responding.
   *
   * Algorithm:
   * - Base delay = baseDelayFactor × agentCount² (quadratic scaling)
   * - Jitter = random [0, baseDelay) (prevents synchronization)
   * - Backpressure = 2× if agent exceeds fair share by backpressureThreshold
   * - Capped at maxDelay
   */
  computeDelay(chatId: string, myAgentId: string, agentCount: number): number {
    if (!this.config.enabled || agentCount <= 1) {
      return 0;
    }

    this.pruneWindow(chatId);
    const records = this.recentMessages.get(chatId) ?? [];

    // Base delay: quadratic in agent count.
    const baseDelay = this.config.baseDelayFactor * agentCount ** 2;

    // Jitter: random [0, baseDelay).
    const jitter = Math.random() * baseDelay;

    // Backpressure: am I talking too much?
    let backpressure = 1.0;
    if (records.length > 0) {
      const myMessages = records.filter((m) => m.agentId === myAgentId).length;
      const fairShare = records.length / agentCount;
      if (myMessages > fairShare * this.config.backpressureThreshold) {
        backpressure = 2.0;
      }
    }

    return Math.min((baseDelay + jitter) * backpressure, this.config.maxDelay);
  }

  /**
   * Check if another agent posted since a given timestamp (yield detection).
   * If true, the waiting agent should restart its delay timer.
   */
  shouldYield(chatId: string, sinceTsMs: number): boolean {
    const lastTs = this.lastMessageTimestamp.get(chatId);
    return lastTs !== undefined && lastTs > sinceTsMs;
  }

  /** Get recent message count for a chat (within sliding window). */
  getRecentCount(chatId: string): number {
    this.pruneWindow(chatId);
    return this.recentMessages.get(chatId)?.length ?? 0;
  }

  /** Get message count for a specific agent in the window. */
  getAgentCount(chatId: string, agentId: string): number {
    this.pruneWindow(chatId);
    return this.recentMessages.get(chatId)?.filter((m) => m.agentId === agentId).length ?? 0;
  }

  private pruneWindow(chatId: string): void {
    const records = this.recentMessages.get(chatId);
    if (!records) return;
    const cutoff = Date.now() - this.config.windowMs;
    const pruned = records.filter((m) => m.timestamp > cutoff);
    if (pruned.length === 0) {
      this.recentMessages.delete(chatId);
    } else {
      this.recentMessages.set(chatId, pruned);
    }
  }
}
