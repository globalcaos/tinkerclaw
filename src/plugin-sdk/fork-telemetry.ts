/**
 * FORK 2026-09-24: the CONTEXT WINDOW panel's two telemetry contracts, as a declared plugin-SDK
 * surface (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1).
 *
 * Each contract has ONE owner in core (P7 in that optic): A1, the compaction contract, in
 * src/infra/compaction-telemetry.ts, and A8, the per-model-call contract, in
 * src/infra/call-telemetry.ts. Both need a producer on the cc-bridge lane, because the claude CLI's
 * stdout is the only place its own compactions and its per-call usage can be observed (§6.0 a, b).
 *
 * `tinkerclaw-tinker-bridge` is `publishToClawHub: true`, so it reaches core only through declared
 * plugin-sdk subpaths (FOUNDATION #9), and none carried either owner. The cost ran both ways: A8's
 * bridge producer MIRRORED the owner's payload builder, its count rule and its call counter, and
 * wrote the stream literal itself; and A3, the CLI's own compaction (the one executor the gateway
 * never heard, finding F3a), could not be written at all. With this subpath the bridge builds the
 * owners' own event types and hands them to the owners' own emitters.
 *
 * WHAT IS PUBLISHED: the two emitters, the call payload builder, the call-index allocator, the lane
 * helper, the shared absent-not-zero rule, and the event types. An extension may DESCRIBE a
 * compaction or a model call it observed; it gets no way to start one and no store.
 *
 * WHAT IS NOT, on purpose: the compaction owner's legacy pi-auto emitter (a ratchet with a single
 * in-core caller, being retired; publishing it would invite a second), the compaction payload
 * builder (a producer wants the emitter, not the wire shape), and the call owner's test-only
 * counter reset (global state, not a plugin surface).
 *
 * Fork-named rather than added to an upstream-owned subpath such as agent-harness-runtime, so no
 * upstream merge ever conflicts on it. The bridge already depends on fork-only subpaths
 * (fork-error-envelope, fork-inflight-steer), so this adds no new vanilla-OpenClaw incompatibility.
 *
 * ALSO PUBLISHED (FORK 2026-09-25, TINKER_UI_DESIGN_BIBLE/logging.md §7.5 and §4.9): the
 * structured-events emit and the worker lifecycle reports.
 * - `emitEvent` is the one entry every events row goes through. It is catalog-checked (L2) and
 *   drops any string that is neither an enum member nor an id (L4), so an extension can write only
 *   the rows logging.md §4 declares, and never free text.
 * - `noteWorkerSpawn` / `noteWorkerExit` exist beside it because a tinker-bridge `worker.exit` row
 *   carries the worker's last sampled memory and its peak, which only the core worker-resources
 *   sampler holds: the transient unit — and with it its cgroup — is gone by the time the bridge
 *   hears the exit. The spawn report is also what registers the unit for sampling.
 *
 * VALUES are value exports and TYPES are `export type`: a const re-exported as a type erases to
 * undefined under verbatimModuleSyntax (lint:plugins:plugin-sdk-value-exports).
 */

export { compactionTokenCount, emitCompactionTelemetry } from "../infra/compaction-telemetry.js";
export type {
  CompactionEmitTarget,
  CompactionEndEvent,
  CompactionLane,
  CompactionPhase,
  CompactionProvenance,
  CompactionStartEvent,
  CompactionTelemetryEvent,
  CompactionTrigger,
} from "../infra/compaction-telemetry.js";
export {
  allocateCallIndex,
  buildCallEventData,
  CALL_COMPOSITION_KEYS,
  callLaneForProvider,
  emitCallTelemetry,
} from "../infra/call-telemetry.js";
// FORK 2026-10-02 — the ONE anatomy estimator, ceil(chars / 3.5), for the bridge's per-call prompt
// itemisation (cli-context.ts): a second copy would be one more estimateTokens past the
// canonical-derivations.md cap.
export { ANATOMY_CHARS_PER_TOKEN, estimateTokens } from "../shared/anatomy-token-estimate.js";
export type {
  CallComposition,
  CallCompositionKey,
  CallEmitTarget,
  CallEndEvent,
  CallLane,
  CallPhase,
  CallPromptParts,
  CallProvenance,
  CallSendEvent,
  CallTelemetryEvent,
  CallUsageEvent,
} from "../infra/call-telemetry.js";
export { emitEvent } from "../infra/events/emit.js";
export type { EmitEventRecord } from "../infra/events/emit.js";
export { noteWorkerExit, noteWorkerSpawn } from "../infra/events/samplers/worker-resources.js";
export type {
  WorkerExitReport,
  WorkerSpawnReport,
} from "../infra/events/samplers/worker-resources.js";
