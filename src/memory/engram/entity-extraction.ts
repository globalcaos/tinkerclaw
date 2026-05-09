/**
 * ENGRAM Stage 1D: Extract named entities from user messages for targeted FTS queries.
 *
 * Regex-based extraction (no LLM call) to keep latency minimal.
 * Produces deduplicated entity lists that can be converted to FTS5 query strings.
 */

export interface ExtractedEntities {
  people: string[];
  events: string[];
  dates: string[];
  projects: string[];
  raw_keywords: string[];
}

// English + Spanish + Catalan stopwords (merged, deduplicated)
const STOPWORDS = new Set([
  // English
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "it",
  "as",
  "are",
  "was",
  "were",
  "been",
  "be",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "not",
  "no",
  "nor",
  "each",
  "every",
  "all",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "about",
  "above",
  "after",
  "again",
  "also",
  "any",
  "because",
  "before",
  "between",
  "come",
  "get",
  "got",
  "here",
  "into",
  "its",
  "know",
  "like",
  "make",
  "many",
  "much",
  "must",
  "never",
  "now",
  "only",
  "over",
  "said",
  "same",
  "she",
  "then",
  "them",
  "there",
  "they",
  "think",
  "through",
  "under",
  "upon",
  "want",
  "well",
  "went",
  "your",
  "you",
  "him",
  "her",
  "his",
  "our",
  "out",
  // Spanish
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "del",
  "al",
  "este",
  "esta",
  "estos",
  "estas",
  "ese",
  "esa",
  "esos",
  "esas",
  "aquel",
  "aquella",
  "que",
  "quien",
  "como",
  "donde",
  "cuando",
  "cual",
  "cuyo",
  "porque",
  "pero",
  "sino",
  "aunque",
  "pues",
  "ya",
  "muy",
  "más",
  "menos",
  "algo",
  "nada",
  "todo",
  "otra",
  "otro",
  "otros",
  "otra",
  "hay",
  "ser",
  "estar",
  "tener",
  "hacer",
  "poder",
  "decir",
  "saber",
  "querer",
  "deber",
  "dar",
  "ver",
  "poner",
  "para",
  "por",
  "con",
  "sin",
  "sobre",
  "entre",
  "hasta",
  "desde",
  "durante",
  "según",
  "también",
  "así",
  "bien",
  "mal",
  "aquí",
  "allí",
  "ahora",
  "después",
  "antes",
  "siempre",
  "solo",
  "puede",
  "tiene",
  "hace",
  "dice",
  "creo",
  "vamos",
  "vale",
  // Catalan
  "els",
  "les",
  "uns",
  "unes",
  "amb",
  "però",
  "doncs",
  "perquè",
  "quan",
  "aquest",
  "aquesta",
  "aquests",
  "aquestes",
  "aquell",
  "aquella",
  "què",
  "qui",
  "com",
  "on",
  "també",
  "ara",
  "després",
  "abans",
  "sempre",
  "sols",
  "molt",
  "més",
  "menys",
  "bé",
  "bon",
  "dia",
  "tot",
  "tota",
  "tots",
  "totes",
  "fer",
  "dir",
  "ser",
  "estar",
  "tenir",
  "poder",
  "saber",
  "voler",
  "deure",
  "veure",
  "posar",
]);

// English + Spanish + Catalan event keywords
const EVENT_KEYWORDS = new Set([
  // English
  "meeting",
  "call",
  "appointment",
  "standup",
  "sync",
  "review",
  "demo",
  "presentation",
  "interview",
  "ceremony",
  "retro",
  "retrospective",
  "planning",
  "grooming",
  "kickoff",
  "workshop",
  "conference",
  "webinar",
  "lunch",
  "dinner",
  "deadline",
  // Spanish
  "reunión",
  "reunion",
  "cita",
  "llamada",
  "entrevista",
  "taller",
  "presentación",
  "presentacion",
  "almuerzo",
  "cena",
  "plazo",
  // Catalan
  "reunió",
  "trucada",
  "formació",
  "formacion",
  "dinar",
  "sopar",
  "termini",
]);

const DAY_NAMES = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const RELATIVE_DATES =
  /\b(today|tomorrow|yesterday|next\s+week|last\s+week|this\s+week|next\s+month|last\s+month)\b/gi;
const ISO_DATES = /\b\d{4}-\d{2}-\d{2}\b/g;
// Patterns like "Mar 10", "March 10th", "10 Mar", "10th March"
const NAMED_MONTH_DATES =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi;
const DATE_MONTH_PATTERN =
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;

// Capitalized word sequences mid-sentence (potential people names)
// Supports accented chars common in Spanish/Catalan names (Núñez, Mañé, García)
const MID_SENTENCE_NAMES =
  /(?<=\s)([A-ZÀ-ÚÑÇ][a-zà-úñçü]{1,20}(?:\s+[A-ZÀ-ÚÑÇ][a-zà-úñçü]{1,20}){0,2})(?=[\s,.'!?]|$)/g;

// Acronyms (3+ uppercase letters)
const ACRONYMS = /\b([A-Z]{3,})\b/g;

// "project X" or "PROJECT X" patterns
const PROJECT_PATTERN = /\bproject\s+(\S+)/gi;

function dedup(arr: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of arr) {
    const lower = item.toLowerCase().trim();
    if (lower && !seen.has(lower)) {
      seen.add(lower);
      result.push(item.trim());
    }
  }
  return result;
}

export function extractEntities(text: string): ExtractedEntities {
  const people: string[] = [];
  const events: string[] = [];
  const dates: string[] = [];
  const projects: string[] = [];
  const raw_keywords: string[] = [];

  // Extract dates
  for (const match of text.matchAll(DAY_NAMES)) {
    dates.push(match[0]);
  }
  for (const match of text.matchAll(RELATIVE_DATES)) {
    dates.push(match[0]);
  }
  for (const match of text.matchAll(ISO_DATES)) {
    dates.push(match[0]);
  }
  for (const match of text.matchAll(NAMED_MONTH_DATES)) {
    dates.push(match[0]);
  }
  for (const match of text.matchAll(DATE_MONTH_PATTERN)) {
    dates.push(match[0]);
  }

  // Extract event keywords with surrounding context
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const clean = words[i].replace(/[^\w]/g, "").toLowerCase();
    if (EVENT_KEYWORDS.has(clean)) {
      // Grab up to 2 words of surrounding context
      const contextWords: string[] = [];
      if (i > 0) {
        contextWords.push(words[i - 1].replace(/[^\w]/g, ""));
      }
      contextWords.push(words[i].replace(/[^\w]/g, ""));
      if (i < words.length - 1) {
        contextWords.push(words[i + 1].replace(/[^\w]/g, ""));
      }
      events.push(contextWords.filter((w) => w.length > 0).join(" "));
    }
  }

  // Extract projects
  for (const match of text.matchAll(PROJECT_PATTERN)) {
    projects.push(match[1].replace(/[^\w]/g, ""));
  }
  for (const match of text.matchAll(ACRONYMS)) {
    projects.push(match[1]);
  }

  // Extract people (mid-sentence capitalized sequences)
  const sentences = text.split(/[.!?]+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }
    // Skip the first word of the sentence, look for capitalized names mid-sentence
    const rest = trimmed.replace(/^\S+\s*/, "");
    for (const match of rest.matchAll(MID_SENTENCE_NAMES)) {
      const candidate = match[1];
      // Filter out common non-name capitalized words
      if (!STOPWORDS.has(candidate.toLowerCase()) && candidate.length > 1) {
        people.push(candidate);
      }
    }
  }

  // Extract raw keywords (significant words not already captured)
  const allCaptured = new Set([
    ...dates.map((d) => d.toLowerCase()),
    ...events.flatMap((e) => e.toLowerCase().split(/\s+/)),
    ...projects.map((p) => p.toLowerCase()),
    ...people.flatMap((p) => p.toLowerCase().split(/\s+/)),
  ]);

  for (const word of words) {
    const clean = word.replace(/[^\w]/g, "").toLowerCase();
    if (clean.length > 3 && !STOPWORDS.has(clean) && !allCaptured.has(clean)) {
      raw_keywords.push(clean);
    }
  }

  return {
    people: dedup(people),
    events: dedup(events),
    dates: dedup(dates),
    projects: dedup(projects),
    raw_keywords: dedup(raw_keywords),
  };
}

/**
 * Convert extracted entities into FTS5-ready query strings.
 * Returns at most 5 queries, prioritizing by specificity:
 *   1. Events with context (most specific — "security meeting")
 *   2. People names (high-value anchors)
 *   3. Projects
 *   4. Dates combined with any available context
 *   5. Raw keywords as fallback combined query
 */
export function entitiesToQueries(entities: ExtractedEntities): string[] {
  const queries: string[] = [];

  // Events with context are the most specific (e.g. "security meeting tomorrow")
  for (const event of entities.events) {
    if (queries.length >= 5) {
      break;
    }
    queries.push(event);
  }

  // People are high-value anchors
  for (const person of entities.people) {
    if (queries.length >= 5) {
      break;
    }
    queries.push(person);
  }

  // Projects
  for (const project of entities.projects) {
    if (queries.length >= 5) {
      break;
    }
    queries.push(project);
  }

  // Dates — combine with other entities for context if possible
  if (queries.length < 5 && entities.dates.length > 0) {
    const dateContext = entities.dates.slice(0, 2).join(" ");
    // If we have event or people context, combine date with first one for richer query
    if (entities.events.length > 0) {
      queries.push(`${entities.events[0]} ${dateContext}`);
    } else if (entities.people.length > 0) {
      queries.push(`${entities.people[0]} ${dateContext}`);
    } else {
      queries.push(dateContext);
    }
  }

  // Raw keywords as a combined fallback query
  if (queries.length < 5 && entities.raw_keywords.length > 0) {
    queries.push(entities.raw_keywords.slice(0, 5).join(" "));
  }

  console.log(
    `[ENGRAM] entity extraction: ${JSON.stringify({
      people: entities.people.length,
      events: entities.events.length,
      dates: entities.dates.length,
      projects: entities.projects.length,
      keywords: entities.raw_keywords.length,
      queries: queries.length,
    })}`,
  );

  return queries.slice(0, 5);
}
