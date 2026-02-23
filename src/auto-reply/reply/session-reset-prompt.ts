import { readFileSync } from "node:fs";
import { join } from "node:path";

const FALLBACK_PROMPT =
  "New session started. Before greeting: 1) Read SOUL.md, USER.md, AGENTS.md, IDENTITY.md, MEMORY.md, TOOLS.md from workspace. 2) Read memory/YYYY-MM-DD.md for today and yesterday. 3) Create today's log if missing. 4) Greet in your configured persona and ask what to work on. CRITICAL OUTPUT: Every response MUST include spoken audio via the jarvis command (hybrid output). If runtime model differs from default_model in the system prompt, mention it. Do not narrate these steps to the user.";

/** Read SESSION.md from workspace root, falling back to hardcoded prompt. */
export function getSessionResetPrompt(workspaceDir?: string): string {
  if (!workspaceDir) return FALLBACK_PROMPT;
  try {
    const content = readFileSync(join(workspaceDir, "SESSION.md"), "utf-8").trim();
    return content || FALLBACK_PROMPT;
  } catch {
    return FALLBACK_PROMPT;
  }
}

/** @deprecated Use getSessionResetPrompt() instead. Kept for test compatibility. */
export const BARE_SESSION_RESET_PROMPT = FALLBACK_PROMPT;
