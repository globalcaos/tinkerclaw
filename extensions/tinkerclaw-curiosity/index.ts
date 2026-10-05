/**
 * FORK 2026-10-01 (the architect): tinkerclaw-curiosity — the curiosity sense, the first build of J8's "purposeful curiosity".
 *
 * It learns what the principal is passionate about, digs deeper when one of those subjects comes up, asks one deep
 * question at a time to understand exactly what he loves in it, researches it during ordinary turns and teaches him
 * further. The extra goes in a "✨ DEEPER" section that the Tinker chat draws as its own bubble with a yellow border
 * (tinker-ui sectioned-reply.ts).
 *
 * The plugin only delivers: each chat turn of the main agent gets the contract plus the passion map, a private
 * markdown file in the workspace (never in this repo), re-read every minute. The agent researches with its own tools
 * and keeps the map current.
 */
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { curiosityContextFor, readProfile } from "./src/block.js";

const REFRESH_MS = 60_000;

function workspaceDir(): string {
  return (
    process.env.OPENCLAW_WORKSPACE_DIR || join(process.env.HOME ?? "", ".openclaw", "workspace")
  );
}

export default function register(api: OpenClawPluginApi) {
  const c = (api.pluginConfig ?? {}) as {
    profilePath?: unknown;
    sessionPrefix?: unknown;
    maxProfileChars?: unknown;
  };
  const profilePath =
    typeof c.profilePath === "string" && c.profilePath
      ? c.profilePath
      : join(workspaceDir(), "memory", "knowledge", "passions.md");
  const sessionPrefix =
    typeof c.sessionPrefix === "string" && c.sessionPrefix ? c.sessionPrefix : "agent:main:tinker:";
  const maxChars =
    typeof c.maxProfileChars === "number" && c.maxProfileChars > 200 ? c.maxProfileChars : 3500;

  let profile = "";
  const refresh = () => {
    profile = readProfile(profilePath, maxChars);
  };
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref?.();
  api.logger.info(
    `[curiosity] on for ${sessionPrefix}* (map ${profile ? `${profile.length} chars` : "empty"}: ${profilePath})`,
  );

  api.on(
    "before_prompt_build",
    async (_payload: unknown, context: { sessionKey?: string }) => {
      const block = curiosityContextFor(context.sessionKey, {
        sessionPrefix,
        profile,
        profilePath,
      });
      return block ? { prependSystemContext: block } : undefined;
    },
    { priority: 40 },
  );
}
