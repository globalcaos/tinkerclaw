import path from "node:path";
import YAML from "yaml";

export const WIKI_PAGE_KINDS = ["entity", "concept", "source", "synthesis", "report"] as const;

export type WikiPageKind = (typeof WIKI_PAGE_KINDS)[number];

export type ParsedWikiMarkdown = {
  frontmatter: Record<string, unknown>;
  body: string;
};

export type WikiPageSummary = {
  absolutePath: string;
  relativePath: string;
  kind: WikiPageKind;
  title: string;
  id?: string;
  pageType?: string;
  sourceIds: string[];
  linkTargets: string[];
};

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/;
const OBSIDIAN_LINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export function slugifyWikiSegment(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "page";
}

export function parseWikiMarkdown(content: string): ParsedWikiMarkdown {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const parsed = YAML.parse(match[1]) as unknown;
  return {
    frontmatter:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body: content.slice(match[0].length),
  };
}

export function renderWikiMarkdown(params: {
  frontmatter: Record<string, unknown>;
  body: string;
}): string {
  const frontmatter = YAML.stringify(params.frontmatter).trimEnd();
  return `---\n${frontmatter}\n---\n\n${params.body.trimStart()}`;
}

export function extractTitleFromMarkdown(body: string): string | undefined {
  const match = body.match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || undefined;
}

export function normalizeSourceIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

export function extractWikiLinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(OBSIDIAN_LINK_PATTERN)) {
    const target = match[1]?.trim();
    if (target) {
      links.push(target);
    }
  }
  return links;
}

export function formatWikiLink(params: {
  renderMode: "native" | "obsidian";
  relativePath: string;
  title: string;
}): string {
  const withoutExtension = params.relativePath.replace(/\.md$/i, "");
  return params.renderMode === "obsidian"
    ? `[[${withoutExtension}|${params.title}]]`
    : `[${params.title}](${params.relativePath})`;
}

export function renderMarkdownFence(content: string, infoString = "text"): string {
  const fenceSize = Math.max(
    3,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length + 1),
  );
  const fence = "`".repeat(fenceSize);
  return `${fence}${infoString}\n${content}\n${fence}`;
}

export function inferWikiPageKind(relativePath: string): WikiPageKind | null {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized.startsWith("entities/")) {
    return "entity";
  }
  if (normalized.startsWith("concepts/")) {
    return "concept";
  }
  if (normalized.startsWith("sources/")) {
    return "source";
  }
  if (normalized.startsWith("syntheses/")) {
    return "synthesis";
  }
  if (normalized.startsWith("reports/")) {
    return "report";
  }
  return null;
}

export function toWikiPageSummary(params: {
  absolutePath: string;
  relativePath: string;
  raw: string;
}): WikiPageSummary | null {
  const kind = inferWikiPageKind(params.relativePath);
  if (!kind) {
    return null;
  }
  const parsed = parseWikiMarkdown(params.raw);
  const title =
    (typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.trim()) ||
    extractTitleFromMarkdown(parsed.body) ||
    path.basename(params.relativePath, ".md");

  return {
    absolutePath: params.absolutePath,
    relativePath: params.relativePath.split(path.sep).join("/"),
    kind,
    title,
    id:
      typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.trim()
        ? parsed.frontmatter.id.trim()
        : undefined,
    pageType:
      typeof parsed.frontmatter.pageType === "string" && parsed.frontmatter.pageType.trim()
        ? parsed.frontmatter.pageType.trim()
        : undefined,
    sourceIds: normalizeSourceIds(parsed.frontmatter.sourceIds),
    linkTargets: extractWikiLinks(params.raw),
  };
}
