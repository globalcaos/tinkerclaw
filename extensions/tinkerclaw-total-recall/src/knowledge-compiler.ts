/**
 * FORK: Knowledge compiler — runs during sleep consolidation.
 *
 * Groups episode summaries by topic and appends to purpose-organized files
 * in the workspace knowledge directory. Deduplicates against existing entries
 * using word-set Jaccard similarity (threshold 0.8).
 *
 * Categories:
 *   - operational-lessons: errors, fixes, incidents, deploys
 *   - domain-facts: tech, API, config, architecture
 *   - decisions-log: decisions with rationale
 *   - people-context: who does what, preferences
 *
 * Wired into sleep-consolidation.ts after episode summary generation.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface KnowledgeEntry {
  text: string;
  source: string; // episode ID
  timestamp: number;
  category: KnowledgeCategory;
}

export type KnowledgeCategory =
  | "operational-lessons" // errors, fixes, incidents, deploys
  | "domain-facts" // tech, API, config, architecture
  | "decisions-log" // decisions with rationale
  | "people-context"; // who does what, preferences

/** Tag patterns for classification — checked in priority order. */
const CLASSIFICATION_RULES: Array<{ pattern: RegExp; category: KnowledgeCategory }> = [
  {
    pattern: /\b(error|fix|incident|regression|deploy|crash|bug|broke|restore)\b/i,
    category: "operational-lessons",
  },
  {
    pattern: /\b(api|config|architecture|code|build|dependency|module|schema|type)\b/i,
    category: "domain-facts",
  },
  {
    pattern: /\b(decided|chose|switch|approve|reject|prefer|adopt|deprecate)\b/i,
    category: "decisions-log",
  },
  {
    pattern: /\b(team|role|contact|prefer)\b/i,
    category: "people-context",
  },
];

/** Capitalized multi-word sequences that look like person names. */
const PERSON_NAME_PATTERN = /\b[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})+\b/;

/**
 * Classify an episode summary into a knowledge category.
 * Checks tags first (exact keyword match), then falls back to summary text analysis.
 */
export function classifyKnowledge(summary: string, tags: string[]): KnowledgeCategory {
  const tagString = tags.join(" ");

  // Check tags against classification rules
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(tagString)) {
      return rule.category;
    }
  }

  // Check for person names in tags
  for (const tag of tags) {
    if (PERSON_NAME_PATTERN.test(tag)) {
      return "people-context";
    }
  }

  // Fall back to summary text analysis
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(summary)) {
      return rule.category;
    }
  }

  if (PERSON_NAME_PATTERN.test(summary)) {
    return "people-context";
  }

  // Default
  return "operational-lessons";
}

/**
 * Compute word-set Jaccard similarity between two strings.
 * Returns a value in [0, 1] where 1.0 = identical word sets.
 */
export function wordSetJaccard(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

  if (wordsA.size === 0 || wordsB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) {
      intersection++;
    }
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract existing entry texts from a markdown knowledge file.
 * Entries are lines starting with "- **[" (our bullet format).
 */
function extractExistingEntries(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.startsWith("- **["))
    .map((line) => {
      // Strip the markdown prefix: "- **[category]** actual text"
      const match = line.match(/^- \*\*\[.*?\]\*\* (.+)$/);
      return match ? match[1] : line;
    });
}

/** Format a date as YYYY-MM-DD. */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Map category to filename. */
function categoryToFilename(category: KnowledgeCategory): string {
  return `${category}.md`;
}

/**
 * Compile episode summaries into knowledge files.
 * Deduplicates against existing entries (Jaccard > 0.8 = skip).
 */
export async function compileKnowledge(params: {
  summaries: Array<{ text: string; id: string; timestamp: number; tags: string[] }>;
  knowledgeDir: string; // ~/.openclaw/workspace/memory/knowledge/
}): Promise<{
  added: number;
  skipped: number;
  byCategory: Record<KnowledgeCategory, number>;
}> {
  const { summaries, knowledgeDir } = params;
  const JACCARD_THRESHOLD = 0.8;

  // Ensure the knowledge directory exists
  if (!existsSync(knowledgeDir)) {
    mkdirSync(knowledgeDir, { recursive: true });
  }

  const byCategory: Record<KnowledgeCategory, number> = {
    "operational-lessons": 0,
    "domain-facts": 0,
    "decisions-log": 0,
    "people-context": 0,
  };
  let added = 0;
  let skipped = 0;

  // Group summaries by category
  const entries: KnowledgeEntry[] = summaries.map((s) => ({
    text: s.text,
    source: s.id,
    timestamp: s.timestamp,
    category: classifyKnowledge(s.text, s.tags),
  }));

  // Group by category for batch writes
  const grouped = new Map<KnowledgeCategory, KnowledgeEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }

  for (const [category, categoryEntries] of grouped) {
    const filePath = join(knowledgeDir, categoryToFilename(category));
    const existingTexts = extractExistingEntries(filePath);

    const linesToAppend: string[] = [];
    let lastDate = "";

    for (const entry of categoryEntries) {
      // Deduplication: check Jaccard similarity against existing entries
      const isDuplicate = existingTexts.some(
        (existing) => wordSetJaccard(entry.text, existing) > JACCARD_THRESHOLD,
      );

      if (isDuplicate) {
        skipped++;
        continue;
      }

      // Add date header if needed
      const dateStr = formatDate(entry.timestamp);
      if (dateStr !== lastDate) {
        linesToAppend.push("", `## ${dateStr}`, "");
        lastDate = dateStr;
      }

      linesToAppend.push(`- **[${category}]** ${entry.text.replace(/\n/g, " ")}`);
      existingTexts.push(entry.text); // Prevent intra-batch duplicates
      byCategory[category]++;
      added++;
    }

    if (linesToAppend.length > 0) {
      appendFileSync(filePath, linesToAppend.join("\n") + "\n", "utf-8");
    }
  }

  return { added, skipped, byCategory };
}
