// SS3 Task 0 — a hand-authored typed stdlib so `invoke skill:` and
// `prefrontal.recipe.compose` have real, reusable primitives to assemble from on
// day one (the live skill-library is empty + the extractor declines until Task 0b).
// These are deliberately small, genuinely-reusable, fully-typed skills. They round
// trip as ordinary Skill records; the never-delete library versions/dedups them.
import type { SkillLibrary } from "openclaw/plugin-sdk/fork-recipe-engine";
import type { Skill } from "openclaw/plugin-sdk/fork-recipe-engine";

/** Laplace-neutral fitness for a never-invoked seed: (0+1)/(0+2) = 0.5. */
function neutralMetrics(): Skill["successMetrics"] {
  return { invocations: 0, successes: 0, successRate: 0.5, lastInvoked: null };
}

type SeedShape = Pick<
  Skill,
  "skillId" | "name" | "description" | "steps" | "inputSchema" | "outputSchema"
>;

function mkSeed(partial: SeedShape): Skill {
  return {
    version: 1,
    prerequisites: [],
    testCases: [],
    successMetrics: neutralMetrics(),
    sourceEpisodeIds: [],
    // Fixed timestamp: seeds are deterministic foundational primitives, not
    // episode-derived. (Avoids non-determinism in tests/snapshots.)
    created: "2026-06-04T00:00:00.000Z",
    deprecated: false,
    // These primitives are PROMOTED into the stdlib (not compose-assembled).
    lineage: { composedFrom: "promotion" },
    ...partial,
  };
}

/**
 * The seed set. Kept small + obviously-reusable. Each carries an SS1-compatible
 * `inputSchema`/`outputSchema` so `invoke skill:` validates typed I/O and compose
 * can wire ports between them.
 */
export const STDLIB_SEED_SKILLS: readonly Skill[] = [
  mkSeed({
    skillId: "stdlib-summarize-text",
    name: "summarize-text",
    description: "Condense a body of text into a short, faithful summary.",
    steps: [
      "Read the full input text.",
      "Identify the central claims and any load-bearing details.",
      "Write a faithful summary at or under the requested length; do not invent facts.",
    ],
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, maxWords: { type: "number" } },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  }),
  mkSeed({
    skillId: "stdlib-extract-json-field",
    name: "extract-json-field",
    description: "Extract the value at a dotted path from a JSON object.",
    steps: [
      "Parse the input JSON object.",
      "Resolve the dotted path one segment at a time.",
      "Return the value at that path, or null if any segment is absent.",
    ],
    inputSchema: {
      type: "object",
      properties: { json: { type: "object" }, path: { type: "string" } },
      required: ["json", "path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      // value is intentionally any-typed (the field can be any JSON value).
      properties: { value: {} },
      required: ["value"],
      additionalProperties: false,
    },
  }),
  mkSeed({
    skillId: "stdlib-web-search-and-cite",
    name: "web-search-and-cite",
    description: "Search the web for a query and return ranked results with citations.",
    steps: [
      "Issue a web search for the query.",
      "Select the most relevant results.",
      "Return each result's title, url, and a short snippet so claims can be cited.",
    ],
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, k: { type: "number" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
            },
            required: ["title", "url"],
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
  }),
  mkSeed({
    skillId: "stdlib-classify-text",
    name: "classify-text",
    description: "Assign the single best-fitting label to a text from a candidate set.",
    steps: [
      "Read the input text and the candidate labels.",
      "Choose the single label that best fits the text.",
      "Return the chosen label and a confidence in [0,1].",
    ],
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["text", "labels"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { label: { type: "string" }, confidence: { type: "number" } },
      required: ["label"],
      additionalProperties: false,
    },
  }),
];

/**
 * Deposit the seed stdlib into a skill library. Idempotent-ish: a re-seed of the
 * same names version-bumps via the library's dedup (never duplicates). Returns the
 * deposited skill ids (in seed order).
 */
export async function seedStdlibSkills(lib: SkillLibrary): Promise<string[]> {
  const ids: string[] = [];
  for (const skill of STDLIB_SEED_SKILLS) {
    const ref = await lib.put(skill);
    ids.push(ref.skillId);
  }
  return ids;
}
