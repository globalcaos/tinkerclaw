// FORK 2026-11-03 (context-window-panel.md A11): what the gateway's EVICT handler needs from the bridge on the
// claude-code lane. `sessions.compact { keepFraction }` (src/gateway/session-eviction.ts) cannot shrink a Claude Code
// chat by rewriting the gateway's transcript: the CLI resumes its own. So the gateway reaches the bridge through this
// slot (the gateway cannot import an extension), and the bridge writes an evicted fork of the CLI's transcript
// (cli-evict.ts), points the chat at it and retires the idle worker, the same hand-off Rewind uses (rewind-seam.ts):
// the warm `claude` process holds the whole conversation in memory, so only a fresh `--resume` reads the fork.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CliEvictResult, forkEvictedTranscript } from "./cli-evict.js";
import {
  getLatestResumeSessionIdByOpenclawSessionId,
  rebindResumeSessionId,
} from "./session-map.js";
import { getPool } from "./worker-pool.js";

/** Must equal `BRIDGE_EVICT_SLOT` in src/gateway/session-eviction.ts; a test compares them. */
export const BRIDGE_EVICT_SLOT = "openclaw.bridgeEvict";

export interface BridgeEvictSeam {
  /** Evict the oldest turns of the Claude Code session behind this OpenClaw session. */
  evict(openclawSessionId: string, keepFraction: number): CliEvictResult;
}

type PoolLike = {
  isBusyOnSession(sessionId: string): boolean;
  retireIdleOnSession(sessionId: string): number;
};

/** The CLI writes `<id>.jsonl` under the project folder of the worker's cwd; any folder will do. */
export function findClaudeTranscript(
  claudeSessionId: string,
  projectsDir = path.join(os.homedir(), ".claude", "projects"),
): string | null {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = path.join(projectsDir, d, `${claudeSessionId}.jsonl`);
    if (fs.existsSync(file)) {
      return file;
    }
  }
  return null;
}

const BUSY = "a reply is still running in this chat; evict once it ends";

export function createEvictSeam(
  deps: {
    pool?: () => PoolLike;
    lookup?: (openclawSessionId: string) => string | undefined;
    findTranscript?: (claudeSessionId: string) => string | null;
    rebind?: (from: string, to: string) => number;
    fork?: typeof forkEvictedTranscript;
  } = {},
): BridgeEvictSeam {
  const pool = deps.pool ?? getPool;
  const lookup = deps.lookup ?? getLatestResumeSessionIdByOpenclawSessionId;
  const findTranscript = deps.findTranscript ?? ((id: string) => findClaudeTranscript(id));
  const rebind = deps.rebind ?? rebindResumeSessionId;
  const fork = deps.fork ?? forkEvictedTranscript;
  return {
    evict(openclawSessionId, keepFraction) {
      const from = lookup(openclawSessionId);
      if (!from) {
        return { ok: false, reason: "the bridge has no Claude Code session bound to this chat" };
      }
      if (pool().isBusyOnSession(from)) {
        return { ok: false, reason: BUSY };
      }
      const src = findTranscript(from);
      if (!src) {
        return { ok: false, reason: "the Claude Code transcript of this chat is not on disk" };
      }
      const res = fork(src, { keepFraction, recallHint: true });
      if (!res.ok) {
        return res;
      }
      // A turn may have started while the fork was written: never move a chat under a live worker.
      const busy = pool().isBusyOnSession(from);
      const moved = busy ? 0 : rebind(from, res.forkSessionId);
      if (moved === 0) {
        try {
          fs.unlinkSync(res.forkPath);
        } catch {
          // nothing points at it either way
        }
        return {
          ok: false,
          reason: busy ? BUSY : "the bridge could not point this chat at the evicted copy",
        };
      }
      pool().retireIdleOnSession(from);
      return res;
    },
  };
}

export function publishEvictSeam(): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for(BRIDGE_EVICT_SLOT)] = createEvictSeam();
}
