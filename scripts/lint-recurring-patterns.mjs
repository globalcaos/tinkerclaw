#!/usr/bin/env node
/**
 * FORK 2026-05-12 — bug-pattern linter.
 *
 * Today's bug-log.md taxonomy (39 entries, 18 failure classes) shows that
 * the same 3–4 mistakes keep coming back. This linter catches the first
 * recurring class — `ui-state-clear` — by recognizing the code-shape:
 *
 *   File-watcher handler unconditionally clears UI error state without
 *   preserving billing/auth-permanent errors.
 *
 * That shape produced ≥7 bug-log entries before someone added a
 * preservation list. This rule refuses any new file-watcher handler
 * that clears `providerErrors` without an explicit preserve-condition.
 *
 * Scope: scans `tinker-ui/src/` and `src/` (TypeScript files only).
 * Skips files inside dist/, node_modules/, .test.ts files. Outputs
 * findings as JSON when --json passed, otherwise human-readable.
 *
 * Wired into `git-hooks/pre-push` as a third gate (after PII + bible).
 *
 * Adding a new rule: append to RULES below. Each rule is a function
 * (filePath, text) → array of {line, message}.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(os.homedir(), "src/tinkerclaw");
const SCAN_DIRS = [path.join(REPO, "tinker-ui/src"), path.join(REPO, "src")];
const SKIP_PATTERNS = [/\/dist\//, /\/node_modules\//, /\.test\.ts$/, /\.test\.mjs$/];
const FILE_EXTS = new Set([".ts", ".tsx", ".mjs", ".js"]);

/**
 * Rule R1: ui-state-clear — `providerErrors = {}` (or `.clear()`) without a
 * comment or guard that preserves "billing"/"auth_permanent" entries.
 *
 * Catches the pattern:
 *   state.providerErrors = {};               // BAD — wipes billing badges
 *   state.providerErrors.clear();            // BAD — same
 *
 * Allows the pattern:
 *   Object.entries(state.providerErrors).filter(([_, e]) => e.kind === "billing")
 *   // preserve billing                       // (comment-marked exception)
 *
 * Heuristic: look for `providerErrors\s*=\s*\{\s*\}` or `providerErrors\.clear\(\)`
 * within 200 chars of `auth.profiles.updated` or `auth\.refresh|file.watch`
 * and NO mention of `billing` or `auth_permanent` in the same function body
 * (approximated as ±30 lines).
 */
function ruleUiStateClear(filePath, text) {
  const findings = [];
  const lines = text.split("\n");
  const indicators = /providerErrors\s*=\s*\{\s*\}|providerErrors\.clear\(\)/;
  const watcherContext = /auth\.profiles\.updated|file[Ww]atch|watch[A-Z]|onFileChange/;
  const preserveContext = /billing|auth_permanent|preserve/;
  for (let i = 0; i < lines.length; i += 1) {
    if (!indicators.test(lines[i])) continue;
    // Window: 30 lines before and after.
    const start = Math.max(0, i - 30);
    const end = Math.min(lines.length, i + 30);
    const window = lines.slice(start, end).join("\n");
    if (!watcherContext.test(window)) continue;
    if (preserveContext.test(window)) continue;
    findings.push({
      rule: "ui-state-clear",
      line: i + 1,
      message:
        "providerErrors cleared inside a file-watcher / auth-profile-updated context without preserving billing/auth_permanent entries — see bug-log.md ui-state-clear ×7",
      snippet: lines[i].trim().slice(0, 160),
    });
  }
  return findings;
}

const RULES = [{ id: "ui-state-clear", fn: ruleUiStateClear }];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (SKIP_PATTERNS.some((p) => p.test(full))) continue;
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (FILE_EXTS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

async function fileChangedSinceMerge(filePath) {
  // No-op stub for now — could be wired to `git diff` later to limit scans
  // to recently-changed files. The full scan is fast (<2s on this codebase).
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes("--json");
  const isChangedOnly = args.includes("--changed");
  const findings = [];
  let scanned = 0;
  for (const dir of SCAN_DIRS) {
    for await (const file of walk(dir)) {
      if (isChangedOnly && !(await fileChangedSinceMerge(file))) continue;
      scanned += 1;
      try {
        const text = await readFile(file, "utf8");
        for (const rule of RULES) {
          const ruleFindings = rule.fn(file, text);
          for (const f of ruleFindings) {
            findings.push({ ...f, file: path.relative(REPO, file) });
          }
        }
      } catch {
        // unreadable file (broken symlink, binary) — skip
      }
    }
  }
  if (isJson) {
    process.stdout.write(JSON.stringify({ scanned, findings }, null, 2));
    process.stdout.write("\n");
    process.exit(findings.length > 0 ? 1 : 0);
  }
  if (findings.length === 0) {
    console.log(`[lint-recurring-patterns] ${scanned} files scanned — no recurring-pattern hits.`);
    process.exit(0);
  }
  console.error("");
  console.error("━".repeat(70));
  console.error(`🛑 ${findings.length} recurring-pattern hit(s) across ${scanned} files`);
  console.error("━".repeat(70));
  for (const f of findings) {
    console.error("");
    console.error(`  [${f.rule}] ${f.file}:${f.line}`);
    console.error(`  → ${f.message}`);
    console.error(`  | ${f.snippet}`);
  }
  console.error("");
  console.error(
    "These shapes have caused real bugs before — see TINKER_UI_DESIGN_BIBLE/bug-log.md taxonomy.",
  );
  console.error(
    "Bypass: PATTERN_LINT=off (only if the diff is intentional and you've added a `preserve` comment).",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`[lint-recurring-patterns] internal error: ${String(err)}`);
  process.exit(2);
});
