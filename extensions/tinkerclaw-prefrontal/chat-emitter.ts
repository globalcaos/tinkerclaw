/**
 * FORK: prefrontal/chat-emitter — Rate-limited markdown broadcaster for topology events
 *
 * Buffers agent lifecycle events (spawned, ended, stuck) and flushes them as
 * formatted markdown strings at an adaptive interval that accelerates on activity
 * (down to `minIntervalMs`) and decays back to `maxIntervalMs` during quiet periods.
 * The `emitFn` callback provided by the plugin index broadcasts these updates as
 * `prefrontal-update` lifecycle events so the Tinker UI can display real-time agent
 * status without flooding the event stream during high subagent churn.
 *
 * Wired in by: instantiated in `extensions/prefrontal/index.ts` as `ChatEmitter`
 */
import type { PrefrontalNode } from "./topology.js";

interface ChatEvent {
  type: "spawned" | "ended" | "stuck" | "phase";
  label: string;
  model?: string;
  provider?: string;
  outcome?: string;
  ts: number;
}

export class ChatEmitter {
  private pendingEvents: ChatEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAt = 0;
  private minIntervalMs: number;
  private maxIntervalMs: number;
  private currentIntervalMs: number;
  private emitFn: (markdown: string) => void;

  constructor(opts: {
    minIntervalMs: number;
    maxIntervalMs: number;
    emitFn: (markdown: string) => void;
  }) {
    this.minIntervalMs = opts.minIntervalMs;
    this.maxIntervalMs = opts.maxIntervalMs;
    this.currentIntervalMs = opts.maxIntervalMs;
    this.emitFn = opts.emitFn;
  }

  onSpawned(node: PrefrontalNode): void {
    this.pendingEvents.push({
      type: "spawned",
      label: node.label,
      model: node.model,
      provider: node.provider,
      ts: Date.now(),
    });
    this.accelerate();
  }

  onEnded(node: PrefrontalNode, outcome?: string): void {
    this.pendingEvents.push({
      type: "ended",
      label: node.label,
      model: node.model,
      outcome,
      ts: Date.now(),
    });
    this.accelerate();
  }

  onStuck(node: PrefrontalNode): void {
    this.pendingEvents.push({
      type: "stuck",
      label: node.label,
      model: node.model,
      ts: Date.now(),
    });
    this.accelerate();
  }

  private accelerate(): void {
    this.currentIntervalMs = this.minIntervalMs;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) {
      return;
    }
    const elapsed = Date.now() - this.lastEmitAt;
    const wait = Math.max(0, this.currentIntervalMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.pendingEvents.length === 0) {
      this.currentIntervalMs = Math.min(this.currentIntervalMs * 1.5, this.maxIntervalMs);
      return;
    }

    const events = this.pendingEvents.splice(0);
    const lines: string[] = ["**Prefrontal Update**"];

    const spawned = events.filter((e) => e.type === "spawned");
    const ended = events.filter((e) => e.type === "ended");
    const stuck = events.filter((e) => e.type === "stuck");

    if (spawned.length) {
      lines.push("");
      for (const e of spawned) {
        const modelTag = e.model ? ` (${e.model})` : "";
        lines.push(`▸ **${e.label}** started${modelTag}`);
      }
    }
    if (ended.length) {
      lines.push("");
      for (const e of ended) {
        const outcomeTag = e.outcome ? ` — ${e.outcome}` : "";
        lines.push(`✓ **${e.label}** finished${outcomeTag}`);
      }
    }
    if (stuck.length) {
      lines.push("");
      for (const e of stuck) {
        lines.push(`⚠ **${e.label}** appears stuck`);
      }
    }

    this.emitFn(lines.join("\n"));
    this.lastEmitAt = Date.now();

    this.currentIntervalMs = Math.min(this.currentIntervalMs * 1.5, this.maxIntervalMs);
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
