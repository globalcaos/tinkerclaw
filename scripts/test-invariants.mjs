#!/usr/bin/env node
/**
 * FORK 2026-05-11 — pnpm test:invariants
 *
 * The J15 §5 merge gate runner. Walks TINKER_UI_DESIGN_BIBLE/*.md,
 * parses each file's YAML frontmatter, and runs every `verify` entry.
 * A `verify` entry is either:
 *
 *   verify:
 *     - cmd: <shell command>     # exit 0 == pass
 *     - name: <optional label>
 *       cmd: <shell command>     # exit 0 == pass
 *
 * Exits 0 if every `verify.cmd` from every section exits 0. Exits 1
 * if any check fails. Prints a per-file summary plus the failing
 * commands' stderr so a human (or CI) can act on the report.
 *
 * Today: invoked manually (`pnpm test:invariants`). Wired into the
 * upstream-merge cron once `daily-fork-sync` is re-enabled per J15 §5.
 *
 * Implementation notes:
 *   - Frontmatter parser is hand-rolled (a tiny YAML subset). We avoid
 *     pulling in `js-yaml` to keep the runner free of build-time deps.
 *     Supported shapes: scalar `key: value` and a single `verify:`
 *     array of `- cmd:` (with optional `name:`) entries.
 *   - Bash shell is invoked with -lc so PATH, aliases, and shell
 *     functions (e.g. `openclaw`) resolve as the user expects.
 *   - Each verify gets a 30s wall-clock timeout. The runner kills the
 *     shell on timeout and reports it as a fail.
 *   - Standard exit codes: 0 = all pass, 1 = at least one fail,
 *     2 = runner internal error (bible folder missing, parse error, etc.).
 */
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const BIBLE_DIR = path.resolve(os.homedir(), "src/tinkerclaw/TINKER_UI_DESIGN_BIBLE");

const TIMEOUT_MS = 30_000;

function colour(s, code) {
  if (!process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const GREEN = (s) => colour(s, "32");
const RED = (s) => colour(s, "31");
const DIM = (s) => colour(s, "2");
const BOLD = (s) => colour(s, "1");

/**
 * Parse the YAML frontmatter block of a markdown file. Returns:
 *   { metadata: { ...scalars }, verify: [{name?, cmd}, ...] }
 * Supports only the subset we actually use in the bible files.
 */
function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) {
    return { metadata: {}, verify: [] };
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { metadata: {}, verify: [] };
  const block = text.slice(4, end);
  const lines = block.split("\n");
  const metadata = {};
  const verify = [];
  let inVerify = false;
  let currentEntry = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inVerify) {
      if (/^verify:\s*$/.test(line)) {
        inVerify = true;
        continue;
      }
      const m = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
      if (m) {
        metadata[m[1]] = m[2].trim();
      }
    } else {
      // Inside verify array
      const itemStart = /^\s*-\s+(name|cmd):\s*(.*)$/.exec(line);
      if (itemStart) {
        if (currentEntry) verify.push(currentEntry);
        currentEntry = {};
        const key = itemStart[1];
        let value = itemStart[2];
        // Support |-multiline (folded form not supported)
        if (value === "|") {
          // Collect indented continuation lines as a single string
          const continuationLines = [];
          let j = i + 1;
          while (j < lines.length && (lines[j].startsWith("      ") || lines[j].startsWith("\t"))) {
            continuationLines.push(lines[j].replace(/^(?:      |\t)/, ""));
            j++;
          }
          value = continuationLines.join("\n");
          i = j - 1;
        } else {
          value = stripQuotes(value);
        }
        currentEntry[key] = value;
      } else {
        const sub = /^\s+(name|cmd):\s*(.*)$/.exec(line);
        if (sub && currentEntry) {
          const key = sub[1];
          let value = sub[2];
          if (value === "|") {
            const continuationLines = [];
            let j = i + 1;
            while (
              j < lines.length &&
              (lines[j].startsWith("      ") || lines[j].startsWith("\t"))
            ) {
              continuationLines.push(lines[j].replace(/^(?:      |\t)/, ""));
              j++;
            }
            value = continuationLines.join("\n");
            i = j - 1;
          } else {
            value = stripQuotes(value);
          }
          currentEntry[key] = value;
        } else if (/^\S/.test(line)) {
          // dedent → leave verify block
          inVerify = false;
          if (currentEntry) {
            verify.push(currentEntry);
            currentEntry = null;
          }
          const m = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
          if (m) {
            metadata[m[1]] = m[2].trim();
          }
        }
      }
    }
  }
  if (currentEntry) verify.push(currentEntry);
  return { metadata, verify };
}

function stripQuotes(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function runShell(cmd) {
  return new Promise((resolve) => {
    // Prepend system bin dirs to PATH so `/usr/local/bin/openclaw` and
    // `/usr/bin/jq` resolve even when this script is invoked through
    // `pnpm` (which puts `./node_modules/.bin/openclaw` — a different
    // local stub — first on the PATH).
    const systemPath = "/usr/local/bin:/usr/bin:/bin";
    const env = { ...process.env };
    const existing = env.PATH ?? "";
    env.PATH = existing ? `${systemPath}:${existing}` : systemPath;
    const child = spawn("bash", ["-lc", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 8000) stdout = stdout.slice(-8000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: String(err),
      });
    });
  });
}

async function main() {
  let files;
  try {
    files = (await readdir(BIBLE_DIR)).filter((name) => name.endsWith(".md")).sort();
  } catch (err) {
    console.error(`[test-invariants] cannot read ${BIBLE_DIR}: ${String(err)}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`[test-invariants] no .md files in ${BIBLE_DIR}`);
    process.exit(2);
  }

  let totalChecks = 0;
  let totalFailed = 0;
  const fileSummaries = [];

  console.log(BOLD(`\nJ15 invariant suite — ${files.length} bible files`));
  console.log(DIM(`  bible: ${BIBLE_DIR}`));
  console.log("");

  for (const file of files) {
    const filePath = path.join(BIBLE_DIR, file);
    const text = await readFile(filePath, "utf8");
    const { metadata, verify } = parseFrontmatter(text);
    if (verify.length === 0) {
      fileSummaries.push({ file, checks: 0, passed: 0, failed: 0, skipped: true });
      console.log(DIM(`  ${file}: no verify block (skipped)`));
      continue;
    }
    const fileResults = [];
    for (let i = 0; i < verify.length; i++) {
      const entry = verify[i];
      const name = entry.name ?? `verify[${i}]`;
      const cmd = entry.cmd;
      if (!cmd) {
        fileResults.push({ name, ok: false, reason: "missing cmd" });
        continue;
      }
      totalChecks += 1;
      // Probes that hit the live gateway can flake under load (cron.listJobs
      // can sequentially-stat many receipt files, debug.dumpUiSnapshot waits
      // on a UI subscription). One automatic retry with a short backoff
      // turns transient warm-up failures into pass without masking real
      // regressions — a real break stays broken after the second attempt.
      let result = await runShell(cmd);
      let ok = !result.timedOut && result.exitCode === 0;
      let attempts = 1;
      if (!ok) {
        await new Promise((r) => setTimeout(r, 2000));
        result = await runShell(cmd);
        ok = !result.timedOut && result.exitCode === 0;
        attempts = 2;
      }
      if (!ok) totalFailed += 1;
      fileResults.push({
        name,
        ok,
        attempts,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stderr: result.stderr,
        stdout: result.stdout.slice(0, 400),
      });
    }
    const passed = fileResults.filter((r) => r.ok).length;
    const failed = fileResults.length - passed;
    fileSummaries.push({
      file,
      checks: fileResults.length,
      passed,
      failed,
      skipped: false,
      results: fileResults,
      metadata,
    });
    const tag = failed === 0 ? GREEN("PASS") : RED("FAIL");
    console.log(`  ${tag} ${file} (${passed}/${fileResults.length})`);
    if (failed > 0) {
      for (const r of fileResults) {
        if (r.ok) continue;
        console.log(
          RED(`      ✗ ${r.name}`) +
            DIM(
              ` exit=${r.exitCode}${r.timedOut ? " (timeout)" : ""}${r.signal ? ` signal=${r.signal}` : ""}`,
            ),
        );
        if (r.stderr) {
          for (const line of r.stderr.trim().split("\n").slice(0, 6)) {
            console.log(DIM(`        ${line}`));
          }
        }
        if (r.stdout && !r.stderr) {
          for (const line of r.stdout.trim().split("\n").slice(0, 6)) {
            console.log(DIM(`        ${line}`));
          }
        }
      }
    }
  }

  console.log("");
  console.log(
    BOLD(
      `Summary: ${totalChecks - totalFailed}/${totalChecks} checks passed` +
        (totalFailed > 0 ? RED(`, ${totalFailed} failed`) : ""),
    ),
  );
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[test-invariants] internal error: ${String(err)}`);
  process.exit(2);
});
