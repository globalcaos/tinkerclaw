/**
 * Effect classification and target resolution (design doc §3 M3, paper §7.1).
 *
 * Pure text processing: a command string is scanned with a small quote-aware tokenizer and
 * looked up in tables. Nothing is ever executed, no shell is involved, globs are never
 * expanded and `$(...)`/backticks are kept as opaque text. Code buys consistency here: the
 * effect class of a command is the same every turn and no model can skip it.
 */

import * as path from "node:path";
import type { EffectClass, Field, ResolvedTarget } from "./types.js";

interface Tok {
  text: string;
  quoted: boolean;
  op?: ">" | ">>" | "<";
}

const SHELL_TOOLS = new Set(["bash", "exec", "shell", "sh", "zsh", "run", "command"]);
const READ_TOOLS = new Set(["read", "grep", "glob", "webfetch"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);

export function isShellTool(tool: string | null | undefined): boolean {
  return tool != null && SHELL_TOOLS.has(tool.toLowerCase());
}

/** Split a command into simple commands (on ; && || | & newline), each a list of words. */
function scan(cmd: string): Tok[][] {
  const segs: Tok[][] = [];
  let cur: Tok[] = [];
  let buf = "";
  let has = false;
  let quoted = false;
  const flush = (): void => {
    if (has) {
      cur.push({ text: buf, quoted });
    }
    buf = "";
    has = false;
    quoted = false;
  };
  const endSeg = (): void => {
    flush();
    if (cur.length > 0) {
      segs.push(cur);
    }
    cur = [];
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "\\") {
      if (i + 1 < cmd.length) {
        buf += cmd[i + 1];
        has = true;
      }
      i += 2;
    } else if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end === -1 ? cmd.length : end;
      buf += cmd.slice(i + 1, stop);
      has = true;
      quoted = true;
      i = stop + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          if ('"\\$`'.includes(cmd[j + 1])) {
            buf += cmd[j + 1];
          } else {
            buf += cmd[j] + cmd[j + 1];
          }
          j += 2;
        } else {
          buf += cmd[j];
          j++;
        }
      }
      has = true;
      quoted = true;
      i = j + 1;
    } else if (c === "$" && cmd[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < cmd.length; j++) {
        if (cmd[j] === "(") {
          depth++;
        } else if (cmd[j] === ")") {
          depth--;
          if (depth === 0) {
            break;
          }
        }
      }
      buf += cmd.slice(i, j + 1);
      has = true;
      quoted = true;
      i = j + 1;
    } else if (c === "`") {
      const end = cmd.indexOf("`", i + 1);
      const stop = end === -1 ? cmd.length : end;
      buf += cmd.slice(i, stop + 1);
      has = true;
      quoted = true;
      i = stop + 1;
    } else if (c === " " || c === "\t" || c === "\r") {
      flush();
      i++;
    } else if (c === "\n" || c === ";") {
      endSeg();
      i++;
    } else if (c === "|") {
      endSeg();
      i += cmd[i + 1] === "|" || cmd[i + 1] === "&" ? 2 : 1;
    } else if (c === "&") {
      if (cmd[i + 1] === ">") {
        // &> file: a redirect of both streams
        flush();
        i += 2;
        if (cmd[i] === ">") {
          i++;
        }
        cur.push({ text: ">", quoted: false, op: ">" });
      } else {
        endSeg();
        i += cmd[i + 1] === "&" ? 2 : 1;
      }
    } else if (c === ">") {
      if (has && !quoted && /^\d+$/.test(buf)) {
        buf = "";
        has = false;
      }
      flush();
      i++;
      let op: ">" | ">>" = ">";
      if (cmd[i] === ">") {
        op = ">>";
        i++;
      }
      if (cmd[i] === "&") {
        // fd duplication (2>&1): not a file write
        i++;
        while (i < cmd.length && /[\d-]/.test(cmd[i])) {
          i++;
        }
      } else {
        cur.push({ text: op, quoted: false, op });
      }
    } else if (c === "<") {
      flush();
      cur.push({ text: "<", quoted: false, op: "<" });
      i++;
    } else {
      buf += c;
      has = true;
      i++;
    }
  }
  endSeg();
  return segs;
}

interface Parsed {
  words: string[];
  /** Redirect target words (for `>`/`>>`); /dev/null excluded. */
  writes: string[];
}

const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "exec", "nice", "xargs"]);

function parseSegment(toks: Tok[]): Parsed {
  const words: string[] = [];
  const writes: string[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.op) {
      const next = toks[k + 1];
      if (next && !next.op) {
        if (t.op !== "<" && next.text !== "/dev/null") {
          writes.push(next.text);
        }
        k++;
      }
      continue;
    }
    words.push(t.text);
  }
  let s = 0;
  for (;;) {
    while (s < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[s])) {
      s++;
    }
    if (s < words.length && WRAPPERS.has(path.basename(words[s]))) {
      s++;
      while (s < words.length && words[s].startsWith("-")) {
        s++;
      }
      continue;
    }
    break;
  }
  return { words: words.slice(s), writes };
}

const RANK: Record<EffectClass, number> = {
  read: 1,
  "local-write": 2,
  other: 3,
  spend: 4,
  "restart-own-system": 5,
  send: 6,
  delete: 7,
};

function worst(a: EffectClass | null, b: EffectClass): EffectClass {
  return a === null || RANK[b] > RANK[a] ? b : a;
}

const DELETE_CMDS = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);
const SEND_CMDS = new Set(["sendmail", "mail", "mutt", "msmtp", "scp", "lp", "lpr"]);
const READ_CMDS = new Set([
  "cat",
  "ls",
  "grep",
  "rg",
  "head",
  "tail",
  "stat",
  "echo",
  "printf",
  "pwd",
  "which",
]);
const WRITE_CMDS = new Set(["cp", "mv", "mkdir", "touch", "tee"]);
const SHELLS = new Set(["bash", "sh", "zsh"]);

function gitSub(args: string[]): { sub: string | null; rest: string[] } {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "-C" || a === "-c") {
      k++;
      continue;
    }
    if (a.startsWith("-")) {
      continue;
    }
    return { sub: a, rest: args.slice(k + 1) };
  }
  return { sub: null, rest: [] };
}

function spendOr(text: string, fallback: EffectClass): EffectClass {
  return /stripe|paypal|payment/.test(text) ? "spend" : fallback;
}

function classifyWords(words: string[]): EffectClass | null {
  if (words.length === 0) {
    return null;
  }
  const name = path.basename(words[0]);
  const args = words.slice(1);
  const text = words.join(" ").toLowerCase();

  if (SHELLS.has(name)) {
    const c = args.indexOf("-c");
    if (c !== -1 && args[c + 1] !== undefined) {
      return classifyCommand(args[c + 1]);
    }
    return "other";
  }
  if (DELETE_CMDS.has(name)) {
    return "delete";
  }
  if (/^python[\d.]*$/.test(name)) {
    const c = args.indexOf("-c");
    if (c !== -1 && /rmtree|os\.remove|unlink/.test(args[c + 1] ?? "")) {
      return "delete";
    }
    return "other";
  }
  if (name === "find") {
    if (args.includes("-delete")) {
      return "delete";
    }
    for (let k = 0; k < args.length; k++) {
      if (
        (args[k] === "-exec" || args[k] === "-execdir") &&
        DELETE_CMDS.has(path.basename(args[k + 1] ?? ""))
      ) {
        return "delete";
      }
    }
    return "read";
  }
  if (name === "git") {
    const { sub, rest } = gitSub(args);
    if (sub === "clean") {
      return "delete";
    }
    if (sub === "reset" && rest.includes("--hard")) {
      return "delete";
    }
    if (sub === "push") {
      return "send";
    }
    if (sub === "log" || sub === "status" || sub === "diff" || sub === "show") {
      return "read";
    }
    return "other";
  }
  if (SEND_CMDS.has(name)) {
    return "send";
  }
  if (name === "curl") {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (
        ((a === "-X" || a === "--request") && (args[k + 1] ?? "").toUpperCase() === "POST") ||
        a.toUpperCase() === "-XPOST" ||
        a.toUpperCase() === "--REQUEST=POST"
      ) {
        return "send";
      }
    }
    return spendOr(text, "other");
  }
  if (name === "rsync") {
    return args.some((a) => /^[^/\s:-][^/\s:]*:/.test(a)) ? "send" : "local-write";
  }
  if (name === "gh") {
    return args[0] === "pr" && args[1] === "create" ? "send" : spendOr(text, "other");
  }
  if (name === "wacli") {
    return args[0] === "send" ? "send" : "other";
  }
  if (name === "systemctl") {
    if (args.some((a) => a === "stop" || a === "restart" || a === "disable")) {
      return /openclaw|gateway/.test(text) ? "restart-own-system" : "other";
    }
    return "other";
  }
  if (name === "kill" || name === "pkill") {
    return /openclaw|gateway/.test(text) ? "restart-own-system" : "other";
  }
  if (name === "sed") {
    return args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))
      ? "local-write"
      : "read";
  }
  if (READ_CMDS.has(name)) {
    return "read";
  }
  if (WRITE_CMDS.has(name)) {
    return "local-write";
  }
  return spendOr(text, "other");
}

function classifyCommand(command: string): EffectClass | null {
  let out: EffectClass | null = null;
  for (const seg of scan(command)) {
    const parsed = parseSegment(seg);
    let cls = classifyWords(parsed.words);
    if (parsed.writes.length > 0) {
      cls = worst(cls, "local-write");
    }
    if (cls !== null) {
      out = worst(out, cls);
    }
  }
  return out;
}

export function classifyEffect(
  tool: string | null,
  command: string | null,
  args?: Record<string, unknown>,
): Field<EffectClass> {
  if (!tool) {
    return { value: null, origin: "missing" };
  }
  const t = tool.toLowerCase();
  if (READ_TOOLS.has(t)) {
    return { value: "read", origin: "derived", source: `tool:${tool}` };
  }
  if (WRITE_TOOLS.has(t)) {
    return { value: "local-write", origin: "derived", source: `tool:${tool}` };
  }
  if (SHELL_TOOLS.has(t)) {
    const cmd = command ?? (typeof args?.command === "string" ? args.command : null);
    if (cmd === null) {
      return { value: null, origin: "missing" };
    }
    const cls = classifyCommand(cmd);
    return { value: cls ?? "other", origin: "derived", source: "command" };
  }
  return { value: "other", origin: "derived", source: `tool:${tool}` };
}

// ---- target resolution ----------------------------------------------------------------

const OPERAND_CMDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "trash",
  "cat",
  "ls",
  "head",
  "tail",
  "stat",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "tee",
  "grep",
  "rg",
  "sed",
  "find",
]);
const SKIP_FIRST_OPERAND = new Set(["grep", "rg", "sed"]);
const NO_OPERAND_CMDS = new Set(["echo", "printf", "pwd", "which"]);
const ARG_PATH_KEYS = ["file_path", "filePath", "notebook_path", "path", "url", "to"];
const URL_WORD = /^[a-z][a-z0-9+.-]*:\/\//i;
const ADDRESS_WORD = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

function expandHome(w: string, home: string): string {
  if (w === "~") {
    return home;
  }
  if (w.startsWith("~/")) {
    return home + w.slice(1);
  }
  if (w === "$HOME" || w.startsWith("$HOME/")) {
    return home + w.slice(5);
  }
  if (w === "${HOME}" || w.startsWith("${HOME}/")) {
    return home + w.slice(7);
  }
  return w;
}

function makeTarget(
  raw: string,
  cwd: string,
  home: string,
  forceFile: boolean,
): ResolvedTarget | null {
  if (raw.length === 0) {
    return null;
  }
  if (URL_WORD.test(raw)) {
    return { path: raw, kind: "url", resolvedFrom: raw };
  }
  if (ADDRESS_WORD.test(raw)) {
    return { path: raw, kind: "address", resolvedFrom: raw };
  }
  if (/^[^/\s:-][^/\s:]*:[^\s]*$/.test(raw) && !raw.includes("$")) {
    return { path: raw, kind: "host", resolvedFrom: raw };
  }
  const expanded = expandHome(raw, home);
  if (expanded.includes("$") || expanded.includes("`")) {
    return null;
  }
  const abs = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
  const kind = expanded.endsWith("/") ? "dir" : forceFile ? "file" : "unknown";
  return { path: abs, kind, resolvedFrom: raw };
}

/** `NAME=value` (an `export` or `env` argument) is a setting, never a path. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Drops heredoc bodies: their lines are a command's input, not more commands (2026-10-02, `python3 - <<'EOF'`
 * bodies became targets). `<<<` here-strings are left alone. Used for targets only; the command text is unchanged.
 */
function stripHeredocs(cmd: string): string {
  const out: string[] = [];
  let end: { word: string; tabs: boolean } | null = null;
  for (const line of cmd.split("\n")) {
    if (end) {
      if ((end.tabs ? line.replace(/^\t+/, "") : line).trim() === end.word) {
        end = null;
      }
      continue;
    }
    out.push(line);
    const m = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (m) {
      end = { word: m[3], tabs: m[1] === "-" };
    }
  }
  return out.join("\n");
}

function pathLike(w: string): boolean {
  return w.includes("/") || w.startsWith("~") || w.startsWith(".") || w.startsWith("$HOME");
}

export function resolveTargets(
  command: string | null,
  args: Record<string, unknown> | undefined,
  cwd: string,
  home: string,
): Field<ResolvedTarget[]> {
  if (command === null && args === undefined) {
    return { value: null, origin: "missing" };
  }
  const out: ResolvedTarget[] = [];
  const seen = new Set<string>();
  const add = (t: ResolvedTarget | null): void => {
    if (t && !seen.has(t.path)) {
      seen.add(t.path);
      out.push(t);
    }
  };
  if (args) {
    for (const key of ARG_PATH_KEYS) {
      const v = args[key];
      if (typeof v === "string") {
        add(
          makeTarget(
            v,
            cwd,
            home,
            key === "file_path" || key === "filePath" || key === "notebook_path",
          ),
        );
      }
    }
  }
  if (command !== null) {
    // `cd` moves the folder later relative paths resolve against; an unknown one (`cd "$(mktemp -d)"`) keeps it.
    let dir = cwd;
    for (const seg of scan(stripHeredocs(command))) {
      const parsed = parseSegment(seg);
      const name = parsed.words.length > 0 ? path.basename(parsed.words[0]) : "";
      let operands = parsed.words.slice(1).filter((w) => !w.startsWith("-") && !ASSIGNMENT.test(w));
      if (name === "cd") {
        const to = makeTarget(operands[0] ?? "~", dir, home, false);
        if (to && (to.kind === "unknown" || to.kind === "dir")) {
          dir = to.path;
        }
        continue;
      }
      if (name === "git" || name === "systemctl" || name === "gh" || SKIP_FIRST_OPERAND.has(name)) {
        operands = operands.slice(1);
      }
      const takesAll = OPERAND_CMDS.has(name);
      for (const w of operands) {
        if (NO_OPERAND_CMDS.has(name) && !pathLike(w)) {
          continue;
        }
        if (takesAll || pathLike(w) || URL_WORD.test(w) || ADDRESS_WORD.test(w)) {
          add(makeTarget(w, dir, home, false));
        }
      }
      for (const w of parsed.writes) {
        add(makeTarget(w, dir, home, true));
      }
    }
  }
  return { value: out, origin: "derived", source: "text" };
}
