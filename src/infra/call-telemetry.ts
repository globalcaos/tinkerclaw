// FORK 2026-09-24 (the CONTEXT WINDOW panel, TINKER_UI_DESIGN_BIBLE/context-window-panel.md
// §6.1 step A8) — single owner of the `stream:"call"` agent-event contract.
//
// WHY. The panel's call timeline (§5) draws every model call of a session as it happens: when the
// request left, how large its prompt was, what came back and why it stopped. No event said any of
// that per call. The gateway's `round-start` pair never had a caller (F9) and was deleted
// 2026-09-25 (attempt-hooks.ts); on the cc-bridge lane the only usage reaching the gateway was the
// CLI's turn aggregate (F7), while the CLI's per-call usage and its send marker sat on its stdout,
// unread (§6.0 a).
//
// THE CONTRACT: one event per phase of one model call.
//   send   the request left. cc-bridge: the CLI's `system/status` `requesting` line. Embedded:
//          none — pi hands the subscriber no send moment (U5, below), and a guessed one would be
//          a second inference beside the UI's own §5.4 fallback.
//   usage  the prompt side is known. cc-bridge: `message_start.message.usage`. Embedded: the
//          first streamed update whose usage carries a prompt, else message_end.
//   end    the call finished. cc-bridge: `message_delta` (`usage`, `delta.stop_reason`).
//          Embedded: pi's message_end. A producer also ends a call it can no longer follow (an
//          abort, a retried request) with only what it measured, so no call stays open forever.
// Always present: phase, callIndex, t, lane, provenance. Everything else only when measured.
//
// IDENTITY: (runId, lane, callIndex). callIndex is the 0-based ordinal of the model calls ONE
// lane made for ONE run, counted per run rather than per attempt, so a retried attempt continues
// the numbering. `lane` is not in §6.1's original field list; it is here because each lane counts
// its own calls (allocateCallIndex keys on lane AND run, whether or not both producers reach one
// instance of this module), and a run that fails over between claude-code and another provider
// would otherwise number two different calls 0.
//
// ABSENT, NOT ZERO (P10): the A1 rule, reused rather than restated — compactionTokenCount keeps a
// finite value >= 0 and drops anything else, so an unknown count is omitted, never zeroed. A
// measured 0 (no cache hit) is a real 0.
//
// PARTS, NOT A SUM: input / cacheRead / cacheWrite are the provider's parts; the prompt size is
// their sum and the consumer adds them, so the addition can be checked (the cache-telemetry rule).
// `end` may carry the parts again: they are the call's FINAL usage and supersede `usage`'s.
//
// PRODUCERS.
//   - embedded: src/agents/embedded-agent-subscribe.handlers.messages.ts (openEmbeddedCall,
//     noteEmbeddedCallUsage, closeEmbeddedCall). It skips the claude-code provider: pi sees ONE
//     message per turn there, carrying the CLI's aggregate usage (F7), and the bridge reports
//     that lane's calls itself.
//   - cc-bridge: extensions/tinkerclaw-tinker-bridge/src/stream.ts (createBridgeCallTracker,
//     createBridgeCallTelemetry), through the published subpath openclaw/plugin-sdk/fork-telemetry
//     (src/plugin-sdk/fork-telemetry.ts). It maps the CLI's stdout to this file's
//     CallTelemetryEvent, publishes with emitCallTelemetry and numbers with
//     allocateCallIndex(runId, "cc-bridge").
//     MIRROR RETIRED 2026-09-24: until that subpath existed the bridge rebuilt this payload, kept
//     its own call counter and wrote the `stream: "call"` literal itself, under a RATCHET note.
//     That mirror is deleted. THIS is now the only shipped file that writes the literal
//     (context-window-panel.md §6.4, one call emitter).
//
// U5, ANSWERED 2026-09-24 (code-evident): pi-agent-core emits `turn_start` before each LLM call
// (dist/agent-loop.js), but ahead of the context transform and the API-key lookup, and the
// subscriber's dispatch switch (embedded-agent-subscribe.handlers.ts) does not route it. pi-ai
// pushes `start`, which becomes the subscriber's message_start, only after the HTTP response
// resolves (its anthropic provider awaits `messages.create(...).asResponse()` first). Neither is a
// send time.
//
// Consumers: ONE reader of the payload, tinker-ui app.ts feedCallTimelineAgentEvent, which parses
// each frame once (panels/call-timeline.ts parseCallFrame) and applies it to the session's call
// record (the B5 CallTimelineStore, applyCall). Everything else reads that record, not the wire:
// the ctx-timeline's per-call column (B6, feedContextTimelineCall → panels/context-timeline.ts
// pushCall), which replaced the deleted round-start pair, and THIS SESSION's turns / calls
// counters (B3, panels/context-counters.ts, off CallTimelineStore.totals()).
import { emitAgentEvent } from "./agent-events.js";
import { compactionTokenCount } from "./compaction-telemetry.js";

export type CallPhase = "send" | "usage" | "end";

/** The lane that made the call. With runId and callIndex it identifies one call. */
export type CallLane = "embedded" | "cc-bridge";

/**
 * Where the frame's token figures come from (P5): the provider's own usage record, or an estimate
 * on the anatomy ladder, ceil(chars / 3.5). A frame that carries no token figure (a bare `send`, an
 * `end` for a call that died unread) vouches only for its timestamp, which is observed: `exact`.
 */
export type CallProvenance = "exact" | "estimated";

type CallEventCommon = {
  /** 0-based ordinal of this call among the model calls this lane made for the run. */
  callIndex: number;
  /** Epoch ms at which the producer observed this phase. */
  t: number;
  lane: CallLane;
  provenance: CallProvenance;
};

/** The prompt side of one call, in the provider's own parts; each only when measured. */
export type CallPromptParts = {
  /** Fresh (uncached) prompt tokens. */
  input?: number;
  /** Prompt tokens served from the cache. */
  cacheRead?: number;
  /** Prompt tokens written to the cache by this call. */
  cacheWrite?: number;
};

export type CallSendEvent = CallEventCommon & {
  phase: "send";
  /**
   * Prompt size estimated before the call, when a producer measured one. No producer sends it
   * today: A9's pre-call estimate reaches the UI whole, on its own live `lifecycle` event (phase
   * "context-anatomy", attempt-hooks.ts emitPrePromptAnatomy) since 2026-09-25.
   */
  promptTokensEstimate?: number;
};

/**
 * FORK 2026-10-02 (owner: "I see some sent information is unitemised, why is that? Can you fix it
 * and assign it a bucket?") — the buckets one call's prompt is itemised into. They ARE the call
 * timeline's top-lane keys (tinker-ui panels/call-timeline.ts TOP_LANE_KEYS, derived from
 * SEGMENT_COLORS), in the same P3 order, moral code first; the UI reads only these keys.
 */
export const CALL_COMPOSITION_KEYS = [
  "moralCode",
  "systemPrompt",
  "injectedFiles",
  "skills",
  "toolSchemas",
  "conversation",
  "toolResults",
  "userMessage",
] as const;
export type CallCompositionKey = (typeof CALL_COMPOSITION_KEYS)[number];

/**
 * What ONE call's prompt is made of, bucket → tokens, each only when measured (P10). Sent on
 * `usage` by a producer that can see the prompt the provider received; summed, it is that call's
 * billed prompt (input + cacheRead + cacheWrite), so nothing is left "unitemised". cc-bridge: the
 * claude CLI's own transcript (tinker-bridge cli-context.ts), because the gateway's anatomy row
 * describes the gateway's mirror, not what the CLI sends (context-window-panel.md F6, §5.3).
 */
export type CallComposition = Partial<Record<CallCompositionKey, number>>;

export type CallUsageEvent = CallEventCommon &
  CallPromptParts & {
    phase: "usage";
    promptTokensEstimate?: number;
    composition?: CallComposition;
  };

export type CallEndEvent = CallEventCommon &
  CallPromptParts & {
    phase: "end";
    /** Tokens this call generated. */
    output?: number;
    /**
     * Why the call stopped, in the lane's own vocabulary: pi's StopReason on the embedded lane
     * ("stop", "toolUse", "length", "error", "aborted"), Anthropic's `stop_reason` on cc-bridge
     * ("end_turn", "tool_use", "max_tokens", ...). Passed through, never mapped: a mapping would be
     * a guess about two vocabularies that both grow.
     */
    stopReason?: string;
  };

export type CallTelemetryEvent = CallSendEvent | CallUsageEvent | CallEndEvent;

/** Where an event goes: the global agent-event bus (nothing inside a run reacts to a call). */
export type CallEmitTarget = {
  runId: string;
  /** Omitted: emitAgentEvent falls back to the session key registered for the run. */
  sessionKey?: string;
};

function putMeasured(data: Record<string, unknown>, key: string, value: unknown): void {
  const measured = compactionTokenCount(value);
  if (measured !== undefined) {
    data[key] = measured;
  }
}

/** The wire payload (`data`) of one call event. Pure. */
export function buildCallEventData(event: CallTelemetryEvent): Record<string, unknown> {
  const data: Record<string, unknown> = {
    phase: event.phase,
    callIndex: event.callIndex,
    t: event.t,
    lane: event.lane,
    provenance: event.provenance,
  };
  if (event.phase === "send" || event.phase === "usage") {
    putMeasured(data, "promptTokensEstimate", event.promptTokensEstimate);
  }
  if (event.phase === "usage" || event.phase === "end") {
    putMeasured(data, "input", event.input);
    putMeasured(data, "cacheRead", event.cacheRead);
    putMeasured(data, "cacheWrite", event.cacheWrite);
  }
  if (event.phase === "usage" && event.composition) {
    const composition: Record<string, unknown> = {};
    for (const key of CALL_COMPOSITION_KEYS) {
      putMeasured(composition, key, event.composition[key]);
    }
    if (Object.keys(composition).length > 0) {
      data.composition = composition;
    }
  }
  if (event.phase === "end") {
    putMeasured(data, "output", event.output);
    const stopReason = typeof event.stopReason === "string" ? event.stopReason.trim() : "";
    if (stopReason) {
      data.stopReason = stopReason;
    }
  }
  return data;
}

/**
 * Publish one call event on the agent-event bus. No try/catch: emitAgentEvent only bumps the run's
 * seq and hands the event to notifyListeners (src/shared/listeners.ts), which isolates every
 * listener's throw, so nothing here can throw into the stream it observes. Needs a runId, like
 * every emitter on this bus: the runId is half of the call's identity.
 */
export function emitCallTelemetry(target: CallEmitTarget, event: CallTelemetryEvent): void {
  if (!target.runId) {
    return;
  }
  emitAgentEvent({
    runId: target.runId,
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    stream: "call",
    data: buildCallEventData(event),
  });
}

/**
 * (lane, run) pairs whose next call index is remembered; the least recently allocated is forgotten
 * first.
 */
const CALL_INDEX_RUNS_TRACKED = 256;
const nextCallIndexByLaneRun = new Map<string, number>();

/**
 * The next 0-based call index of `runId` on `lane`. Counted per RUN, so a retried attempt continues
 * the numbering, and per LANE (IDENTITY, above), so each producer numbers its own calls from 0
 * whether or not both reach the same instance of this module: the embedded producer imports it
 * from core, the cc-bridge through openclaw/plugin-sdk/fork-telemetry. `lane` defaults to
 * "embedded", the in-core producer's lane. Bounded: past 256 (lane, run) pairs the one that
 * allocated least recently is forgotten, and restarts at 0 only if it makes another call after 256
 * newer pairs each made one.
 */
export function allocateCallIndex(runId: string, lane: CallLane = "embedded"): number {
  const key = `${lane}:${runId}`;
  const next = nextCallIndexByLaneRun.get(key) ?? 0;
  nextCallIndexByLaneRun.delete(key);
  nextCallIndexByLaneRun.set(key, next + 1);
  if (nextCallIndexByLaneRun.size > CALL_INDEX_RUNS_TRACKED) {
    const oldest = nextCallIndexByLaneRun.keys().next().value;
    if (oldest !== undefined) {
      nextCallIndexByLaneRun.delete(oldest);
    }
  }
  return next;
}

/** Test-only: forget every call counter, on every lane. */
export function resetCallIndexesForTest(): void {
  nextCallIndexByLaneRun.clear();
}

/**
 * The provider id the tinker-bridge registers for the claude-code lane
 * (extensions/tinkerclaw-tinker-bridge/src/defaults.ts `PROVIDER_ID`). Core does not import
 * extensions, so the id is named here, as src/gateway/session-eviction.ts names it.
 */
const CC_BRIDGE_PROVIDER_ID = "claude-code";

/** The lane a pi assistant message was served on, from the provider it names. */
export function callLaneForProvider(provider: unknown): CallLane {
  return typeof provider === "string" && provider.trim().toLowerCase() === CC_BRIDGE_PROVIDER_ID
    ? "cc-bridge"
    : "embedded";
}
