/**
 * FORK 2026-09-30: THALAMUS v4 as a declared plugin-SDK surface (design doc sections 6 and 13A).
 *
 * The pure logic lives in `src/shared/thalamus-*.ts` because the chart, the router and the browser must share
 * one computation. The Thalamus extension and the amygdala's companion are extensions, and an extension cannot
 * import core by a relative path, so what they need is published here.
 * WHAT IS PUBLISHED: the reads, the enhancement short list, the per-call decision, the ladder by reason, the cache
 * ledger and its price table, the provider registry that lets the amygdala's call carry the routing questions, the
 * per-call router slot for the embedded runner. Light on purpose: the amygdala imports it. The parts that read the
 * live gateway (the board, use attribution) are in `fork-thalamus-runtime`. Nothing here starts anything.
 */
export * from "../shared/thalamus-reads.js";
export * from "../shared/thalamus-enhancements.js";
export * from "../shared/thalamus-ladder.js";
export * from "../shared/thalamus-shortlist-text.js";
export * from "../shared/thalamus-cache-ledger.js";
export * from "../shared/thalamus-digest.js";
export * from "../shared/thalamus-fresh-points.js";
export * from "../shared/thalamus-stuck.js";
export * from "../shared/thalamus-graph.js";
export * from "../shared/thalamus-learning.js";
export * from "../shared/thalamus-card-loop.js";
export {
  routeCall,
  topicUnsure,
  stepUnsure,
  DEFAULT_RUN_LENGTH_N,
} from "../shared/thalamus-route-call.js";
export type { RouteCallParams } from "../shared/thalamus-route-call.js";
export { cachePolicyFor, priceFor, ratesFor } from "../shared/thalamus-price-table.js";
// FORK 2026-10-02: which model the "Rewind and retry with X" button would use after a detected refusal.
export { retryPick, type RetryPick, type RetryPickParams } from "../shared/thalamus-retry-pick.js";
// v2's vocabulary the plugin types its inputs with (type-only, so nothing runs; strict tsc found them missing in phase H2).
export type { RefusalRecord, SubjectClass } from "../shared/thalamus-feasibility.js";
export type { TaskDomain } from "../shared/thalamus-frontier.js";
export { DEFAULT_RUNG_TIME, type RungTime } from "../shared/thalamus-price.js";
export * from "../shared/thalamus-shared-start.js";
export { isPrivateSource, type PolicyTable } from "../shared/thalamus-vetoes.js";
export {
  thalamusRoute,
  classifyTaskDomain,
  domainStrengthFor,
  type FrontierRung,
} from "../shared/thalamus-frontier.js";
export { supplyOfKey, type SupplyId, type SupplyState } from "../shared/thalamus-supply.js";
export type { FailureClass } from "../shared/thalamus-plan.js";
export type * from "../shared/thalamus-v4-types.js";
export type { ThalamusBoardLike } from "../shared/thalamus-board-like.js";
export * from "../infra/thalamus-read-provider.js";
export * from "../infra/thalamus-call-router.js";
// Types only: the use-attribution code itself is in `fork-thalamus-runtime`.
export type { UsageListing, UsageMark } from "../fork/usage-attribution.js";
