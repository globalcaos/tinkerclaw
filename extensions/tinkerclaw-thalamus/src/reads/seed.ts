// Seeding the enhancement cards from what is installed (design doc section 13A.5; paper P§7.1).
//
// WHAT THIS IS FOR. The registry (`getUsageRegistry().list()`) says which skills and recipes exist and where.
// A card needs more: what each was made for. That text is already in the file's frontmatter, so it is read from
// there and never written by hand: a skill's `description`, a recipe's `summary` and its `triggers` (or, where
// it has none, its `tags`). The card's `structure` line starts empty and is filled by the nightly writer or the
// owner, so the seed makes no claim about how an enhancement works.
//
// Reads only the head of each file. Nothing is sent anywhere from here.

import { closeSync, openSync, readSync } from "node:fs";
import {
  seedCards,
  type EnhancementCard,
  type EnhancementListing,
} from "openclaw/plugin-sdk/fork-thalamus";

/** What `UsageRegistry.list()` returns. */
export type RegistryListing = { kind: "skill" | "recipe" | "plugin"; name: string; path: string };

const HEAD_BYTES = 8 * 1024;
const MAX_TRIGGERS = 12;

export function readHead(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const unquote = (s: string): string =>
  s
    .trim()
    .replace(/^(["'])([\s\S]*)\1$/, "$2")
    .trim();

/** Split on commas that are not inside quotes. */
function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function listFrom(text: string): string[] {
  const t = text.trim();
  if (t.startsWith("[")) {
    return splitOutsideQuotes(t.replace(/^\[|\]\s*$/g, ""))
      .map((x) => unquote(x.replace(/\s+/g, " ")))
      .filter(Boolean);
  }
  const dashed = t
    .split(/\r?\n/)
    .map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined)
    .map(unquote);
  if (dashed.length > 0) return dashed.filter(Boolean);
  return splitOutsideQuotes(t).map(unquote).filter(Boolean);
}

/** The top-level `key: value` pairs of a `---` block. Values are a string or, for lists, an array. */
export function parseFrontmatter(text: string): Record<string, string | string[]> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const cont: string[] = [];
    let j = i + 1;
    while (j < lines.length && (/^\s+/.test(lines[j]) || lines[j].trim() === ""))
      cont.push(lines[j++]);
    const head = kv[2].trim();
    const block = cont.join("\n").trim();
    if (/^[>|][+-]?$/.test(head) || head === "") {
      if (block.startsWith("[") || /^-\s/.test(block)) out[kv[1]] = listFrom(block);
      else if (block)
        out[kv[1]] = block
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" ");
    } else if (head.startsWith("[")) {
      out[kv[1]] = listFrom(`${head}\n${block}`);
    } else {
      out[kv[1]] = unquote(head);
    }
    i = j - 1;
  }
  return out;
}

const asText = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v.join("; ") : v?.trim() || undefined;
const asList = (v: string | string[] | undefined): string[] | undefined =>
  Array.isArray(v) ? v : v ? listFrom(v) : undefined;

/** A plugin manifest is JSON that may be longer than the head we read, so its description is found by pattern. */
export function manifestDescription(text: string | undefined): string | undefined {
  const m = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text ?? "");
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

/** Add the text each card needs to a registry listing. A file that cannot be read still gets its name. */
export function listingWithText(
  list: readonly RegistryListing[],
  read: (path: string) => string | undefined = readHead,
): EnhancementListing[] {
  return list.map((l) => {
    if (l.kind === "plugin") {
      return {
        kind: "plugin" as const,
        name: l.name,
        ...(l.path ? { path: l.path } : {}),
        description: l.path ? manifestDescription(read(l.path)) : undefined,
      };
    }
    const fm = parseFrontmatter(read(l.path) ?? "");
    if (l.kind === "skill") {
      return {
        kind: "skill" as const,
        name: l.name,
        path: l.path,
        description: asText(fm.description),
      };
    }
    return {
      kind: "recipe" as const,
      name: l.name,
      path: l.path,
      description: asText(fm.summary) ?? asText(fm.description),
      triggers: (asList(fm.triggers) ?? asList(fm.tags))?.slice(0, MAX_TRIGGERS),
    };
  });
}

export function seedFromRegistry(
  list: readonly RegistryListing[],
  read?: (path: string) => string | undefined,
): EnhancementCard[] {
  return seedCards(listingWithText(list, read));
}
