/**
 * FORK: tinkerclaw-cc-bridge — session → worker registry.
 *
 * One claude subprocess per OpenClaw session. Workers stay alive until the
 * gateway exits (no idle timeout). If a worker dies, we respawn it with
 * `--resume <sessionId>` on the next turn (see Worker.start).
 *
 * FORK (2026-04-22): sessionKey → sessionId mapping is now persisted to
 * `~/.openclaw/cc-bridge/session-map.json` so a gateway restart doesn't
 * lose claude CLI's conversation state. Previously the in-memory map
 * reset on every restart and Jarvis woke up amnesic even though the
 * transcript .jsonl files were sitting right there on disk.
 */
import { getResumeSessionId } from "./session-map.js";
import { ClaudeCodeWorker, type WorkerSpawnParams } from "./worker.js";

export class SessionWorkerPool {
  private workers = new Map<string, ClaudeCodeWorker>();

  getOrCreate(params: WorkerSpawnParams): ClaudeCodeWorker {
    const existing = this.workers.get(params.sessionKey);
    if (existing && existing.isAlive()) {
      return existing;
    }
    if (existing && existing.sessionId && !params.resumeSessionId) {
      params = { ...params, resumeSessionId: existing.sessionId };
    }
    // FORK (2026-04-22): if there's no live worker AND no in-memory
    // sessionId to resume from, check the persisted session-map. That's
    // the gateway-restart path where `existing` is always undefined.
    if (!params.resumeSessionId) {
      const persisted = getResumeSessionId(params.sessionKey);
      if (persisted) {
        params = { ...params, resumeSessionId: persisted };
      }
    }
    const worker = new ClaudeCodeWorker(params);
    worker.on("exit", () => {
      // Keep entry around so its sessionId can be used for --resume next time.
      // Explicit delete only on gateway shutdown.
    });
    this.workers.set(params.sessionKey, worker);
    return worker;
  }

  get(sessionKey: string): ClaudeCodeWorker | undefined {
    return this.workers.get(sessionKey);
  }

  killAll(): void {
    for (const worker of this.workers.values()) {
      worker.kill("SIGTERM");
    }
    this.workers.clear();
  }
}

// Single gateway-wide pool instance.
let singleton: SessionWorkerPool | null = null;
export function getPool(): SessionWorkerPool {
  if (!singleton) {
    singleton = new SessionWorkerPool();
    process.on("exit", () => singleton?.killAll());
    process.on("SIGTERM", () => singleton?.killAll());
    process.on("SIGINT", () => singleton?.killAll());
  }
  return singleton;
}
