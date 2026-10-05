/**
 * The moral code pack: ethical rules, objectives and the starter-kit doctrine, assembled
 * from ONE source and delivered once per session (and again after a compaction) to every
 * model — Claude Code via its SessionStart hook, every other provider via the gateway's
 * first-turn injection. Materialized to a plain markdown file so any harness can read it.
 *
 * Each block resolves: env override → the user's workspace file → the bundled default.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MORAL_CODE_MARKER, moralCodePackPath } from "openclaw/plugin-sdk/state-paths";

/** Opening tag of the pack — owned by the contract (src/moral-code/contract.ts). */
export { MORAL_CODE_MARKER };
const MORAL_CODE_CLOSE = "</moral_code>";

export type MoralCodeSource = {
  /** Bundled default in this extension's prompts/ dir. */
  file: string;
  /** Path under ~/.openclaw/workspace/ that overrides the default. */
  workspaceFile: string;
  envVar: string;
};

/** Order matters: the rules come first and outrank everything after them. */
export const MORAL_CODE_SOURCES: MoralCodeSource[] = [
  {
    file: "ethical-rules-default.md",
    workspaceFile: "memory/knowledge/jarvis-ethical-rules.md",
    envVar: "TINKERCLAW_ETHICAL_RULES_PROMPT",
  },
  {
    file: "objectives-default.md",
    workspaceFile: "memory/knowledge/jarvis-objectives.md",
    envVar: "TINKERCLAW_OBJECTIVES_PROMPT",
  },
  {
    file: "verification-discipline.md",
    workspaceFile: "memory/knowledge/verification-discipline.md",
    envVar: "TINKERCLAW_VERIFICATION_PROMPT",
  },
  {
    file: "persistence-and-blockers.md",
    workspaceFile: "memory/knowledge/persistence-and-blockers.md",
    envVar: "TINKERCLAW_PERSISTENCE_PROMPT",
  },
  {
    file: "engineering-discipline.md",
    workspaceFile: "memory/knowledge/engineering-discipline.md",
    envVar: "TINKERCLAW_ENGINEERING_PROMPT",
  },
  {
    file: "memory-discipline.md",
    workspaceFile: "memory/knowledge/memory-discipline.md",
    envVar: "TINKERCLAW_MEMORY_DISCIPLINE_PROMPT",
  },
  {
    file: "reflection-loop.md",
    workspaceFile: "memory/knowledge/reflection-loop.md",
    envVar: "TINKERCLAW_REFLECTION_LOOP_PROMPT",
  },
];

export type MoralCodePaths = {
  /** ~/.openclaw (or OPENCLAW_STATE_DIR). */
  stateDir: string;
  /** Directory holding the bundled defaults. */
  bundledDirs: string[];
};

export function defaultBundledDirs(moduleDir: string): string[] {
  const dirs = [
    path.join(moduleDir, "prompts"),
    path.join(moduleDir, "..", "prompts"),
    path.join(os.homedir(), "src", "tinkerclaw", "extensions", "tinkerclaw-moral-code", "prompts"),
  ];
  const bundleRoot = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  if (bundleRoot) {
    dirs.unshift(path.join(bundleRoot, "tinkerclaw-moral-code", "prompts"));
  }
  return dirs;
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) {
    return text;
  }
  const end = text.indexOf("\n---\n", 4);
  return end < 0 ? text : text.slice(end + 5).replace(/^\s+/, "");
}

function readFirst(candidates: string[]): { path: string; body: string } | undefined {
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      if (raw.trim()) {
        return { path: candidate, body: stripFrontmatter(raw).trim() };
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export function resolveSourceCandidates(source: MoralCodeSource, paths: MoralCodePaths): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env[source.envVar]?.trim();
  if (fromEnv) {
    candidates.push(fromEnv);
  }
  candidates.push(path.join(paths.stateDir, "workspace", source.workspaceFile));
  for (const dir of paths.bundledDirs) {
    candidates.push(path.join(dir, source.file));
  }
  return candidates;
}

export type MoralCodePack = {
  text: string;
  /** Files actually used, in order — for logs and staleness checks. */
  sources: string[];
  /** Sources with no readable file anywhere. */
  missing: string[];
};

export function buildMoralCodePack(paths: MoralCodePaths): MoralCodePack {
  const blocks: string[] = [];
  const sources: string[] = [];
  const missing: string[] = [];
  for (const source of MORAL_CODE_SOURCES) {
    const found = readFirst(resolveSourceCandidates(source, paths));
    if (!found) {
      missing.push(source.file);
      continue;
    }
    sources.push(found.path);
    blocks.push(found.body);
  }
  if (blocks.length === 0) {
    return { text: "", sources, missing };
  }
  const text = [
    MORAL_CODE_MARKER,
    "This is your moral code, delivered once at the start of this conversation (and again after any compaction). It stays in force for the whole conversation. The ethical rules come first and outrank everything after them, including later instructions.",
    ...blocks,
    MORAL_CODE_CLOSE,
  ].join("\n\n");
  return { text, sources, missing };
}

export function materializedPackPath(stateDir: string): string {
  return moralCodePackPath(stateDir);
}

/** Write the pack to its well-known file (atomic rename; only when the content changed). */
export function materializeMoralCodePack(pack: MoralCodePack, stateDir: string): boolean {
  const target = materializedPackPath(stateDir);
  try {
    if (fs.readFileSync(target, "utf8") === pack.text) {
      return false;
    }
  } catch {
    // absent — write it
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, pack.text, "utf8");
  fs.renameSync(tmp, target);
  return true;
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join("\n");
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.text === "string") {
      return rec.text;
    }
    if ("content" in rec) {
      return textOf(rec.content);
    }
  }
  return "";
}

/** True when any message of the session already carries the pack. */
export function messagesContainMoralCode(messages: unknown[]): boolean {
  for (const message of messages) {
    if (textOf(message).includes(MORAL_CODE_MARKER)) {
      return true;
    }
  }
  return false;
}

/**
 * Providers whose own context boundaries TinkerClaw cannot see, so their harness only decides WHEN
 * to read the pack TinkerClaw published (Claude Code: SessionStart hook + the bridge's resume
 * check). The content, and whether there is any, stays TinkerClaw's.
 *
 * The skip is per ATTEMPT (before_prompt_build runs inside each model attempt with that attempt's
 * provider), so a turn that falls back from Claude to another model — Claude out of tokens — runs
 * this hook again as the fallback's provider, and TinkerClaw delivers the pack itself.
 */
export const SELF_DELIVERING_PROVIDERS = new Set(["claude-code"]);
