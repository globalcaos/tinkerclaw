// The recall stage: up to 15 candidate recipes, skills and plugins for a task (Broca retrieval v2, phase B).
//
// WHAT THIS IS FOR. Jev can rank a few dozen candidates in one question; it cannot read the whole catalogue of
// three hundred. Recall is the cheap local step in front of it: it casts a wide net, so the card the agent will
// open is inside the fifteen, and leaves the choosing to the ranker. It also stands alone as the labelled
// degraded list when Jev may not or cannot answer (never called Jev).
//
// HOW THE FIFTEEN ARE FOUND. Four sources, merged by reciprocal rank so no source's raw score has to match another's:
//   text     fuzzy, rarity-weighted matching of the request against each card's title, summary, tags, triggers,
//            step titles and section titles, so a card is also found through ONE section (inspiration);
//   history  the cards used on the most similar earlier requests (the caller passes training history only);
//   session  the cards this chat used lately and the recipe it is running, with the recipe's composed children;
//   surface  a named place or product in the request (YouTube, SharePoint, Copilot, a torrent, ...) mapped to the
//            skill or recipe the house rules name for it (AGENTS.md "Named surface").
// A card matched only through a section carries that section's title, so the caller can offer it as inspiration.
//
// WHAT IT NEVER DOES. House rules are not candidates (they load every turn anyway). A runtime notice gets nothing. It
// reads no file and calls nothing: the catalogue, the history and the chat context are handed in, so it is pure and
// fast, and nothing here can send a prompt anywhere.
//
// WHAT WOULD CHANGE IT. A replay that shows a source adding nothing (drop it), or one source drowning another (change
// the merge weights, on the development split only).

import { parse as parseYaml } from "yaml";
import { isHouseRule, isRuntimeNotice, taskText } from "./enhancement-text.js";

export type RecallSource = "surface" | "session" | "text" | "history";

export type RecallDoc = {
  /** The card id: `<kind>:<name>`. */
  id: string;
  kind: "skill" | "recipe" | "plugin";
  /** The folder or file name a surface map points at (`youtube-ultimate`, `acme-coding`). */
  slug: string;
  title: string;
  summary: string;
  /** Frontmatter tags and triggers. */
  tags: string[];
  /** Step titles and section headings. */
  sections: string[];
  /** Slugs of the recipes this one composes. */
  composes: string[];
};

export type HistoryItem = { stems: Set<string>; cardIds: readonly string[] };

export type RecallQuery = {
  text: string;
  /** Earlier requests with the cards used on them. The caller decides what is eligible (training half only). */
  history?: readonly HistoryItem[];
  /** Cards of the recipe the chat is running now. */
  active?: readonly string[];
  /** Cards this chat used in earlier turns, newest first. */
  recent?: readonly string[];
  max?: number;
  /** Only these sources run. Absent: all four. Used to measure what each one adds. */
  sources?: readonly RecallSource[];
  /** Merge weights, for measuring on the development split. Absent: `SOURCE_WEIGHT`. */
  weights?: Partial<Record<RecallSource, number>>;
};

export type Candidate = {
  cardId: string;
  score: number;
  via: RecallSource[];
  /** The one section that carries the match, when the card was found through a section. */
  section?: string;
  /** How strong the text match was (idf-weighted overlap of the request with the card's title, tags, sections and summary), when the text source found it. */
  textStrength?: number;
};

export const RECALL_MAX = 15;

// ─── words ──────────────────────────────────────────────────────────────────────────────────────

const STOP = new Set(
  (
    "a an and are as at be but by can could do does for from had has have how if in into is it its just me my no not of on or our please " +
    "so that the their them then there these they this to up us was we were what when where which who why will with would you your want " +
    "need make get let lets now also about like one two all any some more very than too"
  ).split(" "),
);

/** A word that carries no subject (the same list the stemmer drops). */
export const isStopWord = (w: string): boolean => STOP.has(w.toLowerCase());

function stem(w: string): string {
  const base = w.replace(/(ization|isation)$/, "ize");
  const cut = base.replace(/(ing|edly|ed|ly|es|s)$/, "");
  return cut.length >= 3 ? cut : base;
}

/** Lower-case words of three letters or more, stop words out, each reduced to a stem. */
export function stems(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length >= 3 && !STOP.has(w)) out.push(stem(w));
  }
  return out;
}

function withinEdit1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export const toHistoryItem = (text: string, cardIds: readonly string[]): HistoryItem => ({
  stems: new Set(stems(taskText(text))),
  cardIds,
});

// ─── building a catalogue entry from a card and its file ───────────────────────────────────────

const BOILERPLATE_HEADING =
  /^(steps?|constraints?|safety notes?|failures overcome|when (not )?to use|overview|usage|notes?|examples?|references?|requirements?|setup|installation|prerequisites?|output|inputs?)$/i;

function slugOf(card: { name: string; path?: string }): string {
  if (!card.path) return card.name;
  const parts = card.path.split("/");
  const file = parts[parts.length - 1];
  if (/^(SKILL|recipe|kit)\.md$/i.test(file)) return parts[parts.length - 2] ?? card.name;
  return file.replace(/\.recipe\.md$/, "").replace(/\.md$/, "");
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * A catalogue entry from a card and, when there is one, the text of its file. A card with no file is still
 * matchable on its title and purpose. Headings and step titles become sections; boilerplate headings do not.
 */
export function docFromCard(
  card: {
    id: string;
    kind: RecallDoc["kind"];
    name: string;
    purpose: string;
    path?: string;
    /** Phrases the nightly loop learned from tasks the card served that its author never had in mind. They are trigger words. */
    alsoServed?: readonly string[];
  },
  markdown?: string,
): RecallDoc {
  let fm: Record<string, unknown> = {};
  let body = markdown ?? "";
  const m = /^---\n([\s\S]+?)\n---\n?/.exec(body);
  if (m) {
    try {
      const parsed = parseYaml(m[1]) as unknown;
      if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
    } catch {
      /* a card whose frontmatter does not parse is matched on its purpose alone */
    }
    body = body.slice(m[0].length);
  }
  const sections: string[] = [];
  for (const line of body.split("\n")) {
    const h = /^#{2,4}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const title = h[1]
      .replace(/^\d+[.)]\s*/, "")
      .replace(/[*`]/g, "")
      .trim();
    if (title && !BOILERPLATE_HEADING.test(title)) sections.push(title);
  }
  const description = typeof fm.description === "string" ? fm.description : "";
  const summary = typeof fm.summary === "string" ? fm.summary : "";
  return {
    id: card.id,
    kind: card.kind,
    slug: slugOf(card),
    title: typeof fm.title === "string" ? fm.title : card.name,
    summary: [
      card.purpose,
      summary,
      description,
      ...(card.alsoServed?.length ? [`Also served: ${card.alsoServed.join("; ")}`] : []),
    ]
      .filter(Boolean)
      .join(" "),
    tags: [
      ...new Set([...asStrings(fm.tags), ...asStrings(fm.triggers), ...(card.alsoServed ?? [])]),
    ],
    sections,
    composes: asStrings(fm.composes),
  };
}

/**
 * The recall catalogue from the cards: each card with the text of its file, read through `read` (injected, so a test needs no
 * disk; undefined for a plugin whose path is a folder). One place for the live ranker and the nightly loop, so what the loop
 * scores is what a prompt is ranked against.
 */
export function docsFromCards(
  cards: readonly {
    id: string;
    kind: RecallDoc["kind"];
    name: string;
    purpose: string;
    path?: string;
    alsoServed?: readonly string[];
    status?: string;
  }[],
  read: (path: string) => string | undefined,
): RecallDoc[] {
  return cards
    .filter((c) => c.status === undefined || c.status === "active")
    .map((c) => docFromCard(c, c.path ? read(c.path) : undefined));
}

// ─── named surfaces ─────────────────────────────────────────────────────────────────────────────

/**
 * A named place, product or kind of job, mapped to the skill or recipe the house rules name for it. Written from
 * AGENTS.md "Named surface → catalog first" and the recipes it lists; an entry names `skill:<slug>` or `recipe:<slug>`
 * and is dropped when the catalogue has no such card. It is a map of what the rules already say, not of what a
 * replay missed.
 */
export const NAMED_SURFACES: ReadonlyArray<{ id: string; re: RegExp; cards: readonly string[] }> = [
  { id: "youtube", re: /\byoutube\b|\byoutu\.be\b/i, cards: ["skill:youtube-ultimate"] },
  { id: "gmail", re: /\bgmail\b|\bgog\b/i, cards: ["skill:gog"] },
  {
    id: "amazon",
    re: /\bamazon\b/i,
    cards: ["skill:amazon-shopper", "skill:amazon-product-search-api-skill"],
  },
  {
    id: "copilot",
    re: /\bcopilot\b|\bm365\b|microsoft 365|office 365/i,
    cards: ["skill:m365-copilot", "recipe:microsoft-copilot-connect"],
  },
  {
    id: "sharepoint",
    re: /sharepoint|download[- ]protected|\bimporta del\b/i,
    cards: ["skill:sharepoint-download", "skill:m365-protected-office-extract"],
  },
  {
    id: "torrent",
    re: /\btorrents?\b|\bmagnet\b|\bdownload (?:the )?(?:film|movie|series)\b/i,
    cards: ["skill:torrent-scout", "skill:torrent-verify"],
  },
  { id: "teams", re: /\bteams\b/i, cards: ["skill:teams-hack"] },
  { id: "outlook", re: /\boutlook\b/i, cards: ["skill:outlook-hack"] },
  {
    id: "programming-wiki",
    re: /programming wiki|\bdokuwiki\b|acmevision_lab|\bforecr\b.*\blogin/i,
    cards: ["recipe:acme-programming-wiki-maintenance"],
  },
  {
    id: "gantt",
    re: /\bgantt\b|how is sv2 doing|report progress|where are we\b/i,
    cards: ["skill:build-gantt"],
  },
  {
    id: "master-worker",
    re: /master[- ]worker|worker tab|chained tabs?|\bbuild run\b/i,
    cards: ["recipe:master-worker-coding"],
  },
  {
    id: "article-code",
    re: /article code|codi d'?article|llibreria comer/i,
    cards: ["recipe:acme-article-code"],
  },
  {
    id: "personal-document",
    re: /find (?:my|the) (?:contract|policy|invoice|document)|personal document|sent it on whatsapp/i,
    cards: ["recipe:find-personal-document"],
  },
  {
    id: "trip",
    re: /\b(?:trip|holiday|flights?|motorhome|rv)\b/i,
    cards: ["recipe:plan-family-trip", "skill:flight-scan", "skill:trip-planner", "skill:rv-scan"],
  },
  {
    id: "review-site",
    re: /review site|decision page|story page|for \w+ to review|choose item by item/i,
    cards: ["recipe:review-site", "recipe:decision-page"],
  },
  {
    id: "product-logo",
    re: /(?:acme|acmevision|acmemove|acmepid)\b[^.\n]{0,60}\b(?:logo|wordmark)|\b(?:logo|wordmark)\b[^.\n]{0,60}\b(?:acme|acmevision|acmemove|acmepid)\b/i,
    cards: ["recipe:acme-product-logo"],
  },
  { id: "freeze", re: /\bi'?m off\b|\bfreeze\b|power off/i, cards: ["skill:freeze-thaw"] },
  {
    id: "goku-login",
    re: /\bgoku\b[^.\n]{0,40}\b(?:login|token|access)\b|\b(?:login|token|access)\b[^.\n]{0,40}\bgoku\b/i,
    cards: ["recipe:give-goku-access"],
  },
  {
    id: "acme-coding",
    re: /commit diagram|\bfore2\b.*\bgit\b|acme feature/i,
    cards: ["recipe:acme-coding"],
  },
  {
    id: "candidate-cv",
    re: /\bcvs?\b|curriculum|candidate/i,
    cards: ["skill:m365-copilot"],
  },
];

// ─── the index ──────────────────────────────────────────────────────────────────────────────────

const FIELD_WEIGHT = { tags: 3, title: 2.5, slug: 2, sections: 2, summary: 1.2 } as const;
type Posting = { doc: number; w: number };

type SourceHit = {
  doc: number;
  section?: string;
  /** The text source's raw match strength (idf-weighted overlap). */ strength?: number;
};
const RRF_K = 20;
/**
 * Chosen on the development split (training half, walk-forward) from a grid of 27 settings: recall@15 was flat across
 * the grid (39 or 38 of 44 cases, 55 or 54 of 73 pairs), so these sit in its best tier and were not pushed further.
 * A popularity prior was tried as a fifth source and dropped: it added no recall.
 */
export const SOURCE_WEIGHT: Record<RecallSource, number> = {
  surface: 3,
  session: 2.5,
  text: 1,
  history: 1,
};

export function createRecall(
  catalog: readonly RecallDoc[],
  o: { surfaces?: typeof NAMED_SURFACES } = {},
) {
  const surfaces = o.surfaces ?? NAMED_SURFACES;
  const docs = catalog.filter((d) => !isHouseRule(d.id));
  const byId = new Map(docs.map((d, i) => [d.id, i] as const));
  const bySlug = new Map<string, number[]>();
  docs.forEach((d, i) => {
    const k = `${d.kind}:${d.slug}`;
    bySlug.set(k, [...(bySlug.get(k) ?? []), i]);
  });

  // term -> postings, with the best field weight a doc gets for that term
  const postings = new Map<string, Posting[]>();
  const sectionStems: string[][][] = docs.map((d) => d.sections.map((s) => stems(s)));
  const addTerms = (doc: number, text: string, w: number) => {
    for (const t of new Set(stems(text))) {
      const list = postings.get(t) ?? [];
      const hit = list.find((p) => p.doc === doc);
      if (hit) hit.w = Math.max(hit.w, w);
      else list.push({ doc, w });
      postings.set(t, list);
    }
  };
  docs.forEach((d, i) => {
    addTerms(i, d.title, FIELD_WEIGHT.title);
    addTerms(i, d.slug.replace(/[-_]/g, " "), FIELD_WEIGHT.slug);
    addTerms(i, d.tags.join(" "), FIELD_WEIGHT.tags);
    addTerms(i, d.sections.join(" "), FIELD_WEIGHT.sections);
    addTerms(i, d.summary, FIELD_WEIGHT.summary);
  });
  const idf = (term: string) => Math.log(1 + docs.length / (postings.get(term)?.length ?? 1));
  const vocab = [...postings.keys()];
  const expansions = new Map<string, Array<[string, number]>>();
  const expand = (q: string): Array<[string, number]> => {
    const cached = expansions.get(q);
    if (cached) return cached;
    const out: Array<[string, number]> = [];
    if (postings.has(q)) out.push([q, 1]);
    if (q.length >= 5) {
      for (const t of vocab) {
        if (t === q || t.length < 5) continue;
        if (t.startsWith(q) || q.startsWith(t)) out.push([t, 0.6]);
        else if (withinEdit1(q, t)) out.push([t, 0.5]);
      }
    }
    expansions.set(q, out);
    return out;
  };

  const sectionScore = (doc: number, query: readonly string[]) => {
    let best = { score: 0, title: "", matched: 0 };
    sectionStems[doc].forEach((tokens, si) => {
      let score = 0;
      let matched = 0;
      for (const q of query) {
        let g = 0;
        let idfAt = 0;
        for (const [term, grade] of expand(q)) {
          if (tokens.includes(term) && grade > g) {
            g = grade;
            idfAt = idf(term);
          }
        }
        if (g > 0) {
          score += g * idfAt;
          matched += 1;
        }
      }
      if (score > best.score) best = { score, title: docs[doc].sections[si], matched };
    });
    return best;
  };

  function textHits(query: readonly string[], limit: number): SourceHit[] {
    const perDoc = new Map<number, Map<string, number>>();
    for (const q of new Set(query)) {
      for (const [term, grade] of expand(q)) {
        const rarity = idf(term);
        for (const p of postings.get(term) ?? []) {
          const got = perDoc.get(p.doc) ?? new Map<string, number>();
          got.set(q, Math.max(got.get(q) ?? 0, rarity * grade * p.w));
          perDoc.set(p.doc, got);
        }
      }
    }
    const scored = [...perDoc.entries()]
      .map(([doc, m]) => ({ doc, score: [...m.values()].reduce((a, b) => a + b, 0) }))
      .toSorted((a, b) => b.score - a.score || a.doc - b.doc)
      .slice(0, limit);
    return scored.map(({ doc, score }) => {
      const sec = sectionScore(doc, query);
      const carries = sec.matched >= 2 && sec.score >= 0.4 * score;
      return { doc, strength: score, ...(carries ? { section: sec.title } : {}) };
    });
  }

  function historyHits(
    queryStems: ReadonlySet<string>,
    history: readonly HistoryItem[],
  ): SourceHit[] {
    if (queryStems.size === 0 || history.length === 0) return [];
    const df = new Map<string, number>();
    for (const h of history) for (const s of h.stems) df.set(s, (df.get(s) ?? 0) + 1);
    const w = (s: string) => Math.log(1 + history.length / (df.get(s) ?? 1));
    const qNorm = Math.sqrt([...queryStems].reduce((a, s) => a + w(s) ** 2, 0));
    const sims = history
      .map((h) => {
        let dot = 0;
        let hNorm = 0;
        for (const s of h.stems) {
          hNorm += w(s) ** 2;
          if (queryStems.has(s)) dot += w(s) ** 2;
        }
        return { h, sim: dot === 0 ? 0 : dot / (qNorm * Math.sqrt(hNorm)) };
      })
      .filter((x) => x.sim >= 0.12)
      .toSorted((a, b) => b.sim - a.sim)
      .slice(0, 10);
    const votes = new Map<number, number>();
    for (const { h, sim } of sims) {
      for (const id of new Set(h.cardIds)) {
        const doc = byId.get(id);
        if (doc !== undefined) votes.set(doc, (votes.get(doc) ?? 0) + sim);
      }
    }
    return [...votes.entries()]
      .toSorted((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([doc]) => ({ doc }));
  }

  function surfaceHits(text: string): SourceHit[] {
    const out: SourceHit[] = [];
    for (const s of surfaces) {
      if (!s.re.test(text)) continue;
      for (const ref of s.cards) for (const doc of bySlug.get(ref) ?? []) out.push({ doc });
    }
    return out;
  }

  function sessionHits(active: readonly string[], recent: readonly string[]): SourceHit[] {
    const out: SourceHit[] = [];
    const push = (doc: number | undefined) => doc !== undefined && out.push({ doc });
    for (const id of active) {
      const doc = byId.get(id);
      push(doc);
      if (doc === undefined) continue;
      for (const slug of docs[doc].composes)
        for (const c of bySlug.get(`recipe:${slug}`) ?? []) push(c);
      docs.forEach((d, i) => d.composes.includes(docs[doc].slug) && push(i));
    }
    for (const id of recent) push(byId.get(id));
    return out;
  }

  return {
    size: docs.length,
    /** At most `max` (default 15) candidates, best first. A runtime notice gets none. */
    recall(q: RecallQuery): Candidate[] {
      const max = q.max ?? RECALL_MAX;
      if (isRuntimeNotice(q.text)) return [];
      const text = taskText(q.text);
      const want = new Set<RecallSource>(q.sources ?? ["surface", "session", "text", "history"]);
      const weight = { ...SOURCE_WEIGHT, ...q.weights };
      const queryStems = stems(text);
      const lists: Array<[RecallSource, SourceHit[]]> = [];
      if (want.has("surface")) lists.push(["surface", surfaceHits(text)]);
      if (want.has("session")) lists.push(["session", sessionHits(q.active ?? [], q.recent ?? [])]);
      if (want.has("text")) lists.push(["text", textHits(queryStems.slice(0, 80), 40)]);
      if (want.has("history"))
        lists.push(["history", historyHits(new Set(queryStems), q.history ?? [])]);

      const merged = new Map<number, Candidate>();
      for (const [source, hits] of lists) {
        const seen = new Set<number>();
        let rank = 0;
        for (const hit of hits) {
          if (seen.has(hit.doc)) continue;
          seen.add(hit.doc);
          rank += 1;
          const got = merged.get(hit.doc) ?? { cardId: docs[hit.doc].id, score: 0, via: [] };
          got.score += weight[source] / (RRF_K + rank);
          got.via.push(source);
          if (source === "text" && hit.strength !== undefined)
            got.textStrength = Math.max(got.textStrength ?? 0, hit.strength);
          if (hit.section && !got.section) got.section = hit.section;
          merged.set(hit.doc, got);
        }
      }
      return [...merged.values()]
        .toSorted((a, b) => b.score - a.score || (a.cardId < b.cardId ? -1 : 1))
        .slice(0, max);
    },
  };
}

export type Recall = ReturnType<typeof createRecall>;
