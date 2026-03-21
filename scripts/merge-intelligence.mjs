#!/usr/bin/env node
/**
 * merge-intelligence.mjs — Strategic analysis of upstream changes.
 *
 * Runs after merge, before build. Produces a report that:
 * 1. Detects plugin-sdk import changes and suggests fork updates
 * 2. Identifies upstream features near our interest areas
 * 3. Suggests how our fork code could morph to ride upstream's wave
 * 4. Detects collision zones (context-engine vs ENGRAM, etc.)
 *
 * Output: /tmp/merge-intelligence-report.md (also printed to stdout)
 *
 * Usage: node scripts/merge-intelligence.mjs [--since <commit>]
 *   --since  Base commit to diff from (default: HEAD~1 or last merge base)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const REPORT_PATH = "/tmp/merge-intelligence-report.md";

// ── Config: Our interest areas and fork-specific modules ──────────────────────

const FORK_INTEREST_AREAS = {
  "context-engine": {
    label: "Context Engine (vs ENGRAM)",
    collision: "HIGH",
    forkModules: [
      "src/agents/pi-extensions/compaction-engram.ts",
      "src/agents/pi-extensions/pointer-compaction-runtime.ts",
    ],
    strategy: "Converge: rewrite ENGRAM as Context Engine plugin when API stabilizes",
  },
  "plugin-sdk": {
    label: "Plugin SDK refactoring",
    collision: "HIGH",
    forkModules: [
      "extensions/budget-panel/index.ts",
      "extensions/whatsapp/src/auto-reply/deliver-reply.ts",
    ],
    strategy: "Match: update fork imports to match upstream's new export paths after each merge",
  },
  compaction: {
    label: "Compaction system",
    collision: "MODERATE",
    forkModules: ["src/agents/pi-extensions/compaction-engram.ts", "src/memory/engram/"],
    strategy: "Converge: our compaction strategy is better but should plug into their lifecycle",
  },
  "tts|speech": {
    label: "TTS / Speech",
    collision: "LOW",
    forkModules: ["src/tts/sherpa-onnx.test.ts"],
    strategy:
      "Adopt: use upstream in-memory TTS as backend, apply our pitch-shifting as post-process",
  },
  "openshell|sandbox": {
    label: "Sandbox / Security (AEGIS relevance)",
    collision: "NONE — complementary",
    forkModules: [],
    strategy: "Adopt: use OpenShell for exec sandboxing. Validates AEGIS paper.",
  },
  "image.gen|image_generate": {
    label: "Image Generation",
    collision: "NONE",
    forkModules: [],
    strategy: "Free feature: adopt as-is",
  },
  "web.search|tavily|brave|firecrawl": {
    label: "Web Search plugins",
    collision: "NONE",
    forkModules: [],
    strategy: "Free feature: adopt as-is",
  },
  "context.engine.*assemble|assemble": {
    label: "Context Engine assemble() API",
    collision: "MODERATE",
    forkModules: ["src/memory/engram/recall-tool.ts"],
    strategy: "Wire HIPPOCAMPUS as an assemble() provider when the API is stable",
  },
  "whatsapp.*refactor|whatsapp.*boundary|whatsapp.*runtime": {
    label: "WhatsApp runtime restructuring",
    collision: "HIGH",
    forkModules: [
      "extensions/whatsapp/src/auto-reply/deliver-reply.ts",
      "extensions/whatsapp/src/inbound/access-control.ts",
      "extensions/whatsapp/src/session.ts",
    ],
    strategy: "Match: our Protocol v2 changes must track upstream's file structure",
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function git(cmd) {
  return execSync(`git -C "${ROOT}" ${cmd}`, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function findMergeBase() {
  try {
    // Find the most recent merge commit
    const mergeCommit = git("log --merges --oneline -1 --format=%H");
    if (mergeCommit) {
      // The parent before the merge
      return git(`rev-parse ${mergeCommit}^`);
    }
  } catch {
    /* ignore */
  }
  return "HEAD~1";
}

// ── Analysis functions ────────────────────────────────────────────────────────

function getUpstreamCommitsSince(since) {
  try {
    const log = git(`log ${since}..HEAD --oneline --no-merges`);
    return log ? log.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getChangedFiles(since) {
  try {
    const files = git(`diff --name-only ${since}..HEAD`);
    return files ? files.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

function categorizeFeatureCommits(commits) {
  const features = [];
  const refactors = [];
  const fixes = [];

  for (const line of commits) {
    const msg = line.replace(/^[a-f0-9]+ /, "");
    if (msg.startsWith("feat")) {
      features.push(msg);
    } else if (msg.startsWith("refactor")) {
      refactors.push(msg);
    } else if (msg.startsWith("fix")) {
      fixes.push(msg);
    }
  }
  return { features, refactors, fixes };
}

function detectInterestAreaChanges(commits, changedFiles) {
  const hits = [];

  for (const [pattern, info] of Object.entries(FORK_INTEREST_AREAS)) {
    const regex = new RegExp(pattern.replace(/\./g, "[./]").replace(/\|/g, "|"), "i");

    const matchingCommits = commits.filter((c) => regex.test(c));
    const matchingFiles = changedFiles.filter((f) => regex.test(f));

    if (matchingCommits.length > 0 || matchingFiles.length > 0) {
      hits.push({
        ...info,
        pattern,
        commitCount: matchingCommits.length,
        fileCount: matchingFiles.length,
        commits: matchingCommits.slice(0, 5),
        files: matchingFiles.slice(0, 10),
      });
    }
  }
  return hits;
}

function detectPluginSdkImportBreaks(changedFiles) {
  const sdkFiles = changedFiles.filter(
    (f) => f.startsWith("src/plugin-sdk/") || f.includes("plugin-sdk"),
  );
  if (sdkFiles.length === 0) {
    return null;
  }

  // Check if our fork extensions import from changed paths
  const breaks = [];
  const forkExtensions = [
    "extensions/budget-panel/index.ts",
    "extensions/whatsapp/src/auto-reply/deliver-reply.ts",
    "extensions/whatsapp/src/inbound/access-control.ts",
    "extensions/whatsapp/src/inbound/monitor.ts",
    "extensions/whatsapp/src/session.ts",
  ];

  for (const ext of forkExtensions) {
    const fullPath = path.join(ROOT, ext);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const content = fs.readFileSync(fullPath, "utf8");
    const imports = content.match(/from\s+["']openclaw\/plugin-sdk(?:\/[^"']+)?["']/g) || [];

    for (const imp of imports) {
      const importPath = imp.match(/["']([^"']+)["']/)?.[1];
      if (importPath) {
        // Check if the imported subpath was restructured
        const subpath = importPath.replace("openclaw/plugin-sdk", "src/plugin-sdk");
        if (sdkFiles.some((f) => f.startsWith(subpath.replace(/^src/, "src")))) {
          breaks.push({ extension: ext, importPath, changedSdkFile: subpath });
        }
      }
    }
  }

  return { sdkFiles, breaks };
}

function suggestMorphDirections(interestHits) {
  const suggestions = [];

  for (const hit of interestHits) {
    if (hit.commitCount > 3) {
      suggestions.push({
        area: hit.label,
        urgency: hit.collision === "HIGH" ? "🔴" : hit.collision === "MODERATE" ? "🟡" : "🟢",
        suggestion: hit.strategy,
        evidence: `${hit.commitCount} commits, ${hit.fileCount} files changed`,
        commits: hit.commits,
      });
    }
  }

  return suggestions;
}

// ── Report generation ─────────────────────────────────────────────────────────

function generateReport(since) {
  const commits = getUpstreamCommitsSince(since);
  const changedFiles = getChangedFiles(since);
  const { features, refactors, fixes } = categorizeFeatureCommits(commits);
  const interestHits = detectInterestAreaChanges(commits, changedFiles);
  const sdkAnalysis = detectPluginSdkImportBreaks(changedFiles);
  const suggestions = suggestMorphDirections(interestHits);

  const lines = [];
  lines.push(`# Merge Intelligence Report — ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(
    `**Commits merged:** ${commits.length} (${features.length} features, ${refactors.length} refactors, ${fixes.length} fixes)`,
  );
  lines.push(`**Files changed:** ${changedFiles.length}`);
  lines.push("");

  // Section 1: Interest area changes
  if (interestHits.length > 0) {
    lines.push("## 🎯 Changes In Our Interest Areas");
    lines.push("");
    for (const hit of interestHits) {
      const icon = hit.collision === "HIGH" ? "🔴" : hit.collision === "MODERATE" ? "🟡" : "🟢";
      lines.push(`### ${icon} ${hit.label} (${hit.commitCount} commits, ${hit.fileCount} files)`);
      lines.push(`**Collision risk:** ${hit.collision}`);
      lines.push(`**Strategy:** ${hit.strategy}`);
      if (hit.commits.length > 0) {
        lines.push("");
        lines.push("Recent commits:");
        for (const c of hit.commits) {
          lines.push(`- ${c}`);
        }
      }
      lines.push("");
    }
  }

  // Section 2: Plugin SDK import breaks
  if (sdkAnalysis && sdkAnalysis.sdkFiles.length > 0) {
    lines.push("## ⚡ Plugin SDK Changes (Import Break Risk)");
    lines.push("");
    lines.push(
      `**${sdkAnalysis.sdkFiles.length} SDK files changed.** Check fork extension imports.`,
    );
    if (sdkAnalysis.breaks.length > 0) {
      lines.push("");
      lines.push("**Potential breaks detected:**");
      for (const b of sdkAnalysis.breaks) {
        lines.push(
          `- \`${b.extension}\` imports \`${b.importPath}\` — SDK file changed: \`${b.changedSdkFile}\``,
        );
      }
    }
    lines.push("");
  }

  // Section 3: Morph suggestions
  if (suggestions.length > 0) {
    lines.push("## 🔄 Fork Morph Suggestions");
    lines.push("");
    lines.push("Changes upstream suggest our fork code could evolve:");
    lines.push("");
    for (const s of suggestions) {
      lines.push(`### ${s.urgency} ${s.area}`);
      lines.push(`**Action:** ${s.suggestion}`);
      lines.push(`**Evidence:** ${s.evidence}`);
      lines.push("");
    }
  }

  // Section 4: Notable new features
  if (features.length > 0) {
    lines.push("## 🆕 Notable Upstream Features");
    lines.push("");
    // Filter to features near our interests
    const notable = features.filter((f) => {
      const lf = f.toLowerCase();
      return (
        lf.includes("context") ||
        lf.includes("compaction") ||
        lf.includes("memory") ||
        lf.includes("tts") ||
        lf.includes("speech") ||
        lf.includes("sandbox") ||
        lf.includes("openshell") ||
        lf.includes("security") ||
        lf.includes("whatsapp") ||
        lf.includes("image") ||
        lf.includes("search") ||
        lf.includes("plugin") ||
        lf.includes("fast mode") ||
        lf.includes("browser") ||
        lf.includes("anthropic") ||
        lf.includes("openai")
      );
    });
    if (notable.length > 0) {
      for (const f of notable.slice(0, 15)) {
        lines.push(`- ${f}`);
      }
    } else {
      lines.push("No features directly matching our interest areas in this merge.");
    }
    lines.push("");
  }

  // Section 5: Action items
  lines.push("## ✅ Post-Merge Action Items");
  lines.push("");
  if (sdkAnalysis && sdkAnalysis.breaks.length > 0) {
    lines.push("- [ ] Fix plugin-sdk import breaks in fork extensions");
  }
  if (interestHits.some((h) => h.collision === "HIGH")) {
    lines.push("- [ ] Review HIGH collision areas — manual inspection recommended");
  }
  if (interestHits.some((h) => h.label.includes("Context Engine"))) {
    lines.push("- [ ] Check Context Engine API changes against ENGRAM integration plan");
  }
  if (interestHits.some((h) => h.label.includes("WhatsApp"))) {
    lines.push(
      "- [ ] Verify Protocol v2 changes still apply cleanly to upstream's WhatsApp structure",
    );
  }
  lines.push("- [ ] Run merge guardian: `bash scripts/merge-guardian.sh --fix`");
  lines.push("- [ ] Build and smoke test: `pnpm build && node openclaw.mjs --version`");
  lines.push("");

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

const sinceArg = process.argv.indexOf("--since");
const since =
  sinceArg >= 0 && process.argv[sinceArg + 1] ? process.argv[sinceArg + 1] : findMergeBase();

console.log(`📊 Analyzing changes since ${since.slice(0, 12)}...`);

const report = generateReport(since);
fs.writeFileSync(REPORT_PATH, report);
console.log(report);
console.log(`\n📝 Report saved to ${REPORT_PATH}`);
