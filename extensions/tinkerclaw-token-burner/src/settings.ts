/**
 * What the token burner's spare tokens are for: one objective, a strategy, the governing prompt
 * and an optional dashboard link. One JSON file, <stateDir>/token-burner/settings.json, which the
 * Tinker tab edits through the gateway and the token-burner CLI reads when it plans jobs
 * (skills/token-burner/token_burner/steer.py keeps the same objective ids; change both together).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const OBJECTIVES = [
  { id: "revenue", label: "Maximize revenue" },
  { id: "code", label: "Improve and harden my code" },
  { id: "research", label: "Research and learning" },
  { id: "backlog", label: "Clear my project backlog" },
  { id: "custom", label: "Custom" },
] as const;

export type ObjectiveId = (typeof OBJECTIVES)[number]["id"];

export type TokenBurnerSettings = {
  objective: ObjectiveId;
  customName: string;
  strategy: string;
  promptPath: string;
  dashboardUrl: string;
  updatedAt: string | null;
};

export const MAX_STRATEGY = 4000;
export const MAX_CUSTOM_NAME = 60;

export class SettingsError extends Error {}

export function isObjective(v: unknown): v is ObjectiveId {
  return typeof v === "string" && OBJECTIVES.some((o) => o.id === v);
}

export function objectiveLabel(objective: ObjectiveId, customName: string): string {
  if (objective === "custom") return customName.trim() || "Custom";
  return OBJECTIVES.find((o) => o.id === objective)!.label;
}

export function burnerDir(stateDir: string): string {
  return join(stateDir, "token-burner");
}

export function defaults(stateDir: string): TokenBurnerSettings {
  return {
    objective: "code",
    customName: "",
    strategy: "",
    promptPath: join(burnerDir(stateDir), "prompt.md"),
    dashboardUrl: "",
    updatedAt: null,
  };
}

function inside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Check a patch from the UI and merge it over `base`. Only known keys, the objective from the
 * list, a short custom name, an http(s) dashboard and a prompt file under the state dir (the
 * Tinker file link only opens files there).
 */
export function mergePatch(
  base: TokenBurnerSettings,
  patch: unknown,
  stateDir: string,
): TokenBurnerSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new SettingsError("settings must be an object");
  }
  const p = patch as Record<string, unknown>;
  const known = new Set(["objective", "customName", "strategy", "promptPath", "dashboardUrl"]);
  const extra = Object.keys(p).filter((k) => !known.has(k));
  if (extra.length) throw new SettingsError(`unknown setting(s): ${extra.join(", ")}`);
  const out = { ...base };
  if ("objective" in p) {
    if (!isObjective(p.objective)) {
      throw new SettingsError(`objective must be one of ${OBJECTIVES.map((o) => o.id).join(", ")}`);
    }
    out.objective = p.objective;
  }
  for (const key of ["customName", "strategy", "promptPath", "dashboardUrl"] as const) {
    if (key in p && typeof p[key] !== "string") throw new SettingsError(`${key} must be text`);
  }
  if (typeof p.customName === "string") {
    const name = p.customName.trim();
    if (name.length > MAX_CUSTOM_NAME) {
      throw new SettingsError(`the custom name is longer than ${MAX_CUSTOM_NAME} characters`);
    }
    out.customName = name;
  }
  if (typeof p.strategy === "string") {
    if (p.strategy.length > MAX_STRATEGY) {
      throw new SettingsError(`the strategy is longer than ${MAX_STRATEGY} characters`);
    }
    out.strategy = p.strategy.replace(/\r\n/g, "\n").trim();
  }
  if (typeof p.dashboardUrl === "string") {
    const url = p.dashboardUrl.trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
      throw new SettingsError("the dashboard link must start with http:// or https://");
    }
    out.dashboardUrl = url;
  }
  if (typeof p.promptPath === "string") {
    const path = p.promptPath.trim();
    if (!path) out.promptPath = defaults(stateDir).promptPath;
    else if (!isAbsolute(path) || !inside(stateDir, path) || !path.endsWith(".md")) {
      throw new SettingsError(`the prompt file must be a .md file under ${stateDir}`);
    } else out.promptPath = resolve(path);
  }
  if (out.objective === "custom" && !out.customName) {
    throw new SettingsError("give the custom objective a short name");
  }
  return out;
}

export function settingsPath(stateDir: string): string {
  return join(burnerDir(stateDir), "settings.json");
}

/** The stored settings over the defaults. A broken file reads as the defaults, with `error`. */
export function readSettings(stateDir: string): {
  settings: TokenBurnerSettings;
  error?: string;
} {
  const base = defaults(stateDir);
  const file = settingsPath(stateDir);
  if (!existsSync(file)) return { settings: base };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const { updatedAt, ...rest } = raw;
    const settings = mergePatch(base, rest, stateDir);
    settings.updatedAt = typeof updatedAt === "string" ? updatedAt : null;
    return { settings };
  } catch (err) {
    return { settings: base, error: `${file} was not read: ${(err as Error).message}` };
  }
}

export function writeSettings(
  stateDir: string,
  settings: TokenBurnerSettings,
  now = new Date(),
): TokenBurnerSettings {
  const saved = { ...settings, updatedAt: now.toISOString() };
  const file = settingsPath(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(saved, null, 2)}\n`);
  renameSync(tmp, file);
  return saved;
}

/** Used when the shipped default prompt file cannot be found. */
export const FALLBACK_PROMPT = `Token burner: governing prompt.

Spare tokens from the weekly allowance go to the objective chosen in the Tinker tab, following
its strategy. Every job must leave something a person can check: a commit, a report, a test run.
Never spend money, never send anything to another person, and stop when a job's verifier fails.
`;

/**
 * Make sure the governing prompt exists: copy the shipped default the first time. Returns where
 * it is and when it last changed.
 */
export function ensurePrompt(
  promptPath: string,
  defaultPromptFile: string | null,
): { path: string; mtime: string | null; created: boolean } {
  let created = false;
  if (!existsSync(promptPath)) {
    const text =
      defaultPromptFile && existsSync(defaultPromptFile)
        ? readFileSync(defaultPromptFile, "utf8")
        : FALLBACK_PROMPT;
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, text, { flag: "wx" });
    created = true;
  }
  let mtime: string | null = null;
  try {
    mtime = statSync(promptPath).mtime.toISOString();
  } catch {
    mtime = null;
  }
  return { path: promptPath, mtime, created };
}

/**
 * The shipped default, skills/token-burner/prompts/governing-prompt.md. Looked up from this
 * module upwards (source tree and built dist both keep skills/ at the package root), or under
 * OPENCLAW_BUNDLED_SKILLS_DIR when that is set.
 */
export function findDefaultPrompt(fromDir: string, env = process.env): string | null {
  const rel = join("token-burner", "prompts", "governing-prompt.md");
  const override = env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
  if (override && existsSync(join(override, rel))) return join(override, rel);
  let dir = fromDir;
  for (let i = 0; i < 7; i++) {
    const candidate = join(dir, "skills", rel);
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
