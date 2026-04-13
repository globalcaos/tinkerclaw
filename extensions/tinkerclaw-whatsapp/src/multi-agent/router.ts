/**
 * WhatsApp Protocol v2 — Multi-Agent Router
 *
 * Determines which agent(s) should respond to an inbound message in an intra-agent chat.
 * Handles self-message filtering, addressing detection, and mode-based routing.
 */

import type { AgentConfig, ChatMode, RoutingDecision } from "./types.js";

/**
 * Parse the origin agent from a message by detecting icon prefix.
 * Returns the agentId and the message text with the icon stripped.
 */
export function parseAgentOrigin(
  messageText: string,
  agents: AgentConfig[],
): { agentId: string | null; strippedText: string } {
  const trimmed = messageText.trimStart();
  for (const agent of agents) {
    if (trimmed.startsWith(agent.icon)) {
      const afterIcon = trimmed.slice(agent.icon.length).trimStart();
      return { agentId: agent.id, strippedText: afterIcon };
    }
  }
  return { agentId: null, strippedText: messageText };
}

/**
 * Detect if a message addresses a specific agent by name.
 * Matches patterns like "Luna, what do you think?" or "Hey Rex —"
 */
export function detectAddressing(text: string, agents: AgentConfig[]): string | null {
  const lower = text.toLowerCase().trimStart();
  for (const agent of agents) {
    const name = agent.name.toLowerCase();
    // Match: "name," or "name " or "name:" or "name—" at start of message
    // Also match "hey name" / "ok name" prefixes
    const patterns = [
      new RegExp(`^${escapeRegex(name)}[,:\\s—–-]`, "i"),
      new RegExp(`^(?:hey|ok|hi|yo)\\s+${escapeRegex(name)}[,:\\s—–-]?`, "i"),
    ];
    if (patterns.some((p) => p.test(lower))) {
      return agent.id;
    }
  }
  return null;
}

/**
 * Central routing decision: should this agent respond to the message?
 */
export function shouldAgentRespond(params: {
  myAgentId: string;
  originAgentId: string | null;
  addressedAgentId: string | null;
  chatMode: ChatMode;
  congestionDelayMs: number;
}): RoutingDecision {
  const { myAgentId, originAgentId, addressedAgentId, chatMode, congestionDelayMs } = params;

  // Self-message filtering: never respond to your own messages.
  if (originAgentId === myAgentId) {
    return { respond: false, delayMs: 0, reason: "self-message" };
  }

  // Addressed mode: only the named agent responds.
  if (addressedAgentId !== null) {
    if (addressedAgentId === myAgentId) {
      return { respond: true, delayMs: 0, reason: "directly-addressed" };
    }
    return { respond: false, delayMs: 0, reason: "addressed-to-other" };
  }

  // Mode-based routing.
  switch (chatMode) {
    case "broadcast":
      return { respond: true, delayMs: congestionDelayMs, reason: "broadcast" };

    case "addressed":
      // In addressed mode with no specific addressee, only respond if from human (no agentId).
      if (originAgentId === null) {
        return { respond: true, delayMs: congestionDelayMs, reason: "addressed-human-broadcast" };
      }
      return { respond: false, delayMs: 0, reason: "addressed-mode-no-mention" };

    case "round-robin":
      // Round-robin is handled externally by turn order; always allow with congestion delay.
      return { respond: true, delayMs: congestionDelayMs, reason: "round-robin" };

    default:
      return { respond: false, delayMs: 0, reason: "unknown-mode" };
  }
}

/**
 * Full routing pipeline for an inbound message in an intra-agent chat.
 */
export function routeInboundMessage(params: {
  messageText: string;
  myAgentId: string;
  agents: AgentConfig[];
  chatMode: ChatMode;
  congestionDelayMs: number;
}): RoutingDecision & { originAgentId: string | null; addressedAgentId: string | null } {
  const { messageText, myAgentId, agents, chatMode, congestionDelayMs } = params;

  const { agentId: originAgentId, strippedText } = parseAgentOrigin(messageText, agents);
  const addressedAgentId = detectAddressing(strippedText, agents);

  const decision = shouldAgentRespond({
    myAgentId,
    originAgentId,
    addressedAgentId,
    chatMode,
    congestionDelayMs,
  });

  return { ...decision, originAgentId, addressedAgentId };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
