import { describe, expect, it } from "vitest";
import { adaptCorePromptForClaudeCode } from "./prompt-adapt.js";

// Fixture: representative lines copied from core's buildAgentSystemPrompt
// (src/agents/system-prompt.ts) as it renders for a tinker-bridge worker: one line per entry, no
// blank lines between sections (core joins with filter(Boolean)). Copied, not imported: an
// extension may not import core.
const WORKSPACE = "/tmp/agent/workspace";
const LEGACY_CWD = "/tmp/agent/legacy-workspace";

const IDENTITY = "You are a personal assistant running inside TinkerClaw.";
const TOOLING = [
  "## Tooling",
  "Tool availability (filtered by policy):",
  "Tool names are case-sensitive. Call tools exactly as listed.",
  "- read: Read file contents",
  "- write: Create or overwrite files",
  "- edit: Make precise edits to files",
  "- apply_patch: Apply multi-file patches",
  "- grep: Search file contents for patterns",
  "- find: Find files by glob pattern",
  "- ls: List directory contents",
  "- exec: Run shell commands (pty available for TTY-required CLIs)",
  "- process: Manage background exec sessions",
  "- web_search: Search the web (Brave API)",
  "- web_fetch: Fetch and extract readable content from a URL",
  "- browser: Control web browser",
  "- canvas: Present/eval/snapshot the Canvas",
  "- nodes: List/describe/notify/camera/screen on paired nodes",
  "- cron: Manage cron jobs and wake events (use for reminders)",
  "- message: Send messages and channel actions",
  "- gateway: Restart, apply config, or run updates on the running OpenClaw process",
  "- agents_list: List OpenClaw agent ids allowed for sessions_spawn",
  "- sessions_list: List other sessions (incl. sub-agents) with filters/last",
  "- sessions_history: Fetch history for another session/sub-agent",
  "- sessions_send: Send a message to another session/sub-agent",
  "- subagents: List, steer, or kill sub-agent runs for this requester session",
  "- session_status: Show a /status-equivalent status card",
  "- image: Analyze an image with the configured image model",
  "- image_generate: Generate images with the configured image-generation model",
  "- diffs",
  '- sessions_spawn: Spawn an isolated sub-agent session; use context="fork" only when current transcript context is required',
  "- tts",
  "- wiki_search",
  "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
  "For long waits, avoid rapid poll loops: use exec with enough yieldMs or process(action=poll, timeout=<ms>).",
  "If a task is more complex or takes longer, spawn a sub-agent. Completion is push-based: it will auto-announce when done.",
  'Sub-agents start isolated by default. Use `sessions_spawn` with `context:"fork"` only when the child needs the current transcript context; otherwise omit `context` or use `context:"isolated"`.',
  'For requests like "do this in claude code/cursor/gemini/opencode" or similar ACP harnesses, treat it as ACP harness intent and call `sessions_spawn` with `runtime: "acp"`.',
  "Do not poll `subagents list` / `sessions_list` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).",
];
const TOOL_CALL_STYLE = [
  "## Tool Call Style",
  "Default: do not narrate routine, low-risk tool calls (just call the tool).",
  "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
  "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI or slash commands.",
  "When exec returns approval-pending, include the concrete /approve command from tool output as plain chat text for the user, and do not ask for a different or rotated code.",
  "Never execute /approve through exec or any other shell/tool path; /approve is a user-facing approval command, not a shell command.",
];
const EXECUTION_BIAS = ["## Execution Bias", "- Actionable request: act in this turn."];
const SAFETY = [
  "## Safety",
  "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
  "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
];
const CLI_REFERENCE = [
  "## OpenClaw CLI Quick Reference",
  "OpenClaw is controlled via subcommands. Do not invent commands.",
  "For config changes, use the first-class `gateway` tool (`config.schema.lookup`, `config.get`, `config.patch`, `config.apply`) instead of editing config through exec; the gateway tool hot-reloads config when possible and uses a safe restart only when required.",
  "Use the `gateway` tool action `restart` for Gateway restarts. Only use CLI service lifecycle commands when the user explicitly asks for them.",
  "Gateway service lifecycle quick reference:",
  "- openclaw gateway status",
  "- openclaw gateway restart",
  "Do not chain `openclaw gateway stop` and `openclaw gateway start` as a restart substitute.",
];
const SKILLS = [
  "## Skills (mandatory)",
  "Before replying: scan <available_skills> <description> entries.",
  "- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.",
  "<available_skills></available_skills>",
];
const MEMORY = [
  "## Memory",
  "Before answering anything about prior work, decisions, dates, people, preferences, or todos: search memory first.",
];
const WORKSPACE_SECTION = [
  "## Workspace",
  `Your working directory is: ${WORKSPACE}`,
  "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
];
const DOCUMENTATION = [
  "## Documentation",
  "For config field docs, prefer the `gateway` tool action `config.schema.lookup`; for broader config guidance, read `docs/gateway/configuration.md`.",
];
// The user's own files, injected below core's sections. One reuses a core heading on purpose.
const INJECTED = [
  "## Workspace Files (injected)",
  `## ${WORKSPACE}/AGENTS.md`,
  "## Tool Call Style",
  "In group chats, never paste an /approve code.",
];

function build(...sections: string[][]): string {
  return [IDENTITY, ...sections.flat()].join("\n");
}

const PROMPT = build(
  TOOLING,
  TOOL_CALL_STYLE,
  EXECUTION_BIAS,
  SAFETY,
  CLI_REFERENCE,
  SKILLS,
  MEMORY,
  WORKSPACE_SECTION,
  DOCUMENTATION,
  INJECTED,
);

/** The first `## <title>` section of `prompt`, heading included. */
function section(prompt: string, title: string): string {
  const lines = prompt.split("\n");
  const start = lines.indexOf(`## ${title}`);
  if (start < 0) {
    return "";
  }
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) {
    end++;
  }
  return lines.slice(start, end).join("\n");
}

const OPENCLAW_ONLY = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "grep",
  "find",
  "ls",
  "exec",
  "process",
  "cron",
  "gateway",
  "nodes",
  "sessions_spawn",
  "sessions_send",
  "image",
];

describe("adaptCorePromptForClaudeCode: Tooling", () => {
  const tooling = section(adaptCorePromptForClaudeCode(PROMPT, { cwd: WORKSPACE }), "Tooling");

  it("lists no OpenClaw-only name as a callable tool", () => {
    for (const name of OPENCLAW_ONLY) {
      expect(tooling).not.toMatch(new RegExp(`^- ${name}\\b`, "m"));
    }
    expect(tooling).not.toContain("Call tools exactly as listed");
    expect(tooling).not.toContain("Tool availability (filtered by policy)");
  });

  it("maps file and shell tools to Claude Code's, keeping the OpenClaw names visible", () => {
    expect(tooling).toMatch(/^- Read \(OpenClaw: read, image\): /m);
    expect(tooling).toMatch(/^- Write \(OpenClaw: write\): /m);
    expect(tooling).toMatch(/^- Edit \(OpenClaw: edit, apply_patch\): /m);
    expect(tooling).toMatch(/^- Grep \(OpenClaw: grep\): /m);
    expect(tooling).toMatch(/^- Glob \(OpenClaw: find\): /m);
    expect(tooling).toMatch(/^- Bash \(OpenClaw: ls, exec, process\): .*run_in_background/m);
  });

  it("serves gateway tools under their MCP names, summaries kept", () => {
    expect(tooling).toContain("- mcp__jarvis__message: Send messages and channel actions");
    expect(tooling).toContain("- mcp__jarvis__web_search: Search the web (Brave API)");
    expect(tooling).toContain(
      "- mcp__jarvis__session_status: Show a /status-equivalent status card",
    );
    expect(tooling).toMatch(/^- mcp__jarvis__diffs$/m);
    expect(tooling).toMatch(/^- mcp__jarvis__wiki_search$/m);
    expect(tooling).toContain("ToolSearch");
  });

  it("names the tools the CLI cannot call once, and points at the openclaw CLI", () => {
    expect(tooling).toContain(
      "Not callable as tools here: nodes, cron, gateway, sessions_send, sessions_spawn.",
    );
    expect(tooling).toContain("`openclaw <command> --help`");
  });

  it("replaces the sessions_spawn guidance with the worker's real fan-out routes", () => {
    expect(tooling).not.toContain("`sessions_spawn`");
    expect(tooling).not.toContain("ACP harness");
    expect(tooling).toContain("Agent tool is off in this worker");
    expect(tooling).toContain("the Workflow tool");
    expect(tooling).toContain('"Spawning subagents" section later in this prompt');
    expect(tooling).toContain(
      "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    );
  });

  it("lists Claude Code's file tools even when policy filtered the OpenClaw ones", () => {
    const prompt = build([
      "## Tooling",
      "Tool availability (filtered by policy):",
      "Tool names are case-sensitive. Call tools exactly as listed.",
      "- exec: Run shell commands",
      "- message: Send messages and channel actions",
    ]);
    const out = section(adaptCorePromptForClaudeCode(prompt, { cwd: WORKSPACE }), "Tooling");
    for (const tool of ["Read", "Write", "Edit", "Grep", "Glob"]) {
      expect(out).toMatch(new RegExp(`^- ${tool}: `, "m"));
    }
    expect(out).toMatch(/^- Bash \(OpenClaw: exec\): /m);
  });

  it("follows the worker's disallowed tools, subagent helper and MCP server name", () => {
    const narrow = section(
      adaptCorePromptForClaudeCode(PROMPT, {
        cwd: WORKSPACE,
        disallowedTools: ["Agent", "Workflow", "Glob"],
        subagentHelper: false,
        mcpServer: "gw",
      }),
      "Tooling",
    );
    expect(narrow).not.toMatch(/^- Glob/m);
    expect(narrow).not.toContain("Workflow tool");
    expect(narrow).not.toContain("Spawning subagents");
    expect(narrow).toContain("- mcp__gw__message: ");
    const open = section(
      adaptCorePromptForClaudeCode(PROMPT, { cwd: WORKSPACE, disallowedTools: [] }),
      "Tooling",
    );
    expect(open).toContain("Agent tool runs a sub-agent inside this CLI");
  });
});

describe("adaptCorePromptForClaudeCode: Tool Call Style", () => {
  it("follows the narration contract and drops the /approve guidance", () => {
    const style = section(
      adaptCorePromptForClaudeCode(PROMPT, { cwd: WORKSPACE }),
      "Tool Call Style",
    );
    expect(style).not.toContain("do not narrate routine");
    expect(style).not.toContain("/approve");
    expect(style).toContain("before every tool call");
    expect(style).toContain("without permission prompts");
  });

  it("leaves a provider override and the user's injected files alone", () => {
    const prompt = build(["## Tool Call Style", "Be terse."], INJECTED);
    expect(adaptCorePromptForClaudeCode(prompt, { cwd: WORKSPACE })).toBe(prompt);
  });
});

describe("adaptCorePromptForClaudeCode: Workspace", () => {
  it("leaves the line alone when the cwd is the workspace", () => {
    for (const cwd of [WORKSPACE, `${WORKSPACE}/`]) {
      expect(section(adaptCorePromptForClaudeCode(PROMPT, { cwd }), "Workspace")).toBe(
        WORKSPACE_SECTION.join("\n"),
      );
    }
  });

  it("names the real cwd and the agent workspace when they differ", () => {
    const ws = section(adaptCorePromptForClaudeCode(PROMPT, { cwd: LEGACY_CWD }), "Workspace");
    expect(ws.split("\n")[1]).toBe(
      `Your working directory is: ${LEGACY_CWD}. The agent workspace (AGENTS.md, memory/, skills/) is ${WORKSPACE}; use absolute paths for files there.`,
    );
  });

  it("re-adapts an adapted prompt to a new cwd", () => {
    const legacy = adaptCorePromptForClaudeCode(PROMPT, { cwd: LEGACY_CWD });
    expect(adaptCorePromptForClaudeCode(legacy, { cwd: WORKSPACE })).toBe(
      adaptCorePromptForClaudeCode(PROMPT, { cwd: WORKSPACE }),
    );
  });

  it("skips the rewrite without an absolute cwd", () => {
    expect(section(adaptCorePromptForClaudeCode(PROMPT, { cwd: "" }), "Workspace")).toBe(
      WORKSPACE_SECTION.join("\n"),
    );
  });
});

describe("adaptCorePromptForClaudeCode: OpenClaw CLI Quick Reference", () => {
  it("routes config and restarts through what the CLI has, keeping the rest", () => {
    const ref = section(
      adaptCorePromptForClaudeCode(PROMPT, { cwd: WORKSPACE }),
      "OpenClaw CLI Quick Reference",
    );
    expect(ref).not.toContain("first-class `gateway` tool");
    expect(ref).not.toContain("`gateway` tool action `restart`");
    expect(ref).toContain("`openclaw config`");
    expect(ref).toContain("gateway-restart skill");
    for (const kept of CLI_REFERENCE.filter((line) => !line.includes("`gateway` tool"))) {
      expect(ref).toContain(kept);
    }
  });
});

describe("adaptCorePromptForClaudeCode: the rest of the prompt", () => {
  it("keeps the identity line, unrelated sections and injected files byte-identical", () => {
    const out = adaptCorePromptForClaudeCode(PROMPT, { cwd: LEGACY_CWD });
    expect(out.split("\n")[0]).toBe(IDENTITY);
    for (const kept of [EXECUTION_BIAS, SAFETY, SKILLS, MEMORY, DOCUMENTATION]) {
      expect(section(out, kept[0].slice(3))).toBe(kept.join("\n"));
    }
    expect(out.endsWith(`\n${INJECTED.join("\n")}`)).toBe(true);
  });

  it("is idempotent", () => {
    for (const cwd of [WORKSPACE, LEGACY_CWD]) {
      const once = adaptCorePromptForClaudeCode(PROMPT, { cwd });
      expect(once).not.toBe(PROMPT);
      expect(adaptCorePromptForClaudeCode(once, { cwd })).toBe(once);
    }
  });

  it("returns a prompt without these sections unchanged", () => {
    const prompt = build(SAFETY, SKILLS, MEMORY);
    expect(adaptCorePromptForClaudeCode(prompt, { cwd: LEGACY_CWD })).toBe(prompt);
    expect(adaptCorePromptForClaudeCode("", { cwd: LEGACY_CWD })).toBe("");
  });
});
