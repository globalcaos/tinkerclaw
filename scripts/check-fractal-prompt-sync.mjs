#!/usr/bin/env node
/**
 * check-fractal-prompt-sync.mjs — fail if the live FRACTAL doctrine has drifted
 * from its source-of-truth markdown.
 *
 * WHY THIS EXISTS (2026-08-22). The fractal doctrine existed in four places and
 * only one of them was live:
 *   - extensions/tinkerclaw-fractal-reflection/fractal-prompt.md  → read by NOTHING
 *   - src/fork/fractal-prompt.md                                  → read by a dead path
 *   - extensions/tinkerclaw-fractal-reflection/triage-prompt.md   → live (triage judge)
 *   - a string literal in tinker-ui/src/app.ts                    → live (what the model sees)
 * So the doctrine was edited carefully for months in files that changed nothing,
 * while the live copy silently eroded from 24.7 KB to 1.4 KB. A prompt file with
 * no loader is a decoy that absorbs work and produces no behaviour change.
 *
 * The fix: app.ts holds FRACTAL_DOCTRINE, generated from the .md, and this check
 * asserts they still match. Edit the .md, re-run `node scripts/sync-fractal-prompt.mjs`,
 * commit both.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MD = path.join(ROOT, "extensions/tinkerclaw-fractal-reflection/fractal-prompt.md");
const APP = path.join(ROOT, "tinker-ui/src/app.ts");

/** Strip the parts of the .md that describe the file rather than instruct the model. */
export function doctrineFromMarkdown(raw) {
  let doc = raw;
  // strip ANY leading blockquote status banner (⚠️ orphan / ✅ live / future variants)
  doc = doc.replace(/^(?:>[^\n]*\n)+\n/m, "");
  doc = doc.replace(/^v\d+ \(\d{4}-\d{2}-\d{2}\)\. Lineage:[\s\S]*?\n\n/m, "");
  doc = doc.replace(
    "Deliberately free of host-harness vocabulary so it rides any delivery channel.\n\n",
    "",
  );
  doc = doc.replace("# FRACTAL — the slow thinker\n\n", "");
  return doc.trim();
}

function doctrineFromApp(src) {
  const start = src.indexOf("const FRACTAL_DOCTRINE = String.raw`");
  if (start === -1) return null;
  const open = src.indexOf("`", start) + 1;
  let i = open;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") break;
    i++;
  }
  return src
    .slice(open, i)
    .replace(/\\`/g, "`")
    .replace(/\\\$\{/g, "${")
    .replace(/\\\\/g, "\\");
}

// Only run the check when invoked directly — sync-fractal-prompt.mjs imports
// doctrineFromMarkdown from here, and top-level process.exit() would kill it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = doctrineFromMarkdown(fs.readFileSync(MD, "utf-8"));
  const actual = doctrineFromApp(fs.readFileSync(APP, "utf-8"));

  if (actual === null) {
    console.error("FAIL: FRACTAL_DOCTRINE constant not found in tinker-ui/src/app.ts");
    process.exit(1);
  }
  if (actual !== expected) {
    console.error("FAIL: the live FRACTAL doctrine has drifted from fractal-prompt.md");
    console.error(`  markdown: ${expected.length} chars`);
    console.error(`  app.ts:   ${actual.length} chars`);
    const n = Math.min(expected.length, actual.length);
    let d = 0;
    while (d < n && expected[d] === actual[d]) d++;
    console.error(`  first difference at char ${d}:`);
    console.error(`    md : …${JSON.stringify(expected.slice(Math.max(0, d - 40), d + 60))}`);
    console.error(`    app: …${JSON.stringify(actual.slice(Math.max(0, d - 40), d + 60))}`);
    console.error("  → run: node scripts/sync-fractal-prompt.mjs");
    process.exit(1);
  }
  // 2026-08-22: the user bubble links straight to the .md via FRACTAL_PROMPT_PATH.
  // A link that points at a DIFFERENT copy of the doctrine than the one generating
  // FRACTAL_DOCTRINE is the same decoy failure this file exists to catch, so pin it.
  const appSrc = fs.readFileSync(APP, "utf-8");
  const rel = path.relative(ROOT, MD);
  if (!appSrc.includes(`"~/src/tinkerclaw/${rel}"`)) {
    console.error(`FAIL: FRACTAL_PROMPT_PATH in app.ts does not point at ~/src/tinkerclaw/${rel}`);
    console.error("  → the user bubble's 'fractal prompt' link would open the wrong file");
    process.exit(1);
  }
  console.log(`OK: FRACTAL doctrine in sync (${expected.length} chars, injected per message)`);
}
