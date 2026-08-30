#!/usr/bin/env node
/**
 * NO INTERPOLATED SHELL STRINGS — the mechanical half of the Orca incident's remediation.
 *
 * THE RULE, from J9 (AEGIS) note 8's standing recommendation for the paper's Appendix A:
 *
 *   > In any agent harness, no string derived from model output or from an inferred type may
 *   > reach exec/system/a shell string. Argv arrays only.
 *
 * That rule is auditable, so it belongs in a script rather than in prose — FOUNDATION.md, "Three
 * different jobs, three different homes": the papers and the bible EXPLAIN, running code ENFORCES,
 * and scripts/ CHECKS. (J9 note 9 cites that same split as the resolution of a separate incident,
 * which is a decent sign it is the right shape.)
 *
 * WHAT IT COST TO LEARN. On 2026-08-05 at 05:23:32, and again at 05:28:31, arbitrary code ran on
 * the host with full agent privileges. The process launched was /usr/bin/orca — the GNOME screen
 * reader — which began reading the screen aloud to a sleeping user. No adversary, no malicious
 * input, no compromised dependency. `git-cache.ts` interpolated an action's "target" into
 *
 *     git -C "${escapedDir}" log --since="${hours} hours ago" --format="%an" -- "${escapedFile}"
 *
 * and ran it through /bin/sh -c, escaping only double quotes. The target was not a path at all —
 * it was a command string that `classifyTargetType()` had guessed was a file because it contained
 * a ".". The text being processed was documentation warning that bare `orca` launches the screen
 * reader. The sentence describing the hazard executed the hazard, and investigating the first
 * firing caused the second.
 *
 * WHY A SCRIPT AND NOT A CODE REVIEW. Zero controls fired during the incident — no alert, no audit
 * entry, no anomaly flag. It was caught because the architect heard his speakers. A control that
 * only watches the agent's INPUTS cannot see the agent's PLUMBING, so the check has to live where
 * the plumbing is written.
 *
 * ── WHAT IT MATCHES, and why the obvious regex is wrong ──────────────────────────────────────
 * A naive `grep 'exec(`...${'` returns 12 hits in this repo and ALL TWELVE ARE FALSE POSITIVES:
 * they are `db.exec()` — SQLite DDL, no shell involved. A check that cries wolf twelve times gets
 * switched off, so this resolves the binding instead of pattern-matching the call:
 *
 *   1. find what the file imports from node:child_process, honouring aliases
 *      (`import { exec as execCb }` — the exact form the vulnerable file used);
 *   2. follow one hop through promisify: `const execAsync = promisify(execCb)`, which is how the
 *      dangerous name reached the call site three identifiers away from its import;
 *   3. flag only calls to those resolved names whose FIRST argument is a template literal
 *      containing an interpolation.
 *
 * A template literal with no `${` is a constant command and cannot carry injected data, so it is
 * allowed. `execFile`/`execFileSync`/`spawn` take an argv array and are never flagged — moving to
 * them is the fix this check exists to push you toward.
 *
 * Usage:
 *   node scripts/check-shell-interpolation.mjs           # enforce (exit 1 above the cap)
 *   node scripts/check-shell-interpolation.mjs --list    # show every site, never fails
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * RATCHET. Zero, and it may never rise. Unlike the other ratchets in this repo this one starts AT
 * its target, because the population was exactly one site and that site is now fixed — there is no
 * backlog to amortise, so there is no reason to allow a second.
 */
export const SHELL_INTERPOLATION_CAP = 0;

const SEARCH_DIRS = ["src", "extensions", "tinker-ui/src", "scripts"];
const PRUNE = new Set(["node_modules", "dist", "dist-runtime", "build", ".git", "coverage"]);
/** Shell-executing entry points. execFile/spawn take argv arrays and are the sanctioned fix. */
const SHELL_FNS = new Set(["exec", "execSync"]);

function collectTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) collectTs(path.join(dir, e.name), out);
    } else if (e.isFile() && /\.(ts|mjs|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/**
 * Local identifiers in `text` that ultimately execute a shell.
 * Returns the resolved set, e.g. {"execCb", "execAsync"} for the vulnerable file's shape.
 */
export function resolveShellBindings(text) {
  const names = new Set();

  // import { exec, execSync as x } from "node:child_process"  /  from "child_process"
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
  let m;
  while ((m = importRe.exec(text)) !== null) {
    for (const spec of m[1].split(",")) {
      const parts = spec.trim().split(/\s+as\s+/);
      const imported = parts[0]?.trim();
      const local = (parts[1] ?? parts[0])?.trim();
      if (imported && local && SHELL_FNS.has(imported)) names.add(local);
    }
  }
  // const { exec } = require("child_process")
  const requireRe =
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["'](?:node:)?child_process["']\s*\)/g;
  while ((m = requireRe.exec(text)) !== null) {
    for (const spec of m[1].split(",")) {
      const parts = spec.trim().split(/\s*:\s*/);
      const imported = parts[0]?.trim();
      const local = (parts[1] ?? parts[0])?.trim();
      if (imported && local && SHELL_FNS.has(imported)) names.add(local);
    }
  }

  // One promisify hop: const execAsync = promisify(execCb). This is the step that put three
  // identifiers between `import { exec }` and the call that launched a screen reader.
  if (names.size > 0) {
    const promisifyRe =
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*promisify\(\s*([\w$.]+)\s*\)/g;
    while ((m = promisifyRe.exec(text)) !== null) {
      if (names.has(m[2])) names.add(m[1]);
    }
  }
  return names;
}

/** Call sites of `names` whose first argument is an interpolating template literal. */
export function findInterpolatedCalls(text, names) {
  const hits = [];
  if (names.size === 0) return hits;
  for (const name of names) {
    // name(  `... ${ ...    — the backtick must be the first argument.
    const re = new RegExp(
      String.raw`\b${name.replace(/\$/g, "\\$")}\s*\(\s*` + "`" + `[^\`]*\\$\\{`,
      "g",
    );
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split("\n").length;
      hits.push({ name, line });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Blank out comments, preserving line numbers so reported lines stay true.
 *
 * NOT optional. On its FIRST run this check flagged ITSELF — the block comment above quotes the
 * vulnerable command string as evidence, and the matcher read its own documentation as an
 * occurrence. The fork's bug log already names that class: `[mention-treated-as-use]`, a string
 * ABOUT an action treated as the action. It is the same confusion as the Orca incident itself,
 * where a sentence describing a hazard executed it, and as `fs-dd-guard-flags-the-null-sink`,
 * where a guard blocked the bug report that quoted the command it blocks.
 *
 * Three instances, three tools, one shape — including this one, written specifically to prevent
 * the shape. Naming a failure class does not immunise you against committing it, so the defence
 * has to be mechanical: a checker must never be able to punish the comment that documents the
 * thing it checks for, or the only way to keep it green is to stop explaining the danger.
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

export function scan() {
  const findings = [];
  const self = path.join(repoRoot, "scripts", "check-shell-interpolation.mjs");
  for (const d of SEARCH_DIRS) {
    for (const file of collectTs(path.join(repoRoot, d))) {
      if (/\.test\.|\.spec\.|__tests__/.test(file)) continue;
      if (file === self) continue;
      let raw;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!raw.includes("child_process")) continue;
      const text = stripComments(raw);
      const names = resolveShellBindings(text);
      for (const hit of findInterpolatedCalls(text, names)) {
        findings.push({ file: path.relative(repoRoot, file), ...hit });
      }
    }
  }
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  const findings = scan();

  if (argv.includes("--list") || findings.length > 0) {
    for (const f of findings) {
      console.log(`  ${f.file}:${f.line}  ${f.name}(\`…\${…}\`)`);
    }
  }
  console.log(
    `shell interpolation: ${findings.length} site(s) / cap ${SHELL_INTERPOLATION_CAP} — ` +
      `a shell-executing call whose command is built by interpolation`,
  );

  if (findings.length > SHELL_INTERPOLATION_CAP) {
    console.error(
      `\nFAIL: a command string is being built by interpolation and handed to a shell.\n` +
        `This is the defect that ran /usr/bin/orca on the host on 2026-08-05 with full agent\n` +
        `privileges, from the agent's OWN documentation, with no adversary involved.\n\n` +
        `Fix: use execFile/execFileSync/spawn with an ARGV ARRAY. Arguments then carry no shell\n` +
        `meaning, so backticks and $(…) in a filename are inert data instead of code.\n` +
        `Escaping is NOT a fix — the vulnerable site escaped double quotes and was still exploited\n` +
        `through backticks. Raising this cap is not a fix either.`,
    );
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
