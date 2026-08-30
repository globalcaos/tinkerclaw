// FORK 2026-07-25 (the architect): prompt-cache telemetry — single owner of the
// `stream:"cache"` agent-event contract.
//
// LAYERING DOCTRINE (the architect 2026-07-25): the cache lane must collect its data
// from the DEEPEST practical layer of each serving pipe, decoupled from higher
// mechanisms, so changes/bugs in upper layers (runner heuristics, session
// plumbing, UI) cannot silence the instrument. The stack, bottom → top:
//
//   wire/provider transport  →  per-API-call OBSERVATION layer (usage record)
//   →  runner reasoning loop  →  session/auto-reply  →  UI
//
// There are exactly TWO producers, one per serving pipe, both at their pipe's
// lowest our-code observation point:
//   1. CLI pipe (claude via the CLI subprocess): `src/agents/cli-runner.ts` —
//      the runner IS that pipe's transport-adjacent layer (the subprocess is
//      opaque below it), so it reads usage straight off the stream-json
//      envelope of each assistant message.
//   2. Embedded pipe (openai/google/xai/anthropic-api via runEmbeddedPiAgent):
//      `src/agents/embedded-agent-subscribe.handlers.messages.ts` — the message
//      handler that fires for EVERY embedded API call regardless of which
//      provider/runner logic executed it.
//
// One sample = ONE API call, never a turn aggregate: `promptTokens` is THAT
// call's context size (input + cacheRead + cacheWrite). Reading a turn-level
// aggregate as a context snapshot is a known past regression — don't reopen it.
//
// Consumers: the Tinker UI cache lane (app.ts cache-stream handler).
// The payload shape below is the CONTRACT — both producers must emit it.
import { emitAgentEvent } from "./agent-events.js";
import { recordCacheOutcome } from "./algorithm-metrics.js";
import { declareInstrument, noteInstrumentFired } from "./instrument-liveness.js";

// FORK 2026-07-28 — LIVENESS. Both producers are declared here, at the contract, rather than
// inside each producer: a producer that never runs cannot declare itself, which is precisely
// how the CLI one stayed invisibly dead. Declaring both from the shared owner means a silent
// producer shows up as `neverFired` instead of as an absence nobody notices.
declareInstrument({
  id: "cache-telemetry:embedded-pipe",
  kind: "producer",
  description:
    "stream:'cache' producer for the embedded pipe (openai/google/xai/anthropic-api AND claude-code via the cc-bridge)",
});
declareInstrument({
  id: "cache-telemetry:cli-pipe",
  kind: "producer",
  description: "stream:'cache' producer for the `claude-cli` cliBackend",
  // Verified 2026-07-28: `cliBackends` is absent from the live config, so this producer cannot
  // fire. Silence here is a CONFIG consequence, not a defect — but it stays tracked, because
  // for months its own comment claimed it served "the MAIN pipe" while never running once.
  conditional: "no `cliBackends` configured — this pipe is not in use on this deployment",
});

export interface CacheTelemetrySample {
  runId: string;
  sessionKey?: string;
  /** Bare model id as executed (e.g. "claude-opus-4-8", "gpt-5.6-sol"). */
  model: string;
  /** Provider id (e.g. "anthropic", "openai", "google"); the UI colors by this. */
  provider?: string;
  /** Fresh (uncached) prompt tokens billed for this call. */
  input: number;
  /** Generated output tokens for this call. */
  output?: number;
  /** Prompt tokens served from the cache. */
  cacheRead: number;
  /** Prompt tokens written into the cache by this call. */
  cacheWrite: number;
  /** input + cacheRead + cacheWrite of ONE API call — the context size. */
  promptTokens: number;
  /** Model max context window when the pipe cheaply knows it. */
  contextTokens?: number;
  timestampMs: number;
}

/** Non-finite, negative and NaN counters collapse to 0 — telemetry never ships junk numbers. */
function toCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

/**
 * Emit one prompt-cache sample for a single API call. Fire-and-forget:
 * telemetry must NEVER throw into the serving path it observes.
 */
export function emitCacheTelemetry(sample: CacheTelemetrySample): void {
  if (!sample.runId || !sample.model) {
    return;
  }
  const promptTokens = toCount(sample.promptTokens);
  if (promptTokens <= 0) {
    // No context to show — drop rather than draw an empty bar.
    return;
  }
  // FORK 2026-07-28 — liveness + effectiveness. The pipe is inferred from the sample itself:
  // the CLI producer passes `contextTokens`, the embedded one does not. This is a heuristic,
  // and it is marked as one rather than dressed up as provenance.
  const pipe =
    sample.contextTokens === undefined
      ? "cache-telemetry:embedded-pipe"
      : "cache-telemetry:cli-pipe";
  noteInstrumentFired(pipe, `${sample.provider ?? "?"}/${sample.model}`);
  // Parts only, never a ratio — the hit rate is derived at analysis time so the denominator
  // can be checked. `promptTokens` is NOT passed as contextTokens: on the cc-bridge lane it is
  // a turn aggregate, and mislabelling it is exactly what produced a "645%" context fill.
  recordCacheOutcome({
    variant: pipe === "cache-telemetry:cli-pipe" ? "cli-per-call" : "embedded",
    inputTokens: toCount(sample.input),
    cacheReadTokens: toCount(sample.cacheRead),
    cacheWriteTokens: toCount(sample.cacheWrite),
    ...(sample.contextTokens === undefined ? {} : { contextTokens: toCount(sample.contextTokens) }),
    sessionKey: sample.sessionKey,
    model: sample.model,
    provider: sample.provider,
    source: sample.contextTokens === undefined ? "turn-aggregate" : "per-call-measured",
  });
  try {
    emitAgentEvent({
      runId: sample.runId,
      ...(sample.sessionKey ? { sessionKey: sample.sessionKey } : {}),
      stream: "cache",
      data: {
        phase: "call",
        model: sample.model,
        ...(sample.provider === undefined ? {} : { provider: sample.provider }),
        input: toCount(sample.input),
        ...(sample.output === undefined ? {} : { output: toCount(sample.output) }),
        cacheRead: toCount(sample.cacheRead),
        cacheWrite: toCount(sample.cacheWrite),
        promptTokens,
        ...(sample.contextTokens === undefined
          ? {}
          : { contextTokens: toCount(sample.contextTokens) }),
        timestampMs: toCount(sample.timestampMs),
      },
    });
  } catch {
    // Observation must not disturb the observed: telemetry must NEVER throw
    // into the serving path it observes.
  }
}
