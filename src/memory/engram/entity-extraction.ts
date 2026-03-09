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

const STOPWORDS = new Set([
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
]);

const EVENT_KEYWORDS = new Set([
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
const MID_SENTENCE_NAMES = /(?<=\s)([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,2})(?=[\s,.'!?]|$)/g;

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
 * Returns at most 5 queries, prioritizing specific entities over raw keywords.
 */
export function entitiesToQueries(entities: ExtractedEntities): string[] {
  const queries: string[] = [];

  // People get their own queries (high-value)
  for (const person of entities.people) {
    queries.push(person);
  }

  // Events with context
  for (const event of entities.events) {
    queries.push(event);
  }

  // Dates combined with other context if available
  for (const date of entities.dates) {
    queries.push(date);
  }

  // Projects
  for (const project of entities.projects) {
    queries.push(project);
  }

  // If we have room, add raw keywords as a combined query
  if (queries.length < 5 && entities.raw_keywords.length > 0) {
    queries.push(entities.raw_keywords.slice(0, 5).join(" "));
  }

  // Limit to 5 queries total
  return queries.slice(0, 5);
}
