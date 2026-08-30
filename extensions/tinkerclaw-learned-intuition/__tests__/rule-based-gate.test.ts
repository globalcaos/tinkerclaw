import { describe, it, expect } from "vitest";
import { evaluateRuleBased } from "../src/rule-based-gate.js";

describe("rule-based-gate", () => {
  describe("blocks dangerous patterns", () => {
    it("blocks rm -rf /", () => {
      const result = evaluateRuleBased("exec", "rm -rf /");
      expect(result.decision).toBe("hard_block");
      expect(result.rule).toBe("FS_DESTRUCTIVE_ROOT");
    });

    it("blocks rm -fr /home", () => {
      const result = evaluateRuleBased("exec", "rm -fr /home");
      expect(result.decision).toBe("hard_block");
    });

    it("blocks DROP TABLE", () => {
      const result = evaluateRuleBased("exec", "DROP TABLE users");
      expect(result.decision).toBe("hard_block");
      expect(result.rule).toBe("SQL_DROP");
    });

    it("blocks DROP DATABASE", () => {
      const result = evaluateRuleBased("exec", "DROP DATABASE mydb");
      expect(result.decision).toBe("hard_block");
      expect(result.rule).toBe("SQL_DROP");
    });

    it("blocks TRUNCATE TABLE", () => {
      const result = evaluateRuleBased("exec", "TRUNCATE TABLE users");
      expect(result.decision).toBe("hard_block");
      expect(result.rule).toBe("SQL_TRUNCATE");
    });

    it("blocks credential file access", () => {
      const result = evaluateRuleBased("read", "/home/user/.env");
      expect(result.decision).toBe("hard_block");
      expect(result.rule).toBe("CREDENTIAL_ACCESS");
    });

    it("blocks credentials.json access", () => {
      const result = evaluateRuleBased("read", "credentials.json");
      expect(result.decision).toBe("hard_block");
      expect(result.rule).toBe("CREDENTIAL_ACCESS");
    });

    it("blocks force push to main", () => {
      const result = evaluateRuleBased("exec", "git push --force origin main");
      expect(result.decision).toBe("hard_block");
      expect(result.rule).toBe("GIT_FORCE_PUSH_MAIN");
    });

    it("blocks mkfs commands", () => {
      const result = evaluateRuleBased("exec", "mkfs.ext4 /dev/sda1");
      expect(result.decision).toBe("hard_block");
      expect(result.rule).toBe("FS_FORMAT");
    });

    it("blocks dd to device", () => {
      const result = evaluateRuleBased("exec", "dd if=/dev/zero of=/dev/sda");
      expect(result.decision).toBe("hard_block");
      expect(result.rule).toBe("FS_DD_DEVICE");
    });
  });

  describe("allows normal operations", () => {
    it("allows normal file reads", () => {
      const result = evaluateRuleBased("read", "/home/user/src/main.ts");
      expect(result.decision).toBe("allow");
      expect(result.rule).toBeNull();
    });

    it("allows normal file writes", () => {
      const result = evaluateRuleBased("write", "/home/user/src/output.ts");
      expect(result.decision).toBe("allow");
    });

    it("allows git commit", () => {
      const result = evaluateRuleBased("exec", 'git commit -m "fix bug"');
      expect(result.decision).toBe("allow");
    });

    it("allows git push (non-force)", () => {
      const result = evaluateRuleBased("exec", "git push origin feature-branch");
      expect(result.decision).toBe("allow");
    });

    it("allows npm install", () => {
      const result = evaluateRuleBased("exec", "npm install lodash");
      expect(result.decision).toBe("allow");
    });

    it("allows SELECT queries", () => {
      const result = evaluateRuleBased("exec", "SELECT * FROM users WHERE id = 1");
      expect(result.decision).toBe("allow");
    });

    it("allows rm on specific files (not root)", () => {
      const result = evaluateRuleBased("exec", "rm temp.txt");
      expect(result.decision).toBe("allow");
    });

    // Regression: the -r group in the first FS_DESTRUCTIVE_ROOT rule was optional,
    // so a non-recursive delete of any absolute path was blocked as "recursive
    // delete from root filesystem". The existing allow-case used a relative path
    // and never exercised it.
    it("allows non-recursive rm of an absolute path", () => {
      expect(evaluateRuleBased("exec", "rm -f /tmp/scratch.bin").decision).toBe("allow");
      expect(evaluateRuleBased("exec", "rm /tmp/scratch.bin").decision).toBe("allow");
    });

    it("still blocks recursive deletes of absolute paths", () => {
      for (const cmd of ["rm -rf /", "rm -fr /home", "rm -r /home/user", "rm -f -r /var"]) {
        expect(evaluateRuleBased("exec", cmd).decision).toBe("hard_block");
      }
    });
  });
});
