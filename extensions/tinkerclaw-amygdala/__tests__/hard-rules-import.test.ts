import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 2026-11-05: lib.mjs imports sendServesTask from hard-rules.mjs. The hook's own main() and
// process.exit(0) ran on that import and ended the process before the send check, so a held send
// passed unchecked. Importing the module must leave the importer running.
const HOOK = join(__dirname, "..", "hooks", "hard-rules.mjs");

describe("hard-rules.mjs as a module", () => {
  it("importing it does not run the hook or exit the importer", async () => {
    const out = await new Promise<string>((resolve) => {
      const child = execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(HOOK)}); console.log("alive", typeof m.sendServesTask);`,
        ],
        { env: { ...process.env, AMYGDALA_POLICY_PATH: "/nonexistent" }, timeout: 15_000 },
        (_e, stdout) => resolve(stdout),
      );
      child.stdin!.end("{}");
    });
    expect(out).toContain("alive function");
  });
});
