// FORK 2026-07-24 (the architect): EEG effort telemetry — single owner of the
// `stream:"effort"` agent-event contract.
//
// LAYERING DOCTRINE (the architect 2026-07-24): the EEG must collect its data from the
// DEEPEST practical layer of each serving pipe, decoupled from higher
// mechanisms, so changes/bugs in upper layers (runner heuristics, session
// plumbing, UI) cannot silence the instrument. The stack, bottom → top:
//
//   wire/provider transport  →  run OBSERVATION layer (lifecycle subscription)
//   →  runner reasoning loop  →  session/auto-reply  →  UI
//
// ⚠️ CORRECTED 2026-07-28: this header claimed "exactly TWO producers" with the
// embedded pipe covering only openai/google/xai/anthropic-api. That partition is
// FALSE and it had a live consequence. `claude-code` is a provider-runtime PLUGIN
// (tinker-bridge registers it via api.registerProvider), so a claude-code turn runs
// THROUGH runEmbeddedPiAgent and BOTH producers fire for the SAME runId — the bridge
// reads `__openclawRunId` piped from run/attempt.ts. The embedded `final` frame lands
// last, so its hard-coded zeros overwrote the bridge's real budget on every primary
// turn. The sibling files (cache-telemetry.ts, cli-runner.ts) were corrected the same
// day with "THREE serving pipes, not two"; this one was missed.
//
// There are THREE serving pipes, and two producers that OVERLAP on one of them:
//   1. CLI pipe (claude via tinker-bridge): `emitEffort` in
//      extensions/tinkerclaw-tinker-bridge/src/stream.ts — the bridge IS that
//      pipe's transport-adjacent layer (the CLI subprocess is opaque below it).
//   2. Embedded pipe (openai/google/xai/anthropic-api via runEmbeddedPiAgent):
//      the lifecycle subscription handlers
//      (embedded-agent-subscribe.handlers.lifecycle.ts) calling this module —
//      the observation layer that fires for EVERY embedded run regardless of
//      which provider/runner logic executed it.
//   3. claude-code (cc-bridge): hits BOTH of the above. Anything this module emits
//      for such a turn must therefore be additive — never a field producer 1 owns.
//      A producer that does not know a value must OMIT it, not send a zero.
//
// Consumers: the Tinker UI EEG (app.ts effort-stream handler → EegTraceStore).
// The payload shape below is the CONTRACT — both producers must emit it; the
// bridge's richer thinking fields are optional extras the EEG tolerates.
import { emitAgentEvent } from "./agent-events.js";

export type EffortTelemetryPhase = "live" | "final";

export interface EffortTelemetrySample {
  runId: string;
  sessionKey?: string;
  /** Bare model id as executed (e.g. "grok-4.5", "gpt-5.6-sol"). */
  model: string;
  /** Provider id (e.g. "xai", "codex", "google"); the EEG colors by this. */
  provider?: string;
  phase: EffortTelemetryPhase;
  /** Requested thinking/effort level ("" = Auto/none). */
  thinkLevel?: string;
  /** Generated output tokens (final phase). */
  outputTokens?: number;
  /** True when the run ended in an assistant error (EEG still draws the attempt). */
  isError?: boolean;
}

/**
 * Emit one EEG effort sample. Fire-and-forget: telemetry must NEVER throw into
 * the serving path it observes.
 */
export function emitEffortTelemetry(sample: EffortTelemetrySample): void {
  if (!sample.runId || !sample.model) {
    return;
  }
  try {
    emitAgentEvent({
      runId: sample.runId,
      sessionKey: sample.sessionKey,
      stream: "effort",
      data: {
        phase: sample.phase,
        model: sample.model,
        provider: sample.provider,
        thinkLevel: sample.thinkLevel ?? "",
        // FORK 2026-07-28 — OMITTED, NOT ZEROED.
        //
        // These were hard-coded to 0, and the UI merge copies any numeric value with no phase
        // gate (`tinker-ui/src/app.ts`: `if (typeof d.configuredBudget === "number") ...`). On a
        // claude-code turn BOTH producers fire for the same runId — the bridge supplies the real
        // budget, then this embedded `final` frame lands afterwards and overwrote it with 0, so
        // the EEG budget chip read zero on the primary lane every turn.
        //
        // This producer genuinely does not know the budget, so it now says nothing rather than
        // asserting a false zero. Same rule as the cache panel: a fabricated number is worse
        // than an absent one, because absence is legible and zero is not.
        ...(sample.phase === "final"
          ? { output_tokens: sample.outputTokens ?? 0, isError: sample.isError === true }
          : {}),
      },
    });
  } catch {
    // Observation must not disturb the observed.
  }
}
