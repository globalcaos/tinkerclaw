/**
 * FORK 2026-06-01: prefrontal/cc-skills-bridge — import a Claude-Code SKILL.md
 * as a kit/1.0 recipe (Upgrade 11, external recipe acquisition).
 *
 * Journey kits are already a near-native fetch (`kit-rpcs.ts` search/install).
 * Claude-Code skills are a DIFFERENT shape — `SKILL.md` (YAML frontmatter
 * `name`/`description` + a documented procedure in the body) plus loose scripts.
 * This adapter reads that SKILL.md, infers an ordered step list from the body,
 * and transpiles it to a `KitSpec`, which is then run through the EXISTING
 * `kit-author.ts` validators (`validateKitSpec` + `buildKitMd`) so the
 * phantom-step and slug-traversal guards apply for free. We do NOT fork those
 * validators.
 *
 * Trust posture (see improvement_notes U11 risk a): bridged recipes are marked
 * `authoredBy: "cc-bridge"` so they are distinguishable / low-trust vs the
 * curated `globalcaos/*` set. We retag the buildKitMd output rather than fork
 * buildKitMd.
 *
 * Symlink-safety (risk b / Risk 6): `KitStore.resolveSandboxPath` blocks `../`
 * but NOT symlinks. Imported content is untrusted, so any SKILL.md path we read
 * from disk must be vetted with `assertNoSymlink` first — a symlinked SKILL.md
 * (or a symlinked component anywhere in its path) is rejected, never followed.
 *
 * Pure transpile here (no fs except the symlink probe): `skillMdToKitSpec` +
 * `buildBridgedKitMd` are unit-testable. The recipe.install RPC (Wire phase)
 * does the sandboxed write via `KitStore.writeKitFiles` and scans the
 * `BRIDGED_SKILLS_DIRNAME` dir into the matcher index.
 *
 * See bible subagents-and-recipes.md (recipe/1.0 spec + sandbox enforcement).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { buildKitMd, type KitSpec, type KitStepSpec } from "./kit-author.js";

/** Authorship tag stamped on every bridged recipe (low-trust / distinguishable). */
export const BRIDGED_AUTHORED_BY = "cc-bridge";

/**
 * Sub-directory (under the kit install sandbox) where bridged SKILL.md imports
 * land. The Wire phase adds this to `kit-matcher.ts loadKitIndex`'s scan set so
 * imported recipes become matchable; keeping the name here gives both sides one
 * source of truth.
 */
export const BRIDGED_SKILLS_DIRNAME = "bridged-skills";

const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n/;

/**
 * Step-heading forms a CC SKILL.md commonly documents a procedure with:
 *   "### 1. Title"           (canonical kit form)
 *   "### Step 1 - Title"     (graphify-style)
 *   "### Step 1: Title"
 *   "## 2) Title"
 * The leading number is captured for ordering; the trailing text is the title.
 */
const STEP_HEADING_RE = /^#{1,6}\s+(?:step\s+)?(\d+)\s*[.):-]\s+(.+?)\s*$/gim;

/**
 * Convert a SKILL.md `name` into a traversal-safe kit slug. We only lowercase,
 * collapse whitespace/underscores to single hyphens, and drop everything that
 * is not `[a-z0-9-]`. We deliberately DO NOT try to "rescue" a name like
 * `../../etc` into something safe-looking — the final slug is re-checked by
 * `validateKitSpec`'s SLUG_RE, and a name that can't produce a valid slug
 * throws (so a malicious name can never silently become a different dir).
 */
function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Title-case a slug-ish name into a human kit title (fallback when no `# H1`). */
function humanizeName(name: string): string {
  const cleaned = name.trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
    .trim();
}

/**
 * Derive matcher tags from the skill's name + description. The matcher scores
 * against `tags`, so we seed it with the name tokens and a few description
 * keywords; `buildKitMd` folds these (lowercased, deduped) into the frontmatter.
 */
function deriveTags(name: string, description: string, trigger?: string): string[] {
  const tags = new Set<string>();
  const add = (raw: string) => {
    const v = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");
    if (v.length >= 3) tags.add(v);
  };
  for (const tok of name.split(/[\s_-]+/)) add(tok);
  if (trigger) for (const tok of trigger.replace(/^\//, "").split(/[\s_-]+/)) add(tok);
  for (const tok of description.split(/[\s.,;:()/-]+/).slice(0, 12)) add(tok);
  // Always tag the provenance so bridged recipes are filterable.
  tags.add(BRIDGED_AUTHORED_BY);
  return [...tags];
}

/**
 * Extract the body section after the frontmatter, then split it into ordered
 * steps using STEP_HEADING_RE. The text BETWEEN one step heading and the next
 * becomes that step's body. Numbering drives the order (headings may be `0`-based
 * like graphify's `Step 0`, which we normalise to a contiguous 1..N sequence).
 */
function inferStepsFromBody(body: string): KitStepSpec[] {
  // Capture each heading's match-start (line start of the "### …" line) and the
  // offset just after the heading line (where the step body begins).
  const headings: Array<{ num: number; title: string; headingAt: number; bodyAt: number }> = [];
  STEP_HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STEP_HEADING_RE.exec(body)) !== null) {
    headings.push({
      num: parseInt(m[1], 10),
      title: m[2].trim(),
      headingAt: m.index,
      bodyAt: m.index + m[0].length,
    });
  }
  if (headings.length === 0) return [];

  // They are captured in document order; a step's body runs from just after its
  // heading line to the start of the next heading line (or end of body).
  return headings.map((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].headingAt : body.length;
    const stepBody = body.slice(h.bodyAt, end).trim();
    return {
      title: h.title,
      // A step must have a non-empty body to pass validateKitSpec; fall back to
      // the title as a one-line instruction when the skill documented only a
      // heading (still executable, just terse).
      body: stepBody || `Perform: ${h.title}`,
    };
  });
}

/**
 * Transpile a Claude-Code SKILL.md (frontmatter + documented procedure) into a
 * KitSpec. Throws on a malformed skill (no frontmatter, missing name/description,
 * no inferable steps, or a name that can't yield a traversal-safe slug) so the
 * caller never writes a non-recipe to disk. The returned spec is NOT yet
 * validated against `validateKitSpec` — callers MUST run it through that (and
 * `buildBridgedKitMd`) before persisting, matching kit-author's split.
 */
export function skillMdToKitSpec(skillMdText: string): KitSpec {
  if (typeof skillMdText !== "string" || !skillMdText.trim()) {
    throw new Error("cc-skills-bridge: empty SKILL.md");
  }
  const fm = FRONTMATTER_RE.exec(skillMdText);
  if (!fm) {
    throw new Error("cc-skills-bridge: SKILL.md has no YAML frontmatter (--- … ---)");
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = parseYaml(fm[1]) as Record<string, unknown> | null;
  } catch (err) {
    throw new Error(
      `cc-skills-bridge: SKILL.md frontmatter is not valid YAML: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("cc-skills-bridge: SKILL.md frontmatter did not parse to an object");
  }

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  const trigger = typeof parsed.trigger === "string" ? parsed.trigger.trim() : undefined;

  if (!name) throw new Error("cc-skills-bridge: SKILL.md frontmatter missing `name`");
  if (!description) {
    throw new Error("cc-skills-bridge: SKILL.md frontmatter missing `description`");
  }

  // Reject path-traversal / separator characters in the name OUTRIGHT rather
  // than silently sanitizing them away — `../../etc/passwd` must error, not
  // quietly become slug `etcpasswd` (which would mask intent and could collide
  // with a curated owner/slug). The slug is the on-disk dir name (Risk 6).
  if (/[\\/]|\.\./.test(name)) {
    throw new Error(
      `cc-skills-bridge: SKILL.md name ${JSON.stringify(name)} contains path-traversal characters — refusing to derive a slug`,
    );
  }

  const slug = slugifyName(name);
  if (!slug) {
    throw new Error(
      `cc-skills-bridge: SKILL.md name ${JSON.stringify(name)} did not yield a safe slug`,
    );
  }

  const body = skillMdText.slice(fm[0].length);
  const steps = inferStepsFromBody(body);
  if (steps.length === 0) {
    throw new Error(
      "cc-skills-bridge: no numbered procedure / steps found in SKILL.md body (need `### N. …` or `### Step N - …` headings)",
    );
  }

  // Prefer the body's own `# H1` for a nicer title, else humanize the name.
  const h1 = /^#\s+(.+?)\s*$/m.exec(body);
  const title = h1 ? h1[1].trim() : humanizeName(name);

  return {
    slug,
    title,
    summary: description,
    tags: deriveTags(name, description, trigger),
    category: "operations",
    steps,
  };
}

/**
 * Build the kit/1.0 markdown for a bridged spec, reusing `buildKitMd` and then
 * retagging `authoredBy` from kit-author's default ("jarvis-on-the-fly") to
 * `cc-bridge` so the provenance is honest. We retag the single frontmatter line
 * rather than fork buildKitMd.
 */
export function buildBridgedKitMd(spec: KitSpec): string {
  const md = buildKitMd(spec);
  return md.replace(/^authoredBy:.*$/m, `authoredBy: ${JSON.stringify(BRIDGED_AUTHORED_BY)}`);
}

/**
 * Reject a path whose final component (or any ancestor) is a symbolic link.
 * Imported SKILL.md content is untrusted; `resolveSandboxPath` stops `../` but a
 * symlink could still point outside the sandbox / at sensitive files. We probe
 * with `lstat` (which does NOT follow the link) on every path segment from the
 * importing root down to the file, and throw if any is a symlink. Callers pass
 * the absolute path of the SKILL.md they are about to read/import.
 */
export async function assertNoSymlink(absPath: string, stopAt?: string): Promise<void> {
  if (!path.isAbsolute(absPath)) {
    throw new Error(`cc-skills-bridge: assertNoSymlink needs an absolute path: ${absPath}`);
  }
  const resolvedStop = stopAt ? path.resolve(stopAt) : path.parse(absPath).root;
  let cur = path.resolve(absPath);
  // Walk the leaf and each ancestor up to (but not including) the stop boundary.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      st = await fs.lstat(cur);
    } catch {
      // Missing intermediate dir: nothing to follow there, keep walking up.
      const parent = path.dirname(cur);
      if (parent === cur || cur === resolvedStop) break;
      cur = parent;
      continue;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`cc-skills-bridge: refusing to follow symlink in import path: ${cur}`);
    }
    const parent = path.dirname(cur);
    if (cur === resolvedStop || parent === cur) break;
    cur = parent;
  }
}
