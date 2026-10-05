/**
 * FORK 2026-09-30 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b) — the FILE transport: a claude worker
 * whose stdio outlive the gateway, so a restart can freeze it at an API-call boundary and the next
 * boot can adopt it, replay its turn and thaw it. No prompt, and nothing is asked again.
 *
 * The pipe transport (`systemd-run --pipe`) proxies the worker's stdio through a client process in
 * the GATEWAY's cgroup, so a gateway stop cuts them and the CLI dies mid-turn. Here the unit owns
 * its stdio:
 *   - stdin  is a FIFO the worker opens read-write, so it never sees EOF when the gateway goes;
 *   - stdout/stderr are files the worker appends to and the gateway tails;
 *   - `exit` holds the CLI's exit status, written by the unit's shell when claude ends;
 *   - `meta.json` holds what a new gateway needs to adopt it (session, CLI session, where the
 *     current turn's output starts).
 * All of it lives in `$XDG_RUNTIME_DIR/tinkerclaw-workers/<unit>/` (tmpfs, private to the user).
 *
 * Probed on this host 2026-09-30 (systemd 249, cgroup v2): `systemctl --user freeze/thaw` works on
 * a transient worker unit; a FIFO the unit holds read-write stays open across writers coming and
 * going, and input written while frozen is delivered on thaw.
 *
 * Switch: plugin config `transport` ("pipe" | "file"), env TINKERCLAW_BRIDGE_TRANSPORT wins; the
 * default stays "pipe" until the file transport has been verified live.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

export type BridgeTransport = "pipe" | "file";

let transport: BridgeTransport = "pipe";

export function resolveBridgeTransport(configured: unknown): BridgeTransport {
  const env = process.env.TINKERCLAW_BRIDGE_TRANSPORT?.trim().toLowerCase();
  const raw = env || (typeof configured === "string" ? configured.trim().toLowerCase() : "");
  return raw === "file" ? "file" : "pipe";
}

export function setBridgeTransport(t: BridgeTransport): void {
  transport = t;
}

export function getBridgeTransport(): BridgeTransport {
  return transport;
}

/**
 * The unit's shell. `exec 0<>` opens the FIFO read-write (never blocks, never EOF). claude is NOT
 * exec'd: the shell outlives it to record the exit status. The TERM/INT/HUP trap is a handler, not
 * an ignore, so claude still gets the default action (an ignored signal would be inherited).
 */
export const WORKER_SHELL =
  'trap "true" TERM INT HUP; exec 0<>"$TC_WORKER_DIR/in" 1>>"$TC_WORKER_DIR/out" 2>>"$TC_WORKER_DIR/err"; ' +
  '"$@"; code=$?; printf "%s" "$code" > "$TC_WORKER_DIR/exit.tmp"; mv -f "$TC_WORKER_DIR/exit.tmp" "$TC_WORKER_DIR/exit"; exit "$code"';

export function workersRoot(): string {
  const runtime = process.env.XDG_RUNTIME_DIR?.trim();
  return runtime
    ? path.join(runtime, "tinkerclaw-workers")
    : path.join(os.tmpdir(), `tinkerclaw-workers-${process.getuid?.() ?? "u"}`);
}

export function workerDirFor(unit: string): string {
  return path.join(workersRoot(), unit);
}

// ── meta ─────────────────────────────────────────────────────────────────────────────────────────

export type WorkerTurnMeta = {
  /** Byte offset in `out` where this turn's output begins: the replay starts here. */
  startOffset: number;
  startedAt: number;
};

export type WorkerMeta = {
  version: 1;
  unit: string;
  /** The pool key (`tinker-sp-…`). */
  sessionKey: string;
  openclawSessionKey?: string;
  openclawSessionId?: string;
  cliSessionId?: string;
  model?: string;
  thinkLevel?: string;
  cwd: string;
  systemPromptFile?: string | null;
  createdAt: number;
  /** The turn in flight, or null between turns. */
  turn: WorkerTurnMeta | null;
  /** Set while a restart holds the unit frozen. */
  frozenAt?: number | null;
};

export function readWorkerMeta(dir: string): WorkerMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as WorkerMeta;
    return meta?.version === 1 &&
      typeof meta.unit === "string" &&
      typeof meta.sessionKey === "string"
      ? meta
      : null;
  } catch {
    return null;
  }
}

export function writeWorkerMeta(dir: string, meta: WorkerMeta): void {
  try {
    const tmp = path.join(dir, "meta.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, "meta.json"));
  } catch {
    // a missing meta only costs the reattach: the next boot then treats the unit as a stray
  }
}

/** Make the worker's dir, FIFO and empty output files. Throws when the FIFO cannot be made. */
export function prepareWorkerDir(unit: string): string {
  const dir = workerDirFor(unit);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fifo = path.join(dir, "in");
  const made = spawnSync("mkfifo", ["-m", "600", fifo], { stdio: "ignore" });
  if (made.status !== 0 || !fs.statSync(fifo).isFIFO()) {
    throw new Error(`could not create the worker stdin FIFO at ${fifo}`);
  }
  fs.writeFileSync(path.join(dir, "out"), "", { flag: "a", mode: 0o600 });
  fs.writeFileSync(path.join(dir, "err"), "", { flag: "a", mode: 0o600 });
  return dir;
}

export function removeWorkerDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // tmpfs: gone at logout anyway
  }
}

/** A shell exit status as (code, signal): 128+n is "killed by signal n". */
export function exitStatusToCodeSignal(status: number | null): {
  code: number | null;
  signal: NodeJS.Signals | null;
} {
  if (status === null || !Number.isFinite(status)) {
    return { code: null, signal: null };
  }
  if (status > 128) {
    const n = status - 128;
    const name = Object.entries(os.constants.signals).find(([, v]) => v === n)?.[0];
    if (name) {
      return { code: null, signal: name as NodeJS.Signals };
    }
  }
  return { code: status, signal: null };
}

// ── units ────────────────────────────────────────────────────────────────────────────────────────

export type UnitCommand = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export const systemctlUser: UnitCommand = (args) =>
  new Promise((resolve) => {
    execFile("systemctl", ["--user", ...args], { timeout: 15_000 }, (err, stdout) =>
      resolve({ ok: !err, stdout: String(stdout ?? "") }),
    );
  });

export type UnitState = { active: boolean; frozen: boolean };

export async function readUnitState(
  unit: string,
  run: UnitCommand = systemctlUser,
): Promise<UnitState> {
  const r = await run(["show", "-p", "ActiveState", "-p", "FreezerState", unit]);
  const props = Object.fromEntries(
    r.stdout
      .split("\n")
      .map((l) => l.split("="))
      .filter((kv) => kv.length === 2),
  ) as Record<string, string>;
  const activeState = props.ActiveState ?? "";
  return {
    active: activeState === "active" || activeState === "activating" || activeState === "reloading",
    frozen: props.FreezerState === "frozen" || props.FreezerState === "freezing",
  };
}

// ── tails ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Follow an append-only file from a byte offset. Reads are synchronous: the files are on tmpfs,
 * and a synchronous read can never race a second reader of the same offset.
 */
export class FileTail {
  private fd: number | null = null;
  private watcher: fs.FSWatcher | null = null;
  private readonly buf = Buffer.allocUnsafe(64 * 1024);

  constructor(
    private readonly file: string,
    public offset: number,
    private readonly sink: (chunk: Buffer) => void,
  ) {}

  start(): void {
    if (this.fd !== null) {
      return;
    }
    this.fd = fs.openSync(this.file, "r");
    try {
      this.watcher = fs.watch(this.file, () => this.pump());
      this.watcher.on("error", () => undefined);
    } catch {
      // the channel's poll still pumps
    }
    this.pump();
  }

  get started(): boolean {
    return this.fd !== null;
  }

  /** Read everything written so far. */
  pump(): void {
    if (this.fd === null) {
      return;
    }
    for (;;) {
      let n = 0;
      try {
        n = fs.readSync(this.fd, this.buf, 0, this.buf.length, this.offset);
      } catch {
        return;
      }
      if (n <= 0) {
        return;
      }
      this.offset += n;
      this.sink(Buffer.from(this.buf.subarray(0, n)));
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = null;
    }
  }
}

// ── the channel ──────────────────────────────────────────────────────────────────────────────────

const POLL_MS = 250;
const UNIT_CHECK_MS = 10_000;

/**
 * The file transport, shaped like the ChildProcess the pipe transport hands the worker: `stdin`,
 * `stdout`, `stderr`, `kill()`, and an `exit` event. The worker's line handling is the same for both.
 */
export class FileChannel extends EventEmitter {
  readonly stdin: net.Socket;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined = undefined;
  private readonly outTail: FileTail;
  private readonly errTail: FileTail;
  private poll: NodeJS.Timeout | null = null;
  private unitCheck: NodeJS.Timeout | null = null;
  private inactiveChecks = 0;
  private finished = false;
  private detached = false;
  frozen = false;

  private constructor(
    readonly unit: string,
    readonly dir: string,
    stdoutFrom: number | null,
    private readonly run: UnitCommand,
  ) {
    super();
    // O_RDWR: never blocks on a FIFO and never sees EPIPE; the unit's exit is watched instead.
    const fd = fs.openSync(path.join(dir, "in"), fs.constants.O_RDWR);
    this.stdin = new net.Socket({ fd, readable: false, writable: true });
    this.outTail = new FileTail(path.join(dir, "out"), stdoutFrom ?? 0, (b) =>
      this.stdout.write(b),
    );
    this.errTail = new FileTail(path.join(dir, "err"), fileSize(path.join(dir, "err")), (b) =>
      this.stderr.write(b),
    );
    this.errTail.start();
    if (stdoutFrom !== null) {
      this.outTail.start();
    }
    this.poll = setInterval(() => this.tick(), POLL_MS);
    this.poll.unref?.();
    this.unitCheck = setInterval(() => void this.checkUnit(), UNIT_CHECK_MS);
    this.unitCheck.unref?.();
  }

  /** Start a unit on the file transport and attach to it. `argv` is systemd-run's argv. */
  static async spawn(params: {
    unit: string;
    dir: string;
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    run?: UnitCommand;
  }): Promise<FileChannel> {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      const child = spawn("systemd-run", params.argv, {
        cwd: params.cwd,
        env: params.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        stderr += c;
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`systemd-run exited ${code}: ${stderr.trim().slice(0, 500)}`)),
      );
    });
    return new FileChannel(params.unit, params.dir, 0, params.run ?? systemctlUser);
  }

  /**
   * Attach to a unit an earlier gateway started. `stdoutFrom` null leaves stdout closed until
   * `startStdout` (an adopted turn is replayed only once a run is there to take it).
   */
  static attach(
    unit: string,
    dir: string,
    stdoutFrom: number | null,
    run: UnitCommand = systemctlUser,
  ): FileChannel {
    return new FileChannel(unit, dir, stdoutFrom, run);
  }

  /** Current size of the output file: where a turn that starts now begins. */
  outSize(): number {
    return fileSize(path.join(this.dir, "out"));
  }

  /** Stream stdout from `offset` (the replay of an adopted turn). */
  startStdout(offset: number): void {
    if (this.outTail.started) {
      return;
    }
    this.outTail.offset = offset;
    this.outTail.start();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.finished || this.detached) {
      return false;
    }
    void (async () => {
      if (this.frozen) {
        await this.thaw();
      }
      await this.run(["kill", `--signal=${signal}`, this.unit]);
    })();
    return true;
  }

  async freeze(): Promise<boolean> {
    const r = await this.run(["freeze", this.unit]);
    this.frozen = this.frozen || r.ok;
    return r.ok;
  }

  async thaw(): Promise<boolean> {
    const r = await this.run(["thaw", this.unit]);
    if (r.ok) {
      this.frozen = false;
    }
    return r.ok;
  }

  /** Let go of the unit without stopping it: the gateway is going, the worker stays for the next. */
  detach(): void {
    if (this.finished || this.detached) {
      return;
    }
    this.detached = true;
    this.stopWatching();
    this.stdin.destroy();
  }

  private tick(): void {
    this.outTail.pump();
    this.errTail.pump();
    if (fs.existsSync(path.join(this.dir, "exit"))) {
      this.finish(readExitStatus(this.dir));
    }
  }

  private async checkUnit(): Promise<void> {
    if (this.finished || this.detached) {
      return;
    }
    const state = await readUnitState(this.unit, this.run);
    // Two misses in a row: a unit killed whole (the OOM killer, a manual stop of the unit) leaves no
    // exit file, and one miss can be a unit that is still starting.
    this.inactiveChecks = state.active ? 0 : this.inactiveChecks + 1;
    if (this.inactiveChecks >= 2) {
      this.finish(null);
    }
  }

  private finish(status: number | null): void {
    if (this.finished || this.detached) {
      return;
    }
    this.finished = true;
    // Everything the worker wrote reaches the line reader BEFORE the exit: a `result` line in the
    // file must settle its turn, not be beaten by the exit that follows it.
    this.outTail.pump();
    this.errTail.pump();
    this.stopWatching();
    this.stdin.destroy();
    const { code, signal } = exitStatusToCodeSignal(status);
    let pending = 2;
    let emitted = false;
    const emitExit = () => {
      if (emitted) {
        return;
      }
      emitted = true;
      removeWorkerDir(this.dir);
      this.emit("exit", code, signal);
    };
    const onEnd = () => {
      pending -= 1;
      if (pending === 0) {
        emitExit();
      }
    };
    this.stdout.once("end", onEnd);
    this.stderr.once("end", onEnd);
    this.stdout.end();
    this.stderr.end();
    // A stream nobody reads never ends; the exit must not wait for it.
    setTimeout(emitExit, 500).unref?.();
  }

  private stopWatching(): void {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    if (this.unitCheck) {
      clearInterval(this.unitCheck);
      this.unitCheck = null;
    }
    this.outTail.stop();
    this.errTail.stop();
  }
}

/** Bytes the worker in `dir` has written to stdout so far. */
export function workerOutSize(dir: string): number {
  return fileSize(path.join(dir, "out"));
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readExitStatus(dir: string): number | null {
  try {
    const n = Number.parseInt(fs.readFileSync(path.join(dir, "exit"), "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ── ownership (an in-process restart keeps this process's workers) ───────────────────────────────

const OWNED_KEY = Symbol.for("openclaw.bridgeOwnedUnits");

/** Units a live worker of THIS process drives; a boot scan never adopts them twice. */
export function ownedUnits(): Set<string> {
  const g = globalThis as Record<symbol, Set<string> | undefined>;
  let s = g[OWNED_KEY];
  if (!s) {
    s = new Set();
    g[OWNED_KEY] = s;
  }
  return s;
}
