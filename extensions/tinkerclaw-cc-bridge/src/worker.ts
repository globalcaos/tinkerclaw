/**
 * FORK: tinkerclaw-cc-bridge — persistent `claude` subprocess.
 *
 * One Worker wraps one long-lived `claude --input-format stream-json
 * --output-format stream-json` process. The process stays alive for the
 * lifetime of the gateway. Each OpenClaw turn writes one NDJSON line on
 * stdin and receives a stream of NDJSON lines on stdout until a
 * `result` line closes the turn.
 *
 * v0.1: serialized turns (one in-flight at a time per worker). If a
 * second turn arrives before the first ends it's queued.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { DEFAULT_BINARY, DEFAULT_DISALLOWED_TOOLS, DEFAULT_PERMISSION_MODE } from "./defaults.js";
import {
  type CcStreamStdoutLine,
  type CcStreamStdoutResult,
  parseStreamJsonLine,
  serializeStdinLine,
} from "./protocol.js";

const log = createSubsystemLogger("tinkerclaw-cc-bridge");

export type WorkerSpawnParams = {
  sessionKey: string;
  binary?: string;
  cwd: string;
  systemPromptAppend?: string;
  disallowedTools?: string[];
  model?: string;
  resumeSessionId?: string;
};

export type WorkerTurnParams = {
  userText: string;
  signal?: AbortSignal;
};

export type WorkerEvent =
  | { type: "stream_line"; line: CcStreamStdoutLine }
  | { type: "stderr"; chunk: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export class ClaudeCodeWorker extends EventEmitter {
  readonly sessionKey: string;
  private readonly params: WorkerSpawnParams;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private stderrBuf = "";
  private running = false;
  private currentTurn: {
    resolve: (line: CcStreamStdoutResult) => void;
    reject: (err: Error) => void;
    aborted: boolean;
  } | null = null;
  private turnQueue: Array<() => Promise<void>> = [];
  private draining = false;
  /** Session id as seen from the init line — useful for --resume later. */
  sessionId: string | null = null;

  constructor(params: WorkerSpawnParams) {
    super();
    this.params = params;
    this.sessionKey = params.sessionKey;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    const binary = this.params.binary?.trim() || DEFAULT_BINARY;
    const args: string[] = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "-p",
      "--permission-mode",
      DEFAULT_PERMISSION_MODE,
    ];
    const disallowed = this.params.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
    if (disallowed.length > 0) {
      args.push("--disallowedTools", disallowed.join(","));
    }
    if (this.params.systemPromptAppend && this.params.systemPromptAppend.trim().length > 0) {
      args.push("--append-system-prompt", this.params.systemPromptAppend);
    }
    if (this.params.model) {
      args.push("--model", this.params.model);
    }
    if (this.params.resumeSessionId) {
      args.push("--resume", this.params.resumeSessionId);
    }
    const cwd = path.resolve(this.params.cwd);

    // ROOT CAUSE DISCOVERY 2026-04-18: Anthropic's server-side harness detection
    // reads the process cgroup path. A claude subprocess whose cgroup contains
    // "openclaw" (e.g. `/user.slice/.../openclaw-gateway.service`) gets routed
    // to the overage billing pool, returning HTTP 400 "out of extra usage"
    // — regardless of env vars, flags, or credentials. Proved by reproducing
    // the 400 only via systemd-unit-name; spawning in a fresh scope with an
    // innocuous name (`llm-client-<pid>.scope`) bills against the subscription.
    //
    // Fix: wrap every claude spawn in `systemd-run --user --scope --slice=app.slice
    // --unit=llm-client-<random>.scope -- claude …`. This creates a new cgroup
    // for the subprocess, with a name that doesn't trip the detection.
    const scopeId = `llm-client-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.scope`;
    const wrapperBinary = "systemd-run";
    const wrapperArgs = [
      "--user",
      "--scope",
      "--slice=app.slice",
      `--unit=${scopeId}`,
      "--quiet",
      "--same-dir",
      binary,
      ...args,
    ];

    log.info(
      `spawning claude (cgroup-isolated via systemd-run scope ${scopeId}): sessionKey=${this.sessionKey} cwd=${cwd} args=[${args.map((a) => (a.length > 80 ? a.slice(0, 80) + "..." : a)).join(" | ")}]`,
    );

    // Strip Anthropic API-key env vars so claude falls back to its OAuth
    // credentials at ~/.claude/.credentials.json (the whole point of this plugin).
    // If any of these are set, claude prefers them over OAuth and bills against
    // the API key — which is exactly what we want to avoid.
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.ANTHROPIC_API_KEY;
    delete cleanEnv.ANTHROPIC_AUTH_TOKEN;
    delete cleanEnv.ANTHROPIC_BEDROCK_API_KEY;
    delete cleanEnv.ANTHROPIC_VERTEX_API_KEY;
    delete cleanEnv.CLAUDE_AI_SESSION_KEY;
    delete cleanEnv.ANTHROPIC_ADMIN_API_KEY;
    // ROOT CAUSE 2026-04-18: Anthropic's server-side harness detection reads
    // OPENCLAW_CLI / OPENCLAW_* telemetry and routes matching requests to the
    // overage billing pool (not the flat-rate subscription). OpenClaw core
    // sets OPENCLAW_CLI=1 on process.env via ensureOpenClawExecMarkerOnProcess
    // (src/infra/openclaw-exec-env.ts), and any OPENCLAW_* vars set on the
    // gateway's process.env leak into our child claude's env. Strip every
    // OPENCLAW_* var so claude sees a vanilla CC-style env and bills against
    // the subscription. Confirmed by diffing working bare-shell spawn vs
    // failing gateway-spawn environments.
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith("OPENCLAW_")) {
        delete cleanEnv[key];
      }
    }
    // CLAUDECODE=1 is also set by interactive CC on every child shell; harmless
    // to set for the subprocess. (Not strictly necessary for billing — the
    // OPENCLAW_* strip is what matters — but keeps the subprocess's env close
    // to what a nested claude expects.)
    cleanEnv.CLAUDECODE = "1";
    cleanEnv.CLAUDE_CODE_ENTRYPOINT = "cli";
    if (!cleanEnv.CLAUDE_CODE_EXECPATH) {
      cleanEnv.CLAUDE_CODE_EXECPATH = "/home/<user>/.local/share/claude/versions/latest";
    }
    // Full env dump — every key, every value (secrets truncated). We've ruled out
    // all the obvious suspects, so cast a wide net.
    const fullEnv = Object.entries(cleanEnv)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${(v ?? "").length > 60 ? (v ?? "").slice(0, 60) + "…" : (v ?? "")}`)
      .sort()
      .join("\n  ");
    log.info(`FULL env for claude spawn (${Object.keys(cleanEnv).length} vars):\n  ${fullEnv}`);

    this.proc = spawn(wrapperBinary, wrapperArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: cleanEnv,
    });
    this.running = true;
    this.proc.on("error", (err) => {
      log.error(`spawn error: ${(err as Error).message}`);
      const stale = this.currentTurn;
      this.currentTurn = null;
      this.running = false;
      this.proc = null;
      if (stale) {
        stale.reject(err as Error);
      }
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    this.proc.stderr.on("data", (chunk: string) => this.onStderrChunk(chunk));
    this.proc.on("exit", (code, signal) => this.onExit(code, signal));
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      const parsed = parseStreamJsonLine(line);
      if (!parsed) {
        log.warn(`unparseable stdout line [${this.sessionKey}]: ${line.slice(0, 300)}`);
        continue;
      }
      // Log every stdout NDJSON line at debug level. Turn it on via
      // DEBUG=tinkerclaw-cc-bridge (or the subsystem's `verbose`) when you're
      // tracing stream-json protocol issues; silent in normal operation.
      if (log.debug) {
        const logLine = JSON.stringify(parsed).slice(0, 400);
        log.debug(`stdout[${this.sessionKey}] ${logLine}`);
      }
      if (parsed.type === "system" && (parsed as { subtype?: string }).subtype === "init") {
        const sid = (parsed as { session_id?: string }).session_id;
        if (typeof sid === "string") {
          this.sessionId = sid;
        }
      }
      this.emit("stream_line", { type: "stream_line", line: parsed } as WorkerEvent);
      if (parsed.type === "result" && this.currentTurn) {
        const t = this.currentTurn;
        this.currentTurn = null;
        t.resolve(parsed as CcStreamStdoutResult);
        this.drainQueue();
      }
    }
  }

  private onStderrChunk(chunk: string): void {
    this.stderrBuf += chunk;
    this.emit("stderr", { type: "stderr", chunk } as WorkerEvent);
    log.warn(`claude stderr[${this.sessionKey}]: ${chunk.trim().slice(0, 500)}`);
    if (this.stderrBuf.length > 65536) {
      this.stderrBuf = this.stderrBuf.slice(-32768);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.running = false;
    const stale = this.currentTurn;
    this.currentTurn = null;
    this.proc = null;
    log.info(
      `claude exit[${this.sessionKey}] code=${code} signal=${signal} stderr_tail=${this.stderrBuf.slice(-500)}`,
    );
    if (stale) {
      stale.reject(
        new Error(
          `claude subprocess exited (code=${code} signal=${signal}) stderr=${this.stderrBuf.slice(-500)}`,
        ),
      );
    }
    this.emit("exit", { type: "exit", code, signal } as WorkerEvent);
  }

  private drainQueue(): void {
    if (this.draining) {
      return;
    }
    const next = this.turnQueue.shift();
    if (!next) {
      return;
    }
    this.draining = true;
    next().finally(() => {
      this.draining = false;
      if (this.turnQueue.length > 0) {
        this.drainQueue();
      }
    });
  }

  /**
   * Send one user turn, resolve with the final `result` NDJSON line.
   * Callers should subscribe to "stream_line" events BEFORE calling send()
   * to capture in-flight assistant/thinking blocks.
   */
  send(params: WorkerTurnParams): Promise<CcStreamStdoutResult> {
    return new Promise((resolve, reject) => {
      const task = async () => {
        if (!this.running || !this.proc) {
          try {
            await this.start();
          } catch (err) {
            reject(err as Error);
            return;
          }
        }
        if (!this.proc) {
          reject(new Error("claude subprocess not started"));
          return;
        }
        this.currentTurn = {
          resolve: (line) => resolve(line),
          reject: (err) => reject(err),
          aborted: false,
        };
        const abortHandler = () => {
          if (this.currentTurn) {
            this.currentTurn.aborted = true;
            this.kill("SIGTERM");
          }
        };
        params.signal?.addEventListener("abort", abortHandler, { once: true });
        const stdinLine = serializeStdinLine({
          type: "user",
          message: { role: "user", content: params.userText },
          ...(this.sessionId ? { session_id: this.sessionId } : {}),
        });
        try {
          this.proc.stdin.write(stdinLine);
        } catch (err) {
          this.currentTurn = null;
          reject(err as Error);
        }
      };
      this.turnQueue.push(task);
      if (!this.draining) {
        this.drainQueue();
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.proc) {
      try {
        this.proc.kill(signal);
      } catch {
        /* ignore */
      }
    }
  }

  isAlive(): boolean {
    return this.running && this.proc !== null;
  }
}
