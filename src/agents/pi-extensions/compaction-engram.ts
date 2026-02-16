/**
 * ENGRAM Compaction Extension — pointer-based compaction for the Pi agent framework.
 *
 * Instead of generating a narrative summary (lossy), this extension:
 * 1. Persists all messages being compacted to the ENGRAM event store (lossless)
 * 2. Returns time-range markers as the "summary" — compact pointers with topic hints
 *    and a retrieval directive, rather than a narrative that destroys detail.
 *
 * The Pi framework expects a summary string back from session_before_compact.
 * We return rendered time-range markers that serve as the agent's "breadcrumbs"
 * for what was evicted and how to retrieve it.
 *
 * FORK-ISOLATED: This file is unique to our fork.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { EventStore } from "../../memory/engram/event-store.js";
import { createTimeRangeMarker, renderMarker } from "../../memory/engram/time-range-marker.js";
import type { EventKind, MemoryEvent } from "../../memory/engram/event-types.js";
import { EngramMetrics } from "../../memory/engram/metrics.js";

/** Map Pi agent message roles to ENGRAM event kinds. */
function roleToEventKind(role: string, isError?: boolean): EventKind {
  switch (role) {
    case "user":
      return "user_message";
    case "assistant":
      return "agent_message";
    case "toolCall":
      return "tool_call";
    case "toolResult":
      return isError ? "tool_result" : "tool_result";
    case "system":
      return "system_event";
    default:
      return "system_event";
  }
}

/** Extract text content from a Pi agent message. */
function extractMessageText(msg: AgentMessage): string {
  const content = (msg as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: unknown) =>
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text",
      )
      .map((block: unknown) => String((block as Record<string, unknown>).text ?? ""))
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

/** Rough token estimate (4 chars per token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export default function compactionEngramExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, _ctx) => {
    const { preparation } = event;
    const messagesToCompact = preparation.messagesToSummarize;
    const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
    const allMessages = [...messagesToCompact, ...turnPrefixMessages];

    if (allMessages.length === 0) {
      return {
        compaction: {
          summary: "[No messages to compact]",
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    }

    // 1. Persist all messages to ENGRAM event store
    const store = new EventStore();
    const metrics = new EngramMetrics();
    const events: MemoryEvent[] = [];
    let totalTokens = 0;
    const topicHints: string[] = [];

    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i] as AgentMessage & Record<string, unknown>;
      const role = String(msg.role ?? "system");
      const isError = msg.isError === true;
      const text = extractMessageText(msg);
      const tokens = estimateTokens(text);
      totalTokens += tokens;

      const ev = store.append({
        kind: roleToEventKind(role, isError),
        content: text,
        tokens,
        sessionKey: "live",
        metadata: {
          tags: role === "toolResult" && msg.toolName ? [String(msg.toolName)] : undefined,
        },
      });
      events.push(ev);

      // Extract topic hints from user messages and tool names
      if (role === "user" && text.length > 0) {
        const words = text.split(/\s+/).slice(0, 5).join(" ");
        if (words.length > 3) topicHints.push(words);
      }
      if (role === "toolResult" && msg.toolName) {
        topicHints.push(String(msg.toolName));
      }
    }

    // 2. Create time-range marker
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const marker = createTimeRangeMarker({
      startTurnId: 0,
      endTurnId: allMessages.length - 1,
      startTime: firstEvent.timestamp,
      endTime: lastEvent.timestamp,
      topicHints: [...new Set(topicHints)].slice(0, 5),
      eventCount: events.length,
      tokenCount: totalTokens,
    });

    // 3. Render marker as the "summary"
    const rendered = renderMarker(marker);

    metrics.record("compaction", "engram_compaction", 1, {
      eventsStored: events.length,
      tokensEvicted: totalTokens,
      markerTokens: estimateTokens(rendered),
    });

    return {
      compaction: {
        summary: rendered,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { engramEventsStored: events.length, tokensEvicted: totalTokens },
      },
    };
  });
}
