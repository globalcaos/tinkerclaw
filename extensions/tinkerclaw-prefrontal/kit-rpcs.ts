import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
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
  PrefrontalKitMatchParamsSchema,
  type PrefrontalKitSearchParams,
  type PrefrontalKitGetParams,
  type PrefrontalKitInstallParams,
  type PrefrontalKitPublishParams,
  type PrefrontalKitListParams,
  type PrefrontalKitRunParams,
  type PrefrontalKitAuthorParams,
  type PrefrontalKitMatchParams,
} from "../../src/gateway/protocol/schema/prefrontal-kit.js";
import { buildKitMd, validateKitSpec, type KitSpec } from "./kit-author.js";
import { loadKitIndex, matchKitsDetailed, invalidateKitIndexCache } from "./kit-matcher.js";
import { runKit } from "./kit-runner.js";
import { KitStore } from "./kit-store.js";
import { surfaceKitOutcome } from "./long-run-surface.js";

const ajv = new Ajv({ allErrors: true });
const vSearch = ajv.compile(PrefrontalKitSearchParamsSchema);
const vGet = ajv.compile(PrefrontalKitGetParamsSchema);
const vInstall = ajv.compile(PrefrontalKitInstallParamsSchema);
const vPublish = ajv.compile(PrefrontalKitPublishParamsSchema);
const vList = ajv.compile(PrefrontalKitListParamsSchema);
const vRun = ajv.compile(PrefrontalKitRunParamsSchema);
const vAuthor = ajv.compile(PrefrontalKitAuthorParamsSchema);
const vMatch = ajv.compile(PrefrontalKitMatchParamsSchema);

type Validator = ReturnType<typeof ajv.compile>;

function check<T>(v: Validator, p: unknown, name: string): T {
  if (!v(p))
    throw new Error(
      `${name}: invalid params: ${(v.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ")}`,
    );
  return p as T;
}

// ─── Canonical kit frontmatter shape ───────────────────────────────────────

interface KitFrontmatter {
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
export function inferCategory(fm: KitFrontmatter): string {
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
      const parsed = parseYaml(fm[1]) as KitFrontmatter | null;
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
 * Walk `ownKitsDir/<slug>/kit.md` and return parsed entries.
 * Layout: `kits/<slug>/kit.md` (one level deep — slug is the immediate child dir).
 */
async function listOwnKits(ownKitsDir: string): Promise<OwnKitEntry[]> {
  const out: OwnKitEntry[] = [];
  let slugDirs: string[];
  try {
    slugDirs = await fs.readdir(ownKitsDir);
  } catch {
    return out;
  }
  await Promise.all(
    slugDirs.map(async (dirName) => {
      const kitMdPath = path.join(ownKitsDir, dirName, "kit.md");
      try {
        await fs.access(kitMdPath);
      } catch {
        return; // not a kit directory
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

// ─── RPC deps + factory ─────────────────────────────────────────────────────

export interface KitRpcsDeps {
  store: KitStore;
  baseUrl: string;
  apiKey: string | null;
  kitInstallSandbox: string;
  ownKitsDir: string;
  /** Optional plan store — required for prefrontal.kit.run in live mode */
  // oxlint-disable-next-line typescript-eslint/no-explicit-any
  planStore?: any;
}

export function createKitRpcs(deps: KitRpcsDeps) {
  const fetchJson = async (p: string, init?: Parameters<typeof undiciFetch>[1]) => {
    const headers = new Headers((init?.headers as Record<string, string>) ?? undefined);
    headers.set("Accept", "application/json");
    if (deps.apiKey) headers.set("Authorization", `Bearer ${deps.apiKey}`);
    const res = await undiciFetch(`${deps.baseUrl}${p}`, { ...init, headers });
    if (!res.ok) throw new Error(`Journey ${p} -> ${res.status} ${res.statusText}`);
    return res.json();
  };

  return {
    "prefrontal.recipe.search": async (raw: unknown) => {
      const p = check<PrefrontalKitSearchParams>(vSearch, raw, "prefrontal.recipe.search");
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
      return { results: [...seen.values()] };
    },

    "prefrontal.recipe.get": async (raw: unknown) => {
      const p = check<PrefrontalKitGetParams>(vGet, raw, "prefrontal.recipe.get");
      const j: any = await fetchJson(
        `/api/kits/${p.kitRef}${p.ref ? `?ref=${encodeURIComponent(p.ref)}` : ""}`,
      );
      return { kit: j };
    },

    "prefrontal.recipe.install": async (raw: unknown) => {
      const p = check<PrefrontalKitInstallParams>(vInstall, raw, "prefrontal.recipe.install");
      const ref = p.ref ?? "latest";
      const install: any = await fetchJson(
        `/api/kits/${p.kitRef}/install?target=openclaw&ref=${encodeURIComponent(ref)}`,
      );

      const risk: Array<{ source: string; level: string; alertCount?: number }> =
        install.risk ?? [];
      const blocking = risk.find((r) => r.level === "Critical" || r.level === "High Risk");
      if (blocking && !p.allowRisky) {
        throw new Error(
          `prefrontal.kit.install refused: kit ${p.kitRef} reports ${blocking.level} (${blocking.source}, alerts=${blocking.alertCount ?? "?"}). Re-run with allowRisky:true to override.`,
        );
      }

      const [owner, slug] = p.kitRef.split("/");
      await deps.store.writeKitFiles({ owner, slug, files: install.files ?? [] });

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
        installedPath: `${deps.kitInstallSandbox}/${owner}/${slug}`,
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
        ownKits = await listOwnKits(deps.ownKitsDir);
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

    "prefrontal.recipe.publish": async (raw: unknown) => {
      const p = check<PrefrontalKitPublishParams>(vPublish, raw, "prefrontal.recipe.publish");
      if (!deps.apiKey)
        throw new Error(
          "prefrontal.recipe.publish: missing apiKey (set integrations.journey.apiKey in openclaw.json)",
        );
      const pathP = await import("node:path");
      const kitMdPath = pathP.join(deps.ownKitsDir, p.slug, "kit.md");
      const body = await fs.readFile(kitMdPath, "utf-8");
      const res = await undiciFetch(`${deps.baseUrl}/api/kits/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          slug: p.slug,
          visibility: p.visibility,
          orgId: p.orgId,
          kitMd: body,
        }),
      });
      if (!res.ok) throw new Error(`Journey publish -> ${res.status}: ${await res.text()}`);
      return await res.json();
    },

    "prefrontal.recipe.run": async (raw: unknown) => {
      const p = check<PrefrontalKitRunParams>(vRun, raw, "prefrontal.recipe.run");

      if (p.dryRun) {
        // Dry-run: return the dispatch plan without spawning anything.
        const result = await runKit({
          kitRef: p.kitRef,
          sessionKey: p.sessionKey,
          intent: p.intent,
          parameters: p.parameters,
          dryRun: true,
          ownKitsDir: deps.ownKitsDir,
          kitInstallSandbox: deps.kitInstallSandbox,
        });
        return {
          ok: result.ok,
          planId: result.planId,
          dryRun: true,
          dryRunPlan: result.dryRunPlan,
          errorMessage: result.errorMessage,
        };
      }

      // Live mode: runKit seeds the plan synchronously then dispatches subagents
      // in the background. We await only the plan seed, then let dispatch continue
      // asynchronously. The plan board in TUI reflects live step progress.
      //
      // We wrap in a Promise that resolves after the plan is seeded (first async
      // boundary inside runKit) by running the full kit in background and
      // returning immediately with the planId from a pre-seeded plan.
      const runResult = await runKit({
        kitRef: p.kitRef,
        sessionKey: p.sessionKey,
        intent: p.intent,
        parameters: p.parameters,
        dryRun: false,
        planStore: deps.planStore,
        ownKitsDir: deps.ownKitsDir,
        kitInstallSandbox: deps.kitInstallSandbox,
        // FORK 2026-05-30 (Upgrade 5): durable checkpointing. Auto-resume an
        // interrupted in_progress plan only when resume:true is explicitly passed
        // (no silent re-attach — Oscar's policy). Read defensively so this works
        // even before `resume` is added to PrefrontalKitRunParamsSchema.
        resume: (p as { resume?: boolean }).resume === true,
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

    // FORK 2026-05-29: compose a recipe on the fly. Validates the spec, builds a
    // kit/1.0 doc, and writes it to the own-kits dir so the turn-start matcher
    // picks it up immediately. This is the NO-MATCH escape hatch — Jarvis turns a
    // recipe gap into a reusable recipe in one call.
    "prefrontal.recipe.author": async (raw: unknown) => {
      const p = check<PrefrontalKitAuthorParams>(vAuthor, raw, "prefrontal.recipe.author");
      const spec = p as unknown as KitSpec;
      const v = validateKitSpec(spec);
      if (!v.ok) {
        throw new Error(`prefrontal.kit.author: invalid spec — ${v.errors.join("; ")}`);
      }
      const kitMd = buildKitMd(spec);
      const dir = path.join(deps.ownKitsDir, spec.slug);
      const target = path.join(dir, "kit.md");
      let existed = false;
      let existingText = "";
      try {
        existingText = await fs.readFile(target, "utf-8");
        existed = true;
      } catch {
        existed = false;
      }
      if (existed) {
        // Never clobber a hand-curated, version-controlled kit. Only kits this
        // author RPC itself wrote (authoredBy: jarvis-*) are overwritable, and
        // only with explicit overwrite:true (review finding 2026-05-29).
        const isAuthored = /authoredBy:\s*["']?jarvis/i.test(existingText);
        if (!isAuthored) {
          throw new Error(
            `prefrontal.kit.author: "${spec.slug}" is a curated kit — refusing to overwrite. Pick a different slug.`,
          );
        }
        if (!p.overwrite) {
          throw new Error(
            `prefrontal.kit.author: authored kit "${spec.slug}" already exists — pass overwrite:true to replace it`,
          );
        }
      }
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(target, kitMd, "utf-8");
      invalidateKitIndexCache(); // next turn's matcher re-scans the catalog
      return {
        ok: true,
        slug: spec.slug,
        kitRef: `globalcaos/${spec.slug}`,
        path: target,
        stepCount: spec.steps.length,
        replaced: existed,
        note: existed
          ? `overwrote existing kit "${spec.slug}"`
          : `authored new kit "${spec.slug}" — matchable on the next turn`,
      };
    },

    // FORK 2026-05-29: LLM-free best-fit lookup. Returns ranked local-catalog
    // candidates + a confidence so the caller can decide use-vs-author.
    "prefrontal.recipe.match": async (raw: unknown) => {
      const p = check<PrefrontalKitMatchParams>(vMatch, raw, "prefrontal.recipe.match");
      const index = await loadKitIndex(deps.ownKitsDir);
      const { matches, confidence } = matchKitsDetailed(p.prompt, index, { max: p.limit ?? 5 });
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
