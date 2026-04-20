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
import fs from "node:fs";
import os from "node:os";
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

// FORK 2026-04-18: read the amygdala + fractal prompt .md files at spawn
// time and append their FULL text to the system prompt. Keeps the per-turn
// UI injection tiny ("follow your system-prompt rules") while giving Opus
// the actual rule text in its permanent context. Read once per worker
// spawn; cost paid only on the ~12s cold-start, not per turn.
const PROMPT_FILES: Array<{ label: string; paths: string[] }> = [
  {
    label: "amygdala",
    paths: [
      "/home/<user>/src/tinkerclaw/extensions/tinkerclaw-learned-intuition/amygdala-prompt.md",
    ],
  },
  {
    label: "fractal",
    paths: [
      "/home/<user>/src/tinkerclaw/extensions/tinkerclaw-fractal-reflection/fractal-prompt.md",
    ],
  },
];
function readPromptFile(paths: string[]): string | null {
  for (const p of paths) {
    try {
      const expanded = p.startsWith("~/")
        ? path.join(os.homedir(), p.slice(2))
        : p;
      const txt = fs.readFileSync(expanded, "utf8");
      if (txt.trim().length > 0) return txt;
    } catch {
      /* try next */
    }
  }
  return null;
}
// FORK 2026-04-20: locate the scripts/openclaw-spawn-subagent.mjs CLI.
// Tries a few known positions so this works from both the bundled gateway
// (dist/index.js) and the dev-loop ts-node run. Returns "" if not found so
// the env var simply isn't exported.
function resolveSpawnSubagentCliPath(): string {
  const candidates = [
    process.env.OPENCLAW_SPAWN_SUBAGENT_BIN ?? "",
    "/home/<user>/src/tinkerclaw/scripts/openclaw-spawn-subagent.mjs",
    path.join(os.homedir(), "src", "tinkerclaw", "scripts", "openclaw-spawn-subagent.mjs"),
    path.join(os.homedir(), ".openclaw", "workspace", "scripts", "openclaw-spawn-subagent.mjs"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return "";
}

// FORK 2026-04-20: read the gateway auth token from ~/.openclaw/openclaw.json.
// The CLI can read this itself but passing it through env keeps the cc-bridge
// → CLI hop cheap and survives config relocations.
function readGatewayTokenFromConfig(): string {
  try {
    const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      gateway?: { auth?: { token?: string }; controlUi?: { auth?: { token?: string } } };
    };
    return cfg?.gateway?.auth?.token ?? cfg?.gateway?.controlUi?.auth?.token ?? "";
  } catch {
    return "";
  }
}

// FORK 2026-04-20: one short system-prompt paragraph teaching Jarvis how to
// spawn OpenClaw subagents from inside cc-bridge (where his native tool set
// is only Bash/Read/Write/Edit/Grep/Glob). This writes the same kind of hint
// a normal pi-agent-core run would get from the sessions_spawn tool
// description -- intentionally brief to stay out of Opus's way. Skipped if
// the CLI binary isn't locatable at worker spawn time.
function buildSubagentHelperBlock(): string {
  const bin = resolveSpawnSubagentCliPath();
  if (!bin) return "";
  const recipesDir = resolveRecipesDirPath();
  return [
    "",
    "",
    "<!-- TINKERCLAW SUBAGENT HELPER -- loaded at worker spawn -->",
    "## Spawning subagents",
    "",
    "When a task is big enough that a parallel sub-run would help (long research,",
    "multi-file refactor, independent audit, section-by-section paper revision),",
    "dispatch it to an OpenClaw subagent so Prefrontal can track it and the user",
    "sees live progress in the panel.",
    "",
    "Invoke via Bash:",
    "",
    "    node $OPENCLAW_SPAWN_SUBAGENT_BIN --task \"<instruction>\" \\",
    "         --label \"<short-name>\" \\",
    "         [--model claude-code/claude-opus-4-7] \\",
    "         [--thinking medium] \\",
    "         [--timeout 600] \\",
    "         --json",
    "",
    "The CLI prints one JSON object with `childSessionKey` and `runId` on stdout.",
    "Use `--json` when you want to parse it; drop it for a human-readable line.",
    "",
    "The helper speaks the fork's WS RPC `fork.subagents.spawn`, which wraps the",
    "same `spawnSubagentDirect` path OpenClaw's native `sessions_spawn` tool uses.",
    "Prefrontal's `subagent_spawning` hook fires automatically, so the panel will",
    "light up as soon as the child starts. When the current harness is swapped",
    "for a regular LLM provider (anthropic/openai/etc) the native sessions_spawn",
    "tool takes over automatically — you don't need to rewrite orchestration code.",
    "",
    "Guidelines:",
    "- Only spawn when it actually parallelizes. Small tasks stay inline.",
    "- Prefer `claude-code/claude-haiku-4-5` for minimal tasks (lookups, format),",
    "  `claude-code/claude-sonnet-4-6` for standard, `claude-code/claude-opus-4-7`",
    "  only for genuinely hard reasoning.",
    "- Always pass a short `--label` so the Prefrontal tree is readable.",
    "- Narrate orchestration out loud in your reply ('dispatching §2 to sonnet,",
    "  §7 to sonnet, §12 to opus') so the user can follow your meta-reasoning",
    "  while the tree populates.",
    ...(recipesDir
      ? [
          "",
          "## Recipes (structured playbooks)",
          "",
          `A catalog of hand-written orchestration recipes lives at ${recipesDir}.`,
          "Each recipe is a markdown file with YAML frontmatter (schema=recipe/1.0)",
          "and numbered Steps, Constraints, Safety Notes, and Failures Overcome.",
          "When the user's task matches a recipe's `triggers`, READ the recipe",
          "FIRST, use its Steps as the skeleton of your plan, and reference the",
          "recipe id in your orchestration narration so the user can follow the",
          "same playbook. Key catalog entries:",
          "",
          "- `writing/revise-paper.md` — paper improvement pass (structure audit,",
          "  evidence check, prose tightening, fresh additions, final pass).",
          "- `writing/write-paper.md`, `writing/brainstorm.md`, `writing/write-plan.md`",
          "- `coding/{code-review,debug,feature,refactor,plan,verify}.md`",
          "- `analysis/{investigate,dependency-analysis}.md`",
          "- See `recipes/CATALOG.md` for the full index.",
          "",
          "Recipes are PLAYBOOKS, not executable code. Combine them with the",
          "subagent helper: dispatch each Step in a recipe to its own subagent",
          "when the Step is independent and parallelizable, execute sequentially",
          "otherwise.",
        ]
      : []),
  ].join("\n");
}

function resolveRecipesDirPath(): string {
  const candidates = [
    "/home/<user>/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes",
    path.join(
      os.homedir(),
      "src",
      "tinkerclaw",
      "extensions",
      "tinkerclaw-prefrontal",
      "recipes",
    ),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch {}
  }
  return "";
}

function buildAppendedPromptRules(): string {
  const blocks: string[] = [];
  for (const entry of PROMPT_FILES) {
    const body = readPromptFile(entry.paths);
    if (!body) {
      log.warn(`prompt rule file missing for "${entry.label}" — tried ${entry.paths.join(", ")}`);
      continue;
    }
    blocks.push(
      `\n\n<!-- TINKERCLAW ${entry.label.toUpperCase()} RULES — loaded at worker spawn -->\n` +
        body.trim(),
    );
  }
  return blocks.join("\n\n");
}

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
    // FORK 2026-04-18: also append the amygdala + fractal rule files so
    // Opus always has the rules in context — the per-turn UI injection
    // can then just say "do sections A→B→C per your rules" without
    // restating all 100 lines of each file.
    const systemPromptBody = (this.params.systemPromptAppend ?? "").trim();
    const rulesBody = buildAppendedPromptRules();
    const subagentHelpBody = buildSubagentHelperBlock();
    const combinedSystemPrompt = [systemPromptBody, rulesBody, subagentHelpBody]
      .filter(Boolean)
      .join("");
    if (combinedSystemPrompt.length > 0) {
      args.push("--append-system-prompt", combinedSystemPrompt);
    }
    if (this.params.model) {
      args.push("--model", this.params.model);
    }
    if (this.params.resumeSessionId) {
      args.push("--resume", this.params.resumeSessionId);
    }
    const cwd = path.resolve(this.params.cwd);

    log.info(
      `spawning claude: sessionKey=${this.sessionKey} binary=${binary} cwd=${cwd} args=[${args.map((a) => (a.length > 80 ? a.slice(0, 80) + "..." : a)).join(" | ")}]`,
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
    // FORK 2026-04-20: expose the provider-agnostic subagent-spawn helper
    // CLI path + gateway token so Jarvis's Bash can dispatch sub-work and
    // light up Prefrontal's call tree. The CLI speaks the fork-only
    // `fork.subagents.spawn` RPC (see src/fork/subagents-rpc.ts) which in
    // turn calls `spawnSubagentDirect` -- the same path pi-agent-core's
    // native `sessions_spawn` tool ends up in. When we eventually swap
    // cc-bridge out for a regular provider, this env var just stops being
    // set; nothing here leaks into the non-cc-bridge flow.
    cleanEnv.OPENCLAW_SPAWN_SUBAGENT_BIN = resolveSpawnSubagentCliPath();
    const gatewayToken = readGatewayTokenFromConfig();
    if (gatewayToken) {
      cleanEnv.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
    }
    cleanEnv.OPENCLAW_GATEWAY_URL = cleanEnv.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
    // Full env dump — every key, every value (secrets truncated). We've ruled out
    // all the obvious suspects, so cast a wide net.
    const fullEnv = Object.entries(cleanEnv)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${(v ?? "").length > 60 ? (v ?? "").slice(0, 60) + "…" : (v ?? "")}`)
      .sort()
      .join("\n  ");
    log.info(`FULL env for claude spawn (${Object.keys(cleanEnv).length} vars):\n  ${fullEnv}`);

    this.proc = spawn(binary, args, {
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
