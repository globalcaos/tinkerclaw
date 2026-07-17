/**
 * FORK: tinkerclaw-tinker-bridge — credentials validation.
 *
 * We don't manage OAuth ourselves. Claude Code's own login flow writes
 * ~/.claude/.credentials.json and refreshes it on use. This file just
 * sanity-checks the credential file exists and isn't expired.
 *
 * If the check fails, the provider's auth step fails and OpenClaw's
 * fallback chain kicks in (today: Ollama gemma4:26b as emergency).
 */
import fs from "node:fs";
import { CREDENTIALS_PATH } from "./defaults.js";

export type CredentialsStatus = { ok: true; expiresAt: number } | { ok: false; reason: string };

export function checkClaudeCredentials(
  credentialsPath: string = CREDENTIALS_PATH,
): CredentialsStatus {
  try {
    if (!fs.existsSync(credentialsPath)) {
      return {
        ok: false,
        reason: `no credentials file at ${credentialsPath} — run 'claude' to log in`,
      };
    }
    const raw = fs.readFileSync(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { expiresAt?: number; accessToken?: string };
    };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
      return { ok: false, reason: "credentials file missing claudeAiOauth.accessToken" };
    }
    const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
    const now = Date.now();
    if (expiresAt > 0 && expiresAt < now) {
      return { ok: false, reason: `credentials expired at ${new Date(expiresAt).toISOString()}` };
    }
    return { ok: true, expiresAt };
  } catch (err) {
    return { ok: false, reason: `failed to read credentials: ${(err as Error).message}` };
  }
}
