/**
 * FORK 2026-10-21 — `askSession.slice` (a visible sign that the ask skill is in use).
 *
 * The ask-session skill wakes a past Claude Code session in place, so its whole exchange is the byte
 * range it appended to that session's transcript; `sessions.py ask` prints the range. The Tinker UI's
 * purple ask card calls this when it is expanded, and draws the woken session's thinking and tool calls
 * from the answer.
 *
 * READ scope, and read-only: it reads one transcript under ~/.claude/projects, found by session id
 * (never by a client path), from the given byte offsets, at most CLAUDE_CLI_SLICE_MAX_BYTES.
 */
import {
  isClaudeCliSessionId,
  readClaudeCliTranscriptSlice,
} from "../cli-session-history.claude.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export function createAskSessionHandlers(
  deps: { homeDir?: () => string | undefined } = {},
): GatewayRequestHandlers {
  return {
    "askSession.slice": async ({ params, respond }) => {
      const p = (params ?? {}) as { sessionId?: unknown; fromByte?: unknown; toByte?: unknown };
      const fromByte = typeof p.fromByte === "number" ? p.fromByte : Number.NaN;
      if (!isClaudeCliSessionId(p.sessionId) || !Number.isFinite(fromByte) || fromByte < 0) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "askSession.slice needs a session id and a fromByte >= 0",
          ),
        );
        return;
      }
      const homeDir = deps.homeDir?.();
      const slice = readClaudeCliTranscriptSlice({
        cliSessionId: p.sessionId,
        fromByte,
        ...(typeof p.toByte === "number" ? { toByte: p.toByte } : {}),
        ...(homeDir ? { homeDir } : {}),
      });
      if (!slice) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `no transcript for session ${p.sessionId}`),
        );
        return;
      }
      respond(true, { sessionId: p.sessionId, ...slice });
    },
  };
}

export const askSessionHandlers: GatewayRequestHandlers = createAskSessionHandlers();
