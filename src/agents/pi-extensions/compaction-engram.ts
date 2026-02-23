/**
 * ENGRAM Compaction Extension — pointer-based compaction for the Pi agent framework.
 *
 * Instead of generating a narrative summary (lossy), this extension:
 * 1. Persists all messages being compacted to the ENGRAM event store (lossless)
 * 2. Returns a compaction "summary" — either a pointer manifest (when pointerMode is
 *    enabled via cfg.agents.defaults.compaction.pointerMode) or rendered time-range
 *    markers as breadcrumbs with topic hints and a retrieval directive.
 *
 * The Pi framework expects a summary string back from session_before_compact.
 *
 * FORK-ISOLATED: This file is unique to our fork.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { createEventStore } from "../../memory/engram/event-store.js";
import { createTimeRangeMarker, renderMarker } from "../../memory/engram/time-range-marker.js";
import type { EventKind, MemoryEvent } from "../../memory/engram/event-types.js";
import { createMetricsCollector } from "../../memory/engram/metrics.js";
import {
  getPointerCompactionRuntime,
  buildManifest,
  renderManifest,
} from "./pointer-compaction-runtime.js";
import { getReflectionRuntime } from "./reflection-runtime.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

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
  const content = (msg as unknown as Record<string, unknown>).content;
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

/**
 * Create the compaction engram extension factory.
 * Accepts the OpenClaw config to resolve feature flags at registration time.
 */
export default function compactionEngramExtension(cfg?: OpenClawConfig): (api: ExtensionAPI) => void {
  return (api: ExtensionAPI): void => {
    api.on("session_before_compact", async (event, ctx) => {
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
      const baseDir = join(process.env.HOME ?? "~", ".openclaw", "engram");
      mkdirSync(baseDir, { recursive: true });
      const store = createEventStore({ baseDir, sessionKey: "compaction" });
      const metrics = createMetricsCollector({ baseDir });
      const events: MemoryEvent[] = [];
      let totalTokens = 0;
      const topicHints: string[] = [];

      for (let i = 0; i < allMessages.length; i++) {
        const msg = allMessages[i] as unknown as Record<string, unknown>;
        const role = String(msg.role ?? "system");
        const isError = msg.isError === true;
        const text = extractMessageText(allMessages[i]);
        const tokens = estimateTokens(text);
        totalTokens += tokens;

        const ev = store.append({
          kind: roleToEventKind(role, isError),
          content: text,
          tokens,
          turnId: i,
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

      // 2. Choose compaction summary strategy based on feature flag
      const pointerMode = cfg?.agents?.defaults?.compaction?.pointerMode === true;
      const ptrHandler = pointerMode ? getPointerCompactionRuntime(ctx.sessionManager) : null;

      let rendered: string;

      if (pointerMode && ptrHandler) {
        // Pointer mode: build a manifest from the persisted events and store it
        // as a compaction_marker in the session event store.
        const manifest = buildManifest(events);
        ptrHandler.eventStore.append({
          turnId: events[events.length - 1]?.turnId ?? 0,
          sessionKey: ptrHandler.eventStore.sessionKey,
          kind: "compaction_marker",
          content: JSON.stringify(manifest),
          tokens: Math.ceil(JSON.stringify(manifest).length / 4),
          metadata: { tags: ["pointer_compaction", "engram_compact"] },
        });
        rendered = renderManifest(manifest);

        metrics.record("compaction", "engram_pointer_compaction", 1, {
          eventsStored: events.length,
          tokensEvicted: totalTokens,
          markerTokens: estimateTokens(rendered),
          pointerMode: 1,
        });
      } else {
        // Default mode: create a time-range marker as a lightweight breadcrumb
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
        rendered = renderMarker(marker);

        metrics.record("compaction", "engram_compaction", 1, {
          eventsStored: events.length,
          tokensEvicted: totalTokens,
          markerTokens: estimateTokens(rendered),
        });
      }

      // Phase 1.5: fire post-compaction self-reflection (fire-and-forget — does
      // not block the compaction response). Severity routing is handled inside:
      //   low    → persisted silently (autoFixApplied = true)
      //   medium → persisted + logged for review
      //   high   → persisted + stderr alert
      const reflector = getReflectionRuntime(ctx.sessionManager);
      if (reflector) {
        void reflector
          .reflectCompaction({
            eventsCompacted: events.length,
            summary: rendered,
            tokensEvicted: totalTokens,
          })
          .then((record) => {
            if (record.severity === "high") {
              console.error(
                `[ENGRAM][reflection] HIGH severity: ${record.diagnosis} — ${record.suggestions.join(" | ")}`,
              );
            } else if (record.severity === "medium") {
              console.warn(
                `[ENGRAM][reflection] medium: ${record.diagnosis}`,
              );
            }
            // low: auto-fix applied silently
          })
          .catch((err: unknown) => {
            // Reflection errors must never surface to the user
            console.error("[ENGRAM][reflection] error:", err);
          });
      }

      return {
        compaction: {
          summary: rendered,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { engramEventsStored: events.length, tokensEvicted: totalTokens },
        },
      };
    });
  };
}
