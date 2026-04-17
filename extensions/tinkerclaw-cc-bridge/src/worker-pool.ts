/**
 * FORK: tinkerclaw-cc-bridge — session → worker registry.
 *
 * One claude subprocess per OpenClaw session. Workers stay alive until the
 * gateway exits (no idle timeout). If a worker dies, we respawn it with
 * `--resume <sessionId>` on the next turn (see Worker.start).
 */
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
