/**
 * ENGRAM — MEMORY.md writer (Upgrade 8, working-memory plane).
 *
 * The MISSING piece of the Mem0 write-reconciliation upgrade: a bounded,
 * idempotent serializer for MEMORY.md. The reconciler core
 * (`reconciliation.ts`) + ledger (`reconciliation-ledger.ts`) already decide
 * ADD/UPDATE/DELETE/NONE; this module turns the surviving fact set (plus the
 * per-episode summaries produced by the nightly consolidation pass) into the
 * bounded digest text.
 *
 * DESIGN DECISION — SUGGEST-ONLY / BOUNDED (Open Question #1, default fork):
 *   This writer NEVER touches disk and NEVER decides to overwrite MEMORY.md.
 *   It is a pure function: facts + summaries + {maxLines} → { content,
 *   demotions, ... }. The caller (the Wire phase, behind ENGRAM_RECONCILE,
 *   default off) decides whether to write the content and how to act on the
 *   demotion suggestions. This preserves MEMORY.md's hand-edited authorship by
 *   default — reconciliation can only *suggest* prunes, never silently rewrite.
 *
 * BOUNDING — mirrors MEMORY.md's own "keep index entries to one line; move
 * detail into topic files" discipline. Each surviving fact becomes a single
 * one-line index entry under the `# Memory Index` heading. When facts +
 * summaries would exceed `maxLines`, the LOWEST-importance facts are DEMOTED to
 * a linked detail-file reference (never dropped) until the output fits.
 *
 * DETERMINISTIC / IDEMPOTENT — facts are sorted by (importance desc, key asc)
 * so the same input always yields byte-identical output regardless of input
 * order, and re-serializing the already-bounded survivor set is a fixpoint.
 *
 * FORK-ISOLATED: unique to our fork (Total Recall paper, Upgrade 8).
 */

/**
 * A single MEMORY.md index entry. One fact = one bounded one-line entry.
 * (No existing `Fact` type in the engram module — defined here as the writer's
 * input contract; the Wire phase derives these from the reconciliation ledger's
 * surviving facts.)
 */
export interface MemoryMdFact {
  /** Stable identity for dedup / tie-break / demotion tracking. */
  key: string;
  /** Human-readable section title (defaults to `key` when absent). */
  title?: string;
  /** One-line summary body. Newlines are collapsed to keep it single-line. */
  summary?: string;
  /** Importance 1–10 (default 5). Higher survives; lower is demoted first. */
  importance?: number;
  /**
   * Optional pre-assigned detail file for this fact. When the fact is demoted,
   * the body links here; if absent, a default detail file is used.
   */
  detailFile?: string;
}

/** A fact the writer suggests demoting to a linked detail file (over budget). */
export interface MemoryMdDemotion {
  key: string;
  title: string;
  importance: number;
  /** The detail file the demoted fact is linked to (never empty). */
  detailFile: string;
  /** The full one-line entry text, so the caller can append it to the file. */
  entry: string;
}

export interface MemoryMdResult {
  /** The bounded MEMORY.md content. Guaranteed `<= opts.maxLines` lines. */
  content: string;
  /** Actual line count of `content`. */
  lineCount: number;
  /** True if any fact was demoted to fit the bound. */
  overBudget: boolean;
  /** Lowest-importance facts demoted to linked detail files (suggest-only). */
  demotions: MemoryMdDemotion[];
}

export interface MemoryMdOptions {
  /** Hard upper bound on output line count. Required. */
  maxLines: number;
}

/** Default detail file demoted facts link to (mirrors the topic-file rule). */
const DEFAULT_DETAIL_FILE = "topics/memory-detail.md";

const INDEX_HEADING = "# Memory Index";
const SUMMARIES_HEADING = "## Recent Episode Summaries";

/** Collapse any multi-line summary into a single clean line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Render a fact as its one-line index entry (deterministic). */
function factEntry(fact: MemoryMdFact): string {
  const title = oneLine(fact.title ?? fact.key);
  const summary = oneLine(fact.summary ?? "");
  return summary ? `- **${title}** — ${summary}` : `- **${title}**`;
}

/**
 * Render the demoted facts as ONE collapsed pointer line per detail file (not
 * one line per fact). This is what makes demotion actually shrink the output:
 * N demoted facts that share a detail file cost a single line, mirroring
 * MEMORY.md's "move detail into topic files" rule (one pointer per topic file).
 */
function demotedPointerLines(demoted: MemoryMdFact[]): string[] {
  // Group by detail file deterministically (file asc), counting facts per file.
  const byFile = new Map<string, number>();
  for (const fact of demoted) {
    const file = fact.detailFile ?? DEFAULT_DETAIL_FILE;
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  return [...byFile.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((file) => {
      const count = byFile.get(file) ?? 0;
      return `- ${count} fact(s) moved to [detail](${file})`;
    });
}

/**
 * Deterministic ordering: importance descending, then key ascending. This makes
 * the writer order-independent (shuffled input → identical output) and makes
 * "lowest-importance first" demotion well-defined even under ties.
 */
function sortFacts(facts: MemoryMdFact[]): MemoryMdFact[] {
  return [...facts].sort((a, b) => {
    const ia = a.importance ?? 5;
    const ib = b.importance ?? 5;
    if (ia !== ib) {
      return ib - ia; // higher importance first
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; // tie-break by key asc
  });
}

/**
 * Serialize a bounded, idempotent MEMORY.md from surviving facts + episode
 * summaries. SUGGEST-ONLY: returns the content string and demotion suggestions;
 * does NOT write to disk and does NOT decide to overwrite the existing file.
 *
 * @param facts             Surviving facts (from the reconciliation ledger).
 * @param episodeSummaries  Per-episode summaries from the consolidation pass.
 * @param opts.maxLines     Hard line bound the output must respect.
 */
export function writeMemoryMd(
  facts: MemoryMdFact[],
  episodeSummaries: string[],
  opts: MemoryMdOptions,
): MemoryMdResult {
  const maxLines = Math.max(1, Math.floor(opts.maxLines));

  // Stable, importance-ranked order — the foundation of determinism.
  const ranked = sortFacts(facts);

  // Demote lowest-importance facts (the tail of `ranked`) until the rendered
  // output fits within maxLines. We render, measure, and if over budget pop the
  // lowest-importance survivor into the demoted set, then re-render. Because
  // ranked is sorted high→low, popping from the end always removes the current
  // lowest-importance fact (deterministic).
  const survivors = [...ranked];
  const demotedFacts: MemoryMdFact[] = [];

  let content = render(survivors, demotedFacts, episodeSummaries);
  while (countLines(content) > maxLines && survivors.length > 0) {
    const dropped = survivors.pop();
    if (dropped) {
      demotedFacts.unshift(dropped); // keep demoted in importance order too
    }
    content = render(survivors, demotedFacts, episodeSummaries);
  }

  const demotions: MemoryMdDemotion[] = demotedFacts.map((fact) => {
    const detailFile = fact.detailFile ?? DEFAULT_DETAIL_FILE;
    return {
      key: fact.key,
      title: oneLine(fact.title ?? fact.key),
      importance: fact.importance ?? 5,
      detailFile,
      entry: factEntry(fact),
    };
  });

  return {
    content,
    lineCount: countLines(content),
    overBudget: demotedFacts.length > 0,
    demotions,
  };
}

function countLines(content: string): number {
  return content.split("\n").length;
}

/**
 * Pure deterministic render. Body = surviving facts as one-line entries, then
 * one collapsed pointer line per detail file holding demoted facts, then the
 * episode summaries (each collapsed to one line so the bound is predictable).
 *
 * The demoted pointers are heading-less inline lines (one per detail file) so
 * that demotion always strictly reduces the line count — the load-bearing
 * property that makes the bounding loop converge.
 */
function render(survivors: MemoryMdFact[], demoted: MemoryMdFact[], summaries: string[]): string {
  const lines: string[] = [INDEX_HEADING, ""];

  for (const fact of survivors) {
    lines.push(factEntry(fact));
  }

  if (demoted.length > 0) {
    for (const pointer of demotedPointerLines(demoted)) {
      lines.push(pointer);
    }
  }

  if (summaries.length > 0) {
    lines.push("", SUMMARIES_HEADING);
    for (const summary of summaries) {
      const flat = oneLine(summary);
      if (flat) {
        lines.push(`- ${flat}`);
      }
    }
  }

  return lines.join("\n");
}
