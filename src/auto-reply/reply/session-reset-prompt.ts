import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/config.js";

const BARE_SESSION_RESET_PROMPT_BASE =
  "A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user. Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

/**
 * FORK: Read SESSION.md from workspace root if it exists.
 * Falls back to the upstream hardcoded prompt when SESSION.md is missing.
 */
function resolveSessionPromptBase(workspaceDir?: string): string {
  if (workspaceDir) {
    try {
      const content = readFileSync(join(workspaceDir, "SESSION.md"), "utf-8").trim();
      if (content) {
        return content;
      }
    } catch {
      // SESSION.md not found or unreadable — use default
    }
  }
  return BARE_SESSION_RESET_PROMPT_BASE;
}

/**
 * Build the bare session reset prompt, appending the current date/time so agents
 * know which daily memory files to read during their Session Startup sequence.
 * Without this, agents on /new or /reset guess the date from their training cutoff.
 *
 * FORK: When a workspace SESSION.md exists, its content replaces the default prompt.
 */
export function buildBareSessionResetPrompt(
  cfg?: OpenClawConfig,
  nowMs?: number,
  workspaceDir?: string,
): string {
  return appendCronStyleCurrentTimeLine(
    resolveSessionPromptBase(workspaceDir),
    cfg ?? {},
    nowMs ?? Date.now(),
  );
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
