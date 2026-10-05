// The raw copy of a condensed tool result (design doc section 8, table `raw_results`; paper P§5.2).
//
// WHAT THIS IS FOR. A digest is only allowed because the full result stays on disk under a name, so a digest that lost
// a detail costs one extra read, not a wrong answer. This keeps those copies, hands them back on request, and prunes
// them. A result that cannot be kept is not digested at all (the digest service checks).
//
// HOW IT IS KEPT. `<dataDir>/raw/<session-hash>/<name>`, folder mode 0700, file mode 0600. The name is content-derived
// (`res-<hash>-<length>`), so the same result is one file. Nothing here is written outside that folder, and a name that
// does not have the exact shape is refused before any path is built.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { rawResultName } from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusStore } from "./store.js";

export const RAW_NAME = /^res-[0-9a-f]{8}-[0-9a-z]+$/;
/** A raw result larger than this is not kept, so it is not digested either. */
export const DEFAULT_MAX_RAW_BYTES = 20 * 1024 * 1024;

const sessionDir = (session: string): string =>
  createHash("sha1").update(session).digest("hex").slice(0, 12);

export function createRawStore(o: {
  dir: string;
  store: () => ThalamusStore | undefined;
  now?: () => number;
  maxBytes?: number;
}) {
  const now = o.now ?? Date.now;
  const root = resolve(o.dir);
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_RAW_BYTES;

  return {
    /** Keep the raw text; returns where, or undefined when it cannot be kept (too big, no store, a write failed). */
    put(p: {
      session: string;
      tool: string;
      text: string;
      tokens: number;
      digestTokens?: number;
    }): { name: string; path: string } | undefined {
      const store = o.store();
      const bytes = Buffer.byteLength(p.text, "utf8");
      if (!store || bytes > maxBytes) return undefined;
      const name = rawResultName(p.text);
      const dir = join(root, sessionDir(p.session));
      const path = join(dir, name);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          chmodSync(root, 0o700);
          chmodSync(dir, 0o700);
        } catch {
          /* not ours to chmod */
        }
        if (!existsSync(path)) writeFileSync(path, p.text, { mode: 0o600 });
        store.putRaw({
          name,
          ts: now(),
          session: p.session,
          path,
          bytes,
          tokens: p.tokens,
          ...(p.digestTokens !== undefined ? { digestTokens: p.digestTokens } : {}),
          tool: p.tool,
        });
        return { name, path };
      } catch {
        return undefined;
      }
    },

    /** The full result, or undefined when the name is not a raw name, is unknown, or the file is gone. */
    recall(name: string): string | undefined {
      if (!RAW_NAME.test(name)) return undefined;
      const store = o.store();
      const row = store?.getRaw(name);
      if (!store || !row) return undefined;
      const path = resolve(row.path);
      if (!path.startsWith(root + sep)) return undefined;
      try {
        const text = readFileSync(path, "utf8");
        store.noteRecall(name, now());
        return text;
      } catch {
        return undefined;
      }
    },

    /** Delete raw copies older than the cutoff, and the folders they leave empty. Returns how many. */
    prune(olderThanTs: number): number {
      const store = o.store();
      if (!store) return 0;
      let n = 0;
      for (const row of store.rawOlderThan(olderThanTs)) {
        try {
          const path = resolve(row.path);
          if (path.startsWith(root + sep)) {
            try {
              unlinkSync(path);
            } catch {
              /* already gone */
            }
          }
          store.deleteRaw(row.name);
          n += 1;
        } catch {
          /* keep the row: the file may still be there */
        }
      }
      try {
        for (const d of readdirSync(root)) {
          try {
            rmdirSync(join(root, d)); // only succeeds when empty
          } catch {
            /* not empty */
          }
        }
      } catch {
        /* no folder yet */
      }
      return n;
    },
  };
}

export type RawStore = ReturnType<typeof createRawStore>;
