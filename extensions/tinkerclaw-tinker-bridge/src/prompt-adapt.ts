/**
 * FORK 2026-10-09: fit core's OpenClaw system prompt to the Claude Code CLI it is appended to.
 *
 * worker.ts appends core's prompt (src/agents/system-prompt.ts buildAgentSystemPrompt) to every
 * `claude` subprocess. Four of its sections were written for OpenClaw's OWN tool runtime and are
 * false here, measured on a live worker prompt file:
 *   - `## Tooling` says "Call tools exactly as listed" over OpenClaw names (read, exec, cron,
 *     sessions_spawn, ...) the CLI does not have, and says to spawn sub-agents with sessions_spawn.
 *   - `## Tool Call Style` says "do not narrate routine, low-risk tool calls", against the chat-row
 *     narration contract stream.ts appends to every user message, and explains /approve exec
 *     approvals that bypassPermissions never raises.
 *   - `## Workspace` names the agent workspace as the working directory; the worker's cwd can be
 *     another directory (defaults.ts resolveDefaultCwd prefers a legacy one).
 *   - `## OpenClaw CLI Quick Reference` routes config and restarts through a `gateway` tool the CLI
 *     is never given (the gateway's HTTP tool surface withholds it).
 *
 * A section is rewritten only while it still carries core's own text (a signature line), so a
 * provider override, or a workspace file that reuses a heading, passes through; an already adapted
 * section is recognised and kept as it is. Only sections above `## Workspace Files (injected)` are
 * considered, so the user's own files are never rewritten. Pure (no I/O, no clock, no
 * process.cwd), never throws, idempotent.
 *
 * What it does NOT do (worker.ts, "MECHANISM A REMOVED", 2026-09-20): remove harness identity. The
 * identity line is untouched, every OpenClaw tool name stays visible beside the Claude Code tool
 * that replaces it or on the not-callable line, and the new text names the runtime as it is. It
 * corrects instructions; it hides nothing about who is asking.
 *
 * Code, not prompt: core's builder is a fixed producer and the want is the same correction on every
 * spawn. A counter-instruction appended later would leave the model weighing two contradictory
 * texts on every turn; rewriting the source leaves one.
 */
import path from "node:path";
import { DEFAULT_DISALLOWED_TOOLS } from "./defaults.js";

/**
 * The name `openclaw mcp tools` (src/mcp/jarvis-tools-serve.ts) gives its server. Claude Code names
 * MCP tools `mcp__<config key>__<tool>`, so a host that registers the server under another key
 * passes `mcpServer`.
 */
export const DEFAULT_GATEWAY_MCP_SERVER = "jarvis";

export interface AdaptCorePromptOptions {
  /** The worker's real working directory. Absolute; anything else skips the Workspace rewrite. */
  cwd: string;
  /** Claude Code tools this worker disables (`--disallowedTools`). Default DEFAULT_DISALLOWED_TOOLS. */
  disallowedTools?: readonly string[];
  /** The prompt carries the subagent-helper section (prompts/subagent-helper.md). Default true. */
  subagentHelper?: boolean;
  /** Key the gateway's MCP tool server is registered under in Claude Code. Default "jarvis". */
  mcpServer?: string;
}

type Resolved = {
  cwd: string | null;
  disallowed: ReadonlySet<string>;
  subagentHelper: boolean;
  mcpServer: string;
};

/** Returns the new body, the same `body` when it is core's section and already right, or null when it is not core's. */
type Adapter = (body: readonly string[], o: Resolved) => readonly string[] | null;

/** Core's heading for the user's injected workspace files: nothing at or below it is rewritten. */
const INJECTED_FILES_HEADING = "## Workspace Files (injected)";

type NativeTool = "Read" | "Write" | "Edit" | "Grep" | "Glob" | "Bash";

/** Claude Code's own file and shell tools, in the order they are listed. */
const NATIVE_TOOLS: ReadonlyArray<readonly [NativeTool, string]> = [
  ["Read", "Read a file; images and PDFs are shown to you directly"],
  ["Write", "Create or overwrite a file"],
  ["Edit", "Replace an exact string in a file; apply a multi-file patch as one Edit per hunk"],
  ["Grep", "Search file contents with a regex"],
  ["Glob", "Find files by glob pattern"],
  [
    "Bash",
    "Run shell commands; for a long job pass `run_in_background: true` and read its output later",
  ],
];

/** OpenClaw tool -> the Claude Code tool that does its job (`image`: Read shows you the image itself). */
const OPENCLAW_TO_NATIVE: ReadonlyMap<string, NativeTool> = new Map<string, NativeTool>([
  ["read", "Read"],
  ["image", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["apply_patch", "Edit"],
  ["grep", "Grep"],
  ["find", "Glob"],
  ["ls", "Bash"],
  ["exec", "Bash"],
  ["process", "Bash"],
]);

/**
 * Tools the gateway withholds from its HTTP tool surface, which is all `openclaw mcp tools` can
 * list: core's DEFAULT_GATEWAY_HTTP_TOOL_DENY (src/security/dangerous-tools.ts) minus the names
 * mapped to native tools above. Copied, not imported: an extension may not import core.
 */
const NOT_EXPOSED: ReadonlySet<string> = new Set([
  "spawn",
  "shell",
  "fs_write",
  "fs_delete",
  "fs_move",
  "sessions_spawn",
  "sessions_send",
  "cron",
  "gateway",
  "nodes",
]);

/** One `- name` or `- name: summary` line of core's tool list. */
const TOOL_LINE = /^- ([A-Za-z0-9_.-]+)(?::\s*(.*))?$/;

const TOOLING_SIGNATURE = "Tool availability (filtered by policy):";
const TOOLING_INTRO =
  "You run inside the Claude Code CLI through TinkerClaw's tinker bridge, so you call Claude Code's tools, not OpenClaw's tool names. Tool names are case-sensitive: call each by the name that starts its line. Where a skill, TOOLS.md or a note names an OpenClaw tool, call the tool it maps to below.";
const TOOLS_MD_LINE =
  "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.";
const SUBAGENT_POLL_LINE =
  "Do not poll `subagents list` / `sessions_list` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).";

const TOOL_CALL_STYLE_INTRO =
  "Narrate by the chat-row contract at the end of each user message: one short, plain-language sentence before every tool call, naming what it touches and why. That sentence becomes the tool row's title in the chat.";
const TOOL_CALL_STYLE_BODY: readonly string[] = [
  TOOL_CALL_STYLE_INTRO,
  "Tool calls run without permission prompts in this runtime, so there is no approval to request or relay. A missing prompt is not permission: your rules on irreversible and outbound actions still apply. A safety hook can still deny a call; its reason comes back as the tool result, and you stop there instead of routing around it.",
  "When a tool exists for an action, use it directly instead of asking the user to run the equivalent CLI or slash command.",
];

const CLI_CONFIG_LINE =
  "For config changes, use `openclaw config` through Bash (get, set, unset, schema, validate; see `openclaw config --help`) instead of editing the config file by hand.";
const CLI_RESTART_LINE =
  "For Gateway restarts, use the gateway-restart skill when your skill list has it; otherwise run `openclaw gateway restart` only when the user explicitly asks for a restart.";

const WORKDIR_PREFIX = "Your working directory is: ";
const ADAPTED_WORKDIR =
  /^Your working directory is: (.+?)\. The agent workspace \(AGENTS\.md, memory\/, skills\/\) is (.+); use absolute paths for files there\.$/;

function keepTrailingBlanks(next: readonly string[], body: readonly string[]): readonly string[] {
  let blanks = 0;
  while (blanks < body.length && (body[body.length - 1 - blanks] ?? "").trim() === "") {
    blanks++;
  }
  return blanks > 0 ? [...next, ...body.slice(body.length - blanks)] : next;
}

function subagentLine(o: Resolved): string {
  const head = o.disallowed.has("Agent")
    ? "Sub-agents: Claude Code's built-in Agent tool is off in this worker."
    : "Sub-agents: Claude Code's Agent tool runs a sub-agent inside this CLI.";
  const routes: string[] = [];
  if (!o.disallowed.has("Workflow")) {
    routes.push("the Workflow tool");
  }
  if (o.subagentHelper) {
    routes.push(
      'the OpenClaw sub-agent helper in the "Spawning subagents" section later in this prompt',
    );
  }
  return routes.length > 0 ? `${head} To fan out, use ${routes.join(", or ")}.` : head;
}

const adaptTooling: Adapter = (body, o) => {
  if (body[0] === TOOLING_INTRO) {
    return body;
  }
  if (!body.some((line) => line.trim() === TOOLING_SIGNATURE)) {
    return null;
  }
  const replaced = new Map<NativeTool, string[]>();
  const mcp: string[] = [];
  const blocked: string[] = [];
  const seen = new Set<string>();
  for (const line of body) {
    const match = TOOL_LINE.exec(line.trim());
    const name = match?.[1] ?? "";
    const key = name.toLowerCase();
    if (!match || !name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const native = OPENCLAW_TO_NATIVE.get(key);
    if (native && !o.disallowed.has(native)) {
      replaced.set(native, [...(replaced.get(native) ?? []), name]);
    } else if (native || NOT_EXPOSED.has(key)) {
      blocked.push(name);
    } else {
      const summary = match[2]?.trim();
      mcp.push(`- mcp__${o.mcpServer}__${name}${summary ? `: ${summary}` : ""}`);
    }
  }
  const out: string[] = [
    TOOLING_INTRO,
    "Claude Code tools (with the OpenClaw tools each one replaces):",
  ];
  for (const [tool, summary] of NATIVE_TOOLS) {
    if (o.disallowed.has(tool)) {
      continue;
    }
    const from = replaced.get(tool);
    out.push(`- ${tool}${from ? ` (OpenClaw: ${from.join(", ")})` : ""}: ${summary}`);
  }
  if (mcp.length > 0) {
    out.push(
      "Gateway tools, served to this CLI over MCP. Load each with ToolSearch (`select:<name>`) before its first call; if ToolSearch finds nothing, that tool is not exposed here, so say so instead of guessing:",
      ...mcp,
    );
  }
  if (blocked.length > 0) {
    out.push(
      `Not callable as tools here: ${blocked.join(", ")}. Use the \`openclaw\` CLI through Bash instead (\`openclaw <command> --help\`).`,
    );
  }
  out.push(
    "Where a later section names a `gateway` tool action (config.get, config.patch, update.run, restart), use the `openclaw` CLI through Bash instead.",
    TOOLS_MD_LINE,
    "For long waits, avoid rapid poll loops: start the command with Bash `run_in_background: true` and check its output when you need it.",
    subagentLine(o),
    SUBAGENT_POLL_LINE,
  );
  return keepTrailingBlanks(out, body);
};

const adaptToolCallStyle: Adapter = (body) => {
  if (body[0] === TOOL_CALL_STYLE_INTRO) {
    return body;
  }
  if (!body.some((line) => line.includes("do not narrate routine") || line.includes("/approve"))) {
    return null;
  }
  return keepTrailingBlanks(TOOL_CALL_STYLE_BODY, body);
};

const adaptCliReference: Adapter = (body) => {
  let hit = false;
  const out = body.map((line) => {
    if (line.includes("first-class `gateway` tool")) {
      hit = true;
      return CLI_CONFIG_LINE;
    }
    if (line.includes("`gateway` tool action `restart`")) {
      hit = true;
      return CLI_RESTART_LINE;
    }
    return line;
  });
  if (hit) {
    return out;
  }
  return body.includes(CLI_CONFIG_LINE) || body.includes(CLI_RESTART_LINE) ? body : null;
};

/** `a` is absolute and resolved; `b` is the path core printed. */
function samePath(a: string, b: string): boolean {
  return path.isAbsolute(b) ? a === path.resolve(b) : a === b;
}

function replaceAt(body: readonly string[], index: number, line: string): readonly string[] {
  const out = [...body];
  out[index] = line;
  return out;
}

const adaptWorkspace: Adapter = (body, o) => {
  const index = body.findIndex((line) => line.startsWith(WORKDIR_PREFIX));
  if (index < 0) {
    return null;
  }
  const line = body[index] ?? "";
  const adapted = ADAPTED_WORKDIR.exec(line);
  const workspace = (adapted ? (adapted[2] ?? "") : line.slice(WORKDIR_PREFIX.length)).trim();
  if (o.cwd === null || !workspace) {
    return body;
  }
  if (samePath(o.cwd, workspace)) {
    return adapted ? replaceAt(body, index, `${WORKDIR_PREFIX}${workspace}`) : body;
  }
  const next = `${WORKDIR_PREFIX}${o.cwd}. The agent workspace (AGENTS.md, memory/, skills/) is ${workspace}; use absolute paths for files there.`;
  return next === line ? body : replaceAt(body, index, next);
};

const ADAPTERS: ReadonlyArray<readonly [string, Adapter]> = [
  ["Tooling", adaptTooling],
  ["Tool Call Style", adaptToolCallStyle],
  ["OpenClaw CLI Quick Reference", adaptCliReference],
  ["Workspace", adaptWorkspace],
];

/** Every `## <title>` section above the injected files: [heading index, end index) pairs. */
function findSections(lines: readonly string[], title: string): Array<[number, number]> {
  const heading = `## ${title}`;
  const found: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trimEnd();
    if (line === INJECTED_FILES_HEADING) {
      break;
    }
    if (line !== heading) {
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !(lines[end] ?? "").startsWith("## ")) {
      end++;
    }
    found.push([i, end]);
  }
  return found;
}

function resolveOptions(opts: AdaptCorePromptOptions): Resolved {
  const cwd = typeof opts.cwd === "string" ? opts.cwd.trim() : "";
  return {
    cwd: path.isAbsolute(cwd) ? path.resolve(cwd) : null,
    disallowed: new Set(opts.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS),
    subagentHelper: opts.subagentHelper ?? true,
    mcpServer: opts.mcpServer?.trim() || DEFAULT_GATEWAY_MCP_SERVER,
  };
}

/**
 * Rewrite the Tooling, Tool Call Style, OpenClaw CLI Quick Reference and Workspace sections of
 * core's system prompt for a Claude Code worker. Every other byte is kept; a prompt without those
 * sections comes back as the same string.
 */
export function adaptCorePromptForClaudeCode(prompt: string, opts: AdaptCorePromptOptions): string {
  if (!prompt) {
    return prompt;
  }
  const o = resolveOptions(opts);
  const lines = prompt.split("\n");
  let changed = false;
  for (const [title, adapt] of ADAPTERS) {
    for (const [start, end] of findSections(lines, title)) {
      const body = lines.slice(start + 1, end);
      const next = adapt(body, o);
      if (next === null) {
        continue;
      }
      if (next !== body) {
        lines.splice(start + 1, body.length, ...next);
        changed = true;
      }
      break;
    }
  }
  return changed ? lines.join("\n") : prompt;
}
