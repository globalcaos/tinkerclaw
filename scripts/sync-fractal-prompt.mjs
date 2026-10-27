#!/usr/bin/env node
/**
 * sync-fractal-prompt.mjs — regenerate tinker-ui/src/fractal-doctrine.generated.ts
 * (FRACTAL_DOCTRINE_CORE, FRACTAL_CHAPTERS) from its sources of truth:
 * extensions/tinkerclaw-fractal-reflection/fractal-prompt.md (the core) and
 * extensions/tinkerclaw-fractal-reflection/chapters/{correction,friction,delivery,channel}.md.
 *
 * FORK 2026-10-09 (Fractal v2, P1) — was: rewrite the FRACTAL_DOCTRINE literal inside
 * tinker-ui/src/app.ts. It now writes its own module and never touches app.ts, which imports
 * from it (see check-fractal-prompt-sync.mjs for why).
 *
 * Edit the .md files, run this, commit them with the generated file.
 * `scripts/check-fractal-prompt-sync.mjs` enforces that they never drift.
 * `--root <dir>` works on another tree (tests use a temp copy).
 */
import fs from "node:fs";
import path from "node:path";
import {
  GENERATED_REL,
  readDoctrineSources,
  renderDoctrineModule,
  rootFromArgv,
} from "./check-fractal-prompt-sync.mjs";

const root = rootFromArgv();
const sources = readDoctrineSources(root);
const next = renderDoctrineModule(sources);
const out = path.join(root, GENERATED_REL);

const prev = fs.existsSync(out) ? fs.readFileSync(out, "utf-8") : null;
if (prev === next) {
  console.log("already in sync — nothing to do");
  process.exit(0);
}
fs.writeFileSync(out, next);
const total =
  sources.core.length + Object.values(sources.chapters).reduce((n, c) => n + c.length, 0);
console.log(
  `synced: ${GENERATED_REL} (core ${sources.core.length} chars, core + chapters ${total} chars)`,
);
