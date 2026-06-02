/**
 * FORK 2026-05-29: prefrontal/recipe-author — compose a kit/1.0 recipe on the fly.
 *
 * The matcher's NO-MATCH signal used to be a dead end: Jarvis was told "no
 * recipe fit" and that was that. This module closes the loop — Jarvis (or any
 * caller) composes a structured RecipeSpec and `prefrontal.kit.author` validates +
 * persists it as a real kit.md the matcher will pick up next turn. That makes
 * "compose any recipe on the fly" a functional yes, not a manual file edit.
 *
 * Pure here (no fs): buildRecipeMd + validateRecipeSpec are unit-testable. The RPC in
 * recipe-rpcs.ts does the sandboxed write via RecipeStore.writeKitFiles.
 *
 * See bible subagents-and-kits.md (kit/1.0 spec + sandbox enforcement).
 */

export interface RecipeStepSpec {
  title: string;
  tools?: string[];
  doneWhen?: string;
  body: string;
}

export interface RecipeSpec {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  category?: string;
  triggers?: string[];
  goal?: string;
  whenToUse?: string[];
  steps: RecipeStepSpec[];
  /** 0-based step-index groups; serial chains = one index per group. */
  parallelismGroups?: number[][];
  parallelismNotes?: string;
  constraints?: string[];
  safetyNotes?: string[];
  failuresOvercome?: string[];
}

export interface RecipeValidationResult {
  ok: boolean;
  errors: string[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CANONICAL_CATEGORIES = [
  "coding",
  "writing",
  "communication",
  "analysis",
  "operations",
  "security",
];

/**
 * Validate a RecipeSpec before it is written to disk. Mirrors the merge-gate
 * invariants in subagents-and-kits.md: parseable slug/title/summary, ≥1 step,
 * parallelism groups that are in-range, non-overlapping, and cover every step.
 * Slug is also the on-disk directory name, so it must be traversal-safe.
 */
export function validateRecipeSpec(spec: unknown): RecipeValidationResult {
  const errors: string[] = [];
  const s = spec as Partial<RecipeSpec> | null;

  if (!s || typeof s !== "object") {
    return { ok: false, errors: ["spec is not an object"] };
  }

  if (typeof s.slug !== "string" || !SLUG_RE.test(s.slug)) {
    errors.push(
      `slug must match ${SLUG_RE} (lowercase, no slashes or '..') — got ${JSON.stringify(s.slug)}`,
    );
  }
  if (typeof s.title !== "string" || !s.title.trim()) errors.push("title is required");
  if (typeof s.summary !== "string" || !s.summary.trim()) errors.push("summary is required");
  if (!Array.isArray(s.tags) || s.tags.length === 0) errors.push("tags must be a non-empty array");
  if (
    s.category !== undefined &&
    (typeof s.category !== "string" || !CANONICAL_CATEGORIES.includes(s.category))
  ) {
    errors.push(`category must be one of ${CANONICAL_CATEGORIES.join("|")}`);
  }
  if (!Array.isArray(s.steps) || s.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  } else {
    s.steps.forEach((st, i) => {
      if (!st || typeof st !== "object") errors.push(`step ${i} is not an object`);
      else {
        if (typeof st.title !== "string" || !st.title.trim())
          errors.push(`step ${i} missing title`);
        if (typeof st.body !== "string" || !st.body.trim()) errors.push(`step ${i} missing body`);
        // A numbered markdown heading in the body would reparse as a PHANTOM
        // step (the runner splits on "### N. Title"), desyncing step count and
        // parallelism dispatch. Forbid it (review finding 2026-05-29).
        else if (/^#{1,6}\s+\d+\.\s+/m.test(st.body))
          errors.push(
            `step ${i} body has a numbered markdown heading ("### N. …") that would reparse as a phantom step — reword it`,
          );
      }
    });
  }

  // Parallelism groups: in-range, non-overlapping, full coverage.
  if (s.parallelismGroups !== undefined) {
    const stepCount = Array.isArray(s.steps) ? s.steps.length : 0;
    if (!Array.isArray(s.parallelismGroups)) {
      errors.push("parallelismGroups must be an array of arrays");
    } else {
      const seen = new Set<number>();
      for (const group of s.parallelismGroups) {
        if (!Array.isArray(group) || group.length === 0) {
          errors.push("each parallelism group must be a non-empty array");
          continue;
        }
        for (const idx of group) {
          if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= stepCount) {
            errors.push(
              `parallelism group references invalid step index ${idx} (steps=${stepCount}, must be a 0-based integer)`,
            );
          } else if (seen.has(idx)) {
            errors.push(`parallelism group repeats step index ${idx}`);
          } else {
            seen.add(idx);
          }
        }
      }
      if (errors.length === 0 && seen.size !== stepCount) {
        errors.push(
          `parallelism groups cover ${seen.size}/${stepCount} steps — every step must appear exactly once`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function yamlList(items: string[] | undefined): string {
  if (!items || items.length === 0) return "[]";
  return "\n" + items.map((t) => `  - ${JSON.stringify(t)}`).join("\n");
}

function defaultGroups(stepCount: number): number[][] {
  // Conservative default: fully serial (one step per group). Authors override
  // with explicit independence; we never assume parallelism we weren't told about.
  return Array.from({ length: stepCount }, (_, i) => [i]);
}

/**
 * Assemble a kit/1.0 markdown document from a validated RecipeSpec. The frontmatter
 * keys (schema/slug/title/summary/tags/category/parallelism.groups) are exactly
 * the ones the matcher (recipe-matcher.ts) and the lister (recipe-rpcs.ts parseKitMd)
 * read. Step headings use the canonical `### N. Title` form the runner parses.
 */
export function buildRecipeMd(spec: RecipeSpec): string {
  const groups =
    spec.parallelismGroups && spec.parallelismGroups.length > 0
      ? spec.parallelismGroups
      : defaultGroups(spec.steps.length);

  // The matcher scores against `tags` (not `triggers`), so fold trigger phrases
  // into the tag set — otherwise an authored kit's trigger phrases would never
  // make it matchable (review finding 2026-05-29). Dedup, lowercase.
  const tagSet = new Set<string>();
  for (const t of [...spec.tags, ...(spec.triggers ?? [])]) {
    const v = String(t).trim().toLowerCase();
    if (v) tagSet.add(v);
  }
  const allTags = [...tagSet];

  const fm: string[] = [
    "---",
    `schema: "kit/1.0"`,
    `slug: ${JSON.stringify(spec.slug)}`,
    `title: ${JSON.stringify(spec.title)}`,
    `summary: ${JSON.stringify(spec.summary)}`,
    `version: "1.0.0"`,
    `owner: "globalcaos"`,
    `license: "MIT"`,
    `category: ${JSON.stringify(spec.category ?? "operations")}`,
    `tags: [${allTags.map((t) => JSON.stringify(t)).join(", ")}]`,
    `testedHarnesses: ["OpenClaw", "Claude Code"]`,
    `authoredBy: "jarvis-on-the-fly"`,
    "parallelism:",
    "  groups:",
    ...groups.map((g) => `    - [${g.join(", ")}]`),
  ];
  if (spec.parallelismNotes) {
    fm.push("  notes: |");
    for (const line of spec.parallelismNotes.split("\n")) fm.push(`    ${line}`);
  }
  fm.push("---", "");

  const body: string[] = [];
  body.push(`# ${spec.title}`, "");
  body.push(`> ${spec.summary}`, "");
  if (spec.goal) body.push("## Goal", "", spec.goal, "");
  if (spec.whenToUse && spec.whenToUse.length > 0) {
    body.push("## When to Use", "");
    for (const w of spec.whenToUse) body.push(`- ${w}`);
    body.push("");
  }
  body.push("## Steps", "");
  spec.steps.forEach((st, i) => {
    body.push(`### ${i + 1}. ${st.title}`, "");
    if (st.tools && st.tools.length > 0) body.push(`**Tools:** ${st.tools.join(", ")}`);
    if (st.doneWhen) body.push(`**Done when:** ${st.doneWhen}`);
    if (st.tools?.length || st.doneWhen) body.push("");
    body.push(st.body, "");
  });
  if (spec.constraints && spec.constraints.length > 0) {
    body.push("## Constraints", "");
    for (const c of spec.constraints) body.push(`- ${c}`);
    body.push("");
  }
  if (spec.safetyNotes && spec.safetyNotes.length > 0) {
    body.push("## Safety Notes", "");
    for (const c of spec.safetyNotes) body.push(`- ${c}`);
    body.push("");
  }
  if (spec.failuresOvercome && spec.failuresOvercome.length > 0) {
    body.push("## Failures Overcome", "");
    for (const c of spec.failuresOvercome) body.push(`- ${c}`);
    body.push("");
  }

  // yamlList is exported-in-spirit for future tags-as-block usage; keep ref.
  void yamlList;

  return fm.join("\n") + body.join("\n").trimEnd() + "\n";
}
