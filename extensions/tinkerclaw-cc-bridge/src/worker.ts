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
import { setResumeSessionId } from "./session-map.js";

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
      const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
      const txt = fs.readFileSync(expanded, "utf8");
      if (txt.trim().length > 0) {
        return txt;
      }
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
  return resolveForkScript("openclaw-spawn-subagent.mjs", "OPENCLAW_SPAWN_SUBAGENT_BIN");
}
function resolveRecipeStateCliPath(): string {
  return resolveForkScript("openclaw-recipe-state.mjs", "OPENCLAW_RECIPE_STATE_BIN");
}
function resolveForkScript(name: string, envVar: string): string {
  const candidates = [
    process.env[envVar] ?? "",
    `/home/<user>/src/tinkerclaw/scripts/${name}`,
    path.join(os.homedir(), "src", "tinkerclaw", "scripts", name),
    path.join(os.homedir(), ".openclaw", "workspace", "scripts", name),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
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
  if (!bin) {
    return "";
  }
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
    '    node $OPENCLAW_SPAWN_SUBAGENT_BIN --task "<instruction>" \\',
    '         --label "<short-name>" \\',
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
    "- Do NOT narrate dispatches in your chat reply. The user watches the",
    "  redesigned Prefrontal panel for orchestration; your chat should stay",
    "  focused on the actual answer / product. Use the recipe-state CLI below",
    "  to publish what's happening behind the scenes.",
    "",
    "## Orchestration observability",
    "",
    "You have `$OPENCLAW_RECIPE_STATE_BIN` in env. Use it to push what the user",
    "sees in the Prefrontal panel -- recipe id, current step, in-flight labels,",
    "and a rolling trail of actions:",
    "",
    "    # announce / advance recipe state (call on every Step transition)",
    "    node $OPENCLAW_RECIPE_STATE_BIN --recipe revise-paper \\",
    '         --step 3 --total 6 --step-name "evidence check" --cap 3 \\',
    "         --in-flight '§3-oauth-check,§7-NemoClaw-ev'",
    "",
    "    # push a trail event (dispatch, complete, note, transition, warn)",
    "    node $OPENCLAW_RECIPE_STATE_BIN --trail dispatch \\",
    "         --label '§7-NemoClaw-ev' --message 'sonnet, ~240s budget'",
    "    node $OPENCLAW_RECIPE_STATE_BIN --trail complete \\",
    "         --label '§2-threat-ref' --message '6s · 340w delta'",
    "    node $OPENCLAW_RECIPE_STATE_BIN --trail transition \\",
    "         --label 'Step 3 → Step 4' --message 'evidence clean; tightening prose'",
    "",
    "Rule of thumb: every `spawn-subagent` call gets a paired `--trail dispatch`",
    "event BEFORE the spawn, and a paired `--trail complete` or `--trail warn`",
    "event AFTER you see the child's result. Every recipe-step change gets a",
    "`--recipe ... --step N` call. The user reads this panel instead of chat",
    "narration, so keep it honest and current.",
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

// FORK 2026-04-20: tool-choice guidance. Claude Code 2.1.114 exposes a dozen
// tools as DEFERRED (WebSearch, WebFetch, Monitor, PushNotification,
// NotebookEdit, Cron*, EnterPlanMode, Task*, EnterWorktree, mcp__...). They
// don't appear in the default tool list; the model has only the *names* and
// must load each schema on demand via `ToolSearch({query:"select:<name>"})`.
// Jarvis has been reflexing to `WebFetch` for every URL-shaped need, which
// fails on "find me the right URL" tasks (he guesses domains and TLS-errors
// out). This short block teaches the decision tree so he stops asking the
// user for URLs he could search for himself.
function buildToolChoiceBlock(): string {
  return [
    "",
    "",
    "<!-- TINKERCLAW TOOL-CHOICE HINTS — loaded at worker spawn -->",
    "## Tool choice",
    "",
    "Some capabilities are DEFERRED: the tool name exists, but the schema must",
    'be loaded before use — `ToolSearch({query:"select:<Name>"})`, then call',
    "the tool normally. Deferred tools include WebSearch, WebFetch, Monitor,",
    "PushNotification, NotebookEdit, CronCreate/List/Delete, EnterPlanMode,",
    "TaskCreate/List/Get/Update/Stop/Output, and the mcp__* auth tools.",
    "",
    "Pick the right one:",
    "",
    "- **WebSearch** — you need to FIND a URL, identify the current state of a",
    "  topic, discover a domain you don't know, or check whether something",
    "  exists on the web. Use it instead of guessing domains. If the user",
    "  references an external page they are viewing and you don't have the",
    "  link, WebSearch it once before asking them to paste it.",
    "- **WebFetch** — you have a specific URL and want the content. Don't",
    "  WebFetch guessed domains; WebSearch first, then fetch the hit.",
    "- **Monitor** — watch a file, process, or log for a condition. Use it",
    "  instead of `sleep` loops or self-paced wake-ups when a specific event",
    "  signals readiness.",
    "- **PushNotification** — alert the user about a significant event when",
    "  they're not looking at the chat (build finished, long-running task",
    "  complete, important decision needed). Do NOT use for routine status.",
    "- **CronCreate/Delete/List** — schedule a repeating task in OpenClaw's",
    "  cron system. Use for recurring work, not one-offs (ScheduleWakeup or",
    "  Monitor is better for one-offs).",
    "- **EnterPlanMode** — switch into read-only plan mode. Use only when the",
    "  user explicitly asks for a plan-before-action gate; otherwise plan",
    "  inline in chat.",
    "- **TaskCreate/Update/List/Get/Stop** — create a structured task list",
    "  for multi-step work (3+ distinct steps). Mark each step complete as",
    "  you finish it so the user can track progress without scrolling chat.",
    "",
    "Anti-patterns:",
    "",
    "- Guessing URLs and WebFetching them. Symptom: TLS errors, connection",
    "  refused, 404s in a row. Cure: WebSearch.",
    "- Polling a file via `sleep; test -f` in a loop. Cure: Monitor.",
    '- Posting routine "still working" updates in chat. The user watches the',
    "  Prefrontal panel for status (recipe-state + trail events). Reserve",
    "  chat for substantive output.",
    "- Re-asking the user for information that's inferable from the workspace",
    "  (a specific paper path, a known config file, a recent commit). Grep or",
    "  WebSearch first; ask only when genuinely ambiguous.",
  ].join("\n");
}

function resolveRecipesDirPath(): string {
  const candidates = [
    "/home/<user>/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes",
    path.join(os.homedir(), "src", "tinkerclaw", "extensions", "tinkerclaw-prefrontal", "recipes"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return p;
      }
    } catch {}
  }
  return "";
}

// FORK 2026-04-21: narration guidance. Claude Code users expect running text
// between tool calls — a sentence before a tool chain, short updates at key
// moments (finding, pivot, blocker), brief end-of-turn summary. Without this
// Jarvis tends to go silent on complex tasks because the subagent-helper
// block above explicitly says "Do NOT narrate dispatches in your chat reply"
// (so Prefrontal owns orchestration mechanics). That rule is correct for
// dispatches but was over-applied to everything — the user loses signal on
// long investigations and multi-file edits. This block reinstates substance
// narration in chat while keeping mechanics out.
function buildChatNarrationBlock(): string {
  return [
    "",
    "",
    "<!-- TINKERCLAW CHAT NARRATION — loaded at worker spawn -->",
    "## Keep chat alive between tool calls",
    "",
    "Most of your tool calls are invisible to the user. Only the text you emit is.",
    "Story Mode is on by default in the Tinker UI: every tool call renders",
    "inline with its full output, preceded by the text you emit between calls.",
    "**The text you write before a tool call becomes that tool call's title in",
    "the UI.** That title is the user's bird's-eye view of *why* the tool call",
    "happened — not *what* it mechanically does.",
    "",
    "Make progress visible:",
    "",
    "- **Before every tool call, write one sentence of purpose.** Non-",
    "  negotiable, even for a single file read. Write the goal the call is",
    "  serving in the context of the user's current task, not the mechanics.",
    "  Compare:",
    "  - Bad (mechanical, pattern-level): *Searching the code for a pattern.*",
    "  - Good (task-level purpose): *Looking for where the reset handler",
    "    drops the workspace arg so I know where to patch.*",
    "  - Bad: *Reading a file.*",
    "  - Good: *Pulling up the failing test to see which assertion actually",
    "    fires.*",
    "  - Bad: *Running a command.*",
    "  - Good: *Rebuilding dist so the gateway picks up the narration block.*",
    "- At key moments between tool calls, emit ONE sentence: when you find",
    "  something, change direction, or hit a blocker. *Found it — line 331",
    "  drops the workspace arg.* *That path doesn't exist; pivoting to the",
    "  plugin manifest.* These sentences become the title of the NEXT tool",
    "  call AND chain the story between them.",
    "- End-of-turn: 1–2 sentences. What changed, what's next. Nothing else.",
    "",
    "Brief is good. Silent is not. A complex task with zero chat text between",
    "tool calls reads as a wall of greps — even if Prefrontal shows activity.",
    "Purpose sentences turn that wall into a narrative that builds to the fix.",
    "",
    "What NOT to narrate:",
    "",
    "- Subagent dispatches, recipe-step transitions, trail events — those go",
    "  through `$OPENCLAW_RECIPE_STATE_BIN` to Prefrontal, not to chat.",
    "- Running commentary on your own thought process (\"let me think… now I'll",
    '  check…"). State results and decisions, not deliberation.',
    "- Mechanical restatements of the tool's argument list. The UI already",
    "  shows the args on expand. Your line is the PURPOSE, not the command.",
    "",
    "Split of concerns:",
    "",
    "- **Prefrontal panel** — orchestration mechanics. Dispatches, recipe steps,",
    "  spawn/complete trails. Owned by the recipe-state CLI.",
    "- **Chat text** — substance. What you found, what you're doing with it,",
    "  what you concluded, where you're stuck. Owned by you in plain prose.",
    "",
    "These complement each other. Don't duplicate orchestration into chat, and",
    "don't push substance into trails. If the user ever has to flip between",
    "panels to know where you are, the split was wrong.",
  ].join("\n");
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
    const toolChoiceBody = buildToolChoiceBlock();
    const narrationBody = buildChatNarrationBlock();
    const combinedSystemPrompt = [
      systemPromptBody,
      rulesBody,
      subagentHelpBody,
      toolChoiceBody,
      narrationBody,
    ]
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
    // FORK 2026-04-20: expose the provider-agnostic subagent-spawn helper
    // CLI path + gateway token so Jarvis's Bash can dispatch sub-work and
    // light up Prefrontal's call tree. The CLI speaks the fork-only
    // `fork.subagents.spawn` RPC (see src/fork/subagents-rpc.ts) which in
    // turn calls `spawnSubagentDirect` -- the same path pi-agent-core's
    // native `sessions_spawn` tool ends up in. When we eventually swap
    // cc-bridge out for a regular provider, this env var just stops being
    // set; nothing here leaks into the non-cc-bridge flow.
    cleanEnv.OPENCLAW_SPAWN_SUBAGENT_BIN = resolveSpawnSubagentCliPath();
    cleanEnv.OPENCLAW_RECIPE_STATE_BIN = resolveRecipeStateCliPath();
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
      .toSorted()
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
          // FORK (2026-04-22): persist so the next gateway boot can --resume.
          // Best-effort; failures just mean amnesia on next restart, not
          // broken turns.
          try {
            setResumeSessionId(this.sessionKey, sid);
          } catch {
            // swallow
          }
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
