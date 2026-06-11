import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { serializeAegisRules } from "../src/rule-based-gate.js";

const HOOK = join(__dirname, "..", "hook", "amygdala-pretooluse.mjs");
let dir: string;

function writePolicy(hookEnforcement: boolean) {
  writeFileSync(
    join(dir, "policy.json"),
    JSON.stringify({ version: 1, hookEnforcement, rules: serializeAegisRules() }),
  );
}

function run(payload: unknown) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, AMYGDALA_DATA_DIR: dir },
    encoding: "utf-8",
  });
}

function spool(): Array<Record<string, unknown>> {
  const p = join(dir, "hook-decisions.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amy-hook-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("amygdala-pretooluse hook", () => {
  it("denies rm -rf / on Bash and spools a deny row", () => {
    writePolicy(true);
    const r = run({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("FS_DESTRUCTIVE_ROOT");
    const rows = spool();
    expect(rows.some((x) => x.decision === "deny" && x.enforced === true)).toBe(true);
  });

  it("allows a benign Bash command with no stdout", () => {
    writePolicy(true);
    const r = run({ tool_name: "Bash", tool_input: { command: "ls -la" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("does NOT deny a Read of a .env path (credential rule is exec-scope + observe-only)", () => {
    writePolicy(true);
    const r = run({ tool_name: "Read", tool_input: { file_path: "/home/u/.env" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(""); // Read is not an execution tool → not scanned
  });

  it("observes (does not deny) a Bash grep for 'password' — enforce:false", () => {
    writePolicy(true);
    const r = run({ tool_name: "Bash", tool_input: { command: "grep -r password src/" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    const rows = spool();
    expect(rows.some((x) => x.decision === "observe" && x.rule === "CREDENTIAL_CONTENT")).toBe(
      true,
    );
  });

  it("does not deny when hookEnforcement is off", () => {
    writePolicy(false);
    const r = run({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("fails open (exit 0, no output) when the policy is missing", () => {
    const r = run({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
