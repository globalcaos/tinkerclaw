import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import { renderWikiMarkdown, toWikiPageSummary, type WikiPageSummary } from "./markdown.js";

export type MemoryWikiLintIssue = {
  severity: "error" | "warning";
  code:
    | "missing-id"
    | "duplicate-id"
    | "missing-page-type"
    | "page-type-mismatch"
    | "missing-title"
    | "missing-source-ids"
    | "broken-wikilink";
  path: string;
  message: string;
};

export type LintMemoryWikiResult = {
  vaultRoot: string;
  issueCount: number;
  issues: MemoryWikiLintIssue[];
  reportPath: string;
};

function toExpectedPageType(page: WikiPageSummary): string {
  return page.kind;
}

function collectBrokenLinkIssues(pages: WikiPageSummary[]): MemoryWikiLintIssue[] {
  const validTargets = new Set<string>();
  for (const page of pages) {
    const withoutExtension = page.relativePath.replace(/\.md$/i, "");
    validTargets.add(withoutExtension);
    validTargets.add(path.basename(withoutExtension));
  }

  const issues: MemoryWikiLintIssue[] = [];
  for (const page of pages) {
    for (const linkTarget of page.linkTargets) {
      if (!validTargets.has(linkTarget)) {
        issues.push({
          severity: "warning",
          code: "broken-wikilink",
          path: page.relativePath,
          message: `Broken wikilink target \`${linkTarget}\`.`,
        });
      }
    }
  }
  return issues;
}

function collectPageIssues(pages: WikiPageSummary[]): MemoryWikiLintIssue[] {
  const issues: MemoryWikiLintIssue[] = [];
  const pagesById = new Map<string, WikiPageSummary[]>();

  for (const page of pages) {
    if (!page.id) {
      issues.push({
        severity: "error",
        code: "missing-id",
        path: page.relativePath,
        message: "Missing `id` frontmatter.",
      });
    } else {
      const current = pagesById.get(page.id) ?? [];
      current.push(page);
      pagesById.set(page.id, current);
    }

    if (!page.pageType) {
      issues.push({
        severity: "error",
        code: "missing-page-type",
        path: page.relativePath,
        message: "Missing `pageType` frontmatter.",
      });
    } else if (page.pageType !== toExpectedPageType(page)) {
      issues.push({
        severity: "error",
        code: "page-type-mismatch",
        path: page.relativePath,
        message: `Expected pageType \`${toExpectedPageType(page)}\`, found \`${page.pageType}\`.`,
      });
    }

    if (!page.title.trim()) {
      issues.push({
        severity: "error",
        code: "missing-title",
        path: page.relativePath,
        message: "Missing page title.",
      });
    }

    if (page.kind !== "source" && page.kind !== "report" && page.sourceIds.length === 0) {
      issues.push({
        severity: "warning",
        code: "missing-source-ids",
        path: page.relativePath,
        message: "Non-source page is missing `sourceIds` provenance.",
      });
    }
  }

  for (const [id, matches] of pagesById.entries()) {
    if (matches.length > 1) {
      for (const match of matches) {
        issues.push({
          severity: "error",
          code: "duplicate-id",
          path: match.relativePath,
          message: `Duplicate page id \`${id}\`.`,
        });
      }
    }
  }

  issues.push(...collectBrokenLinkIssues(pages));
  return issues.toSorted((left, right) => left.path.localeCompare(right.path));
}

function buildLintReportBody(issues: MemoryWikiLintIssue[]): string {
  if (issues.length === 0) {
    return "No issues found.";
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const lines = [`- Errors: ${errors.length}`, `- Warnings: ${warnings.length}`];

  if (errors.length > 0) {
    lines.push("", "### Errors");
    for (const issue of errors) {
      lines.push(`- \`${issue.path}\`: ${issue.message}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("", "### Warnings");
    for (const issue of warnings) {
      lines.push(`- \`${issue.path}\`: ${issue.message}`);
    }
  }

  return lines.join("\n");
}

async function writeLintReport(rootDir: string, issues: MemoryWikiLintIssue[]): Promise<string> {
  const reportPath = path.join(rootDir, "reports", "lint.md");
  const original = await fs.readFile(reportPath, "utf8").catch(() =>
    renderWikiMarkdown({
      frontmatter: {
        pageType: "report",
        id: "report.lint",
        title: "Lint Report",
        status: "active",
      },
      body: "# Lint Report\n",
    }),
  );
  const updated = replaceManagedMarkdownBlock({
    original,
    heading: "## Generated",
    startMarker: "<!-- openclaw:wiki:lint:start -->",
    endMarker: "<!-- openclaw:wiki:lint:end -->",
    body: buildLintReportBody(issues),
  });
  await fs.writeFile(reportPath, withTrailingNewline(updated), "utf8");
  return reportPath;
}

export async function lintMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
): Promise<LintMemoryWikiResult> {
  const compileResult = await compileMemoryWikiVault(config);
  const issues = collectPageIssues(compileResult.pages);
  const reportPath = await writeLintReport(config.vault.path, issues);

  await appendMemoryWikiLog(config.vault.path, {
    type: "lint",
    timestamp: new Date().toISOString(),
    details: {
      issueCount: issues.length,
      reportPath: path.relative(config.vault.path, reportPath),
    },
  });

  return {
    vaultRoot: config.vault.path,
    issueCount: issues.length,
    issues,
    reportPath,
  };
}
