import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import AjvPkg from "ajv";
import { fetch as undiciFetch } from "undici";
import { parse as parseYaml } from "yaml";
import { callGateway } from "../../src/gateway/call.js";
import {
  PrefrontalKitSearchParamsSchema,
  PrefrontalKitGetParamsSchema,
  PrefrontalKitInstallParamsSchema,
  PrefrontalKitPublishParamsSchema,
  PrefrontalKitListParamsSchema,
  PrefrontalKitRunParamsSchema,
  PrefrontalKitAuthorParamsSchema,
  PrefrontalKitComposeParamsSchema,
  PrefrontalKitMatchParamsSchema,
  PrefrontalKitOrchestrateParamsSchema,
  PrefrontalKitReadParamsSchema,
  type PrefrontalKitSearchParams,
  type PrefrontalKitGetParams,
  type PrefrontalKitInstallParams,
  type PrefrontalKitPublishParams,
  type PrefrontalKitListParams,
  type PrefrontalKitRunParams,
  type PrefrontalKitAuthorParams,
  type PrefrontalKitComposeParams,
  type PrefrontalKitMatchParams,
  type PrefrontalKitOrchestrateParams,
  type PrefrontalKitReadParams,
} from "../../src/gateway/protocol/schema/prefrontal-kit.js";
import { createSubsystemLogger } from "../../src/logging/subsystem.js";
import { createEventStore } from "../../src/memory/engram/event-store.js";
import { makeFitnessLookup } from "../../src/memory/engram/recipe-fitness.js";
import { createSkillLibrary } from "../../src/memory/engram/skill-library.js";
import {
  skillMdToRecipeSpec,
  buildBridgedKitMd,
  BRIDGED_SKILLS_DIRNAME,
} from "./cc-skills-bridge.js";
import { surfaceKitOutcome } from "./long-run-surface.js";
import { createProductionOrchestrationRuntime } from "./orchestration-deps.js";
import { runOrchestrationScript } from "./orchestration-script.js";
import { parsePlanMd } from "./plan-store.js";
import {
  applyMutationProposal,
  buildRewritePrompt,
  buildStepRewritePrompt,
  isApplyEnabled,
  type ApplyProposalInput,
} from "./recipe-apply.js";
import { buildRecipeMd, validateRecipeSpec, type RecipeSpec } from "./recipe-author.js";
import {
  bumpVersion,
  makeRatingLookup,
  type Marketplace,
  type SemverBump,
} from "./recipe-marketplace.js";
import {
  loadRecipeIndex,
  matchRecipesDetailed,
  invalidateRecipeIndexCache,
} from "./recipe-matcher.js";
import { optimizeRecipe } from "./recipe-optimize.js";
import { parseRecipeMd, recipeStepProse, firstSentence } from "./recipe-parse.js";
import { parseUsesDirective, resolveRecipeOverlayDir, runRecipe } from "./recipe-runner.js";
import { snapshotKit } from "./recipe-snapshot.js";
import { RecipeStore } from "./recipe-store.js";

const recipeApplyLog = createSubsystemLogger("recipe-apply");

const AjvCtor = AjvPkg as unknown as typeof import("ajv").default;
const ajv = new AjvCtor({ allErrors: true });
const vSearch = ajv.compile(PrefrontalKitSearchParamsSchema);
const vGet = ajv.compile(PrefrontalKitGetParamsSchema);
const vInstall = ajv.compile(PrefrontalKitInstallParamsSchema);
const vPublish = ajv.compile(PrefrontalKitPublishParamsSchema);
const vList = ajv.compile(PrefrontalKitListParamsSchema);
const vRun = ajv.compile(PrefrontalKitRunParamsSchema);
const vAuthor = ajv.compile(PrefrontalKitAuthorParamsSchema);
const vCompose = ajv.compile(PrefrontalKitComposeParamsSchema);
const vMatch = ajv.compile(PrefrontalKitMatchParamsSchema);
const vOrchestrate = ajv.compile(PrefrontalKitOrchestrateParamsSchema);
const vRead = ajv.compile(PrefrontalKitReadParamsSchema);

type Validator = ReturnType<typeof ajv.compile>;

function check<T>(v: Validator, p: unknown, name: string): T {
  if (!v(p))
    throw new Error(
      `${name}: invalid params: ${(v.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ")}`,
    );
  return p as T;
}

/**
 * U1 fitness PRODUCER (seam A) — append ONE `recipe:<owner/slug>` attribution marker
 * into a session's engram event store so sleep-consolidation's attributeRecipe() can
 * credit the episode's outcome to the recipe (the producer that was missing, leaving
 * empirical fitness inert). Direct raw append (it does not flow through the ingestion
 * reconciler) so the marker always lands; a `turnId: 0` system_event with no
 * `[session_start]` content can neither flip inferOutcome (which keys off the LAST
 * event) nor split an episode. Best-effort: a failed append must never break a run.
 */
export function stampRecipeAttribution(
  engramBaseDir: string,
  sessionKey: string,
  recipeTag: string,
): void {
  try {
    createEventStore({ baseDir: engramBaseDir, sessionKey }).append({
      turnId: 0,
      sessionKey,
      kind: "system_event",
      content: `[recipe_attribution] ${recipeTag}`,
      tokens: 0,
      metadata: { tags: [recipeTag] },
    });
  } catch {
    // attribution must never break the run
  }
}

// ─── Canonical kit frontmatter shape ───────────────────────────────────────

interface RecipeFrontmatter {
  schema?: string;
  slug?: string;
  title?: string;
  summary?: string;
  tags?: unknown[];
  category?: string;
  [key: string]: unknown;
}

/**
 * Derive a canonical category from kit frontmatter.
 * Rules (in priority order):
 *  1. Explicit `category` field wins if present.
 *  2. First tag that exactly matches one of the 6 canonical categories.
 *  3. Pattern-match any tag against known keywords.
 *  4. Fall back to "operations".
 */
export function inferCategory(fm: RecipeFrontmatter): string {
  // 1. Explicit category field wins if present
  if (typeof fm.category === "string" && fm.category) return fm.category;

  const canonical = ["coding", "writing", "communication", "analysis", "operations", "security"];
  const tags = (fm.tags ?? []).map((t) => String(t).toLowerCase());

  // 2. First tag that matches one of the 6 canonical categories
  for (const t of tags) if (canonical.includes(t)) return t;

  // 3. Pattern-match tags
  if (tags.some((t) => /(code-review|coding|refactor|tdd|debug|codebase)/.test(t))) return "coding";
  if (tags.some((t) => /(research|analysis|investigation)/.test(t))) return "analysis";
  if (tags.some((t) => /(security|audit|secure)/.test(t))) return "security";
  if (
    tags.some((t) => /(gateway|cron|monitoring|orchestration|deploy|ops|devops|watchdog)/.test(t))
  )
    return "operations";
  if (tags.some((t) => /(write|writing|paper|manuscript|edit|summariz)/.test(t))) return "writing";
  if (tags.some((t) => /(slack|email|discord|telegram|calendar|whatsapp)/.test(t)))
    return "communication";

  return "operations";
}

/** Parsed result from a single kit.md file. */
export interface KitParsed {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  category: string;
}

/**
 * Parse a kit.md file and return the normalized frontmatter fields.
 * Falls back gracefully: missing fields get sensible defaults derived from path.
 */
export async function parseKitMd(filePath: string): Promise<KitParsed> {
  const slugFromPath = path.basename(path.dirname(filePath));
  let slug = slugFromPath;
  let title = slugFromPath;
  let summary = "";
  let tags: string[] = [];
  let category = "operations";

  try {
    const text = await fs.readFile(filePath, "utf-8");
    const fm = /^---\n([\s\S]+?)\n---/.exec(text);
    if (fm) {
      const parsed = parseYaml(fm[1]) as RecipeFrontmatter | null;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.slug === "string" && parsed.slug) slug = parsed.slug;
        if (typeof parsed.title === "string" && parsed.title) title = parsed.title;
        else title = slug;
        if (typeof parsed.summary === "string") summary = parsed.summary;
        if (Array.isArray(parsed.tags))
          tags = (parsed.tags as unknown[]).filter((t) => typeof t === "string") as string[];
        category = inferCategory(parsed);
      }
    }
  } catch {
    // frontmatter parse failure — return slug/empty defaults
  }

  return { slug, title, summary, tags, category };
}

// ─── Frontmatter scalar read/write (U12 version/owner) ───────────────────────

/**
 * Read a single scalar YAML frontmatter field (e.g. `version`, `owner`) from a
 * kit.md. Tolerates quoted (`version: "1.2.3"`) or bare (`owner: globalcaos`)
 * values. Returns undefined when there is no frontmatter or the key is absent.
 */
export function readFrontmatterField(recipeMd: string, key: string): string | undefined {
  const fm = /^---\n([\s\S]+?)\n---/.exec(recipeMd);
  if (!fm) return undefined;
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
  const m = re.exec(fm[1]);
  if (!m) return undefined;
  return m[1].replace(/^["']|["']$/g, "").trim() || undefined;
}

/**
 * Return `recipeMd` with the frontmatter scalar `key` set to `value` (quoted). If the
 * key exists it is replaced in place; if absent it is appended just before the
 * closing `---`. No-op-safe on a doc without frontmatter (returns it unchanged).
 */
export function setFrontmatterField(recipeMd: string, key: string, value: string): string {
  const fm = /^(---\n)([\s\S]+?)(\n---)/.exec(recipeMd);
  if (!fm) return recipeMd;
  const block = fm[2];
  const re = new RegExp(`^${key}:.*$`, "m");
  const line = `${key}: ${JSON.stringify(value)}`;
  const newBlock = re.test(block) ? block.replace(re, line) : `${block}\n${line}`;
  return (
    recipeMd.slice(0, fm.index) + fm[1] + newBlock + fm[3] + recipeMd.slice(fm.index + fm[0].length)
  );
}

// ─── Own-kits walker ────────────────────────────────────────────────────────

interface OwnKitEntry {
  owner: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  category: string;
  path: string;
  source: "ours";
}

/**
 * Walk `ownRecipesDir/<slug>/{recipe.md,kit.md}` and return parsed entries.
 * Layout: `<slug>/recipe.md` (new canonical) or `<slug>/kit.md` (legacy) — one
 * level deep, slug is the immediate child dir. DUAL-READ: recipe.md is probed
 * first per slug-dir, kit.md is the legacy fallback.
 */
async function listOwnKits(ownRecipesDir: string): Promise<OwnKitEntry[]> {
  const out: OwnKitEntry[] = [];
  let slugDirs: string[];
  try {
    slugDirs = await fs.readdir(ownRecipesDir);
  } catch {
    return out;
  }
  await Promise.all(
    slugDirs.map(async (dirName) => {
      let kitMdPath = "";
      for (const fname of ["recipe.md", "kit.md"]) {
        const candidate = path.join(ownRecipesDir, dirName, fname);
        try {
          await fs.access(candidate);
          kitMdPath = candidate;
          break;
        } catch {
          // try next filename
        }
      }
      if (!kitMdPath) {
        return; // not a recipe directory
      }
      const parsed = await parseKitMd(kitMdPath);
      out.push({
        owner: "globalcaos",
        slug: parsed.slug || dirName,
        title: parsed.title,
        summary: parsed.summary,
        tags: parsed.tags,
        category: parsed.category,
        path: kitMdPath,
        source: "ours",
      });
    }),
  );
  // Sort for deterministic ordering
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

// ─── Shared kit-write (guarded) + recipe-rewrite spawn ──────────────────────

/**
 * Validate + persist a RecipeSpec to the own-kits dir, enforcing the authorship guard: an existing
 * kit is only overwritten when it carries `authoredBy: jarvis-*` AND overwrite is true. Hand-
 * curated kits are NEVER clobbered. Shared by the prefrontal.recipe.author RPC and the J5
 * self-apply loop so the guard lives in ONE place. Throws on invalid spec or guard violation.
 */
export async function persistKitSpec(
  spec: RecipeSpec,
  ownRecipesDir: string,
  overwrite: boolean,
): Promise<{ slug: string; path: string; replaced: boolean; note: string }> {
  const v = validateRecipeSpec(spec);
  if (!v.ok) {
    throw new Error(`invalid spec — ${v.errors.join("; ")}`);
  }
  const recipeMd = buildRecipeMd(spec);
  const dir = path.join(ownRecipesDir, spec.slug);
  // New authored recipes are written as recipe.md (canonical). DUAL-READ: the
  // curated-overwrite guard must still see a legacy kit.md for the same slug, so
  // the existence check probes recipe.md FIRST then kit.md.
  const target = path.join(dir, "recipe.md");
  let existed = false;
  let existingText = "";
  for (const fname of ["recipe.md", "kit.md"]) {
    try {
      existingText = await fs.readFile(path.join(dir, fname), "utf-8");
      existed = true;
      break;
    } catch {
      // try next filename
    }
  }
  if (existed) {
    // Never clobber a hand-curated, version-controlled kit. Only kits authored by this fork
    // (authoredBy: jarvis-*) are overwritable, and only with explicit overwrite.
    const isAuthored = /authoredBy:\s*["']?jarvis/i.test(existingText);
    if (!isAuthored) {
      throw new Error(
        `"${spec.slug}" is a curated kit — refusing to overwrite. Pick a different slug.`,
      );
    }
    if (!overwrite) {
      throw new Error(
        `authored kit "${spec.slug}" already exists — pass overwrite:true to replace it`,
      );
    }
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(target, recipeMd, "utf-8");
  invalidateRecipeIndexCache(); // next turn's matcher re-scans the catalog
  return {
    slug: spec.slug,
    path: target,
    replaced: existed,
    note: existed ? `overwrote existing kit "${spec.slug}"` : `authored new kit "${spec.slug}"`,
  };
}

/**
 * SS3: build a traversal-safe, validateRecipeSpec-valid slug (`^[a-z0-9][a-z0-9-]{1,63}$`)
 * from a free-text compose query. Always prefixed `composed-` so it starts with a
 * letter and never collides with a hand-curated single-word slug.
 */
export function composeSlug(query: string): string {
  const base = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = `composed-${base}`.slice(0, 64).replace(/-+$/g, "");
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(slug) ? slug : "composed-recipe";
}

/**
 * Spawn a one-shot subagent to rewrite a recipe and return its final text. Mirrors the
 * overseer/curiosity spawn → wait → history pattern. Returns undefined on any failure so the
 * self-apply loop falls back to keeping the original recipe. Never throws.
 */
async function spawnRecipeRewrite(task: string): Promise<string | undefined> {
  try {
    const spawn = await callGateway<{ ok?: boolean; childSessionKey?: string; runId?: string }>({
      method: "fork.subagents.spawn",
      params: {
        task,
        label: "recipe-evolve",
        parentSessionKey: "agent:main:main",
        runTimeoutSeconds: 90,
        expectsCompletionMessage: false,
      },
      timeoutMs: 100_000,
    });
    if (!spawn?.ok || !spawn.childSessionKey || !spawn.runId) return undefined;
    const wait = await callGateway<{ status?: "ok" | "timeout" | "error" }>({
      method: "agent.wait",
      params: { runId: spawn.runId, timeoutMs: 90_000 },
      timeoutMs: 95_000,
    });
    if (wait?.status === "error" || wait?.status === "timeout") return undefined;
    const hist = await callGateway<{ messages?: Array<{ role?: string; content?: unknown }> }>({
      method: "chat.history",
      params: { sessionKey: spawn.childSessionKey, limit: 30 },
      timeoutMs: 10_000,
    });
    const msgs = Array.isArray(hist?.messages) ? hist.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role !== "assistant") continue;
      const c = msgs[i]?.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .map((b) =>
                  typeof (b as { text?: unknown })?.text === "string"
                    ? (b as { text: string }).text
                    : "",
                )
                .join("")
            : "";
      return text.trim() ? text : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ─── RPC deps + factory ─────────────────────────────────────────────────────

export interface KitRpcsDeps {
  store: RecipeStore;
  baseUrl: string;
  apiKey: string | null;
  recipeInstallSandbox: string;
  ownRecipesDir: string;
  /** Optional plan store — required for prefrontal.kit.run in live mode */
  // oxlint-disable-next-line typescript-eslint/no-explicit-any
  planStore?: any;
  /**
   * FORK 2026-06-01 (U12): the recipe marketplace facade (recipe-marketplace.ts).
   * When wired, publish bumps + immutability-checks against it and get/install
   * resolve a version-constraint through it. Omitted → version logic is skipped
   * (back-compat: publish POSTs the kit verbatim, get/install pass ref straight
   * to Journey), so a marketplace-less deploy keeps working.
   */
  marketplace?: Marketplace;
  /**
   * FORK 2026-06-01 (U12): the identity that may publish/overwrite kits. Used for
   * the publish owner-permission check (a kit whose frontmatter `owner:` differs
   * is refused). Default "globalcaos".
   */
  currentOwner?: string;
  /**
   * FORK 2026-06-01 (Wire-seam 5): injectable Journey JSON fetch seam. Defaults to
   * the undici-backed implementation built in the factory. Mirrors recipe-
   * marketplace's injectable MarketplaceFetch so the RPCs are unit-testable
   * offline; production passes nothing and gets the real network path.
   */
  fetchJsonImpl?: (p: string, init?: Parameters<typeof undiciFetch>[1]) => Promise<unknown>;
  /**
   * FORK 2026-06 (U1): engram base dir for the on-disk recipe-fitness store. When
   * supplied, prefrontal.recipe.match + the recipe.search local fallback fold each
   * candidate's empirical-fitness boost into the score (via makeFitnessLookup),
   * matching the turn-start seed in index.ts. Omitted → pure lexical scoring
   * (back-compat: a fitness-less deploy / offline test keeps working).
   */
  engramBaseDir?: string;
}

// ─── BROCA visibility (2026-06-06): recipe.read return contract ──────────────
// These interfaces mirror tinker-ui/src/panels/broca.ts VERBATIM — the UI is
// coded against these exact keys. Keep in sync with the panel.
interface BrocaPort {
  name: string;
  from: string;
}
interface BrocaStep {
  n: number;
  title: string;
  prose?: string;
  skillId?: string;
  usesKitRef?: string;
  ins?: BrocaPort[];
  out?: unknown;
  when?: string;
  returns?: boolean;
}
interface BrocaRecipe {
  slug: string;
  title: string;
  summary?: string;
  category?: string;
  signature?: string;
  steps: BrocaStep[];
  lineage?: {
    composedFrom?: string;
    composedSkills?: string[];
    composedRecipes?: string[];
    sourceQuery?: string;
  };
}

/**
 * Extract the optional lineage block from a recipe's frontmatter (the nested
 * `lineage:` shape recipe-snapshot.injectLineageFrontmatter stamps). Returns
 * undefined when absent/malformed.
 */
function extractLineage(md: string): BrocaRecipe["lineage"] | undefined {
  const fm = /^---\n([\s\S]+?)\n---/.exec(md);
  if (!fm) return undefined;
  let obj: Record<string, unknown> | null = null;
  try {
    obj = parseYaml(fm[1]) as Record<string, unknown> | null;
  } catch {
    return undefined;
  }
  const l = obj?.lineage;
  if (!l || typeof l !== "object") return undefined;
  const ln = l as Record<string, unknown>;
  const out: NonNullable<BrocaRecipe["lineage"]> = {};
  if (typeof ln.composedFrom === "string") out.composedFrom = ln.composedFrom;
  if (typeof ln.sourceQuery === "string") out.sourceQuery = ln.sourceQuery;
  if (Array.isArray(ln.composedSkills))
    out.composedSkills = ln.composedSkills.filter((x): x is string => typeof x === "string");
  if (Array.isArray(ln.composedRecipes))
    out.composedRecipes = ln.composedRecipes.filter((x): x is string => typeof x === "string");
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createRecipeRpcs(deps: KitRpcsDeps) {
  const fetchJson =
    deps.fetchJsonImpl ??
    (async (p: string, init?: Parameters<typeof undiciFetch>[1]) => {
      const headers: Record<string, string> = {
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
        Accept: "application/json",
      };
      if (deps.apiKey) headers.Authorization = `Bearer ${deps.apiKey}`;
      const res = await undiciFetch(`${deps.baseUrl}${p}`, { ...init, headers });
      if (!res.ok) throw new Error(`Journey ${p} -> ${res.status} ${res.statusText}`);
      return res.json();
    });

  // FORK 2026-06-01 (U11): bridged CC-skill imports land under the install
  // sandbox in a dedicated dir (BRIDGED_SKILLS_DIRNAME). The matcher scans it via
  // loadRecipeIndex's extraDirs so imported recipes become matchable. One source of
  // truth for the name lives in cc-skills-bridge.ts.
  const bridgedSkillsDir = path.join(deps.recipeInstallSandbox, BRIDGED_SKILLS_DIRNAME);

  // FORK 2026-06 (U1) + 2026-06-01 (U12): build the matcher's empirical-fitness +
  // marketplace-rating lookups for the local-match RPCs (recipe.match + the
  // recipe.search local fallback). Built FRESH per call so a fitness write between
  // calls is reflected (makeFitnessLookup memoizes only within one lookup). Returns
  // `{}` (no lookups) when neither seam is wired, so an offline test / fitness-less
  // deploy keeps pure-lexical scoring. Mirrors the index.ts turn-start seed wiring.
  const buildMatchSignals = (): {
    feedback?: (slug: string) => number | undefined;
    rating?: (slug: string) => number | undefined;
  } => ({
    ...(deps.engramBaseDir ? { feedback: makeFitnessLookup(deps.engramBaseDir) } : {}),
    ...(deps.marketplace ? { rating: makeRatingLookup(deps.marketplace) } : {}),
  });

  /**
   * FORK 2026-06-01 (U12): resolve an optional `ref` to a concrete published
   * version when (a) a marketplace is wired and (b) ref looks like a version
   * constraint. Returns the raw ref unchanged when no marketplace, no ref, or the
   * marketplace cannot resolve it (so non-version refs and marketplace-less
   * deploys are untouched). Never throws.
   */
  const resolveRef = async (
    kitRef: string,
    ref: string | undefined,
  ): Promise<string | undefined> => {
    if (!deps.marketplace || !ref) return ref;
    try {
      const resolved = await deps.marketplace.resolveVersion(kitRef, ref);
      return resolved ?? ref;
    } catch {
      return ref;
    }
  };

  /**
   * FORK 2026-06-01 (U11): bridge ONE Claude-Code SKILL.md into a recipe/1.0 and
   * write it (sandboxed) into the bridged-skills dir. Reuses the existing
   * cc-skills-bridge transpiler + the buildRecipeMd/validateRecipeSpec guards (no fork).
   * Throws on a malformed skill BEFORE any write (validation lives in
   * skillMdToRecipeSpec). Returns the slug + on-disk path.
   */
  const bridgeSkill = async (skillMd: string): Promise<{ slug: string; path: string }> => {
    const spec = skillMdToRecipeSpec(skillMd); // throws on malformed skill (pre-write)
    const v = validateRecipeSpec(spec);
    if (!v.ok) {
      throw new Error(`cc-skills-bridge: transpiled spec is invalid — ${v.errors.join("; ")}`);
    }
    const md = buildBridgedKitMd(spec);
    const dir = path.join(bridgedSkillsDir, spec.slug);
    await fs.mkdir(dir, { recursive: true });
    // Bridged imports are our-authored content → recipe.md (canonical). The
    // matcher dual-reads, so a legacy bridged kit.md still loads.
    const target = path.join(dir, "recipe.md");
    await fs.writeFile(target, md, "utf-8");
    invalidateRecipeIndexCache(); // matcher re-scans (incl. bridgedSkillsDir) next turn
    return { slug: spec.slug, path: target };
  };

  /**
   * Split a declared dependency ref into its `owner/slug` and an optional trailing
   * `@<constraint>` (e.g. `globalcaos/foo@^1.2.0` → ["globalcaos/foo", "^1.2.0"]).
   * A dep with no `@` carries no declared constraint (→ undefined), which the
   * installer resolves as `latest`. Bare slugs normalize to `globalcaos/<slug>`.
   */
  const splitDepRef = (raw: string): { ref: string; constraint: string | undefined } => {
    const at = raw.indexOf("@");
    const refPart = at >= 0 ? raw.slice(0, at) : raw;
    const constraint = at >= 0 ? raw.slice(at + 1).trim() || undefined : undefined;
    const ref = refPart.includes("/") ? refPart : `globalcaos/${refPart}`;
    return { ref, constraint };
  };

  /**
   * FORK 2026-06-01 (U11): transitive dependency resolver for recipe.install.
   * After a kit is written, parse its kit.md for the two composition kinds a
   * recipe declares its deps with — frontmatter `composes: [slug, ...]` (merged
   * sub-recipes) and a leading `uses: <ref>` directive in any step body (runtime
   * sub-kit) — and install each one, recursively. Cycle-guarded by the `seen` set
   * (a ref already installed this call is never re-fetched), so a → b → a
   * terminates. Bare slugs normalize to `globalcaos/<slug>` (matching the runner's
   * parseUsesDirective contract). Each dep resolves with its OWN declared
   * constraint (a trailing `@<constraint>` on the composes/uses ref) or `latest` —
   * the root's `p.ref` constraint is NEVER inherited by a transitive dep. Returns
   * the flat set of dependency refs written.
   */
  const installDeps = async (
    rootRef: string,
    installOne: (ref: string, constraint: string | undefined) => Promise<string[] | void>,
    seen: Set<string>,
  ): Promise<string[]> => {
    const installed: string[] = [];
    const [owner, slug] = rootRef.split("/");
    let recipeMd: string;
    try {
      const target = deps.store.resolveSandboxPath(owner, slug, "kit.md");
      recipeMd = await fs.readFile(target, "utf-8");
    } catch {
      return installed; // nothing written / unreadable → no deps to resolve
    }

    // Each dep carries its OWN declared version constraint (from `@<constraint>`),
    // not the root install's constraint.
    const deps2: Array<{ ref: string; constraint: string | undefined }> = [];
    // 1) frontmatter composes: [...]
    const fm = /^---\n([\s\S]+?)\n---\n/.exec(recipeMd);
    if (fm) {
      try {
        const parsed = parseYaml(fm[1]) as Record<string, unknown> | null;
        if (parsed && Array.isArray(parsed.composes)) {
          for (const c of parsed.composes) {
            if (typeof c === "string" && c.trim()) {
              deps2.push(splitDepRef(c.trim()));
            }
          }
        }
      } catch {
        // malformed frontmatter — skip composes, still try uses below
      }
    }
    // 2) `uses: <ref>` directives in step bodies (reuse the runner's parser).
    const body = fm ? recipeMd.slice(fm[0].length) : recipeMd;
    for (const part of body.split(/(?=^#{1,6}\s+\d+\.\s+)/m)) {
      const stepBody = part.replace(/^#{1,6}\s+\d+\.\s+.*$/m, "").trim();
      const usesRef = parseUsesDirective(stepBody);
      if (usesRef) deps2.push({ ref: usesRef, constraint: undefined });
    }

    for (const dep of deps2) {
      if (seen.has(dep.ref)) continue; // cycle / already-installed guard
      seen.add(dep.ref);
      await installOne(dep.ref, dep.constraint);
      installed.push(dep.ref);
      // Recurse into the dep's OWN deps.
      const sub = await installDeps(dep.ref, installOne, seen);
      installed.push(...sub);
    }
    return installed;
  };

  return {
    "prefrontal.recipe.search": async (raw: unknown) => {
      const p = check<PrefrontalKitSearchParams>(vSearch, raw, "prefrontal.recipe.search");
      try {
        const j: any = await fetchJson(
          `/api/kits/search?q=${encodeURIComponent(p.query)}${p.limit ? `&limit=${p.limit}` : ""}`,
        );
        // Journey API returns a flat array; guard against wrapped {results:[...]} shape too
        const arr: any[] = Array.isArray(j) ? j : (j.results ?? []);
        // Dedupe by kitRef — keep the entry with the highest releaseTag (semver string compare)
        const seen = new Map<string, any>();
        for (const r of arr) {
          const k = r.kitRef;
          if (!k) continue;
          const cur = seen.get(k);
          if (!cur || (r.releaseTag ?? "") > (cur.releaseTag ?? "")) seen.set(k, r);
        }
        return { results: [...seen.values()], source: "journey" as const };
      } catch (err) {
        // FORK 2026-06-01 (U11): Journey unreachable → degrade to the LOCAL catalog
        // (same Risk-7 graceful-degradation posture as the marketplace) instead of
        // hard-failing the search. The local matcher scores the query against the
        // own-kits catalog (+ bridged imports) so a network outage still surfaces
        // the recipes Jarvis already has. Never throws on the fallback path.
        const index = await loadRecipeIndex(deps.ownRecipesDir, [bridgedSkillsDir]);
        // FORK 2026-06 (U1) + 2026-06-01 (U12): same fitness+rating signals as the
        // turn-start seed so the local fallback ranks proven/popular recipes higher.
        const { matches } = matchRecipesDetailed(p.query, index, {
          max: p.limit ?? 10,
          ...buildMatchSignals(),
        });
        return {
          results: matches.map((m) => ({
            kitRef: `globalcaos/${m.entry.slug}`,
            slug: m.entry.slug,
            title: m.entry.title,
            summary: m.entry.summary,
            score: m.score,
            source: "local" as const,
          })),
          source: "local" as const,
          fallbackReason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    "prefrontal.recipe.get": async (raw: unknown) => {
      const p = check<PrefrontalKitGetParams>(vGet, raw, "prefrontal.recipe.get");
      // FORK 2026-06-01 (U12): when a marketplace is wired AND ref is a version
      // constraint (range/latest/exact), resolve it to a concrete published version
      // first so the fetch pins a real release. resolveVersion never throws (Risk 7
      // degrades to cache/null); a null resolution falls through to the raw ref so
      // a non-version ref (e.g. a git sha) still works.
      const ref = await resolveRef(p.kitRef, p.ref);
      const j: any = await fetchJson(
        `/api/kits/${p.kitRef}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
      );
      return { kit: j };
    },

    "prefrontal.recipe.install": async (raw: unknown) => {
      const p = check<PrefrontalKitInstallParams>(vInstall, raw, "prefrontal.recipe.install");

      // FORK 2026-06-01 (U11): CC SKILL.md import path. When `skillMd` is provided,
      // transpile it to a recipe/1.0 and write it into the bridged-skills dir
      // instead of fetching from Journey. Malformed skills throw before any write.
      if (typeof p.skillMd === "string" && p.skillMd.trim()) {
        const { slug, path: writtenPath } = await bridgeSkill(p.skillMd);
        return {
          ok: true,
          bridged: true,
          slug,
          installedPath: writtenPath,
          preflightResults: [],
          nextSteps: [],
        } as const;
      }

      // ── Journey install path (with transitive dep resolution) ────────────────
      // FORK 2026-06-01 (U12): resolve a version-constraint to a concrete release
      // before fetching the install payload (marketplace-less → ref passes through).
      const seen = new Set<string>([p.kitRef]);

      // installOne: fetch + risk-gate + sandboxed write for a single ref. Shared by
      // the root install and the transitive dep walk so the risk gate + sandbox
      // write apply uniformly. `constraint` is the version constraint THIS ref
      // resolves with — the root passes p.ref; each transitive dep passes its OWN
      // declared constraint (or undefined → latest), so the root's pin never leaks
      // onto a sub-recipe. Returns nothing; writes to disk.
      let rootInstall: any = null;
      const installOne = async (kitRef: string, constraint: string | undefined): Promise<void> => {
        const ref = (await resolveRef(kitRef, constraint)) ?? "latest";
        const install: any = await fetchJson(
          `/api/kits/${kitRef}/install?target=openclaw&ref=${encodeURIComponent(ref)}`,
        );
        const risk: Array<{ source: string; level: string; alertCount?: number }> =
          install.risk ?? [];
        const blocking = risk.find((r) => r.level === "Critical" || r.level === "High Risk");
        if (blocking && !p.allowRisky) {
          throw new Error(
            `prefrontal.kit.install refused: kit ${kitRef} reports ${blocking.level} (${blocking.source}, alerts=${blocking.alertCount ?? "?"}). Re-run with allowRisky:true to override.`,
          );
        }
        const [owner, slug] = kitRef.split("/");
        await deps.store.writeKitFiles({ owner, slug, files: install.files ?? [] });
        if (kitRef === p.kitRef) rootInstall = install;
      };

      // Root install: ONLY the root kitRef honours the caller's p.ref constraint.
      await installOne(p.kitRef, p.ref);
      // Resolve + install transitive composes:/uses: dependencies (cycle-guarded);
      // each dep resolves with its own declared constraint, not the root's p.ref.
      const dependenciesInstalled = await installDeps(p.kitRef, installOne, seen);
      invalidateRecipeIndexCache(); // newly written kits are matchable next turn

      const install = rootInstall ?? {};
      const [owner, slug] = p.kitRef.split("/");
      const preflightResults: Array<{ check: string; ok: boolean; output: string }> = [];
      for (const pf of install.preflightChecks ?? []) {
        preflightResults.push({
          check: typeof pf === "string" ? pf : (pf.cmd ?? JSON.stringify(pf)),
          ok: false,
          output: "preflight execution not wired in this build",
        });
      }

      return {
        ok: true,
        installedPath: `${deps.recipeInstallSandbox}/${owner}/${slug}`,
        dependenciesInstalled,
        preflightResults,
        nextSteps: install.nextSteps ?? [],
      } as const;
    },

    "prefrontal.recipe.list": async (raw: unknown) => {
      const p = check<PrefrontalKitListParams>(vList, raw, "prefrontal.recipe.list");

      // ── Downloaded kits (existing path) ──────────────────────────────────
      const downloadedEntries = await deps.store.list({ owner: p.owner });
      const downloadedKits = await Promise.all(
        downloadedEntries.map(async (e) => {
          const parsed = await parseKitMd(e.path);
          return {
            kitRef: `${e.owner}/${e.slug}`,
            owner: e.owner,
            slug: e.slug,
            title: parsed.title || e.slug,
            summary: parsed.summary,
            tags: parsed.tags,
            category: parsed.category,
            source: "downloaded" as const,
            path: e.path,
          };
        }),
      );

      // ── Source-tree (own) kits — skip if owner filter set (not ours) ──────
      let ownKits: ReturnType<typeof listOwnKits> extends Promise<infer T> ? T : never = [];
      if (!p.owner || p.owner === "globalcaos") {
        ownKits = await listOwnKits(deps.ownRecipesDir);
      }
      const ownKitsMapped = ownKits.map((e) => ({
        kitRef: `${e.owner}/${e.slug}`,
        owner: e.owner,
        slug: e.slug,
        title: e.title,
        summary: e.summary,
        tags: e.tags,
        category: e.category,
        source: "ours" as const,
        path: e.path,
      }));

      // ── Merge: our kits first, then downloaded ────────────────────────────
      const kits = [...ownKitsMapped, ...downloadedKits];
      return { kits };
    },

    "prefrontal.recipe.read": async (raw: unknown) => {
      const p = check<PrefrontalKitReadParams>(vRead, raw, "prefrontal.recipe.read");
      const slug = p.slug ?? (p.kitRef ? p.kitRef.split("/")[1] : undefined);

      // Resolve a LOCAL recipe md (ours, then downloaded), mirroring recipe.list.
      let md: string | null = null;
      if (typeof p.path === "string" && p.path.trim()) {
        try {
          md = await fs.readFile(p.path, "utf-8");
        } catch {
          md = null;
        }
      }
      if (md === null && slug) {
        // OVERLAY-FIRST: an edited copy under ~/.openclaw/recipes/<slug>/ shadows the
        // git-tracked default, so the BROCA/UI panel reads the user's edited recipe.
        for (const fname of ["recipe.md", "kit.md"]) {
          try {
            md = await fs.readFile(path.join(resolveRecipeOverlayDir(), slug, fname), "utf-8");
            break;
          } catch {
            // try next filename / fall through to the git-tracked default
          }
        }
      }
      if (md === null && slug) {
        // DUAL-READ: recipe.md (canonical) then kit.md (legacy), under ownRecipesDir.
        for (const fname of ["recipe.md", "kit.md"]) {
          try {
            md = await fs.readFile(path.join(deps.ownRecipesDir, slug, fname), "utf-8");
            break;
          } catch {
            // try next filename / fall through to downloaded
          }
        }
      }
      if (md === null && (p.kitRef || slug)) {
        try {
          const owner = p.kitRef ? p.kitRef.split("/")[0] : undefined;
          const entries = await deps.store.list(owner ? { owner } : {});
          const match = entries.find((e) =>
            p.kitRef ? `${e.owner}/${e.slug}` === p.kitRef : e.slug === slug,
          );
          if (match) md = await fs.readFile(match.path, "utf-8");
        } catch {
          // downloaded lookup failed — fall through to Journey
        }
      }

      if (md !== null) {
        const spec = parseRecipeMd(md);
        const steps: BrocaStep[] = spec.steps.map((st, i) => {
          const proseRaw = st.doneWhen ?? firstSentence(recipeStepProse(st.body));
          const usesKitRef = parseUsesDirective(st.body);
          const step: BrocaStep = { n: i + 1, title: st.title };
          if (proseRaw && proseRaw.trim()) step.prose = proseRaw.trim();
          if (st.invokeSkill) step.skillId = st.invokeSkill;
          if (usesKitRef) step.usesKitRef = usesKitRef;
          if (st.in) step.ins = st.in.map((port) => ({ name: port.name, from: port.from }));
          if (st.out !== undefined) step.out = st.out;
          if (st.when) step.when = st.when;
          if (st.earlyExit) step.returns = true;
          return step;
        });
        const recipe: BrocaRecipe = { slug: spec.slug, title: spec.title, steps };
        if (spec.summary) recipe.summary = spec.summary;
        if (spec.category) recipe.category = spec.category;
        const lineage = extractLineage(md);
        if (lineage) recipe.lineage = lineage;
        return { recipe };
      }

      // Fallback: not a local recipe → Journey recipe.get (same path recipe.get uses).
      if (!p.kitRef) {
        throw new Error(
          "prefrontal.recipe.read: no local recipe for the given slug/path and no kitRef to fetch from Journey",
        );
      }
      const ref = await resolveRef(p.kitRef, undefined);
      const kit: any = await fetchJson(
        `/api/kits/${p.kitRef}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
      );
      return { recipe: kit };
    },

    "prefrontal.recipe.publish": async (raw: unknown) => {
      const p = check<PrefrontalKitPublishParams>(vPublish, raw, "prefrontal.recipe.publish");
      if (!deps.apiKey)
        throw new Error(
          "prefrontal.recipe.publish: missing apiKey (set integrations.journey.apiKey in openclaw.json)",
        );
      // DUAL-READ: a recipe def is recipe.md (canonical) or kit.md (legacy).
      let body = "";
      {
        let readErr: unknown;
        for (const fname of ["recipe.md", "kit.md"]) {
          try {
            body = await fs.readFile(path.join(deps.ownRecipesDir, p.slug, fname), "utf-8");
            readErr = undefined;
            break;
          } catch (err) {
            readErr = err;
          }
        }
        if (readErr) throw readErr;
      }

      // FORK 2026-06-01 (U12): versioning + immutability + owner permission. The
      // publish becomes the place recipe-as-artifact semantics are enforced:
      //   1. OWNER check — refuse to publish a kit whose frontmatter `owner:`
      //      differs from the publishing identity (currentOwner, default
      //      "globalcaos"). Stops accidentally re-publishing someone else's recipe.
      //   2. VERSION bump — read the frontmatter `version:` and bump it per `level`
      //      (default patch). A missing/garbage version starts the chain at 1.0.0.
      //   3. IMMUTABILITY — if a marketplace is wired and the BUMPED version is
      //      already published (hasVersion), refuse: versions are immutable, a bad
      //      recipe is yanked + re-bumped, never overwritten in place.
      const owner = readFrontmatterField(body, "owner") ?? "globalcaos";
      const me = deps.currentOwner ?? "globalcaos";
      if (owner !== me) {
        throw new Error(
          `prefrontal.recipe.publish: owner permission denied — "${p.slug}" is owned by "${owner}", not "${me}".`,
        );
      }

      const currentVersion = readFrontmatterField(body, "version");
      const level: SemverBump = p.level ?? "patch";
      let nextVersion: string;
      if (currentVersion === undefined) {
        // No version at all → this is the recipe's FIRST publish; start the chain
        // at 1.0.0 (same as the garbage/unparseable path below).
        nextVersion = "1.0.0";
      } else {
        try {
          nextVersion = bumpVersion(currentVersion, level);
        } catch {
          // Unparseable existing version → start a clean chain at 1.0.0.
          nextVersion = "1.0.0";
        }
      }

      const kitRef = `${owner}/${p.slug}`;
      if (deps.marketplace && (await deps.marketplace.hasVersion(kitRef, nextVersion))) {
        throw new Error(
          `prefrontal.recipe.publish: ${kitRef}@${nextVersion} is already published — versions are immutable (yank + re-bump instead of overwriting).`,
        );
      }

      // Rewrite the frontmatter `version:` line to the bumped value (in-memory; the
      // on-disk kit.md is the source of truth and stays at the author's edit).
      const bumpedKitMd = setFrontmatterField(body, "version", nextVersion);

      const j: any = await fetchJson(`/api/kits/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          slug: p.slug,
          visibility: p.visibility,
          orgId: p.orgId,
          version: nextVersion,
          recipeMd: bumpedKitMd,
        }),
      });
      // Pre-seed the marketplace cache so a later resolve sees the new version.
      try {
        deps.marketplace?.recordMarketplaceCache({
          kitRef,
          versions: [nextVersion],
        });
      } catch {}
      return { ...(j && typeof j === "object" ? j : {}), version: nextVersion, kitRef };
    },

    "prefrontal.recipe.run": async (raw: unknown) => {
      const p = check<PrefrontalKitRunParams>(vRun, raw, "prefrontal.recipe.run");

      // SS3: the stdlib skill library an `invoke skill:` step resolves against —
      // the SAME on-disk engram library the fork.skill.* RPCs read (so a skill
      // deposited via compose/extraction is invocable here). Read-only in the
      // runner; outcomes route back via onSkillOutcome → fork.skill.recordOutcome.
      // Needed at SEED time too: compileSteps lifts a skill's outputSchema so the
      // port-wiring check validates downstream `in:` ports (also in dry-run).
      // SS4/U1: ONE engram base dir for this run so the skill library, the
      // recipe-fitness PRODUCER (onTag, below) and the fitnessSuccessRate CONSUMER
      // (runRecipe, below) all hit the SAME on-disk store the gateway ingests turn
      // events into — co-locating the attribution marker with the run's episode.
      const engramBaseDir =
        deps.engramBaseDir ??
        path.join(process.env.OPENCLAW_HOME ?? homedir(), ".openclaw", "engram");
      const skillLibrary = createSkillLibrary({ baseDir: engramBaseDir });

      // SS1 follow-up (U1 fitness CONSUMER): fold the recipe's empirical success
      // rate into runRecipe so the J16-derived re-dispatch + recovery budgets respond
      // to how reliable THIS recipe has been. Keyed by the full owner/slug kitRef —
      // the same id recipe-fitness.attributeRecipe stores under. undefined (no record
      // / no engram) → the runner's neutral 0.5 default (back-compat).
      const fitnessSuccessRate = makeFitnessLookup(engramBaseDir)(p.kitRef);

      if (p.dryRun) {
        // Dry-run: return the dispatch plan without spawning anything.
        const result = await runRecipe({
          kitRef: p.kitRef,
          sessionKey: p.sessionKey,
          intent: p.intent,
          parameters: p.parameters,
          dryRun: true,
          ownRecipesDir: deps.ownRecipesDir,
          recipeInstallSandbox: deps.recipeInstallSandbox,
          skillLibrary,
          fitnessSuccessRate,
        });
        return {
          ok: result.ok,
          planId: result.planId,
          dryRun: true,
          dryRunPlan: result.dryRunPlan,
          errorMessage: result.errorMessage,
        };
      }

      // Live mode: runRecipe seeds the plan synchronously then dispatches subagents
      // in the background. We await only the plan seed, then let dispatch continue
      // asynchronously. The plan board in TUI reflects live step progress.
      //
      // We wrap in a Promise that resolves after the plan is seeded (first async
      // boundary inside runRecipe) by running the full kit in background and
      // returning immediately with the planId from a pre-seeded plan.
      const runResult = await runRecipe({
        kitRef: p.kitRef,
        sessionKey: p.sessionKey,
        intent: p.intent,
        parameters: p.parameters,
        dryRun: false,
        planStore: deps.planStore,
        ownRecipesDir: deps.ownRecipesDir,
        recipeInstallSandbox: deps.recipeInstallSandbox,
        skillLibrary,
        fitnessSuccessRate,
        // FORK 2026-05-30 (Upgrade 5): durable checkpointing. Auto-resume an
        // interrupted in_progress plan only when resume:true is explicitly passed
        // (no silent re-attach — the architect's policy). `resume` is now part of
        // PrefrontalKitRunParamsSchema, so the defensive cast is gone.
        resume: p.resume === true,
        // FORK 2026-05-30 (Upgrade 5): forward in-flight checkpoint heartbeats so a
        // long-polling step is observably alive in the recipe trail. Same loopback
        // callGateway + fire-and-forget pattern as onRecipeState above — a stalled
        // heartbeat never blocks or fails the run. (Wire-seam 4.)
        onCheckpoint: (ev) => {
          void callGateway({
            method: "fork.prefrontal.trailEvent",
            params: {
              kind: "checkpoint",
              label: `${p.kitRef}:step-${ev.stepIndex}`,
              message: `step ${ev.stepIndex + 1} still running (${Math.round(ev.elapsedMs / 1000)}s)`,
              sessionKey: ev.sessionKey,
              payload: {
                recipeId: p.kitRef,
                stepIndex: ev.stepIndex,
                elapsedMs: ev.elapsedMs,
              },
            },
          }).catch(() => {});
        },
        // FORK 2026-05-31: forward live recipe-state to the RECIPES panel via the
        // setRecipe broadcast RPC (same loopback callGateway pattern as
        // surfaceKitOutcome below). Fire-and-forget — observability never blocks
        // or fails the run. This is the producer half of the dull-panel fix: the
        // recipe-runner was previously silent, so the rich recipe header never had a
        // data source and the panel always fell back to "Thinking → Acting".
        onRecipeState: (state) => {
          void callGateway({
            method: "fork.prefrontal.setRecipe",
            params: {
              recipeId: state.recipeId,
              step: state.step,
              totalSteps: state.totalSteps,
              stepName: state.stepName,
              parallelismCap: state.parallelismCap,
              inFlightLabels: state.inFlightLabels,
              sessionKey: state.sessionKey,
              // BROCA visibility (2026-06-06): forward the per-turn id + the current
              // step's skill so the panel can scope + color the composition.
              turnId: state.turnId,
              skillId: state.skillId,
            },
          }).catch(() => {});
        },
        // FORK 2026-06 (Upgrade 1): recipe-ATTRIBUTION producer. recipe-runner stamps a
        // `recipe:<owner/slug>` TagStamp at run start AND at each task dispatch; we
        // forward each one to the engram trail/ingestion seam (same loopback
        // callGateway + fire-and-forget pattern as onRecipeState/onCheckpoint above).
        // The tag rides into the run's episode events so recipe-fitness.attributeRecipe()
        // can attribute the episode's outcome to this recipe at consolidation — the
        // missing producer that left empirical fitness inert. Never blocks/fails the run.
        onTag: (ev) => {
          void callGateway({
            method: "fork.prefrontal.trailEvent",
            params: {
              kind: "recipe-tag",
              label: ev.tag,
              message:
                ev.phase === "start"
                  ? `recipe attribution ${ev.tag}`
                  : `recipe attribution ${ev.tag} (step ${(ev.stepIndex ?? 0) + 1})`,
              sessionKey: ev.sessionKey,
              payload: {
                recipeTag: ev.tag,
                phase: ev.phase,
                ...(typeof ev.stepIndex === "number" ? { stepIndex: ev.stepIndex } : {}),
                // The canonical attribution tag the cerebellum reads off episode
                // events (recipe-fitness.attributeRecipe matches `recipe:` prefix).
                tags: [ev.tag],
              },
            },
          }).catch(() => {});
          // U1 fitness PRODUCER (seam A): the trail event above is observability-only
          // and never reached the engram event store — which is why empirical fitness
          // stayed inert. On run START, append ONE attribution marker into THIS
          // session's engram store so the tag rides into the run's episode and
          // recipe-fitness.attributeRecipe() can credit the episode outcome to this
          // recipe at consolidation. Once per run (start only); best-effort.
          if (ev.phase === "start") {
            stampRecipeAttribution(engramBaseDir, ev.sessionKey, ev.tag);
          }
        },
        // SS1: forward typed-output schema-mismatch re-dispatch trails to the
        // prefrontal trail (same loopback + fire-and-forget pattern as the sinks
        // above) so a validation failure + its correction attempts are observable,
        // never silent. Wire-seam for SS1's "no silent failure" guarantee.
        onTrail: (ev) => {
          void callGateway({
            method: "fork.prefrontal.trailEvent",
            params: {
              kind: ev.kind,
              label: ev.label,
              message: ev.message,
              sessionKey: ev.sessionKey,
              payload: ev.payload,
            },
          }).catch(() => {});
        },
        // SS3: skill-fitness loopback — a skill step's terminal outcome routes to
        // fork.skill.recordOutcome so the library's Laplace fitness compounds with
        // real use. Same loopback callGateway + fire-and-forget pattern as above.
        onSkillOutcome: (skillId, success) => {
          void callGateway({
            method: "fork.skill.recordOutcome",
            params: { skillId, success },
          }).catch(() => {});
        },
        // OVERSEER keep-going wire: when the overseer loop decides the run isn't
        // done, re-prompt the (possibly idle) parent session to drive Jarvis
        // onward. Same loopback callGateway + fire-and-forget pattern as the sinks
        // above — a stalled re-prompt never blocks or fails the run. The message
        // IS prefixed with the ⟦OVERSEER⟧ marker so it renders as the electric-blue
        // right-anchored Overseer bubble. This targets the run's own internal
        // session (the Tinker-UI chat), so marking it is safe and the
        // fire-and-forget contract is unchanged.
        onKeepGoing: (sessionKey, message) => {
          void callGateway({
            method: "sessions.send",
            params: { key: sessionKey, message: `⟦OVERSEER⟧ ${message}` },
          }).catch(() => {});
        },
      });

      // Surface progress/completion back into the (possibly closed) parent turn.
      // Only worth doing when the run actually produced step results.
      if (runResult.results && runResult.results.length > 0) {
        void surfaceKitOutcome(
          {
            sessionKey: p.sessionKey,
            kitRef: p.kitRef,
            ok: runResult.ok,
            results: runResult.results,
          },
          { callGateway: (args) => callGateway(args as Parameters<typeof callGateway>[0]) },
        ).catch(() => {});
      }

      return {
        ok: runResult.ok,
        planId: runResult.planId,
        errorMessage: runResult.errorMessage,
        results: runResult.results,
        note: runResult.ok ? "kit runner completed; check plan board for step results" : undefined,
      };
    },

    // SS0 (2026-06-04): run a Jarvis-authored orchestration script natively over
    // the A1 runtime (agent/parallel/pipeline/phase) — the native replacement for
    // the borrowed Claude Code Workflow tool. Same trust boundary as recipe.run:
    // Jarvis's own self-hosted gateway, a single trusted principal; the script runs
    // with Jarvis's privileges (NOT a sandbox, by design). RESTART-UNVERIFIED — the
    // production spawn path (orchestration-deps) mirrors reasoning-runtime.ts and is
    // type-clean but awaits a live-restart smoke test.
    "prefrontal.recipe.orchestrate": async (raw: unknown) => {
      const p = check<PrefrontalKitOrchestrateParams>(
        vOrchestrate,
        raw,
        "prefrontal.recipe.orchestrate",
      );
      const runtime = createProductionOrchestrationRuntime({
        callGateway,
        parentSessionKey: p.sessionKey,
        onPhase: (title) => {
          void callGateway({
            method: "fork.prefrontal.setRecipe",
            params: {
              recipeId: p.label ?? "orchestrate",
              stepName: title,
              sessionKey: p.sessionKey,
            },
          }).catch(() => {});
        },
      });
      const logs: string[] = [];
      const result = await runOrchestrationScript(runtime, p.script, p.args, (message) => {
        logs.push(message);
        void callGateway({
          method: "fork.prefrontal.trailEvent",
          params: { kind: "orchestrate-log", message, sessionKey: p.sessionKey },
        }).catch(() => {});
      });
      return { ok: true, result, logs };
    },

    // FORK 2026-05-29: compose a recipe on the fly. Validates the spec, builds a
    // kit/1.0 doc, and writes it to the own-kits dir so the turn-start matcher
    // picks it up immediately. This is the NO-MATCH escape hatch — Jarvis turns a
    // recipe gap into a reusable recipe in one call.
    // SS3 (2026-06-04): mechanically compose a recipe from stdlib skills. Search the
    // skill library for `query`, emit ONE `invoke skill:` step per hit in rank order,
    // then validate + persist as an authored recipe (buildRecipeMd stamps
    // authoredBy: jarvis-* so the authorship guard allows it). Deterministic +
    // testable with a stubbed fork.skill.search; LLM-override is a later additive (O3).
    "prefrontal.recipe.compose": async (raw: unknown) => {
      const p = check<PrefrontalKitComposeParams>(vCompose, raw, "prefrontal.recipe.compose");
      const k = p.k ?? 4;
      // Loopback re-negotiates scopes (does NOT inherit) — fork.skill.* default-deny
      // to admin, so pass operator.admin (single trusted principal, same as spawn).
      const hits = await callGateway<{ skills?: Array<{ skillId: string; name?: string }> }>({
        method: "fork.skill.search",
        params: { query: p.query, k },
        scopes: ["operator.admin"],
      });
      const skills = (hits?.skills ?? []).slice(0, k);
      if (skills.length === 0) {
        return { ok: false, note: `compose: no matching skills for "${p.query}"` };
      }
      const spec: RecipeSpec = {
        slug: composeSlug(p.query),
        title: `composed: ${p.query}`.slice(0, 120),
        summary: `Auto-composed from ${skills.length} stdlib skill(s) for: ${p.query}`,
        tags: ["composed", ...p.query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4)],
        steps: skills.map((s) => ({
          title: s.name ?? s.skillId,
          invokeSkill: s.skillId,
          body: `Apply skill ${s.skillId} to the task.`,
        })),
      };
      const v = validateRecipeSpec(spec);
      if (!v.ok) {
        return { ok: false, note: `compose: invalid spec: ${v.errors.join("; ")}` };
      }
      let r: { slug: string; path: string; replaced: boolean };
      try {
        // overwrite:true — a re-compose of the same query updates its own authored
        // recipe (never clobbers a hand-curated kit; the guard enforces that).
        r = await persistKitSpec(spec, deps.ownRecipesDir, true);
      } catch (err) {
        return {
          ok: false,
          note: `compose: persist failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // SS3 (O2): snapshot the composed recipe with lineage in the FRONTMATTER (the
      // never-delete archive = reversibility + provenance). Best-effort.
      try {
        await snapshotKit(
          deps.ownRecipesDir,
          r.slug,
          buildRecipeMd(spec),
          new Date().toISOString(),
          {
            composedFrom: "compose",
            sourceQuery: p.query,
            composedSkills: skills.map((s) => s.skillId),
          },
        );
      } catch {
        // snapshot is provenance, never blocks the compose result
      }
      return {
        ok: true,
        slug: r.slug,
        kitRef: `globalcaos/${r.slug}`,
        composedSkills: skills.map((s) => s.skillId),
      };
    },

    "prefrontal.recipe.author": async (raw: unknown) => {
      const p = check<PrefrontalKitAuthorParams>(vAuthor, raw, "prefrontal.recipe.author");
      const spec = p as unknown as RecipeSpec;
      // Guarded write (validate + authorship-guard + persist) lives in persistKitSpec.
      let r: { slug: string; path: string; replaced: boolean };
      try {
        r = await persistKitSpec(spec, deps.ownRecipesDir, p.overwrite === true);
      } catch (err) {
        throw new Error(
          `prefrontal.kit.author: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return {
        ok: true,
        slug: r.slug,
        kitRef: `globalcaos/${r.slug}`,
        path: r.path,
        stepCount: spec.steps.length,
        replaced: r.replaced,
        note: r.replaced
          ? `overwrote existing kit "${r.slug}"`
          : `authored new kit "${r.slug}" — matchable on the next turn`,
      };
    },

    // FORK 2026-05-31: J5 self-apply — apply ONE autoPromotable recipe-evolution proposal.
    // Snapshot the current recipe (rollback net) → LLM rewrites it applying the op+intent →
    // validate → guarded write (persistKitSpec, which refuses hand-curated kits). Gated by
    // RECIPE_AUTOAPPLY_ENABLED; never throws into the caller (returns a typed result).
    "prefrontal.recipe.applyProposal": async (raw: unknown) => {
      const p = (raw ?? {}) as {
        recipeId?: unknown;
        op?: unknown;
        intent?: unknown;
        rationale?: unknown;
      };
      if (typeof p.recipeId !== "string" || !p.recipeId.trim()) {
        throw new Error("prefrontal.recipe.applyProposal: recipeId (non-empty string) required");
      }
      if (!isApplyEnabled()) {
        return { ok: true, applied: false, reason: "disabled" };
      }
      const input: ApplyProposalInput = {
        recipeId: p.recipeId,
        op: typeof p.op === "string" ? p.op : "tighten_criteria",
        intent: typeof p.intent === "string" ? p.intent : "",
        rationale: typeof p.rationale === "string" ? p.rationale : "",
      };
      const result = await applyMutationProposal(input, {
        loadKitText: async (slug) => {
          // DUAL-READ: recipe.md (canonical) then kit.md (legacy).
          for (const fname of ["recipe.md", "kit.md"]) {
            try {
              const target = path.join(deps.ownRecipesDir, slug, fname);
              const text = await fs.readFile(target, "utf-8");
              return { path: target, text };
            } catch {
              // try next filename
            }
          }
          return null;
        },
        snapshot: (slug, text) =>
          snapshotKit(deps.ownRecipesDir, slug, text, new Date().toISOString()),
        rewrite: (currentText, op, intent) =>
          spawnRecipeRewrite(buildRewritePrompt(currentText, op, intent)),
        authorKit: async (spec) => {
          try {
            const r = await persistKitSpec(spec, deps.ownRecipesDir, true);
            return { ok: true, note: r.note };
          } catch (err) {
            return { ok: false, note: err instanceof Error ? err.message : String(err) };
          }
        },
        log: {
          info: (m) => recipeApplyLog.info(m),
          warn: (m) => recipeApplyLog.warn(m),
        },
      });
      // FORK 2026-05-31: surface the autonomous recipe rewrite in the RECIPES
      // panel decision trail (apply on success, reject on any skip reason), so the
      // unsupervised self-edit loop is legible instead of RPC-only. Fire-and-forget
      // via the trailEvent RPC; never blocks or fails the proposal.
      try {
        void callGateway({
          method: "fork.prefrontal.trailEvent",
          params: result.applied
            ? {
                kind: "recipe-apply",
                label: result.recipeId,
                message: `rewrote ${result.recipeId} (${input.op})`,
                payload: {
                  recipeId: result.recipeId,
                  applied: true,
                  op: input.op,
                  ...(result.archivePath ? { archivePath: result.archivePath } : {}),
                },
              }
            : {
                kind: "recipe-reject",
                label: result.recipeId,
                message: `declined ${result.recipeId} rewrite — ${result.reason}`,
                payload: {
                  recipeId: result.recipeId,
                  applied: false,
                  reason: result.reason,
                },
              },
        }).catch(() => {});
      } catch {}
      return { ok: true, ...result };
    },

    // SS4 (2026-06-06): the self-sharpening RPC. Read this recipe's LIVE plan archive
    // → per-step struggle → propose a rewrite_step_text per struggling step → apply
    // each ONLY when RECIPE_AUTOAPPLY_ENABLED (proposes-only by default). Mirrors
    // applyProposal: snapshot-reversible, authorship-guarded, validate-or-skip;
    // patch version bump. Never throws into the caller.
    "prefrontal.recipe.optimize": async (raw: unknown) => {
      const p = (raw ?? {}) as { kitRef?: unknown };
      if (typeof p.kitRef !== "string" || !p.kitRef.trim()) {
        throw new Error("prefrontal.recipe.optimize: kitRef (non-empty string) required");
      }
      const kitRef = p.kitRef.trim();
      const slug = kitRef.includes("/") ? kitRef.split("/")[1] : kitRef;

      const result = await optimizeRecipe(kitRef, {
        // Read the plan archive for THIS recipe: scan archive/<date>/*.md under the
        // plan-store root, parse each, keep those whose frontmatter kitRef matches.
        readArchivedPlans: async () => {
          if (!deps.planStore) return [];
          const plans: import("../../src/gateway/protocol/schema/prefrontal-plan.js").Plan[] = [];
          const archiveRoot = path.join(deps.planStore.rootDirPublic(), "archive");
          let dateDirs: string[] = [];
          try {
            dateDirs = await fs.readdir(archiveRoot);
          } catch {
            return [];
          }
          for (const date of dateDirs) {
            let files: string[] = [];
            try {
              files = await fs.readdir(path.join(archiveRoot, date));
            } catch {
              continue;
            }
            for (const f of files) {
              if (!f.endsWith(".md")) continue;
              try {
                const text = await fs.readFile(path.join(archiveRoot, date, f), "utf-8");
                const plan = parsePlanMd(text);
                if (plan.kitRef === kitRef) plans.push(plan);
              } catch {
                // skip an unreadable / malformed archive file
              }
            }
          }
          return plans;
        },
        baseVersion: await (async () => {
          // Read the current version from the kit frontmatter (default 1 for bumping).
          for (const fname of ["recipe.md", "kit.md"]) {
            try {
              const text = await fs.readFile(path.join(deps.ownRecipesDir, slug, fname), "utf-8");
              const v = readFrontmatterField(text, "version");
              const major = v ? parseInt(v.split(".")[0], 10) : 1;
              return Number.isFinite(major) ? major : 1;
            } catch {
              // try next filename
            }
          }
          return 1;
        })(),
        applyProposal: async (input) =>
          applyMutationProposal(input, {
            loadKitText: async (s) => {
              for (const fname of ["recipe.md", "kit.md"]) {
                try {
                  const target = path.join(deps.ownRecipesDir, s, fname);
                  const text = await fs.readFile(target, "utf-8");
                  return { path: target, text };
                } catch {
                  // try next filename
                }
              }
              return null;
            },
            snapshot: (s, text) =>
              snapshotKit(deps.ownRecipesDir, s, text, new Date().toISOString()),
            rewrite: async () => undefined, // unused on the step path
            rewriteStep: (stepBody, stepTitle, dominantKind, message) =>
              spawnRecipeRewrite(
                buildStepRewritePrompt(stepBody, stepTitle, dominantKind, message),
              ),
            authorKit: async (spec) => {
              try {
                // SS4: patch version bump on a step-text sharpening (immutable history).
                const r = await persistKitSpec(spec, deps.ownRecipesDir, true);
                try {
                  const target = path.join(deps.ownRecipesDir, spec.slug, "recipe.md");
                  const text = await fs.readFile(target, "utf-8");
                  const cur = readFrontmatterField(text, "version") ?? "1.0.0";
                  const bumped = setFrontmatterField(text, "version", bumpVersion(cur, "patch"));
                  await fs.writeFile(target, bumped, "utf-8");
                } catch {
                  // version-bump is best-effort; the rewrite itself already persisted
                }
                return { ok: true, note: r.note };
              } catch (err) {
                return { ok: false, note: err instanceof Error ? err.message : String(err) };
              }
            },
            log: { info: (m) => recipeApplyLog.info(m), warn: (m) => recipeApplyLog.warn(m) },
          }),
      });

      // Surface the optimize pass in the RECIPES panel decision trail (best-effort).
      try {
        void callGateway({
          method: "fork.prefrontal.trailEvent",
          params: {
            kind: result.applied.length > 0 ? "recipe-optimize" : "recipe-optimize-proposed",
            label: kitRef,
            message:
              result.applied.length > 0
                ? `sharpened ${result.applied.filter((a) => a.applied).length} step(s) of ${kitRef}`
                : `proposed ${result.proposed.length} step rewrite(s) for ${kitRef} (apply OFF)`,
            payload: {
              kitRef,
              proposed: result.proposed.length,
              applied: result.applied.filter((a) => a.applied).length,
              strugglingStepIndexes: result.struggleBefore.strugglingStepIndexes,
            },
          },
        }).catch(() => {});
      } catch {}

      return { ok: true, ...result };
    },

    // FORK 2026-05-29: LLM-free best-fit lookup. Returns ranked local-catalog
    // candidates + a confidence so the caller can decide use-vs-author.
    "prefrontal.recipe.match": async (raw: unknown) => {
      const p = check<PrefrontalKitMatchParams>(vMatch, raw, "prefrontal.recipe.match");
      // FORK 2026-06-01 (U11): include bridged CC-skill imports in the match catalog.
      const index = await loadRecipeIndex(deps.ownRecipesDir, [bridgedSkillsDir]);
      // FORK 2026-06 (U1) + 2026-06-01 (U12): fold empirical-fitness + marketplace-
      // rating into the score so recipe.match returns the same proven/popular-aware
      // ranking the turn-start seed uses (single scoring policy across both seams).
      const { matches, confidence } = matchRecipesDetailed(p.prompt, index, {
        max: p.limit ?? 5,
        ...buildMatchSignals(),
      });
      return {
        confidence,
        catalogSize: index.length,
        recommendAuthor: matches.length === 0,
        matches: matches.map((m) => ({
          kitRef: `globalcaos/${m.entry.slug}`,
          slug: m.entry.slug,
          title: m.entry.title,
          summary: m.entry.summary,
          score: m.score,
          composes: m.entry.composes,
        })),
      };
    },
  } as const;
}
