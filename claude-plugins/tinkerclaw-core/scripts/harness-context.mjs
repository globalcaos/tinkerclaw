#!/usr/bin/env node
/**
 * Claude Code SessionStart hook (startup | clear | compact): tell the model which harness it is in,
 * what it shares with the same assistant in the other harness, and what this side lacks. On plain
 * Claude Code it also carries the workspace persona and context files a chat worker already gets in
 * its system prompt.
 *
 * FORK 2026-10-09 — one assistant runs in two harnesses on one machine, and neither side was told
 * the other exists:
 *   - worker: the `claude` child the tinker-bridge spawns for each chat; the bridge always exports
 *     TC_SESSION_KEY to it (worker.ts). It gets part 1 only, a short card: the gateway already put
 *     the workspace files into its system prompt and matches recipes on every turn, so sending
 *     either again would spend its context on copies.
 *   - claude-code: any session without TC_SESSION_KEY. Part 1 is its card; parts 2..N carry the
 *     workspace files (SOUL, IDENTITY, USER, TOOLS, AGENTS by default).
 *
 * NAMES come from <state dir>/harness-identity.json, never from this code, so a deployment on
 * another machine does not inherit ours:
 *   {"claudeCode":{"name":"…"},"worker":{"name":"…"},"bootstrapFiles":["SOUL.md",…],"recipeHints":true}
 * Missing or not a JSON object: generic wording and the default file list.
 *
 * NO WORKSPACE, NO CARD. When the resolved workspace directory does not exist there is nothing on
 * this machine to share with a worker, and a card naming paths that are not there sends the model
 * looking for them; every slot stays silent, as the moral code hook does with no published pack.
 * delivery-parts.test.ts relies on this: it runs every SessionStart command against a state dir that
 * holds only a moral code pack, and must see the moral code alone.
 *
 * Delivery mirrors the moral code (moral-code-session-start.mjs): hooks.json runs PART_SLOTS
 * commands, `--part 1` … `--part N`; each prints part i, a complete block under the CLI's
 * 10,000-char cap on one hook's additionalContext; a slot past the last part prints nothing; the
 * per-kind lock in hook-common.mjs keeps a twice-loaded plugin from delivering twice.
 * No dependencies, by design: this runs on every new session and every compaction.
 */
import fs from "node:fs";
import path from "node:path";
import {
  claim,
  expandHome,
  harnessSide,
  partArg,
  readJsonFile,
  readStdin,
  splitIntoParts,
  stateDir,
} from "./hook-common.mjs";

/** Opening tag of every part; with CLOSE it delimits one part. */
const OPEN = '<harness_context source="tinkerclaw-core">';
const CLOSE = "</harness_context>";
/** One part, wrapper and label included, stays under this: the CLI's cap is 10,000 chars. */
const PART_MAX_CHARS = 9_500;
/** Hook slots hooks.json registers for this script, one part each: room for ~110k chars. */
const PART_SLOTS = 12;
/** The workspace files carried to plain Claude Code when harness-identity.json names none. */
const DEFAULT_BOOTSTRAP_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "AGENTS.md"];
/**
 * How plain Claude Code reads the chat side's conversations: two tools of the gateway's MCP server.
 * FORK 2026-10-09: the card first pointed at `openclaw gateway call engram.search`, which answered 0
 * results on every store probed that day (a word taken from the store itself included), so it named a
 * dead path. The sessions tools were checked live and answer.
 */
const CHAT_HISTORY_TOOLS = "`sessions_list` and `sessions_history`";

/** Part i of n, as delivered: opening tag, label, the part's text, closing tag. */
function wrap(i, n, body) {
  return `${OPEN}\n[harness context, part ${i} of ${n}]\n${body}${CLOSE}`;
}

/** A name from harness-identity.json as one short line of plain text; "" when unset. */
function cleanName(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The workspace: agents.defaults.workspace in <state>/openclaw.json when that file parses and the key
 * is a string (`~` expanded, relative to the state dir); else the tinker-bridge's profile rule
 * (defaults.ts resolveDefaultCwd) under the state dir: workspace-<OPENCLAW_PROFILE> for a profile
 * other than "default", workspace otherwise.
 */
function workspaceDir(state) {
  const configured = readJsonFile(path.join(state, "openclaw.json"))?.agents?.defaults?.workspace;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(state, expandHome(configured.trim()));
  }
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(state, `workspace-${profile}`);
  }
  return path.join(state, "workspace");
}

/** The listed workspace files that exist and are not empty, in list order: { name, file, text }. */
function workspaceFiles(workspace, identity) {
  const listed = Array.isArray(identity.bootstrapFiles)
    ? identity.bootstrapFiles
    : DEFAULT_BOOTSTRAP_FILES;
  const seen = new Set();
  const out = [];
  for (const entry of listed) {
    const name = typeof entry === "string" ? entry.trim() : "";
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const file = path.resolve(workspace, name);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8").trim();
    } catch {
      continue;
    }
    if (text) {
      out.push({ name, file, text });
    }
  }
  return out;
}

/** Part 1 on plain Claude Code. */
function claudeCodeCard(names, state, workspace, files, recipeHints) {
  const self = names.claudeCode ? `You are ${names.claudeCode}, running` : "You are running";
  const other = names.worker ? ` (there it goes by ${names.worker})` : "";
  const catalog = path.join(state, "prefrontal", "recipe-index.json");
  const lines = [
    "# Which harness you are in",
    "",
    `${self} in plain Claude Code, outside the TinkerClaw gateway: a terminal session or a background job, not a chat.`,
    "",
    `The same assistant also answers in TinkerClaw's chat UI and on its messaging channels, as a worker the gateway spawns for each chat${other}. One assistant, two harnesses.`,
    "",
    "## Shared with the chat worker",
    "",
    "- The auto-memory bank and its MEMORY.md index.",
    "- The workspace, with its AGENTS.md, memory/ and skills/.",
    "- The saved recipes.",
    "- The moral code, which this same plugin delivers to both sides.",
    "",
    "## Only here",
    "",
    "- Claude Code's Agent tool, AskUserQuestion and background jobs.",
    "",
    "## Missing here",
    "",
    "- The Tinker web UI.",
    "- The gateway's per-turn context: the recall pack, recipe matching, model routing, the curiosity and humor blocks, and the reflection turn.",
    "",
    "## Chat rules that do not apply in a terminal",
    "",
    'Rules written for the Tinker chat or the messaging channels do not apply here: the spoken first line in italics and its audio, `html-render` blocks and closing summary cards, the FRACTAL reflection block and its turn, and "the reply must be the last text block". Write plain Markdown.',
    "",
    "## Reaching what the gateway would have added",
    "",
    `- Saved recipes: the jarvis-recipe skill runs one by slug; the catalog is ${catalog}.${recipeHints ? " This plugin also lists likely matches under each prompt." : ""}`,
    `- The chat side's conversations: the ${CHAT_HISTORY_TOOLS} tools of the gateway MCP server (load them with ToolSearch first; needs the gateway running).`,
    "- The shared model quota: the `budget_check` tool of the gateway MCP server, when that server is listed.",
    "",
  ];
  if (files.length > 0) {
    lines.push(
      "## Workspace files",
      "",
      `Parts 2 and on of this harness context carry the workspace files a chat worker gets in its system prompt: ${files.map((f) => f.name).join(", ")}. They describe you; read them as yours.`,
      "",
    );
  }
  lines.push("## Paths", "", `- State dir: ${state}`, `- Workspace: ${workspace}`, "");
  return lines.join("\n");
}

/** Part 1, and the only part, on a chat worker. */
function workerCard(names, state, workspace) {
  const self = names.worker ? `You are ${names.worker}, running` : "You are running";
  const other = names.claudeCode ? ` (there it goes by ${names.claudeCode})` : "";
  return [
    "# Which harness you are in",
    "",
    `${self} as a TinkerClaw chat worker: the claude process the gateway spawned for this chat.`,
    "",
    `The same assistant also runs in plain Claude Code, in a terminal or a background job${other}. It shares your memory bank (the auto-memory and its MEMORY.md index), the workspace with its skills, the saved recipes and the moral code. It does not see this chat and gets none of the gateway's per-turn context, so a note meant for it goes into memory or the workspace.`,
    "",
    "Claude Code's built-in Agent tool is switched off in workers by default. Fan work out through the Workflow tool, or through the gateway's subagent helper described in your system prompt.",
    "",
    `- State dir: ${state}`,
    `- Workspace: ${workspace}`,
    "",
  ].join("\n");
}

const input = readStdin();
const source = typeof input.source === "string" ? input.source : "startup";
const part = partArg();
const state = stateDir();
const workspace = workspaceDir(state);
if (!isDir(workspace)) {
  process.exit(0);
}
if (!claim("harness-context", input.session_id, source, part)) {
  process.exit(0);
}

const raw = readJsonFile(path.join(state, "harness-identity.json"));
const identity = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
const names = {
  claudeCode: cleanName(identity.claudeCode?.name),
  worker: cleanName(identity.worker?.name),
};
// The wrapper of a two-digit part number: every part is measured against the worst case.
const budget = PART_MAX_CHARS - wrap(99, 99, "").length;
let bodies;
if (harnessSide() === "worker") {
  bodies = splitIntoParts(workerCard(names, state, workspace), budget);
} else {
  const files = workspaceFiles(workspace, identity);
  const card = claudeCodeCard(names, state, workspace, files, identity.recipeHints !== false);
  const text = files
    .map((f) => `## Workspace file: ${f.name} (${f.file})\n\n${f.text}\n\n`)
    .join("");
  bodies = [...splitIntoParts(card, budget), ...(text ? splitIntoParts(text, budget) : [])];
}

const n = bodies.length;
if (part === PART_SLOTS && n > PART_SLOTS) {
  // Never silent: the parts past the last slot are not delivered.
  process.stderr.write(
    `tinkerclaw-core: the harness context needs ${n} parts and hooks.json has ${PART_SLOTS} slots — parts ${PART_SLOTS + 1}..${n} were NOT delivered; trim bootstrapFiles in harness-identity.json or add slots\n`,
  );
}
if (part > n) {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: wrap(part, n, bodies[part - 1]),
    },
  }),
);
