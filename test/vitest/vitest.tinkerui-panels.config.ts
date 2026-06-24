// test/vitest/vitest.tinkerui-panels.config.ts
// FORK 2026-06-14 (fluid-model-effort Drop 1): tinker-ui/src/** tests are orphaned
// from rootVitestProjects (the UI project globs ui/src/** only). This scoped project
// gives the fork's tinker-ui tests a real runner. Bible §5.84.
// FORK 2026-06-19 (bug C — chat ordering): broadened from panels/** to all of
// tinker-ui/src/**/*.test.ts so the top-level pure-helper tests (queued-sends,
// sectioned-reply, fractal-dock) actually run in CI, not just the panel tests.
import { createUiVitestConfig } from "./vitest.ui.config.ts";

export default createUiVitestConfig(process.env, {
  includePatterns: ["tinker-ui/src/**/*.test.ts"],
  name: "tinkerui-panels",
});
