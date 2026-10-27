#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: a background Fractal reflection proposes, it never sends, deletes, publishes, spends or
 * restarts.
 *
 * FORK 2026-10-25 — WHY CODE. The Fractal doctrine (extensions/tinkerclaw-fractal-reflection/fractal-prompt.md,
 * "Reversibility gates boldness") and the moral code's reflection loop both say it: files, notes, code on a branch and a
 * merge into develop are the reflection's to do; a send, a delete, a publish, a spend or a restart comes back as the
 * exact command, for the owner to run. Until today that was prompt text only, and the reflection runs with every tool.
 * The memory post (thetinkerzone.com, "Why your AI assistant forgets what you told it") says such calls come back "as a
 * proposal, never as an action"; this hook is what makes that true.
 *
 * WHERE IT RUNS. hooks.json registers it for every tool call of every session, behind a shell test: only a worker the
 * tinker-bridge spawned for a Fractal session (`agent:<id>:fractal:<P>`) has TC_FRACTAL_GUARD set (tinker-bridge
 * fractal-guard.ts), so plain Claude Code and every chat worker pay one `sh` test and never start node.
 *
 *   TC_FRACTAL_GUARD=enforce  a matched call is denied with the reason below (the model writes it as a proposal)
 *   TC_FRACTAL_GUARD=watch    the call runs; the match is only logged
 *   unset / anything else     nothing at all
 *   TC_FRACTAL_GUARD_SINCE    when the worker started (epoch ms): a file born after it is the reflection's own
 *
 * Every match goes to <state dir>/data/fractal/guard.jsonl: the time, the mode, the decision, the kind, the tool, the
 * short phrase that matched and the session key. Never the command or its arguments, which may carry a message's text.
 *
 * WHAT STILL PASSES, measured on 3,968 tool calls of 807 past reflections on the owner's Pi (2026-10-25): deleting the
 * reflection's own leftovers (a path under /tmp or from `mktemp`, a symlink, a file born after the worker started),
 * `trash` (recoverable), `git branch -d` and `git worktree remove` without force, `git rm` without -f, and a `kill`
 * that is not a reload signal or aimed at the gateway (its own test runs). The restart and rebuild skills keep their
 * own busy-house check.
 *
 * A PATTERN LIST, NOT A SANDBOX. It reads the command text the model wrote: a script that deletes or sends inside itself
 * is not seen. Exit code is always 0: an internal error lets the call through, the way the amygdala's hook fails open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { claim, readStdin, stateDir } from "./hook-common.mjs";

export const FRACTAL_GUARD_MODES = ["enforce", "watch"];

// ─── shell text → simple commands ───────────────────────────────────────────────────────────────────────────────────

/** Programs whose stdin or argument is itself shell: their heredoc body and `-c` script are commands. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** Shell words of one simple command: quotes removed, a backslash escapes the next char. */
function shellWords(seg) {
  const out = [];
  let cur = "";
  let quote = null;
  let any = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < seg.length) {
        cur += seg[++i];
      } else {
        cur += c;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      any = true;
    } else if (c === "\\" && i + 1 < seg.length) {
      cur += seg[++i];
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) {
        out.push(cur);
      }
      cur = "";
      any = false;
    } else {
      cur += c;
    }
  }
  if (cur || any) {
    out.push(cur);
  }
  return out;
}

/** Words that run the command after them. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "time",
  "exec",
  "command",
  "builtin",
  "xargs",
  "nice",
  "ionice",
  "setsid",
  "stdbuf",
  "timeout",
]);
/** Wrapper options that take a value (`sudo -u root`, `timeout -s KILL 5`). */
const WRAPPER_VALUE_OPTS = new Set(["-u", "-g", "-C", "-s", "-k", "-n", "-p"]);

/** The command word and its arguments, past `VAR=x` assignments and wrappers. */
function commandOf(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_]\w*=/.test(w)) {
      i++;
      continue;
    }
    const base = path.basename(w);
    if (!WRAPPERS.has(base)) {
      break;
    }
    i++;
    while (i < words.length && words[i].startsWith("-")) {
      i += WRAPPER_VALUE_OPTS.has(words[i]) && base !== "env" && base !== "xargs" ? 2 : 1;
    }
    if (base === "timeout" && /^\d/.test(words[i] ?? "")) {
      i++;
    }
  }
  return { cmd: path.basename(words[i] ?? ""), args: words.slice(i + 1) };
}

/** Heredoc bodies fed to anything but a shell are data (a file being written, a python script), not commands. */
function stripDataHeredocs(command) {
  const lines = String(command).split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(lines[i]);
    if (!m) {
      continue;
    }
    const before = lines[i].slice(0, m.index).split(/[|;&]/).pop() ?? "";
    if (SHELLS.has(commandOf(shellWords(before)).cmd)) {
      continue;
    }
    const end = lines.findIndex((l, j) => j > i && l.trim() === m[2]);
    if (end > i) {
      i = end - 1;
    }
  }
  return out.join("\n");
}

/**
 * The simple commands of a command line, in order: split on ; && || | & newlines, `$(`, backticks and parentheses,
 * outside quotes. A `#` that starts a word comments out the rest of its line.
 */
function segments(command) {
  const text = stripDataHeredocs(command);
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < text.length) {
        cur += text[++i];
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\" && i + 1 < text.length) {
      cur += c + text[++i];
    } else if (c === "#" && (cur === "" || /\s$/.test(cur))) {
      while (i + 1 < text.length && text[i + 1] !== "\n") {
        i++;
      }
    } else if (";|&\n`()".includes(c)) {
      out.push(cur);
      cur = "";
    } else if (c === "$" && text[i + 1] === "(") {
      out.push(cur);
      cur = "";
      i++;
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// ─── what a delete may touch: the reflection's own scratch ──────────────────────────────────────────────────────────

/**
 * Where a command runs and what it named. `cwd` follows `cd` to literal paths (undefined once it cannot be known),
 * `vars` holds literal assignments (`W=/x`) and `mktemp` results, `since` is when the worker started, `remote` marks an
 * ssh command (another disk: no stat, no cwd).
 */
function newContext(base) {
  return { cwd: base.cwd, vars: new Map(), since: base.since, remote: base.remote === true };
}

/** `$NAME`, `${NAME}` and a leading `~` expanded from the context; null when something cannot be expanded. */
function expand(word, ctx) {
  let w = word;
  if (w === "~" || w.startsWith("~/")) {
    w = path.join(os.homedir(), w.slice(1));
  }
  let unknown = false;
  w = w.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_, name) => {
    const v = ctx.vars.get(name) ?? (name === "HOME" ? os.homedir() : undefined);
    if (v === undefined) {
      unknown = true;
    }
    return v ?? "";
  });
  return unknown || /[$`]/.test(w) ? null : w;
}

/**
 * A path the delete may remove: under /tmp, or (on this disk) a symlink, a file or folder born after `since` (the
 * reflection made it), or an absolute path where nothing exists.
 */
function isScratch(target, ctx) {
  if (ctx.remote && target.startsWith("~")) {
    return false; // the remote host's home, never this one's
  }
  const t = expand(target, ctx);
  if (t === null || t.split("/").includes("..")) {
    return false;
  }
  if (/^\/tmp\/./.test(t)) {
    return true; // a glob under /tmp stays under /tmp
  }
  if (/[*?[]/.test(t)) {
    return false;
  }
  if (ctx.remote || (!path.isAbsolute(t) && !ctx.cwd)) {
    return false;
  }
  const abs = path.resolve(ctx.cwd ?? "/", t);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    // Nothing there deletes nothing; only trusted for an absolute path, never for one resolved from a tracked cwd.
    return err?.code === "ENOENT" && path.isAbsolute(t);
  }
  if (st.isSymbolicLink()) {
    return true;
  }
  return Number.isFinite(ctx.since) && st.birthtimeMs > 0 && st.birthtimeMs >= ctx.since;
}

/** `mktemp` that lands under /tmp: no `-p`/`--tmpdir=<dir>`, and a template, if any, that is relative or in /tmp. */
function mktempInTmp(args) {
  let template = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p" || a === "--tmpdir") {
      return /^\/tmp(?:\/|$)/.test(args[i + 1] ?? "");
    }
    if (a.startsWith("--tmpdir=")) {
      return /^--tmpdir=\/tmp(?:\/|$)/.test(a);
    }
    if (!a.startsWith("-")) {
      template = a;
    }
  }
  return !template.includes("/") || template.startsWith("/tmp/");
}

/** Note `X=$(mktemp …)` before splitting, while the assignment and the call are still one piece of text. */
function noteMktempVars(command, ctx) {
  for (const m of String(command).matchAll(/\b([A-Za-z_]\w*)=["']?\$\(\s*mktemp\b([^)]*)\)/g)) {
    if (mktempInTmp(shellWords(m[2]))) {
      ctx.vars.set(m[1], `/tmp/mktemp.${m[1]}`);
    }
  }
}

/** Assignments and `cd` change what later commands mean; nothing else does here. */
function track(words, ctx) {
  if (words.length > 0 && words.every((w) => /^[A-Za-z_]\w*=/.test(w))) {
    for (const w of words) {
      const at = w.indexOf("=");
      const name = w.slice(0, at);
      const raw = w.slice(at + 1);
      if (
        ctx.vars.get(name)?.startsWith("/tmp/mktemp.") &&
        (raw === "" || raw.includes("mktemp"))
      ) {
        continue; // `T=$(mktemp)` itself (noteMktempVars has it), or its left half split off at `$(`
      }
      const value = expand(raw, ctx);
      if (value === null) {
        ctx.vars.delete(name);
      } else {
        ctx.vars.set(name, value);
      }
    }
    return;
  }
  if (words[0] === "pushd" || words[0] === "popd") {
    ctx.cwd = undefined;
    return;
  }
  if (words[0] === "cd") {
    const dir = words[1] === undefined ? os.homedir() : expand(words[1], ctx);
    ctx.cwd = dir === null || ctx.remote ? undefined : path.resolve(ctx.cwd ?? "/", dir);
  }
}

// ─── the rules, one function per command family ─────────────────────────────────────────────────────────────────────

const hit = (kind, match) => ({ kind, match });

/** Deleters that throw data away. `trash` moves it to the trash can and is left alone: recoverable. */
const DELETERS = new Set(["rm", "unlink", "shred", "srm"]);

function deleteRule(cmd, args, ctx) {
  if (DELETERS.has(cmd)) {
    const targets = args.filter((a) => !a.startsWith("-"));
    return targets.length > 0 && targets.every((t) => isScratch(t, ctx))
      ? null
      : hit("delete", cmd);
  }
  if (cmd === "gio" && args[0] === "remove") {
    return hit("delete", "gio remove");
  }
  if (cmd === "find") {
    const deletes =
      args.includes("-delete") ||
      args.some(
        (a, j) =>
          (a === "-exec" || a === "-execdir") && DELETERS.has(path.basename(args[j + 1] ?? "")),
      );
    if (!deletes) {
      return null;
    }
    const firstFlag = args.findIndex((a) => a.startsWith("-"));
    const roots = args.slice(0, firstFlag < 0 ? args.length : firstFlag);
    return roots.length > 0 && roots.every((r) => isScratch(r, ctx))
      ? null
      : hit("delete", "find -delete");
  }
  if (cmd === "trash-empty") {
    return hit("delete", "trash-empty");
  }
  if (/^(?:npm|pnpm|yarn|pip3?|uv|conda)$/.test(cmd) && /^(?:cache|store)$/.test(args[0] ?? "")) {
    return /^(?:purge|clean|clear|remove|prune|rm)$/.test(args[1] ?? "")
      ? hit("delete", `${cmd} ${args[0]} ${args[1]}`)
      : null;
  }
  if (cmd === "docker" && /^(?:rm|rmi)$/.test(args[0] ?? "")) {
    return hit("delete", `docker ${args[0]}`);
  }
  if (cmd === "docker" && args.includes("prune")) {
    return hit("delete", "docker prune");
  }
  if (
    /^apt(?:-get)?$/.test(cmd) &&
    /^(?:remove|purge|autoremove|clean|autoclean)$/.test(args[0] ?? "")
  ) {
    return hit("delete", `${cmd} ${args[0]}`);
  }
  if (cmd === "snap" && args[0] === "remove") {
    return hit("delete", "snap remove");
  }
  if (cmd === "journalctl" && args.some((a) => a.startsWith("--vacuum"))) {
    return hit("delete", "journalctl --vacuum");
  }
  return null;
}

/** Git's global options before the subcommand that take a value. */
const GIT_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

function gitRule(args, ctx) {
  let i = 0;
  let repo;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C") {
      repo = args[i + 1];
    }
    i += GIT_VALUE_OPTS.has(args[i]) ? 2 : 1;
  }
  const sub = args[i] ?? "";
  const rest = args.slice(i + 1);
  const flag = (re) => rest.some((a) => re.test(a));
  // Throwing work away in the reflection's own scratch repo or worktree (mktemp, born this turn) deletes nothing of his.
  const own = (dir) => (dir === undefined ? false : isScratch(dir, ctx));
  const verdict = gitVerdict(sub, rest, flag);
  if (verdict?.kind === "delete") {
    const target =
      sub === "worktree" ? rest.filter((a) => !a.startsWith("-"))[1] : (repo ?? ctx.cwd);
    if (own(target)) {
      return null;
    }
  }
  return verdict;
}

function gitVerdict(sub, rest, flag) {
  switch (sub) {
    case "push":
      return hit("publish", "git push");
    case "send-email":
      return hit("send", "git send-email");
    case "clean":
      return flag(/^-[a-zA-Z]*f|^--force$/) ? hit("delete", "git clean -f") : null;
    case "reset":
      return flag(/^--hard$/) ? hit("delete", "git reset --hard") : null;
    case "checkout":
      // `git checkout -b x` and `git checkout <branch>` move HEAD; `--`, `.` or `-f` overwrite edits.
      return rest.includes("--") || rest.includes(".") || flag(/^(?:-f|--force)$/)
        ? hit("delete", "git checkout -- (overwrites edits)")
        : null;
    case "restore":
      // `git restore --staged x` only unstages; touching the working tree overwrites edits.
      return flag(/^(?:-S|--staged)$/) && !flag(/^(?:-W|--worktree)$/)
        ? null
        : hit("delete", "git restore (overwrites edits)");
    case "branch":
      return flag(/^-[a-zA-Z]*D/) || (flag(/^(?:-d|--delete)$/) && flag(/^(?:-f|--force)$/))
        ? hit("delete", "git branch -D")
        : null;
    case "stash":
      return /^(?:drop|clear)$/.test(rest[0] ?? "") ? hit("delete", `git stash ${rest[0]}`) : null;
    case "worktree":
      return rest[0] === "remove" && flag(/^(?:-f|--force)$/)
        ? hit("delete", "git worktree remove --force")
        : null;
    case "rm":
      return flag(/^-[a-zA-Z]*f|^--force$/) ? hit("delete", "git rm -f") : null;
    case "filter-branch":
    case "filter-repo":
      return hit("delete", `git ${sub}`);
    default:
      return null;
  }
}

const GH_WRITES = {
  pr: /^(?:create|merge|comment|close|edit|review|reopen|ready|lock)$/,
  issue: /^(?:create|comment|close|edit|reopen|delete|transfer|lock|pin)$/,
  release: /^(?:create|upload|edit|delete)$/,
  repo: /^(?:create|delete|edit|fork|rename|archive|sync)$/,
  gist: /^(?:create|edit|delete)$/,
  workflow: /^(?:run|enable|disable)$/,
  run: /^(?:rerun|cancel|delete)$/,
  secret: /^(?:set|delete)$/,
  variable: /^(?:set|delete)$/,
  label: /^(?:create|edit|delete|clone)$/,
};

function ghRule(args) {
  const [noun = "", verb = ""] = args;
  if (noun === "api") {
    const at = args.findIndex((a) => a === "-X" || a === "--method");
    const method = at >= 0 ? (args[at + 1] ?? "").toUpperCase() : "";
    const writesFields = args.some((a) => /^(?:-f|-F|--field|--raw-field|--input)$/.test(a));
    return /^(?:POST|PUT|PATCH|DELETE)$/.test(method) || (at < 0 && writesFields)
      ? hit("publish", `gh api ${method || "POST"}`)
      : null;
  }
  return GH_WRITES[noun]?.test(verb) ? hit("publish", `gh ${noun} ${verb}`) : null;
}

/** `openclaw message …` verbs that only read. */
const MESSAGE_CLI_READS =
  /^(?:read|search|list|info|status|pins|reactions|permissions|history|--help|-h)$/;
/** `openclaw gateway call <method>` methods that start a run or put text in front of a person. */
const GATEWAY_SEND_METHODS =
  /^(?:send|agent|chat\.send|chat\.inject|sessions\.send|sessions\.steer|message\.[\w.]+|tts\.[\w.]+|voice\.[\w.]+)$/;

function openclawRule(args) {
  const [a0 = "", a1 = ""] = args;
  if (a0 === "message" && !args.slice(1, 3).some((a) => MESSAGE_CLI_READS.test(a))) {
    return hit("send", `openclaw message ${a1}`.trim());
  }
  if (a0 === "agent" && args.some((a) => a === "--deliver" || a.startsWith("--deliver="))) {
    return hit("send", "openclaw agent --deliver");
  }
  if (a0 === "gateway" && /^(?:restart|stop|start|install|uninstall)$/.test(a1)) {
    return hit("restart", `openclaw gateway ${a1}`);
  }
  if (a0 === "gateway" && a1 === "call") {
    const method = args.slice(2).find((a) => !a.startsWith("-")) ?? "";
    if (/^cron\.(?:add|create|update|edit|enable|run)$/.test(method)) {
      return hit("spend", `gateway call ${method}`);
    }
    return GATEWAY_SEND_METHODS.test(method) ? hit("send", `gateway call ${method}`) : null;
  }
  if (a0 === "cron" && /^(?:add|create|edit|update|enable|run)$/.test(a1)) {
    return hit("spend", `openclaw cron ${a1}`);
  }
  return null;
}

/** Hosts that only take messages for people. */
const MESSAGING_HOSTS =
  /\b(?:hooks\.slack\.com|slack\.com\/api\/chat\.|api\.telegram\.org\/bot|discord(?:app)?\.com\/api\/webhooks|graph\.facebook\.com\/\S*\/messages|api\.twilio\.com|api\.sendgrid\.com|api\.mailgun\.net|outlook\.office\.com\/webhook)/i;

/** Signals that make a service reload or restart itself (the gateway restarts on SIGUSR1). */
const RELOAD_SIGNAL = /^-(?:s)?(?:1|HUP|USR1|USR2|SIGHUP|SIGUSR1|SIGUSR2)$/i;
/** What a pkill/killall aimed at the gateway or its workers names. */
const SERVICE_PROCESS = /openclaw|gateway|tinkerclaw-worker|^claude$|^node$/i;

/** The script an interpreter runs, or "" when it runs code from stdin, `-c` or `-e`. */
function scriptOf(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-" || /^-(?:c|e|p|n)$|^--(?:eval|print|check)$/.test(a)) {
      return "";
    }
    if (a === "-m") {
      return args[i + 1] ?? "";
    }
    if (!a.startsWith("-")) {
      return path.basename(a);
    }
  }
  return "";
}

/** The command an `ssh` line runs on the remote host, or "" for an interactive login. */
function sshRemoteCommand(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += /^-[BbcDEeFIiJLlmOoPpQRSWw]$/.test(args[i]) ? 2 : 1;
  }
  return args.slice(i + 1).join(" ");
}

/** One simple command's verdict, or null. */
function commandRule(words, ctx) {
  const { cmd, args } = commandOf(words);
  if (!cmd) {
    return null;
  }
  // An ssh remote command, a shell's -c script and an npx/pnpm exec call are read as commands too.
  if (cmd === "ssh") {
    const remote = sshRemoteCommand(args);
    return remote ? classifyCommand(remote, { remote: true }) : null;
  }
  if (SHELLS.has(cmd)) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c >= 0) {
      return args[c + 1] ? classifyCommand(args[c + 1], ctx) : null;
    }
  }
  if (cmd === "npx" || cmd === "bunx" || (cmd === "pnpm" && /^(?:exec|dlx)$/.test(args[0] ?? ""))) {
    const rest = cmd === "pnpm" ? args.slice(1) : args;
    return commandRule(
      rest.filter((a, j) => j > 0 || !a.startsWith("-")),
      ctx,
    );
  }

  const del = deleteRule(cmd, args, ctx);
  if (del) {
    return del;
  }
  if (cmd === "git") {
    return gitRule(args, ctx);
  }
  if (cmd === "gh") {
    return ghRule(args);
  }
  if (cmd === "openclaw") {
    return openclawRule(args);
  }
  if (/^(?:npm|pnpm|yarn|bun)$/.test(cmd) && args[0] === "publish") {
    return hit("publish", `${cmd} publish`);
  }
  if (cmd === "clawhub" && /^(?:publish|delete|hide|unhide|transfer|sync)$/.test(args[0] ?? "")) {
    return hit("publish", `clawhub ${args[0]}`);
  }
  if (cmd === "wp" && args[0] === "post" && /^(?:create|update|delete)$/.test(args[1] ?? "")) {
    return hit("publish", `wp post ${args[1]}`);
  }
  if (cmd === "systemctl") {
    const verb = args.find((a) => !a.startsWith("-")) ?? "";
    if (
      /^(?:restart|stop|kill|reload|try-restart|reload-or-restart|isolate|poweroff|reboot|halt|suspend|hibernate|mask|disable)$/.test(
        verb,
      )
    ) {
      return hit("restart", `systemctl ${verb}`);
    }
    return verb === "enable" ? hit("spend", "systemctl enable") : null;
  }
  if (/^(?:reboot|shutdown|poweroff|halt)$/.test(cmd)) {
    return hit("restart", cmd);
  }
  if (cmd === "kill") {
    const s = args.indexOf("-s");
    const signal = s >= 0 ? `-${args[s + 1] ?? ""}` : (args.find((a) => a.startsWith("-")) ?? "");
    return RELOAD_SIGNAL.test(signal) ? hit("restart", `kill ${signal}`) : null;
  }
  if (cmd === "pkill" || cmd === "killall") {
    return args.some((a) => !a.startsWith("-") && SERVICE_PROCESS.test(a))
      ? hit("restart", cmd)
      : null;
  }
  if (cmd === "docker" && /^(?:restart|stop|kill)$/.test(args[0] ?? "")) {
    return hit("restart", `docker ${args[0]}`);
  }
  if (cmd === "crontab" && !args.includes("-l")) {
    return hit("spend", "crontab");
  }
  if (cmd === "systemd-run" && args.some((a) => a.startsWith("--on-calendar"))) {
    return hit("spend", "systemd-run --on-calendar");
  }
  if (/^(?:jarvis|jarvis-call|sendmail|mail|mailx|mutt|msmtp|swaks)$/.test(cmd)) {
    // `jarvis --out f.wav` renders to a file and speaks to nobody.
    return cmd === "jarvis" && args.includes("--out") ? null : hit("send", cmd);
  }
  if (
    /^(?:wacli|gog|himalaya)$/.test(cmd) &&
    args.some((a) => /^(?:send|reply|forward)$/.test(a))
  ) {
    return hit("send", `${cmd} send`);
  }
  if (/^(?:curl|wget|http|https|xh)$/.test(cmd) && args.some((a) => MESSAGING_HOSTS.test(a))) {
    return hit("send", `${cmd} to a messaging API`);
  }
  // A script named for what it does: chat-send.mjs, wa-send.py, pack-publish.sh, clawhub-publish.mjs.
  const interpreted = /^(?:node|python3?|bun|deno|tsx|bash|sh|zsh|perl|ruby)$/.test(cmd)
    ? scriptOf(args)
    : "";
  for (const name of [cmd, interpreted]) {
    if (/(?:^|[-_.])send(?:[-_.]|$)/i.test(name)) {
      return hit("send", name);
    }
    if (/(?:^|[-_.])publish(?:[-_.]|$)/i.test(name)) {
      return hit("publish", name);
    }
  }
  return null;
}

/**
 * The first send / delete / publish / spend / restart in a shell command line, or null. `base` is where it runs
 * (`cwd`), when the worker started (`since`), and `remote` for a command ssh runs on another host.
 */
export function classifyCommand(command, base = {}) {
  const ctx = newContext(base);
  noteMktempVars(command, ctx);
  for (const seg of segments(command)) {
    const words = shellWords(seg);
    const r = commandRule(words, ctx);
    if (r) {
      return r;
    }
    track(words, ctx);
  }
  return null;
}

// ─── tools ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Gateway tools (as `mcp__<server>__<name>` in Claude Code) that put something in front of a person. */
const SEND_TOOLS = new Set(["message", "tts", "voice_call", "sessions_send", "sessions_steer"]);
/** Gateway tools that cost money per call. */
const SPEND_TOOLS = new Set(["image_generate", "video_generate", "music_generate"]);
/** The `message` tool's actions that only read (src/channels/plugins/message-action-names.ts). */
const MESSAGE_READ_ACTIONS =
  /^(?:read|reactions|search|list-pins|permissions|thread-list|sticker-search|member-info|role-info|emoji-list|channel-info|channel-list|voice-status|event-list|download-file)$/;

/**
 * What a tool call would do, as one of send / delete / publish / spend / restart, or null when it is none of them.
 * `toolInput` is the call's input as Claude Code hands it to the hook; `base` as for classifyCommand.
 */
export function classifyFractalCall(toolName, toolInput, base = {}) {
  const name = String(toolName ?? "");
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  if (name === "Bash" || name === "Monitor") {
    return typeof input.command === "string" ? classifyCommand(input.command, base) : null;
  }
  const leaf = name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  if (SEND_TOOLS.has(leaf)) {
    const action = typeof input.action === "string" ? input.action : "";
    return leaf === "message" && MESSAGE_READ_ACTIONS.test(action) ? null : hit("send", leaf);
  }
  if (/^send_|_send$/.test(leaf)) {
    return hit("send", leaf);
  }
  if (SPEND_TOOLS.has(leaf)) {
    return hit("spend", leaf);
  }
  if (leaf === "cron") {
    const action = typeof input.action === "string" ? input.action : "";
    return /^(?:list|status|runs|get)$/i.test(action) ? null : hit("spend", "cron");
  }
  return null;
}

// ─── the hook ───────────────────────────────────────────────────────────────────────────────────────────────────────

const VERBS = {
  send: "sends something to a person",
  delete: "deletes data",
  publish: "publishes",
  spend: "spends money or installs recurring work",
  restart: "stops or restarts a service",
};

/** What the model reads when a call is denied: write the call as a proposal, do not look for another way. */
export function denyReason(verdict) {
  return (
    `Fractal guard: this call ${VERBS[verdict.kind]} (${verdict.match}). A background Fractal reflection never sends, ` +
    "deletes, publishes, spends or restarts on its own: it proposes. Do not retry it another way. Put the exact command " +
    "in your 🌿 FRACTAL text on a line that starts with `Proposed:`, with one line on why, and the owner runs it if he " +
    "agrees. Still yours: your own scratch (/tmp, mktemp, files you made this turn, symlinks), `trash`, " +
    "`git branch -d`, `git worktree remove` without --force, and the gateway-restart and tinker-rebuild skills."
  );
}

function logMatch(row, toolUseId) {
  // The plugin can be loaded twice in one session (marketplace and --plugin-dir): one row per tool call.
  if (toolUseId && !claim("fractal-guard", toolUseId, "pre", 1)) {
    return;
  }
  try {
    const dir = path.join(stateDir(), "data", "fractal");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "guard.jsonl"), `${JSON.stringify(row)}\n`);
  } catch {
    // A lost row costs the row, never the decision.
  }
}

function main() {
  const mode = process.env.TC_FRACTAL_GUARD?.trim();
  if (!FRACTAL_GUARD_MODES.includes(mode)) {
    return;
  }
  const payload = readStdin();
  const since = Number(process.env.TC_FRACTAL_GUARD_SINCE);
  const verdict = classifyFractalCall(payload.tool_name, payload.tool_input, {
    cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : undefined,
    since: Number.isFinite(since) && since > 0 ? since : undefined,
  });
  if (!verdict) {
    return;
  }
  const decision = mode === "enforce" ? "deny" : "would-deny";
  logMatch(
    {
      v: 1,
      ts: new Date().toISOString(),
      mode,
      decision,
      kind: verdict.kind,
      tool: String(payload.tool_name ?? ""),
      match: verdict.match,
      sessionKey: process.env.TC_SESSION_KEY ?? "",
    },
    typeof payload.tool_use_id === "string" ? payload.tool_use_id : "",
  );
  if (decision === "deny") {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: denyReason(verdict),
        },
      })}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    // Fail open: a guard bug must never stop a tool call.
  }
}
