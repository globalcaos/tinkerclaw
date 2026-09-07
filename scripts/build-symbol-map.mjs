#!/usr/bin/env node
import { execSync } from "node:child_process";
/**
 * build-symbol-map.mjs — generate a greppable symbol -> file:line index for the fork.
 *
 * WHY THIS EXISTS (measured, not assumed):
 *   Over 2,159 sessions, re-fetching something already read in the same session accounted for
 *   26,329 retrieval turns. The single largest target was the directory `~/src/tinkerclaw`
 *   itself — 5,914 re-searches — i.e. repeated `grep -r` across the tree because nothing answers
 *   "where does X live" without a search. Each grep costs a full turn (~176K cache-read tokens),
 *   so N greps cost N turns regardless of how little text each returns.
 *   Evidence: ~/.openclaw/workspace/memory/co-access/refetch-anatomy.json
 *
 * WHAT IT PRODUCES
 *   docs/SYMBOLS.tsv  — one line per exported symbol: `symbol<TAB>path:line<TAB>kind`.
 *                       Large by design and NEVER meant to be read whole — it is grepped.
 *                       One grep here replaces a tree-wide grep.
 *   docs/SYMBOLS.md   — the small entry point: how to use it, and the directory purpose map.
 *
 * DERIVED, NOT FROZEN (J16 Pillar 1): re-run this after any refactor. The map states its own
 * generation command and commit so a stale copy is detectable rather than silently wrong.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ROOTS = ["src", "extensions", "scripts", "tinker-ui/src"];
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  "__pycache__",
  ".next",
  "out",
  "vendor",
  "fixtures",
  "__snapshots__",
]);
const EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".py"]);

/** Exported/top-level declarations only — internals would drown the signal. */
const PATTERNS = [
  [/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "fn"],
  [/^export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "const"],
  [/^export\s+interface\s+([A-Za-z_$][\w$]*)/, "iface"],
  [/^export\s+type\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^export\s+enum\s+([A-Za-z_$][\w$]*)/, "enum"],
  [/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "fn-local"],
  [/^def\s+([A-Za-z_][\w]*)/, "py-def"],
  [/^class\s+([A-Za-z_][\w]*)/, "py-class"],
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".claude") continue;
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(extname(e.name)) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const rows = [];
let files = 0,
  skippedBig = 0;
for (const r of ROOTS) {
  for (const f of walk(join(ROOT, r))) {
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (st.size > 3_000_000) {
      skippedBig++;
      continue;
    }
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    files++;
    const rel = relative(ROOT, f);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 400) continue;
      for (const [re, kind] of PATTERNS) {
        const m = re.exec(line);
        if (m) {
          rows.push(`${m[1]}\t${rel}:${i + 1}\t${kind}`);
          break;
        }
      }
    }
  }
}
rows.sort();

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
} catch {}
const stamp = new Date().toISOString().slice(0, 10);

mkdirSync(join(ROOT, "docs"), { recursive: true });
writeFileSync(
  join(ROOT, "docs/SYMBOLS.tsv"),
  `# symbol\tpath:line\tkind — generated ${stamp} @ ${commit} by scripts/build-symbol-map.mjs\n` +
    `# GREP THIS FILE. Do not read it whole.\n` +
    rows.join("\n") +
    "\n",
);

const dirs = new Map();
for (const r of rows) {
  const d = r.split("\t")[1].split("/").slice(0, 2).join("/");
  dirs.set(d, (dirs.get(d) || 0) + 1);
}
const top = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);

writeFileSync(
  join(ROOT, "docs/SYMBOLS.md"),
  `# Symbol map — find code without grepping the tree

**What this is for.** Answering *"where does \`X\` live?"* in **one** lookup instead of a tree-wide
search. Measured cause: \`~/src/tinkerclaw\` was re-searched **5,914 times** across 2,159 sessions —
the largest single item in the retrieval budget. A grep costs a whole turn whatever it returns, so
the fix is fewer searches, not cheaper ones.

**How to use it — grep the TSV, never read it whole:**

\`\`\`bash
grep -P '^performGatewaySessionReset\\t' ~/src/tinkerclaw/docs/SYMBOLS.tsv   # exact symbol
grep -iP '^[^\\t]*sessionreset' ~/src/tinkerclaw/docs/SYMBOLS.tsv           # fuzzy
\`\`\`

Format: \`symbol<TAB>path:line<TAB>kind\`. **${rows.length.toLocaleString()} symbols** across
**${files.toLocaleString()} source files**.

**Provenance.** Generated ${stamp} at commit \`${commit}\` by \`scripts/build-symbol-map.mjs\`.
Exported declarations plus top-level \`function\`/\`def\`/\`class\`; excludes \`node_modules\`,
\`dist\`, \`.d.ts\` and files over 3 MB (${skippedBig} skipped).

**How to update.** Re-run after any refactor — it is derived, not frozen (J16 Pillar 1):

\`\`\`bash
node ~/src/tinkerclaw/scripts/build-symbol-map.mjs
\`\`\`

**What it does NOT cover.** Local (non-exported) helpers, symbols built by string concatenation,
runtime-registered names, and anything in \`dist/\`. A miss here means fall back to a tree grep —
but check the map first.

## Where symbols live

| directory | symbols |
|---|---|
${top.map(([d, n]) => `| \`${d}\` | ${n.toLocaleString()} |`).join("\n")}
`,
);

console.log(`files scanned : ${files}`);
console.log(`symbols       : ${rows.length}`);
console.log(`skipped >3MB  : ${skippedBig}`);
console.log(`wrote docs/SYMBOLS.tsv and docs/SYMBOLS.md @ ${commit}`);
