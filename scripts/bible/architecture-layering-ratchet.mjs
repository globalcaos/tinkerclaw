#!/usr/bin/env node
/**
 * architecture.md §Layering rules / V6 — "src/ MUST NOT import from extensions/" — made executable.
 *
 * The RULE lives in TINKER_UI_DESIGN_BIBLE/architecture.md and is the authority. This file is only
 * one ENCODING of it, deliberately kept out of the markdown (FOUNDATION.md, "Three different jobs,
 * three different homes": explain in the bible, enforce in running code, CHECK in
 * scripts/bible/*.mjs behind a one-line `cmd:` pointer).
 *
 * The rule is DIRECTIONAL and does not hold yet, so it is RATCHETED rather than asserted — a
 * comfortable lie that passes is worse than a debt that is counted. It is a SET check, not a count,
 * and it ratchets in BOTH directions:
 *   ADDED   — a violator that is not in KNOWN fails, so nobody writes a seventh;
 *   RETIRED — a KNOWN entry that no longer violates ALSO fails, so a paid debt leaves the set.
 *
 * History this check carries — do not lose it. The inline version it replaces (architecture.md
 * frontmatter, measured 2026-08-03) was wrong in both directions at once, and the two errors
 * cancelled into a green gate:
 *
 *   TOO NARROW — it matched only `from "…"`. The dynamic
 *     `await import("../../extensions/tinkerclaw-tinker-bridge/src/tool-buffer.js")` at
 *     src/fork/attempt-hooks.ts:921 was therefore invisible. Deferring the import softens the
 *     coupling (the runner boots without the extension); it does not remove the dependency.
 *
 *   TOO BROAD — src/fork/process-message-hooks.ts stayed in KNOWN after the architect removed its
 *     reverse dependency on 2026-08-04 (that file's own header narrates the removal, and the
 *     TS2339 build break that paid for it). A stale KNOWN entry is not a harmless leftover: it is
 *     a standing permission slip, so re-adding that exact import would have passed silently.
 *
 * Net effect: the violator SET had already been swapped — one out, one in — while the total stayed
 * at six. That substitution is precisely what the inline comment claimed to defend against, and it
 * went unnoticed for as long as the check only ever asked "is anything NEW here?".
 *
 * It also RESOLVES specifiers instead of pattern-matching them, which fixes a hole in BOTH
 * directions:
 *   - the inline version needed a `(?<!pi-)` lookbehind to stop `src/agents/pi-extensions/…` from
 *     matching the substring `extensions/`. Resolution retires the hack, because that path lands
 *     under src/ and so is not a crossing at all;
 *   - conversely, a substring match cannot see a crossing that never spells the word. tsconfig.json
 *     maps `@openclaw/*` onto `./extensions/*` (and `@openclaw/whatsapp*` onto the WhatsApp
 *     extension), so `import … from "@openclaw/whatsapp/src/history/index.js"` inside src/ is a
 *     real violation that the old regex waved through — a one-keystroke bypass of the whole
 *     ratchet. Bare specifiers are therefore resolved through the tsconfig `paths` table, longest
 *     matching pattern wins, exactly as TypeScript resolves them. No src/ file uses that route
 *     today (measured 2026-08-04); the point is that it is closed before one does.
 *
 * When this script and architecture.md disagree, architecture.md is right and this file is the bug.
 *
 * Usage:
 *   node scripts/bible/architecture-layering-ratchet.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(repoRoot, "src");
const EXTENSIONS = path.join(repoRoot, "extensions") + path.sep;

/**
 * The legacy violators, re-measured 2026-08-04. This set may only SHRINK — enlarging it is not a
 * fix, it is a seventh place where core depends on an optional component. To retire one, move the
 * shared code down into src/ and import it from both sides, or invert the dependency so the
 * extension registers into a src/ registry (the setIngestionRuntime / setLinkBuilderRuntime
 * pattern in src/agents/embedded-agent-runner/extensions.ts) — then delete its line here.
 */
const KNOWN = new Set([
  "src/agents/pi-extensions/cortex-runtime.ts",
  "src/agents/pi-extensions/limbic-runtime.ts",
  "src/agents/pi-extensions/synapse-runtime.ts",
  "src/agents/tools/whatsapp-history-tool.ts",
  "src/fork/attempt-hooks.ts",
  "src/plugin-sdk/ollama.ts",
]);

/** Pruned DURING the walk, never after: a recursive glob over a node_modules tree hangs the gate. */
const PRUNE = new Set(["node_modules", "dist", "dist-runtime", ".git", "coverage"]);
const SKIP_FILE = /\.test\.|__tests__|\.d\.ts$/;

/** Static `import|export … from "x"`, plus dynamic `import("x")` and `require("x")`. */
const SPEC =
  /(?:^|\n)[ \t]*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Same contract as Python's `assert cond, msg`: message to stderr, non-zero exit. */
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * tsconfig `paths` as a prefix table: { prefix, intoExtensions }. TypeScript picks the LONGEST
 * matching pattern, which is why `@openclaw/plugin-sdk/*` (-> src/) must beat `@openclaw/*`
 * (-> extensions/) for a plugin-sdk subpath. Parse failure degrades to "no aliases" rather than
 * throwing: a missing tsconfig must not turn the layering gate into a crash.
 */
function loadAliasTable() {
  let paths;
  try {
    paths = JSON.parse(readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8")).compilerOptions
      ?.paths;
  } catch {
    return [];
  }
  const table = [];
  for (const [pattern, targets] of Object.entries(paths ?? {})) {
    const intoExtensions = (Array.isArray(targets) ? targets : []).some((t) => {
      const literal = path.normalize(path.join(repoRoot, String(t).split("*")[0]));
      return (literal + path.sep).startsWith(EXTENSIONS);
    });
    table.push({ prefix: pattern.split("*")[0], intoExtensions });
  }
  return table;
}
const ALIASES = loadAliasTable();

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) walkTs(full, out);
    } else if ((e.name.endsWith(".ts") || e.name.endsWith(".tsx")) && !SKIP_FILE.test(full)) {
      out.push(full);
    }
  }
  return out;
}

/** A specifier crosses the boundary when it RESOLVES under the repo's extensions/ tree. */
function crossesIntoExtensions(file, spec) {
  if (!spec.startsWith(".")) {
    let best = null;
    for (const a of ALIASES) {
      if (!spec.startsWith(a.prefix)) continue;
      if (!best || a.prefix.length > best.prefix.length) best = a;
    }
    return best ? best.intoExtensions : false;
  }
  const target = path.normalize(path.join(path.dirname(file), spec));
  return (target + path.sep).startsWith(EXTENSIONS);
}

const found = new Map();
for (const file of walkTs(SRC)) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1] ?? m[2];
    if (!crossesIntoExtensions(file, spec)) continue;
    const rel = path.relative(repoRoot, file);
    if (!found.has(rel)) found.set(rel, new Set());
    found.get(rel).add(spec);
  }
}

const added = [...found.keys()].filter((f) => !KNOWN.has(f)).sort();
const retired = [...KNOWN].filter((f) => !found.has(f)).sort();

const problems = [];
if (added.length) {
  problems.push(
    `NEW violator(s) ${JSON.stringify(added)} — src/ must not import from extensions/. Invert it: ` +
      "let the plugin register into core at load time (the setIngestionRuntime pattern in " +
      "src/agents/embedded-agent-runner/extensions.ts), or move the shared code down into src/ " +
      "where extensions may reach it. See architecture.md#layering-rules.",
  );
}
if (retired.length) {
  problems.push(
    `KNOWN entr(ies) that no longer violate ${JSON.stringify(retired)} — the debt was paid, so ` +
      "delete those lines from KNOWN in this script and from V6 in architecture.md. Leaving them " +
      "is a standing permission slip: the ratchet would not notice the import coming back.",
  );
}
must(!problems.length, `architecture.md V6 (layering ratchet) — ${problems.join(" || ")}`);

console.log(
  `architecture V6: ${found.size} legacy src/ -> extensions/ violator(s), exactly the known set ` +
    "(none added, none stale).",
);
