/**
 * BROCA visibility (2026-06-06): parseRecipeMd — single-source recipe parser.
 *
 * A UI panel (tinker-ui/src/panels/broca.ts) must render step-for-step what the
 * runner EXECUTES, so this reuses the runner's exact parsers
 * (parseKitStepsAndParallelism + the per-step directive parsers) instead of a
 * second parser that could drift. Pure: no fs / network — the caller loads the
 * kit.md text (the prefrontal.recipe.read RPC).
 */
import { parse as parseYaml } from "yaml";
import type {
  RecipeSpec,
  RecipeStepSpec,
  RecipeParamSpec,
  RecipeParamType,
} from "./recipe-author.js";
import {
  parseKitStepsAndParallelism,
  parseInvokeSkillDirective,
  parseWhenDirective,
  parseEarlyExitDirective,
} from "./recipe-runner.js";
import { parseStepIoDirectives, stripStepIoDirectives } from "./recipe-types.js";

const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---/;
const DONE_WHEN_RE = /^\*\*Done when:\*\*\s+(.+?)\s*$/m;
const LEADING_DIRECTIVE_RE = /^(?:out|in|uses|loop|when|return|done|map|filter|keep|onError):/i;
const INVOKE_DIRECTIVE_RE = /^invoke\s+skill:/i;
const META_LINE_RE = /^\*\*(?:Tools|Done when):\*\*/i;

/**
 * The human-readable prose of a step body: all leading directive lines
 * (out/in/uses/loop/when/return/done/map/filter/keep/onError/invoke skill) and
 * the `**Tools:**` / `**Done when:**` meta lines stripped from the top.
 */
export function recipeStepProse(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") continue;
    if (LEADING_DIRECTIVE_RE.test(t) || INVOKE_DIRECTIVE_RE.test(t) || META_LINE_RE.test(t))
      continue;
    break;
  }
  return lines.slice(i).join("\n").trim();
}

/** First sentence of prose (up to a terminal . ! ?), or the whole trimmed string. */
export function firstSentence(prose: string): string {
  const t = prose.trim();
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(t);
  return (m ? m[0] : t).trim();
}

/**
 * Parse a recipe kit.md into a RecipeSpec using the runner's exact parser
 * semantics. Per step: out/in via parseStepIoDirectives; invokeSkill/when/earlyExit
 * via the runner's directive parsers off the io-stripped body; doneWhen recovered
 * from the `**Done when:**` meta line; body = the io-stripped body (uses:/when: etc.
 * retained so a caller can re-parse usesKitRef).
 */
export function parseRecipeMd(md: string): RecipeSpec {
  let fm: Record<string, unknown> = {};
  const fmMatch = FRONTMATTER_RE.exec(md);
  if (fmMatch) {
    try {
      const parsed = parseYaml(fmMatch[1]) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object") fm = parsed;
    } catch {
      // frontmatter parse failure → empty fm; slug/title fall back below
    }
  }
  const slug = typeof fm.slug === "string" && fm.slug ? fm.slug : "unknown";
  const title = typeof fm.title === "string" && fm.title ? fm.title : slug;
  const summary = typeof fm.summary === "string" ? fm.summary : "";
  const tags = Array.isArray(fm.tags)
    ? (fm.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  const category = typeof fm.category === "string" ? fm.category : undefined;

  // SS-params: tolerantly normalize the params: frontmatter into typed specs.
  // This is the panel/runner READER — stay lenient; validateRecipeSpec is the hard gate.
  let params: Record<string, RecipeParamSpec> | undefined;
  if (fm.params && typeof fm.params === "object" && !Array.isArray(fm.params)) {
    const acc: Record<string, RecipeParamSpec> = {};
    for (const [name, raw] of Object.entries(fm.params as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      const spec: RecipeParamSpec = { type: (r.type as RecipeParamType) ?? "string" };
      if (typeof r.required === "boolean") spec.required = r.required;
      if (r.default !== undefined) spec.default = r.default;
      if (typeof r.secret === "boolean") spec.secret = r.secret;
      if (typeof r.description === "string") spec.description = r.description;
      if (typeof r.pattern === "string") spec.pattern = r.pattern;
      if (Array.isArray(r.enum))
        spec.enum = r.enum.filter((e): e is string => typeof e === "string");
      acc[name] = spec;
    }
    if (Object.keys(acc).length > 0) params = acc;
  }

  const parsed = parseKitStepsAndParallelism(md);
  const steps: RecipeStepSpec[] = parsed.steps.map((s) => {
    const io = parseStepIoDirectives(s.body);
    const cleaned = stripStepIoDirectives(s.body);
    const dw = DONE_WHEN_RE.exec(s.body);
    const step: RecipeStepSpec = { title: s.title, body: cleaned };
    if (io.out !== undefined) step.out = io.out;
    if (io.in !== undefined) step.in = io.in;
    const skill = parseInvokeSkillDirective(cleaned);
    if (skill) step.invokeSkill = skill;
    const when = parseWhenDirective(cleaned);
    if (when) step.when = when;
    if (parseEarlyExitDirective(cleaned)) step.earlyExit = true;
    if (dw) step.doneWhen = dw[1].trim();
    return step;
  });

  const out: RecipeSpec = { slug, title, summary, tags, steps };
  if (category) out.category = category;
  if (parsed.parallelism?.groups) out.parallelismGroups = parsed.parallelism.groups;
  if (params) out.params = params;
  return out;
}
