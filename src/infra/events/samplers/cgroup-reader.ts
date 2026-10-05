/**
 * FORK 2026-09-25 — kernel resource accounting for the worker-resources sampler
 * (TINKER_UI_DESIGN_BIBLE/logging.md §4.9, §9 step 5).
 *
 * Two sources, one per shape of worker:
 *
 * - A tinker-bridge worker runs as a transient systemd user unit (`systemd-run --user --pipe
 *   --unit=tinkerclaw-worker-…`, extensions/tinkerclaw-tinker-bridge/src/worker.ts). The child the
 *   gateway holds is the `systemd-run` wrapper, so `/proc/<child.pid>` would chart the wrong
 *   process with total confidence. The unit's cgroup (v2) holds the real process tree:
 *   `memory.current`, `memory.peak`, `cpu.stat` usage_usec and `pids.current`. Its path is ASKED of
 *   systemd (`systemctl --user show --property=ControlGroup`), never guessed from the gateway's own
 *   cgroup.
 * - A direct child process of the gateway (whatsmeow's Go binary) is read from `/proc/<pid>`.
 *
 * Every reader takes its filesystem root as a parameter, so tests run against a fixture tree and
 * never the host's /sys or /proc. Every reader resolves to null (never throws, never rejects) when
 * its source is absent: the sampler records that as `source=unavailable` — an honest gap, never a
 * zero.
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const CGROUP_FS_ROOT = "/sys/fs/cgroup";
export const PROC_FS_ROOT = "/proc";
/**
 * The unit of utime / stime / starttime in /proc/<pid>/stat. The kernel fixes USER_HZ at 100 in
 * its userspace ABI on every mainstream architecture, whatever CONFIG_HZ is.
 */
export const PROC_USER_HZ = 100;
export const SYSTEMCTL_TIMEOUT_MS = 5_000;
export const WORKER_UNIT_PREFIX = "tinkerclaw-worker-";

/** `tinkerclaw-worker-<gateway pid>-<spawn ms, base 36>-<random>`, exactly as worker.ts names it. */
const WORKER_UNIT_NAME = /^tinkerclaw-worker-(\d{1,10})-([0-9a-z]{1,13})-([0-9a-z]{1,16})$/;
/** A unit name that systemctl cannot read as an option (no shell is involved: execFile). */
const SAFE_UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}$/;
const SERVICE_SUFFIX = ".service";
/** systemctl's ACTIVE column values for a unit that still holds a process. */
const LIVE_ACTIVE_STATES = new Set(["active", "activating", "reloading", "deactivating"]);

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** A non-negative integer file ("123\n"), or null — including cgroup's literal "max". */
function parseCount(text: string | null | undefined): number | null {
  if (text === null || text === undefined) {
    return null;
  }
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

// ─── the unit ───────────────────────────────────────────────────────────────

export interface ParsedWorkerUnit {
  readonly unit: string;
  /** The gateway process that spawned it (worker.ts embeds `process.pid`). */
  readonly ownerPid: number;
  /** When it was spawned (worker.ts embeds `Date.now()` in base 36). */
  readonly spawnedAtMs: number;
}

/** The owner pid and spawn time a tinker-bridge unit name carries, or null for any other name. */
export function parseWorkerUnitName(unit: string): ParsedWorkerUnit | null {
  const match = WORKER_UNIT_NAME.exec(unit);
  if (match === null) {
    return null;
  }
  const ownerPid = Number.parseInt(match[1], 10);
  const spawnedAtMs = Number.parseInt(match[2], 36);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    return null;
  }
  if (!Number.isSafeInteger(spawnedAtMs) || spawnedAtMs <= 0) {
    return null;
  }
  return { unit, ownerPid, spawnedAtMs };
}

/** Runs a command without a shell; resolves stdout, rejects on a non-zero exit or the timeout. */
export type RunCommand = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

export const runCommand: RunCommand = (file, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });

/**
 * The unit's cgroup path as systemd reports it (`/user.slice/…/<unit>.service`), or null when
 * systemd has none for it — the unit has not started yet, is already gone, or systemctl is absent
 * (not Linux, no user manager). Off the hot path: one subprocess per call.
 */
export async function resolveUnitControlGroup(
  unit: string,
  run: RunCommand = runCommand,
): Promise<string | null> {
  if (!SAFE_UNIT_NAME.test(unit)) {
    return null;
  }
  try {
    const out = await run(
      "systemctl",
      ["--user", "show", "--property=ControlGroup", "--value", `${unit}${SERVICE_SUFFIX}`],
      SYSTEMCTL_TIMEOUT_MS,
    );
    const controlGroup = out.trim();
    return controlGroup.length > 0 ? controlGroup : null;
  } catch {
    return null;
  }
}

/** The tinker-bridge units that still hold a process, out of `systemctl --user list-units`. */
export function parseWorkerUnitList(text: string): string[] {
  const units: string[] = [];
  for (const line of text.split("\n")) {
    const columns = line.trim().split(/\s+/);
    const name = columns[0] ?? "";
    const active = columns[2] ?? "";
    if (!name.endsWith(SERVICE_SUFFIX) || !LIVE_ACTIVE_STATES.has(active)) {
      continue;
    }
    const unit = name.slice(0, -SERVICE_SUFFIX.length);
    if (parseWorkerUnitName(unit) !== null) {
      units.push(unit);
    }
  }
  return units;
}

/** Live `tinkerclaw-worker-*` units, or null when systemd cannot be asked. */
export async function listLiveWorkerUnits(run: RunCommand = runCommand): Promise<string[] | null> {
  try {
    const out = await run(
      "systemctl",
      [
        "--user",
        "list-units",
        "--type=service",
        "--plain",
        "--no-legend",
        "--no-pager",
        `${WORKER_UNIT_PREFIX}*`,
      ],
      SYSTEMCTL_TIMEOUT_MS,
    );
    return parseWorkerUnitList(out);
  } catch {
    return null;
  }
}

// ─── the cgroup ─────────────────────────────────────────────────────────────

/**
 * `<root><controlGroup>` for an absolute cgroup path, or null for anything else: a relative path,
 * a `.` or `..` segment, a NUL, or the root cgroup itself (never a worker's).
 */
export function cgroupDirFor(controlGroup: string, root: string = CGROUP_FS_ROOT): string | null {
  const cg = controlGroup.trim();
  if (!cg.startsWith("/") || cg === "/" || cg.includes("\0")) {
    return null;
  }
  if (cg.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return path.join(root, cg);
}

export interface CgroupReading {
  readonly memoryCurrentBytes: number;
  /** null on a kernel without memory.peak (it arrived in 5.19). */
  readonly memoryPeakBytes: number | null;
  readonly cpuUsageUsec: number | null;
  /** The pids controller's count — tasks, so threads count too. */
  readonly pidsCurrent: number | null;
}

/** `usage_usec` out of a cgroup v2 `cpu.stat`. */
export function parseCpuStatUsageUsec(text: string): number | null {
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === "usage_usec") {
      return parseCount(value);
    }
  }
  return null;
}

/** One reading of a cgroup v2 directory, or null when `memory.current` cannot be read (gone, or not v2). */
export async function readCgroup(dir: string): Promise<CgroupReading | null> {
  const [current, peak, cpuStat, pids] = await Promise.all([
    readText(path.join(dir, "memory.current")),
    readText(path.join(dir, "memory.peak")),
    readText(path.join(dir, "cpu.stat")),
    readText(path.join(dir, "pids.current")),
  ]);
  const memoryCurrentBytes = parseCount(current);
  if (memoryCurrentBytes === null) {
    return null;
  }
  return {
    memoryCurrentBytes,
    memoryPeakBytes: parseCount(peak),
    cpuUsageUsec: cpuStat === null ? null : parseCpuStatUsageUsec(cpuStat),
    pidsCurrent: parseCount(pids),
  };
}

// ─── /proc ──────────────────────────────────────────────────────────────────

export interface ProcStat {
  readonly comm: string;
  readonly ppid: number;
  /** utime + stime, in USER_HZ ticks. */
  readonly cpuTicks: number;
  /** starttime: USER_HZ ticks after boot. */
  readonly startTicks: number;
}

/**
 * /proc/<pid>/stat. `comm` sits in parentheses and may itself hold spaces and `)`, so the numeric
 * fields are split from AFTER the last `)`; field N (1-based, proc(5)) is then rest[N - 3].
 */
export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) {
    return null;
  }
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const startTicks = Number(rest[19]);
  if (![ppid, utime, stime, startTicks].every((value) => Number.isFinite(value))) {
    return null;
  }
  return { comm: text.slice(open + 1, close), ppid, cpuTicks: utime + stime, startTicks };
}

/** A `Key:  <n> kB` line of /proc/<pid>/status, in bytes. */
export function parseProcStatusKb(text: string, key: string): number | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${key}:`)) {
      continue;
    }
    const match = /^[^:]+:\s+(\d+)\s+kB/.exec(line);
    return match === null ? null : Number(match[1]) * 1024;
  }
  return null;
}

export async function readProcStat(
  pid: number,
  procRoot: string = PROC_FS_ROOT,
): Promise<ProcStat | null> {
  const text = await readText(path.join(procRoot, String(pid), "stat"));
  return text === null ? null : parseProcStat(text);
}

export interface ProcProcessReading {
  readonly pid: number;
  readonly comm: string;
  readonly rssBytes: number;
  /** VmHWM: the process's peak resident set. */
  readonly peakRssBytes: number | null;
  /** utime + stime since the process started, in ms. */
  readonly cpuMs: number;
  readonly startTicks: number;
}

/** null when the process is gone, or is a zombie (no VmRSS line). */
export async function readProcProcess(
  pid: number,
  procRoot: string = PROC_FS_ROOT,
): Promise<ProcProcessReading | null> {
  const [stat, statusText] = await Promise.all([
    readProcStat(pid, procRoot),
    readText(path.join(procRoot, String(pid), "status")),
  ]);
  if (stat === null || statusText === null) {
    return null;
  }
  const rssBytes = parseProcStatusKb(statusText, "VmRSS");
  if (rssBytes === null) {
    return null;
  }
  return {
    pid,
    comm: stat.comm,
    rssBytes,
    peakRssBytes: parseProcStatusKb(statusText, "VmHWM"),
    cpuMs: (stat.cpuTicks * 1000) / PROC_USER_HZ,
    startTicks: stat.startTicks,
  };
}

/**
 * Direct children of `pid`: the union of `/proc/<pid>/task/<tid>/children` over its threads (a
 * child is listed under the thread that forked it). Empty when the kernel lacks
 * CONFIG_PROC_CHILDREN or the process is gone.
 */
export async function listChildPids(
  pid: number,
  procRoot: string = PROC_FS_ROOT,
): Promise<number[]> {
  const taskDir = path.join(procRoot, String(pid), "task");
  let tids: string[];
  try {
    tids = await readdir(taskDir);
  } catch {
    return [];
  }
  const lists = await Promise.all(tids.map((tid) => readText(path.join(taskDir, tid, "children"))));
  const children = new Set<number>();
  for (const list of lists) {
    for (const token of (list ?? "").trim().split(/\s+/)) {
      const child = Number(token);
      if (Number.isSafeInteger(child) && child > 0) {
        children.add(child);
      }
    }
  }
  return [...children].toSorted((a, b) => a - b);
}

/** The boot time (ms epoch), from the `btime` line of /proc/stat (one-second granularity). */
export async function readBootTimeMs(procRoot: string = PROC_FS_ROOT): Promise<number | null> {
  const text = await readText(path.join(procRoot, "stat"));
  const match = text === null ? null : /^btime\s+(\d+)\s*$/m.exec(text);
  return match === null ? null : Number(match[1]) * 1000;
}

/**
 * When process `pid` started (ms epoch): the boot time plus its starttime. null when either cannot
 * be read. What tells a live pid apart from a REUSED one: a process that started after a unit was
 * spawned cannot be the gateway that spawned it.
 */
export async function readProcessStartMs(
  pid: number,
  procRoot: string = PROC_FS_ROOT,
): Promise<number | null> {
  const [bootMs, stat] = await Promise.all([readBootTimeMs(procRoot), readProcStat(pid, procRoot)]);
  if (bootMs === null || stat === null) {
    return null;
  }
  return bootMs + (stat.startTicks * 1000) / PROC_USER_HZ;
}

/** Milliseconds since boot, from /proc/uptime. */
export async function readProcUptimeMs(procRoot: string = PROC_FS_ROOT): Promise<number | null> {
  const text = await readText(path.join(procRoot, "uptime"));
  if (text === null) {
    return null;
  }
  const seconds = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}
