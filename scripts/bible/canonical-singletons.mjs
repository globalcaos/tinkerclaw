#!/usr/bin/env node
/**
 * canonical-derivations.md — the SINGLETON assertions, made executable.
 *
 * The optic TINKER_UI_DESIGN_BIBLE/canonical-derivations.md is the AUTHORITY: it carries the
 * incident that paid for each of these collapses, which is the part a future reader acts on. This
 * file is only the guard that keeps them collapsed. When the two disagree, the OPTIC is right and
 * THIS FILE is the bug.
 *
 * It lives here rather than in the optic's frontmatter per FOUNDATION.md, "Three different jobs,
 * three different homes": explain in the bible, enforce in the running code, CHECK in
 * scripts/bible/*.mjs behind a one-line `cmd:` pointer.
 *
 * Usage:
 *   node scripts/bible/canonical-singletons.mjs                          # all checks
 *   node scripts/bible/canonical-singletons.mjs --check=pii-re
 *   node scripts/bible/canonical-singletons.mjs --check=chrome-extension
 *   node scripts/bible/canonical-singletons.mjs --check=engram
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRUNE = new Set(["node_modules", "dist", "dist-runtime", "coverage", ".git"]);

/** Depth-first over real directories only — a symlinked dist/node_modules must not be followed. */
function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) walk(full, visit);
    } else if (e.isFile()) {
      visit(full);
    }
  }
}

const rel = (p) => path.relative(repoRoot, p);

/**
 * The ENGRAM twin was 26+ files under extensions/tinkerclaw-total-recall/src/ duplicating
 * src/memory/engram/. Detect a re-vendoring by NAME, anywhere under extensions/, rather than by
 * that one path — the next copy will land somewhere else. Extend this list when a new module
 * becomes load-bearing enough that a copy of it would hurt.
 */
const ENGRAM_SENTINELS = new Set([
  "event-store.ts",
  "retrieval-integration.ts",
  "pointer-compaction.ts",
  "sleep-consolidation.ts",
]);
const ENGRAM_CROSSING = "src/plugin-sdk/memory-engram.ts";
const PLUGIN_SDK_ENTRYPOINTS = "scripts/lib/plugin-sdk-entrypoints.json";

const CHECKS = {
  "pii-re": {
    title: "the leak-grep pattern has exactly one definition (collapsed 3 -> 1 on 2026-08-03)",
    run() {
      const hits = [];
      walk(repoRoot, (f) => {
        if (!f.endsWith(".sh")) return;
        let src;
        try {
          src = readFileSync(f, "utf8");
        } catch {
          return;
        }
        if (/^PII_RE=/m.test(src)) hits.push(rel(f));
      });
      if (hits.length === 1) return { ok: true, note: hits[0] };
      return {
        ok: false,
        problems: [
          `expected 1 PII_RE definition, found ${hits.length}:\n  ${hits.join("\n  ") || "(none)"}\n` +
            "One copy of this pattern once lived in the PRIVATE repo and was called canonical, so a\n" +
            "contributor cloning the public fork had no pattern and a silently-passing leak gate.",
        ],
      };
    },
  },

  "chrome-extension": {
    title: "the chrome extension has exactly one tree (collapsed 2 -> 1 on 2026-08-03)",
    run() {
      const trees = [];
      walk(repoRoot, (f) => {
        if (path.basename(f) !== "manifest.json") return;
        if (!f.includes("chrome-extension")) return;
        trees.push(rel(path.dirname(f)));
      });
      if (trees.length === 1) return { ok: true, note: trees[0] };
      return {
        ok: false,
        problems: [
          `expected 1 chrome-extension tree, found ${trees.length}:\n  ${trees.join("\n  ") || "(none)"}\n` +
            "Last time there were two, the CLI installed the OLDER one — host_permissions limited to\n" +
            "localhost — and six weeks of relay work never shipped.",
        ],
      };
    },
  },

  engram: {
    title:
      "the ENGRAM library is not vendored back into an extension, and its sanctioned crossing still exists",
    run() {
      const problems = [];
      const dupes = [];
      walk(path.join(repoRoot, "extensions"), (f) => {
        if (ENGRAM_SENTINELS.has(path.basename(f))) dupes.push(rel(f));
      });
      if (dupes.length) {
        problems.push(
          `ENGRAM modules re-vendored under extensions/:\n  ${dupes.join("\n  ")}\n` +
            "Import from openclaw/plugin-sdk/memory-engram instead. A private copy is bounded in\n" +
            "space and UNBOUNDED IN TIME — it cannot drift-check itself (FOUNDATION #9).",
        );
      }
      if (!existsSync(path.join(repoRoot, ENGRAM_CROSSING))) {
        problems.push(
          `${ENGRAM_CROSSING} is gone — the boundary has no crossing again, so the next author's\n` +
            "only remaining option is the copy. Ship the crossing with the rule, never after it.",
        );
      } else {
        let registry = "";
        try {
          registry = readFileSync(path.join(repoRoot, PLUGIN_SDK_ENTRYPOINTS), "utf8");
        } catch {
          /* a missing registry is reported by the includes() check below */
        }
        if (!registry.includes('"memory-engram"')) {
          problems.push(
            `memory-engram is not a registered plugin-sdk entrypoint in ${PLUGIN_SDK_ENTRYPOINTS} —\n` +
              "the subpath exists but does not resolve for anyone consuming the package.",
          );
        }
      }
      return problems.length
        ? { ok: false, problems }
        : { ok: true, note: `0 re-vendored modules; crossing ${ENGRAM_CROSSING} registered` };
    },
  },
};

const requested = (process.argv.find((a) => a.startsWith("--check=")) ?? "").slice(8);
if (requested && !CHECKS[requested]) {
  console.error(`unknown --check=${requested}; known: ${Object.keys(CHECKS).join(", ")}`);
  process.exit(2);
}

let failed = false;
for (const [name, check] of Object.entries(CHECKS)) {
  if (requested && requested !== name) continue;
  const result = check.run();
  if (result.ok) {
    console.log(`${name}: OK — ${result.note}`);
  } else {
    failed = true;
    console.error(`${name}: FAILED — ${check.title}`);
    for (const p of result.problems) console.error(`  ${p.split("\n").join("\n  ")}`);
  }
}

process.exit(failed ? 1 : 0);
