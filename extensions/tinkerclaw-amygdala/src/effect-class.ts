/**
 * Effect classification and target resolution (design doc §3 M3, paper §7.1).
 *
 * Pure text processing: a command string is scanned with a small quote-aware tokenizer and
 * looked up in tables. Nothing is ever executed, no shell is involved, globs are never
 * expanded and `$(...)`/backticks are kept as one word (their inner command is classified as text
 * too). The one file read is the Host names of ~/.ssh/config, for ssh. Code buys consistency here:
 * the effect class of a command is the same every turn and no model can skip it.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { EffectClass, Field, ResolvedTarget } from "./types.js";

interface Tok {
  text: string;
  quoted: boolean;
  op?: ">" | ">>" | "<";
  /** The commands of the `$(…)`/backtick substitutions the shell runs in this word (none in single quotes). */
  subs?: string[];
}

const SHELL_TOOLS = new Set(["bash", "exec", "shell", "sh", "zsh", "run", "command"]);
const READ_TOOLS = new Set(["read", "grep", "glob", "webfetch"]);
/** The gateway's message tool: an action that puts or changes a message in someone else's chat is a send. */
const MESSAGE_TOOLS = new Set(["message", "mcp__jarvis__message"]);
const MESSAGE_OUT = new Set([
  "send",
  "broadcast",
  "poll",
  "edit",
  "delete",
  "unsend",
  "react",
  "reply",
]);
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
  let subs: string[] = [];
  const flush = (): void => {
    if (has) {
      cur.push(subs.length > 0 ? { text: buf, quoted, subs } : { text: buf, quoted });
    }
    buf = "";
    has = false;
    quoted = false;
    subs = [];
  };
  /** The index of the `)` closing the `(` at `open`, or the end of the command. */
  const closing = (open: number): number => {
    let depth = 0;
    let j = open;
    for (; j < cmd.length; j++) {
      if (cmd[j] === "(") {
        depth++;
      } else if (cmd[j] === ")" && --depth === 0) {
        break;
      }
    }
    return j;
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
          // Inside double quotes the shell still runs `$(…)` and backticks; the word's text is kept as it was.
          if (cmd[j] === "$" && cmd[j + 1] === "(" && cmd[j + 2] !== "(") {
            subs.push(cmd.slice(j + 2, closing(j + 1)));
          } else if (cmd[j] === "`") {
            const end = cmd.indexOf("`", j + 1);
            const dq = cmd.indexOf('"', j + 1);
            if (end !== -1 && (dq === -1 || end < dq)) {
              subs.push(cmd.slice(j + 1, end));
              buf += cmd.slice(j, end);
              j = end;
            }
          }
          buf += cmd[j];
          j++;
        }
      }
      has = true;
      quoted = true;
      i = j + 1;
    } else if (c === "$" && cmd[i + 1] === "(") {
      const j = closing(i + 1);
      if (cmd[i + 2] !== "(") {
        subs.push(cmd.slice(i + 2, j));
      }
      buf += cmd.slice(i, j + 1);
      has = true;
      quoted = true;
      i = j + 1;
    } else if (c === "`") {
      const end = cmd.indexOf("`", i + 1);
      const stop = end === -1 ? cmd.length : end;
      subs.push(cmd.slice(i + 1, stop));
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
  /** The commands the segment's substitutions run. */
  subs: string[];
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
  return { words: words.slice(s), writes, subs: toks.flatMap((t) => t.subs ?? []) };
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
const SEND_CMDS = new Set(["sendmail", "mail", "mutt", "msmtp", "lp", "lpr"]);
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

/** A `host:path` word. `=` is not a host character, so an option value such as `ProxyJump=a:22` is not one. */
const REMOTE_WORD = /^[^/\s:=-][^/\s:=]*:/;

/**
 * A copy that only fetches: it names a remote source and ends on a word that is not remote. A flag after that source may
 * take the last word as its value, and a destination in a variable shows no host, so both stay sends: what cannot be
 * read as a fetch counts as the upload it may be.
 */
function fetchesOnly(args: string[]): boolean {
  const first = args.findIndex((a) => REMOTE_WORD.test(a));
  const rest = first < 0 ? [] : args.slice(first + 1);
  const dest = rest[rest.length - 1];
  return dest !== undefined && !REMOTE_WORD.test(dest) && !rest.some((a) => a.startsWith("-"));
}

function spendOr(text: string, fallback: EffectClass): EffectClass {
  return /stripe|paypal|payment/.test(text) ? "spend" : fallback;
}

/**
 * True when a curl POST stays on this machine: every address it names is loopback, and none is a route that
 * passes something on to the outside (a message, a notification, a command to a phone).
 *
 * 2026-11-12: a test POST to a page served on 127.0.0.1 was held as a "send", the class for content that leaves
 * the machine. The rule read the method and never the destination. The gate is on the effect, so the exception
 * stops where the effect could leave: a local route named after sending keeps the "send" class.
 */
const LOOPBACK_URL = /^https?:\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
const RELAY_ROUTE = /send|message|notify|invoke|publish|mail|whatsapp|sms|call|webhook/i;
function postsOnlyToThisMachine(args: string[]): boolean {
  const urls = args.filter((a) => /^https?:\/\//i.test(a));
  return urls.length > 0 && urls.every((u) => LOOPBACK_URL.test(u) && !RELAY_ROUTE.test(u));
}

/**
 * Raw network senders and remote shells (2026-11-14, burn review b1113-s4/F3). `nc host 443 < file` and `cat f | ssh
 * host 'cat > x'` read "other": no egress question, no fail-closed hold. A raw pipe to another machine is a send. For
 * ssh the owner's own machines are the daily routine (the Pi, the laptop, the lab boxes), so a destination named as a
 * `Host` in ~/.ssh/config, or a private LAN / tailnet address, stays "other", as before; any other destination (a public
 * name or address, or a variable) is a send. Only the Host names are read from that file, never a HostName, a key or any
 * other line.
 */
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|\[::1\])$/i;
/**
 * A private LAN or tailnet address (10/8, 172.16/12, 192.168/16, the 100.64/10 range Tailscale hands out, IPv6 link-local
 * and unique-local). His laptop and the lab boxes are reached by address as often as by name (2026-11-14: 306 recorded
 * ssh steps to the laptop's tailnet address, 102 to lab LAN addresses), and ssh to them read "other" before this change.
 */
const PRIVATE_ADDRESS =
  /^(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|\[?f[cde][0-9a-f]{2}:[0-9a-f:%\w]*\]?)$/i;
const DEFAULT_SSH_CONFIG = path.join(homedir(), ".ssh", "config");
let sshConfigPath = DEFAULT_SSH_CONFIG;
let sshHosts: { path: string; mtimeMs: number; names: Set<string> } | null = null;

/** Tests point the own-host list at a fixture; `null` goes back to ~/.ssh/config. */
export function setSshConfigForTests(p: string | null): void {
  sshConfigPath = p ?? DEFAULT_SSH_CONFIG;
  sshHosts = null;
}

/** The literal `Host` names of the ssh config, lower-cased. Patterns (`*`, `?`, `!x`) and `Include` are not followed. */
function ownSshHosts(): Set<string> {
  try {
    const { mtimeMs } = statSync(sshConfigPath);
    if (sshHosts?.path !== sshConfigPath || sshHosts.mtimeMs !== mtimeMs) {
      const names = new Set<string>();
      for (const line of readFileSync(sshConfigPath, "utf8").split("\n")) {
        const m = /^\s*host(?:\s*=\s*|\s+)(.+)$/i.exec(line);
        for (const n of m ? m[1].trim().split(/\s+/) : []) {
          if (!/[*?!]/.test(n)) names.add(n.toLowerCase());
        }
      }
      sshHosts = { path: sshConfigPath, mtimeMs, names };
    }
    return sshHosts.names;
  } catch {
    return new Set();
  }
}

/** ssh options that take a value: `-p 22`, `-i key`, `-o X=Y`. */
const SSH_VALUE_FLAGS = "BbcDEeFIiJLlmOoPpQRSWw";

/** The host an `ssh` command connects to (`user@`, `ssh://` and `:port` removed), or null when it names none (`ssh -V`). */
function sshHost(args: string[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        if (SSH_VALUE_FLAGS.includes(a[j])) {
          if (j === a.length - 1) k++;
          break;
        }
      }
      continue;
    }
    return a
      .replace(/^ssh:\/\//i, "")
      .replace(/^.*@/, "")
      .replace(/:\d+$/, "");
  }
  return null;
}

/** nc moves data unless it only scans (`-z`), talks to a local socket (`-U`), or names no host but this machine. */
function ncSends(args: string[]): boolean {
  const flags = args.filter((a) => /^-[A-Za-z]/.test(a)).join("");
  if (/[zU]/.test(flags)) return false;
  if (/l/.test(flags)) return true;
  const operands = args.filter((a) => !a.startsWith("-"));
  return !operands.every((a) => /^\d+$/.test(a) || LOOPBACK_HOST.test(a));
}

/** A socat network address (`TCP:host:443`, `TCP-LISTEN:80`, `OPENSSL:host:443`) that is not on this machine. */
const SOCAT_NET = /^(?:tcp|udp|sctp|dccp|ssl|openssl)[\w-]*:/i;
const SOCAT_LOOPBACK = /:(?:127(?:\.\d{1,3}){3}|localhost|\[?::1\]?):/i;

/** `> /dev/tcp/host/port` (or udp) writes to the network; a loopback host stays on this machine. */
const DEV_NET = /^\/dev\/(?:tcp|udp)\/([^/]+)\//;
function writesToNetwork(target: string): boolean {
  const m = DEV_NET.exec(target);
  return m !== null && !LOOPBACK_HOST.test(m[1]);
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
    // Everything under /tmp is scratch: losing it costs nothing, so it is an ordinary local change, not a delete.
    const paths = args.filter((a) => !a.startsWith("-"));
    const onlyTmp =
      paths.length > 0 && paths.every((a) => /^\/tmp\/[^\s*?]/.test(a) && !a.includes(".."));
    return onlyTmp ? "local-write" : "delete";
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
    let out: EffectClass = "read";
    for (let k = 0; k < args.length; k++) {
      if (args[k] !== "-exec" && args[k] !== "-execdir") {
        continue;
      }
      // What `-exec` runs decides: `find … -exec sed -i` changes files, and a read never reaches the gates that ask.
      // 2026-11-14 (burn review b1113-s4/F1): every class counts, not only delete and local-write. A `-exec curl -X
      // POST` read "read", and a plain read silences the safety family.
      const inner = classifyWords(args.slice(k + 1).filter((w) => !/^(?:\\?;|\+)$/.test(w)));
      if (inner !== null) {
        out = worst(out, inner);
      }
    }
    return out;
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
  if (name === "nc" || name === "ncat" || name === "netcat") {
    return ncSends(args) ? "send" : spendOr(text, "other");
  }
  if (name === "socat") {
    const net = args.some((a) => SOCAT_NET.test(a) && !SOCAT_LOOPBACK.test(a));
    return net ? "send" : spendOr(text, "other");
  }
  if (name === "ssh") {
    const h = sshHost(args)?.toLowerCase() ?? null;
    // `ssh -G host` only prints the config it would use: it connects nowhere.
    const own =
      h === null ||
      args.includes("-G") ||
      LOOPBACK_HOST.test(h) ||
      PRIVATE_ADDRESS.test(h) ||
      ownSshHosts().has(h);
    return own ? spendOr(text, "other") : "send";
  }
  if (name === "curl") {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (
        ((a === "-X" || a === "--request") && (args[k + 1] ?? "").toUpperCase() === "POST") ||
        a.toUpperCase() === "-XPOST" ||
        a.toUpperCase() === "--REQUEST=POST"
      ) {
        return postsOnlyToThisMachine(args) ? "local-write" : "send";
      }
    }
    return spendOr(text, "other");
  }
  if (name === "scp") {
    return fetchesOnly(args) ? "local-write" : "send";
  }
  if (name === "rsync") {
    return args.some((a) => REMOTE_WORD.test(a)) && !fetchesOnly(args) ? "send" : "local-write";
  }
  if (name === "gh") {
    return args[0] === "pr" && args[1] === "create" ? "send" : spendOr(text, "other");
  }
  if (name === "wacli") {
    return args[0] === "send" ? "send" : "other";
  }
  // FORK 2026-11-12: `openclaw message send` is the agent's own WhatsApp send. It read "other", so the "a mention is not
  // a step" exit silenced it: 90 sends recorded from 10-02 to 11-12 (with the message tool's), one of them a packet
  // that went to the wrong person.
  if (name === "openclaw" && args[0] === "message") {
    const help = args.includes("--help") || args.includes("-h");
    return MESSAGE_OUT.has(args[1] ?? "") && !help ? "send" : "other";
  }
  // `timeout 60 cmd` runs cmd: its class counts, and never reads lower than "other" (2026-11-12).
  if (name === "timeout") {
    const inner = classifyWords(afterTimeout(args));
    return inner === null ? "other" : worst("other", inner);
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

/** The command `timeout [options] DURATION cmd …` runs. Options that take a value (`-k 5`, `-s KILL`) are skipped too. */
function afterTimeout(args: string[]): string[] {
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) {
    k += /^-(?:k|s)$|^--(?:kill-after|signal)$/.test(args[k]) ? 2 : 1;
  }
  return args.slice(k + 1);
}

function classifyCommand(command: string): EffectClass | null {
  let out: EffectClass | null = null;
  for (const seg of scan(command)) {
    const parsed = parseSegment(seg);
    let cls = classifyWords(parsed.words);
    if (parsed.writes.length > 0) {
      cls = worst(cls, parsed.writes.some(writesToNetwork) ? "send" : "local-write");
    }
    if (cls !== null) {
      out = worst(out, cls);
    }
  }
  // 2026-11-14 (burn review b1113-s4/F2): a substitution runs a command of its own. `echo $(curl -X POST …)` read
  // "read", and a plain read silences the safety family. The inner command counts when it is heavier than "other",
  // and a step that runs one reads as a plain read only when that command is a read too. A quoted heredoc body is
  // text the shell never expands (markdown backticks written to a file), so it is left out.
  for (const sub of scan(stripHeredocs(command, true)).flatMap((seg) => parseSegment(seg).subs)) {
    const inner = classifyCommand(sub) ?? "other";
    if (out === null || out === "read" || RANK[inner] > RANK.other) {
      out = worst(out, inner);
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
  if (MESSAGE_TOOLS.has(t)) {
    const out = MESSAGE_OUT.has(String(args?.action ?? "")) && args?.dryRun !== true;
    return { value: out ? "send" : "other", origin: "derived", source: `tool:${tool}` };
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
/** A chat recipient: a phone number or a WhatsApp chat id (`…@s.whatsapp.net`, `…@g.us`, `…@lid`). */
const RECIPIENT_WORD = /^(?:\+?\d[\d\s().-]{4,}\d|[\w.+-]+@(?:s\.whatsapp\.net|g\.us|lid|c\.us))$/;
const RECIPIENT_KEYS = ["target", "to", "chatId"];
const MESSAGE_RECIPIENT_FLAGS = new Set(["-t", "--target", "--to"]);
const MESSAGE_FILE_FLAGS = new Set(["--media", "--file", "--path"]);

function recipientTarget(raw: string): ResolvedTarget | null {
  const r = raw.trim();
  return RECIPIENT_WORD.test(r) ? { path: r, kind: "address", resolvedFrom: raw } : null;
}

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
 * bodies became targets). `<<<` here-strings are left alone. Used for targets and the card's script names; the command
 * text is unchanged.
 */
export function stripHeredocs(cmd: string, quotedOnly = false): string {
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
    // `quotedOnly`: keep an unquoted body (`<<EOF`), whose `$(…)` the shell does run; drop only a quoted one (`<<'EOF'`).
    if (m && (!quotedOnly || m[2] !== "")) {
      end = { word: m[3], tabs: m[1] === "-" };
    }
  }
  return out.join("\n");
}

function pathLike(w: string): boolean {
  return w.includes("/") || w.startsWith("~") || w.startsWith(".") || w.startsWith("$HOME");
}

const WRITE_ALL_OPERANDS = new Set(["tee", "touch", "mkdir"]);
const WRITE_LAST_OPERAND = new Set(["cp", "mv"]);

/**
 * The files a shell command writes, as far as its text shows (2026-10-25, for the owned targets): redirect targets, the
 * operands of `tee`/`touch`/`mkdir`, the destination of `cp`/`mv`. Text processing only, like `resolveTargets`; a
 * command that writes through a program (`python3 -c …`) shows nothing here.
 */
export function writtenByCommand(command: string, cwd: string, home: string): string[] {
  const out = new Set<string>();
  let dir = cwd;
  for (const seg of scan(stripHeredocs(command))) {
    const parsed = parseSegment(seg);
    const name = parsed.words.length > 0 ? path.basename(parsed.words[0]) : "";
    const operands = parsed.words.slice(1).filter((w) => !w.startsWith("-") && !ASSIGNMENT.test(w));
    if (name === "cd") {
      const to = makeTarget(operands[0] ?? "~", dir, home, false);
      if (to && (to.kind === "unknown" || to.kind === "dir")) {
        dir = to.path;
      }
      continue;
    }
    const add = (w: string): void => {
      const t = makeTarget(w, dir, home, true);
      if (t && (t.kind === "file" || t.kind === "dir")) {
        out.add(t.path);
      }
    };
    parsed.writes.forEach(add);
    if (WRITE_ALL_OPERANDS.has(name)) {
      operands.forEach(add);
    } else if (WRITE_LAST_OPERAND.has(name) && operands.length >= 2) {
      add(operands[operands.length - 1]);
    }
  }
  return [...out];
}

/** A pipe, a substitution or `xargs` can hand what one command read to another (`ls dir | xargs rm`). */
function carriesOutputOn(cmd: string): boolean {
  if (/\$\(|`|[<>]\(|\bxargs\b/.test(cmd)) return true;
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === "\\") i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === "|") {
      if (cmd[i + 1] !== "|") return true;
      i++;
    }
  }
  return false;
}

/**
 * The paths a shell command only reads, as far as its text shows (2026-11-13, for the scope question on a deletion):
 * the operands of `ls`, `cat`, `stat` and the other READ_CMDS, less every path another part of the command names or
 * writes. A clean-up that ended on `ls` of the repository folder was asked about because that folder was not the
 * agent's own; a deletion does not reach a folder it lists. Nothing is returned when what was read can travel into
 * another command. Paths resolve as in `resolveTargets`. Text processing only.
 */
export function readOnlyByCommand(command: string, cwd: string, home: string): string[] {
  const text = stripHeredocs(command);
  if (carriesOutputOn(text)) return [];
  const read = new Set<string>();
  const named = new Set<string>();
  let dir = cwd;
  for (const seg of scan(text)) {
    const parsed = parseSegment(seg);
    if (parsed.words.length > 0 && path.basename(parsed.words[0]) === "timeout") {
      parsed.words = afterTimeout(parsed.words.slice(1));
    }
    const name = parsed.words.length > 0 ? path.basename(parsed.words[0]) : "";
    const rest = parsed.words.slice(1).filter((w) => !ASSIGNMENT.test(w));
    if (name === "cd") {
      const to = makeTarget(rest.find((w) => !w.startsWith("-")) ?? "~", dir, home, false);
      if (to && (to.kind === "unknown" || to.kind === "dir")) {
        dir = to.path;
      }
      continue;
    }
    const reads = READ_CMDS.has(name);
    // A reading command gives the operands `resolveTargets` takes from it. Any other command names every word it
    // carries, a flag's `=value` too: more than it may touch, never less.
    let words = reads
      ? rest.filter((w) => !w.startsWith("-") && (!NO_OPERAND_CMDS.has(name) || pathLike(w)))
      : rest
          .map((w) => (w.startsWith("-") && w.includes("=") ? w.slice(w.indexOf("=") + 1) : w))
          .filter((w) => !w.startsWith("-"));
    if (reads && SKIP_FIRST_OPERAND.has(name)) {
      words = words.slice(1);
    }
    for (const w of words) {
      const t = makeTarget(w, dir, home, false);
      if (t && (t.kind === "file" || t.kind === "dir" || t.kind === "unknown")) {
        (reads ? read : named).add(t.path);
      }
    }
    for (const w of parsed.writes) {
      const t = makeTarget(w, dir, home, true);
      if (t) {
        named.add(t.path);
      }
    }
  }
  return [...read].filter((p) => !named.has(p));
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
    // A recipient first: the card and the checks name the first target, and a number is not a file.
    for (const key of RECIPIENT_KEYS) {
      const v = args[key];
      if (typeof v === "string") add(recipientTarget(v));
    }
    for (const key of ARG_PATH_KEYS) {
      if (key === "to" && typeof args.to === "string" && recipientTarget(args.to)) continue;
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
      if (parsed.words.length > 0 && path.basename(parsed.words[0]) === "timeout") {
        parsed.words = afterTimeout(parsed.words.slice(1));
      }
      const name = parsed.words.length > 0 ? path.basename(parsed.words[0]) : "";
      // `openclaw message …`: the recipient and any file it attaches are the targets; the text is not a path
      // (2026-11-12: a message body holding a URL became a file named after the whole message).
      if (name === "openclaw" && parsed.words[1] === "message") {
        const w = parsed.words;
        for (let k = 2; k < w.length; k++) {
          const [flag, inline] = w[k].includes("=") ? w[k].split(/=(.*)/s, 2) : [w[k], undefined];
          const value = inline ?? w[k + 1];
          if (value === undefined) continue;
          if (MESSAGE_RECIPIENT_FLAGS.has(flag))
            add(recipientTarget(value) ?? makeTarget(value, dir, home, false));
          else if (MESSAGE_FILE_FLAGS.has(flag)) add(makeTarget(value, dir, home, false));
          else continue;
          if (inline === undefined) k++;
        }
        for (const wr of parsed.writes) add(makeTarget(wr, dir, home, true));
        continue;
      }
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
