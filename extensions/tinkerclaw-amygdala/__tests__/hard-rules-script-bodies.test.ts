import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AEGIS_RULES } from "../src/rules.js";

// 2026-10-19: `grep -n "coverage" ~/.openclaw/scripts/nightly-backup.sh` was blocked as
// DELETE_UNREQUESTED twice while the architect asked whether his backups were done. The hook appends the
// body of every script the command RUNS, and a bare `~/x.sh` anywhere counted as running it, so
// the backup script's prune `rm` lines were read as the command's own. Reading a script is not
// running it; running it must still be seen (2026-10-12, `bash ~/pi-format-ssd.sh`).

const HOOK = join(__dirname, "..", "hooks", "hard-rules.mjs");
const del = AEGIS_RULES.find((r) => r.rule === "DELETE_UNREQUESTED")!;

const dir = mkdtempSync(join(tmpdir(), "aegis-sb-"));
const policy = join(dir, "policy.json");
writeFileSync(
  policy,
  JSON.stringify({
    rules: [
      {
        id: del.rule,
        source: del.pattern.source,
        flags: "",
        explanation: del.explanation,
        enforce: true,
        scope: "exec",
        ownerIntent: "delete",
      },
    ],
  }),
);
const script = join(dir, "prune.sh");
writeFileSync(script, "#!/bin/bash\nrm -f /home/someone/old-bundle.tgz\n");

function decide(command: string): "deny" | "allow" {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, AMYGDALA_POLICY_PATH: policy, AMYGDALA_DATA_DIR: dir },
    encoding: "utf-8",
    timeout: 15_000,
  });
  return /"permissionDecision"\s*:\s*"deny"/.test(r.stdout) ? "deny" : "allow";
}

describe("hard-rules hook: script bodies only for scripts that run", () => {
  it.each([
    `grep -n "coverage" ${script} | head -5`,
    `cat ${script}`,
    `sed -n 1,5p ${script}`,
    `wc -l ${script} && ls -l ${script}`,
  ])("reading the script is allowed: %s", (cmd) => {
    expect(decide(cmd)).toBe("allow");
  });

  it.each([
    `bash ${script}`,
    `${script}`,
    `cd /tmp && ${script} --now`,
    `sudo ${script}`,
    `echo go; ${script}`,
  ])("running the script is still denied: %s", (cmd) => {
    expect(decide(cmd)).toBe("deny");
  });
});
