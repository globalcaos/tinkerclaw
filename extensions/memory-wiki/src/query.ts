import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { parseWikiMarkdown, toWikiPageSummary, type WikiPageSummary } from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const QUERY_DIRS = ["entities", "concepts", "sources", "syntheses", "reports"] as const;

export type WikiSearchResult = {
  path: string;
  title: string;
  kind: WikiPageSummary["kind"];
  score: number;
  snippet: string;
  id?: string;
};

export type WikiGetResult = {
  path: string;
  title: string;
  kind: WikiPageSummary["kind"];
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
};

export type QueryableWikiPage = WikiPageSummary & {
  raw: string;
};

async function listWikiMarkdownFiles(rootDir: string): Promise<string[]> {
  const files = (
    await Promise.all(
      QUERY_DIRS.map(async (relativeDir) => {
        const dirPath = path.join(rootDir, relativeDir);
        const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
        return entries
          .filter(
            (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md",
          )
          .map((entry) => path.join(relativeDir, entry.name));
      }),
    )
  ).flat();
  return files.toSorted((left, right) => left.localeCompare(right));
}

export async function readQueryableWikiPages(rootDir: string): Promise<QueryableWikiPage[]> {
  const files = await listWikiMarkdownFiles(rootDir);
  const pages = await Promise.all(
    files.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const raw = await fs.readFile(absolutePath, "utf8");
      const summary = toWikiPageSummary({ absolutePath, relativePath, raw });
      return summary ? { ...summary, raw } : null;
    }),
  );
  return pages.flatMap((page) => (page ? [page] : []));
}

function buildSnippet(raw: string, query: string): string {
  const queryLower = query.toLowerCase();
  const matchingLine = raw
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().includes(queryLower) && line.trim().length > 0);
  return (
    matchingLine?.trim() ||
    raw
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ||
    ""
  );
}

function scorePage(page: QueryableWikiPage, query: string): number {
  const queryLower = query.toLowerCase();
  const titleLower = page.title.toLowerCase();
  const pathLower = page.relativePath.toLowerCase();
  const idLower = page.id?.toLowerCase() ?? "";
  const rawLower = page.raw.toLowerCase();
  if (
    !(
      titleLower.includes(queryLower) ||
      pathLower.includes(queryLower) ||
      idLower.includes(queryLower) ||
      rawLower.includes(queryLower)
    )
  ) {
    return 0;
  }

  let score = 1;
  if (titleLower === queryLower) {
    score += 50;
  } else if (titleLower.includes(queryLower)) {
    score += 20;
  }
  if (pathLower.includes(queryLower)) {
    score += 10;
  }
  if (idLower.includes(queryLower)) {
    score += 10;
  }
  const bodyOccurrences = rawLower.split(queryLower).length - 1;
  score += Math.min(20, bodyOccurrences);
  return score;
}

function normalizeLookupKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.endsWith(".md") ? normalized : normalized.replace(/\/+$/, "");
}

export function resolveQueryableWikiPageByLookup(
  pages: QueryableWikiPage[],
  lookup: string,
): QueryableWikiPage | null {
  const key = normalizeLookupKey(lookup);
  const withExtension = key.endsWith(".md") ? key : `${key}.md`;
  return (
    pages.find((page) => page.relativePath === key) ??
    pages.find((page) => page.relativePath === withExtension) ??
    pages.find((page) => page.relativePath.replace(/\.md$/i, "") === key) ??
    pages.find((page) => path.basename(page.relativePath, ".md") === key) ??
    pages.find((page) => page.id === key) ??
    null
  );
}

export async function searchMemoryWiki(params: {
  config: ResolvedMemoryWikiConfig;
  query: string;
  maxResults?: number;
}): Promise<WikiSearchResult[]> {
  await initializeMemoryWikiVault(params.config);
  const pages = await readQueryableWikiPages(params.config.vault.path);
  const maxResults = Math.max(1, params.maxResults ?? 10);
  return pages
    .map((page) => ({
      path: page.relativePath,
      title: page.title,
      kind: page.kind,
      score: scorePage(page, params.query),
      snippet: buildSnippet(page.raw, params.query),
      ...(page.id ? { id: page.id } : {}),
    }))
    .filter((page) => page.score > 0)
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, maxResults);
}

export async function getMemoryWikiPage(params: {
  config: ResolvedMemoryWikiConfig;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
}): Promise<WikiGetResult | null> {
  await initializeMemoryWikiVault(params.config);
  const pages = await readQueryableWikiPages(params.config.vault.path);
  const page = resolveQueryableWikiPageByLookup(pages, params.lookup);
  if (!page) {
    return null;
  }

  const parsed = parseWikiMarkdown(page.raw);
  const lines = parsed.body.split(/\r?\n/);
  const fromLine = Math.max(1, params.fromLine ?? 1);
  const lineCount = Math.max(1, params.lineCount ?? 200);
  const slice = lines.slice(fromLine - 1, fromLine - 1 + lineCount).join("\n");

  return {
    path: page.relativePath,
    title: page.title,
    kind: page.kind,
    content: slice,
    fromLine,
    lineCount,
    ...(page.id ? { id: page.id } : {}),
  };
}
