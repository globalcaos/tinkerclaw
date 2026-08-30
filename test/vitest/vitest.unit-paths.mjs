import path from "node:path";
import { BUNDLED_PLUGIN_ROOT_DIR } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const unitTestIncludePatterns = [
  "src/**/*.test.ts",
  "packages/**/*.test.ts",
  "test/**/*.test.ts",
];

export const boundaryTestFiles = [
  "src/infra/boundary-path.test.ts",
  "src/infra/git-root.test.ts",
  "src/infra/home-dir.test.ts",
  "src/infra/openclaw-exec-env.test.ts",
  "src/infra/openclaw-root.test.ts",
  "src/infra/package-json.test.ts",
  "src/infra/path-env.test.ts",
  "src/infra/stable-node-path.test.ts",
  "test/extension-import-boundaries.test.ts",
  "test/extension-test-boundary.test.ts",
  "test/plugin-extension-import-boundary.test.ts",
  "test/web-provider-boundary.test.ts",
];

export const bundledPluginDependentUnitTestFiles = [
  "src/infra/matrix-plugin-helper.test.ts",
  "src/plugin-sdk/facade-runtime.test.ts",
  "src/plugins/loader.test.ts",
  // FORK 2026-07-29 — tinker-bridge specs, enrolled so they RUN.
  // `extensions/**` is in unitTestAdditionalExcludePatterns, so these 10 files
  // existed and passed only when named explicitly on the command line — never in a
  // full-suite run. That left claude-cli worker-pool keying, dedup, steering and
  // dead-resume with no gate at all, on the lane Jarvis actually serves. Listing
  // them here lifts the extensions/** exclusion for exactly these paths (see
  // vitest.bundled.config.ts, which filters out any exclude pattern that would
  // match an included file). Verified 70/70 green before enrolling.
  "extensions/tinkerclaw-tinker-bridge/__tests__/orchestration-disposition.test.ts",
  "extensions/tinkerclaw-tinker-bridge/src/inflight-worker-registry.test.ts",
  "extensions/tinkerclaw-tinker-bridge/src/stream.dedup.test.ts",
  "extensions/tinkerclaw-tinker-bridge/src/stream.fast-fail.test.ts",
  "extensions/tinkerclaw-tinker-bridge/src/stream.flatten.test.ts",
  "extensions/tinkerclaw-tinker-bridge/src/thinking-budget.test.ts",
  "extensions/tinkerclaw-tinker-bridge/src/transcript-path.test.ts",
  "extensions/tinkerclaw-tinker-bridge/src/worker-pool.test.ts",
  "extensions/tinkerclaw-tinker-bridge/src/worker.dead-resume.test.ts",
  "extensions/tinkerclaw-tinker-bridge/src/worker.steer.test.ts",
  // FORK 2026-08-19 — the NUL-argv quarantine (27 fatal spawn deaths on 2026-08-18).
  "extensions/tinkerclaw-tinker-bridge/src/worker.nul-argv.test.ts",
];

export const unitTestAdditionalExcludePatterns = [
  "src/gateway/**",
  "src/hooks/**",
  "src/infra/**",
  `${BUNDLED_PLUGIN_ROOT_DIR}/**`,
  "src/browser/**",
  "src/line/**",
  "src/agents/**",
  "src/auto-reply/**",
  "src/channels/**",
  "src/cli/**",
  "src/commands/**",
  "src/config/**",
  "src/cron/**",
  "src/daemon/**",
  "src/media/**",
  "src/plugin-sdk/**",
  "src/plugins/**",
  "src/process/**",
  "src/secrets/**",
  "src/shared/**",
  "src/tasks/**",
  "src/media-understanding/**",
  "src/logging/**",
  "src/tui/**",
  "src/utils/**",
  "src/wizard/**",
  "src/plugins/contracts/**",
  "src/scripts/**",
  "src/infra/boundary-path.test.ts",
  "src/infra/git-root.test.ts",
  "src/infra/home-dir.test.ts",
  "src/infra/openclaw-exec-env.test.ts",
  "src/infra/openclaw-root.test.ts",
  "src/infra/package-json.test.ts",
  "src/infra/path-env.test.ts",
  "src/infra/stable-node-path.test.ts",
  ...bundledPluginDependentUnitTestFiles,
  "src/config/doc-baseline.integration.test.ts",
  "src/config/schema.base.generated.test.ts",
  "src/config/schema.help.quality.test.ts",
  "test/**",
];

const sharedBaseExcludePatterns = [
  "dist/**",
  "apps/macos/**",
  "apps/macos/.build/**",
  "**/node_modules/**",
  "**/vendor/**",
  "dist/OpenClaw.app/**",
  "**/*.live.test.ts",
  "**/*.e2e.test.ts",
];

const normalizeRepoPath = (value) => value.split(path.sep).join("/");

const matchesAny = (file, patterns) => patterns.some((pattern) => path.matchesGlob(file, pattern));

export function isUnitConfigTestFile(file) {
  const normalizedFile = normalizeRepoPath(file);
  return (
    matchesAny(normalizedFile, unitTestIncludePatterns) &&
    !matchesAny(normalizedFile, sharedBaseExcludePatterns) &&
    !matchesAny(normalizedFile, unitTestAdditionalExcludePatterns)
  );
}

export function isBundledPluginDependentUnitTestFile(file) {
  return bundledPluginDependentUnitTestFiles.includes(normalizeRepoPath(file));
}

export function isBoundaryTestFile(file) {
  return boundaryTestFiles.includes(normalizeRepoPath(file));
}
