/**
 * FORK 2026-10-06 (Broca retrieval v2, phase D): recipe-extract — lift ONE step of a recipe into its own composable recipe.
 *
 * WHAT THIS IS FOR. Inspiration found in one part of a recipe is only reusable if that part can be run on its own. This
 * turns a numbered step (`### N. Title`) into a recipe of its own and leaves, where the step was, the one line the runner
 * already understands as composition: `uses: <slug>`. The parent keeps its title, its number and every other byte; the
 * runner resolves the new recipe through the same `uses:` edge `feature.md` uses for its sub-recipes.
 *
 * HOW IT STAYS FAITHFUL. Step boundaries are the runner's own (`parseKitStepsAndParallelism`: a numbered heading to the
 * next numbered heading), so "the step" is exactly what the runner sends a subagent. Before any write it parses the
 * would-be parent and child and proves that expanding `uses:` gives the original steps, title for title and body for body,
 * and that every `{{param}}` the moved step uses is declared in the child with the parent's own spec.
 *
 * WHAT IT REFUSES (and then writes nothing). A step the child could not run alone:
 *  - one that reads the parent's plan: an `in:`/`out:`/`when:`/`return:`/`onError:` directive, or a `{{steps.N.out…}}` ref;
 *  - one that is already composition or control flow: `uses:`, `invoke skill:`, `loop:`, `map:`, `filter:`, `keep:`, `done:`;
 *  - one that uses `{{item}}`/`{{index}}`, or a `{{param}}` the parent does not declare (the child could not receive it);
 *  - one whose body holds a heading as high as its own (a trailing `## Constraints` the runner folds into the last step);
 *  - a slug that exists anywhere in the library, an unknown or ambiguous section, a recipe whose steps are not 1..N in order.
 * Per-step budget directives (`allow-tools`, `max-tokens`, `max-tool-calls`, `model`, `thinking`) move with the step.
 *
 * WRITES ARE STAGED. The new files are written beside their targets first, then published child first, parent last (one
 * atomic rename), then read back and re-verified. A failure anywhere removes what this call created and puts the parent's
 * original bytes back, so the library is byte-identical to before. A source is never deleted; the parent's previous text is
 * archived (append-only) before it changes.
 *
 * VALUES. Parameters move as NAMES AND SPECS only. A `secret: true` default is not copied. The private store
 * (`recipe-vars.json`) is not read or written: the child receives the parent's resolved parameters by name at run time, which
 * is how every `uses:` sub-recipe already gets them.
 *
 * WHAT WOULD CHANGE IT. Moving a RANGE of steps (needs renumbering of `steps.N.out` refs, `when:` guards and parallelism
 * groups), or giving a lifted step a typed `out:` (needs the parent's `uses:` step to adopt the child's return value).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildRecipeMd,
  validateRecipeSpec,
  type RecipeParamSpec,
  type RecipeSpec,
} from "./recipe-author.js";
import { declaredSlug, findRecipeFile } from "./recipe-locate.js";
import {
  checkParamRefs,
  isDynamicUsesRef,
  parseParamsFromText,
  parseUsesDirective,
  type CompileStep,
} from "./recipe-runner.js";
import { injectLineageFrontmatter, recipeArchiveDir } from "./recipe-snapshot.js";

export type ExtractParams = {
  /** Slug of the recipe to lift the step out of. */
  from: string;
  /** The step's number (`"3"`) or its title (case-insensitive, whole title). */
  section: string;
  /** Slug of the new recipe. */
  slug: string;
  /** Title of the new recipe. */
  title: string;
};

export type ExtractResult =
  | {
      ok: true;
      slug: string;
      kitRef: string;
      /** The new recipe's file. */
      path: string;
      /** The parent's file, now holding `uses: <slug>` where the step was. */
      parentPath: string;
      /** The step that moved, 1-based. */
      step: number;
      stepTitle: string;
      /** Parameters the child declares, by name. */
      paramsMoved: string[];
      /** Where the parent's previous text was archived. */
      archive: string;
      /** Number of steps either recipe expands to; equal by construction. */
      expandedSteps: number;
      notes: string[];
    }
  | { ok: false; refused: string[] };

/** The file operations a write needs, so a test can make any one of them fail. */
export interface ExtractIo {
  readFile(p: string): Promise<string>;
  /** Create a new file; fails when it exists. */
  createFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(p: string): Promise<void>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
}

export const nodeIo: ExtractIo = {
  readFile: (p) => fs.readFile(p, "utf-8"),
  createFile: (p, data) => fs.writeFile(p, data, { encoding: "utf-8", flag: "wx" }),
  rename: (a, b) => fs.rename(a, b),
  mkdir: (p) => fs.mkdir(p),
  unlink: (p) => fs.unlink(p),
  rmdir: (p) => fs.rmdir(p),
  chmod: (p, mode) => fs.chmod(p, mode),
};

// ─── steps, exactly as the runner splits them ───────────────────────────────────────────────

type Step = {
  number: number;
  title: string;
  body: string;
  /** Offsets into the whole text: the heading's first character and the next numbered heading (or the end). */
  start: number;
  end: number;
  headingLen: number;
  level: number;
};

const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n/;
const HEADING_RE = /^(#{1,6})\s+(\d+)\.\s+(.+)$/m;

/** The runner's split: from one numbered heading to the next. A heading with no title is skipped, as the runner skips it. */
export function splitSteps(text: string): Step[] {
  const fm = FRONTMATTER_RE.exec(text);
  const bodyStart = fm ? fm[0].length : 0;
  const body = text.slice(bodyStart);
  const starts = [...body.matchAll(/^#{1,6}\s+\d+\.\s+/gm)].map((m) => m.index);
  const steps: Step[] = [];
  starts.forEach((s, i) => {
    const e = i + 1 < starts.length ? starts[i + 1] : body.length;
    const part = body.slice(s, e);
    const m = HEADING_RE.exec(part);
    if (!m) return;
    steps.push({
      number: parseInt(m[2], 10),
      title: m[3].trim(),
      body: part.slice(m[0].length).trim(),
      start: bodyStart + s,
      end: bodyStart + e,
      headingLen: m[0].length,
      level: m[1].length,
    });
  });
  return steps;
}

export type ExpandedStep = { title: string; body: string };

/**
 * The flat list of steps a recipe runs: every static `uses:` step replaced by the steps of the recipe it names, recursively.
 * `resolve` gives the text of a recipe by `owner/slug`; undefined means it is not in the library (an installed kit, say), and
 * the step is kept as it is, so the same reference expands the same way before and after an extraction.
 */
export async function expandRecipeSteps(
  text: string,
  resolve: (ref: string) => Promise<string | undefined>,
  chain: readonly string[] = [],
): Promise<ExpandedStep[]> {
  const out: ExpandedStep[] = [];
  for (const step of splitSteps(text)) {
    const ref = parseUsesDirective(step.body);
    if (!ref || isDynamicUsesRef(ref)) {
      out.push({ title: step.title, body: step.body });
      continue;
    }
    if (chain.includes(ref) || chain.length >= 8) {
      throw new Error(`composition cycle or depth limit at ${ref}`);
    }
    const sub = await resolve(ref);
    if (sub === undefined) {
      out.push({ title: step.title, body: step.body });
      continue;
    }
    out.push(...(await expandRecipeSteps(sub, resolve, [...chain, ref])));
  }
  return out;
}

// ─── what the step is made of ───────────────────────────────────────────────────────────────

/** Leading directive names that tie a step to its parent's plan or turn it into composition or control flow. */
const REFUSED_DIRECTIVES = new Set([
  "uses",
  "loop",
  "when",
  "return",
  "done",
  "map",
  "filter",
  "keep",
  "onerror",
  "in",
  "out",
  "invoke skill",
]);
const BUDGET_DIRECTIVES = new Set([
  "allow-tools",
  "max-tokens",
  "max-tool-calls",
  "model",
  "thinking",
]);
const DIRECTIVE_RE =
  /^(uses|loop|when|return|done|map|filter|keep|onError|allow-tools|max-tokens|max-tool-calls|model|thinking|in|out|invoke\s+skill)\s*:/i;

function leadingDirectiveNames(body: string): string[] {
  const names: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = DIRECTIVE_RE.exec(line);
    if (!m) break;
    names.push(m[1].toLowerCase().replace(/\s+/g, " "));
  }
  return names;
}

/** Does the body hold a heading as high as the step's own, outside code fences? That is a sibling section, not the step. */
function holdsSiblingHeading(body: string, level: number): string | undefined {
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (m && m[1].length <= level) return line.trim();
  }
  return undefined;
}

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

const words = (s: string): string[] => [...new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];

const normTitle = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

const frontmatterOf = (text: string): Record<string, unknown> => {
  const fm = FRONTMATTER_RE.exec(text);
  if (!fm) return {};
  try {
    const parsed = parseYaml(fm[1]) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const compileSteps = (text: string): CompileStep[] =>
  splitSteps(text).map((s) => ({ title: s.title, body: s.body }));

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ─── the operation ──────────────────────────────────────────────────────────────────────────

export type ExtractOptions = {
  /** Where the parent's previous text is archived. Default: the archive beside the parent's library root. */
  archiveDir?: string;
  /** ISO time for the archive file name; given so a test is deterministic. Default: now. */
  stamp?: string;
  io?: ExtractIo;
};

/**
 * Lift one step of `p.from` into a recipe of its own. `roots` are the recipe libraries in the order the runner reads them;
 * the parent is changed where it is found and the child is created beside it, as `<root>/<slug>/recipe.md`.
 */
export async function extractSection(
  roots: readonly string[],
  p: ExtractParams,
  o: ExtractOptions = {},
): Promise<ExtractResult> {
  const io = o.io ?? nodeIo;
  const refuse = (...why: string[]): ExtractResult => ({ ok: false, refused: why });

  if (typeof p.from !== "string" || !p.from.trim())
    return refuse("from (a recipe slug) is required");
  if (typeof p.section !== "string" || !p.section.trim())
    return refuse("section (a step number or title) is required");
  if (p.slug === p.from) return refuse("the new slug must differ from the recipe it comes from");

  // 1. Find the parent.
  let parentPath: string | null = null;
  let root = "";
  for (const r of roots) {
    parentPath = await findRecipeFile(r, p.from);
    if (parentPath) {
      root = r;
      break;
    }
  }
  if (!parentPath) return refuse(`recipe "${p.from}" not found in any recipe library`);
  let original: string;
  try {
    original = await io.readFile(parentPath);
  } catch (err) {
    return refuse(
      `could not read ${parentPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (original.includes("\r"))
    return refuse("the recipe has CRLF line endings; convert them first");

  // 2. Find the step.
  const steps = splitSteps(original);
  if (steps.length === 0) return refuse(`"${p.from}" has no numbered steps (### N. Title)`);
  if (!steps.every((s, i) => s.number === i + 1)) {
    return refuse(
      `"${p.from}" steps are not numbered 1..${steps.length} in order; renumber them first`,
    );
  }
  const wanted = p.section.trim();
  const matches = /^\d+$/.test(wanted)
    ? steps.filter((s) => s.number === Number(wanted))
    : steps.filter((s) => normTitle(s.title) === normTitle(wanted));
  if (matches.length === 0) {
    return refuse(
      `no step "${wanted}" in "${p.from}" (steps: ${steps.map((s) => `${s.number}. ${s.title}`).join("; ")})`,
    );
  }
  if (matches.length > 1)
    return refuse(`"${wanted}" matches ${matches.length} steps in "${p.from}"; use the number`);
  const step = matches[0];

  // 3. Can the step run on its own?
  const problems: string[] = [];
  for (const d of leadingDirectiveNames(step.body)) {
    if (REFUSED_DIRECTIVES.has(d)) {
      problems.push(
        `step ${step.number} carries a \`${d}:\` directive, which ties it to the plan of "${p.from}" or is composition already`,
      );
    } else if (!BUDGET_DIRECTIVES.has(d)) {
      problems.push(
        `step ${step.number} carries a \`${d}:\` directive this extraction does not know`,
      );
    }
  }
  const sibling = holdsSiblingHeading(step.body, step.level);
  if (sibling) {
    problems.push(
      `step ${step.number} holds the heading "${sibling}" at its own level or higher; the runner folds it into the step, so lifting the step would carry it or drop it. Number it as a step or move it first`,
    );
  }
  const decls = parseParamsFromText(original) ?? {};
  const used = new Set<string>();
  for (const m of step.body.matchAll(TOKEN_RE)) {
    const token = m[1].trim();
    if (/^steps\.\d+\.out/.test(token)) {
      problems.push(
        `step ${step.number} uses {{${token}}}, an output of another step the new recipe would not have`,
      );
    } else if (token === "item" || token === "index") {
      problems.push(
        `step ${step.number} uses {{${token}}}, a per-element binding of a map or filter`,
      );
    } else if (decls[token]) {
      used.add(token);
    } else {
      problems.push(
        `step ${step.number} uses {{${token}}}, which "${p.from}" does not declare, so the new recipe could not receive it`,
      );
    }
  }
  if (!step.body.trim()) problems.push(`step ${step.number} has an empty body`);

  // 4. The new recipe: spec, then text.
  const notes: string[] = [];
  const params: Record<string, RecipeParamSpec> = {};
  for (const name of [...used].toSorted()) {
    const spec = { ...decls[name] };
    if (spec.secret && spec.default !== undefined) {
      delete spec.default;
      notes.push(`param "${name}" is secret: its default was not copied`);
    }
    params[name] = spec;
  }
  const fm = frontmatterOf(original);
  const category = typeof fm.category === "string" ? fm.category : undefined;
  // Tags are what the matcher scores a prompt against: a single word scores as much as the threshold on its own, so a
  // derived recipe gets only its slug and its exact title phrase (a phrase scores only when the whole phrase is typed).
  const phrase = p.title.trim().toLowerCase();
  const tags = [...new Set([p.slug, ...(phrase.includes(" ") ? [phrase] : [])])];
  const parentRef = `globalcaos/${declaredSlug(original) ?? p.from}`;
  const childSpec: RecipeSpec = {
    slug: p.slug,
    title: p.title,
    summary: `${p.title}. Step ${step.number} of ${p.from} ("${step.title}") as a recipe of its own.`,
    tags,
    ...(category ? { category } : {}),
    steps: [{ title: step.title, body: step.body }],
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
  let checked = validateRecipeSpec(childSpec);
  if (!checked.ok && childSpec.category) {
    // a parent's category outside the canonical list is not a reason to refuse: the child takes the default
    delete childSpec.category;
    checked = validateRecipeSpec(childSpec);
  }
  if (!checked.ok) problems.push(...checked.errors.map((e) => `new recipe: ${e}`));
  if (problems.length > 0) return refuse(...problems);

  // A slug already in the library is never reused, in any root, and a bare directory of that name is in the way too.
  for (const r of roots) {
    if (await findRecipeFile(r, p.slug))
      return refuse(`a recipe "${p.slug}" already exists (${r}); choose another slug`);
  }
  const childDir = path.join(root, p.slug);
  const childPath = path.join(childDir, "recipe.md");
  try {
    await fs.stat(childDir);
    return refuse(`${childDir} already exists; choose another slug`);
  } catch {
    /* absent, as it should be */
  }

  const childText = injectLineageFrontmatter(buildRecipeMd(childSpec), {
    composedFrom: "extraction",
    composedRecipes: [parentRef],
  });
  const partText = original.slice(step.start, step.end);
  const trailing = /\s*$/.exec(partText.slice(step.headingLen))![0];
  const newParent =
    original.slice(0, step.start) +
    `${partText.slice(0, step.headingLen)}\n\nuses: ${p.slug}${trailing === "" ? "\n" : trailing}` +
    original.slice(step.end);

  // 5. Prove it before anything is written.
  const childRef = `globalcaos/${p.slug}`;
  const resolver =
    (candidateChild: string) =>
    async (ref: string): Promise<string | undefined> => {
      if (ref === childRef) return candidateChild;
      const slug = ref.split("/")[1];
      for (const r of roots) {
        const f = await findRecipeFile(r, slug);
        if (f) return io.readFile(f);
      }
      return undefined;
    };
  const proof = await verifyPair(original, newParent, childText, step, p, params, resolver);
  if (proof.length > 0) return refuse(...proof.map((e) => `would not be faithful: ${e}`));

  // 6. Stage, publish, verify; on any failure put everything back.
  const stamp = o.stamp ?? new Date().toISOString();
  const archiveRoot = o.archiveDir ?? recipeArchiveDir(root);
  const archiveDay = path.join(archiveRoot, stamp.slice(0, 10));
  const archiveFile = path.join(archiveDay, `${p.from}-${stamp.replace(/[:.]/g, "-")}.md`);
  const mode = (await fs.stat(parentPath)).mode & 0o777;
  const tmpTag = `.extract-${process.pid}-${Date.now()}.tmp`;
  const childTmp = path.join(root, `${p.slug}${tmpTag}`);
  const parentTmp = `${parentPath}${tmpTag}`;

  const undo: Array<() => Promise<void>> = [];
  const rollback = async (): Promise<string[]> => {
    const left: string[] = [];
    for (const fn of undo.toReversed()) {
      try {
        await fn();
      } catch (err) {
        left.push(err instanceof Error ? err.message : String(err));
      }
    }
    return left;
  };
  // A staged file that was renamed into place is already gone when its undo runs; that is not a problem.
  const quietUnlink = async (file: string): Promise<void> => {
    try {
      await io.unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  };
  const create = async (file: string, data: string): Promise<void> => {
    await io.createFile(file, data);
    undo.push(() => quietUnlink(file));
  };
  const makeDir = async (dir: string): Promise<void> => {
    await io.mkdir(dir);
    undo.push(() => io.rmdir(dir));
  };
  const ensureDirs = async (dir: string): Promise<void> => {
    try {
      await fs.stat(dir);
      return;
    } catch {
      await ensureDirs(path.dirname(dir));
      await makeDir(dir);
    }
  };

  try {
    await ensureDirs(archiveDay);
    await create(archiveFile, original); // the parent's previous text, append-only
    await create(childTmp, childText);
    await create(parentTmp, newParent);
    await io.chmod(parentTmp, mode);
    // publish: the child first (new; nothing reads it yet), the parent last (one atomic replace)
    await makeDir(childDir);
    await io.rename(childTmp, childPath);
    undo.push(() => quietUnlink(childPath));
    // the parent must still be what the plan was made from
    if ((await io.readFile(parentPath)) !== original)
      throw new Error("the parent changed while the extraction was staged");
    await io.rename(parentTmp, parentPath);
    undo.push(async () => {
      const back = `${parentPath}${tmpTag}.back`;
      await io.createFile(back, original);
      await io.chmod(back, mode);
      await io.rename(back, parentPath);
    });
    // read back what is on disk and prove the pair again
    const gotParent = await io.readFile(parentPath);
    const gotChild = await io.readFile(childPath);
    if (gotParent !== newParent || gotChild !== childText)
      throw new Error("what was written is not what was planned");
    const again = await verifyPair(original, gotParent, gotChild, step, p, params, resolver);
    if (again.length > 0) throw new Error(`read-back check failed: ${again.join("; ")}`);
  } catch (err) {
    const left = await rollback();
    return refuse(
      `extraction failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
      ...(left.length > 0 ? [`rollback left problems: ${left.join("; ")}`] : []),
    );
  }

  const expanded = await expandRecipeSteps(newParent, resolver(childText));
  return {
    ok: true,
    slug: p.slug,
    kitRef: childRef,
    path: childPath,
    parentPath,
    step: step.number,
    stepTitle: step.title,
    paramsMoved: Object.keys(params),
    archive: archiveFile,
    expandedSteps: expanded.length,
    notes,
  };
}

/** Every reason the pair would not behave as the original did. Empty means it would. */
async function verifyPair(
  original: string,
  newParent: string,
  childText: string,
  step: Step,
  p: ExtractParams,
  moved: Record<string, RecipeParamSpec>,
  resolver: (child: string) => (ref: string) => Promise<string | undefined>,
): Promise<string[]> {
  const why: string[] = [];
  // the parent changed in one place only
  const fmEnd = FRONTMATTER_RE.exec(original)?.[0].length ?? 0;
  if (newParent.slice(0, step.start) !== original.slice(0, step.start))
    why.push("the parent's text before the step changed");
  if (!newParent.endsWith(original.slice(step.end)))
    why.push("the parent's text after the step changed");
  if (newParent.slice(0, fmEnd) !== original.slice(0, fmEnd))
    why.push("the parent's frontmatter changed");
  // the same steps, one of them now a reference
  const was = splitSteps(original);
  const now = splitSteps(newParent);
  if (now.length !== was.length) why.push(`the parent has ${now.length} steps, was ${was.length}`);
  was.forEach((s, i) => {
    const n = now[i];
    if (!n) return;
    if (n.number !== s.number || n.title !== s.title)
      why.push(`step ${s.number} changed its number or title`);
    if (i !== step.number - 1 && n.body !== s.body) why.push(`step ${s.number} changed its body`);
  });
  const ref = now[step.number - 1] ? parseUsesDirective(now[step.number - 1].body) : undefined;
  if (ref !== `globalcaos/${p.slug}`) why.push(`step ${step.number} does not reference ${p.slug}`);
  // expanding the reference gives back the original steps
  try {
    const before = await expandRecipeSteps(original, resolver(childText));
    const after = await expandRecipeSteps(newParent, resolver(childText));
    if (!sameJson(before, after)) why.push("the parent no longer expands to the same steps");
  } catch (err) {
    why.push(`expansion failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // the child is the step and only the step
  const child = splitSteps(childText);
  if (child.length !== 1 || child[0].title !== step.title || child[0].body !== step.body) {
    why.push("the new recipe is not exactly the moved step");
  }
  // parameters: each moved one declared with the parent's own spec, and every ref in both recipes declared
  const childDecls = parseParamsFromText(childText) ?? {};
  const parentDecls = parseParamsFromText(original) ?? {};
  for (const name of Object.keys(moved)) {
    const want = { ...parentDecls[name] } as RecipeParamSpec;
    if (want.secret) delete want.default;
    if (!sameJson(childDecls[name], want))
      why.push(`param "${name}" is not declared in the new recipe as in the parent`);
  }
  if (!sameJson(parseParamsFromText(newParent), parentDecls))
    why.push("the parent's parameters changed");
  const childRefs = checkParamRefs(compileSteps(childText), childDecls);
  if (childRefs.length > 0) why.push(...childRefs.map((e) => `new recipe: ${e}`));
  const parentRefs = checkParamRefs(compileSteps(newParent), parentDecls);
  if (parentRefs.length > 0) why.push(...parentRefs.map((e) => `parent: ${e}`));
  return why;
}
