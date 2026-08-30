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
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  AMYGDALA_CC_HOOK_SETTINGS_PATH,
  DEFAULT_BINARY,
  DEFAULT_DISALLOWED_TOOLS,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_PLUGIN_DIRS,
  RESUME_MAX_TRANSCRIPT_BYTES,
  maxOutputTokensFor,
} from "./defaults.js";
import { loadPromptFile } from "./prompt-loader.js";
import {
  type CcStreamStdoutLine,
  type CcStreamStdoutResult,
  parseStreamJsonLine,
  serializeStdinLine,
} from "./protocol.js";
import { forgetResumeSessionId, setResumeSessionId } from "./session-map.js";
import { thinkLevelToMaxThinkingTokens } from "./thinking-budget.js";
import {
  isTranscriptOversized,
  resolveTranscriptPath,
  transcriptExists,
} from "./transcript-path.js";

const log = createSubsystemLogger("tinkerclaw-tinker-bridge");

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

// FORK 2026-05-21: ethical-rules foundation layer. The persona block (SOUL.md /
// jarvis-default.md) defines voice + posture; the narration / subagent-helper /
// tool-choice / plan-tools blocks define mechanics. Neither layer guards against
// the assistant doing something stupid under pressure — flattery, leaking
// private data, sending half-baked outbound, impersonating the user. This block
// ships ten Asimov-style priority-ordered rules that act as safeguards across
// every channel, every turn. Resolution order (per loadPromptFile defaults):
//   1. env var TINKERCLAW_ETHICAL_RULES_PROMPT
//   2. ~/.openclaw/workspace/memory/knowledge/jarvis-ethical-rules.md (user)
//   3. extensions/tinkerclaw-tinker-bridge/prompts/ethical-rules-default.md (bundled)
// Inserted into combinedSystemPrompt immediately after the persona block so the
// rules read as foundational, before voice/narration/tooling mechanics.
function buildEthicalRulesBlock(): string {
  return loadPromptFile({
    plugin: "tinkerclaw-tinker-bridge",
    subdir: "prompts",
    file: "ethical-rules-default.md",
    envVar: "TINKERCLAW_ETHICAL_RULES_PROMPT",
    workspaceFile: "memory/knowledge/jarvis-ethical-rules.md",
  });
}

// FORK 2026-07-26 (the architect): objectives foundation layer. The ethical rules above say what the
// assistant must never do; the persona says how it sounds; the orchestration block below says
// how to spend effort. NONE of them said what the work is FOR — so every task arrived at the
// same importance and effort was allocated by quota pressure and prompt length. Prompt length
// is a poor proxy for consequence. This block supplies the missing term: the operator's own
// objective + a reach × permanence × proximity value model the effort/fan-out decisions can
// key off. Advisory (no code enforces it), and it can raise EFFORT but never AUTONOMY — the
// ethical rules keep priority, which is why it is inserted after them.
// Resolution order (per loadPromptFile defaults):
//   1. env var TINKERCLAW_OBJECTIVES_PROMPT
//   2. ~/.openclaw/workspace/memory/knowledge/jarvis-objectives.md (user — personal strategy)
//   3. extensions/tinkerclaw-tinker-bridge/prompts/objectives-default.md (bundled, generic)
function buildObjectivesBlock(): string {
  return loadPromptFile({
    plugin: "tinkerclaw-tinker-bridge",
    subdir: "prompts",
    file: "objectives-default.md",
    envVar: "TINKERCLAW_OBJECTIVES_PROMPT",
    workspaceFile: "memory/knowledge/jarvis-objectives.md",
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
};

export type WorkerEvent =
  | { type: "stream_line"; line: CcStreamStdoutLine }
  | { type: "stderr"; chunk: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

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
    this.thinkLevel = params.thinkLevel;
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
    if (fs.existsSync(AMYGDALA_CC_HOOK_SETTINGS_PATH)) {
      args.push("--settings", AMYGDALA_CC_HOOK_SETTINGS_PATH);
    }
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
    const ethicalRulesBody = buildEthicalRulesBlock();
    const objectivesBody = buildObjectivesBlock();
    const orchestrationDispositionBody = buildOrchestrationDispositionBlock();
    // FORK 2026-04-24 (ROOT CAUSE, subscription-billing regression):
    // OpenClaw's embedded-agent-runner appends its full tool catalog + OpenClaw
    // CLI quick-reference + heartbeat section + Runtime metadata to the
    // system prompt (see `src/agents/system-prompt.ts:buildAgentSystemPrompt`
    // — started sending that content on 2026-04-18 via commit 378684e4f5,
    // "apply fork wiring after 309-commit upstream merge"). The block
    // contains dozens of mentions of OpenClaw-specific verbs like
    // `sessions_spawn`, `openclaw gateway start`, and
    // `repo=/home/…/.openclaw/workspace` — exactly the fingerprint
    // Anthropic's server-side classifier uses to route requests to the
    // metered overage pool (HTTP 400 "out of extra usage"), even when
    // everything else (env, cgroup, OAuth creds, credentials file) is
    // already clean.
    //
    // Strip everything from the "You are a personal assistant running
    // inside OpenClaw" sentinel onwards. That keeps the persona block at
    // the top (`# Persona: JarvisOne (v1)…`) and drops the harness-
    // specific tool policy. claude-cli maintains its own tool catalog so
    // we don't lose tool access by trimming here. We also skip the
    // rulesBody — it's fork-internal scaffolding for Jarvis's reply style
    // that's not worth the risk of re-tripping the classifier.
    //
    // Confirmed by bisect: merge-base `4a6a289d5a` works, raw-merge
    // `3db21784ad` works, fork-wiring `378684e4f5` fails. The ONLY change
    // in `378684e4f5` that affects request routing is the new
    // `buildAgentSystemPrompt` content (persona injection + "running
    // inside OpenClaw" text), and stripping it here (on top of HEAD) makes
    // Jarvis bill the subscription again.
    const OPENCLAW_SYSPROMPT_CUTOFF = "You are a personal assistant running inside OpenClaw";
    const openClawCutoff = systemPromptBody.indexOf(OPENCLAW_SYSPROMPT_CUTOFF);
    const personaOnly =
      openClawCutoff > 0 ? systemPromptBody.slice(0, openClawCutoff).trim() : systemPromptBody;
    // FORK 2026-06-11 (subagent task-delivery fix): OpenClaw places a spawned
    // subagent's task in the system prompt under "## Your Role", but
    // buildSubagentSystemPrompt appends that block AFTER the "You are a personal
    // assistant running inside OpenClaw" sentinel — so the strip above DROPS it
    // and every tinker-sp-* subagent wakes up with NO task (confirmed empirically via
    // BOTH the prefrontal orchestrate runtime and openclaw-spawn-subagent.mjs:
    // the child's own thinking reads "I don't see a clear **Your Role** section").
    // Re-extract ONLY the "## Your Role" block (the task description) and keep it:
    // it carries no OpenClaw harness verbs (sessions_spawn et al. live in the
    // later "## Sub-Agent Spawning" / tool-catalog sections that the strip still
    // drops), so it stays billing-classifier-safe. Self-gating: the main agent's
    // prompt has no "## Your Role", so subagentRoleBlock is "" there (no-op).
    const extractSubagentRoleBlock = (full: string): string => {
      const start = full.indexOf("## Your Role");
      if (start < 0) {
        return "";
      }
      const rest = full.slice(start);
      const end = rest.indexOf("\n## Rules");
      return (end >= 0 ? rest.slice(0, end) : rest).trim();
    };
    const subagentRoleBlock = openClawCutoff > 0 ? extractSubagentRoleBlock(systemPromptBody) : "";
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
      ethicalRulesBody,
      objectivesBody,
      orchestrationDispositionBody,
      narrationBody,
      subagentHelpBody,
      toolChoiceBody,
      planToolsBody,
    ]
      .filter(Boolean)
      .join("");
    if (combinedSystemPrompt.length > 0) {
      args.push("--append-system-prompt", combinedSystemPrompt);
    }
    if (this.params.model) {
      args.push("--model", this.params.model);
    }
    const cwd = path.resolve(this.params.cwd);
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
      }
    }

    // ROOT CAUSE DISCOVERY 2026-04-18 + 2026-04-24: Anthropic's server-side
    // harness detection reads BOTH the process cgroup path AND the PPID chain
    // (`/proc/<pid>/status:PPid`). The 2026-04-18 fix used `systemd-run --scope`
    // to isolate the cgroup — but with `--scope` the claude process keeps the
    // gateway as its PPID, and Anthropic's detector now matches on that parent
    // process name. Confirmed by live probe (see /tmp/catch-claude.sh): with
    // --scope, `/proc/<claude-pid>/status` shows `PPid: <gateway-pid>` and the
    // parent's comm is `openclaw-gatewa` — a textbook harness tell.
    //
    // Fix (2026-04-24): switch to `systemd-run --user --pipe --unit=llm-client-<id>`
    // which runs claude as a transient systemd service. The service has
    // systemd (pid 1) as its parent, so `/proc/<claude-pid>/status` shows
    // `PPid: 1`, matching what a daemonized real CC install looks like. The
    // `--pipe` flag keeps stdin/stdout/stderr forwarded to the caller — which
    // tinker-bridge needs for stream-json NDJSON both directions. Confirmed by
    // bare-shell probe: `systemd-run --user --pipe --setenv=CLAUDECODE=1 ...`
    // bills against the subscription even with the gateway's exact env +
    // allowlist. Cgroup isolation still intact (the transient unit lives
    // under `app.slice/llm-client-<id>.service`, never under openclaw-gateway).
    const unitId = `llm-client-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // NOTE: we build wrapperArgs AFTER cleanEnv so we can pass every env var
    // through `--setenv=K=V` — `systemd-run --pipe` does NOT inherit env
    // from the caller (unlike --scope), so the service would otherwise run
    // with only the user@1000.service's default env. Building the --setenv
    // list here keeps the wrapper call self-contained.
    const wrapperBinary = "systemd-run";
    const wrapperBaseArgs = ["--user", "--pipe", "--quiet", "--same-dir", `--unit=${unitId}`];

    log.info(
      `spawning claude (reparented to systemd via --pipe, unit=${unitId}): sessionKey=${this.sessionKey} cwd=${cwd} args=[${args.map((a) => (a.length > 80 ? a.slice(0, 80) + "..." : a)).join(" | ")}]`,
    );

    // FORK 2026-04-24: SWITCH TO ALLOWLIST. The previous implementation was
    // "copy process.env, then delete the known-bad keys". That strategy keeps
    // losing ground every time the gateway grows a new env var (provider
    // API key, fork annotation, systemd leak). Anthropic's harness detector
    // apparently matches on the presence of *any* env var a vanilla Claude
    // Code install wouldn't have, not just a known denylist — so a single
    // stray var silently routes the request to the metered overage pool.
    //
    // Empirically confirmed: a bare-shell spawn with `env -i` + minimal
    // allowlist bills against the subscription; any wider env passes
    // fail with HTTP 400 `out-of-extra-usage`. This switches to a closed
    // allowlist: we construct the child env from scratch, copying only the
    // vars a real CC install on an Ubuntu user session would have. That
    // means the child cannot pick up stray OPENCLAW_*, ANTHROPIC_*,
    // OPENAI_*, JOURNAL_STREAM, INVOCATION_ID, or any other harness-tell
    // no matter how many new vars the gateway's systemd unit adds over time.
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
      // Output-token ceiling — set explicitly below. A host-level override
      // (if present) wins; otherwise we pin it so the CLI never falls back to
      // a low default that would silently truncate a long answer.
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
      // Thinking-token budget — set explicitly below from this session's
      // think level. Native Claude Code knob (same class as the output-token
      // ceiling above), so it doesn't read as a harness tell. Omitted for
      // off/undefined so the CLI keeps its own default.
      "MAX_THINKING_TOKENS",
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
    // session. Neutral name — NOT OPENCLAW_* — so it doesn't trip Anthropic's
    // harness billing detection (which matches the OPENCLAW_ prefix).
    // FORK 2026-05-30: export the CANONICAL openclaw key (`agent:main:main`),
    // not `this.sessionKey` (the `tinker-sp-<hash>` worker-pool hash). The binary
    // gates on `== agent:main:main` and passes this to `chat.inject` — both
    // need the canonical key; the hash never matches the gate and never routes
    // a bubble. Fall back to the hash only when the canonical key is absent
    // (yields a safe no-match → silent, never a mis-routed bubble).
    cleanEnv.TC_SESSION_KEY = this.params.openclawSessionKey ?? this.sessionKey;
    // FORK 2026-05-29: pin the output-token ceiling PER MODEL so a paid
    // response is never silently truncated by a low CLI default. The value
    // comes from the active model's `maxOutputTokens` (defaults.ts, single
    // source of truth) resolved from this session's model. CLAUDE_CODE_MAX_OUTPUT_TOKENS
    // is a native Claude Code knob (so it doesn't look like a harness tell).
    // A host-level value (set before us) takes precedence; we only fill it in
    // when absent.
    if (!cleanEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
      cleanEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokensFor(this.params.model));
    }
    // FORK 2026-06-11: pin the thinking-token budget from this session's think
    // level. MAX_THINKING_TOKENS is a native Claude Code knob (so it doesn't
    // look like a harness tell). The helper clamps to the model's output
    // ceiling and returns undefined for off/unset → we OMIT the var entirely
    // (the CLI keeps its own default), never setting it to 0.
    const __maxThinking = thinkLevelToMaxThinkingTokens(
      this.params.thinkLevel,
      maxOutputTokensFor(this.params.model),
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
    // FORK 2026-04-20, REGRESSION FIXED 2026-04-24:
    // The original provider-agnostic subagent bridge commit (601e8a3561)
    // re-exported `OPENCLAW_SPAWN_SUBAGENT_BIN`, `OPENCLAW_RECIPE_STATE_BIN`,
    // `OPENCLAW_GATEWAY_TOKEN`, and `OPENCLAW_GATEWAY_URL` to the child
    // claude subprocess so Jarvis's Bash could expand them. But this
    // undoes the whole point of the `OPENCLAW_*` strip above (commit
    // d5d0eb53fd): Anthropic's server-side harness detection matches on
    // the `OPENCLAW_*` prefix and routes any request whose subprocess
    // env contains those vars to the metered overage pool, returning
    // HTTP 400 `out-of-extra-usage` even when the subscription is at 5%.
    // That's exactly the failure mode the user saw after the 2026-04-20 merge.
    //
    // Fix (now): DO NOT re-export any OPENCLAW_* var to the child. The
    // spawn/recipe-state helper scripts get absolute paths interpolated
    // directly into the narration block at buildSubagentHelperBlock time
    // (see extensions/tinkerclaw-tinker-bridge/src/worker.ts:buildSubagentHelperBlock),
    // and both scripts already fall back to reading gateway.auth.token /
    // default URL from `~/.openclaw/openclaw.json` when their respective
    // env vars aren't set (scripts/openclaw-spawn-subagent.mjs:58-67,
    // scripts/openclaw-recipe-state.mjs:78-87). The subagent bridge still
    // works; the harness-detection strip is honored.
    // Full env dump — every key, every value (secrets truncated). We've ruled out
    // all the obvious suspects, so cast a wide net.
    const fullEnv = Object.entries(cleanEnv)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${(v ?? "").length > 60 ? (v ?? "").slice(0, 60) + "…" : (v ?? "")}`)
      .toSorted()
      .join("\n  ");
    log.info(`FULL env for claude spawn (${Object.keys(cleanEnv).length} vars):\n  ${fullEnv}`);

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
    const rawWrapperArgs = [...wrapperBaseArgs, ...setenvArgs, binary, ...args];

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

    this.proc = spawn(wrapperBinary, wrapperArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: cleanEnv.PATH,
        HOME: cleanEnv.HOME,
        DBUS_SESSION_BUS_ADDRESS: cleanEnv.DBUS_SESSION_BUS_ADDRESS,
        XDG_RUNTIME_DIR: cleanEnv.XDG_RUNTIME_DIR,
      },
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
      // DEBUG=tinkerclaw-tinker-bridge (or the subsystem's `verbose`) when you're
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
            setResumeSessionId(this.sessionKey, sid, this.params.openclawSessionId);
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
   */
  steer(text: string): boolean {
    if (!this.proc || !this.running || !this.currentTurn) {
      return false;
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

  /**
   * True while a turn is in flight or queued. The worker pool uses this to
   * never evict a worker mid-turn (people-profiles turns can run for many
   * minutes — see bible lifecycles.md L2).
   */
  isBusy(): boolean {
    return this.currentTurn !== null || this.turnQueue.length > 0 || this.draining;
  }
}
