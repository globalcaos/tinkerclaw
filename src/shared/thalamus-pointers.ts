// THALAMUS v4 — memory pointers: the note and past-chat legs of the anticipation note (2026-10-25).
//
// WHAT THIS IS FOR. The short list already puts the tools that may fit a task on the desk before round 1. The other
// two things an agent goes searching for are a note it wrote earlier and a chat where the same work was done. This
// finds up to a few of each for a prompt, by the note's own "use when" key (its frontmatter `description`), its title,
// and the start of its text; and a past chat by its title, summary and first owner prompts. The caller turns a hit
// into ONE line with an exact address (a path, a session id). Never the document itself.
//
// NOTHING WHEN NOTHING FITS. A hit needs at least `minTerms` distinct prompt words in common AND must cover at least
// `minCover` of the prompt's information, both relative to this corpus (inverse document frequency over the same
// notes or chats), never an absolute score: an absolute threshold in idf units would move every time the corpus grows.
// Both are taken over the prompt's `POINTER_QUERY_TERMS` rarest words, so a long prompt is neither penalised for its length
// nor matched on its common words.
//
// PURE. No clock, no I/O: the docs are handed in (`extensions/tinkerclaw-thalamus/src/pointer-sources.ts` reads them).
//
// WHAT WOULD CHANGE IT. The ledger records every pointer computed (`enh_uses.pointers_json`) and the round the agent
// opened it in, so the cuts can be re-chosen from counts (`thalamus.anticipate.report`).

import { parse as parseYaml } from "yaml";
import { stems } from "./enhancement-recall.js";
import { taskText } from "./enhancement-text.js";

export type PointerKind = "note" | "chat";

export type PointerDoc = {
  kind: PointerKind;
  /** The exact address: a note's absolute path, a chat's session id. */
  id: string;
  /** What the pointer line shows: the note's use key or heading, the chat's title. */
  label: string;
  /** The words the doc is found by, strongest first: title, use key, body. */
  title: string;
  key: string;
  body: string;
  /** `YYYY-MM-DD` the note was written or the chat last worked, when known. */
  date?: string;
};

export type PointerHit = {
  kind: PointerKind;
  id: string;
  label: string;
  date?: string;
  /** The share of the prompt's information this doc covers, 0..1. */
  cover: number;
  /** Distinct prompt words in common. */
  terms: number;
};

export type PointerMatchOptions = {
  max: number;
  /** Distinct prompt words a hit must share. Default 2: one shared word is a coincidence. */
  minTerms?: number;
  /** The share of the prompt's information a hit must cover. Default `POINTER_MIN_COVER`. */
  minCover?: number;
  /** Docs to leave out (the chat the prompt is typed in, for one). */
  exclude?: (doc: PointerDoc) => boolean;
};

/** The prompt's information is counted over at most this many of its rarest words. */
export const POINTER_QUERY_TERMS = 8;
export const POINTER_MIN_COVER = 0.45;
/** A corpus smaller than this is weighed as if it had this many docs, so a rare word is not worth nothing in a tiny one. */
const IDF_FLOOR_DOCS = 50;
const FIELD_WEIGHT = { title: 1, key: 1, body: 0.6 } as const;

/** How many characters of a note's text past its frontmatter are matched. Enough for a heading and a paragraph. */
export const POINTER_NOTE_BODY_CHARS = 700;

export function createPointerIndex(docs: readonly PointerDoc[]) {
  // term -> postings with the doc's best field weight for that term
  const postings = new Map<string, Array<{ doc: number; w: number }>>();
  docs.forEach((d, i) => {
    const best = new Map<string, number>();
    const add = (text: string, w: number) => {
      for (const t of stems(text)) {
        best.set(t, Math.max(best.get(t) ?? 0, w));
      }
    };
    add(d.title, FIELD_WEIGHT.title);
    add(d.key, FIELD_WEIGHT.key);
    add(d.body, FIELD_WEIGHT.body);
    for (const [t, w] of best) {
      const list = postings.get(t) ?? [];
      list.push({ doc: i, w });
      postings.set(t, list);
    }
  });
  const n = Math.max(docs.length, IDF_FLOOR_DOCS);
  const idf = (t: string) => Math.log(1 + n / (postings.get(t)?.length ?? 1));

  return {
    size: docs.length,
    match(text: string, o: PointerMatchOptions): PointerHit[] {
      if (docs.length === 0 || o.max <= 0) {
        return [];
      }
      // The rarest words carry the most. Both the prompt's information and a doc's share of it are counted over the
      // same rarest words, so a long prompt's common words cannot add up to a match. A word no doc carries counts as
      // the rarest of all: a prompt whose subject is nowhere in the corpus ("the salary band") is not matched on the
      // generic words around it ("draft a reply").
      const query = [...new Set(stems(taskText(text)))]
        .toSorted((a, b) => idf(b) - idf(a) || (a < b ? -1 : 1))
        .slice(0, POINTER_QUERY_TERMS);
      if (!query.some((t) => postings.has(t))) {
        return [];
      }
      const mass = query.reduce((s, t) => s + idf(t), 0);
      const minTerms = o.minTerms ?? 2;
      const minCover = o.minCover ?? POINTER_MIN_COVER;
      const score = new Map<number, { s: number; terms: number }>();
      for (const t of query) {
        const w = idf(t);
        for (const p of postings.get(t) ?? []) {
          const cur = score.get(p.doc) ?? { s: 0, terms: 0 };
          cur.s += w * p.w;
          cur.terms += 1;
          score.set(p.doc, cur);
        }
      }
      const hits: PointerHit[] = [];
      for (const [i, v] of score) {
        const d = docs[i];
        const cover = Math.min(1, v.s / mass);
        if (v.terms < minTerms || cover < minCover) {
          continue;
        }
        if (o.exclude?.(d)) {
          continue;
        }
        hits.push({
          kind: d.kind,
          id: d.id,
          label: d.label,
          ...(d.date ? { date: d.date } : {}),
          cover: Math.round(cover * 1000) / 1000,
          terms: v.terms,
        });
      }
      hits.sort((a, b) => b.cover - a.cover || b.terms - a.terms || (a.id < b.id ? -1 : 1));
      return hits.slice(0, o.max);
    },
  };
}

export type PointerIndex = ReturnType<typeof createPointerIndex>;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isoDay = (v: unknown): string | undefined => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v));
  return m ? m[1] : undefined;
};

/**
 * A note file as a pointer doc: the frontmatter `description` is its use key, `name` and the first heading its title.
 * The label is the use key when there is one (it is written for exactly this moment: deciding whether the file is
 * relevant), else the heading, else the file name. A file with nothing to match on gives undefined.
 */
export function noteDoc(path: string, markdown: string, mtimeMs?: number): PointerDoc | undefined {
  let fm: Record<string, unknown> = {};
  let body = markdown;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (m) {
    try {
      const parsed = parseYaml(m[1]) as unknown;
      if (parsed && typeof parsed === "object") {
        fm = parsed as Record<string, unknown>;
      }
    } catch {
      /* a note whose frontmatter does not parse is matched on its text alone */
    }
    body = markdown.slice(m[0].length);
  }
  const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]?.replace(/[*`]/g, "").trim() ?? "";
  const file = path.split("/").pop() ?? path;
  const name = str(fm.name) || file.replace(/\.md$/i, "");
  const description = oneLine(str(fm.description));
  const text = oneLine(body.slice(0, POINTER_NOTE_BODY_CHARS));
  if (!description && !heading && !text) {
    return undefined;
  }
  const meta =
    fm.metadata && typeof fm.metadata === "object" ? (fm.metadata as Record<string, unknown>) : {};
  const date =
    isoDay(meta.modified) ??
    isoDay(fm.modified) ??
    isoDay(fm.date) ??
    (mtimeMs !== undefined && Number.isFinite(mtimeMs)
      ? new Date(mtimeMs).toISOString().slice(0, 10)
      : undefined);
  return {
    kind: "note",
    id: path,
    label: description || heading || name,
    title: `${name.replace(/[-_]/g, " ")} ${heading}`,
    key: description,
    body: text,
    ...(date ? { date } : {}),
  };
}

/**
 * A chat title that an agent or the system wrote (a headless run's prompt, a message an agent signs with 🤖), not the
 * owner: never offered as a past chat.
 */
const AGENT_TITLE = /^\s*(?:#|⟦|🤖|\[System\b|<|\[Subagent Context\])/u;

/** One past session of the chat catalogue (the ask-session skill's `cards` table) as a pointer doc. */
export function chatDoc(row: {
  id: string;
  title?: string | null;
  summary?: string | null;
  prompts?: string | null;
  lastWorkTs?: string | null;
}): PointerDoc | undefined {
  const title = oneLine(row.title ?? "");
  if (!row.id || !title || AGENT_TITLE.test(title)) {
    return undefined;
  }
  const date = isoDay(row.lastWorkTs);
  return {
    kind: "chat",
    id: row.id,
    label: title,
    title,
    key: oneLine(row.summary ?? ""),
    body: oneLine((row.prompts ?? "").slice(0, 1200)),
    ...(date ? { date } : {}),
  };
}
