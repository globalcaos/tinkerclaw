#!/usr/bin/env node
/**
 * logging.md §4 — the event catalog in the bible and its executable encoding,
 * src/infra/events/catalog.ts, declare the SAME events, in BOTH directions.
 *
 * §4 is the a-priori declaration (an event exists in the doc before any code emits it — L2);
 * catalog.ts is what the writer will actually enforce. This file only checks that the two still
 * agree — the same shape and reasoning as index-files-table.mjs: the bible EXPLAINS, the running
 * code ENFORCES, and `scripts/bible/*.mjs` CHECKS that the two still agree.
 *
 * DERIVED, NOT FROZEN (design-principles.md #19, #20): no row count is asserted anywhere — the
 * doc said 66 events on 2026-09-24 and that number may move. Both sets are re-derived on every
 * run and both directions are load-bearing:
 *   - a name only in code could be emitted without the bible ever declaring it (L2 broken);
 *   - a name only in §4 is declared-but-unemittable — the writer would drop it as unknown;
 *   - a kind/retention disagreement means one side lies about what a row is or how long it lives.
 *
 * catalog.ts is parsed TEXTUALLY (this runs under plain node, with no TypeScript loader): every
 * row keeps its first three properties double-quoted, each on its own line, in declaration order
 * — the format contract stated at the top of that file and enforced by catalog.test.ts.
 *
 * Usage: node scripts/bible/logging-catalog.mjs [catalogTsPath] [loggingMdPath]
 * Exit 0 = the two catalogs match. Exit 1 = drift, with both lists on stderr.
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVENT_KINDS = new Set(["sample", "span", "transition", "outcome", "rollup", "mark"]);
const RETENTION_CLASSES = new Set(["hot", "event", "research", "debug"]);

/** catalog.ts source text → Map(name → {kind, retention}). Throws on a malformed row. */
export function parseCodeCatalog(source) {
  const rows = new Map();
  let current = null;
  const finish = () => {
    if (!current) {
      return;
    }
    if (!current.kind || !current.retention) {
      throw new Error(
        `catalog.ts row \`${current.name}\` is missing its quoted ${
          current.kind ? "retention" : "kind"
        } line — the format contract at the top of catalog.ts is broken`,
      );
    }
    if (rows.has(current.name)) {
      throw new Error(`catalog.ts declares \`${current.name}\` twice`);
    }
    rows.set(current.name, { kind: current.kind, retention: current.retention });
    current = null;
  };
  for (const line of source.split("\n")) {
    let m = /^\s*name:\s*"([^"]+)",?\s*$/.exec(line);
    if (m) {
      finish();
      current = { name: m[1], kind: null, retention: null };
      continue;
    }
    if (!current) {
      continue;
    }
    m = /^\s*kind:\s*"([^"]+)",?\s*$/.exec(line);
    if (m) {
      if (!EVENT_KINDS.has(m[1])) {
        throw new Error(`catalog.ts \`${current.name}\`: unknown kind "${m[1]}"`);
      }
      current.kind = m[1];
      continue;
    }
    m = /^\s*retention:\s*"([^"]+)",?\s*$/.exec(line);
    if (m) {
      if (!RETENTION_CLASSES.has(m[1])) {
        throw new Error(`catalog.ts \`${current.name}\`: unknown retention "${m[1]}"`);
      }
      current.retention = m[1];
    }
  }
  finish();
  if (rows.size === 0) {
    throw new Error("no rows parsed from catalog.ts — the name/kind/retention line format is gone");
  }
  return rows;
}

/** logging.md source → Map(name → {kind, retention}) from the §4 rows between the markers. */
export function parseDocCatalog(markdown) {
  const begin = "<!-- catalog:begin -->";
  const end = "<!-- catalog:end -->";
  const from = markdown.indexOf(begin);
  const to = markdown.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error("logging.md no longer has the catalog begin/end markers around §4");
  }
  const rows = new Map();
  for (const raw of markdown.slice(from + begin.length, to).split("\n")) {
    if (!raw.startsWith("| `")) {
      continue;
    }
    const cells = raw
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length !== 7) {
      throw new Error(`§4 row without exactly 7 cells: ${raw.slice(0, 60)}…`);
    }
    const name = cells[0].replaceAll("`", "");
    if (rows.has(name)) {
      throw new Error(`§4 declares \`${name}\` twice`);
    }
    rows.set(name, { kind: cells[1], retention: cells[5] });
  }
  if (rows.size === 0) {
    throw new Error("no catalog rows between the §4 markers");
  }
  return rows;
}

/** Stable byte-order compare, so the drift lists read the same on every machine and locale. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Both directions of name presence, plus per-name kind/retention agreement. */
export function compareCatalogs(code, doc) {
  const onlyInCode = [...code.keys()].filter((n) => !doc.has(n)).toSorted(byCodeUnit);
  const onlyInDoc = [...doc.keys()].filter((n) => !code.has(n)).toSorted(byCodeUnit);
  const mismatched = [...code.keys()]
    .filter((n) => doc.has(n))
    .toSorted(byCodeUnit)
    .map((n) => ({ name: n, code: code.get(n), doc: doc.get(n) }))
    .filter((r) => r.code.kind !== r.doc.kind || r.code.retention !== r.doc.retention);
  return { onlyInCode, onlyInDoc, mismatched };
}

function main() {
  // Resolved from THIS file's location, never from $HOME: the check must hold in a git worktree
  // or a clone on another machine — FOUNDATION #9 applied to the gate itself.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tsPath = process.argv[2] ?? path.join(repoRoot, "src", "infra", "events", "catalog.ts");
  const mdPath = process.argv[3] ?? path.join(repoRoot, "TINKER_UI_DESIGN_BIBLE", "logging.md");

  let code;
  let doc;
  try {
    code = parseCodeCatalog(readFileSync(tsPath, "utf8"));
    doc = parseDocCatalog(readFileSync(mdPath, "utf8"));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { onlyInCode, onlyInDoc, mismatched } = compareCatalogs(code, doc);
  if (onlyInCode.length || onlyInDoc.length || mismatched.length) {
    console.error(
      "logging.md §4 and src/infra/events/catalog.ts no longer declare the same events.\n",
    );
    if (onlyInCode.length) {
      console.error(
        `  events in code with no §4 row: ${JSON.stringify(onlyInCode)}\n` +
          "    → emittable without ever being declared (L2); add the §4 row or drop the code row.",
      );
    }
    if (onlyInDoc.length) {
      console.error(
        `  §4 rows with no code row: ${JSON.stringify(onlyInDoc)}\n` +
          "    → declared but unemittable — the writer counts the name as unknown; add it to catalog.ts.",
      );
    }
    for (const m of mismatched) {
      console.error(
        `  \`${m.name}\`: code says ${m.code.kind}/${m.code.retention}, §4 says ` +
          `${m.doc.kind}/${m.doc.retention} — one of them lies; fix both sides in the same change.`,
      );
    }
    process.exit(1);
  }

  console.log(
    `logging catalog: ${doc.size} event(s) in §4, ${code.size} in code — ` +
      "names, kinds and retention all agree.",
  );
}

/**
 * True only when this module is the process entry, so importing its parsers never runs the gate.
 * Compares REAL paths, as scripts/test-invariants.mjs `isEntryPoint` does: Node resolves the
 * entry's `import.meta.url` through symlinks while `process.argv[1]` keeps the path as typed, so a
 * plain URL comparison is false when the script (or a parent directory) is reached through a
 * symlink — and the gate would exit 0 having checked nothing. catalog.test.ts runs it through one.
 */
function isEntryPoint(argv1 = process.argv[1]) {
  if (!argv1) {
    return false;
  }
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  main();
}
