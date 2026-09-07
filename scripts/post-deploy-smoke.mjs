#!/usr/bin/env node
/**
 * POST-DEPLOY SMOKE — six read-only checks that prove, in seconds, that the paths we just
 * fixed are alive on the RUNNING system.
 *
 * Usage:
 *   node scripts/post-deploy-smoke.mjs [--expect-sha <sha>] [--json]
 *
 * Exit 0 when nothing FAILed (WARNs are allowed and are printed loudly). Exit 1 on any FAIL.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────
 * Five defects were fixed on 2026-08-03. Not one of them was caught by a test, a gate, or a
 * monitor: every one was caught by a human eventually reading a number that could not be
 * true. They share one shape, the shape this codebase keeps re-learning:
 *
 *   1. 18 crons fired on schedule and did nothing — each run recorded
 *      `status:"skipped" error:"disabled"`, took ~10ms, exited clean. Four days, no alarm.
 *   2. ENGRAM sleep consolidation defaulted to the store `events/live.jsonl`, which has
 *      never existed. readAll() on a missing file returns [], so it truthfully reported
 *      "0 episodes / 0 events" for 83 consecutive nights while 575 real stores sat in the
 *      same directory.
 *   3. The instrument-liveness registry — written precisely to catch components that are
 *      registered but never run — shipped with no caller for its own report.
 *
 * Every one of those is the same bug: A CHECK THAT SAW NOTHING AND REPORTED SUCCESS. So the
 * contract here is the inverse, and it is the only rule this file really has:
 *
 *   EVERY CHECK PRINTS WHAT IT SAW, NOT JUST A VERDICT.
 *
 * A check that cannot see its evidence must say so out loud (WARN or FAIL). "No data" is
 * never rendered as PASS, and a verdict never asserts a cause the check did not observe.
 * That is why the output is verbose for a smoke test: the verdict is the cheap part, the
 * evidence is the part that would have caught all three bugs above.
 *
 * ── READ-ONLY, BY CONSTRUCTION ────────────────────────────────────────────────────────
 * Nothing here writes to ~/.openclaw, restarts anything, or issues a POST. The only network
 * call is an unauthenticated GET /health. The only subprocesses are `journalctl` and
 * `systemctl show` — both read-only. Instrument liveness has no machine-readable surface
 * yet: `reportInstrumentLiveness` in src/infra/instrument-liveness.ts has exactly one
 * consumer, `logInstrumentLivenessSummary`, which logs. If an RPC ever returns those rows,
 * prefer it and delete the journal grep.
 *
 * ── THE VERDICT LADDER ────────────────────────────────────────────────────────────────
 *   FAIL  a thing we fixed is provably broken again, OR the check could not see its
 *         evidence at all (blindness is a failure, not a pass).
 *   WARN  a real observation that is not, on its own, a deploy blocker — never-fired
 *         instruments (known and tracked), stale metrics, or evidence that PRE-DATES the
 *         running build and therefore cannot prove anything about it.
 *   PASS  the check saw current evidence and it was good.
 *
 * ── WHAT "DEPLOYED" MEANS HERE (earned the hard way) ──────────────────────────────────
 * `dist/build-info.json` proves what was BUILT. It does not prove what is RUNNING: `pnpm
 * build` without a restart leaves the old process serving while builtAt jumps to now. There
 * is no runtime commit surface to correlate against — /health returns only
 * {"ok":true,"status":"live"} and the gateway logs no startup commit — so check 2 uses the
 * PROCESS START TIME instead (systemd MainPID -> /proc/<pid> mtime, verified equal to
 * ActiveEnterTimestamp). A process that started BEFORE the artifact was built is not serving
 * it, and that is a FAIL: it is the single most common way a "deployed" fix isn't.
 *
 * That same instant is the boundary check 3 uses to tell evidence apart. A cron receipt
 * written before the running process started is the OLD binary's output and can say nothing
 * about the fix — FAILing on it would red-alarm every deploy until the next cron tick, and a
 * check that cries wolf gets ignored, which is this disease with better manners. So
 * pre-boundary evidence is a WARN labelled UNPROVEN. Post-boundary evidence with the bug
 * signature is an unambiguous FAIL. And when the boundary CANNOT be established, there is no
 * grace at all — the pre-deploy WARN is an exception that requires knowing the deploy
 * instant, so without it the signature FAILs. Fail closed; never manufacture an alibi.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const USAGE = `post-deploy smoke — prove the just-deployed paths are alive on the running system

Usage: node scripts/post-deploy-smoke.mjs [options]

Options:
  --expect-sha <sha>            FAIL unless dist/build-info.json commit matches (>=7 hex chars).
  --json                        Machine-readable report on stdout, nothing else.
  --gateway <url>               Gateway base URL (default: http://127.0.0.1:18789).
  --repo <dir>                  Repo root holding dist/ (default: this script's parent).
  --openclaw-dir <dir>          OpenClaw state dir (default: $HOME/.openclaw).
  --unit <name>                 systemd --user unit, used for the process-start boundary and
                                the journal grep (default: openclaw-gateway.service).
  --cron-window-hours <n>       Recency window for "did anything run lately" (default: 48).
                                It does NOT gate the skipped/disabled signature: a job whose
                                newest receipt carries it is judged whatever its age.
  --strict-cron                 FAIL on skipped/disabled even when the receipt pre-dates the
                                running build (default: that case is WARN/UNPROVEN).
  --metrics-max-age-hours <n>   Per-algorithm metrics freshness window (default: 24).
  --self-test                   Run the pure-helper assertions and exit. Touches nothing.
  -h, --help                    Show this help.

Exit 0 when no check FAILed (WARNs still print). Exit 1 on any FAIL, and on bad arguments.
`;

const GATEWAY_TIMEOUT_MS = 4000;
const JOURNAL_TIMEOUT_MS = 12_000;
const SYSTEMCTL_TIMEOUT_MS = 5000;
const CRON_TAIL_BYTES = 1024 * 1024;
const METRICS_TAIL_BYTES = 512 * 1024;
const DIST_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_ROWS = 40;
const LIVENESS_REPORT_SYMBOL = "logInstrumentLivenessSummary";

// ── pure helpers (every one of them exercised by --self-test) ──────────────────────────

/** Human age. Negative = clock skew or a future timestamp; say so rather than hide it. */
export function fmtAge(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 0) return `${fmtAge(-ms)} IN THE FUTURE`;
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/**
 * Compare a deployed commit against an expected one. Prefix matching in EITHER direction so a
 * short SHA works, but never below 7 chars: a 3-char "prefix" matches ~1 commit in 4096, which
 * is a check that passes while seeing nothing.
 */
export function matchSha(actual, expected) {
  const a = String(actual ?? "")
    .trim()
    .toLowerCase();
  const e = String(expected ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]+$/.test(e)) return { ok: false, reason: "expected-not-a-sha" };
  if (e.length < 7) return { ok: false, reason: "expected-too-short" };
  if (!/^[0-9a-f]{7,40}$/.test(a)) return { ok: false, reason: "deployed-sha-malformed" };
  const ok = a.startsWith(e) || e.startsWith(a);
  return { ok, reason: ok ? "match" : "mismatch" };
}

/**
 * The CURRENT summary format, emitted by src/infra/instrument-liveness.ts:508 since the
 * 2026-08-03 reporter rewrite:
 *
 *   [instrument-liveness] declared=25 live=11 pending=4 never=6 stale=0 idle=0 byConfig=4
 *
 * FIXED 2026-08-04. This regex still demanded the PRE-rewrite field names
 * (`healthy= silent= silentByConfig=`), which stopped existing when the reporter grew its
 * six-state model. Live consequence: `matched 3 line(s); newest did not parse` → WARN, and the
 * NEVER-fired instruments this check exists to surface went unreported for a day.
 *
 * The reason it survived is the part worth remembering: the `--self-test` FIXTURES ALSO encoded
 * the old format, so the self-test was green, and probes.md's merge gates assert only check-IDs
 * and evidence-presence, never verdicts — so the merge gate was green too. **A self-test whose
 * fixture is a hand-copy of the format under test cannot detect that the format moved.** It
 * asserts the parser still agrees with a snapshot of a world that ended.
 *
 * Two structural defences added with the fix:
 *   1. `parseLivenessSummary` returns `{ stale: "legacy-format" }` for the OLD shape instead of
 *      null, so a future drift is reported as A BROKEN WATCHER rather than as absence of data.
 *   2. The caller now FAILS when lines matched but did not parse. Unparseable is not "quiet".
 */
const LIVENESS_RE =
  /\[instrument-liveness\]\s+declared=(\d+)\s+live=(\d+)\s+pending=(\d+)\s+never=(\d+)\s+stale=(\d+)\s+idle=(\d+)\s+byConfig=(\d+)/;

/** The shape this check used to parse. Matching it now means the WATCHER is stale, not the data. */
const LIVENESS_LEGACY_RE =
  /\[instrument-liveness\]\s+declared=(\d+)\s+healthy=(\d+)\s+silent=(\d+)\s+silentByConfig=(\d+)/;

/**
 * Parse the one summary line src/infra/instrument-liveness.ts emits on every health tick.
 *
 * Returns null only when the line is not a liveness summary at all. A summary in a format this
 * parser does not understand returns `{ legacy: true }` — the distinction matters, because
 * "no data" and "I can no longer read the data" need opposite responses from an operator.
 */
export function parseLivenessSummary(line) {
  const text = String(line ?? "");
  const m = LIVENESS_RE.exec(text);
  if (!m) {
    if (LIVENESS_LEGACY_RE.test(text)) {
      return { legacy: true, declared: Number(LIVENESS_LEGACY_RE.exec(text)[1]) };
    }
    return null;
  }
  // `never` is the count this check exists for: declared, and not once fired.
  const never = Number(m[4]);
  // The enumeration block names never/stale/byConfig ids; live/pending/idle are structurally
  // unnameable in the current reporter, so brokenIds is best-effort and never load-bearing.
  const idSeg = /never=\d+[^\n]*?\[([^\]]*)\]/.exec(text);
  const brokenIds = (idSeg ? idSeg[1] : "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((tok) => tok.replace(/\(.*$/, ""));
  return {
    legacy: false,
    declared: Number(m[1]),
    live: Number(m[2]),
    pending: Number(m[3]),
    never,
    stale: Number(m[5]),
    idle: Number(m[6]),
    byConfig: Number(m[7]),
    neverFired: never,
    brokenIds,
  };
}

/**
 * Mirrors OPERATOR_CHOSEN_CRON_SKIP_REASONS in src/cron/service/timer.ts:103. These are the
 * ONLY two reasons a skipped cron is a decision rather than a failure. Keep in sync.
 */
export const OPERATOR_CHOSEN_SKIP_REASONS = new Set(["quiet-hours", "not-due"]);

/**
 * Classify a cron receipt's skip.
 *
 * The 2026-07-30 bug wrote `status:"skipped" error:"disabled"` 18 times a day for four days.
 * The 2026-08-03 fix did NOT make that reason disappear — it made it LOUD: timer.ts:1449 now
 * records `wake-refused:<reason>` specifically so it "cannot be confused with a job-level
 * skip". So `wake-refused:disabled` is the SAME defect wearing its new, honest name, and a
 * matcher on the bare string would watch the bug walk past. It did: the first live run of this
 * script scored `fork-scanner[wake-refused:disabled]`, recorded two minutes AFTER the deploy,
 * as clean.
 *
 * The prefix also carries a second bit. timer.ts:1425 returns the reason BARE exactly when it
 * is operator-chosen and applies the prefix only in the branch that logs "wake refused for a
 * reason the operator did not choose for THIS job". `wake-refused:` therefore MEANS
 * not-operator-chosen, so a prefixed reason is never excused, whatever it says.
 *
 *   "operator-chosen"  bare quiet-hours / not-due — the operator asked for this. Fine.
 *   "disabled"         the fixed bug, bare or prefixed. FAIL.
 *   "unchosen"         anything else — timer.ts's own words: "the job ran and delivered
 *                      nothing". Not the bug we fixed, so WARN, but never silent.
 */
export function classifyCronSkip(rec) {
  if (!rec || rec.status !== "skipped") return null;
  const raw = typeof rec.error === "string" && rec.error ? rec.error : "(no reason recorded)";
  const refused = raw.startsWith("wake-refused:");
  const bare = refused ? raw.slice("wake-refused:".length) : raw;
  if (bare === "disabled") return { kind: "disabled", raw, bare };
  if (!refused && OPERATOR_CHOSEN_SKIP_REASONS.has(bare)) {
    return { kind: "operator-chosen", raw, bare };
  }
  return { kind: "unchosen", raw, bare };
}

/**
 * Recency needs a LOWER bound too. A receipt stamped in the future satisfies `<= window` and
 * would otherwise let one clock-skewed row stand in for a scheduler that has been dead a week.
 */
export function isRecent(ageMs, windowMs) {
  return ageMs !== null && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= windowMs;
}

/** Walk backwards to the newest line that parses AND carries a status — never guess from the tail. */
export function lastStatusRecord(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (rec && typeof rec === "object" && typeof rec.status === "string") return rec;
  }
  return null;
}

/** Drop the leading fragment when the read started mid-file; a half-line is not a record. */
export function tailLines(text, truncated) {
  const lines = String(text ?? "").split("\n");
  if (truncated) lines.shift();
  return lines.map((l) => l.trim()).filter(Boolean);
}

/** Epoch ms from either an ISO string or a numeric ts, else null. Never NaN-propagates. */
export function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * The instant after which evidence is attributable to the build we just deployed.
 *
 * Grace is an EXCEPTION and it costs knowledge: it is granted only when we know both when the
 * artifact was built and when the running process started, and the process started after the
 * build. Anything else returns null, which means no grace — the caller must fail closed.
 */
export function deriveDeployBoundary({ builtAtMs, processStartedAtMs }) {
  if (builtAtMs === null || builtAtMs === undefined) {
    return { ms: null, source: "unknown", why: "dist/build-info.json has no usable builtAt" };
  }
  if (processStartedAtMs === null || processStartedAtMs === undefined) {
    return {
      ms: null,
      source: "unknown",
      why: "the running gateway's start time could not be read, so 'after the deploy' is not decidable",
    };
  }
  if (processStartedAtMs < builtAtMs) {
    return {
      ms: null,
      source: "unknown",
      why: "the running process started BEFORE this build — it is not serving it, so nothing is attributable to it",
    };
  }
  return {
    ms: processStartedAtMs,
    source: "gateway process start",
    why: "receipts written after the running process started are the deployed build's own output",
  };
}

/**
 * The cron verdict, as a pure function, because every one of its historical bugs was a
 * branch-order or a scope bug rather than an IO bug — and those are exactly what a fixture can
 * pin down. Each branch below is a regression test in --self-test.
 */
export function decideCronVerdict({
  jobs,
  fileCount,
  unreadableCount,
  boundary,
  strictCron,
  windowHours,
}) {
  const offending = jobs.filter((j) => j.skipKind === "disabled");
  const afterBoundary =
    boundary.ms === null ? [] : offending.filter((j) => j.ts !== null && j.ts >= boundary.ms);
  const recent = jobs.filter((j) => j.recent);
  const unchosen = recent.filter((j) => j.skipKind === "unchosen");
  const future = jobs.filter((j) => j.ageMs !== null && j.ageMs < 0);
  const name = (j) => `${j.jobId}[${j.error ?? j.status}]`;

  // Blindness first: we read files and understood none of them. Never diagnose a cause
  // (a dead scheduler, a healthy fleet) that the check did not actually observe.
  if (jobs.length === 0) {
    return {
      verdict: "FAIL",
      headline:
        fileCount === 0
          ? "no cron receipt files at all — nothing has ever run, or the path is wrong"
          : `read ${fileCount} receipt file(s) and could not parse a status record from any of them — this check is blind, not green`,
    };
  }
  if (afterBoundary.length > 0) {
    return {
      verdict: "FAIL",
      headline:
        `${afterBoundary.length} cron job(s) skipped with reason "disabled" (bare or wake-refused:) ` +
        `AFTER the running build started — the silent-skip bug is live: ${afterBoundary.map(name).join(", ")}`,
    };
  }
  if (offending.length > 0 && (strictCron || boundary.ms === null)) {
    return {
      verdict: "FAIL",
      headline: strictCron
        ? `--strict-cron: ${offending.length} job(s) skipped as disabled: ${offending.map(name).join(", ")}`
        : `${offending.length} job(s) skipped as disabled, and the deploy boundary is unknown (${boundary.why}) — ` +
          `refusing to excuse them as pre-deploy: ${offending.map(name).join(", ")}`,
    };
  }
  if (offending.length > 0) {
    return {
      verdict: "WARN",
      headline:
        `UNPROVEN: ${offending.length} job(s) last recorded skipped/disabled, but every one of those receipts ` +
        `pre-dates the running build (${boundary.source}) — no cron has fired since. Re-run after the next tick. ` +
        `Jobs: ${offending.map(name).join(", ")}`,
    };
  }
  if (recent.length === 0) {
    return {
      verdict: "WARN",
      headline:
        `no cron produced a receipt in the last ${windowHours}h — the scheduler itself may be down` +
        (future.length > 0 ? ` (and ${future.length} receipt(s) are stamped in the FUTURE)` : ""),
    };
  }
  if (unchosen.length > 0) {
    return {
      verdict: "WARN",
      headline:
        `${unchosen.length} job(s) skipped for a reason the operator did not choose: ` +
        unchosen.map(name).join(", "),
    };
  }
  if (future.length > 0) {
    return {
      verdict: "WARN",
      headline: `${recent.length} job(s) ran inside the window, but ${future.length} receipt(s) are stamped in the FUTURE — clock skew`,
    };
  }
  if (unreadableCount > 0) {
    return {
      verdict: "WARN",
      headline: `${recent.length} recent job(s) healthy, but ${unreadableCount} receipt file(s) could not be read`,
    };
  }
  return {
    verdict: "PASS",
    headline: `${recent.length} job(s) ran inside the window, none skipped-as-disabled (${jobs.length} job(s) inspected in total)`,
  };
}

// ── io helpers ─────────────────────────────────────────────────────────────────────────

function readTail(path, maxBytes) {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  if (len === 0) return { text: "", truncated: false, size };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.subarray(0, read).toString("utf8"), truncated: start > 0, size };
  } finally {
    closeSync(fd);
  }
}

/** Live git HEAD, resolved from files only (no subprocess). Informational — see check 2. */
function readGitHead(repoRoot) {
  try {
    let gitDir = join(repoRoot, ".git");
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = m[1].trim();
      if (!gitDir.startsWith("/")) gitDir = join(repoRoot, gitDir);
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const refMatch = /^ref:\s*(.+)$/.exec(head);
    if (!refMatch) return null;
    const ref = refMatch[1].trim();
    const loose = join(gitDir, ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    const packed = join(gitDir, "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split("\n")) {
        const pm = /^([0-9a-f]{40})\s+(.+)$/.exec(line.trim());
        if (pm && pm[2] === ref) return pm[1];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * When did the RUNNING gateway start? systemd knows the PID; /proc/<pid> mtime is the process
 * start instant on Linux (verified equal to ActiveEnterTimestamp to the second on this host).
 *
 * Do NOT parse systemd's own timestamp string: `Date.parse("Mon 2026-08-03 12:51:47 CEST")`
 * returns NaN, and a NaN boundary silently disables every attribution this script makes.
 */
function readGatewayProcess(unit) {
  let res;
  try {
    res = spawnSync(
      "systemctl",
      ["--user", "show", unit, "--property=MainPID", "--property=ActiveState"],
      { encoding: "utf8", timeout: SYSTEMCTL_TIMEOUT_MS },
    );
  } catch (e) {
    return { known: false, reason: String(e?.message ?? e) };
  }
  if (!res || res.error || typeof res.stdout !== "string") {
    return {
      known: false,
      reason: String(res?.error?.message ?? res?.error ?? `systemctl exit ${res?.status}`),
    };
  }
  const props = {};
  for (const line of res.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const pid = Number(props.MainPID);
  const activeState = props.ActiveState ?? "unknown";
  if (!Number.isInteger(pid) || pid <= 0) {
    return { known: false, activeState, reason: `MainPID=${props.MainPID ?? "(absent)"}` };
  }
  try {
    return { known: true, pid, activeState, startedAtMs: statSync(`/proc/${pid}`).mtimeMs };
  } catch (e) {
    return { known: false, pid, activeState, reason: `/proc/${pid}: ${String(e?.message ?? e)}` };
  }
}

/**
 * Does the DEPLOYED bundle actually CALL the instrument-liveness report? This is the only way
 * check 5 can tell its own regression ("the registry shipped with no caller") from the healthy
 * case, since both produce zero journal lines. A chunk that references the symbol without
 * defining it is an importer, and it only imports it in order to call it.
 *
 * Lazy: this walks dist/*.js, so it runs only in the zero-lines branch.
 */
function findLivenessReportCaller(repoRoot) {
  const distDir = join(repoRoot, "dist");
  if (!existsSync(distDir)) return { known: false, reason: `no ${distDir}` };
  let files = [];
  try {
    files = readdirSync(distDir).filter((f) => f.endsWith(".js"));
  } catch (e) {
    return { known: false, reason: String(e?.message ?? e) };
  }
  let scannedFiles = 0;
  let scannedBytes = 0;
  for (const file of files) {
    const path = join(distDir, file);
    let text;
    try {
      const size = statSync(path).size;
      if (scannedBytes + size > DIST_SCAN_MAX_BYTES) break;
      text = readFileSync(path, "utf8");
      scannedBytes += size;
      scannedFiles++;
    } catch {
      continue;
    }
    if (!text.includes(LIVENESS_REPORT_SYMBOL)) continue;
    if (new RegExp(`function\\s+${LIVENESS_REPORT_SYMBOL}\\s*\\(`).test(text)) continue;
    return { known: true, caller: file, scannedFiles, scannedBytes };
  }
  return { known: true, caller: null, scannedFiles, scannedBytes };
}

function httpGetText(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
          if (bytes <= 64 * 1024) chunks.push(c);
        });
        res.on("end", () =>
          finish({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8").slice(0, 2048),
          }),
        );
        res.on("error", (e) => finish({ error: String(e?.message ?? e) }));
      });
    } catch (e) {
      finish({ error: String(e?.message ?? e) });
      return;
    }
    req.on("timeout", () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
    req.on("error", (e) => finish({ error: String(e?.message ?? e) }));
  });
}

// ── args ───────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    json: false,
    expectSha: null,
    gateway: "http://127.0.0.1:18789",
    repoRoot: join(__dirname, ".."),
    openclawDir: join(homedir(), ".openclaw"),
    unit: "openclaw-gateway.service",
    cronWindowHours: 48,
    metricsMaxAgeHours: 24,
    strictCron: false,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    const positive = (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${arg} must be a positive number`);
      return n;
    };
    switch (arg) {
      case "--json":
        opts.json = true;
        break;
      case "--expect-sha":
        opts.expectSha = value();
        break;
      case "--gateway":
        opts.gateway = value().replace(/\/+$/, "");
        break;
      case "--repo":
        opts.repoRoot = value();
        break;
      case "--openclaw-dir":
        opts.openclawDir = value();
        break;
      case "--unit":
        opts.unit = value();
        break;
      case "--cron-window-hours":
        opts.cronWindowHours = positive(value());
        break;
      case "--metrics-max-age-hours":
        opts.metricsMaxAgeHours = positive(value());
        break;
      case "--strict-cron":
        opts.strictCron = true;
        break;
      case "--self-test":
        opts.selfTest = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

// ── checks ─────────────────────────────────────────────────────────────────────────────
// Each returns { verdict, headline, evidence: string[], data: object }. `evidence` is what the
// check SAW; it is printed whatever the verdict, including on PASS.

async function checkGatewayLive(opts) {
  const url = `${opts.gateway}/health`;
  const res = await httpGetText(url, GATEWAY_TIMEOUT_MS);
  if (res.error) {
    return {
      verdict: "FAIL",
      headline: "gateway did not answer /health",
      evidence: [`GET ${url} -> ${res.error}`],
      data: { url, error: res.error },
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    /* the raw body is printed below either way */
  }
  const ok = res.status === 200 && parsed?.ok === true;
  return {
    verdict: ok ? "PASS" : "FAIL",
    headline: ok ? "gateway answered ok" : `gateway answered HTTP ${res.status} without ok:true`,
    evidence: [`GET ${url} -> HTTP ${res.status} ${res.body.trim() || "(empty body)"}`],
    data: { url, status: res.status, body: res.body.trim(), ok },
  };
}

function checkDeployedBuild(opts, now) {
  const path = join(opts.repoRoot, "dist", "build-info.json");
  const proc = readGatewayProcess(opts.unit);
  const processStartedAtMs = proc.known ? proc.startedAtMs : null;

  if (!existsSync(path)) {
    return {
      verdict: "FAIL",
      headline: "no dist/build-info.json — nothing has been built from this tree",
      evidence: [`looked for ${path}`],
      data: { path, present: false, processStartedAtMs, builtAtMs: null },
    };
  }
  let info;
  try {
    info = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return {
      verdict: "FAIL",
      headline: "dist/build-info.json is unreadable",
      evidence: [`${path} -> ${String(e?.message ?? e)}`],
      data: {
        path,
        present: true,
        parseError: String(e?.message ?? e),
        processStartedAtMs,
        builtAtMs: null,
      },
    };
  }
  const commit = typeof info.commit === "string" ? info.commit : null;
  const builtAtMs = toEpochMs(info.builtAt);

  const evidence = [
    `${path} -> commit=${commit ?? "(missing)"} builtAt=${info.builtAt ?? "(missing)"}` +
      (builtAtMs === null ? "" : ` (${fmtAge(now - builtAtMs)} ago)`) +
      ` version=${info.version ?? "(missing)"}`,
    "source is the BUILD stamp, NOT `openclaw --version` — that banner prints live git HEAD and has misled before",
    proc.known
      ? `running gateway: unit=${opts.unit} state=${proc.activeState} pid=${proc.pid} started=${new Date(proc.startedAtMs).toISOString()} (${fmtAge(now - proc.startedAtMs)} ago, from /proc/${proc.pid})`
      : `running gateway start time UNKNOWN (${proc.reason}) — cannot prove the running process is serving this build`,
  ];
  const head = readGitHead(opts.repoRoot);
  evidence.push(
    head
      ? `live git HEAD=${head}` +
          (commit && head.toLowerCase() === commit.toLowerCase()
            ? " (same commit as the build)"
            : " — DIFFERENT from the build; the tree moved after it (normal, but HEAD is not what is deployed)")
      : "live git HEAD could not be resolved from .git (informational only)",
  );

  let verdict = "PASS";
  let headline = `built ${commit ? commit.slice(0, 12) : "(no commit field)"} and the running process is newer`;
  if (!commit) {
    verdict = "FAIL";
    headline = "dist/build-info.json has no commit field";
  } else if (builtAtMs === null) {
    verdict = "WARN";
    headline = `built ${commit.slice(0, 12)} but builtAt is missing/unparseable — the deploy boundary is undecidable`;
  } else if (processStartedAtMs === null) {
    verdict = "WARN";
    headline = `built ${commit.slice(0, 12)}, but whether the RUNNING process is serving it is unknown`;
  } else if (processStartedAtMs < builtAtMs) {
    verdict = "FAIL";
    headline =
      `BUILT BUT NOT RESTARTED: the running gateway started ${fmtAge(builtAtMs - processStartedAtMs)} BEFORE ` +
      `this build was produced, so it is serving the previous code`;
  }
  if (verdict !== "FAIL" && opts.expectSha) {
    const m = matchSha(commit, opts.expectSha);
    evidence.push(`--expect-sha ${opts.expectSha} vs built ${commit} -> ${m.reason}`);
    if (!m.ok) {
      verdict = "FAIL";
      headline =
        m.reason === "expected-too-short"
          ? `--expect-sha "${opts.expectSha}" is shorter than 7 hex chars — too ambiguous to prove anything`
          : m.reason === "expected-not-a-sha"
            ? `--expect-sha "${opts.expectSha}" is not a hex sha`
            : `built sha ${commit.slice(0, 12)} != expected ${opts.expectSha}`;
    }
  }
  return {
    verdict,
    headline,
    evidence,
    data: {
      path,
      commit,
      builtAt: info.builtAt ?? null,
      builtAtMs,
      version: info.version ?? null,
      gitHead: head,
      expectSha: opts.expectSha,
      process: proc,
      processStartedAtMs,
    },
  };
}

function checkCronNotSilentlySkipped(opts, now, boundary) {
  const runsDir = join(opts.openclawDir, "cron", "runs");
  if (!existsSync(runsDir)) {
    return {
      verdict: "FAIL",
      headline: "no cron runs directory — cannot see whether any cron ever ran",
      evidence: [`looked for ${runsDir}`],
      data: { runsDir, present: false },
    };
  }
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));
  const windowMs = opts.cronWindowHours * 3600_000;
  const jobs = [];
  const unreadable = [];
  for (const file of files) {
    const path = join(runsDir, file);
    let rec = null;
    try {
      const { text, truncated } = readTail(path, CRON_TAIL_BYTES);
      rec = lastStatusRecord(tailLines(text, truncated));
    } catch (e) {
      unreadable.push(`${file}: ${String(e?.message ?? e)}`);
      continue;
    }
    if (!rec) {
      unreadable.push(`${file}: no parseable record carrying a status`);
      continue;
    }
    const ts = toEpochMs(rec.ts) ?? toEpochMs(rec.runAtMs);
    const ageMs = ts === null ? null : now - ts;
    jobs.push({
      jobId: typeof rec.jobId === "string" ? rec.jobId : file.replace(/\.jsonl$/, ""),
      status: rec.status,
      error: typeof rec.error === "string" ? rec.error : null,
      ts,
      ageMs,
      recent: isRecent(ageMs, windowMs),
      afterBoundary: boundary.ms !== null && ts !== null && ts >= boundary.ms,
      skipKind: classifyCronSkip(rec)?.kind ?? null,
    });
  }
  jobs.sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity));

  const evidence = [
    `${files.length} receipt file(s) in ${runsDir}; ${jobs.length} readable, ${unreadable.length} unreadable; ` +
      `${jobs.filter((j) => j.recent).length} with a run inside the last ${opts.cronWindowHours}h`,
    `deploy boundary: ${boundary.ms === null ? `UNKNOWN — ${boundary.why}` : `${new Date(boundary.ms).toISOString()} (${boundary.source})`}`,
  ];
  // The signature is judged whatever a receipt's age; the window only answers "did anything run
  // lately". A job whose newest receipt is a 3-day-old skipped/disabled is the post-mortem
  // scenario itself — when crons stop entirely, their last receipts age out of any window.
  const marker = (j) => {
    if (j.skipKind === "disabled") {
      return j.afterBoundary
        ? "  <== SKIPPED/DISABLED *AFTER* THE RUNNING BUILD STARTED — the job fired and delivered nothing"
        : "  <-- skipped/disabled, but pre-dates the running build (proves nothing about the fix)";
    }
    if (j.skipKind === "unchosen" && j.recent) {
      return "  <-- skipped for a reason the operator did not choose";
    }
    if (j.ageMs !== null && j.ageMs < 0) return "  <-- receipt stamped in the FUTURE (clock skew)";
    return "";
  };
  for (const j of jobs.slice(0, MAX_EVIDENCE_ROWS)) {
    evidence.push(
      `  ${j.jobId} status=${j.status}${j.error ? ` error=${j.error}` : ""} ` +
        `last=${j.ts === null ? "(no timestamp)" : `${fmtAge(j.ageMs)} ago`}` +
        (j.recent || j.ts === null ? "" : " [outside window]") +
        marker(j),
    );
  }
  if (jobs.length > MAX_EVIDENCE_ROWS) {
    evidence.push(`  … ${jobs.length - MAX_EVIDENCE_ROWS} more (use --json for all)`);
  }
  for (const u of unreadable.slice(0, 10)) evidence.push(`  UNREADABLE ${u}`);

  const { verdict, headline } = decideCronVerdict({
    jobs,
    fileCount: files.length,
    unreadableCount: unreadable.length,
    boundary,
    strictCron: opts.strictCron,
    windowHours: opts.cronWindowHours,
  });
  return {
    verdict,
    headline,
    evidence,
    data: {
      runsDir,
      fileCount: files.length,
      jobCount: jobs.length,
      windowHours: opts.cronWindowHours,
      boundary,
      jobs,
      unreadable,
    },
  };
}

function checkEngramStores(opts, now) {
  const eventsDir = join(opts.openclawDir, "engram", "events");
  if (!existsSync(eventsDir)) {
    return {
      verdict: "FAIL",
      headline: "no ENGRAM events/ directory — the sleep runner has nothing to discover",
      evidence: [`looked for ${eventsDir}`],
      data: { eventsDir, present: false },
    };
  }
  const all = readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"));
  const phantomPresent = all.includes("live.jsonl");
  let phantomSize = null;
  const stores = [];
  for (const file of all) {
    let st;
    try {
      st = statSync(join(eventsDir, file));
    } catch {
      continue;
    }
    if (file === "live.jsonl") {
      phantomSize = st.size;
      continue;
    }
    stores.push({ name: file, size: st.size, mtimeMs: st.mtimeMs });
  }
  const nonEmpty = stores.filter((s) => s.size > 0);
  const newest = nonEmpty.reduce((a, b) => (a === null || b.mtimeMs > a.mtimeMs ? b : a), null);

  const evidence = [
    `${eventsDir} -> ${stores.length} real *.jsonl store(s), ${nonEmpty.length} non-empty`,
    newest
      ? `newest store: ${newest.name} (${newest.size}B, written ${fmtAge(now - newest.mtimeMs)} ago)`
      : "newest store: NONE — every store is empty or unstattable",
    phantomPresent
      ? `events/live.jsonl EXISTS (${phantomSize}B) — the phantom default is back; anything falling back to it can read [] and call it a quiet night`
      : "events/live.jsonl is absent, as it always has been — nothing can silently fall back to it",
  ];

  let verdict = "PASS";
  let headline = `${nonEmpty.length} discoverable non-empty ENGRAM store(s)`;
  if (stores.length === 0 || nonEmpty.length === 0) {
    verdict = "FAIL";
    headline =
      stores.length === 0
        ? "zero real ENGRAM stores — consolidation would report a quiet night forever"
        : "every ENGRAM store is empty — nothing to consolidate, and that is not a quiet night";
  } else if (phantomPresent) {
    verdict = "WARN";
    headline = `${nonEmpty.length} real store(s), but events/live.jsonl now exists — re-check that nothing defaults to it`;
  }
  return {
    verdict,
    headline,
    evidence,
    data: {
      eventsDir,
      storeCount: stores.length,
      nonEmptyCount: nonEmpty.length,
      phantomPresent,
      phantomSize,
      newest,
    },
  };
}

function checkInstrumentLiveness(opts) {
  const grep = "instrument-liveness\\] declared=";
  let res;
  try {
    res = spawnSync(
      "journalctl",
      ["--user", "-u", opts.unit, "--since", "-60 min", "--no-pager", "-o", "cat", "--grep", grep],
      { encoding: "utf8", timeout: JOURNAL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (e) {
    res = { error: e };
  }
  if (!res || res.error || typeof res.stdout !== "string") {
    return {
      verdict: "WARN",
      headline: "could not read the journal — instrument liveness is UNOBSERVED, not healthy",
      evidence: [
        `journalctl --user -u ${opts.unit} --since '-60 min' --grep '${grep}' -> ` +
          String(res?.error?.message ?? res?.error ?? `exit ${res?.status}`),
      ],
      data: { unit: opts.unit, available: false },
    };
  }
  const lines = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1] : null;
  const parsed = last ? parseLivenessSummary(last) : null;

  // A summary we can see but cannot READ is the watcher itself being broken, and it must not be
  // reported as quiet. This is the exact failure that hid the 2026-08-03 format change for a day.
  if (parsed?.legacy) {
    return {
      verdict: "FAIL",
      headline:
        "the liveness summary is in a format this check no longer parses — the WATCHER is stale, not the system",
      evidence: [
        `newest summary (of ${lines.length} in the last hour): ${last.slice(0, 600)}`,
        "matched the PRE-2026-08-03 field names (healthy=/silent=/silentByConfig=). Update LIVENESS_RE " +
          "in scripts/post-deploy-smoke.mjs to the emitter in src/infra/instrument-liveness.ts, and update " +
          "the --self-test fixtures in the SAME commit — a fixture that copies the old format is why this " +
          "went unnoticed.",
      ],
      data: { unit: opts.unit, available: true, matchedLines: lines.length, legacyFormat: true },
    };
  }

  if (parsed) {
    return {
      verdict: parsed.neverFired > 0 ? "WARN" : "PASS",
      headline:
        parsed.neverFired > 0
          ? `${parsed.neverFired} declared instrument(s) have NEVER fired (known and tracked — WARN, not a deploy blocker)`
          : `all ${parsed.declared} declared instruments have fired`,
      evidence: [
        `newest summary (of ${lines.length} in the last hour): ${last.slice(0, 600)}`,
        `parsed -> declared=${parsed.declared} live=${parsed.live} pending=${parsed.pending} ` +
          `never=${parsed.never} stale=${parsed.stale} idle=${parsed.idle} byConfig=${parsed.byConfig}`,
      ],
      data: { unit: opts.unit, available: true, matchedLines: lines.length, summary: parsed },
    };
  }

  // Lines matched the grep (`instrument-liveness] declared=`) but parsed as neither the current
  // nor the legacy shape. That is a third format nobody has taught this check about, and it is
  // still a broken watcher — never a PASS.
  if (lines.length > 0) {
    return {
      verdict: "FAIL",
      headline: `found ${lines.length} liveness summary line(s) and could parse none of them — the watcher is broken`,
      evidence: [
        `newest: ${last.slice(0, 600)}`,
        "Neither LIVENESS_RE nor LIVENESS_LEGACY_RE matched. The emitter is src/infra/instrument-liveness.ts.",
      ],
      data: { unit: opts.unit, available: true, matchedLines: lines.length, unparseable: true },
    };
  }

  // Zero lines is ambiguous by construction: the healthy path logs at DEBUG
  // (instrument-liveness.ts:224) and only the broken path logs at WARN (:211). The ONE thing
  // that distinguishes "everything is fine and quiet" from the regression this instrument
  // exists to catch — the report shipped with no caller — is whether the deployed bundle
  // still calls it. So go look, rather than shrug and print a verdict either way.
  const caller = findLivenessReportCaller(opts.repoRoot);
  const evidence = [
    `journalctl --user -u ${opts.unit} --since '-60 min' --grep '${grep}' matched ${lines.length} line(s)` +
      (last ? `; newest did not parse: ${last.slice(0, 200)}` : ""),
    caller.known
      ? caller.caller
        ? `deployed bundle DOES call ${LIVENESS_REPORT_SYMBOL} (dist/${caller.caller}; scanned ${caller.scannedFiles} chunk(s))`
        : `deployed bundle has NO caller for ${LIVENESS_REPORT_SYMBOL} (scanned ${caller.scannedFiles} chunk(s))`
      : `could not scan dist for a caller: ${caller.reason}`,
  ];
  if (caller.known && !caller.caller) {
    return {
      verdict: "FAIL",
      headline: `no liveness summary in the journal AND no caller for ${LIVENESS_REPORT_SYMBOL} in the deployed bundle — the counter-nobody-reads regression is back`,
      evidence,
      data: { unit: opts.unit, available: true, matchedLines: lines.length, summary: null, caller },
    };
  }
  return {
    verdict: "WARN",
    headline: caller.known
      ? "no liveness summary in the last hour; the caller IS in the bundle, so this is most likely the healthy DEBUG path being filtered — UNPROVEN either way"
      : "no liveness summary in the last hour and dist could not be scanned — UNOBSERVED, not healthy",
    evidence,
    data: { unit: opts.unit, available: true, matchedLines: lines.length, summary: null, caller },
  };
}

function checkAlgorithmMetricsFresh(opts, now) {
  const path = join(opts.openclawDir, "data", "algorithm-metrics.jsonl");
  if (!existsSync(path)) {
    return {
      verdict: "FAIL",
      headline: "algorithm-metrics.jsonl is missing — the metrics producer has never written",
      evidence: [`looked for ${path}`],
      data: { path, present: false },
    };
  }
  const { text, truncated, size } = readTail(path, METRICS_TAIL_BYTES);
  const lines = tailLines(text, truncated);
  const newestByAlgorithm = new Map();
  let parsed = 0;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = toEpochMs(rec?.ts);
    if (ts === null || typeof rec.algorithm !== "string") continue;
    parsed++;
    const prev = newestByAlgorithm.get(rec.algorithm);
    if (!prev || ts > prev.ts) {
      newestByAlgorithm.set(rec.algorithm, { ts, outcome: rec.outcome ?? null });
    }
  }
  const staleMs = opts.metricsMaxAgeHours * 3600_000;
  const rows = [...newestByAlgorithm.entries()]
    .map(([algorithm, v]) => ({
      algorithm,
      ts: v.ts,
      ageMs: now - v.ts,
      outcome: v.outcome,
      stale: now - v.ts > staleMs,
    }))
    .sort((a, b) => a.ageMs - b.ageMs);
  const evidence = [
    `${path} (${size}B${truncated ? `, read last ${METRICS_TAIL_BYTES}B` : ""}) -> ` +
      `${parsed} parseable record(s), ${rows.length} distinct algorithm(s), window=${opts.metricsMaxAgeHours}h`,
  ];
  for (const r of rows.slice(0, MAX_EVIDENCE_ROWS)) {
    evidence.push(
      `  ${r.algorithm} newest=${new Date(r.ts).toISOString()} (${fmtAge(r.ageMs)} ago)` +
        (r.outcome ? ` outcome=${r.outcome}` : "") +
        (r.stale ? "  <-- STALE" : ""),
    );
  }
  if (rows.length === 0) {
    return {
      verdict: "FAIL",
      headline: "algorithm-metrics.jsonl exists but yielded zero parseable records",
      evidence,
      data: { path, present: true, size, parsed: 0, algorithms: [] },
    };
  }
  // Judge EVERY producer, not just the freshest one. Six of seven can be dead for a week while
  // model-router writes every few seconds; reading only the newest row calls that fresh.
  const stale = rows.filter((r) => r.stale);
  return {
    verdict: stale.length > 0 ? "WARN" : "PASS",
    headline:
      stale.length > 0
        ? `${stale.length} of ${rows.length} algorithm(s) stale (>${opts.metricsMaxAgeHours}h): ` +
          stale.map((r) => `${r.algorithm}[${fmtAge(r.ageMs)}]`).join(", ")
        : `all ${rows.length} algorithm(s) wrote within ${opts.metricsMaxAgeHours}h (newest ${rows[0].algorithm} ${fmtAge(rows[0].ageMs)} ago)`,
    evidence,
    data: {
      path,
      present: true,
      size,
      parsed,
      maxAgeHours: opts.metricsMaxAgeHours,
      algorithms: rows,
    },
  };
}

// ── self-test ──────────────────────────────────────────────────────────────────────────
// Every fixture below is a bug this script actually had. Pure functions only: no gateway, no
// filesystem, no clock. Wired into TINKER_UI_DESIGN_BIBLE/probes.md as a merge gate.

function selfTest() {
  const failures = [];
  const check = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${name}: got ${a}, want ${e}`);
  };
  const SHA = "d1c811e363162f0f4e32b7662021077c31677529";

  check("matchSha exact", matchSha(SHA, SHA).ok, true);
  check("matchSha short prefix", matchSha(SHA, "d1c811e").ok, true);
  check("matchSha mismatch", matchSha(SHA, "deadbeef").ok, false);
  check("matchSha refuses <7 chars", matchSha(SHA, "d1c").reason, "expected-too-short");
  check("matchSha refuses non-hex", matchSha(SHA, "HEAD").reason, "expected-not-a-sha");

  const brokenLine =
    // VERBATIM from the live journal at 21:00:47 on 2026-08-04 — copied from a real gateway, not
    // hand-written. A hand-written fixture is how this check spent a day parsing a format that no
    // longer existed: the fixture agreed with the parser, and both agreed with a dead world.
    "2026-08-04T21:00:47.330+02:00 [infra/instrument-liveness] [instrument-liveness] " +
    "declared=25 live=11 pending=4 never=6 stale=0 idle=0 byConfig=4";
  const parsedBroken = parseLivenessSummary(brokenLine);
  check("liveness declared", parsedBroken.declared, 25);
  check("liveness live", parsedBroken.live, 11);
  check("liveness byConfig", parsedBroken.byConfig, 4);
  check("liveness counts NEVER-fired instruments", parsedBroken.neverFired, 6);
  check("liveness is not flagged legacy", parsedBroken.legacy, false);
  check(
    "liveness healthy line parses with never=0",
    parseLivenessSummary(
      "[instrument-liveness] declared=18 live=18 pending=0 never=0 stale=0 idle=0 byConfig=0",
    ).neverFired,
    0,
  );
  check("liveness rejects noise", parseLivenessSummary("unrelated log line"), null);
  // THE REGRESSION GUARD. This asserts the check can RECOGNISE that it has gone stale. The
  // pre-2026-08-03 format must parse as `legacy`, never as null and never as a healthy summary —
  // because the caller turns `legacy` into a FAIL that names the fix. Without this, the next
  // format change repeats the same silent day: fixture and parser drift together, in agreement,
  // away from the emitter.
  const deadFormat =
    "[instrument-liveness] declared=18 healthy=0 silent=14 silentByConfig=4 " +
    "BROKEN=[router:model-fallback(gate,NEVER)] byConfig=[compaction-gate:pi-auto]";
  check("liveness detects its OWN stale format", parseLivenessSummary(deadFormat)?.legacy, true);
  check(
    "liveness does not mistake the stale format for data",
    parseLivenessSummary(deadFormat)?.neverFired,
    undefined,
  );

  const kind = (rec) => classifyCronSkip(rec)?.kind ?? null;
  check("classify bare disabled", kind({ status: "skipped", error: "disabled" }), "disabled");
  // The regression this script's own first live run caught in this script.
  check(
    "classify wake-refused:disabled",
    kind({ status: "skipped", error: "wake-refused:disabled" }),
    "disabled",
  );
  check(
    "classify quiet-hours",
    kind({ status: "skipped", error: "quiet-hours" }),
    "operator-chosen",
  );
  check("classify not-due", kind({ status: "skipped", error: "not-due" }), "operator-chosen");
  // timer.ts applies the prefix ONLY in the not-operator-chosen branch, so a prefixed
  // quiet-hours is not a decision the operator made for this job.
  check(
    "classify wake-refused:quiet-hours is NOT operator-chosen",
    kind({ status: "skipped", error: "wake-refused:quiet-hours" }),
    "unchosen",
  );
  check(
    "classify other reason",
    kind({ status: "skipped", error: "requests-in-flight" }),
    "unchosen",
  );
  check("classify missing reason", kind({ status: "skipped" }), "unchosen");
  check("classify non-skip", kind({ status: "ok", error: "disabled" }), null);
  check("classify null", kind(null), null);
  check(
    "classify keeps the raw reason",
    classifyCronSkip({ status: "skipped", error: "wake-refused:disabled" }).raw,
    "wake-refused:disabled",
  );

  const HOUR = 3600_000;
  check("isRecent inside", isRecent(2 * HOUR, 48 * HOUR), true);
  check("isRecent outside", isRecent(72 * HOUR, 48 * HOUR), false);
  check("isRecent rejects future-dated", isRecent(-HOUR, 48 * HOUR), false);
  check("isRecent rejects null", isRecent(null, 48 * HOUR), false);

  check(
    "boundary needs builtAt",
    deriveDeployBoundary({ builtAtMs: null, processStartedAtMs: 1000 }).ms,
    null,
  );
  check(
    "boundary needs a process start",
    deriveDeployBoundary({ builtAtMs: 1000, processStartedAtMs: null }).ms,
    null,
  );
  check(
    "boundary is null when the process predates the build",
    deriveDeployBoundary({ builtAtMs: 2000, processStartedAtMs: 1000 }).ms,
    null,
  );
  check(
    "boundary is the process start when it is newer",
    deriveDeployBoundary({ builtAtMs: 1000, processStartedAtMs: 2000 }).ms,
    2000,
  );

  const BOUNDARY = { ms: 1_000_000, source: "gateway process start", why: "" };
  const NO_BOUNDARY = { ms: null, source: "unknown", why: "test" };
  const job = (over) => ({
    jobId: "j",
    status: "ok",
    error: null,
    ts: 2_000_000,
    ageMs: HOUR,
    recent: true,
    afterBoundary: true,
    skipKind: null,
    ...over,
  });
  const verdict = (over) =>
    decideCronVerdict({
      jobs: [],
      fileCount: 0,
      unreadableCount: 0,
      boundary: BOUNDARY,
      strictCron: false,
      windowHours: 48,
      ...over,
    }).verdict;

  check("cron: healthy recent run", verdict({ jobs: [job()] }), "PASS");
  check(
    "cron: disabled after the boundary FAILs",
    verdict({
      jobs: [job({ status: "skipped", error: "wake-refused:disabled", skipKind: "disabled" })],
    }),
    "FAIL",
  );
  check(
    "cron: disabled before the boundary is UNPROVEN, not green",
    verdict({
      jobs: [
        job({
          status: "skipped",
          error: "disabled",
          skipKind: "disabled",
          ts: 500_000,
          afterBoundary: false,
        }),
      ],
    }),
    "WARN",
  );
  // Fixture A: an offending receipt older than the window must still be judged, and the
  // healthy job next to it must not launder it into a PASS.
  check(
    "cron: offending receipt outside the window still counts",
    verdict({
      jobs: [
        job(),
        job({
          jobId: "stale",
          status: "skipped",
          error: "disabled",
          skipKind: "disabled",
          ageMs: 72 * HOUR,
          recent: false,
          ts: 500_000,
          afterBoundary: false,
        }),
      ],
    }),
    "WARN",
  );
  // Fixture B: no boundary => no grace. Never assert "pre-dates the build" without a build time.
  check(
    "cron: no boundary means no pre-deploy alibi",
    verdict({
      boundary: NO_BOUNDARY,
      jobs: [
        job({ status: "skipped", error: "disabled", skipKind: "disabled", afterBoundary: false }),
      ],
    }),
    "FAIL",
  );
  check(
    "cron: --strict-cron FAILs on a pre-boundary receipt",
    verdict({
      strictCron: true,
      jobs: [
        job({
          status: "skipped",
          error: "disabled",
          skipKind: "disabled",
          ts: 500_000,
          afterBoundary: false,
        }),
      ],
    }),
    "FAIL",
  );
  // Fixture F: files present, none parseable => blind, and blind is never a diagnosis.
  const blind = decideCronVerdict({
    jobs: [],
    fileCount: 2,
    unreadableCount: 2,
    boundary: BOUNDARY,
    strictCron: false,
    windowHours: 48,
  });
  check("cron: all-unreadable FAILs", blind.verdict, "FAIL");
  check(
    "cron: all-unreadable does not blame the scheduler",
    /scheduler/.test(blind.headline),
    false,
  );
  // Fixture E: one future-dated receipt must not stand in for a dead scheduler.
  check(
    "cron: future-dated receipt does not count as recent",
    verdict({
      jobs: [
        job({ jobId: "skewed", ageMs: -HOUR, recent: false }),
        job({ jobId: "dead", ageMs: 120 * HOUR, recent: false }),
      ],
    }),
    "WARN",
  );
  check(
    "cron: unchosen skip is surfaced",
    verdict({
      jobs: [job({ status: "skipped", error: "requests-in-flight", skipKind: "unchosen" })],
    }),
    "WARN",
  );

  const receipts = [
    '{"ts":1,"jobId":"a","status":"ok"}',
    "{ this is not json",
    '{"ts":2,"jobId":"a","action":"started"}',
    '{"ts":3,"jobId":"a","status":"skipped","error":"disabled"}',
    "{ truncated tail",
  ];
  check("lastStatusRecord skips non-status tail", lastStatusRecord(receipts).ts, 3);
  check("lastStatusRecord empty", lastStatusRecord(["nope"]), null);

  check("tailLines drops the leading fragment", tailLines('sonl"}\n{"a":1}\n', true), ['{"a":1}']);
  check("tailLines keeps a whole first line", tailLines('{"a":1}\n{"b":2}\n', false), [
    '{"a":1}',
    '{"b":2}',
  ]);

  check("toEpochMs numeric", toEpochMs(1785729600034), 1785729600034);
  check(
    "toEpochMs iso",
    toEpochMs("2026-08-03T07:28:06.888Z"),
    Date.parse("2026-08-03T07:28:06.888Z"),
  );
  check("toEpochMs garbage", toEpochMs("not a date"), null);
  check("toEpochMs undefined", toEpochMs(undefined), null);
  // systemd's own timestamp string is NOT parseable; the /proc fallback exists because of this.
  check(
    "toEpochMs rejects the systemd timestamp format",
    toEpochMs("Mon 2026-08-03 12:51:47 CEST"),
    null,
  );

  check("fmtAge future is labelled", fmtAge(-5000).includes("IN THE FUTURE"), true);
  check("fmtAge seconds", fmtAge(30_000), "30s");
  check("fmtAge hours", fmtAge(3 * HOUR), "3.0h");

  if (failures.length > 0) {
    for (const f of failures) console.error(`[post-deploy-smoke] SELF-TEST FAIL ${f}`);
    console.error(`[post-deploy-smoke] self-test: ${failures.length} failure(s)`);
    return 1;
  }
  console.log("[post-deploy-smoke] self-test: all pure-helper assertions passed");
  return 0;
}

// ── main ───────────────────────────────────────────────────────────────────────────────

const VERDICT_ORDER = { FAIL: 0, WARN: 1, PASS: 2 };

function runCheck(order, id, name, fn) {
  // Normalise the shape rather than trusting it. A check that returns a malformed result used
  // to take the whole report down with it (measured: a missing `evidence` array threw in the
  // renderer AFTER five checks had already produced findings, and printed none of them). The
  // report is the product; one sloppy check must not delete the other five.
  const wrap = (out) => {
    const verdict = ["PASS", "WARN", "FAIL"].includes(out?.verdict) ? out.verdict : "FAIL";
    const evidence = Array.isArray(out?.evidence) ? out.evidence.map((l) => String(l)) : [];
    return {
      order,
      id,
      name,
      verdict,
      headline: String(
        out?.headline ?? (out ? "check returned no headline" : "check returned nothing"),
      ),
      evidence:
        evidence.length > 0
          ? evidence
          : ["(this check reported no evidence — treat as unobserved)"],
      data: out?.data ?? {},
    };
  };
  const fail = (e) =>
    wrap({
      // A crashed check is a FAIL. It must never read as a pass — that is the entire disease
      // this script exists to treat.
      verdict: "FAIL",
      headline: `check threw: ${String(e?.message ?? e)}`,
      evidence: [
        String(e?.stack ?? e)
          .split("\n")
          .slice(0, 4)
          .join(" | "),
      ],
      data: { error: String(e?.message ?? e) },
    });
  try {
    const out = fn();
    if (out && typeof out.then === "function") return out.then(wrap, fail);
    return wrap(out);
  } catch (e) {
    return fail(e);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[post-deploy-smoke] ${String(e?.message ?? e)}\n`);
    console.error(USAGE);
    return 1;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.selfTest) return selfTest();

  const startedAtMs = Date.now();
  const now = startedAtMs;

  // Check 2 runs first because check 3 needs the deploy boundary to tell pre-deploy evidence
  // from post-deploy evidence. Report order is fixed by the explicit index, not by run order.
  const build = runCheck(2, "deployed-build", "deployed build", () =>
    checkDeployedBuild(opts, now),
  );
  const boundary = deriveDeployBoundary({
    builtAtMs: build.data?.builtAtMs ?? null,
    processStartedAtMs: build.data?.processStartedAtMs ?? null,
  });

  const checks = await Promise.all([
    runCheck(1, "gateway-live", "gateway live", () => checkGatewayLive(opts)),
    build,
    runCheck(3, "cron-not-skipped", "cron not silently skipped", () =>
      checkCronNotSilentlySkipped(opts, now, boundary),
    ),
    runCheck(4, "engram-stores", "engram stores discoverable", () => checkEngramStores(opts, now)),
    runCheck(5, "instrument-liveness", "instrument liveness", () => checkInstrumentLiveness(opts)),
    runCheck(6, "algorithm-metrics", "algorithm metrics fresh", () =>
      checkAlgorithmMetricsFresh(opts, now),
    ),
  ]);
  checks.sort((a, b) => a.order - b.order);

  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const c of checks) counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
  const durationMs = Date.now() - startedAtMs;
  const exitCode = counts.FAIL > 0 ? 1 : 0;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: exitCode === 0,
          exitCode,
          startedAt: new Date(startedAtMs).toISOString(),
          durationMs,
          counts,
          gateway: opts.gateway,
          repoRoot: opts.repoRoot,
          openclawDir: opts.openclawDir,
          deployBoundary: boundary,
          checks: checks.map(({ order: _order, ...rest }) => rest),
        },
        null,
        2,
      )}\n`,
    );
    return exitCode;
  }

  const tty = Boolean(process.stdout.isTTY);
  const paint = (v) =>
    tty ? `\x1b[${v === "PASS" ? "32" : v === "WARN" ? "33" : "31"}m${v}\x1b[0m` : v;
  console.log(`post-deploy smoke — ${new Date(startedAtMs).toISOString()}`);
  console.log(`  repo=${opts.repoRoot}  state=${opts.openclawDir}  gateway=${opts.gateway}`);
  console.log("");
  let n = 0;
  for (const c of checks) {
    n++;
    console.log(`[${n}/${checks.length}] ${paint(c.verdict)}  ${c.name} — ${c.headline}`);
    for (const line of c.evidence) console.log(`        ${line}`);
    console.log("");
  }
  const worst = checks.reduce(
    (acc, c) => (VERDICT_ORDER[c.verdict] < VERDICT_ORDER[acc] ? c.verdict : acc),
    "PASS",
  );
  console.log(
    `summary: ${counts.PASS} PASS · ${counts.WARN} WARN · ${counts.FAIL} FAIL · ${durationMs}ms · worst=${worst} · exit ${exitCode}`,
  );
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`[post-deploy-smoke] fatal: ${String(e?.stack ?? e)}`);
    process.exitCode = 1;
  });
