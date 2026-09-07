#!/usr/bin/env node
/**
 * sync-fractal-prompt.mjs — regenerate the live FRACTAL_DOCTRINE constant in
 * tinker-ui/src/app.ts from its source of truth,
 * extensions/tinkerclaw-fractal-reflection/fractal-prompt.md.
 *
 * Edit the .md, run this, commit both. `scripts/check-fractal-prompt-sync.mjs`
 * enforces that they never drift (see that file for why this matters).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctrineFromMarkdown } from "./check-fractal-prompt-sync.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MD = path.join(ROOT, "extensions/tinkerclaw-fractal-reflection/fractal-prompt.md");
const APP = path.join(ROOT, "tinker-ui/src/app.ts");

const doctrine = doctrineFromMarkdown(fs.readFileSync(MD, "utf-8"));
const escaped = doctrine.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const src = fs.readFileSync(APP, "utf-8");
const start = src.indexOf("const FRACTAL_DOCTRINE = String.raw`");
if (start === -1) {
  console.error("FAIL: FRACTAL_DOCTRINE constant not found in app.ts — add it first");
  process.exit(1);
}
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
const next = src.slice(0, open) + escaped + src.slice(i);
if (next === src) {
  console.log("already in sync — nothing to do");
  process.exit(0);
}
fs.writeFileSync(APP, next);
console.log(`synced: ${doctrine.length} chars written into FRACTAL_DOCTRINE`);
