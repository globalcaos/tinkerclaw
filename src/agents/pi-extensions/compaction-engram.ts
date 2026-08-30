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

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { recordCompactionOutcome } from "../../infra/algorithm-metrics.js";
import { declareInstrument, noteInstrumentFired } from "../../infra/instrument-liveness.js";
import { createEventStore } from "../../memory/engram/event-store.js";
import type { EventKind, MemoryEvent } from "../../memory/engram/event-types.js";
import { createMetricsCollector } from "../../memory/engram/metrics.js";
import { createTimeRangeMarker, renderMarker } from "../../memory/engram/time-range-marker.js";
import {
  getPointerCompactionRuntime,
  buildManifest,
  renderManifest,
} from "./pointer-compaction-runtime.js";
import { getReflectionRuntime } from "./reflection-runtime.js";

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
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: unknown) =>
          block && typeof block === "object" && (block as Record<string, unknown>).type === "text",
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
 * Session id for the metrics ledger. Deliberately total: this runs on the serving path, and
 * telemetry must never be able to break the compaction it observes.
 */
function resolveSessionKey(ctx: {
  sessionManager?: { getSessionId?: () => string };
}): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

// FORK 2026-07-28 — LIVENESS + EFFECTIVENESS. This extension is the arm that actually runs under
// the live `agents.defaults.compaction.mode = "engram"` config, which makes its numbers the ONLY
// real data we have on compaction effectiveness. The compaction-safeguard hook next door was
// fully implemented and entirely dead under that same config for weeks with every structural
// check green. So: DECLARED here at registration, FIRED below at the two places where the
// handler genuinely decides — the return that hands pi a summary, and the early decline.
// Declaration is not liveness; keeping the two calls apart is the entire point.
declareInstrument({
  id: "compaction:engram-executor",
  kind: "extension",
  description: "engram pointer/marker compaction — the live compaction executor",
});

/**
 * Create the compaction engram extension factory.
 * Accepts the OpenClaw config to resolve feature flags at registration time.
 */
export default function compactionEngramExtension(
  cfg?: OpenClawConfig,
): (api: ExtensionAPI) => void {
  return (api: ExtensionAPI): void => {
    api.on("session_before_compact", async (event, ctx) => {
      const { preparation } = event;
      const messagesToCompact = preparation.messagesToSummarize;
      const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
      const allMessages = [...messagesToCompact, ...turnPrefixMessages];

      // FORK 2026-07-28 — instrumentation state, resolved ABOVE the early return so the decline
      // path can still say which arm was configured. `cfg` is closure-constant, so hoisting
      // pointerMode here costs nothing and keeps a single owner for the flag.
      const startedAtMs = Date.now();
      const sessionKey = resolveSessionKey(ctx);
      const pointerMode =
        (cfg?.agents?.defaults?.compaction as Record<string, unknown> | undefined)?.pointerMode ===
        true;
      const configuredVariant = pointerMode ? "engram-pointer" : "engram-marker";

      // Nothing to summarize means there is nothing to replace the dropped
      // history with. Committing a compaction here would still honour
      // firstKeptEntryId and silently discard everything before it, which
      // reads to the user as "the conversation was wiped". Decline instead.
      if (allMessages.length === 0) {
        // FORK 2026-07-28 — a decline is NOT a non-event. Returning undefined hands compaction
        // back to pi, which then makes the direct summarisation HTTP call that hangs ~9 minutes
        // and is discarded — so the DECLINE RATE is itself the diagnostic, and an invisible
        // decline is exactly the blindness this instrumentation exists to remove. The detail
        // string is distinct on purpose: "fired but declined" must never read as "compacted".
        noteInstrumentFired(
          "compaction:engram-executor",
          `declined/no-messages ${configuredVariant}`,
        );
        recordCompactionOutcome({
          variant: configuredVariant,
          outcome: "skipped",
          tokensBefore: preparation.tokensBefore,
          durationMs: Date.now() - startedAtMs,
          sessionKey,
          note: "declined: no messages to summarize; pi falls through to its own summarisation",
        });
        return undefined;
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
          if (words.length > 3) {
            topicHints.push(words);
          }
        }
        if (role === "toolResult" && msg.toolName) {
          topicHints.push(String(msg.toolName));
        }
      }

      // 2. Choose compaction summary strategy based on feature flag (pointerMode resolved above)
      const ptrHandler = pointerMode ? getPointerCompactionRuntime(ctx.sessionManager) : null;

      let rendered: string;
      // The variant is only KNOWN once this branch resolves: pointerMode can be on while the
      // pointer runtime is absent, in which case the marker arm runs. Assigned in both branches
      // so the ledger records the arm that actually executed, not the one that was configured.
      let variant: "engram-pointer" | "engram-marker";

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
        variant = "engram-pointer";

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
        variant = "engram-marker";

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
              console.warn(`[ENGRAM][reflection] medium: ${record.diagnosis}`);
            }
            // low: auto-fix applied silently
          })
          .catch((err: unknown) => {
            // Reflection errors must never surface to the user
            console.error("[ENGRAM][reflection] error:", err);
          });
      }

      // FORK 2026-07-28 — the executor genuinely ran. Fire AFTER the strategy branch so `variant`
      // names the arm that actually produced the summary, and record the outcome in the algorithm
      // ledger. `tokensBefore` comes from pi, so it is third-party-reported — recordCompactionOutcome
      // assigns that provenance itself and it must not be restated or overridden here.
      noteInstrumentFired("compaction:engram-executor", `${variant} events=${events.length}`);
      recordCompactionOutcome({
        variant,
        outcome: "fired",
        tokensBefore: preparation.tokensBefore,
        durationMs: Date.now() - startedAtMs,
        sessionKey,
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
  };
}
