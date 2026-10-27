// The note and past-chat sources of the anticipation note (2026-10-25).
//
// WHAT THIS IS FOR. `thalamus-pointers.ts` matches a prompt against pointer docs; this reads the docs: the note folders
// (Markdown files, a frontmatter `description` is the use key) and the chat catalogue the ask-session skill builds every
// night (`skills/ask-session/scripts/sessions.py`, table `cards`). The short-list seam asks `find()` once per owner
// prompt.
//
// NEVER ON THE PROMPT'S CLOCK. The indexes are built in the background and looked at again every `REFRESH_MS` (the
// catalogue as soon as its file changes, checked at most once a minute). A rebuild whose files did not change (same
// paths, sizes and times) only stats them. A prompt that arrives before the first build gets no pointers and the ledger
// says `index-building`; matching itself is in memory and takes about a millisecond.
//
// FAIL QUIET. A folder that does not exist, a file that cannot be read, a catalogue that is missing, locked or of an
// older shape: that source gives nothing, and nothing else changes.
//
// WHAT IT NEVER POINTS AT. MEMORY.md and its archive (loaded every turn anyway), dated daily logs, a chat an agent
// started (its title is a system prompt or carries 🤖), and a chat worked in the last hour: that is the chat the prompt
// is typed in, or one so fresh it is still in the owner's head.

import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  chatDoc,
  createPointerIndex,
  noteDoc,
  type PointerDoc,
  type PointerHit,
  type PointerIndex,
} from "openclaw/plugin-sdk/fork-thalamus";

export const REFRESH_MS = 10 * 60_000;
const CATALOG_CHECK_MS = 60_000;
/** A chat worked more recently than this is never offered. */
export const FRESH_CHAT_MS = 60 * 60_000;
const NOTE_HEAD_BYTES = 4096;
const MAX_NOTE_FILES = 4000;
const MAX_CHATS = 20_000;
/** Chats need more in common than notes: a chat's text is long, so two shared words are often a coincidence. */
const CHAT_MIN_TERMS = 3;
const SKIP_FILE = /^(?:MEMORY|MEMORY-ARCHIVE)\.md$|^\d{4}-\d{2}-\d{2}/i;
const SKIP_DIR = /^(?:\.|node_modules$)/;

export type CatalogRow = {
  id: string;
  title: string | null;
  summary: string | null;
  prompts: string | null;
  last_work_ts: string | null;
};

/** The owner's past sessions from the ask-session catalogue, newest first; undefined when it cannot be read. */
export function readChatCatalog(path: string): CatalogRow[] | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 200");
    const cols = new Set(
      (db.prepare("PRAGMA table_info(cards)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("id") || !cols.has("title") || !cols.has("kind")) {
      return undefined;
    }
    const last = cols.has("last_work_ts") ? "COALESCE(last_work_ts, last_ts)" : "last_ts";
    const summary = cols.has("summary") ? "summary" : "NULL";
    const prompts = cols.has("prompts") ? "substr(prompts, 1, 1500)" : "NULL";
    return db
      .prepare(
        `SELECT id, title, ${summary} AS summary, ${prompts} AS prompts, ${last} AS last_work_ts
         FROM cards WHERE kind = 'main' ORDER BY ${last} DESC LIMIT ?`,
      )
      .all(MAX_CHATS) as CatalogRow[];
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

async function readHead(path: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(NOTE_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, NOTE_HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** The note files of the folders, two levels deep, each folder read once even when two entries name it. */
export async function listNoteFiles(dirs: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real)) {
      return;
    }
    seen.add(real);
    let entries: Dirent[];
    try {
      entries = await readdir(real, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.length >= MAX_NOTE_FILES) {
        return;
      }
      if (e.isDirectory()) {
        if (depth < 1 && !SKIP_DIR.test(e.name)) {
          await walk(join(real, e.name), depth + 1);
        }
      } else if (e.isFile() && /\.md$/i.test(e.name) && !SKIP_FILE.test(e.name)) {
        files.push(join(real, e.name));
      }
    }
  };
  for (const d of dirs) {
    await walk(d, 0);
  }
  return files;
}

/**
 * The note docs of the folders, and the signature of what was read (paths, sizes, times). With the signature of the
 * last read and nothing changed since, only the signature comes back: nothing is read or parsed again.
 */
export async function readNoteDocs(
  dirs: readonly string[],
  lastSig?: string,
): Promise<{ sig: string; docs?: PointerDoc[] }> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const sig: string[] = [];
  for (const path of await listNoteFiles(dirs)) {
    try {
      const st = await stat(path);
      files.push({ path, mtimeMs: st.mtimeMs });
      sig.push(`${path}:${st.size}:${Math.floor(st.mtimeMs)}`);
    } catch {
      /* gone between the listing and now */
    }
  }
  const signature = sig.join("|");
  if (lastSig !== undefined && signature === lastSig) {
    return { sig: signature };
  }
  const docs: PointerDoc[] = [];
  for (const f of files) {
    const head = await readHead(f.path);
    if (head === undefined) {
      continue;
    }
    const doc = noteDoc(f.path, head, f.mtimeMs);
    if (doc) {
      docs.push(doc);
    }
  }
  return { sig: signature, docs };
}

export type PointerFind =
  | { notes: PointerHit[]; chats: PointerHit[] }
  | { skip: "index-building" | "no-sources" };

export function createPointerSources(d: {
  noteDirs: () => readonly string[];
  /** The catalogue path; an empty string means no past-chat leg. */
  chatCatalog: () => string;
  now: () => number;
  /** Injectable so tests need no disk. Given the last signature and nothing changed, it may return no docs. */
  readNotes?: (
    dirs: readonly string[],
    lastSig?: string,
  ) => Promise<{ sig: string; docs?: PointerDoc[] }>;
  readCatalog?: (path: string) => CatalogRow[] | undefined;
  catalogMtime?: (path: string) => Promise<number | undefined>;
  onError?: (err: unknown) => void;
}) {
  const readNotes = d.readNotes ?? readNoteDocs;
  const readCatalog = d.readCatalog ?? readChatCatalog;
  const catalogMtime =
    d.catalogMtime ??
    (async (p: string) => {
      try {
        return (await stat(p)).mtimeMs;
      } catch {
        return undefined;
      }
    });

  let notes: PointerIndex | undefined;
  let notesSig: string | undefined;
  let chats: PointerIndex | undefined;
  const lastWork = new Map<string, number>();
  let builtAt = 0;
  let catalogAt: number | undefined;
  let lastCheck = 0;
  let building: Promise<void> | undefined;

  const buildChats = (path: string, mtime: number | undefined): void => {
    catalogAt = mtime;
    lastWork.clear();
    const rows = path && mtime !== undefined ? (readCatalog(path) ?? []) : [];
    const docs: PointerDoc[] = [];
    for (const r of rows) {
      const doc = chatDoc({
        id: r.id,
        title: r.title,
        summary: r.summary,
        prompts: r.prompts,
        lastWorkTs: r.last_work_ts,
      });
      if (!doc) {
        continue;
      }
      docs.push(doc);
      const t = Date.parse(r.last_work_ts ?? "");
      if (Number.isFinite(t)) {
        lastWork.set(r.id, t);
      }
    }
    chats = createPointerIndex(docs);
  };

  const refresh = (): Promise<void> => {
    if (building) {
      return building;
    }
    building = (async () => {
      try {
        const dirs = d.noteDirs();
        const read =
          dirs.length > 0 ? await readNotes(dirs, notes ? notesSig : undefined) : { sig: "" };
        if (read.docs || !notes || read.sig !== notesSig) {
          notes = createPointerIndex(read.docs ?? []);
        }
        notesSig = read.sig;
        const path = d.chatCatalog();
        buildChats(path, path ? await catalogMtime(path) : undefined);
        builtAt = d.now();
        lastCheck = builtAt;
      } catch (err) {
        d.onError?.(err);
      }
    })().finally(() => {
      building = undefined;
    });
    return building;
  };

  /** Rebuild what went stale, in the background. The catalogue changes once a night; notes through the day. */
  const keepFresh = (): void => {
    const t = d.now();
    if (!notes || t - builtAt >= REFRESH_MS) {
      void refresh();
      return;
    }
    if (building || t - lastCheck < CATALOG_CHECK_MS) {
      return;
    }
    lastCheck = t;
    const path = d.chatCatalog();
    if (!path) {
      return;
    }
    void catalogMtime(path).then(
      (m) => {
        if (m !== catalogAt) {
          try {
            buildChats(path, m);
          } catch (err) {
            d.onError?.(err);
          }
        }
      },
      () => undefined,
    );
  };

  return {
    /** Start the first build; the promise settles when it is done (tests await it). */
    warm: (): Promise<void> => refresh(),

    /** The pointers for a prompt, or why there are none. Never waits for disk. */
    find(text: string, o: { maxNotes: number; maxChats: number }): PointerFind {
      keepFresh();
      if (!notes || !chats) {
        return { skip: "index-building" };
      }
      if (notes.size === 0 && chats.size === 0) {
        return { skip: "no-sources" };
      }
      const now = d.now();
      return {
        notes: notes.match(text, { max: o.maxNotes }),
        chats: chats.match(text, {
          max: o.maxChats,
          minTerms: CHAT_MIN_TERMS,
          exclude: (doc) => now - (lastWork.get(doc.id) ?? 0) < FRESH_CHAT_MS,
        }),
      };
    },

    stats: () => ({ notes: notes?.size ?? 0, chats: chats?.size ?? 0, builtAt }),
  };
}

export type PointerSources = ReturnType<typeof createPointerSources>;
