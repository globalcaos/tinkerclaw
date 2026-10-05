// Standalone runner for tinker-ui's own tests. The repo-level UI project (test/vitest/vitest.ui.config.ts) still points
// at the retired stock `ui/` folder, so it cannot load here. Run from the repo root:
//   node scripts/run-vitest.mjs run --config tinker-ui/vitest.config.ts <files>
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "tinker-ui",
    root: new URL("..", import.meta.url).pathname,
    include: ["tinker-ui/src/**/*.test.ts"],
    environment: "jsdom",
    isolate: true,
    testTimeout: 60_000,
  },
});
