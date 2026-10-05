// Writes a fresh-point decision to the store off the caller's path (units D3, D4). One place, so every kind of
// record is deferred, fails into `onError` and never into the run, and carries the mode it was made in.

import type { ThalamusConfig } from "./config.js";
import type { FreshPointRow, ThalamusStore } from "./store.js";

export type FreshRecorderDeps = {
  cfg: () => ThalamusConfig;
  store: () => ThalamusStore | undefined;
  now: () => number;
  defer: (fn: () => void) => void;
  onError?: (err: unknown) => void;
};

export function createFreshRecorder(d: FreshRecorderDeps) {
  return (row: Omit<FreshPointRow, "ts" | "mode">): void => {
    const ts = d.now();
    const mode = d.cfg().mode;
    d.defer(() => {
      try {
        d.store()?.insertFreshPoint({ ...row, ts, mode });
      } catch (err) {
        d.onError?.(err);
      }
    });
  };
}

export type FreshRecorder = ReturnType<typeof createFreshRecorder>;
