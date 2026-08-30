/**
 * FORK: the observability substrate, as a declared plugin-SDK surface.
 *
 * WHY THIS EXISTS — FOUNDATION #9 (bounded, replicable, recoverable).
 * These three primitives are the fork's own instrumentation plane, and cognitive
 * extensions genuinely need them: an extension that cannot declare an instrument
 * or record an algorithm outcome is invisible to the liveness registry, which
 * defeats FOUNDATION #4 (total observability) and #5 (no silent failure).
 *
 * They were reached by relative `../../src/infra/*` imports. That is fine for a
 * bundled-only plugin, but `tinkerclaw-learned-intuition` is `publishToNpm: true`
 * and ships only its own directory — the import cannot resolve in the published
 * tarball. Under #9 a published artefact must be bounded on its own, so the
 * dependency has to be DECLARED and travel with it. This file is that declaration.
 *
 * Note the second reason, which applies even to plugins nobody publishes:
 * extensions with `openclaw.bundle.stageRuntimeDependencies: true` get their own
 * rolldown graph (tsdown.config.ts:288-341), so a relative `src/` import INLINES a
 * second copy of the module into the plugin bundle. `agent-events` and
 * `instrument-liveness` survive that only because they resolve their state through
 * `resolveGlobalSingleton`; `algorithm-metrics` survives because it is stateless.
 * Routing through the SDK keeps one copy in the shared graph and removes the
 * landmine.
 *
 * see also: TINKER_UI_DESIGN_BIBLE/FOUNDATION.md #9,
 *           TINKER_UI_DESIGN_BIBLE/canonical-derivations.md ("Which crossing is correct")
 */

export { recordAlgorithmOutcome } from "../infra/algorithm-metrics.js";
export { declareInstrument, noteInstrumentFired } from "../infra/instrument-liveness.js";
