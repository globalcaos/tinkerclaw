/**
 * FORK: Rule-based safety gate (AEGIS) — the deterministic hard floor.
 *
 * AEGIS is the one layer that BLOCKS by construction, independent of any learned
 * model. v3.1 makes the rule set a single serializable source of truth
 * (`AEGIS_RULES`) consumed by BOTH:
 *   - the in-gateway gate (`evaluateRuleBased`, native `before_tool_call`), and
 *   - the pre-execution PreToolUse hook on the tinker-bridge / claude-cli path
 *     (compiled into `policy.json` by `policy-snapshot.ts`, evaluated by
 *     `hook/amygdala-pretooluse.mjs`).
 * Having one array means the two enforcement seams can never drift.
 *
 * Each rule carries a TIER:
 *   - `enforce`: true  → a match HARD-DENIES the action (destructive execution).
 *   - `enforce`: false → a match is OBSERVE-ONLY (logged, not blocked). Used for
 *     credential-PATTERN rules whose false-positive rate on legitimate work
 *     (grepping for the word "password", reading a dev `.env`) is too high to
 *     hard-deny — anti-cry-wolf.
 *   - `scope`: "exec" → matched only against execution-tool command text (Bash
 *     command / shell-like tool input). A `.sql` file that contains DROP TABLE
 *     is NOT an execution, so file-content tools are not scanned in v1.
 *   - `scope`: "all"  → matched against tool name + serialized input.
 */

import { emitEvent } from "openclaw/plugin-sdk/fork-telemetry";
import type { GateDecision } from "./types.js";

export interface RuleBasedResult {
  decision: GateDecision;
  rule: string | null;
  explanation: string;
}

export type AegisScope = "exec" | "all";

export interface AegisRule {
  /** Pattern matched against the candidate text. */
  pattern: RegExp;
  /** Stable rule identifier (several patterns may share one id). */
  rule: string;
  /** Human-readable reason shown when the rule fires. */
  explanation: string;
  /** true → hard-deny on match; false → observe-only (log, do not block). */
  enforce: boolean;
  /** "exec" → only execution-tool command text; "all" → tool name + input. */
  scope: AegisScope;
}

/**
 * The AEGIS rule set. Single source of truth — the in-process gate and the
 * pre-execution hook snapshot both derive from this array.
 */
export const AEGIS_RULES: AegisRule[] = [
  // DELIBERATELY BROAD — do not "fix" this by narrowing it to `/` and the
  // top-level system directories. The trailing `\/` means "any ABSOLUTE path",
  // so `rm -rf /tmp/scratch` is blocked too, on purpose: a recursive delete of
  // an absolute path is a confirm-with-the-user action, and the agent can always
  // use a relative path or ask. Locked by the "still blocks recursive deletes of
  // absolute paths" test (commit 5f57107d1a8). The rule id says ROOT for
  // historical reasons; the explanations below say what is actually matched,
  // because reading "root filesystem" after deleting a scratch dir looks like a
  // false positive and invites exactly that narrowing.
  {
    // The -r group is REQUIRED: with it optional this matched `rm -f /tmp/x`,
    // i.e. any non-recursive delete of an absolute path. `rm -rf /` and `rm -fr /`
    // are still covered by the two combined-flag rules below.
    pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)\//,
    rule: "FS_DESTRUCTIVE_ROOT",
    explanation: "Recursive delete of an absolute path",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\//,
    rule: "FS_DESTRUCTIVE_ROOT",
    explanation: "Recursive force delete of an absolute path",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /rm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\//,
    rule: "FS_DESTRUCTIVE_ROOT",
    explanation: "Recursive force delete of an absolute path",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /mkfs\./i,
    rule: "FS_FORMAT",
    explanation: "Filesystem format command",
    enforce: true,
    scope: "exec",
  },
  {
    // /dev/null and /dev/zero are sinks, not devices to destroy — exempt them
    // so decompressor/throughput sanity checks are not flagged as device writes.
    pattern: /dd\s+.*of=\/dev\/(?!null\b|zero\b)/i,
    rule: "FS_DD_DEVICE",
    explanation: "Direct device write via dd",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: />\s*\/dev\/[sh]d[a-z]/i,
    rule: "FS_REDIRECT_DEVICE",
    explanation: "Redirect output to block device",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /chmod\s+(-[a-zA-Z]*\s+)?777\s+\//,
    rule: "FS_CHMOD_ROOT",
    explanation: "Chmod 777 on root filesystem",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)/i,
    rule: "SQL_DROP",
    explanation: "SQL DROP statement detected",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /TRUNCATE\s+TABLE/i,
    rule: "SQL_TRUNCATE",
    explanation: "SQL TRUNCATE TABLE detected",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /DELETE\s+FROM\s+\w+\s*;?\s*$/i,
    rule: "SQL_DELETE_ALL",
    explanation: "SQL DELETE without WHERE clause",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /ALTER\s+TABLE\s+.*DROP\s+COLUMN/i,
    rule: "SQL_ALTER_DROP",
    explanation: "SQL ALTER TABLE DROP COLUMN",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /\.env\b|credentials\.json|\.aws\/credentials|id_rsa|\.ssh\/|\.gnupg\//i,
    rule: "CREDENTIAL_ACCESS",
    explanation: "Credential or secret file access pattern",
    // Observe-only: legitimate dev work reads .env / .ssh paths constantly.
    enforce: false,
    scope: "exec",
  },
  {
    pattern: /password|api[_-]?key|secret[_-]?key|access[_-]?token/i,
    rule: "CREDENTIAL_CONTENT",
    explanation: "Credential content pattern in target",
    // Observe-only: the bare word "password" appears in countless safe commands.
    enforce: false,
    scope: "exec",
  },
  {
    pattern: /curl\s+.*-d\s+.*password|wget\s+.*password/i,
    rule: "CREDENTIAL_EXFIL",
    explanation: "Potential credential exfiltration via HTTP",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /git\s+push\s+--force\s+.*main|git\s+push\s+-f\s+.*main/i,
    rule: "GIT_FORCE_PUSH_MAIN",
    explanation: "Force push to main branch",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /git\s+reset\s+--hard\s+.*HEAD~[0-9]{2,}/i,
    rule: "GIT_RESET_MANY",
    explanation: "Hard reset discarding many commits",
    enforce: true,
    scope: "exec",
  },
];

/**
 * J9 / TINKER_UI_DESIGN_BIBLE/logging.md §4.12 `j.aegis.decision` (§9 step 9) — one row per
 * evaluation of the rule set, written at the gate itself, so "which security rules fire" is
 * answered by the rule set's OWN evaluation rather than by a second count kept downstream
 * (design-principles #18).
 *
 * CADENCE. On the default v3.1 path the rule set is evaluated exactly once per gated tool call
 * (the AEGIS pre-check, `evaluateAegisEnforced` via the checker index.ts wires into
 * AmygdalaHook.evaluate), so a row IS a gated tool call. The legacy ensemble modes (off unless
 * `legacyEnsemble` is set) evaluate the rules a second time — the rule-based fallback calls
 * `evaluateRuleBased`, the ONNX path re-runs the checker as a post-check — and so write two rows
 * for one call. That is stated here rather than hidden; the bible row owes the note.
 *
 * `label` is the matched rule id, and `none` — a closed value, never null — when nothing matched,
 * so the allow rate is queryable from the same column.
 *
 * `overridden` is deliberately ABSENT. This function cannot know whether a human later overrode
 * the block; that fact lives with `logHumanOverride` in runtime-hook.ts, which owns the training
 * log. An honest gap is actionable; a field hardcoded to false would silently answer "nothing is
 * ever overridden" (VERIFICATION DISCIPLINE #6).
 */
function noteAegisDecision(result: RuleBasedResult): RuleBasedResult {
  emitEvent("j.aegis.decision", {
    label: result.rule ?? "none",
    fields: {
      decision:
        result.decision === "hard_block"
          ? "block"
          : result.decision === "soft_block"
            ? "ask"
            : "allow",
    },
  });
  return result;
}

/**
 * Evaluate a tool call through the rule-based safety gate (in-process path).
 *
 * Unchanged contract: matches the combined "<toolName> <argsStr>" against every
 * AEGIS rule and returns a `hard_block` on the first match (regardless of the
 * `enforce` tier — the in-process gate's enforcement decision is made by the
 * caller; the `enforce`/`scope` tiers govern the pre-execution hook). Allow
 * otherwise.
 *
 * @param toolName   The tool/action name
 * @param argsStr    Serialized arguments or target string
 * @returns          Gate result with decision and matched rule (if any)
 */
export function evaluateRuleBased(toolName: string, argsStr: string): RuleBasedResult {
  const combined = `${toolName} ${argsStr}`;

  for (const { pattern, rule, explanation } of AEGIS_RULES) {
    if (pattern.test(combined)) {
      return noteAegisDecision({
        decision: "hard_block",
        rule,
        explanation: `Rule-based block [${rule}]: ${explanation}`,
      });
    }
  }

  return noteAegisDecision({
    decision: "allow",
    rule: null,
    explanation: "No rule-based safety concerns detected.",
  });
}

/**
 * Enforce-aware evaluation for the in-process native gate. Unlike
 * `evaluateRuleBased` (which hard-blocks on ANY match, preserved for the legacy
 * callers + tests), this only hard-blocks rules tiered `enforce: true` — so the
 * credential-PATTERN rules (`enforce: false`) stay observe-only and don't
 * cry-wolf on legitimate work now that the native `before_tool_call` block is
 * actually wired through the host.
 */
export function evaluateAegisEnforced(toolName: string, argsStr: string): RuleBasedResult {
  const combined = `${toolName} ${argsStr}`;
  for (const { pattern, rule, explanation, enforce } of AEGIS_RULES) {
    if (enforce && pattern.test(combined)) {
      return noteAegisDecision({
        decision: "hard_block",
        rule,
        explanation: `Rule-based block [${rule}]: ${explanation}`,
      });
    }
  }
  return noteAegisDecision({
    decision: "allow",
    rule: null,
    explanation: "No enforced rule-based safety concerns detected.",
  });
}

/**
 * Serializable view of the AEGIS rules for the policy snapshot (the hook script
 * cannot import TypeScript / RegExp objects). Mirrors `AegisRule` with the
 * pattern flattened to source + flags strings.
 */
export interface SerializedAegisRule {
  id: string;
  source: string;
  flags: string;
  explanation: string;
  enforce: boolean;
  scope: AegisScope;
}

/** Flatten `AEGIS_RULES` to JSON-safe rows for `policy.json`. */
export function serializeAegisRules(): SerializedAegisRule[] {
  return AEGIS_RULES.map((r) => ({
    id: r.rule,
    source: r.pattern.source,
    flags: r.pattern.flags,
    explanation: r.explanation,
    enforce: r.enforce,
    scope: r.scope,
  }));
}
