/**
 * FORK: tinkerclaw-tinker-bridge — persistent `claude` subprocess.
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
import { noteWorkerExit, noteWorkerSpawn } from "openclaw/plugin-sdk/fork-telemetry";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { amygdalaSettingsArgs } from "./amygdala-settings.js";
import { type ChildStreamsLike, guardChildStreams } from "./child-stream-guards.js";
import { extractCliCommand } from "./cli-command.js";
import {
  AMYGDALA_CC_HOOK_SETTINGS_PATH,
  AMYGDALA_JEV_EFFECTIVE_SETTINGS_PATH,
  AMYGDALA_JEV_HOOK_SETTINGS_PATH,
  DEFAULT_BINARY,
  DEFAULT_DISALLOWED_TOOLS,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_PLUGIN_DIRS,
  RESUME_MAX_TRANSCRIPT_BYTES,
  maxOutputTokensFor,
} from "./defaults.js";
import {
  readMaterializedMoralCode,
  resolveCorePluginDir,
  transcriptHasMoralCode,
} from "./moral-code-delivery.js";
import { loadPromptFile } from "./prompt-loader.js";
import {
  type CcStreamStdoutLine,
  type CcStreamStdoutResult,
  parseStreamJsonLine,
  serializeStdinLine,
} from "./protocol.js";
import { forgetResumeSessionId, setResumeSessionId } from "./session-map.js";
import {
  thalamusSpawnExtras,
  leafModelOwnerText,
  subagentModelOwnerText,
} from "./thalamus-worker-seam.js";
import { thinkLevelToMaxThinkingTokens } from "./thinking-budget.js";
import {
  isTranscriptOversized,
  resolveTranscriptPath,
  transcriptExists,
} from "./transcript-path.js";
import {
  newUnpromptedTurnId,
  parseUnpromptedWakeMarker,
  requestUnpromptedWake,
  type TaskNotice,
} from "./unprompted-turn.js";
import {
  FileChannel,
  getBridgeTransport,
  ownedUnits,
  prepareWorkerDir,
  removeWorkerDir,
  systemctlUser,
  type UnitCommand,
  WORKER_SHELL,
  type WorkerMeta,
  workerOutSize,
  type WorkerTurnMeta,
  writeWorkerMeta,
} from "./worker-transport.js";

/** Is a restart draining right now? (core's restart-drain.ts global key; an extension may not import it) */
function restartDrainActive(): boolean {
  const s = (globalThis as Record<symbol, { active?: boolean } | undefined>)[
    Symbol.for("openclaw.restartDrain")
  ];
  return s?.active === true;
}

/** How a restart drain left one worker (holdAtBoundary). */
export type WorkerHoldVerdict = "held" | "ended" | "unfinished" | "idle" | "pipe";

const log = createSubsystemLogger("tinkerclaw-tinker-bridge");

/** How long an early empty `result` waits for turn activity before it ends a silent turn. */
export const EARLY_EMPTY_RESULT_HOLD_MS = 45_000;
/** Stream lines that show the CLI is working the current prompt. */
const TURN_ACTIVITY_TYPES = new Set(["assistant", "user", "stream_event"]);

/**
 * FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost]): how long a turn the CLI started on
 * its own, and finished, keeps its worker busy while it waits for the run that takes it
 * (unprompted-turn.ts). Past it the pool may reap the worker again; the wake normally lands in
 * seconds, and its retries end within a minute.
 */
export const UNPROMPTED_KEEP_MS = 30 * 60_000;
const NOTICE_CAP = 10;
const TASK_DESCRIPTION_CAP = 64;

/** An empty `result` printed before the CLI did anything: no turns, no error, no text. */
export function isEarlyEmptyResult(r: CcStreamStdoutResult): boolean {
  return r.num_turns === 0 && !r.is_error && !(r.result ?? "").trim();
}

/**
 * FORK 2026-08-19 — NUL quarantine for the spawn argv.
 *
 * Node's `spawn` REFUSES any argv entry containing a NUL ("The argument
 * 'args[45]' must be a string without null bytes") and throws BEFORE the child
 * exists, so the worker dies fatally and the user sees "Provider error — I'm
 * retrying" on a loop that can never succeed.
 *
 * We do not choose to send that byte. `--append-system-prompt` carries the
 * persona plus whatever the session transcript replays into it, and an agent
 * that once READ a file containing a NUL owns that byte in its history
 * permanently — fixing the file does not un-poison the transcript. The
 * `--setenv=` values ride the same argv and inherit the same exposure, which is
 * why this runs over the WHOLE array and not just the prompt argument.
 *
 * MEASURED by decoding the base36 timestamp out of every distinct `err_*` id
 * that carried this message: 49 fatal spawn deaths spread over 2026-08-06 (8),
 * 08-07 (1), 08-09 (7), 08-10 (1), 08-13 (2), 08-16 (3) and 08-18 (27).
 *
 * READ THAT DISTRIBUTION BEFORE BLAMING A FILE. The 08-18 spike does have a
 * single identifiable cause — three commits shipped a literal NUL as the
 * separator in board-types.ts's `stableItemId`, and the byte outlived the
 * same-day correction in 197 transcript copies — but the twenty-two failures
 * BEFORE it did not come from that file. NULs reach transcripts from whatever
 * an agent happens to read, on no schedule, from sources that will not be
 * enumerable in advance. That is precisely why the fix belongs at this boundary
 * and not in any one source file: chasing the emitter is unbounded work,
 * tolerating the byte here is four lines.
 *
 * (Counting method matters here: counting forensic dumps that MENTION the
 * message gave 34 and was wrong in both directions — once an error is delivered
 * into a session, every later dump of that session quotes it, while a single
 * dump can quote dozens of distinct failures. Count identities, not files.)
 *
 * A NUL carries no meaning in a prompt or an env value, so dropping it costs
 * nothing where it lands and the alternative is no child process at all. The
 * count is returned rather than swallowed: a number that keeps rising means
 * something upstream is writing binary into a text field, which is a real bug
 * even though this makes it survivable.
 */
export function stripNulBytesFromArgv(argv: string[]): { argv: string[]; stripped: number } {
  const NUL = "\u0000";
  let stripped = 0;
  const cleaned = argv.map((a) => {
    if (!a.includes(NUL)) {
      return a;
    }
    stripped += a.split(NUL).length - 1;
    return a.split(NUL).join("");
  });
  return { argv: cleaned, stripped };
}

/**
 * FORK 2026-09-22 — the system prompt goes by FILE, not argv.
 *
 * Linux caps a SINGLE argv entry at MAX_ARG_STRLEN = 131072 bytes. The combined
 * persona + rules prompt sits at ~97–106k CHARS on a normal day, and emoji /
 * accented text push its UTF-8 byte count past the cap: the turn then dies with
 * `spawn E2BIG` before the child exists (tab "Enable Opus 4.8 picker",
 * 2026-09-22 08:29 — 96,858 chars yet over the byte limit). The failure is
 * deterministic for that payload, so no retry can help.
 *
 * `claude --append-system-prompt-file` reads the same text from disk and has no
 * such cap. The file is private (0600, in a 0700 dir) and removed when the child
 * exits. Returns null on any write failure so the caller can fall back to the
 * argv route — a tmp-disk hiccup must never mute the brain.
 */
export function writeSystemPromptFile(sessionKey: string, prompt: string): string | null {
  try {
    const dir = path.join(os.tmpdir(), "tinkerclaw-sysprompt");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeKey = sessionKey.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    const file = path.join(
      dir,
      `${safeKey}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.md`,
    );
    // NUL is harmless in a file but meaningless in a prompt; drop it here too so
    // both delivery routes carry identical text.
    fs.writeFileSync(file, prompt.split("\u0000").join(""), { encoding: "utf8", mode: 0o600 });
    return file;
  } catch (err) {
    log.warn(`system-prompt file write failed (${(err as Error).message}) — falling back to argv`);
    return null;
  }
}

function removeSystemPromptFile(file: string | null): void {
  if (!file) {
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone — nothing to do
  }
}

// FORK 2026-04-18 (paths de-hardcoded 2026-04-28 per bible §5.76):
// read the amygdala + fractal prompt .md files at spawn time and append
// their FULL text to the system prompt. Keeps the per-turn UI injection
// tiny ("follow your system-prompt rules") while giving the model the
// actual rule text in its permanent context. Read once per worker spawn;
// cost paid only on the ~12s cold-start, not per turn.
//
// Resolution order per bible §5.76 (config → workspace → bundled):
//   1. env var override                  (TINKERCLAW_AMYGDALA_PROMPT etc.)
//   2. ~/.openclaw/workspace/<name>.md   (user override, outside repo)
//   3. $OPENCLAW_BUNDLED_PLUGINS_DIR/<plugin>/<name>.md  (runtime bundle)
//   4. ~/src/tinkerclaw/extensions/<plugin>/<name>.md   (dev clone)
//   5. relative to this module's __dirname              (npm-style install)
function resolvePromptFile(plugin: string, file: string, envVar: string): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    candidates.push(fromEnv);
  }
  candidates.push(path.join(os.homedir(), ".openclaw", "workspace", file));
  const bundleRoot = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  if (bundleRoot) {
    candidates.push(path.join(bundleRoot, plugin, file));
  }
  candidates.push(path.join(os.homedir(), "src", "tinkerclaw", "extensions", plugin, file));
  candidates.push(path.join(__dirname, "..", "..", plugin, file));
  return candidates;
}
const PROMPT_FILES: Array<{ label: string; paths: string[] }> = [
  // FORK 2026-06-07: amygdala-prompt.md no longer loaded — the per-turn 🧠 AMYGDALA
  // section was removed (it reported on inert ensembles; the live panel is the
  // feedback loop). Fractal stays.
  {
    label: "fractal",
    paths: resolvePromptFile(
      "tinkerclaw-fractal-reflection",
      "fractal-prompt.md",
      "TINKERCLAW_FRACTAL_PROMPT",
    ),
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
// FORK 2026-06-11: locate scripts/openclaw-orchestrate.mjs — the dynamic-workflow
// CLI (prefrontal.recipe.orchestrate wrapper). Lets the disposition prompt teach
// Jarvis to fan out parallel/pipeline workflows of subscription-billed tinker-sp-*
// units (a STANDING capability, not gated behind any effort tier).
function resolveOrchestrateCliPath(): string {
  return resolveForkScript("openclaw-orchestrate.mjs", "OPENCLAW_ORCHESTRATE_BIN");
}
function resolveForkScript(name: string, envVar: string): string {
  // FORK 2026-04-28 (bible §5.76): no hardcoded absolute home paths.
  // Order: env override → bundled scripts dir (production via
  // OPENCLAW_BUNDLED_PLUGINS_DIR's parent) → ~/src/tinkerclaw clone (dev) →
  // workspace-side script override.
  const bundleRoot = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  const candidates = [
    process.env[envVar] ?? "",
    bundleRoot ? path.join(bundleRoot, "..", "scripts", name) : "",
    path.join(os.homedir(), "src", "tinkerclaw", "scripts", name),
    path.join(os.homedir(), ".openclaw", "workspace", "scripts", name),
    path.join(__dirname, "..", "..", "..", "scripts", name),
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

// FORK 2026-04-20 (extracted to prompts/subagent-helper.md 2026-04-28 per
// bible §5.76): one short system-prompt block teaching how to spawn
// OpenClaw subagents from inside tinker-bridge (where the native tool set is
// only Bash / Read / Write / Edit / Grep / Glob). The content lives in a
// markdown file under `prompts/`; this function only resolves the runtime
// CLI paths and asks the loader to substitute them. Skipped if the spawn
// CLI is not locatable at worker spawn time.
function buildSubagentHelperBlock(): string {
  const bin = resolveSpawnSubagentCliPath();
  if (!bin) {
    return "";
  }
  const recipeBin = resolveRecipeStateCliPath();
  const recipesDir = resolveRecipesDirPath();
  return loadPromptFile({
    plugin: "tinkerclaw-tinker-bridge",
    subdir: "prompts",
    file: "subagent-helper.md",
    envVar: "TINKERCLAW_SUBAGENT_HELPER_PROMPT",
    substitutions: {
      SPAWN_SUBAGENT_BIN: bin,
      RECIPE_STATE_BIN: recipeBin || "<not-installed>",
      RECIPES_DIR: recipesDir || "<not-installed>",
      MODEL_CHOICE_OWNER: subagentModelOwnerText(),
    },
  });
}

// (Subagent helper content moved to prompts/subagent-helper.md — see
// loadPromptFile call above. Inline content removed 2026-04-28.)

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
  return loadPromptFile({
    plugin: "tinkerclaw-tinker-bridge",
    subdir: "prompts",
    file: "tool-choice.md",
    envVar: "TINKERCLAW_TOOL_CHOICE_PROMPT",
  });
}

function resolveRecipesDirPath(): string {
  // FORK 2026-04-28 (bible §5.76): no hardcoded absolute home paths.
  // Order: env override → workspace recipes dir (user-added recipes) →
  // bundled prefrontal recipes (shipped catalog) → ~/src clone (dev).
  const bundleRoot = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  const candidates = [
    process.env.TINKERCLAW_RECIPES_DIR ?? "",
    path.join(os.homedir(), ".openclaw", "workspace", "recipes"),
    bundleRoot ? path.join(bundleRoot, "tinkerclaw-prefrontal", "recipes") : "",
    path.join(os.homedir(), "src", "tinkerclaw", "extensions", "tinkerclaw-prefrontal", "recipes"),
    path.join(__dirname, "..", "..", "tinkerclaw-prefrontal", "recipes"),
  ].filter(Boolean);
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
  return loadPromptFile({
    plugin: "tinkerclaw-tinker-bridge",
    subdir: "prompts",
    file: "narration-contract.md",
    envVar: "TINKERCLAW_NARRATION_PROMPT",
  });
}

// (Narration content moved to prompts/narration-contract.md — see
// loadPromptFile call above. Inline content removed 2026-04-28.)

// FORK 2026-05-13: plan-tools guidance. Phases 1-3 shipped the
// `prefrontal.plan.{set,step,get,close}` RPCs + restart auto-continue, but
// Jarvis had no system-prompt instruction telling him to use them. This block
// teaches the decision rule: any request with 3+ steps → call
// `prefrontal.plan.set` first, mark progress, close when done. Without this
// Jarvis defaults to TodoWrite (disabled) or inline narration, and the plan
// board stays empty on complex turns.
function buildPlanToolsBlock(): string {
  return loadPromptFile({
    plugin: "tinkerclaw-tinker-bridge",
    subdir: "prompts",
    file: "plan-tools.md",
    envVar: "TINKERCLAW_PLAN_TOOLS_PROMPT",
  });
}

// FORK 2026-05-29: orchestration-disposition advisory block. Maps task classes
// to quality kits (adversarial-verify, judge-panel, completeness-critic,
// multi-modal-sweep, loop-until-dry) so the agent picks the right kit without
// being told each time. Advisory — no code enforces it. Inserted immediately
// after ethical-rules (foundational layer) and before narration (mechanics),
// so the disposition is framed as intent rather than procedure.
// Resolution order (per loadPromptFile defaults):
//   1. env var TINKERCLAW_ORCHESTRATION_DISPOSITION_PROMPT
//   2. extensions/tinkerclaw-tinker-bridge/prompts/orchestration-disposition.md (bundled)
function buildOrchestrationDispositionBlock(): string {
  const orchestrateBin = resolveOrchestrateCliPath();
  return loadPromptFile({
    plugin: "tinkerclaw-tinker-bridge",
    subdir: "prompts",
    file: "orchestration-disposition.md",
    envVar: "TINKERCLAW_ORCHESTRATION_DISPOSITION_PROMPT",
    workspaceFile: false, // generic kit-class → kit mapping; no workspace override
    substitutions: {
      ORCHESTRATE_BIN: orchestrateBin || "<not-installed>",
      LEAF_MODEL_OWNER: leafModelOwnerText(),
    },
  });
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
  /**
   * FORK 2026-06-11: per-session think level (e.g. `off` | `think` |
   * `think_hard` | `ultrathink`). Mapped to Claude Code's native
   * `MAX_THINKING_TOKENS` env knob at spawn (see `thinkLevelToMaxThinkingTokens`);
   * `off`/undefined omits the var entirely so the CLI keeps its own default.
   */
  thinkLevel?: string;
  resumeSessionId?: string;
  /**
   * FORK 2026-05-04: extra plugin directories to load. Each becomes
   * `--plugin-dir <path>` on claude-cli's command line. Defaults to the
   * jarvis-skills wrapper that re-exports `~/.openclaw/workspace/skills/`
   * as a plugin (see `DEFAULT_PLUGIN_DIRS`).
   */
  pluginDirs?: string[];
  /**
   * FORK 2026-05-10: openclaw-side agent session id (the `sessionId` field
   * of the OpenClaw session entry, e.g. `adf1152b-…`). Persisted alongside
   * the claude-cli sessionId in `session-map.json` so the worker pool can
   * fall back to looking up by openclaw sessionId when the tinker-bridge
   * sessionKey hash drifts across an interrupted-then-resumed turn. See
   * `getLatestResumeSessionIdByOpenclawSessionId`.
   */
  openclawSessionId?: string;
  /**
   * FORK 2026-05-30: openclaw-side CANONICAL session key (e.g.
   * `agent:main:main`), distinct from the tinker-bridge `sessionKey` hash
   * (`tinker-sp-<hash>`). Exported to the child as `TC_SESSION_KEY` so the
   * `jarvis` voice binary can (a) gate speech to the home session and
   * (b) route its `**Jarvis:**` bubble via `chat.inject` — both need the
   * canonical key, NOT the worker-pool hash. See jarvis-voice SKILL.md.
   */
  openclawSessionKey?: string;
};

export type WorkerTurnParams = {
  userText: string;
  signal?: AbortSignal;
  /**
   * FORK 2026-10-01 (TINKER_UI_DESIGN_BIBLE/bug-log.md [chat-divergence], cause 4): the gateway
   * run this turn belongs to. On the file transport it is recorded in meta.json beside the turn's
   * start, so that after a restart the run that takes the turn can name it (frozenTurn).
   */
  runId?: string;
};

/**
 * FORK 2026-10-01 (bug-log [chat-divergence], cause 4) — the turn meta.json records
 * (worker-transport.ts WorkerTurnMeta) plus the run it belongs to. After a restart the turn is
 * taken by a run with a NEW id and replayed from its first byte; the old id is how the webchat
 * finds that turn's prompt on its page. Optional: a meta written before the field reads as unknown.
 */
export type WorkerTurnMetaWithRun = WorkerTurnMeta & { runId?: string };

export type WorkerEvent =
  | { type: "stream_line"; line: CcStreamStdoutLine }
  | { type: "stderr"; chunk: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

/**
 * FORK 2026-09-03 (SIGTERM cause attribution) — carry WHY the child was killed.
 *
 * At least seven unrelated causes end a turn with the identical
 * `signal=SIGTERM`: the user's Stop button (`AbortError: Reply operation
 * aborted by user`), a gateway restart drain (`Reply operation aborted for
 * restart`), the run wall-clock deadline (`TimeoutError: request timed out`),
 * the LLM idle timeout (`LLM idle timeout (300s): no response from model`),
 * budget exhaustion (`budget-exhausted`), `sessions_yield`, and the fast-fail
 * init-stall abort in stream.ts. Downstream they were indistinguishable, so
 * `src/fork/error-envelope.ts` classified ALL of them as "Gateway restarted —
 * I'm resuming it automatically". For six of the seven BOTH halves are false:
 * nothing restarted, nothing resumes, and the user has to type "keep going".
 *
 * DELIBERATELY NOT A TAXONOMY HERE. This module transports the cause text
 * verbatim; `src/fork/error-envelope.ts` is its single owner and is unit-tested
 * against the exact producer strings above. A duplicate enum on both sides of
 * the extension boundary (`src/**` can never be imported from `extensions/**`)
 * would drift silently the first time an upstream abort message is reworded.
 *
 * The channel is the `onExit` rejection message — the string that becomes the
 * envelope's `raw`. It already crosses worker -> stream -> envelope, so it needs
 * no new plumbing and no intermediate layer can drop it.
 */
function formatKillCause(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return "";
  }
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Error
        ? `${raw.name}: ${raw.message}`
        : String(raw);
  // `]` would close the `reason=[…]` delimiter early and newlines would break
  // the single-line log shape. 200 chars is far more than any producer emits.
  return text
    .replace(/[\r\n\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export class ClaudeCodeWorker extends EventEmitter {
  readonly sessionKey: string;
  /**
   * FORK 2026-06-11: the think level this worker was SPAWNED with (the value of
   * `params.thinkLevel` at construction). The worker pool reads this to detect a
   * warm/idle worker that was spawned with a now-stale thinking budget and
   * recycle it, so a later turn requesting a different think level doesn't reuse
   * a child whose `MAX_THINKING_TOKENS` env was baked in at the previous spawn.
   */
  readonly thinkLevel?: string;
  private readonly params: WorkerSpawnParams;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private stderrBuf = "";
  private running = false;
  /** Per-spawn system-prompt file (see writeSystemPromptFile); removed on exit. */
  private systemPromptFile: string | null = null;
  /** Moral code owed to a resumed conversation that predates tinkerclaw-core (sent once). */
  private pendingMoralCodePrefix: string | null = null;
  private currentTurn: {
    resolve: (line: CcStreamStdoutResult) => void;
    reject: (err: Error) => void;
    aborted: boolean;
    /** The CLI has produced turn activity (assistant, tool or stream lines) for this turn. */
    active?: boolean;
    /** An early empty `result` held back, see EARLY_EMPTY_RESULT_HOLD_MS. */
    heldEmpty?: { line: CcStreamStdoutResult; timer: ReturnType<typeof setTimeout> };
  } | null = null;
  private turnQueue: Array<() => Promise<void>> = [];
  private draining = false;
  /**
   * FORK 2026-09-03: the cause text of the FIRST kill of the CURRENT turn.
   * Reset per TURN (in `send()`, where `currentTurn` is assigned) and NOT per
   * child: the pool keeps workers warm across many turns (worker-pool.ts), so a
   * per-child reset would let one turn's cause be reported on a later,
   * unrelated turn — e.g. a fast-fail kill that lost its race, then reported
   * against the next turn the user stopped by hand.
   */
  private lastKillCause: string | null = null;
  /**
   * FORK 2026-09-25 (TINKER_UI_DESIGN_BIBLE/logging.md §4.9): the systemd unit of the CURRENT child
   * (`tinkerclaw-worker-…`, also its worker_id), the unit whose exit was last reported, and the
   * turns this child has answered. The worker-resources sampler charts the UNIT's cgroup — never
   * `proc.pid`, which is the systemd-run wrapper, not claude.
   */
  private unitId: string | null = null;
  private exitReportedUnitId: string | null = null;
  private turnsServed = 0;
  /** FORK 2026-10-01: when the child last printed a stdout line (see `lastActivityAt`). */
  private lastStdoutAt = 0;
  /**
   * FORK 2026-09-30 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b): the FILE transport
   * (worker-transport.ts), null on the pipe. Its meta mirrors to `<dir>/meta.json` whatever a new
   * gateway needs to adopt this worker; `callOpen` is true while a TOP-LEVEL API call streams, and
   * `pendingTurn` is an adopted turn a restart froze, waiting for a run to take it (resumeTurn).
   */
  private channel: FileChannel | null = null;
  private meta: WorkerMeta | null = null;
  private callOpen = false;
  private boundaryWaiters: Array<() => void> = [];
  private pendingTurn: WorkerTurnMetaWithRun | null = null;
  /**
   * FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost], unprompted-turn.ts): what the CLI
   * does between the bridge's turns. `bgTasks` are its live background tasks (Bash in the
   * background, Workflow, Monitor), from `background_tasks_changed`; `notices` the tasks it said
   * ended while no turn was open; `unprompted` a turn it started on its own, kept line by line
   * until a run takes it (takeUnpromptedTurn) or a prompt joins it (send).
   */
  private bgTasks = new Map<string, string>();
  private taskDescriptions = new Map<string, string>();
  private notices: TaskNotice[] = [];
  private unprompted: {
    id: string;
    lines: unknown[];
    startedAt: number;
    result: CcStreamStdoutResult | null;
    finishedAt: number;
  } | null = null;
  private strayActivityLogged = false;
  /** Session id as seen from the init line — useful for --resume later. */
  sessionId: string | null = null;

  /**
   * FORK 2026-10-02: the directory the CLI runs in, which names its transcript's projects/ folder
   * (transcript-path.ts). stream.ts reads that transcript to itemise each call (cli-context.ts).
   */
  get cwd(): string {
    return this.params.cwd;
  }

  constructor(params: WorkerSpawnParams) {
    super();
    this.params = params;
    this.sessionKey = params.sessionKey;
    this.thinkLevel = params.thinkLevel;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    // FORK 2026-09-03: a respawn must not inherit the PREVIOUS child's stderr
    // tail. That tail is appended to the exit message this fork now makes
    // load-bearing for diagnosis, so a stale one pairs a fresh cause with an
    // unrelated error (and can re-trigger the dead-resume purge below on an id
    // the new child never mentioned).
    this.stderrBuf = "";
    const binary = this.params.binary?.trim() || DEFAULT_BINARY;
    const args: string[] = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      // FORK 2026-05-23 — without this flag, claude-cli only emits
      // `assistant` NDJSON lines at content-block boundaries (one big
      // chunk per text block). That means the Tinker UI sees the answer
      // arrive all at once at the END of the turn instead of token-by-
      // token. With `--include-partial-messages`, claude-cli emits fine-
      // grained `stream_event` lines (content_block_delta.text_delta),
      // which stream.ts already routes through pushTextDelta() → the
      // gateway's state:"delta" broadcast → the UI's _temporary bubble
      // append path → real-time streaming with the splitSectionedReply /
      // renderSectionedReply pipeline producing the answer/amygdala/
      // fractal three-bubble structure incrementally as the model emits.
      "--include-partial-messages",
      "--verbose",
      "-p",
      "--permission-mode",
      DEFAULT_PERMISSION_MODE,
    ];
    // FORK 2026-06-11 (AMYGDALA v3.1): when the learned-intuition extension has
    // hook enforcement on it writes this claude-cli settings file (and deletes it
    // when off). Its presence wires the amygdala pre-execution PreToolUse hook,
    // which synchronously DENIES destructive-execution AEGIS rules inside
    // claude-cli — real enforcement on the primary runner, even under
    // bypassPermissions. Absent → no extra flag, identical behavior.
    // FORK 2026-09-29 (digital amygdala C5): the new plugin's files, when present, may replace
    // the v3.1 file as the single --settings (amygdala-settings.ts); with none of them present
    // this is exactly the v3.1 behaviour above.
    args.push(
      ...amygdalaSettingsArgs(
        {
          v31: AMYGDALA_CC_HOOK_SETTINGS_PATH,
          next: AMYGDALA_JEV_HOOK_SETTINGS_PATH,
          effective: AMYGDALA_JEV_EFFECTIVE_SETTINGS_PATH,
        },
        (p) => {
          try {
            return fs.statSync(p);
          } catch {
            return null;
          }
        },
      ),
    );
    const disallowed = this.params.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
    if (disallowed.length > 0) {
      args.push("--disallowedTools", disallowed.join(","));
    }
    // FORK 2026-05-04: claude-code only loads skills from PLUGINS, not from
    // `${cwd}/.claude/skills/`. Workspace skills live at
    // `~/.openclaw/workspace/skills/<name>/SKILL.md` (88 of them, including
    // outlook-hack and teams-hack). A wrapper at `~/.openclaw/jarvis-plugins/
    // jarvis-skills/skills` symlinks to that dir so the layout matches the
    // plugin spec (`<plugin-root>/skills/<name>/SKILL.md`). Each --plugin-dir
    // is one plugin root; repeatable. Without this Jarvis literally couldn't
    // see outlook-hack or teams-hack — he answered the user with "no Outlook
    // connector wired up" because his skill catalog was empty.
    const pluginDirs = this.params.pluginDirs ?? DEFAULT_PLUGIN_DIRS;
    for (const dir of pluginDirs) {
      const trimmed = dir?.trim();
      if (trimmed) {
        args.push("--plugin-dir", trimmed);
      }
    }
    // FORK 2026-09-22: tinkerclaw-core delivers the moral code once per conversation
    // (SessionStart: startup | clear | compact). See moral-code-delivery.ts.
    const corePluginDir = resolveCorePluginDir();
    if (corePluginDir) {
      args.push("--plugin-dir", corePluginDir);
    } else {
      log.warn(
        "tinkerclaw-core Claude Code plugin not found — moral code falls back to the system prompt",
      );
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
    const planToolsBody = buildPlanToolsBlock();
    const orchestrationDispositionBody = buildOrchestrationDispositionBlock();
    // FORK 2026-09-20 — MECHANISM A REMOVED (de-evasion). Deliberate, on the record.
    //
    // This block used to slice the system prompt at a "You are a personal
    // assistant running inside OpenClaw" sentinel and drop everything after it.
    // The rationale, stated verbatim in the comment this replaces, was that the
    // appended harness catalog is "exactly the fingerprint Anthropic's
    // server-side classifier uses to route requests to the metered overage
    // pool", and that stripping it "makes Jarvis bill the subscription again".
    //
    // That is removing truthful harness identity in order to change how the
    // provider classifies and bills the request. It is evasion, not privacy,
    // and no reframing of the switch changes its causal purpose. Removed.
    //
    // Standing rule for this bridge: ADD our own identity (the persona block),
    // NEVER SUBTRACT harness identity. Billing follows whatever Anthropic's
    // classifier honestly determines from what we actually send. A genuine
    // privacy feature redacts the USER's data (PII, secrets, local paths,
    // hostnames) — never the client/harness identity that bears on
    // authorization, enforcement or billing.
    //
    // The prior behaviour and this correction are both kept in git history on
    // purpose: the fix is published as loudly as the original.
    const personaOnly = systemPromptBody;
    // The "## Your Role" re-extraction below existed ONLY to rescue a spawned
    // subagent's task from the strip above (OpenClaw places it after the
    // sentinel, so the strip dropped it and subagents woke with no task). With
    // nothing stripped, that block is already present in systemPromptBody, so
    // re-appending it would duplicate the task. Kept as an empty no-op for the
    // downstream concatenation.
    const subagentRoleBlock = "";
    void rulesBody;
    // FORK 2026-04-27: order matters. Put the narration block RIGHT AFTER the
    // persona, before the dense subagent-helper / tool-choice text. When
    // narration was last in the chain Jarvis read 5–6 KB of subagent
    // mechanics first and reached the narration directive after the framing
    // was set, then defaulted to claude-cli's stock "execute tools quietly"
    // behaviour. Hoisting it makes the grandma-proof bar one of the first
    // rules the model considers, so each tool call gets a real pre-call
    // sentence.
    // FORK 2026-05-21: ethical-rules block goes immediately after the persona
    // and BEFORE narration / subagent / tool-choice / plan-tools. Reasons: (1)
    // the persona answers "who I am" and the ethical-rules answer "what I will
    // and won't do" — those belong adjacent in the system prompt so the model
    // reads them as one foundational layer before mechanics. (2) Asimov-style
    // priority means later blocks must defer to earlier ones; putting ethical
    // rules ahead of narration etc. makes that ordering match document order.
    const combinedSystemPrompt = [
      personaOnly,
      subagentRoleBlock ? `\n\n${subagentRoleBlock}\n` : "",
      // FORK 2026-09-22: the moral code (ethical rules, objectives, starter kit) no longer
      // rides every spawn's system prompt — see moral-code-delivery.ts. Only when the
      // tinkerclaw-core plugin is missing does it fall back to this position.
      corePluginDir ? "" : `\n\n${readMaterializedMoralCode()}`,
      orchestrationDispositionBody,
      narrationBody,
      subagentHelpBody,
      toolChoiceBody,
      planToolsBody,
    ]
      .filter(Boolean)
      .join("");
    if (combinedSystemPrompt.length > 0) {
      // By file: an argv entry over 128 KB kills the spawn with E2BIG.
      // See writeSystemPromptFile.
      removeSystemPromptFile(this.systemPromptFile);
      this.systemPromptFile = writeSystemPromptFile(this.sessionKey, combinedSystemPrompt);
      if (this.systemPromptFile) {
        args.push("--append-system-prompt-file", this.systemPromptFile);
      } else {
        args.push("--append-system-prompt", combinedSystemPrompt);
      }
    }
    // FORK 2026-09-30 (THALAMUS v4 D5): a registered worker provider may add `--agents`, a per-spawn model and
    // environment. With none registered `thalamusExtras` is empty and nothing below differs from before.
    const thalamusExtras = thalamusSpawnExtras({
      sessionKey: this.sessionKey,
      model: this.params.model,
    });
    const spawnModel = thalamusExtras.model ?? this.params.model;
    if (spawnModel) {
      args.push("--model", spawnModel);
    }
    args.push(...thalamusExtras.args);
    const cwd = path.resolve(this.params.cwd);
    if (!fs.existsSync(cwd)) {
      // Node reports a missing cwd as `spawn systemd-run ENOENT`, naming the wrong culprit.
      throw new Error(
        `claude-code cwd does not exist: ${cwd} — create it or set plugins.entries.tinkerclaw-tinker-bridge.config.cwd`,
      );
    }
    if (this.params.resumeSessionId) {
      // FORK 2026-06-23 (oversized-resume guard): a fat transcript wedges the
      // brain — `claude --resume` stalls parsing 14.5–15.3MB of history, emits
      // no stream events, and the idle watchdog SIGTERMs the worker before the
      // turn starts. If the on-disk transcript is over RESUME_MAX_TRANSCRIPT_BYTES
      // we SKIP --resume and start FRESH. CRITICAL fail-open: any stat/path
      // error falls through to a NORMAL resume (the catch swallows it and we
      // still push --resume) — a guard bug must never mute the brain. We do NOT
      // touch the session-map; the next persisted sessionId overwrites naturally.
      let skipResume = false;
      try {
        const transcriptPath = resolveTranscriptPath(cwd, this.params.resumeSessionId);
        // FORK 2026-07-27 (dead-resume guard): a MISSING transcript is not an
        // "unknown size" to fail open on — it is a KNOWN-dead id. `claude
        // --resume` on it exits code=1 ("No conversation found with session
        // ID") before any stream event, the turn surfaces as an incomplete
        // terminal response, and since the binding survives, every retry —
        // and every model — fails identically. Start fresh and purge the id so
        // the fallback-by-openclawSessionId lookup cannot resurrect it.
        if (!transcriptExists(transcriptPath)) {
          skipResume = true;
          const purged = forgetResumeSessionId(this.params.resumeSessionId);
          log.warn(
            `[dead-resume] sessionKey=${this.sessionKey} resumeSessionId=${this.params.resumeSessionId} transcript missing (${transcriptPath}) — starting FRESH, purged ${purged} stale session-map binding(s)`,
          );
        } else if (isTranscriptOversized(transcriptPath, RESUME_MAX_TRANSCRIPT_BYTES)) {
          skipResume = true;
          const sizeMb = (fs.statSync(transcriptPath).size / 1_000_000).toFixed(1);
          const thresholdMb = (RESUME_MAX_TRANSCRIPT_BYTES / 1_000_000).toFixed(1);
          log.warn(
            `[oversized-resume] sessionKey=${this.sessionKey} size=${sizeMb}MB threshold=${thresholdMb}MB — starting FRESH session`,
          );
        }
      } catch (err) {
        // Fail open: stat/path failure must NOT prevent resume.
        log.warn(
          `[oversized-resume] guard errored for sessionKey=${this.sessionKey}, resuming normally: ${err instanceof Error ? err.message : String(err)}`,
        );
        skipResume = false;
      }
      if (!skipResume) {
        args.push("--resume", this.params.resumeSessionId);
        if (corePluginDir) {
          const transcriptPath = resolveTranscriptPath(cwd, this.params.resumeSessionId);
          if (!transcriptHasMoralCode(transcriptPath)) {
            const pack = readMaterializedMoralCode();
            this.pendingMoralCodePrefix = pack || null;
            if (pack) {
              log.info(
                `[moral-code] resumed ${this.sessionKey} has no moral code yet — prefixing the next message once`,
              );
            }
          }
        }
      }
    }

    // TinkerClaw runs claude as a transient systemd user service via
    // `systemd-run --user --pipe --unit=tinkerclaw-worker-<id>`. The service has
    // systemd (pid 1) as its parent, and `--pipe` keeps stdin/stdout/stderr
    // forwarded to the caller — which tinker-bridge needs for stream-json NDJSON
    // in both directions. The transient unit lives under
    // `app.slice/tinkerclaw-worker-<id>.service` and is auto-collected on exit.
    //
    // HONESTY NOTE (2026-09-19) — supersedes the anti-detection rationale
    // repeated throughout this spawn path (the env allowlist below, the
    // `OPENCLAW_*` strip, the PPID/cgroup reparent, and every "harness tell"
    // remark). Those were added (2026-04-18/24) on the belief that Anthropic
    // detects an OpenClaw harness from the child's PPID, cgroup, or environment,
    // and the earlier generic `llm-client-<id>` unit name was a deliberate
    // disguise. That belief is very likely FALSE: Anthropic's API receives an
    // HTTPS request (auth + client headers + message content) and does NOT
    // receive the caller's PPID, cgroup, or process environment — so none of
    // those measures can change what the server sees or how it bills. The only
    // OpenClaw-identifying signal that can actually reach Anthropic is request
    // CONTENT (the system prompt), handled separately. This reparent is retained
    // solely for its real benefits (clean transient-unit lifecycle + stdio
    // forwarding) and the unit is now named honestly for what it is. The
    // `OPENCLAW_*` env exclusion below is kept for now only as ordinary env
    // hygiene and is marked for removal once the interactive billing check
    // confirms subscription billing without it — a pending cleanup, not a
    // legitimate measure.
    const unitId = `tinkerclaw-worker-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // NOTE: we build wrapperArgs AFTER cleanEnv so we can pass every env var
    // through `--setenv=K=V` — `systemd-run --pipe` does NOT inherit env
    // from the caller (unlike --scope), so the service would otherwise run
    // with only the user@1000.service's default env. Building the --setenv
    // list here keeps the wrapper call self-contained.
    const wrapperBinary = "systemd-run";
    // FORK 2026-09-30 (lifecycles.md L4b): on the FILE transport the unit owns its stdio (a FIFO
    // and two files in its worker dir), so it outlives a gateway restart. See worker-transport.ts.
    const workerDir = getBridgeTransport() === "file" ? prepareWorkerDir(unitId) : null;
    const wrapperBaseArgs = workerDir
      ? [
          "--user",
          "--quiet",
          "--collect",
          "--same-dir",
          `--unit=${unitId}`,
          `--setenv=TC_WORKER_DIR=${workerDir}`,
        ]
      : ["--user", "--pipe", "--quiet", "--same-dir", `--unit=${unitId}`];

    log.info(
      `spawning claude (reparented to systemd, ${workerDir ? "file transport" : "--pipe"}, unit=${unitId}): sessionKey=${this.sessionKey} cwd=${cwd} args=[${args.map((a) => (a.length > 80 ? a.slice(0, 80) + "..." : a)).join(" | ")}]`,
    );

    // The child runs on a minimal, constructed env (allowlist below) for two
    // reasons, ONLY ONE of which is load-bearing:
    //   (1) LEGITIMATE + NECESSARY: the child must NOT inherit the gateway's
    //       Anthropic auth vars (`ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`,
    //       `ANTHROPIC_AUTH_TOKEN`). If it did, `claude` would bill the metered
    //       API instead of the subscription OAuth in ~/.claude/.credentials.json.
    //       Verified 2026-09-19: on subscription OAuth (those vars unset) a call
    //       bills to the subscription; with the API key present it routes to the
    //       API. Excluding the Anthropic auth vars is what keeps billing on the
    //       subscription — nothing else here does.
    //   (2) HYGIENE: a small, predictable env. Nothing more.
    // De-evasion 2026-09-19: earlier revisions framed this allowlist as defeating
    // an "Anthropic harness detector" that "matches on the OPENCLAW_ prefix." That
    // premise is FALSE — Anthropic's API never receives the child's environment
    // (see the honesty note at the systemd-run block). The `OPENCLAW_*` wiring the
    // child's own helpers need is now re-exported explicitly (added to the allowlist
    // below); it is no longer withheld to dodge anything.
    const allowedKeys = new Set([
      // Shell / user identity
      "HOME",
      "USER",
      "USERNAME",
      "LOGNAME",
      "SHELL",
      "PWD",
      "TMPDIR",
      // Path (must include the claude binary + node)
      "PATH",
      // Locale
      "LANG",
      "LC_ADDRESS",
      "LC_IDENTIFICATION",
      "LC_MEASUREMENT",
      "LC_MONETARY",
      "LC_NAME",
      "LC_NUMERIC",
      "LC_PAPER",
      "LC_TELEPHONE",
      "LC_TIME",
      "LC_ALL",
      // Terminal (CC does TTY/color detection)
      "TERM",
      "COLORTERM",
      // systemd-run --user needs the DBus session + runtime dir to attach
      // the new scope to user@1000.service. Without these the spawn fails
      // with "Failed to connect to bus". Real CC gets both from the login
      // shell naturally.
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_RUNTIME_DIR",
      // Forwarded CC markers — set explicitly below.
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      // Long-lived headless login (`claude setup-token`). Claude Code's own documented
      // variable for machines with no browser, so it is not a harness tell. A host that
      // sets it in the gateway environment gets a login that does not share (and rotate)
      // the refresh token of another machine; hosts without it are unaffected.
      "CLAUDE_CODE_OAUTH_TOKEN",
      // Output-token ceiling — set explicitly below. A host-level override
      // (if present) wins; otherwise we pin it so the CLI never falls back to
      // a low default that would silently truncate a long answer.
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
      // Thinking-token budget — set explicitly below from this session's
      // think level. Native Claude Code knob (same class as the output-token
      // ceiling above), so it doesn't read as a harness tell. Omitted for
      // off/undefined so the CLI keeps its own default.
      "MAX_THINKING_TOKENS",
      // FORK 2026-09-19 (de-evasion): re-export the fork's OWN wiring that the
      // child's helper scripts read directly (subagent-spawn / recipe-state /
      // orchestrate bins, gateway token + url, bundled-plugins dir). Previously
      // withheld on the mistaken anti-detection premise; Anthropic never sees the
      // child env, so this is free and lets the helpers use them instead of
      // re-reading openclaw.json. The Anthropic AUTH vars are deliberately NOT
      // re-exported — that exclusion, not this allowlist, keeps billing on the
      // subscription OAuth.
      "OPENCLAW_SPAWN_SUBAGENT_BIN",
      "OPENCLAW_RECIPE_STATE_BIN",
      "OPENCLAW_ORCHESTRATE_BIN",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
    ]);
    const cleanEnv: NodeJS.ProcessEnv = {};
    for (const key of allowedKeys) {
      const v = process.env[key];
      if (typeof v === "string") {
        cleanEnv[key] = v;
      }
    }
    // CLAUDECODE=1 is also set by interactive CC on every child shell; harmless
    // to set for the subprocess. (Not strictly necessary for billing — the
    // OPENCLAW_* strip is what matters — but keeps the subprocess's env close
    // to what a nested claude expects.)
    cleanEnv.CLAUDECODE = "1";
    cleanEnv.CLAUDE_CODE_ENTRYPOINT = "cli";
    // FORK 2026-05-29: expose the OpenClaw session key to the child shell so the
    // jarvis-speak script can (a) gate voice to the home session only ("WhatsApp
    // never triggers voice") and (b) route its UI-inject bubble to the right
    // session. Named `TC_` for TinkerClaw, its honest owner. (The earlier
    // "avoid the OPENCLAW_ prefix so Anthropic's detector doesn't see it" reason
    // does not hold — the API never receives the child's env; see the honesty
    // note at the systemd-run block above.)
    // FORK 2026-05-30: export the CANONICAL openclaw key (`agent:main:main`),
    // not `this.sessionKey` (the `tinker-sp-<hash>` worker-pool hash). The binary
    // gates on `== agent:main:main` and passes this to `chat.inject` — both
    // need the canonical key; the hash never matches the gate and never routes
    // a bubble. Fall back to the hash only when the canonical key is absent
    // (yields a safe no-match → silent, never a mis-routed bubble).
    cleanEnv.TC_SESSION_KEY = this.params.openclawSessionKey ?? this.sessionKey;
    // Never override a variable the bridge has already set (the allowlist is also enforced in the seam).
    for (const [k, v] of Object.entries(thalamusExtras.env)) {
      if (cleanEnv[k] === undefined) cleanEnv[k] = v;
    }
    // FORK 2026-05-29: pin the output-token ceiling PER MODEL so a paid
    // response is never silently truncated by a low CLI default. The value
    // comes from the active model's `maxOutputTokens` (defaults.ts, single
    // source of truth) resolved from this session's model. CLAUDE_CODE_MAX_OUTPUT_TOKENS
    // is a native Claude Code knob (so it doesn't look like a harness tell).
    // A host-level value (set before us) takes precedence; we only fill it in
    // when absent.
    if (!cleanEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
      cleanEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokensFor(spawnModel));
    }
    // FORK 2026-06-11: pin the thinking-token budget from this session's think
    // level. MAX_THINKING_TOKENS is a native Claude Code knob (so it doesn't
    // look like a harness tell). The helper clamps to the model's output
    // ceiling and returns undefined for off/unset → we OMIT the var entirely
    // (the CLI keeps its own default), never setting it to 0.
    const __maxThinking = thinkLevelToMaxThinkingTokens(
      this.params.thinkLevel,
      maxOutputTokensFor(spawnModel),
    );
    if (__maxThinking !== undefined) {
      cleanEnv.MAX_THINKING_TOKENS = String(__maxThinking);
    }
    // FORK 2026-04-28 (bible §5.76): probe for the user's claude install at
    // runtime instead of hardcoding an absolute home path. claude-cli
    // installs land under `~/.local/share/claude/versions/latest` for the
    // upstream installer; if that's missing, omit the env var entirely and
    // let claude-cli detect its own install path. The var is a marker that
    // tells nested CC sessions where the parent install lives — empty is
    // better than wrong.
    if (!cleanEnv.CLAUDE_CODE_EXECPATH) {
      const probedExecPath = path.join(
        os.homedir(),
        ".local",
        "share",
        "claude",
        "versions",
        "latest",
      );
      try {
        if (fs.existsSync(probedExecPath)) {
          cleanEnv.CLAUDE_CODE_EXECPATH = probedExecPath;
        }
      } catch {
        /* leave unset; claude-cli detects its own install */
      }
    }
    // FORK 2026-09-19 (de-evasion — reverses the 2026-04-24 decision):
    // The original subagent-bridge commit (601e8a3561) re-exported
    // `OPENCLAW_SPAWN_SUBAGENT_BIN`, `OPENCLAW_RECIPE_STATE_BIN`,
    // `OPENCLAW_GATEWAY_TOKEN`, and `OPENCLAW_GATEWAY_URL` so the child's Bash
    // could expand them. A later fix (d5d0eb53fd) STRIPPED them on the belief that
    // "Anthropic's harness detection matches on the OPENCLAW_ prefix and routes the
    // request to the overage pool." That belief is FALSE: Anthropic's API never
    // receives the child's environment (see the systemd-run honesty note), and the
    // 2026-09-19 billing test confirmed the subscription OAuth channel bills to the
    // subscription regardless. The strip defeated nothing.
    //
    // Now: those wiring vars ARE re-exported (added to the allowlist above), so the
    // helper scripts use them directly instead of falling back to re-reading
    // ~/.openclaw/openclaw.json (scripts/openclaw-spawn-subagent.mjs:58-67,
    // scripts/openclaw-recipe-state.mjs:78-87 — the fallback still works too).
    // Billing stays on the subscription because the ANTHROPIC auth vars are
    // excluded — that, not any OPENCLAW_ strip, is the load-bearing exclusion.
    // Log the env SHAPE, never the values. This used to dump every key=value
    // pair (truncated at 60 chars) into the gateway journal on every single
    // spawn — which is not redaction: most tokens are shorter than 60 chars,
    // and HOME/PATH/USER/XDG_RUNTIME_DIR leak the operator's identity and host
    // layout into a log that gets read, tailed and pasted into bug reports.
    // The allowlist above is the thing worth auditing, and the key names alone
    // prove which vars survived it.
    const envKeys = Object.keys(cleanEnv).toSorted().join(", ");
    log.info(`env for claude spawn (${Object.keys(cleanEnv).length} vars, names only): ${envKeys}`);

    // Build --setenv=K=V args for every cleanEnv entry. systemd-run --pipe
    // does NOT inherit the caller's env (only --scope does), so the child
    // would otherwise see only user@1000.service's default env. Pass them
    // explicitly and keep the `env:` field on spawn minimal — systemd-run
    // itself doesn't care about most env, but it does need PATH (to find
    // `claude`) and DBUS/XDG (to connect to the user session bus).
    const setenvArgs: string[] = [];
    for (const [k, v] of Object.entries(cleanEnv)) {
      if (typeof v === "string") {
        setenvArgs.push(`--setenv=${k}=${v}`);
      }
    }
    const rawWrapperArgs = [
      ...wrapperBaseArgs,
      ...setenvArgs,
      ...(workerDir ? ["/bin/sh", "-c", WORKER_SHELL, "tc-worker"] : []),
      binary,
      ...args,
    ];

    // One stray NUL anywhere on this argv — the appended system prompt or any
    // --setenv value — makes Node refuse to start the child at all. See
    // stripNulBytesFromArgv for why the byte gets there and why dropping it is safe.
    const { argv: wrapperArgs, stripped: nulHits } = stripNulBytesFromArgv(rawWrapperArgs);
    if (nulHits > 0) {
      log.warn(
        `stripped ${nulHits} NUL byte(s) from spawn argv — Node would have refused to start the child. ` +
          `Something upstream (transcript replay, a file the agent read) carries binary in a text field.`,
      );
    }

    const spawnEnv = {
      PATH: cleanEnv.PATH,
      HOME: cleanEnv.HOME,
      DBUS_SESSION_BUS_ADDRESS: cleanEnv.DBUS_SESSION_BUS_ADDRESS,
      XDG_RUNTIME_DIR: cleanEnv.XDG_RUNTIME_DIR,
    };
    if (workerDir) {
      let channel: FileChannel;
      try {
        channel = await FileChannel.spawn({
          unit: unitId,
          dir: workerDir,
          argv: wrapperArgs,
          cwd,
          env: spawnEnv,
        });
      } catch (err) {
        removeWorkerDir(workerDir);
        removeSystemPromptFile(this.systemPromptFile);
        this.systemPromptFile = null;
        throw err;
      }
      this.channel = channel;
      this.meta = {
        version: 1,
        unit: unitId,
        sessionKey: this.sessionKey,
        openclawSessionKey: this.params.openclawSessionKey,
        openclawSessionId: this.params.openclawSessionId,
        model: this.params.model,
        thinkLevel: this.params.thinkLevel,
        cwd,
        systemPromptFile: this.systemPromptFile,
        createdAt: Date.now(),
        turn: null,
      };
      writeWorkerMeta(workerDir, this.meta);
      ownedUnits().add(unitId);
      this.proc = channel as unknown as ChildProcessWithoutNullStreams;
    } else {
      this.proc = spawn(wrapperBinary, wrapperArgs, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: spawnEnv,
      });
    }
    this.wireChild(this.proc, unitId, { resumed: args.includes("--resume") });
  }

  /**
   * Hook a started child (either transport) to this worker. `resumed` null: an ADOPTED unit, which
   * no `worker.spawn` row describes (this gateway did not start it).
   */
  private wireChild(
    child: ChildProcessWithoutNullStreams,
    unitId: string,
    spawned: { resumed: boolean } | null,
  ): void {
    this.proc = child;
    this.running = true;
    // FORK 2026-09-25 (logging.md §4.9, §9 step 5): one `worker.spawn` row per child, and the unit
    // handed to the worker-resources sampler, which charts its cgroup (never `child.pid`: that is
    // the systemd-run wrapper, not claude). A spawn that throws above never reaches this line.
    this.unitId = unitId;
    this.turnsServed = 0;
    if (spawned) {
      noteWorkerSpawn({
        workerType: "tinker_bridge",
        workerId: unitId,
        resumed: spawned.resumed,
      });
    }
    this.proc.on("error", (err) => {
      log.error(`spawn error: ${(err as Error).message}`);
      removeSystemPromptFile(this.systemPromptFile);
      this.systemPromptFile = null;
      const stale = this.currentTurn;
      this.currentTurn = null;
      this.running = false;
      this.proc = null;
      if (stale) {
        stale.reject(err as Error);
      }
      // A child that never started emits 'error' and may never emit 'exit' (Node's contract), so
      // its row closes here; a later 'exit' for the same unit adds nothing (reportWorkerExit).
      if (child.pid === undefined) {
        this.reportWorkerExit(unitId, null, null);
      }
    });
    this.attachChildStreamGuards(this.proc);

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    this.proc.stderr.on("data", (chunk: string) => this.onStderrChunk(chunk));
    // The unit is bound here, not read at exit time: a late 'exit' of an earlier child must never
    // be reported as the end of the child that replaced it.
    this.proc.on("exit", (code, signal) => this.onExit(code, signal, unitId));
  }

  /**
   * FORK 2026-09-14 (gateway crash class). A child that dies between spawn and our first
   * `stdin.write()` — at boot on 2026-09-14 the anthropic OAuth refresh was failing and the CLI
   * exited at once — surfaces as an ASYNCHRONOUS 'error' event (EPIPE) on the stdin pipe, not as
   * a throw from write(). With no listener Node turned it into an uncaught exception and the
   * whole gateway died, three times in eleven minutes (07:49, 07:52, 08:00). The exit handler
   * still owns the turn's fate; this guard only keeps the PROCESS alive and fails the TURN.
   * Kept as a method so the test can drive it with an EventEmitter stand-in for the child.
   */
  private attachChildStreamGuards(proc: ChildStreamsLike): void {
    guardChildStreams(proc, (stream, err) => {
      log.warn(`${stream} stream error [${this.sessionKey}]: ${err.message}`);
      if (stream !== "stdin") {
        return;
      }
      const stale = this.currentTurn;
      if (!stale) {
        return;
      }
      this.currentTurn = null;
      stale.reject(
        new Error(`claude stdin closed before the turn could be written (${err.message})`),
      );
    });
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
      // DEBUG=tinkerclaw-tinker-bridge (or the subsystem's `verbose`) when you're
      // tracing stream-json protocol issues; silent in normal operation.
      if (log.debug) {
        const logLine = JSON.stringify(parsed).slice(0, 400);
        log.debug(`stdout[${this.sessionKey}] ${logLine}`);
      }
      this.lastStdoutAt = Date.now();
      this.observeCallBoundary(parsed);
      if (parsed.type === "system" && (parsed as { subtype?: string }).subtype === "init") {
        const sid = (parsed as { session_id?: string }).session_id;
        if (typeof sid === "string") {
          this.sessionId = sid;
          this.updateMeta({ cliSessionId: sid });
          // FORK (2026-04-22): persist so the next gateway boot can --resume.
          // Best-effort; failures just mean amnesia on next restart, not
          // broken turns.
          try {
            setResumeSessionId(this.sessionKey, sid, this.params.openclawSessionId);
          } catch {
            // swallow
          }
        }
      }
      // FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost]): lines no turn of ours asked
      // for. A turn the CLI starts on its own is kept here until a run takes it.
      this.noteBackgroundLine(parsed);
      if (!this.currentTurn) {
        this.keepUnpromptedLine(parsed);
      }
      this.emit("stream_line", { type: "stream_line", line: parsed } as WorkerEvent);
      const turn = this.currentTurn;
      if (turn && !turn.active && TURN_ACTIVITY_TYPES.has(parsed.type)) {
        turn.active = true;
        if (turn.heldEmpty) {
          clearTimeout(turn.heldEmpty.timer);
          turn.heldEmpty = undefined;
          log.warn(
            `[early-empty-result] dropped: the CLI went on working after an empty result [${this.sessionKey}]`,
          );
        }
      }
      if (parsed.type === "result" && turn) {
        const result = parsed as CcStreamStdoutResult;
        // FORK 2026-10-01 (bug-log [event-ordering+cleanup-race]): a resumed CLI whose last turn
        // left work pending (killed by the run limit at 02:44, background Workflow at 14:01) can
        // print an empty `result` (num_turns=0, ~200 ms) BEFORE it reads the new prompt. Ending
        // the turn on it made the gateway retry on a second process while the first one went on
        // working the prompt: two workers on one session. Hold it; real activity drops it, and a
        // turn that stays silent still ends with it, so the empty-response retry keeps working.
        if (!turn.active && !turn.heldEmpty && isEarlyEmptyResult(result)) {
          const timer = setTimeout(() => {
            if (this.currentTurn === turn && turn.heldEmpty) {
              log.warn(
                `[early-empty-result] released after ${EARLY_EMPTY_RESULT_HOLD_MS} ms with no activity [${this.sessionKey}]`,
              );
              turn.heldEmpty = undefined;
              this.finishTurn(turn, result);
            }
          }, EARLY_EMPTY_RESULT_HOLD_MS);
          timer.unref?.();
          turn.heldEmpty = { line: result, timer };
          log.warn(
            `[early-empty-result] held: num_turns=0 duration_ms=${result.duration_ms} before any turn activity [${this.sessionKey}]`,
          );
          continue;
        }
        this.finishTurn(turn, result);
      } else if (parsed.type === "result" && this.unprompted && !this.unprompted.result) {
        const kept = this.unprompted;
        kept.result = parsed as CcStreamStdoutResult;
        kept.finishedAt = Date.now();
        this.turnsServed += 1;
        log.info(
          `[unprompted-turn] ${kept.id} ended (num_turns=${kept.result.num_turns}, ${kept.lines.length} lines kept); waiting for the run that takes it [${this.sessionKey}]`,
        );
      }
    }
  }

  /**
   * FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost]): the CLI's own account of its
   * background tasks. `background_tasks_changed` lists the live ones (the pool must not reap a
   * worker that has any, isBusy); `task_notification` with no turn of ours open is a task that
   * ended between turns, named in the wake of the turn the CLI starts about it.
   */
  private noteBackgroundLine(line: { type: string }): void {
    if (line.type !== "system") {
      return;
    }
    const rec = line as {
      subtype?: unknown;
      tasks?: unknown;
      task_id?: unknown;
      description?: unknown;
      summary?: unknown;
      status?: unknown;
    };
    if (rec.subtype === "background_tasks_changed") {
      this.bgTasks.clear();
      for (const t of Array.isArray(rec.tasks) ? rec.tasks : []) {
        const task = t as { task_id?: unknown; description?: unknown };
        if (typeof task?.task_id === "string") {
          const d =
            typeof task.description === "string" && task.description
              ? task.description
              : task.task_id;
          this.bgTasks.set(task.task_id, d);
          this.rememberTask(task.task_id, d);
        }
      }
    } else if (
      rec.subtype === "task_started" &&
      typeof rec.task_id === "string" &&
      typeof rec.description === "string"
    ) {
      this.rememberTask(rec.task_id, rec.description);
    } else if (
      rec.subtype === "task_notification" &&
      typeof rec.task_id === "string" &&
      !this.currentTurn &&
      !(this.unprompted && !this.unprompted.result)
    ) {
      const description =
        this.taskDescriptions.get(rec.task_id) ??
        (typeof rec.summary === "string" ? rec.summary : undefined);
      this.notices.push({
        taskId: rec.task_id,
        ...(typeof rec.status === "string" ? { status: rec.status } : {}),
        ...(description ? { description } : {}),
      });
      if (this.notices.length > NOTICE_CAP) {
        this.notices.shift();
      }
    }
  }

  private rememberTask(id: string, description: string): void {
    this.taskDescriptions.delete(id);
    this.taskDescriptions.set(id, description);
    if (this.taskDescriptions.size > TASK_DESCRIPTION_CAP) {
      const oldest = this.taskDescriptions.keys().next().value;
      if (oldest !== undefined) {
        this.taskDescriptions.delete(oldest);
      }
    }
  }

  /**
   * A line that came with no turn of ours open. The CLI opens every turn with `init` (measured
   * 2026-10-01 for a background Bash and for a Monitor event); one that comes while nothing is
   * queued opens a turn the CLI started on its own, and its lines are kept until a run takes it.
   * Turn activity with no `init` before it is logged once, so a turn that starts some other way
   * shows up in the journal instead of vanishing.
   */
  private keepUnpromptedLine(line: { type: string }): void {
    const queued = this.turnQueue.length > 0 || this.draining || this.pendingTurn !== null;
    const isInit = line.type === "system" && (line as { subtype?: unknown }).subtype === "init";
    if (isInit && !queued && (!this.unprompted || this.unprompted.result)) {
      this.openUnpromptedTurn();
    }
    const kept = this.unprompted;
    if (kept && !kept.result) {
      kept.lines.push(line);
      return;
    }
    if (!queued && TURN_ACTIVITY_TYPES.has(line.type) && !this.strayActivityLogged) {
      this.strayActivityLogged = true;
      log.warn(
        `[unprompted-turn] a ${line.type} line came with no turn open and no init before it; not kept [${this.sessionKey}]`,
      );
    }
  }

  private openUnpromptedTurn(): void {
    const replaced = this.unprompted;
    if (replaced) {
      log.warn(
        `[unprompted-turn] ${replaced.id} was never taken; a new turn of the CLI replaces it [${this.sessionKey}]`,
      );
    }
    const id = newUnpromptedTurnId();
    const notices = this.notices;
    const liveTasks = [...this.bgTasks.values()];
    this.notices = [];
    this.strayActivityLogged = false;
    this.unprompted = { id, lines: [], startedAt: Date.now(), result: null, finishedAt: 0 };
    log.info(
      `[unprompted-turn] ${id} the CLI started a turn on its own [${this.sessionKey}] notices=${notices.length} liveTasks=${liveTasks.length}`,
    );
    void requestUnpromptedWake({
      info: { id, notices, liveTasks },
      openclawSessionKey: this.params.openclawSessionKey,
      model: this.params.model,
      workerKey: this.sessionKey,
    });
  }

  private replayLines(lines: unknown[]): void {
    for (const line of lines) {
      this.emit("stream_line", { type: "stream_line", line } as WorkerEvent);
    }
  }

  private finishTurn(
    t: NonNullable<ClaudeCodeWorker["currentTurn"]>,
    result: CcStreamStdoutResult,
  ): void {
    if (t.heldEmpty) {
      clearTimeout(t.heldEmpty.timer);
      t.heldEmpty = undefined;
    }
    this.currentTurn = null;
    this.updateMeta({ turn: null });
    this.turnsServed += 1;
    t.resolve(result);
    this.drainQueue();
  }

  private onStderrChunk(chunk: string): void {
    this.stderrBuf += chunk;
    this.emit("stderr", { type: "stderr", chunk } as WorkerEvent);
    log.warn(`claude stderr[${this.sessionKey}]: ${chunk.trim().slice(0, 500)}`);
    if (this.stderrBuf.length > 65536) {
      this.stderrBuf = this.stderrBuf.slice(-32768);
    }
  }

  private onExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    exitedUnitId: string | null = this.unitId,
  ): void {
    this.running = false;
    removeSystemPromptFile(this.systemPromptFile);
    this.systemPromptFile = null;
    const stale = this.currentTurn;
    this.currentTurn = null;
    this.proc = null;
    // FORK 2026-10-01: the child's background tasks and any turn of its own die with it.
    if (this.unprompted) {
      log.warn(
        `[unprompted-turn] ${this.unprompted.id} lost: the CLI exited before a run took it [${this.sessionKey}]`,
      );
    }
    this.unprompted = null;
    this.bgTasks.clear();
    this.notices = [];
    // FORK 2026-09-30 (L4b): a file-transport unit is gone (its dir was removed by the channel);
    // a drain waiting on it has nothing left to wait for.
    if (exitedUnitId) {
      ownedUnits().delete(exitedUnitId);
    }
    if (this.channel && this.channel.unit === exitedUnitId) {
      this.channel = null;
      this.meta = null;
      this.pendingTurn = null;
      this.callOpen = false;
      this.flushBoundaryWaiters();
    }
    log.info(
      `claude exit[${this.sessionKey}] code=${code} signal=${signal} stderr_tail=${this.stderrBuf.slice(-500)}`,
    );
    // FORK 2026-07-27 (dead-resume self-heal): belt-and-braces for the case the
    // pre-spawn guard cannot see — the transcript existed at stat time but the
    // CLI still refuses the id (relocated/renamed project dir, cwd drift, a
    // transcript deleted between stat and spawn). The CLI names the offending
    // id in stderr; purge exactly that one so the NEXT turn spawns fresh
    // instead of re-deriving the same corpse forever.
    const deadResume = /No conversation found with session ID:\s*([0-9a-fA-F-]{8,})/.exec(
      this.stderrBuf,
    );
    if (deadResume) {
      const deadId = deadResume[1];
      const purged = forgetResumeSessionId(deadId);
      log.warn(
        `[dead-resume] sessionKey=${this.sessionKey} claude rejected resume id=${deadId} — purged ${purged} session-map binding(s); next turn starts FRESH`,
      );
    }
    if (stale?.heldEmpty) {
      // FORK 2026-10-01: the CLI exited after an early empty result and nothing else: that empty
      // result was the turn's answer, as it was before the hold existed.
      clearTimeout(stale.heldEmpty.timer);
      const held = stale.heldEmpty.line;
      stale.heldEmpty = undefined;
      stale.resolve(held);
    } else if (stale) {
      // FORK 2026-09-03: `reason=[…]` carries WHY the child died, verbatim from
      // the aborter. It is the ONLY signal that reaches
      // src/fork/error-envelope.ts (this message becomes the envelope's `raw`),
      // and without it every SIGTERM rendered "Gateway restarted — I'm resuming
      // it automatically", which is false for every cause but the restart. An
      // EMPTY reason is deliberate and honest: it classifies to a neutral "the
      // turn was interrupted" that promises nothing. It is placed BEFORE
      // `stderr=` so a `reason=[…]` printed by the child can never win.
      stale.reject(
        new Error(
          `claude subprocess exited (code=${code} signal=${signal} reason=[${this.lastKillCause ?? ""}]) stderr=${this.stderrBuf.slice(-500)}`,
        ),
      );
    }
    this.reportWorkerExit(exitedUnitId, code, signal);
    this.emit("exit", { type: "exit", code, signal } as WorkerEvent);
  }

  /**
   * FORK 2026-09-25 (logging.md §4.9): report one child's end — once per unit, whichever of
   * 'error' (a child that never started) or 'exit' arrives first. The kill cause crosses as TEXT
   * and is classified in core into a closed set (worker-resources.ts classifyWorkerExit, through
   * src/fork/error-envelope.ts's classifyAbortCause, the taxonomy's single owner); the text itself
   * is never stored. It is the latch the error envelope reads, through the same classifier, so
   * the row and the user-facing message name the same cause (an empty one is "unknown" in both).
   */
  private reportWorkerExit(
    unitId: string | null,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (unitId === null || unitId === this.exitReportedUnitId) {
      return;
    }
    this.exitReportedUnitId = unitId;
    if (this.unitId === unitId) {
      this.unitId = null;
    }
    noteWorkerExit({
      workerId: unitId,
      code,
      signal,
      killCause: this.lastKillCause,
      turnsServed: this.turnsServed,
    });
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
        // FORK 2026-09-03: the kill-cause latch belongs to THIS turn. Cleared
        // here rather than in start(), because a pooled worker serves many turns
        // without ever restarting its child.
        this.lastKillCause = null;
        // FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost]): the CLI is in a turn of its
        // own. Its result would end this one, so this turn takes it: its lines so far are replayed
        // and the prompt joins it, as a prompt sent mid-turn does. A finished one is left for the
        // run its wake starts.
        const joining = this.unprompted && !this.unprompted.result ? this.unprompted : null;
        if (joining) {
          this.unprompted = null;
        }
        this.notices = [];
        this.strayActivityLogged = false;
        this.currentTurn = {
          resolve: (line) => resolve(line),
          reject: (err) => reject(err),
          aborted: false,
          ...(joining
            ? {
                active: joining.lines.some((l) =>
                  TURN_ACTIVITY_TYPES.has((l as { type?: string }).type ?? ""),
                ),
              }
            : {}),
        };
        if (joining) {
          log.info(
            `[unprompted-turn] ${joining.id}: a prompt came while the CLI was in a turn of its own; it joins that turn (${joining.lines.length} lines replayed) [${this.sessionKey}]`,
          );
          this.replayLines(joining.lines);
        }
        const abortHandler = () => {
          if (this.currentTurn) {
            this.currentTurn.aborted = true;
            // FORK 2026-09-03: carry the abort's own cause through to the exit
            // message. `AbortSignal.reason` is whatever the aborter passed to
            // `AbortController.abort(reason)` — an Error for a user Stop, a
            // restart drain, the run deadline, the idle timeout or budget
            // exhaustion; the bare string "sessions_yield" for a yield. Node's
            // DEFAULT (nothing passed) names no cause and formats to "", so the
            // envelope stays neutral instead of claiming a restart.
            this.kill("SIGTERM", params.signal?.reason);
          }
        };
        params.signal?.addEventListener("abort", abortHandler, { once: true });
        // FORK 2026-09-25 (context-window-panel.md §6.1 A6 (i); cli-command.ts): a turn whose text
        // IS a CLI command reaches the CLI as that command and nothing else. The CLI runs a slash
        // command only when the line STARTS with it and reads everything after the name as its
        // argument, so no prefix and no wrapper may ride along.
        //
        // It does NOT consume the moral code. A command line carries no conversation, and the
        // prefix would stop `/compact` being a command at all. The pack stays owed to the next real
        // turn, at least once: a compaction that succeeds also re-fires tinkerclaw-core's
        // SessionStart hook (matcher startup|clear|compact), one that fails does not.
        const cliCommand = extractCliCommand(params.userText);
        let content: string;
        if (cliCommand === null) {
          const moralCodePrefix = this.pendingMoralCodePrefix;
          this.pendingMoralCodePrefix = null;
          content = moralCodePrefix ? `${moralCodePrefix}\n\n${params.userText}` : params.userText;
        } else {
          content = cliCommand;
          const name = cliCommand.split(/\s/, 1)[0];
          // Names and lengths only: the owner's instructions are the owner's text, not the journal's.
          log.info(
            `[cli-command] ${this.sessionKey} writing ${name} as a CLI command (instructions.len=${Math.max(0, cliCommand.length - name.length - 1)}, moral code ${this.pendingMoralCodePrefix ? "still owed" : "not owed"})`,
          );
        }
        const stdinLine = serializeStdinLine({
          type: "user",
          message: { role: "user", content },
          ...(this.sessionId ? { session_id: this.sessionId } : {}),
        });
        // FORK 2026-09-30 (L4b): the turn's output starts here; a gateway that adopts this worker
        // after a restart replays it from this offset.
        if (this.channel) {
          this.callOpen = false;
          // FORK 2026-10-01 (bug-log [chat-divergence], cause 4): and the run it belongs to, so
          // the run that takes this turn after a restart can name it to the webchat (frozenTurn).
          const turnMeta: WorkerTurnMetaWithRun = {
            startOffset: this.channel.outSize(),
            startedAt: Date.now(),
            ...(params.runId ? { runId: params.runId } : {}),
          };
          this.updateMeta({ turn: turnMeta });
        }
        try {
          this.proc.stdin.write(stdinLine);
        } catch (err) {
          this.currentTurn = null;
          reject(err as Error);
          return;
        }
        // A turn that starts while a restart drains spends nothing until the next gateway takes
        // it: frozen at once, its prompt waits in the FIFO.
        if (this.channel && restartDrainActive()) {
          void this.freezeUnit();
        }
      };
      this.turnQueue.push(task);
      if (!this.draining) {
        this.drainQueue();
      }
    });
  }

  /**
   * Inject an ADDITIONAL user-message line onto the already-open persistent
   * stdin during a LIVE turn — claude-cli (stream-json input) accepts extra
   * user messages mid-turn and folds them into the current turn. Unlike send(),
   * this does NOT start a new turn and does NOT abort: it must NOT touch
   * currentTurn / turnQueue / kill, so the in-flight turn keeps owning the
   * eventual `result` line. Returns true iff the line was written.
   *
   * Only meaningful while a turn is in flight (currentTurn !== null); between
   * turns there is no live claude turn to consume the line, so we no-op. This is
   * the queue-not-SIGTERM primitive for in-flight prompts: a new prompt steers
   * the live worker instead of aborting + respawning it.
   *
   * A CLI command (`/compact`, cli-command.ts) is never steered: it returns false
   * and the gateway delivers it as its own turn (A6 (i), below).
   */
  steer(text: string): boolean {
    if (!this.proc || !this.running || !this.currentTurn) {
      return false;
    }
    // FORK 2026-09-25 (context-window-panel.md §6.1 A6 (i)): a CLI command is a TURN START, not a
    // mid-turn aside. steer's contract is "fold prose into the running answer", and what the CLI
    // does with a slash command that lands mid-turn is unmeasured (U3). So it is refused, and
    // `false` IS the declared refusal: tryInflightSteer reads it as "not handled" and runs.ts
    // flushSteerBuffer falls back to the run's next round (handle.queueMessage), where the command
    // arrives as its own turn and send() writes it bare. Never throw instead: the hook's catch
    // would reach the same fallback by accident rather than by contract.
    if (extractCliCommand(text) !== null) {
      log.info(
        `[cli-command] ${this.sessionKey} steer refused a CLI command; it runs as its own turn`,
      );
      return false;
    }
    // FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost]): a wake for a turn the CLI
    // started on its own is never news to the CLI. If that turn is still kept, the wake must run as
    // its own turn to take it (false); otherwise a prompt already joined it, and the wake is
    // handled by writing nothing (true).
    const wakeId = parseUnpromptedWakeMarker(text);
    if (wakeId !== null) {
      if (this.unprompted?.id === wakeId) {
        return false;
      }
      log.info(
        `[unprompted-turn] ${wakeId}: its wake reached a live turn after the turn was joined; nothing written [${this.sessionKey}]`,
      );
      return true;
    }
    const line = serializeStdinLine({
      type: "user",
      message: { role: "user", content: text },
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
    });
    try {
      this.proc.stdin.write(line);
      return true;
    } catch (err) {
      // Write-after-end / EPIPE: never throw (an unhandled rejection crashes
      // this gateway — see bible failures.md / the playwright-relay incident).
      log.warn(
        `steer stdin write failed [${this.sessionKey}]: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // ── FORK 2026-09-30 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b): restart hold and reattach ─────
  //
  // On the FILE transport a restart does not cut the turn. The drain freezes the unit at the end
  // of the API call that is streaming (holdAtBoundary), the gateway lets go of it (detach), and the
  // next gateway adopts it (adopt) and hands the turn to the first run of its session (resumeTurn),
  // which replays the turn's output from its start and thaws the unit.

  /** The canonical session key (`agent:main:…`) this worker serves. */
  get openclawSessionKey(): string | undefined {
    return this.params.openclawSessionKey;
  }

  isFileTransport(): boolean {
    return this.channel !== null;
  }

  /** An adopted turn is waiting for a run (resumeTurn). */
  hasPendingTurn(): boolean {
    return this.pendingTurn !== null;
  }

  /**
   * FORK 2026-10-01 (bug-log [chat-divergence], cause 4) — the adopted turn waiting for a run, as
   * that run names it to the webchat: when it started (the gateway's clock) and, when the last
   * gateway recorded it, the run it belonged to. The run that takes it has a NEW id and replays it
   * from its first byte (resumeTurn); the page anchors that replay to the turn named here. Null
   * when no turn waits. meta.json is read back unchecked, so each field is checked here.
   */
  frozenTurn(): { runId?: string; startedAt?: number } | null {
    const turn = this.pendingTurn;
    if (!turn) {
      return null;
    }
    const runId: unknown = turn.runId;
    const startedAt: unknown = turn.startedAt;
    return {
      ...(typeof runId === "string" && runId ? { runId } : {}),
      ...(typeof startedAt === "number" && Number.isFinite(startedAt) ? { startedAt } : {}),
    };
  }

  private updateMeta(patch: Partial<WorkerMeta>): void {
    if (!this.channel || !this.meta) {
      return;
    }
    this.meta = { ...this.meta, ...patch };
    writeWorkerMeta(this.channel.dir, this.meta);
  }

  /**
   * Track the TOP-LEVEL API call: open at its `message_start`, closed at the `message_delta` that
   * carries its stop reason (or the turn's `result`). A subagent's call (parent_tool_use_id) is not
   * this turn's boundary.
   */
  private observeCallBoundary(line: unknown): void {
    if (!this.channel) {
      return;
    }
    const rec = line as {
      type?: unknown;
      parent_tool_use_id?: unknown;
      event?: { type?: unknown; delta?: { stop_reason?: unknown } };
    };
    if (rec.parent_tool_use_id) {
      return;
    }
    if (rec.type === "stream_event" && rec.event?.type === "message_start") {
      this.callOpen = true;
    } else if (
      rec.type === "result" ||
      (rec.type === "stream_event" &&
        rec.event?.type === "message_delta" &&
        typeof rec.event.delta?.stop_reason === "string")
    ) {
      this.callOpen = false;
      this.flushBoundaryWaiters();
    }
  }

  private flushBoundaryWaiters(): void {
    const waiters = this.boundaryWaiters;
    this.boundaryWaiters = [];
    for (const w of waiters) {
      w();
    }
  }

  private async freezeUnit(): Promise<boolean> {
    if (!this.channel) {
      return false;
    }
    const ok = await this.channel.freeze();
    if (ok) {
      this.updateMeta({ frozenAt: Date.now() });
      log.info(`[restart-hold] froze ${this.channel.unit} sessionKey=${this.sessionKey}`);
    } else {
      log.warn(
        `[restart-hold] could not freeze ${this.channel.unit} sessionKey=${this.sessionKey}`,
      );
    }
    return ok;
  }

  /**
   * The restart drain: hold this worker's turn at the end of the API call now streaming (nothing
   * is cut, nothing more is spent). Past the budget it is frozen mid-call anyway: a frozen call may
   * have to be repeated after the thaw, a killed turn is lost whole.
   */
  async holdAtBoundary(budgetMs: number): Promise<WorkerHoldVerdict> {
    if (!this.channel) {
      return this.currentTurn ? "pipe" : "idle";
    }
    if (!this.currentTurn) {
      return "idle";
    }
    let reached = true;
    if (this.callOpen) {
      reached = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(0, budgetMs));
        timer.unref?.();
        this.boundaryWaiters.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    }
    if (!this.currentTurn || !this.channel) {
      return "ended";
    }
    // A unit that would not freeze runs on while the gateway is down: not held.
    const frozen = await this.freezeUnit();
    return frozen && reached ? "held" : "unfinished";
  }

  /** The restart was called off, or this process goes on (an in-process restart): thaw. */
  async releaseHold(): Promise<void> {
    if (this.channel?.frozen && (await this.channel.thaw())) {
      this.updateMeta({ frozenAt: null });
    }
  }

  /**
   * The gateway is going: let go of the unit and leave it running (or frozen) for the next one.
   * A pipe-transport worker cannot outlive its gateway and is killed, as before.
   */
  detach(): void {
    if (!this.channel) {
      this.kill("SIGTERM");
      return;
    }
    ownedUnits().delete(this.channel.unit);
    this.channel.detach();
    this.channel = null;
    this.meta = null;
    this.running = false;
    this.proc = null;
    this.flushBoundaryWaiters();
  }

  /**
   * Take the turn a restart froze: replay its output from the turn's start (the stream rebuilds
   * the answer, its tool rows and its thinking from it), then thaw the unit so it goes on. Resolves
   * with the turn's `result` line, like send().
   */
  resumeTurn(params: { signal?: AbortSignal } = {}): Promise<CcStreamStdoutResult> {
    const turn = this.pendingTurn;
    const channel = this.channel;
    this.pendingTurn = null;
    if (!turn || !channel || !this.proc) {
      return Promise.reject(new Error("no frozen turn to resume on this worker"));
    }
    return new Promise((resolve, reject) => {
      this.lastKillCause = null;
      this.currentTurn = { resolve, reject, aborted: false };
      params.signal?.addEventListener(
        "abort",
        () => {
          if (this.currentTurn) {
            this.currentTurn.aborted = true;
            this.kill("SIGTERM", params.signal?.reason);
          }
        },
        { once: true },
      );
      this.callOpen = false;
      log.info(
        `[reattach] resuming ${channel.unit} sessionKey=${this.sessionKey} from byte ${turn.startOffset} (turn of run ${typeof turn.runId === "string" && turn.runId ? turn.runId : "?"}, started ${turn.startedAt})`,
      );
      channel.startStdout(turn.startOffset);
      void this.releaseHold();
    });
  }

  /**
   * Adopt a unit an earlier gateway started on the file transport. A turn it left in flight is
   * kept for resumeTurn and its output is not read until then; an idle one is read from the end.
   */
  static adopt(
    meta: WorkerMeta,
    dir: string,
    frozen: boolean,
    run: UnitCommand = systemctlUser,
  ): ClaudeCodeWorker {
    const worker = new ClaudeCodeWorker({
      sessionKey: meta.sessionKey,
      cwd: meta.cwd,
      model: meta.model,
      thinkLevel: meta.thinkLevel,
      openclawSessionId: meta.openclawSessionId,
      openclawSessionKey: meta.openclawSessionKey,
    });
    worker.sessionId = meta.cliSessionId ?? null;
    worker.systemPromptFile = meta.systemPromptFile ?? null;
    const channel = FileChannel.attach(meta.unit, dir, meta.turn ? null : workerOutSize(dir), run);
    channel.frozen = frozen;
    worker.channel = channel;
    worker.meta = meta;
    worker.pendingTurn = meta.turn;
    ownedUnits().add(meta.unit);
    worker.wireChild(channel as unknown as ChildProcessWithoutNullStreams, meta.unit, null);
    return worker;
  }

  /**
   * Kill the child. `cause` is the reason the caller has for killing it — an
   * `AbortSignal.reason` (Error or string), or a literal such as
   * "fast-fail-init-stall". It is echoed VERBATIM in the `onExit` rejection so
   * `src/fork/error-envelope.ts` can classify the SIGTERM by cause instead of
   * calling every one of them a gateway restart.
   *
   * FIRST NAMED CAUSE WINS: a fast-fail kill is routinely followed within
   * milliseconds by the run's own abort of the turn that is already dying, and
   * the second kill must never overwrite the true cause. The one permitted
   * upgrade is from an EMPTY cause — "" carries no claim, so replacing it with a
   * named one can only add information.
   *
   * The extra parameter keeps `PoolWorker.kill(signal?: NodeJS.Signals)`
   * satisfied (an additional OPTIONAL parameter stays assignable), so the pool's
   * reason-less `kill("SIGTERM")` is unchanged and lands on "". That is correct
   * for the pool: both of its kill paths are gated on `!isBusy()`, so neither
   * can produce a user-visible envelope.
   */
  kill(signal: NodeJS.Signals = "SIGTERM", cause?: unknown): void {
    if (this.lastKillCause === null || this.lastKillCause === "") {
      this.lastKillCause = formatKillCause(cause);
    }
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

  /** When the child last printed a line; the pool's idle sweep counts it as use. */
  lastActivityAt(): number {
    return this.lastStdoutAt;
  }

  /**
   * True while a turn is in flight or queued. The worker pool uses this to
   * never evict a worker mid-turn (people-profiles turns can run for many
   * minutes — see bible lifecycles.md L2).
   */
  isBusy(): boolean {
    // An adopted turn waiting for its run is a turn in flight: never evicted, never respawned.
    // FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost]): so is work the CLI owns after
    // its turn ended: live background tasks (a Workflow, a Monitor, Bash in the background) and a
    // turn it started on its own that waits for its run. Reaping the worker kills them all.
    return (
      this.currentTurn !== null ||
      this.turnQueue.length > 0 ||
      this.draining ||
      this.pendingTurn !== null ||
      this.bgTasks.size > 0 ||
      this.holdsUnpromptedTurn()
    );
  }

  private holdsUnpromptedTurn(): boolean {
    const kept = this.unprompted;
    return kept !== null && (!kept.result || Date.now() - kept.finishedAt <= UNPROMPTED_KEEP_MS);
  }

  /**
   * FORK 2026-10-01 (bug-log [monitor-notify-idle-session-lost]): the turn the CLI started on its
   * own and nobody has taken yet, if any.
   */
  unpromptedTurn(): { id: string; finished: boolean; startedAt: number } | null {
    const kept = this.unprompted;
    return kept ? { id: kept.id, finished: kept.result !== null, startedAt: kept.startedAt } : null;
  }

  /**
   * Take the turn the CLI started on its own (the run its wake started, stream.ts): replay its
   * lines from its `init`, then follow it live to its `result`, or resolve at once when it already
   * ended. Nothing is written to the CLI: it has already answered. Resolves like send().
   */
  takeUnpromptedTurn(params: { id: string; signal?: AbortSignal }): Promise<CcStreamStdoutResult> {
    const kept = this.unprompted;
    if (!kept || kept.id !== params.id) {
      return Promise.reject(new Error(`no unprompted turn ${params.id} on this worker`));
    }
    this.unprompted = null;
    log.info(
      `[unprompted-turn] ${kept.id} taken by a run (${kept.lines.length} lines replayed, ${kept.result ? "ended" : "still running"}) [${this.sessionKey}]`,
    );
    return new Promise((resolve, reject) => {
      if (kept.result) {
        this.replayLines(kept.lines);
        resolve(kept.result);
        return;
      }
      this.lastKillCause = null;
      this.currentTurn = {
        resolve,
        reject,
        aborted: false,
        active: kept.lines.some((l) =>
          TURN_ACTIVITY_TYPES.has((l as { type?: string }).type ?? ""),
        ),
      };
      params.signal?.addEventListener(
        "abort",
        () => {
          if (this.currentTurn) {
            this.currentTurn.aborted = true;
            this.kill("SIGTERM", params.signal?.reason);
          }
        },
        { once: true },
      );
      this.replayLines(kept.lines);
    });
  }
}
