/**
 * Digital amygdala v2 - hard rules (the deterministic floor).
 *
 * A port of the v3.1 AEGIS rule set (`tinkerclaw-learned-intuition/src/rule-based-gate.ts`),
 * pattern for pattern and id for id, so the floor behaves identically whether v3.1 or v2 owns it.
 * The array is the single source of truth: the in-process check (`evaluateRules`) and the
 * pre-execution hook policy (`serializeRules`, compiled into policy.json) both derive from it.
 * Kept as a copy, not an import, so the extension ships to a vanilla OpenClaw on its own.
 *
 * Each rule carries a tier:
 *   - `enforce: true`  -> a match hard-denies (destructive execution).
 *   - `enforce: false` -> observe-only (credential-PATTERN rules: too many false positives to deny).
 *   - `scope: "exec"`  -> matched against execution-tool command text only.
 *   - `scope: "all"`   -> matched against tool name + serialized input.
 */

export type AegisScope = "exec" | "all";

export interface AegisRule {
  /** Pattern matched against the candidate text. */
  pattern: RegExp;
  /** Stable rule identifier (several patterns may share one id). */
  rule: string;
  /** Human-readable reason shown when the rule fires. */
  explanation: string;
  /** true -> hard-deny on match; false -> observe-only. */
  enforce: boolean;
  scope: AegisScope;
}

export interface SerializedRule {
  id: string;
  source: string;
  flags: string;
  explanation: string;
  enforce: boolean;
  scope: AegisScope;
}

export const AEGIS_RULES: AegisRule[] = [
  // DELIBERATELY BROAD - do not "fix" this by narrowing it to `/` and the
  // top-level system directories. The trailing `\/` means "any ABSOLUTE path",
  // so `rm -rf /tmp/scratch` is blocked too, on purpose: a recursive delete of
  // an absolute path is a confirm-with-the-user action, and the agent can always
  // use a relative path or ask. The rule id says ROOT for historical reasons; the
  // explanations say what is actually matched, because reading "root filesystem"
  // after deleting a scratch dir looks like a false positive and invites exactly
  // that narrowing.
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
    // /dev/null and /dev/zero are sinks, not devices to destroy - exempt them
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

// ── Rules that exist only in v2 ────────────────────────────────────────────────────────────────────────────────────
// `AEGIS_RULES` above stays entry-for-entry equal to v3.1 (a test holds that). A rule the principal added on top lives
// here, so v3.1 and v2 can be told apart and the parity claim stays true.

/** Names of files that hold stored credentials: the file itself, not a directory or a lookalike (`.pub`, `.example`). */
const CREDENTIAL_NAME =
  "(?:credentials?(?:\\.[A-Za-z0-9]+)?|secrets?(?:\\.[A-Za-z0-9]+)?|api[_-]?keys?(?:\\.[A-Za-z0-9]+)?" +
  "|\\.env(?:\\.(?!example|sample|template|dist|defaults?)[A-Za-z0-9_-]+)?|\\.netrc|\\.pgpass" +
  "|id_(?:rsa|dsa|ecdsa|ed25519)|[A-Za-z0-9_.-]+\\.pem)";
const CREDENTIAL_END = "(?=$|[\\s'\"|;&<>)])";
const CREDENTIAL_PATH = `(?:[^\\s'"|;&<>]*/)?${CREDENTIAL_NAME}${CREDENTIAL_END}`;
// A command that PRINTS what it reads, at the start of a command (start, or after ; & | newline). A read inside `$( )`
// or backticks follows neither, so a key captured into a variable does not match; nor does `source` or a redirect.
const PRINTING_READERS =
  "(?:sudo\\s+)?(?:cat|tac|nl|less|more|head|tail|bat|batcat|strings|xxd|od|hexdump|grep|egrep|fgrep|rg|awk|sed|cut|sort|uniq|column|jq|yq)";

/**
 * Tightening authorized by the principal, 2026-09-29 22:21: a plain read of a credentials file whose output lands in
 * the transcript is held. Not held: the same read captured into a variable, loaded with `source`, sent to a file with
 * `>`, or made quiet with `-q`. Files are matched by NAME (credentials, secrets, api keys, .env, .netrc, private keys),
 * so a credential kept in an ordinary-looking file is not covered.
 */
export const V2_RULES: AegisRule[] = [
  {
    pattern: new RegExp(
      `(?:^(?:[A-Za-z_]+\\s+)?|[;&|\\n]\\s*)${PRINTING_READERS}\\b` +
        `(?![^;&|\\n]*\\s-[A-Za-z]*q\\b)[^;&|\\n>]*?[\\s'"=<]${CREDENTIAL_PATH}` +
        `(?![^;&|\\n]*(?:^|\\s)1?>>?\\s*[^&\\s])`,
      "i",
    ),
    rule: "CREDENTIAL_FILE_PRINTED",
    explanation: "Prints a credentials file into the chat",
    enforce: true,
    scope: "exec",
  },
  {
    // The Read tool returns the file into the transcript by design.
    pattern: new RegExp(
      `^Read\\s[^\\n]*"(?:file_path|path)"\\s*:\\s*"(?:[^"]*/)?${CREDENTIAL_NAME}"`,
      "i",
    ),
    rule: "CREDENTIAL_FILE_PRINTED",
    explanation: "Reads a credentials file into the chat",
    enforce: true,
    scope: "all",
  },
];

/** v3.1's rules plus the v2-only ones: the floor the check and the hook policy both use. */
export const ALL_RULES: AegisRule[] = [...AEGIS_RULES, ...V2_RULES];

export interface RulesResult {
  decision: "hard_block" | "allow";
  rule: string | null;
  explanation: string;
}

/**
 * Match "<toolName> <argsStr>" against the rules. By default ANY match blocks (v3.1's
 * `evaluateRuleBased`); with `enforcedOnly` only `enforce: true` rules block
 * (v3.1's `evaluateAegisEnforced`), so observe-only credential patterns do not cry wolf.
 */
export function evaluateRules(
  toolName: string,
  argsStr: string,
  o?: { enforcedOnly?: boolean },
): RulesResult {
  const combined = `${toolName} ${argsStr}`;
  const enforcedOnly = o?.enforcedOnly === true;
  for (const { pattern, rule, explanation, enforce } of ALL_RULES) {
    if (enforcedOnly && !enforce) continue;
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
    explanation: enforcedOnly
      ? "No enforced rule-based safety concerns detected."
      : "No rule-based safety concerns detected.",
  };
}

/** Flatten `AEGIS_RULES` to JSON-safe rows (the hook cannot import RegExp objects). */
export function serializeRules(): SerializedRule[] {
  return ALL_RULES.map((r) => ({
    id: r.rule,
    source: r.pattern.source,
    flags: r.pattern.flags,
    explanation: r.explanation,
    enforce: r.enforce,
    scope: r.scope,
  }));
}
