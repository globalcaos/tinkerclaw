// Loads the question wording from `questions/*.json`, the only place it lives.
//
// The static files (`task.json`, `step.json`, `outcome.json`) have the amygdala's `{family, questions}` shape,
// so the same book can read them (phase C6). The two templates in `questions/templates/` are for questions
// built at run time (one per family, one per top entry, one per pending item) and are never in the book.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JevQuestion } from "openclaw/plugin-sdk/fork-jev";
import type { EnhancementTemplate } from "openclaw/plugin-sdk/fork-thalamus";

/** A question as the files hold it: the client's fields plus the metadata the amygdala's book requires. */
export type RoutingQuestion = JevQuestion & {
  family: "routing";
  seams: Array<"prompt" | "pre-tool" | "post-tool" | "stop">;
  cutoff: { kind: "none" };
  purpose: string;
  origin: string;
  retirement: string;
  mustCatch: string[];
  status: "active" | "off";
  name: string;
};

export type ParallelTemplate = { instructions: string; purpose: string; name: string };

export type LoadedQuestions = {
  task: RoutingQuestion[];
  step: RoutingQuestion[];
  outcome: RoutingQuestion[];
  enhancement: EnhancementTemplate;
  parallel: ParallelTemplate;
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readQuestions(file: string): RoutingQuestion[] {
  const body = readJson<{ family: string; questions: RoutingQuestion[] }>(file);
  if (body.family !== "routing" || !Array.isArray(body.questions)) {
    throw new Error(`${file}: expected {family: "routing", questions: []}`);
  }
  return body.questions;
}

export function loadQuestions(dir: string): LoadedQuestions {
  return {
    task: readQuestions(join(dir, "task.json")),
    step: readQuestions(join(dir, "step.json")),
    outcome: readQuestions(join(dir, "outcome.json")),
    enhancement: readJson<EnhancementTemplate>(join(dir, "templates", "enhancement.json")),
    parallel: readJson<ParallelTemplate>(join(dir, "templates", "step-parallel.json")),
  };
}

/** One noul question per pending item, at most `max` (the rest count as dependent). */
export function buildParallelQuestions(
  items: readonly string[],
  t: ParallelTemplate,
  max = 6,
): { questions: JevQuestion[]; asked: string[] } {
  const asked = items.slice(0, max);
  return {
    asked,
    questions: asked.map((item, i) => ({
      id: `step-parallel-ok-${i + 1}`,
      version: 1,
      type: "noul" as const,
      criteria: { true: "yes", false: "no" },
      instructions: t.instructions.replace("{item}", item.slice(0, 240)),
      fields: ["request"],
    })),
  };
}
