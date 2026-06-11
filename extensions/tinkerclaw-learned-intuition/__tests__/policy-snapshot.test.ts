import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writePolicySnapshot, removeHookSettings, policyPaths } from "../src/policy-snapshot.js";
import { evaluateRuleBased, serializeAegisRules } from "../src/rule-based-gate.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amy-policy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("policy-snapshot", () => {
  it("writes a valid policy.json with enforce/scope tiers", () => {
    writePolicySnapshot(dir, { hookEnforcement: true });
    const p = policyPaths(dir);
    expect(existsSync(p.policyPath)).toBe(true);
    const policy = JSON.parse(readFileSync(p.policyPath, "utf-8"));
    expect(policy.hookEnforcement).toBe(true);
    expect(Array.isArray(policy.rules)).toBe(true);
    const drop = policy.rules.find((r: { id: string }) => r.id === "SQL_DROP");
    expect(drop.enforce).toBe(true);
    expect(drop.scope).toBe("exec");
    const cred = policy.rules.find((r: { id: string }) => r.id === "CREDENTIAL_CONTENT");
    expect(cred.enforce).toBe(false); // anti-cry-wolf, observe-only
  });

  it("stages the hook script and points settings at it", () => {
    const res = writePolicySnapshot(dir, { hookEnforcement: true });
    const p = policyPaths(dir);
    // The hook script must be resolvable from the source tree.
    expect(res.settingsWritten).toBe(true);
    expect(res.staged).not.toBeNull();
    expect(existsSync(res.staged!)).toBe(true);
    const settings = JSON.parse(readFileSync(p.settingsPath, "utf-8"));
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command as string;
    expect(cmd).toContain(res.staged!);
    expect(cmd.startsWith("node ")).toBe(true);
  });

  it("hookEnforcement:false writes policy but removes the settings file", () => {
    writePolicySnapshot(dir, { hookEnforcement: true });
    const p = policyPaths(dir);
    expect(existsSync(p.settingsPath)).toBe(true);
    writePolicySnapshot(dir, { hookEnforcement: false });
    expect(existsSync(p.policyPath)).toBe(true);
    const policy = JSON.parse(readFileSync(p.policyPath, "utf-8"));
    expect(policy.hookEnforcement).toBe(false);
    expect(existsSync(p.settingsPath)).toBe(false);
  });

  it("removeHookSettings is idempotent", () => {
    expect(() => removeHookSettings(dir)).not.toThrow();
    writePolicySnapshot(dir, { hookEnforcement: true });
    removeHookSettings(dir);
    expect(existsSync(policyPaths(dir).settingsPath)).toBe(false);
  });

  it("serialized rules and evaluateRuleBased agree on rm -rf /", () => {
    const blocked = evaluateRuleBased("Bash", "rm -rf /");
    expect(blocked.decision).toBe("hard_block");
    const rules = serializeAegisRules();
    const matched = rules.some((r) => {
      try {
        return new RegExp(r.source, r.flags).test("Bash rm -rf /") && r.enforce;
      } catch {
        return false;
      }
    });
    expect(matched).toBe(true);
  });
});
