import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  formatWikiLink,
  toWikiPageSummary,
  type WikiPageKind,
  type WikiPageSummary,
} from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const COMPILE_PAGE_GROUPS: Array<{ kind: WikiPageKind; dir: string; heading: string }> = [
  { kind: "source", dir: "sources", heading: "Sources" },
  { kind: "entity", dir: "entities", heading: "Entities" },
  { kind: "concept", dir: "concepts", heading: "Concepts" },
  { kind: "synthesis", dir: "syntheses", heading: "Syntheses" },
  { kind: "report", dir: "reports", heading: "Reports" },
];

export type CompileMemoryWikiResult = {
  vaultRoot: string;
  pageCounts: Record<WikiPageKind, number>;
  pages: WikiPageSummary[];
  updatedFiles: string[];
};

async function collectMarkdownFiles(rootDir: string, relativeDir: string): Promise<string[]> {
  const dirPath = path.join(rootDir, relativeDir);
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(relativeDir, entry.name))
    .filter((relativePath) => path.basename(relativePath) !== "index.md")
    .toSorted((left, right) => left.localeCompare(right));
}

async function readPageSummaries(rootDir: string): Promise<WikiPageSummary[]> {
  const filePaths = (
    await Promise.all(COMPILE_PAGE_GROUPS.map((group) => collectMarkdownFiles(rootDir, group.dir)))
  ).flat();

  const pages = await Promise.all(
    filePaths.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const raw = await fs.readFile(absolutePath, "utf8");
      return toWikiPageSummary({ absolutePath, relativePath, raw });
    }),
  );

  return pages
    .flatMap((page) => (page ? [page] : []))
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

function buildPageCounts(pages: WikiPageSummary[]): Record<WikiPageKind, number> {
  return {
    entity: pages.filter((page) => page.kind === "entity").length,
    concept: pages.filter((page) => page.kind === "concept").length,
    source: pages.filter((page) => page.kind === "source").length,
    synthesis: pages.filter((page) => page.kind === "synthesis").length,
    report: pages.filter((page) => page.kind === "report").length,
  };
}

function renderSectionList(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  emptyText: string;
}): string {
  if (params.pages.length === 0) {
    return `- ${params.emptyText}`;
  }
  return params.pages
    .map(
      (page) =>
        `- ${formatWikiLink({
          renderMode: params.config.vault.renderMode,
          relativePath: page.relativePath,
          title: page.title,
        })}`,
    )
    .join("\n");
}

async function writeManagedMarkdownFile(params: {
  filePath: string;
  title: string;
  startMarker: string;
  endMarker: string;
  body: string;
}): Promise<void> {
  const original = await fs.readFile(params.filePath, "utf8").catch(() => `# ${params.title}\n`);
  const updated = replaceManagedMarkdownBlock({
    original,
    heading: "## Generated",
    startMarker: params.startMarker,
    endMarker: params.endMarker,
    body: params.body,
  });
  await fs.writeFile(params.filePath, withTrailingNewline(updated), "utf8");
}

function buildRootIndexBody(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  counts: Record<WikiPageKind, number>;
}): string {
  const lines = [
    `- Render mode: \`${params.config.vault.renderMode}\``,
    `- Total pages: ${params.pages.length}`,
    `- Sources: ${params.counts.source}`,
    `- Entities: ${params.counts.entity}`,
    `- Concepts: ${params.counts.concept}`,
    `- Syntheses: ${params.counts.synthesis}`,
    `- Reports: ${params.counts.report}`,
  ];

  for (const group of COMPILE_PAGE_GROUPS) {
    lines.push("", `### ${group.heading}`);
    lines.push(
      renderSectionList({
        config: params.config,
        pages: params.pages.filter((page) => page.kind === group.kind),
        emptyText: `No ${group.heading.toLowerCase()} yet.`,
      }),
    );
  }

  return lines.join("\n");
}

function buildDirectoryIndexBody(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  group: { kind: WikiPageKind; dir: string; heading: string };
}): string {
  return renderSectionList({
    config: params.config,
    pages: params.pages.filter((page) => page.kind === params.group.kind),
    emptyText: `No ${params.group.heading.toLowerCase()} yet.`,
  });
}

export async function compileMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
): Promise<CompileMemoryWikiResult> {
  await initializeMemoryWikiVault(config);
  const rootDir = config.vault.path;
  const pages = await readPageSummaries(rootDir);
  const counts = buildPageCounts(pages);
  const updatedFiles: string[] = [];

  const rootIndexPath = path.join(rootDir, "index.md");
  await writeManagedMarkdownFile({
    filePath: rootIndexPath,
    title: "Wiki Index",
    startMarker: "<!-- openclaw:wiki:index:start -->",
    endMarker: "<!-- openclaw:wiki:index:end -->",
    body: buildRootIndexBody({ config, pages, counts }),
  });
  updatedFiles.push(rootIndexPath);

  for (const group of COMPILE_PAGE_GROUPS) {
    const filePath = path.join(rootDir, group.dir, "index.md");
    await writeManagedMarkdownFile({
      filePath,
      title: group.heading,
      startMarker: `<!-- openclaw:wiki:${group.dir}:index:start -->`,
      endMarker: `<!-- openclaw:wiki:${group.dir}:index:end -->`,
      body: buildDirectoryIndexBody({ config, pages, group }),
    });
    updatedFiles.push(filePath);
  }

  await appendMemoryWikiLog(rootDir, {
    type: "compile",
    timestamp: new Date().toISOString(),
    details: {
      pageCounts: counts,
      updatedFiles: updatedFiles.map((filePath) => path.relative(rootDir, filePath)),
    },
  });

  return {
    vaultRoot: rootDir,
    pageCounts: counts,
    pages,
    updatedFiles,
  };
}
