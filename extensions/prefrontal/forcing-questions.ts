// extensions/prefrontal/forcing-questions.ts
// FORK: Pre-action forcing questions — injects structured thinking prompts
// before complex tasks. Follows GStack's "office hours" pattern.

export interface ForcingQuestionsContext {
  trigger?: string;
}

const COMPLEXITY_KEYWORDS = [
  "implement",
  "refactor",
  "debug",
  "fix and test",
  "redesign",
  "migrate",
  "rewrite",
  "architect",
  "optimize",
  "integrate",
];

const MIN_LENGTH_THRESHOLD = 500;
const MIN_FILE_PATHS = 3;
const FILE_PATH_REGEX = /(?:\/[\w.-]+){2,}/g;

export function shouldInjectForcingQuestions(
  userMessage: string,
  ctx?: ForcingQuestionsContext,
): boolean {
  if (ctx?.trigger === "heartbeat" || ctx?.trigger === "cron") {return false;}
  if (!userMessage || userMessage.length < 10) {return false;}

  const lower = userMessage.toLowerCase();

  // Check for complexity keywords
  if (COMPLEXITY_KEYWORDS.some((kw) => lower.includes(kw))) {return true;}

  // Check for long messages
  if (userMessage.length >= MIN_LENGTH_THRESHOLD) {return true;}

  // Check for multiple file paths
  const paths = userMessage.match(FILE_PATH_REGEX) ?? [];
  if (paths.length >= MIN_FILE_PATHS) {return true;}

  return false;
}

export function getForcingQuestionsPrompt(): string {
  return `## Before You Begin — Forcing Questions

Answer these in your thinking before proceeding:

1. **What is the SIMPLEST solution that fully addresses the requirement?**
   Avoid over-engineering. Three similar lines are better than a premature abstraction.

2. **What existing code/patterns should I follow?**
   Read before writing. Find working examples in the codebase first.

3. **What could go wrong? What are the failure modes?**
   Consider edge cases, but only handle ones that can actually happen.

4. **How will I verify this works?**
   Identify the specific command or test that proves success. You must run it.

5. **What should I NOT touch?**
   Define the scope boundary. A bug fix doesn't need surrounding code cleaned up.`;
}
