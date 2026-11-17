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
  /** "delete" → needs the owner's intent; only the pre-execution hook can read it (see rule-based-gate.ts). */
  ownerIntent?: "delete" | "secret";
}

export interface SerializedRule {
  id: string;
  source: string;
  flags: string;
  explanation: string;
  enforce: boolean;
  scope: AegisScope;
  ownerIntent?: "delete" | "secret";
}

export const AEGIS_RULES: AegisRule[] = [
  // DELIBERATELY BROAD - do not "fix" this by narrowing it to `/` and the
  // top-level system directories. The trailing `\/` means "any ABSOLUTE path",
  // so a recursive delete anywhere is matched. One exception lives in the hook
  // (hard-rules.mjs): it passes when every target is under /tmp. Otherwise a recursive delete of
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
    // 2026-10-13: a request for help freeing disk space was answered by purging the pip and
    // npm caches and force-removing 8 deploy worktrees (~41 GB), none of which he asked to
    // delete. Asking for help is not an instruction to delete: deletion needs his explicit
    // words. ownerIntent:"delete" makes the hook check them (see the field doc above).
    pattern:
      /(?:^|[\s;&|(`])(?:rm|shred|unlink)\s|\bfind\s[^;&|]*\s-delete\b|\bgit\s+(?:rm\s|clean\s+-\S*f|worktree\s+remove\s+(?:\S+\s+)*(?:--force|-f)\b)|\b(?:pip3?|uv|conda|yarn|npm|pnpm)\s+(?:cache\s+(?:purge|clean|remove|prune|rm)|store\s+prune|clean\b)|\bdocker\s+(?:(?:system|image|volume|container|builder|network)\s+prune|rmi\b|rm\b)|\bapt(?:-get)?\s+(?:autoremove|purge|remove|clean|autoclean)\b|\bsnap\s+remove\b|\bjournalctl\s[^;&|]*--vacuum|\bhuggingface-cli\s+delete-cache\b|\btimeshift\s[^;&|]*--delete\b/,
    rule: "DELETE_UNREQUESTED",
    // 2026-11-04: the hook now lets a deletion through when it serves the owner's recent task, and
    // holds it only when Jev reads it as unrelated to that task (a side agenda); see hard-rules.mjs.
    explanation: "Deletes files that have nothing to do with what the owner asked for",
    enforce: true,
    scope: "exec",
    ownerIntent: "delete",
  },
  {
    // 2026-10-13: password access gets the same treatment as deletion, enforced by the
    // amygdala and allowed only on explicit wording. Reading or using a stored password, key file or .env needs his own words,
    // checked by the hook exactly like a deletion (ownerIntent:"secret"). SSH keys used by
    // ssh -i are not in scope: they authenticate, nobody reads them.
    pattern:
      /[\w.-]+\.secret\b|\.config\/(?:orbisvision|jarvis)\/|\.openclaw\/(?:[\w.-]+\/)?\.env\b|\.openclaw\/credentials\/|\bsecret-tool\s+lookup\b|\bpass\s+show\b/,
    rule: "SECRET_UNREQUESTED",
    explanation:
      "Reads or uses a stored password or secret the owner did not explicitly ask to use",
    enforce: false,
    scope: "all",
    ownerIntent: "secret",
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
  // Tightening, 2026-11-13. A held step waits for the owner's answer, and since that day the answer can also be
  // given on another screen (Zen Mail's page posts it to its own server). Every path an answer travels is a path
  // the agent's own shell can reach: the gateway method, that page's route, and the `allow <code>` words the Allow
  // button sends into the chat as his prompt. A step that takes one of them is giving his answer for him. These
  // match the plain call; a call built from pieces is not caught here, and the after-the-fact review reads it.
  {
    pattern: /(?:\bgateway\s+call|\b[\w.-]*rpc[\w.-]*\.m?js["']?)\s+["']?amygdala2\.answer\b/,
    rule: "GUARD_SELF_ANSWER",
    explanation: "Answers a question the guard put to the owner",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /["']?method["']?\s*[:=]\s*["']amygdala2\.answer["']/,
    rule: "GUARD_SELF_ANSWER",
    explanation: "Answers a question the guard put to the owner",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /https?:\/\/[^\s"'<>]*\/api\/guard\/answer\b/,
    rule: "GUARD_SELF_ANSWER",
    explanation: "Answers a question the guard put to the owner",
    enforce: true,
    scope: "exec",
  },
  // Tightening, 2026-11-16, with the own-files list (src/own-files.ts). A path on that list may be deleted without
  // the owner's words, so the list is the gateway's to write. A shell step or a file tool that writes it would be
  // the agent declaring a file its own. These match the plain write; a write built from pieces is not caught here.
  {
    pattern:
      /(?:>>?\s*|\b(?:tee|cp|mv|truncate|install|ln)\b[^|;&\n]*\s|\bsed\s+-i[^|;&\n]*\s)["']?[^\s"'|;&]*own-files\.jsonl\b/,
    rule: "GUARD_OWN_LIST_WRITE",
    explanation: "Writes the guard's list of the agent's own files",
    enforce: true,
    scope: "exec",
  },
  {
    pattern: /^(?:Write|Edit|MultiEdit)\s[^\n]*"(?:file_path|path)"\s*:\s*"[^"]*own-files\.jsonl"/i,
    rule: "GUARD_OWN_LIST_WRITE",
    explanation: "Writes the guard's list of the agent's own files",
    enforce: true,
    scope: "all",
  },
  {
    pattern: /\bchat\.send\b[\s\S]{0,600}?\ballow\s+JEV-[0-9A-Za-z]{6}\b/,
    rule: "GUARD_SELF_ANSWER",
    explanation: "Sends the owner's Allow into a chat in his place",
    enforce: true,
    scope: "exec",
  },
];

/** v3.1's rules plus the v2-only ones: the floor the check and the hook policy both use. */
export const ALL_RULES: AegisRule[] = [...AEGIS_RULES, ...V2_RULES];

/**
 * What the chat says about each rule (2026-11-03), one entry per rule id; matching stays in the arrays above.
 * `says`: the amygdala's line to the agent when the rule fires. `ask`: the owner's Allow question; the page puts the
 * deleted path or the secret's name in `{target}` when it can read one from the command, else `noun`.
 */
export const RULE_WORDS: Record<string, { says: string; ask: string; noun?: string }> = {
  FS_DESTRUCTIVE_ROOT: {
    says: "That deletes a whole folder for good.",
    ask: "Allow deleting {target} and everything in it?",
    noun: "that folder",
  },
  FS_FORMAT: { says: "That wipes a whole disk.", ask: "Allow formatting a disk?" },
  DELETE_UNREQUESTED: {
    says: "That deletion has nothing to do with what you were asked.",
    ask: "Allow deleting {target}?",
    noun: "these files",
  },
  SECRET_UNREQUESTED: {
    says: "Nobody asked you to use that password.",
    ask: "Allow using {target}?",
    noun: "a stored password",
  },
  FS_DD_DEVICE: { says: "That writes straight over a disk.", ask: "Allow writing over a disk?" },
  FS_REDIRECT_DEVICE: {
    says: "That writes straight over a disk.",
    ask: "Allow writing over a disk?",
  },
  FS_CHMOD_ROOT: {
    says: "That opens every file to everyone.",
    ask: "Allow opening every file to everyone?",
  },
  SQL_DROP: { says: "That destroys database data.", ask: "Allow dropping database data?" },
  SQL_TRUNCATE: { says: "That empties a database table.", ask: "Allow emptying a database table?" },
  SQL_DELETE_ALL: {
    says: "That deletes every row of the table.",
    ask: "Allow deleting every row of a table?",
  },
  SQL_ALTER_DROP: {
    says: "That drops a column for good.",
    ask: "Allow dropping a database column?",
  },
  CREDENTIAL_ACCESS: {
    says: "That touches a credentials file.",
    ask: "Allow touching a credentials file?",
  },
  CREDENTIAL_CONTENT: {
    says: "That looks like a password.",
    ask: "Allow a step that handles a password?",
  },
  CREDENTIAL_EXFIL: {
    says: "That sends a password over the web.",
    ask: "Allow sending a password over the web?",
  },
  GIT_FORCE_PUSH_MAIN: {
    says: "That rewrites main for everyone.",
    ask: "Allow force-pushing to main?",
  },
  GIT_RESET_MANY: {
    says: "That throws away many commits.",
    ask: "Allow discarding those commits?",
  },
  GUARD_OWN_LIST_WRITE: {
    says: "That list says which files are yours to delete. The gateway writes it, not you.",
    ask: "Allow the agent to write the guard's own-files list?",
  },
  GUARD_SELF_ANSWER: {
    says: "That answer is the owner's to give, not yours.",
    ask: "Allow the agent to answer a guard question itself?",
  },
  CREDENTIAL_FILE_PRINTED: {
    says: "That prints a password into the chat.",
    ask: "Allow showing {target} in the chat?",
    noun: "a credentials file",
  },
};

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
/** True when the text's rm commands all target only paths under /tmp: scratch, free to delete, recursive or not. */
export function rmOnlyUnderTmp(text: string): boolean {
  // A line break ends a command, as `;` does, so it ends this rm's operands too: [^\S\n] is any space but a line break.
  const rms = [...text.matchAll(/\brm[^\S\n]+((?:[^\s;&|"'\\]+[^\S\n]*)+)/g)];
  return (
    rms.length > 0 &&
    rms.every((m) => {
      const paths = m[1].split(/\s+/).filter((w) => w && !w.startsWith("-"));
      return paths.length > 0 && paths.every((w) => /^\/tmp\/[^\s*?]/.test(w) && !w.includes(".."));
    })
  );
}

export function evaluateRules(
  toolName: string,
  argsStr: string,
  o?: { enforcedOnly?: boolean },
): RulesResult {
  const combined = `${toolName} ${argsStr}`;
  const enforcedOnly = o?.enforcedOnly === true;
  for (const { pattern, rule, explanation, enforce, ownerIntent } of ALL_RULES) {
    if (ownerIntent) continue; // needs the owner's words: decided by the pre-execution hook
    if (enforcedOnly && !enforce) continue;
    if (pattern.test(combined) && !(rule === "FS_DESTRUCTIVE_ROOT" && rmOnlyUnderTmp(combined))) {
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
    ...(r.ownerIntent ? { ownerIntent: r.ownerIntent } : {}),
  }));
}
