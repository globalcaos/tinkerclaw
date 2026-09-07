// FORK 2026-07-28: tinker-ui had NO vitest project at all. Every
// `tinker-ui/src/**/*.test.ts` was an orphan, so `npx vitest run tinker-ui/...`
// from the repo root printed "No test files found" and exited 1 — which under a
// quiet reporter reads as a FALSE PASS. That trap bit twice (the eeg-trace
// tests were written but never executed; then again while fixing the EEG lane
// allocator), so the run path is now a committed config + `pnpm test:tinker-ui`
// instead of a throwaway file you have to remember to write.
//
// IN `rootVitestProjects` since 2026-08-17. It was held out because some specs were stale against
// shipped design changes (see TINKER_UI_DESIGN_BIBLE/bug-log.md 2026-07-28, eegCostWidthPx vs the
// unclipped width model) and wiring them in would have redded `pnpm test` on known-stale
// assertions. That unblock condition — "re-anchor those specs, THEN add this line" — is met: the
// project now runs 27/27 files, 1191/1191 green in ~5s.
//
// The cost of the interim is the lesson worth keeping: for three weeks these tests PASSED and were
// executed by nothing, while six thinking-indicator regressions shipped past the gate. A suite
// outside the gate is documentation, not defence — and it reads exactly like defence in a review.
//
// jsdom because 3 of the 13 files touch document/window (fractal-dock,
// context-cache, queued-sends); the pure ones (eeg-trace, …) run fine under it.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";

export default createScopedVitestConfig(["tinker-ui/src/**/*.test.ts"], {
  deps: jsdomOptimizedDeps,
  environment: "jsdom",
  excludeUnitFastTests: false,
  includeOpenClawRuntimeSetup: false,
  isolate: false,
  name: "tinker-ui",
});
