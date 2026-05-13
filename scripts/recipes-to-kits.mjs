#!/usr/bin/env node
// scripts/recipes-to-kits.mjs — one-shot: recipes/<cat>/<name>.md → kits/<slug>/kit.md (kit/1.0)
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extensions/tinkerclaw-prefrontal/recipes");
const DST = path.join(ROOT, "extensions/tinkerclaw-prefrontal/kits");
const OWNER = "globalcaos";

async function main() {
  await fs.mkdir(DST, { recursive: true });
  const cats = await fs.readdir(SRC).catch(() => []);
  let migrated = 0;
  for (const cat of cats) {
    if (cat === "CATALOG.md") continue;
    const catPath = path.join(SRC, cat);
    const stat = await fs.stat(catPath).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const files = await fs.readdir(catPath);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const srcPath = path.join(catPath, file);
      const text = await fs.readFile(srcPath, "utf-8");
      const m = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/.exec(text);
      if (!m) {
        console.warn(`skip ${srcPath}: no frontmatter`);
        continue;
      }
      const fm = parseYaml(m[1]);
      const body = m[2];
      const slug = fm.id || path.basename(file, ".md");
      const kit = {
        schema: "kit/1.0",
        slug,
        title: fm.title ?? slug,
        summary: fm.summary ?? "",
        version: "1.0.0",
        owner: OWNER,
        license: "MIT",
        tags: Array.from(new Set([cat, ...(fm.triggers ?? [])].filter(Boolean))),
        tools: fm.tools ?? [],
        testedHarnesses: ["OpenClaw", "Claude Code"],
        model: {
          provider: "anthropic",
          name: "claude-opus-4-7",
          hosting: "cloud API — requires ANTHROPIC_API_KEY",
        },
      };
      if ((fm.triggers ?? []).length) {
        kit.resolverHints = [
          {
            match: (fm.triggers ?? []).join(" | "),
            load: ["kit.md"],
            purpose: `Pick this kit for: ${(fm.triggers ?? []).join(", ")}`,
          },
        ];
      }
      const out = `---\n${stringifyYaml(kit)}---\n${body}`;
      const dstDir = path.join(DST, slug);
      await fs.mkdir(dstDir, { recursive: true });
      await fs.writeFile(path.join(dstDir, "kit.md"), out, "utf-8");
      console.log(`migrated ${cat}/${file} → kits/${slug}/kit.md`);
      migrated++;
    }
  }
  console.log(`done. ${migrated} kit(s) written.`);
}

function parseYaml(block) {
  const out = {};
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      // Handle arrays — items may be quoted with single or double quotes
      // and may contain spaces inside quoted strings
      v = parseYamlInlineArray(v);
    } else if (v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function parseYamlInlineArray(str) {
  // str is like: [add, create, build, "new feature", 'make it']
  const inner = str.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "," && !inSingle && !inDouble) {
      const t = cur.trim();
      if (t) items.push(t);
      cur = "";
    } else {
      cur += ch;
    }
  }
  const t = cur.trim();
  if (t) items.push(t);
  return items;
}

function stringifyYaml(o) {
  const lines = [];
  for (const [k, v] of Object.entries(o)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      const items = v.map((x) => (typeof x === "string" ? JSON.stringify(x) : JSON.stringify(x)));
      lines.push(`${k}: [${items.join(", ")}]`);
    } else if (typeof v === "object") {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) {
        lines.push(`  ${k2}: ${typeof v2 === "string" ? JSON.stringify(v2) : JSON.stringify(v2)}`);
      }
    } else if (typeof v === "string") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n") + "\n";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
