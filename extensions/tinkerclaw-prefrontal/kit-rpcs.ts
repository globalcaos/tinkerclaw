import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import { fetch as undiciFetch } from "undici";
import { parse as parseYaml } from "yaml";
import {
  PrefrontalKitSearchParamsSchema,
  PrefrontalKitGetParamsSchema,
  PrefrontalKitInstallParamsSchema,
  PrefrontalKitPublishParamsSchema,
  PrefrontalKitListParamsSchema,
  type PrefrontalKitSearchParams,
  type PrefrontalKitGetParams,
  type PrefrontalKitInstallParams,
  type PrefrontalKitPublishParams,
  type PrefrontalKitListParams,
} from "../../src/gateway/protocol/schema/prefrontal-kit.js";
import { KitStore } from "./kit-store.js";

const ajv = new Ajv({ allErrors: true });
const vSearch = ajv.compile(PrefrontalKitSearchParamsSchema);
const vGet = ajv.compile(PrefrontalKitGetParamsSchema);
const vInstall = ajv.compile(PrefrontalKitInstallParamsSchema);
const vPublish = ajv.compile(PrefrontalKitPublishParamsSchema);
const vList = ajv.compile(PrefrontalKitListParamsSchema);

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
    "prefrontal.kit.search": async (raw: unknown) => {
      const p = check<PrefrontalKitSearchParams>(vSearch, raw, "prefrontal.kit.search");
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

    "prefrontal.kit.get": async (raw: unknown) => {
      const p = check<PrefrontalKitGetParams>(vGet, raw, "prefrontal.kit.get");
      const j: any = await fetchJson(
        `/api/kits/${p.kitRef}${p.ref ? `?ref=${encodeURIComponent(p.ref)}` : ""}`,
      );
      return { kit: j };
    },

    "prefrontal.kit.install": async (raw: unknown) => {
      const p = check<PrefrontalKitInstallParams>(vInstall, raw, "prefrontal.kit.install");
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

    "prefrontal.kit.list": async (raw: unknown) => {
      const p = check<PrefrontalKitListParams>(vList, raw, "prefrontal.kit.list");

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

    "prefrontal.kit.publish": async (raw: unknown) => {
      const p = check<PrefrontalKitPublishParams>(vPublish, raw, "prefrontal.kit.publish");
      if (!deps.apiKey)
        throw new Error(
          "prefrontal.kit.publish: missing apiKey (set integrations.journey.apiKey in openclaw.json)",
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
  } as const;
}
