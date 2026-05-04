/**
 * FORK 2026-05-04: WhatsApp inbound sender pre-resolution.
 *
 * Reads `~/.openclaw/workspace/memory/people/_aliases.json` (seeded by
 * tinkerclaw-people) and the matched `<slug>.md` so the inbound envelope can
 * inline the sender's identity, role, manual context, and recent asks BEFORE
 * dispatch. Without this Jarvis would have to call `people.resolve` mid-turn
 * for every WA message — a measurable latency hit and a frequent miss when he
 * forgets the convention.
 *
 * Self-contained on purpose: no cross-plugin import of `tinkerclaw-people`.
 * The default `peopleDir` matches `resolvePeopleConfig`'s default; if a user
 * overrides that path via plugin config, this prefetch returns null and the
 * agent falls back to the in-process `people.*` RPCs (still available).
 *
 * Cached for 60 s — reading 1 MB of aliases on every inbound is wasteful and
 * the file changes only on cron tick or manual reseed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PEOPLE_DIR = path.join(os.homedir(), ".openclaw", "workspace", "memory", "people");
const ALIASES_PATH = path.join(PEOPLE_DIR, "_aliases.json");
const ALIAS_CACHE_TTL_MS = 60_000;

type Alias = {
  displayName?: string;
  emails?: string[];
  phones?: string[];
  lids?: string[];
  names?: string[];
};
type AliasMap = Record<string, Alias>;

let cached: { at: number; aliases: AliasMap } | null = null;

function loadAliases(): AliasMap | null {
  const now = Date.now();
  if (cached && now - cached.at < ALIAS_CACHE_TTL_MS) {
    return cached.aliases;
  }
  try {
    const raw = fs.readFileSync(ALIASES_PATH, "utf-8");
    const aliases = JSON.parse(raw) as AliasMap;
    cached = { at: now, aliases };
    return aliases;
  } catch {
    return null;
  }
}

function digitsOnly(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

function findSlugByPhone(aliases: AliasMap, e164: string): string | null {
  const target = digitsOnly(e164);
  if (target.length < 9) {
    return null;
  }
  const targetSuffix = target.slice(-9);
  for (const [slug, alias] of Object.entries(aliases)) {
    for (const phone of alias.phones ?? []) {
      const pd = digitsOnly(phone);
      if (pd === target || (pd.length >= 9 && pd.endsWith(targetSuffix))) {
        return slug;
      }
    }
  }
  return null;
}

function findSlugByLid(aliases: AliasMap, lid: string): string | null {
  const lower = lid.toLowerCase();
  for (const [slug, alias] of Object.entries(aliases)) {
    if (alias.lids?.some((l) => l.toLowerCase() === lower)) {
      return slug;
    }
  }
  return null;
}

function readProfileMd(slug: string): string | null {
  try {
    return fs.readFileSync(path.join(PEOPLE_DIR, `${slug}.md`), "utf-8");
  } catch {
    return null;
  }
}

function extractSection(md: string, header: string): string {
  const re = new RegExp(`^##\\s+${header}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\z)`, "m");
  const m = md.match(re);
  return (m?.[1] ?? "").trim();
}

function isEmptyMarker(text: string): boolean {
  const t = text.trim();
  return !t || /^_?\(?(empty|none)/i.test(t.split("\n")[0] ?? "");
}

function clipLines(text: string, maxLines: number, maxChars: number): string {
  const lines = text.split("\n").slice(0, maxLines);
  let out = lines.join("\n").trim();
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 1)}…`;
  }
  return out;
}

export type SenderProfileBlock = {
  slug: string;
  displayName: string;
  block: string;
};

/**
 * Build a compact (~600 byte) profile preamble for the sender of an inbound
 * WhatsApp message. Returns null when there's no match or the people dir is
 * absent — caller should fall through to the existing hint.
 */
export function prefetchSenderProfile(params: {
  senderE164?: string;
  senderJid?: string;
}): SenderProfileBlock | null {
  const aliases = loadAliases();
  if (!aliases) return null;

  let slug: string | null = null;
  if (params.senderE164) {
    slug = findSlugByPhone(aliases, params.senderE164);
  }
  if (!slug && params.senderJid && params.senderJid.includes("@lid")) {
    slug = findSlugByLid(aliases, params.senderJid);
  }
  if (!slug) return null;

  const md = readProfileMd(slug);
  if (!md) return null;

  // Pull the four sections that matter for context grounding.
  const identity = extractSection(md, "Identity");
  const manual = extractSection(md, "Manual context");
  const summary = extractSection(md, "Rolling summary");
  const recent = extractSection(md, "Recent asks");

  const displayName =
    md.match(/^- Display name:\s*(.+)$/m)?.[1]?.trim() || aliases[slug]?.displayName || slug;
  const role = md.match(/^- Role \/ org:\s*(.+)$/m)?.[1]?.trim() ?? "";

  const parts: string[] = [];
  parts.push(`[sender-profile slug=${slug}]`);
  parts.push(`Name: ${displayName}${role ? ` — ${role}` : ""}`);
  if (!isEmptyMarker(manual)) {
    parts.push(`Manual context:\n${clipLines(manual, 6, 400)}`);
  }
  if (!isEmptyMarker(summary)) {
    parts.push(`Rolling summary (last ~30d):\n${clipLines(summary, 6, 500)}`);
  }
  if (!isEmptyMarker(recent)) {
    parts.push(`Recent asks:\n${clipLines(recent, 4, 300)}`);
  }
  parts.push(`[/sender-profile]`);
  // Identity section already embedded in the slug header; skipped to save tokens.
  void identity;

  return {
    slug,
    displayName,
    block: parts.join("\n"),
  };
}
