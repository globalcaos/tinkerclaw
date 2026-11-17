import { spawnSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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
const format = AEGIS_RULES.find((r) => r.rule === "FS_FORMAT")!;

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
      {
        id: format.rule,
        source: format.pattern.source,
        flags: format.pattern.flags,
        explanation: format.explanation,
        enforce: true,
        scope: "exec",
      },
    ],
  }),
);
const script = join(dir, "prune.sh");
writeFileSync(script, "#!/bin/bash\nrm -f /home/someone/old-bundle.tgz\n");

// 2026-11-12: a program installed long ago. Its own clean-up lines are not the agent's delete; a disk
// formatting command inside it still counts. That command's name is built from parts, so this file
// does not trip the rule it tests.
const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600_000);
const installed = join(dir, "speaker.sh");
writeFileSync(installed, '#!/bin/bash\nWORK=$(mktemp -d)\nrm -f "$WORK/raw.wav"\n');
utimesSync(installed, threeDaysAgo, threeDaysAgo);
const oldFormat = join(dir, "old-disk.sh");
writeFileSync(oldFormat, `#!/bin/bash\n${["mk", "fs"].join("")}.ext4 /dev/sdz1\n`);
utimesSync(oldFormat, threeDaysAgo, threeDaysAgo);

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

  it("a script that has not changed for days runs: its clean-up is not the command's delete", () => {
    expect(decide(`bash -x ${installed} "one two" 2>&1 | tail -5`)).toBe("allow");
    expect(decide(`${installed}`)).toBe("allow");
  });
  it("the same old script still counts for the other hard rules, and a delete typed in the command still counts", () => {
    expect(decide(`bash ${oldFormat}`)).toBe("deny");
    expect(decide(`bash ${installed} && rm -f /home/someone/notes.txt`)).toBe("deny");
  });
});
