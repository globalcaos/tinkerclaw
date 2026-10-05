/**
 * Pending answers for held steps (design doc §3 M11). The hook long-polls `wait`; the UI (or the native path) calls
 * `answer`. An answer that arrives before `wait` is remembered until its ttl, so the two calls can cross safely.
 */
import { renderTemplate } from "./templates.js";

export interface WaitOption {
  id: string;
  label: string;
}

export interface WaitAnswer {
  /** "allow-once" | "keep-held" | "option:<id>" | "timeout" */
  answer: string;
  /** Set only for `option:<id>`: the rendered `user-picked` template. */
  text?: string;
}

interface Entry {
  options?: WaitOption[];
  expiresAt: number;
  answered?: WaitAnswer;
  waiters: Set<(a: WaitAnswer) => void>;
}

export class WaitRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
  }

  /** Entries still open (for tests and status). */
  pending(): number {
    this.purge();
    return this.entries.size;
  }

  private purge(): void {
    const t = this.now();
    for (const [id, e] of this.entries) {
      if (e.expiresAt <= t && e.waiters.size === 0) this.entries.delete(id);
    }
  }

  register(o: { interventionId: string; options?: WaitOption[]; ttlMs: number }): void {
    this.purge();
    this.entries.set(o.interventionId, {
      options: o.options,
      expiresAt: this.now() + o.ttlMs,
      waiters: new Set(),
    });
  }

  wait(interventionId: string, timeoutMs: number): Promise<WaitAnswer> {
    this.purge();
    const e = this.entries.get(interventionId);
    if (!e) return Promise.resolve({ answer: "timeout" });
    if (e.answered) {
      this.entries.delete(interventionId);
      return Promise.resolve(e.answered);
    }
    return new Promise<WaitAnswer>((resolve) => {
      const timer = setTimeout(
        () => {
          e.waiters.delete(finish);
          if (e.waiters.size === 0 && this.entries.get(interventionId) === e) {
            this.entries.delete(interventionId);
          }
          resolve({ answer: "timeout" });
        },
        Math.max(0, timeoutMs),
      );
      timer.unref?.();
      const finish = (a: WaitAnswer): void => {
        clearTimeout(timer);
        resolve(a);
      };
      e.waiters.add(finish);
    });
  }

  /** False when the id is unknown, expired or already answered. */
  answer(interventionId: string, answer: string): boolean {
    this.purge();
    const e = this.entries.get(interventionId);
    if (!e || e.answered) return false;
    const a: WaitAnswer = { answer };
    if (answer.startsWith("option:")) {
      const optId = answer.slice("option:".length);
      const label = e.options?.find((o) => o.id === optId)?.label ?? optId;
      a.text = renderTemplate("user-picked", { reading: label });
    }
    if (e.waiters.size > 0) {
      const ws = [...e.waiters];
      e.waiters.clear();
      this.entries.delete(interventionId);
      for (const w of ws) w(a);
    } else {
      e.answered = a;
    }
    return true;
  }

  /** Release every waiter (gateway shutting down) so no long-poll outlives the runtime. */
  dispose(): void {
    for (const [id, e] of this.entries) {
      const ws = [...e.waiters];
      e.waiters.clear();
      this.entries.delete(id);
      for (const w of ws) w({ answer: "timeout" });
    }
  }
}
