/**
 * FORK 2026-09-29 — usage attribution: one tool call → the skill / recipe / plugin marks the Tinker
 * chat draws as chips (plan `docs/superpowers/plans/2026-09-29-chat-usage-chips-and-typed-outcomes.md`,
 * unit U6; bible tinker-ui.md §5.8N/§5.8O as amended by decision D1).
 *
 * Why CODE and not a prompt: the chips used to wait for the model to write "Using skill X". The
 * 2026-09-29 census found a chip in 91 of ~370 turns that used a skill, recipe or plugin, and zero
 * recipe or plugin chips. A tool call's NAME and structured ARGUMENTS fire on every turn, so the chip
 * hangs on them. The model's prose is never read here.
 *
 * Rules (plan "Attribution rules", D1, D2):
 *  - read / Read (`path|file_path|filePath|target`, `~` and cwd resolved): a file inside a skill
 *    directory (`…/skills/<n>/SKILL.md` and its siblings) → skill `<n>`; under
 *    `<claude>/plugins/cache/<marketplace>/<plugin>/<version>/skills/<n>/` → `<plugin>:<n>`.
 *    A `.md` under a recipe root → recipe, titled by the registry (CATALOG/README/INDEX/AUTHORING
 *    never count).
 *  - exec / Bash / bash / shell (`command|cmd`): every path-like token of the command. A token
 *    strictly INSIDE `<x>/skills/<n>/` whose `SKILL.md` exists → skill (D1: 167 SKILL.md reads and 84
 *    script-only skill turns went through Bash, all invisible). A recipe .md token → recipe.
 *    `recipe-state` → recipe by slug. The skills ROOT never counts, so `ls ~/.claude/skills` or
 *    `grep -r x skills/` cannot draw one chip per skill (review focus 2). Write-shaped segments are
 *    skipped: `sed -i` / `perl -i`, `tee`, a `>` redirect target, a copy destination, and
 *    maintenance commands (rm, mv, mkdir, chmod, git …) — editing a skill is not using it.
 *  - Skill tool → a skill mark (path from `skillDirByName`, none when unknown) plus, for
 *    `jarvis-recipe <slug>`, a recipe mark.
 *  - `mcp__<server>__<tool>` → a plugin mark named by the tool's owning plugin, else `<server>` (D2).
 *  - Any other tool a plugin owns → a plugin mark. Everything else → [].
 *
 * `attributeToolUsage` and `mergeUsageMarks` are pure given a registry and never throw. Every
 * filesystem probe lives in the registry and is cached, so `chat.history` stays on its fast path
 * (review focus 5). `getUsageRegistry()` rebuilds the real registry at most once per 60 s.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveBundledSkillsDir } from "../agents/skills/bundled-dir.js";
import { normalizeToolName } from "../agents/tool-policy-shared.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { PluginToolRegistration } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";

// ── Contract (plan "Contracts"; do not rename) ─────────────────────────────────────────────────

export type UsageKind = "skill" | "recipe" | "plugin";
export type UsageVia =
  | "read"
  | "exec"
  | "skill-tool"
  | "recipe-cli"
  | "recipe-skill"
  | "mcp"
  | "plugin-tool";
export interface UsageMark {
  kind: UsageKind;
  name: string;
  path?: string;
  via: UsageVia;
  toolCallId?: string;
}
export interface ToolCallLike {
  name: string;
  args?: unknown;
  toolCallId?: string;
}
/**
 * One skill, recipe or plugin the registry can resolve. A plugin is listed only when it registers tools (that is how
 * a tool call is attributed to it), and its `path` is its manifest, or empty when the manifest is not on disk.
 */
export interface UsageListing {
  kind: "skill" | "recipe" | "plugin";
  /** The name a mark carries: a skill's directory name (`<plugin>:<n>` in the plugin cache), a recipe's title, a plugin's id. */
  name: string;
  path: string;
}

export interface UsageRegistry {
  /** "<skill>" or "<plugin>:<skill>" → the skill DIRECTORY (the mark links `<dir>/SKILL.md`). */
  skillDirByName(name: string): string | undefined;
  recipeByPath(absPath: string): { title: string; path: string } | undefined;
  recipeBySlug(slug: string): { title: string; path: string } | undefined;
  /** Owning plugin of a tool name; undefined for core tools. */
  pluginForTool(toolName: string): { pluginId: string; path?: string } | undefined;
  isRecipePath(absPath: string): boolean;
  /**
   * Optional extension of the plan's contract: true when `<absDir>/SKILL.md` exists. The exec rule
   * ("a token inside `<x>/skills/<n>/` where that SKILL.md exists") is an existence check, and
   * `skillDirByName` cannot answer it for a second copy of one name (every cached plugin version,
   * a repo copy of a workspace skill). Registries without it fall back to "the path names SKILL.md
   * itself, or `skillDirByName(<n>)` is exactly this directory".
   */
  isSkillDir?(absDir: string): boolean;
  /**
   * Optional (FORK 2026-09-30, THALAMUS v4 section 13A): every skill and recipe this registry can resolve,
   * first-wins by name, with the same names `attributeToolUsage` puts on a mark. It exists so the enhancement
   * cards can be seeded from what is really installed. Registries built without it simply lack it.
   */
  list?(): UsageListing[];
}

const USAGE_KINDS: ReadonlySet<string> = new Set<UsageKind>(["skill", "recipe", "plugin"]);
const USAGE_VIAS: ReadonlySet<string> = new Set<UsageVia>([
  "read",
  "exec",
  "skill-tool",
  "recipe-cli",
  "recipe-skill",
  "mcp",
  "plugin-tool",
]);

export function isUsageMark(v: unknown): v is UsageMark {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return false;
  }
  const m = v as Record<string, unknown>;
  return (
    typeof m.kind === "string" &&
    USAGE_KINDS.has(m.kind) &&
    typeof m.name === "string" &&
    m.name.trim().length > 0 &&
    typeof m.via === "string" &&
    USAGE_VIAS.has(m.via) &&
    (m.path === undefined || typeof m.path === "string") &&
    (m.toolCallId === undefined || typeof m.toolCallId === "string")
  );
}

/** Union of two mark lists, de-duplicated by kind+name; a mark with a path beats one without. */
export function mergeUsageMarks(a: readonly UsageMark[], b: readonly UsageMark[]): UsageMark[] {
  const out: UsageMark[] = [];
  const at = new Map<string, number>();
  for (const list of [a, b]) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const mark of list) {
      if (!isUsageMark(mark)) {
        continue;
      }
      const key = `${mark.kind}:${mark.name}`; // kind is a fixed word without a colon
      const index = at.get(key);
      if (index === undefined) {
        at.set(key, out.length);
        out.push({ ...mark });
      } else if (!out[index].path && mark.path) {
        out[index] = { ...mark };
      }
    }
  }
  return out;
}

// ── Attribution (pure given a registry; never throws) ──────────────────────────────────────────

const RECIPE_RUNNER_SKILL = "jarvis-recipe";
const READ_PATH_KEYS = ["path", "file_path", "filePath", "target"] as const;
const EXEC_COMMAND_KEYS = ["command", "cmd"] as const;
/** A heredoc can carry a whole file; attribution reads the head of a command only. */
const MAX_COMMAND_CHARS = 16_000;
const SKILL_FILE = "SKILL.md";

interface PathContext {
  homeDir: string;
  cwd: string;
}

export function attributeToolUsage(
  call: ToolCallLike,
  reg: UsageRegistry,
  opts?: { homeDir?: string; cwd?: string },
): UsageMark[] {
  try {
    return mergeUsageMarks(attributeCall(call, reg, opts), []);
  } catch {
    return [];
  }
}

function attributeCall(
  call: ToolCallLike,
  reg: UsageRegistry,
  opts: { homeDir?: string; cwd?: string } | undefined,
): UsageMark[] {
  if (!call || typeof call !== "object" || !reg) {
    return [];
  }
  const name = typeof call.name === "string" ? call.name.trim() : "";
  if (!name) {
    return [];
  }
  const ctx: PathContext = {
    homeDir: opts?.homeDir || safeHomeDir(),
    cwd: opts?.cwd || safeCwd(),
  };
  // MCP first and off the RAW name: `mcp__claude_ai_Gmail__search` carries a case-sensitive
  // server id. The rest goes through core's alias table (`Read`→read, `Bash`/`bash`→exec).
  const tool = name.startsWith("mcp__") ? "" : normalizeToolName(name);
  let marks: UsageMark[];
  if (!tool) {
    marks = attributeMcp(name, reg);
  } else if (tool === "read") {
    marks = attributeRead(readArgs(call.args), reg, ctx);
  } else if (tool === "exec" || tool === "shell") {
    marks = attributeExec(readArgs(call.args), reg, ctx);
  } else if (tool === "skill") {
    marks = attributeSkillTool(readArgs(call.args), reg);
  } else {
    const owner = pluginOwner(reg, name);
    marks = owner ? [pluginMark(owner.pluginId, owner.path, "plugin-tool")] : [];
  }
  const toolCallId =
    typeof call.toolCallId === "string" && call.toolCallId ? call.toolCallId : undefined;
  return toolCallId ? marks.map((mark) => ({ ...mark, toolCallId })) : marks;
}

function attributeRead(
  args: Record<string, unknown>,
  reg: UsageRegistry,
  ctx: PathContext,
): UsageMark[] {
  const raw = firstString(args, READ_PATH_KEYS);
  const abs = raw ? resolveToolPath(raw, ctx) : undefined;
  if (!abs) {
    return [];
  }
  const skill = skillFromPath(abs, reg);
  if (skill) {
    return [{ kind: "skill", name: skill.name, path: skill.path, via: "read" }];
  }
  const recipe = recipeFromPath(abs, reg);
  return recipe ? [{ kind: "recipe", name: recipe.title, path: recipe.path, via: "read" }] : [];
}

function attributeExec(
  args: Record<string, unknown>,
  reg: UsageRegistry,
  ctx: PathContext,
): UsageMark[] {
  const command = firstString(args, EXEC_COMMAND_KEYS);
  if (!command) {
    return [];
  }
  const workdir = firstString(args, ["workdir", "cwd"] as const);
  let cwd = (workdir && resolveToolPath(expandHomeVar(workdir), ctx)) || ctx.cwd;
  const marks: UsageMark[] = [];
  for (const words of splitShellSegments(command.slice(0, MAX_COMMAND_CHARS))) {
    const at = commandIndex(words);
    if (at < 0) {
      continue;
    }
    const head = baseName(words[at].text);
    if (head === "cd" || head === "pushd") {
      const target = words[at + 1]?.text;
      const next = !target
        ? ctx.homeDir
        : target === "-"
          ? undefined
          : resolveToolPath(expandHomeVar(target), { homeDir: ctx.homeDir, cwd });
      if (next) {
        cwd = next;
      }
      continue;
    }
    if (isWriteShaped(head, words, at)) {
      continue;
    }
    const recipeSlug = recipeStateSlug(words, at);
    if (recipeSlug !== undefined) {
      if (recipeSlug) {
        marks.push(recipeMarkBySlug(recipeSlug, reg, "recipe-cli"));
      }
      continue;
    }
    const copyDestination = COPY_COMMANDS.has(head) ? lastOperandIndex(words, at) : -1;
    const local: PathContext = { homeDir: ctx.homeDir, cwd };
    for (let i = 0; i < words.length; i += 1) {
      if (words[i].redirectTarget || i === copyDestination) {
        continue;
      }
      for (const token of pathTokens(words[i].text)) {
        const abs = resolveToolPath(token, local);
        if (!abs) {
          continue;
        }
        const skill = skillFromPath(abs, reg);
        if (skill) {
          marks.push({ kind: "skill", name: skill.name, path: skill.path, via: "exec" });
          continue;
        }
        const recipe = recipeFromPath(abs, reg);
        if (recipe) {
          marks.push({ kind: "recipe", name: recipe.title, path: recipe.path, via: "exec" });
        }
      }
    }
  }
  return marks;
}

function attributeSkillTool(args: Record<string, unknown>, reg: UsageRegistry): UsageMark[] {
  // Claude Code's Skill tool input is `{skill, args?}` (191 of 191 calls in the local transcripts).
  const raw = firstString(args, ["skill"]);
  const name = raw?.trim().replace(/^\//, "").split(/\s+/)[0];
  if (!name) {
    return [];
  }
  const dir = reg.skillDirByName(name);
  const marks: UsageMark[] = [
    {
      kind: "skill",
      name,
      ...(typeof dir === "string" && dir ? { path: path.join(dir, SKILL_FILE) } : {}),
      via: "skill-tool",
    },
  ];
  if (name === RECIPE_RUNNER_SKILL || name.endsWith(`:${RECIPE_RUNNER_SKILL}`)) {
    const slug = recipeSlugFromSkillArgs(args.args);
    if (slug) {
      marks.push(recipeMarkBySlug(slug, reg, "recipe-skill"));
    }
  }
  return marks;
}

function attributeMcp(name: string, reg: UsageRegistry): UsageMark[] {
  const parts = name.split("__");
  const server = parts[1]?.trim();
  const tool = parts.slice(2).join("__");
  if (!server || !tool) {
    return [];
  }
  const owner = pluginOwner(reg, tool);
  return [pluginMark(owner?.pluginId ?? server, owner?.path, "mcp")];
}

function pluginOwner(
  reg: UsageRegistry,
  tool: string,
): { pluginId: string; path?: string } | undefined {
  const owner = reg.pluginForTool(tool);
  return owner && typeof owner.pluginId === "string" && owner.pluginId.trim() ? owner : undefined;
}

function pluginMark(name: string, markPath: string | undefined, via: UsageVia): UsageMark {
  return {
    kind: "plugin",
    name,
    ...(typeof markPath === "string" && markPath ? { path: markPath } : {}),
    via,
  };
}

function recipeMarkBySlug(slug: string, reg: UsageRegistry, via: UsageVia): UsageMark {
  const hit = reg.recipeBySlug(slug);
  return hit && typeof hit.title === "string" && hit.title
    ? { kind: "recipe", name: hit.title, path: hit.path, via }
    : { kind: "recipe", name: slug, via };
}

function recipeSlugFromSkillArgs(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    return normalizeSlug(raw.trim().split(/\s+/)[0] ?? "");
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of ["slug", "recipe", "kitRef"]) {
      const value = record[key];
      if (typeof value === "string") {
        return normalizeSlug(value);
      }
    }
  }
  return undefined;
}

/** `owner/slug`, `kit:owner/slug` and quoted forms → `slug`; anything else → undefined. */
function normalizeSlug(raw: string): string | undefined {
  const bare = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^kit:/, "");
  const slug = bare.slice(bare.lastIndexOf("/") + 1);
  return slug.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) ? slug : undefined;
}

// ── Paths ──────────────────────────────────────────────────────────────────────────────────────

const SKILLS_SEGMENT = "/skills/";
const GLOB_CHARS = /[*?[\]{}]/;
const PLUGIN_CACHE_SKILL_DIR = /\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\/([^/]+)$/;
const PLUGIN_CACHE_SKILLS_ROOT = /\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\/?$/;

function toSlash(p: string): string {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}

function safeHomeDir(): string {
  try {
    return os.homedir();
  } catch {
    return "";
  }
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return "";
  }
}

const NUL = String.fromCharCode(0);

function resolveToolPath(raw: string, ctx: PathContext): string | undefined {
  let p = raw.trim();
  if (!p || p.includes(NUL) || p.includes("://")) {
    return undefined;
  }
  if (p === "~" || p.startsWith("~/")) {
    if (!ctx.homeDir) {
      return undefined;
    }
    p = path.join(ctx.homeDir, p.slice(1));
  } else if (p.startsWith("~")) {
    return undefined; // ~otheruser/… cannot be resolved here
  }
  if (path.isAbsolute(p)) {
    return path.resolve(p);
  }
  return ctx.cwd ? path.resolve(ctx.cwd, p) : undefined;
}

function expandHomeVar(text: string): string {
  return text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, "~");
}

/**
 * The skill a path belongs to: the deepest `<x>/skills/<n>/` that holds a SKILL.md and that the
 * path is strictly INSIDE (the directory itself and the skills root never count).
 */
function skillFromPath(
  absPath: string,
  reg: UsageRegistry,
): { name: string; path: string } | undefined {
  const p = toSlash(absPath);
  let idx = p.lastIndexOf(SKILLS_SEGMENT);
  while (idx >= 0) {
    const after = p.slice(idx + SKILLS_SEGMENT.length);
    const slash = after.indexOf("/");
    const seg = slash < 0 ? after : after.slice(0, slash);
    const rest = slash < 0 ? "" : after.slice(slash + 1).replace(/\/+$/, "");
    if (seg && seg !== "." && seg !== ".." && !GLOB_CHARS.test(seg) && rest) {
      const dir = p.slice(0, idx + SKILLS_SEGMENT.length + seg.length);
      const cached = PLUGIN_CACHE_SKILL_DIR.exec(dir);
      const name = cached ? `${cached[1]}:${cached[2]}` : seg;
      if (isRegisteredSkillDir(dir, name, rest, reg)) {
        return { name, path: `${dir}/${SKILL_FILE}` };
      }
    }
    idx = idx > 0 ? p.lastIndexOf(SKILLS_SEGMENT, idx - 1) : -1;
  }
  return undefined;
}

function isRegisteredSkillDir(
  dir: string,
  name: string,
  rest: string,
  reg: UsageRegistry,
): boolean {
  if (typeof reg.isSkillDir === "function") {
    return reg.isSkillDir(dir) === true;
  }
  if (rest === SKILL_FILE) {
    return true;
  }
  const known = reg.skillDirByName(name);
  return typeof known === "string" && toSlash(path.resolve(known)) === dir;
}

function recipeFromPath(
  absPath: string,
  reg: UsageRegistry,
): { title: string; path: string } | undefined {
  if (!absPath.endsWith(".md") || !reg.isRecipePath(absPath)) {
    return undefined;
  }
  const hit = reg.recipeByPath(absPath);
  return hit && typeof hit.title === "string" && hit.title ? hit : undefined;
}

// ── A small shell reader (quotes, separators, redirects) ────────────────────────────────────────

interface ShellWord {
  text: string;
  /** The word follows `>` / `>>` / `>|`: a file the command WRITES. */
  redirectTarget: boolean;
}

/** Split a command into segments (`;`, `&&`, `||`, `|`, `&`, newline, parentheses) of words. */
function splitShellSegments(src: string): ShellWord[][] {
  const segments: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  let pendingRedirect = false;
  const endWord = () => {
    if (started) {
      words.push({ text: cur, redirectTarget: pendingRedirect });
      pendingRedirect = false;
    }
    cur = "";
    started = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) {
      segments.push(words);
    }
    words = [];
    pendingRedirect = false;
  };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < src.length) {
        i += 1;
        cur += src[i];
      } else {
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < src.length) {
      i += 1;
      if (src[i] !== "\n") {
        cur += src[i];
        started = true;
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      continue;
    }
    if (c === "&" && src[i + 1] === ">") {
      endWord(); // `&>file`: the `>` below marks the target
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
      endSegment();
      continue;
    }
    if (c === ">") {
      if (started && /^\d+$/.test(cur)) {
        cur = ""; // `2>`: the digits are a file descriptor, not a word
        started = false;
      } else {
        endWord();
      }
      if (src[i + 1] === ">" || src[i + 1] === "|") {
        i += 1;
      }
      if (src[i + 1] === "&") {
        i += 1; // `>&2` / `2>&1`: duplicates a descriptor, no file target
        while (i + 1 < src.length && /[0-9-]/.test(src[i + 1])) {
          i += 1;
        }
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    if (c === "<") {
      endWord(); // input redirect / heredoc: what follows is read, not written
      while (src[i + 1] === "<" || src[i + 1] === "-") {
        i += 1;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  endSegment();
  return segments;
}

const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "time",
  "nohup",
  "command",
  "builtin",
  "exec",
  "nice",
  "xargs",
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "{",
]);
/** Editing, moving, deleting or versioning a skill/recipe file is maintenance, not use. */
const MAINTENANCE_COMMANDS: ReadonlySet<string> = new Set([
  "tee",
  "rm",
  "rmdir",
  "mv",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "truncate",
  "unlink",
  "git",
]);
const IN_PLACE_EDITORS: ReadonlySet<string> = new Set(["sed", "perl"]);
/** The LAST operand is the destination (written); the sources are read. */
const COPY_COMMANDS: ReadonlySet<string> = new Set(["cp", "install", "ln", "rsync", "scp"]);
const INTERPRETERS: ReadonlySet<string> = new Set([
  "node",
  "bun",
  "deno",
  "tsx",
  "npx",
  "python",
  "python3",
  "bash",
  "sh",
]);
const RECIPE_STATE_CLI = /(?:^|[-_])recipe-state(?:\.[cm]?js)?$/;
const PATH_TOKEN_SPLIT = /[\s'"`()[\]{},;=<>|&]+/;
const FILE_WITH_EXTENSION = /^[^/]+\.[A-Za-z0-9]{1,6}$/;

function baseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash < 0 ? word : word.slice(slash + 1);
}

function commandIndex(words: ShellWord[]): number {
  for (let i = 0; i < words.length; i += 1) {
    const text = words[i].text;
    if (words[i].redirectTarget || /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
      continue;
    }
    if (COMMAND_PREFIXES.has(text)) {
      continue;
    }
    if (text === "timeout") {
      if (words[i + 1] && /^\d/.test(words[i + 1].text)) {
        i += 1;
      }
      continue;
    }
    return i;
  }
  return -1;
}

function isWriteShaped(head: string, words: ShellWord[], at: number): boolean {
  if (MAINTENANCE_COMMANDS.has(head)) {
    return true;
  }
  if (IN_PLACE_EDITORS.has(head)) {
    return words
      .slice(at + 1)
      .some((w) => /^-[A-Za-z]*i/.test(w.text) || w.text.startsWith("--in-place"));
  }
  return false;
}

function lastOperandIndex(words: ShellWord[], at: number): number {
  for (let i = words.length - 1; i > at; i -= 1) {
    if (!words[i].redirectTarget && !words[i].text.startsWith("-")) {
      return i;
    }
  }
  return -1;
}

/** undefined: not a recipe-state call. "": a recipe-state call without a usable slug. */
function recipeStateSlug(words: ShellWord[], at: number): string | undefined {
  let i = at;
  let head = baseName(words[i].text);
  if (INTERPRETERS.has(head)) {
    i = words.findIndex((w, j) => j > at && !w.text.startsWith("-"));
    if (i < 0) {
      return undefined;
    }
    head = baseName(words[i].text);
  }
  if (!RECIPE_STATE_CLI.test(head)) {
    return undefined;
  }
  const rest = words.slice(i + 1).map((w) => w.text);
  for (let j = 0; j < rest.length; j += 1) {
    if (rest[j] === "--recipe") {
      return normalizeSlug(rest[j + 1] ?? "") ?? "";
    }
    if (rest[j].startsWith("--recipe=")) {
      return normalizeSlug(rest[j].slice("--recipe=".length)) ?? "";
    }
  }
  // `recipe-state <sub> <slug>`
  const positional = rest.filter((w) => !w.startsWith("-"));
  return normalizeSlug(positional[1] ?? "") ?? "";
}

function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const piece of expandHomeVar(text).split(PATH_TOKEN_SPLIT)) {
    if (!piece || piece.includes("://")) {
      continue;
    }
    for (const part of piece.split(":")) {
      if (part && (part.includes("/") || FILE_WITH_EXTENSION.test(part))) {
        out.push(part);
      }
    }
  }
  return out;
}

// ── Args ───────────────────────────────────────────────────────────────────────────────────────

function readArgs(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) {
      return {};
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

// ── Registry (fs-backed, every probe cached) ────────────────────────────────────────────────────

/** Recipe-library layout, as `extensions/tinkerclaw-prefrontal/recipe-locate.ts` reads it. */
const RECIPE_FILENAMES: ReadonlySet<string> = new Set(["recipe.md", "kit.md"]);
const RECIPE_MAX_DEPTH = 3; // `<root>/<category>/<subdivision>/<name>.md`
/** Library documentation, never a recipe (compared case-insensitively). */
const NON_RECIPE_MD: ReadonlySet<string> = new Set([
  "catalog.md",
  "readme.md",
  "index.md",
  "authoring.md",
]);
/** Prefrontal's own library, in any checkout: `<repo>/extensions/tinkerclaw-prefrontal/recipes`. */
const RECIPE_LIBRARY_SHAPE = /^(.*\/extensions\/tinkerclaw-prefrontal\/(?:recipes|kits))\/./;
const HEAD_BYTES = 16 * 1024;
const FS_CACHE_LIMIT = 4096;

interface RecipeInfo {
  title: string;
  declaredSlug?: string;
}

interface SkillDirEntry {
  prefix: string;
  child: string;
  dir: string;
}

export function createUsageRegistry(opts: {
  skillRoots: string[];
  recipeRoots: string[];
  pluginToolOwner?: (tool: string) => { pluginId: string; path?: string } | undefined;
  /** The plugins that register tools, for `list()`. Absent: plugins are not listed. */
  pluginList?: () => Array<{ pluginId: string; path?: string }>;
}): UsageRegistry {
  const skillRoots = uniquePaths(opts?.skillRoots);
  const recipeRoots = uniquePaths(opts?.recipeRoots);
  const pluginToolOwner = opts?.pluginToolOwner;
  const pluginList = opts?.pluginList;

  const skillDirCache = new Map<string, boolean>();
  const rememberSkillDir = (dir: string, hit: boolean) => {
    if (skillDirCache.size >= FS_CACHE_LIMIT) {
      skillDirCache.clear();
    }
    skillDirCache.set(dir, hit);
  };
  let skillEntries: SkillDirEntry[] | undefined;
  const listSkillDirs = (): SkillDirEntry[] => {
    if (!skillEntries) {
      skillEntries = [];
      for (const root of skillRoots) {
        const cacheRoot = PLUGIN_CACHE_SKILLS_ROOT.exec(toSlash(root));
        const prefix = cacheRoot ? `${cacheRoot[1]}:` : "";
        for (const child of listDirNames(root)) {
          const dir = path.join(root, child);
          const hit = fileExists(path.join(dir, SKILL_FILE));
          rememberSkillDir(dir, hit);
          if (hit) {
            skillEntries.push({ prefix, child, dir });
          }
        }
      }
    }
    return skillEntries;
  };
  let byDirName: Map<string, string> | undefined;
  let byDeclaredName: Map<string, string> | undefined;
  const skillDirByName = (name: string): string | undefined => {
    const key = typeof name === "string" ? name.trim() : "";
    if (!key) {
      return undefined;
    }
    byDirName ??= firstWins(
      listSkillDirs().map((e): [string, string] => [e.prefix + e.child, e.dir]),
    );
    const hit = byDirName.get(key);
    if (hit) {
      return hit;
    }
    // Rare: a SKILL.md whose frontmatter `name:` differs from its directory. Read only on a miss.
    byDeclaredName ??= firstWins(
      listSkillDirs().flatMap((e): Array<[string, string]> => {
        const declared = readSkillName(path.join(e.dir, SKILL_FILE));
        return declared ? [[e.prefix + declared, e.dir]] : [];
      }),
    );
    return byDeclaredName.get(key);
  };
  const isSkillDir = (absDir: string): boolean => {
    if (typeof absDir !== "string" || !absDir) {
      return false;
    }
    const dir = path.resolve(absDir);
    const cached = skillDirCache.get(dir);
    if (cached !== undefined) {
      return cached;
    }
    const hit = fileExists(path.join(dir, SKILL_FILE));
    rememberSkillDir(dir, hit);
    return hit;
  };

  let recipeRootForms: string[] | undefined;
  const rootForms = (): string[] => {
    recipeRootForms ??= uniquePaths(recipeRoots.flatMap((root) => [root, safeRealpath(root)]));
    return recipeRootForms;
  };
  const isRecipePath = (absPath: string): boolean => {
    if (typeof absPath !== "string" || !absPath.endsWith(".md")) {
      return false;
    }
    const file = path.resolve(absPath);
    if (rootForms().some((root) => isRecipeRelPath(path.relative(root, file)))) {
      return true;
    }
    // The same library read from another checkout (a worktree, the source tree while the gateway
    // runs a deploy) is still the recipe library, the way `…/skills/<n>/` is still a skill.
    const library = RECIPE_LIBRARY_SHAPE.exec(toSlash(file));
    return library ? isRecipeRelPath(path.relative(library[1], file)) : false;
  };
  const recipeInfoCache = new Map<string, RecipeInfo | null>();
  const recipeInfo = (file: string): RecipeInfo | null => {
    const cached = recipeInfoCache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const text = readHead(file, HEAD_BYTES);
    const info = text === undefined ? null : parseRecipeInfo(file, text);
    if (recipeInfoCache.size >= FS_CACHE_LIMIT) {
      recipeInfoCache.clear();
    }
    recipeInfoCache.set(file, info);
    return info;
  };
  const recipeByPath = (absPath: string): { title: string; path: string } | undefined => {
    if (!isRecipePath(absPath)) {
      return undefined;
    }
    const file = path.resolve(absPath);
    const info = recipeInfo(file);
    return info ? { title: info.title, path: file } : undefined;
  };
  let recipeFiles: string[] | undefined;
  const slugCache = new Map<string, { title: string; path: string } | null>();
  const recipeBySlug = (slug: string): { title: string; path: string } | undefined => {
    const want = typeof slug === "string" ? normalizeSlug(slug) : undefined;
    if (!want) {
      return undefined;
    }
    const cached = slugCache.get(want);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    recipeFiles ??= recipeRoots.flatMap((root) => walkRecipeFiles(root));
    // Path-derived slug first (no reads), then a declared frontmatter `slug:`/`id:` — the order
    // prefrontal's findRecipeFile uses, roots in order (the overlay shadows the bundled copy).
    const file =
      recipeFiles.find((f) => deriveRecipeSlug(f) === want) ??
      recipeFiles.find((f) => recipeInfo(f)?.declaredSlug === want);
    const info = file ? recipeInfo(file) : null;
    const hit = file && info ? { title: info.title, path: file } : null;
    slugCache.set(want, hit);
    return hit ?? undefined;
  };

  const pluginForTool = (toolName: string): { pluginId: string; path?: string } | undefined => {
    if (!pluginToolOwner || typeof toolName !== "string" || !toolName) {
      return undefined;
    }
    try {
      const owner = pluginToolOwner(toolName);
      if (!owner || typeof owner.pluginId !== "string" || !owner.pluginId.trim()) {
        return undefined;
      }
      return {
        pluginId: owner.pluginId,
        ...(typeof owner.path === "string" && owner.path ? { path: owner.path } : {}),
      };
    } catch {
      return undefined;
    }
  };

  const list = (): UsageListing[] => {
    const out: UsageListing[] = [];
    const seen = new Set<string>();
    for (const e of listSkillDirs()) {
      const name = e.prefix + e.child;
      if (!seen.has(`skill:${name}`)) {
        seen.add(`skill:${name}`);
        out.push({ kind: "skill", name, path: path.join(e.dir, SKILL_FILE) });
      }
    }
    recipeFiles ??= recipeRoots.flatMap((root) => walkRecipeFiles(root));
    for (const file of recipeFiles) {
      const info = recipeInfo(file);
      if (info && !seen.has(`recipe:${info.title}`)) {
        seen.add(`recipe:${info.title}`);
        out.push({ kind: "recipe", name: info.title, path: file });
      }
    }
    try {
      for (const p of pluginList?.() ?? []) {
        if (
          p &&
          typeof p.pluginId === "string" &&
          p.pluginId &&
          !seen.has(`plugin:${p.pluginId}`)
        ) {
          seen.add(`plugin:${p.pluginId}`);
          out.push({ kind: "plugin", name: p.pluginId, path: p.path ?? "" });
        }
      }
    } catch {
      /* a broken plugin registry loses the plugin entries, never the skills and recipes */
    }
    return out;
  };

  return {
    skillDirByName,
    recipeByPath,
    recipeBySlug,
    pluginForTool,
    isRecipePath,
    isSkillDir,
    list,
  };
}

function uniquePaths(list: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== "string" || !item.trim()) {
      continue;
    }
    const resolved = path.resolve(item.trim());
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

function firstWins(pairs: Array<[string, string]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of pairs) {
    if (!map.has(key)) {
      map.set(key, value);
    }
  }
  return map;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/** Child directory names (symlinked ones included), hidden entries skipped, sorted. */
function listDirNames(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        (e.isDirectory() || (e.isSymbolicLink() && isDirectory(path.join(dir, e.name)))),
    )
    .map((e) => e.name)
    .toSorted();
}

function readHead(file: string, bytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

const BOM = String.fromCharCode(0xfeff);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

function unquote(value: string | undefined): string {
  const v = (value ?? "").trim();
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1).trim() : v;
}

function readSkillName(file: string): string | undefined {
  const text = readHead(file, 4096);
  const front = text ? FRONTMATTER.exec(stripBom(text))?.[1] : undefined;
  const name = front ? unquote(/^name:\s*(.+?)\s*$/m.exec(front)?.[1]) : "";
  return name || undefined;
}

function deriveRecipeSlug(file: string): string {
  const base = path.basename(file);
  if (RECIPE_FILENAMES.has(base)) {
    return path.basename(path.dirname(file));
  }
  return base.replace(/\.recipe\.md$/, "").replace(/\.md$/, "");
}

function parseRecipeInfo(file: string, raw: string): RecipeInfo {
  const text = stripBom(raw);
  const fm = FRONTMATTER.exec(text);
  const front = fm?.[1] ?? "";
  const body = fm ? text.slice(fm[0].length) : text;
  const title =
    unquote(/^title:\s*(.+?)\s*$/m.exec(front)?.[1]) ||
    /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]?.trim() ||
    deriveRecipeSlug(file);
  const declaredSlug = /^(?:slug|id):\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*$/m.exec(
    front,
  )?.[1];
  return declaredSlug ? { title, declaredSlug } : { title };
}

function isRecipeRelPath(rel: string): boolean {
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return false;
  }
  const segments = rel.split(path.sep);
  const base = segments[segments.length - 1] ?? "";
  if (!base.endsWith(".md") || NON_RECIPE_MD.has(base.toLowerCase())) {
    return false;
  }
  if (segments.some((s) => !s || s.startsWith("."))) {
    return false;
  }
  return (
    segments.length <= RECIPE_MAX_DEPTH ||
    (segments.length === RECIPE_MAX_DEPTH + 1 && RECIPE_FILENAMES.has(base))
  );
}

/** Every recipe file under a root, parents before children (first-slug-wins keeps the curated kit). */
function walkRecipeFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full))) {
        if (depth <= RECIPE_MAX_DEPTH) {
          subdirs.push(full);
        }
      } else if (isRecipeRelPath(path.relative(root, full))) {
        out.push(full);
      }
    }
    for (const sub of subdirs) {
      visit(sub, depth + 1);
    }
  };
  visit(root, 1);
  return out;
}

// ── The real registry (lazy, cached 60 s) ───────────────────────────────────────────────────────

const REGISTRY_TTL_MS = 60_000;
const TINKER_BRIDGE_PLUGIN_ID = "tinkerclaw-tinker-bridge";
let cachedRegistry: { registry: UsageRegistry; builtAt: number } | undefined;

/** The registry over the real skill/recipe roots and the live plugin registry. Never throws. */
export function getUsageRegistry(): UsageRegistry {
  const now = Date.now();
  if (cachedRegistry && now - cachedRegistry.builtAt < REGISTRY_TTL_MS) {
    return cachedRegistry.registry;
  }
  let registry: UsageRegistry;
  try {
    const home = safeHomeDir();
    const cfg = getRuntimeConfigSnapshot();
    registry = createUsageRegistry({
      skillRoots: discoverSkillRoots(cfg, home),
      recipeRoots: discoverRecipeRoots(home),
      pluginToolOwner: activePluginToolOwner,
      pluginList: activePluginList,
    });
  } catch {
    registry = createUsageRegistry({ skillRoots: [], recipeRoots: [] });
  }
  cachedRegistry = { registry, builtAt: now };
  return registry;
}

/**
 * Skill roots, first match wins in `skillDirByName`, so they are ordered the way the caller that
 * can name a skill (the cc-bridge `Skill` tool) resolves it: Claude Code's personal skills, the
 * bridge working folder's `.claude/skills`, the Claude plugin cache (installed version first),
 * then OpenClaw's own loader roots in its precedence order. Paths do not need this list: the read
 * and exec rules find a skill from the path itself.
 */
function discoverSkillRoots(cfg: OpenClawConfig | null, home: string): string[] {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? resolveUserPath(process.env.CLAUDE_CONFIG_DIR.trim())
    : path.join(home, ".claude");
  return [
    path.join(claudeDir, "skills"),
    path.join(resolveBridgeCwd(cfg, home), ".claude", "skills"),
    ...pluginCacheSkillRoots(claudeDir),
    ...openClawSkillRoots(cfg, home),
  ];
}

/**
 * The roots `loadSkillEntries` (src/agents/skills/workspace.ts) builds inline and does not export,
 * highest precedence first: workspace, project `.agents`, personal `.agents`, managed, bundled,
 * `skills.load.extraDirs`. The plugin-declared skill dirs (`resolvePluginSkillDirs`) are left out on
 * purpose: resolving them loads the plugin manifest registry, too heavy for a history hot path, and
 * their skills are still attributed by path.
 */
function openClawSkillRoots(cfg: OpenClawConfig | null, home: string): string[] {
  const workspaceDir = cfg
    ? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg))
    : resolveDefaultAgentWorkspaceDir();
  const bundled = resolveBundledSkillsDir();
  const extraDirs = (cfg?.skills?.load?.extraDirs ?? []).flatMap((dir) =>
    typeof dir === "string" && dir.trim() ? [resolveUserPath(dir.trim())] : [],
  );
  return [
    path.join(workspaceDir, "skills"),
    path.join(workspaceDir, ".agents", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(CONFIG_DIR, "skills"),
    ...(bundled ? [bundled] : []),
    ...extraDirs,
  ];
}

/**
 * The folder the cc-bridge runs `claude` in: `plugins.entries.tinkerclaw-tinker-bridge.config.cwd`,
 * else the bridge's own default (extensions/tinkerclaw-tinker-bridge/src/defaults.ts
 * `resolveDefaultCwd`). Restated rather than imported: production `src/**` must not import bundled
 * plugin files (scripts/check-src-extension-import-boundary.mjs).
 */
function resolveBridgeCwd(cfg: OpenClawConfig | null, home: string): string {
  const configured = cfg?.plugins?.entries?.[TINKER_BRIDGE_PLUGIN_ID]?.config?.cwd;
  if (typeof configured === "string" && configured.trim()) {
    return resolveUserPath(configured.trim());
  }
  const legacy = path.join(home, ".openclaw", "jarvis-workspace");
  return isDirectory(legacy) ? legacy : resolveDefaultAgentWorkspaceDir();
}

/** `<claude>/plugins/cache/<marketplace>/<plugin>/<version>/skills`, installed version first. */
function pluginCacheSkillRoots(claudeDir: string): string[] {
  const cacheDir = path.join(claudeDir, "plugins", "cache");
  const installed = readInstalledPluginPaths(claudeDir);
  const found: Array<{ skills: string; installed: boolean; mtime: number }> = [];
  for (const marketplace of listDirNames(cacheDir)) {
    for (const plugin of listDirNames(path.join(cacheDir, marketplace))) {
      for (const version of listDirNames(path.join(cacheDir, marketplace, plugin))) {
        const versionDir = path.join(cacheDir, marketplace, plugin, version);
        const skills = path.join(versionDir, "skills");
        if (!isDirectory(skills)) {
          continue;
        }
        let mtime = 0;
        try {
          mtime = fs.statSync(versionDir).mtimeMs;
        } catch {
          // keep 0
        }
        found.push({ skills, installed: installed.has(path.resolve(versionDir)), mtime });
      }
    }
  }
  return found
    .toSorted((a, b) => Number(b.installed) - Number(a.installed) || b.mtime - a.mtime)
    .map((entry) => entry.skills);
}

function readInstalledPluginPaths(claudeDir: string): Set<string> {
  const out = new Set<string>();
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(claudeDir, "plugins", "installed_plugins.json"), "utf8"),
    ) as { plugins?: Record<string, unknown> };
    for (const installs of Object.values(raw?.plugins ?? {})) {
      for (const install of Array.isArray(installs) ? installs : []) {
        const installPath = (install as { installPath?: unknown })?.installPath;
        if (typeof installPath === "string" && installPath) {
          out.add(path.resolve(installPath));
        }
      }
    }
  } catch {
    // no Claude Code plugins on this host
  }
  return out;
}

/**
 * Prefrontal's recipe directories: the overlay (`$OPENCLAW_HOME/recipes`, default
 * `~/.openclaw/recipes`, which shadows the bundled copy — recipe-runner.ts `resolveRecipeOverlayDir`)
 * and the package's own `extensions/tinkerclaw-prefrontal/recipes` (legacy `kits`), found from the
 * running package root like recipe-runner.ts `resolveOwnRecipesDir`. Both are restated for the same
 * import-boundary reason as `resolveBridgeCwd`.
 */
function discoverRecipeRoots(home: string): string[] {
  const openclawHome = process.env.OPENCLAW_HOME?.trim() || path.join(home, ".openclaw");
  const roots = [path.join(openclawHome, "recipes")];
  const own = resolveOwnRecipesDir();
  if (own) {
    roots.push(own);
  }
  return roots;
}

function resolveOwnRecipesDir(): string | undefined {
  const packageRoot = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
  });
  if (!packageRoot) {
    return undefined;
  }
  for (const leaf of ["recipes", "kits"]) {
    const candidate = path.join(packageRoot, "extensions", "tinkerclaw-prefrontal", leaf);
    if (isDirectory(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

let ownerIndexSource: { tools: readonly PluginToolRegistration[]; count: number } | undefined;
let ownerIndex = new Map<string, { pluginId: string; path?: string }>();

/**
 * Owner of a tool name from the ACTIVE plugin registry's declared tool names. `getPluginToolMeta`
 * (src/plugins/tools.ts) cannot be used by name: it is a WeakMap keyed by the tool OBJECT that
 * `resolvePluginTools` builds per run. A factory registered without `names` is therefore invisible
 * here until that module keeps a name-keyed owner index.
 */
function activePluginToolOwner(toolName: string): { pluginId: string; path?: string } | undefined {
  const tools = getActivePluginRegistry()?.tools;
  if (!Array.isArray(tools)) {
    return undefined;
  }
  if (ownerIndexSource?.tools !== tools || ownerIndexSource.count !== tools.length) {
    ownerIndex = buildPluginToolOwnerIndex(tools);
    ownerIndexSource = { tools, count: tools.length };
  }
  return ownerIndex.get(toolName);
}

/** Plugins that register tools, once each, with their manifest when it is on disk. */
function activePluginList(): Array<{ pluginId: string; path?: string }> {
  const tools = getActivePluginRegistry()?.tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  const out = new Map<string, { pluginId: string; path?: string }>();
  for (const entry of tools) {
    if (
      !entry ||
      typeof entry.pluginId !== "string" ||
      !entry.pluginId ||
      out.has(entry.pluginId)
    ) {
      continue;
    }
    const manifest =
      typeof entry.rootDir === "string" && entry.rootDir
        ? path.join(entry.rootDir, "openclaw.plugin.json")
        : undefined;
    out.set(entry.pluginId, {
      pluginId: entry.pluginId,
      ...(manifest && fileExists(manifest) ? { path: manifest } : {}),
    });
  }
  return [...out.values()];
}

function buildPluginToolOwnerIndex(
  tools: readonly PluginToolRegistration[],
): Map<string, { pluginId: string; path?: string }> {
  const index = new Map<string, { pluginId: string; path?: string }>();
  for (const entry of tools) {
    if (!entry || typeof entry.pluginId !== "string" || !entry.pluginId) {
      continue;
    }
    const manifest =
      typeof entry.rootDir === "string" && entry.rootDir
        ? path.join(entry.rootDir, "openclaw.plugin.json")
        : undefined;
    const owner = {
      pluginId: entry.pluginId,
      ...(manifest && fileExists(manifest) ? { path: manifest } : {}),
    };
    for (const name of Array.isArray(entry.names) ? entry.names : []) {
      if (typeof name === "string" && name && !index.has(name)) {
        index.set(name, owner);
      }
    }
  }
  return index;
}
