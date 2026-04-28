/**
 * FORK 2026-04-28 (bible §5.76): shared loader for cc-bridge prompt
 * fragments. Implements the resolution order documented in the bible:
 *
 *   1. Explicit env override (TINKERCLAW_<NAME>_PROMPT)
 *   2. Workspace override (~/.openclaw/workspace/<name>.md)
 *   3. Bundled default (extensions/tinkerclaw-cc-bridge/prompts/<name>.md)
 *
 * Templates may reference runtime values via `{{VAR_NAME}}` placeholders;
 * `loadPromptFile` substitutes them at read time. If the template
 * references a placeholder the caller did not provide, the placeholder
 * is left as-is — calling code may treat that as a "feature unavailable"
 * signal (e.g. subagent helper renders empty when SPAWN_SUBAGENT_BIN is
 * not resolvable).
 *
 * The loader returns "" when no candidate file exists — callers must
 * handle empty strings (typically by skipping the prompt block). It does
 * NOT throw, because a missing prompt fragment is a degradation, not a
 * crash: the rest of the system prompt still ships.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LoadPromptOptions {
  /** Plugin directory name (e.g. "tinkerclaw-cc-bridge"). */
  plugin: string;
  /** Subdirectory inside the plugin (e.g. "prompts" or "personas"). */
  subdir: string;
  /** File name without extension or with `.md`. */
  file: string;
  /** Env var name that overrides the resolved path entirely. */
  envVar?: string;
  /** Template variable substitutions: {{KEY}} → value. */
  substitutions?: Record<string, string>;
  /**
   * Workspace-side override file name. Defaults to the same `file` name
   * resolved against `~/.openclaw/workspace/`. Pass `false` to disable
   * workspace override resolution (rare).
   */
  workspaceFile?: string | false;
}

function resolveCandidates(opts: LoadPromptOptions): string[] {
  const fileWithExt = opts.file.endsWith(".md") ? opts.file : `${opts.file}.md`;
  const candidates: string[] = [];

  if (opts.envVar) {
    const fromEnv = process.env[opts.envVar];
    if (fromEnv) {
      candidates.push(fromEnv);
    }
  }

  if (opts.workspaceFile !== false) {
    const wsName = opts.workspaceFile ?? fileWithExt;
    candidates.push(path.join(os.homedir(), ".openclaw", "workspace", wsName));
  }

  const bundleRoot = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  if (bundleRoot) {
    candidates.push(path.join(bundleRoot, opts.plugin, opts.subdir, fileWithExt));
  }

  candidates.push(
    path.join(
      os.homedir(),
      "src",
      "tinkerclaw",
      "extensions",
      opts.plugin,
      opts.subdir,
      fileWithExt,
    ),
  );
  candidates.push(path.join(__dirname, "..", opts.subdir, fileWithExt));
  candidates.push(path.join(__dirname, "..", "..", opts.plugin, opts.subdir, fileWithExt));

  return candidates;
}

/**
 * Substitute {{KEY}} placeholders. Unrecognised placeholders are left
 * untouched so the caller can see them in the rendered prompt and decide
 * whether to omit the block entirely.
 */
function applySubstitutions(text: string, subs: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(subs, key)) {
      return subs[key];
    }
    return match;
  });
}

/**
 * Strip leading YAML frontmatter (delimited by `---` lines). The
 * frontmatter carries metadata for human readers and CLI tools
 * (default-version, override-target) but should not appear in the
 * system-prompt text the LLM sees.
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) {
    return text;
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    return text;
  }
  return text.slice(end + 5).replace(/^\s+/, "");
}

export function loadPromptFile(opts: LoadPromptOptions): string {
  const candidates = resolveCandidates(opts);
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      if (!raw.trim()) {
        continue;
      }
      const stripped = stripFrontmatter(raw);
      const substituted = opts.substitutions
        ? applySubstitutions(stripped, opts.substitutions)
        : stripped;
      // Prepend two blank lines so the block is visually separated from
      // whatever came before in the combined system prompt.
      return `\n\n${substituted.trimEnd()}`;
    } catch {
      // try next candidate
    }
  }
  return "";
}
