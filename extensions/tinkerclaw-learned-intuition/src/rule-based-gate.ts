/**
 * FORK: Rule-based safety gate -- heuristic fallback when ONNX models unavailable.
 *
 * Provides basic pattern matching for obviously dangerous operations.
 * This is the safety net that ensures the extension works without ONNX.
 * When ONNX models are loaded, the neural gate takes over.
 *
 * Rules:
 *   - Block destructive filesystem commands (rm -rf /, etc.)
 *   - Block SQL injection patterns (DROP TABLE, etc.)
 *   - Block credential access patterns
 *   - Allow everything else
 */

import type { GateDecision } from "./types.js";

export interface RuleBasedResult {
  decision: GateDecision;
  rule: string | null;
  explanation: string;
}

/** Dangerous command patterns that should always be blocked */
const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; rule: string; explanation: string }> = [
  {
    pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\//,
    rule: "FS_DESTRUCTIVE_ROOT",
    explanation: "Recursive delete from root filesystem",
  },
  {
    pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\//,
    rule: "FS_DESTRUCTIVE_ROOT",
    explanation: "Recursive force delete from root filesystem",
  },
  {
    pattern: /rm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\//,
    rule: "FS_DESTRUCTIVE_ROOT",
    explanation: "Recursive force delete from root filesystem",
  },
  {
    pattern: /mkfs\./i,
    rule: "FS_FORMAT",
    explanation: "Filesystem format command",
  },
  {
    pattern: /dd\s+.*of=\/dev\//i,
    rule: "FS_DD_DEVICE",
    explanation: "Direct device write via dd",
  },
  {
    pattern: />\s*\/dev\/[sh]d[a-z]/i,
    rule: "FS_REDIRECT_DEVICE",
    explanation: "Redirect output to block device",
  },
  {
    pattern: /chmod\s+(-[a-zA-Z]*\s+)?777\s+\//,
    rule: "FS_CHMOD_ROOT",
    explanation: "Chmod 777 on root filesystem",
  },
  {
    pattern: /DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)/i,
    rule: "SQL_DROP",
    explanation: "SQL DROP statement detected",
  },
  {
    pattern: /TRUNCATE\s+TABLE/i,
    rule: "SQL_TRUNCATE",
    explanation: "SQL TRUNCATE TABLE detected",
  },
  {
    pattern: /DELETE\s+FROM\s+\w+\s*;?\s*$/i,
    rule: "SQL_DELETE_ALL",
    explanation: "SQL DELETE without WHERE clause",
  },
  {
    pattern: /ALTER\s+TABLE\s+.*DROP\s+COLUMN/i,
    rule: "SQL_ALTER_DROP",
    explanation: "SQL ALTER TABLE DROP COLUMN",
  },
  {
    pattern: /\.env\b|credentials\.json|\.aws\/credentials|id_rsa|\.ssh\/|\.gnupg\//i,
    rule: "CREDENTIAL_ACCESS",
    explanation: "Credential or secret file access pattern",
  },
  {
    pattern: /password|api[_-]?key|secret[_-]?key|access[_-]?token/i,
    rule: "CREDENTIAL_CONTENT",
    explanation: "Credential content pattern in target",
  },
  {
    pattern: /curl\s+.*-d\s+.*password|wget\s+.*password/i,
    rule: "CREDENTIAL_EXFIL",
    explanation: "Potential credential exfiltration via HTTP",
  },
  {
    pattern: /git\s+push\s+--force\s+.*main|git\s+push\s+-f\s+.*main/i,
    rule: "GIT_FORCE_PUSH_MAIN",
    explanation: "Force push to main branch",
  },
  {
    pattern: /git\s+reset\s+--hard\s+.*HEAD~[0-9]{2,}/i,
    rule: "GIT_RESET_MANY",
    explanation: "Hard reset discarding many commits",
  },
];

/**
 * Evaluate a tool call through the rule-based safety gate.
 *
 * @param toolName   The tool/action name
 * @param argsStr    Serialized arguments or target string
 * @returns          Gate result with decision and matched rule (if any)
 */
export function evaluateRuleBased(toolName: string, argsStr: string): RuleBasedResult {
  const combined = `${toolName} ${argsStr}`;

  for (const { pattern, rule, explanation } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(combined)) {
      return {
        decision: "hard_block",
        rule,
        explanation: `Rule-based block [${rule}]: ${explanation}`,
      };
    }
  }

  return {
    decision: "allow",
    rule: null,
    explanation: "No rule-based safety concerns detected.",
  };
}
