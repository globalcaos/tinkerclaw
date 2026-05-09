#!/usr/bin/env node
/**
 * FORK: tinkerclaw-people — one-shot seed script.
 *
 * Bootstraps `~/.openclaw/workspace/memory/people/` from the WhatsApp history DB:
 *   - Pulls distinct DM partners and group senders.
 *   - Cross-references `memory/work/people.md` (legacy table) to attach emails.
 *   - Generates a sticky slug per the rule:
 *       1) email local-part (dots->dashes) if email is known
 *       2) last 9 digits of E.164 if phone-style JID
 *       3) slug(pushName)
 *       fallback collisions: `-2`, `-3`, ...
 *   - Writes `_aliases.json`, `_state.json`, `_index.md`, and per-person `<slug>.md`
 *     stubs with the last 14 days of inbound bullets seeded into "Recent asks".
 *
 * Idempotent: re-runs MERGE new identifiers into existing aliases; never
 * touches "Manual context" sections of existing profiles.
 *
 * Usage:
 *   node extensions/tinkerclaw-people/scripts/seed.mjs            # write
 *   node extensions/tinkerclaw-people/scripts/seed.mjs --dry-run  # report only
 *
 * NB: this file is plain ESM JS so it runs without a TypeScript build step.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// CLI parse
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose") || args.includes("-v");

const HOME = os.homedir();
const PEOPLE_DIR = path.join(HOME, ".openclaw", "workspace", "memory", "people");
const WHATSAPP_DB = path.join(HOME, ".openclaw", "data", "whatsapp-history.db");
const WORK_PEOPLE_MD = path.join(HOME, ".openclaw", "workspace", "memory", "work", "people.md");
const ALIASES_PATH = path.join(PEOPLE_DIR, "_aliases.json");
const STATE_PATH = path.join(PEOPLE_DIR, "_state.json");
const INDEX_PATH = path.join(PEOPLE_DIR, "_index.md");

const FOURTEEN_DAYS_SECONDS = 14 * 24 * 3600;
const NOW_SECONDS = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Better-sqlite3 from the fork's node_modules (avoids needing it at this dir).
// ---------------------------------------------------------------------------
function loadBetterSqlite3() {
  const candidates = [
    path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../../node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3",
    ),
    path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../../node_modules/.pnpm/better-sqlite3@12.6.2/node_modules/better-sqlite3",
    ),
    path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../../node_modules/better-sqlite3",
    ),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return require(c);
    }
  }
  // last-ditch: try resolving from the fork root
  try {
    return require("better-sqlite3");
  } catch {
    throw new Error(`Could not locate better-sqlite3. Tried:\n  ${candidates.join("\n  ")}`);
  }
}

// ---------------------------------------------------------------------------
// Slug + name utilities
// ---------------------------------------------------------------------------
function slugifyEmailLocalPart(local) {
  return local
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function slugifyName(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function digitsOnly(s) {
  return s.replace(/[^0-9]/g, "");
}

function jidToPhoneOrLid(jid) {
  if (!jid) return { phone: null, lid: null };
  if (jid.endsWith("@s.whatsapp.net")) {
    const num = jid.split("@")[0];
    if (/^\d+$/.test(num)) return { phone: `+${num}`, lid: null };
    return { phone: null, lid: jid };
  }
  if (jid.endsWith("@lid")) return { phone: null, lid: jid };
  return { phone: null, lid: null };
}

// Pick a deterministic slug given alias info; ensure uniqueness against `existingSlugs` set.
function makeUniqueSlug(base, existing) {
  if (!base) base = "person";
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function pickSlug(person, existingSlugs) {
  // 1) email (first one)
  if (person.emails.length > 0) {
    const local = person.emails[0].split("@")[0];
    const base = slugifyEmailLocalPart(local);
    if (base) return makeUniqueSlug(base, existingSlugs);
  }
  // 2) last 9 digits of phone
  if (person.phones.length > 0) {
    const d = digitsOnly(person.phones[0]);
    if (d.length >= 9) return makeUniqueSlug(d.slice(-9), existingSlugs);
    if (d) return makeUniqueSlug(d, existingSlugs);
  }
  // 3) slugified pushName / displayName
  if (person.displayName) {
    const base = slugifyName(person.displayName);
    if (base) return makeUniqueSlug(base, existingSlugs);
  }
  // 4) lid as last resort
  if (person.lids.length > 0) {
    const base = slugifyName(person.lids[0].split("@")[0]);
    if (base) return makeUniqueSlug(base, existingSlugs);
  }
  return makeUniqueSlug("person", existingSlugs);
}

// ---------------------------------------------------------------------------
// Parse work/people.md table -> { lowerName: email, lowerPart: email }
// ---------------------------------------------------------------------------
function parseWorkPeopleMd(p) {
  const byName = new Map();
  const byEmailLocal = new Map();
  if (!fs.existsSync(p)) return { byName, byEmailLocal, rows: [] };
  const lines = fs.readFileSync(p, "utf-8").split(/\r?\n/);
  const rows = [];
  for (const ln of lines) {
    if (!ln.trim().startsWith("|")) continue;
    if (/^\|\s*-+\s*\|/.test(ln)) continue; // separator
    if (/^\|\s*Name\s*\|/i.test(ln)) continue; // header
    const cells = ln
      .split("|")
      .slice(1, -1) // drop leading/trailing empties
      .map((c) => c.trim());
    if (cells.length < 3) continue;
    const name = cells[0].replace(/^['"]|['"]$/g, "").trim();
    const email = cells[1].trim();
    const role = cells[2] ?? "";
    if (!name || !email || !email.includes("@")) continue;
    rows.push({ name, email, role });
    byName.set(name.toLowerCase(), { email, role, name });
    const local = email.split("@")[0].toLowerCase();
    byEmailLocal.set(local, { email, role, name });
  }
  return { byName, byEmailLocal, rows };
}

// Loose name-match against the table:
// - exact lower
// - first-letter + last-name probe against email local-part (e.g. "Iván Núñez" -> "i.nunez")
// - tokens shared (firstname OR lastname) — narrowed: requires 2+ shared tokens to avoid collisions
function normalizeForMatch(s) {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function matchTableRow(workTable, displayName, contactName) {
  const cands = [displayName, contactName]
    .filter((x) => typeof x === "string" && x.trim())
    .map(normalizeForMatch);
  // 1) exact (normalized) — prebuild a normalized index lazily
  if (!workTable._byNameNorm) {
    workTable._byNameNorm = new Map();
    for (const [k, v] of workTable.byName.entries()) {
      workTable._byNameNorm.set(normalizeForMatch(k), v);
    }
  }
  for (const c of cands) {
    const hit = workTable._byNameNorm.get(c);
    if (hit) return hit;
  }
  // 2) first-letter + lastname probe → email local part
  for (const c of cands) {
    const toks = c.split(/\s+/).filter(Boolean);
    if (toks.length >= 2) {
      // try (first-initial).(last-token), and (first-initial).(second-token-to-last) for triples like "ivan nunez perez"
      const candidates = new Set();
      candidates.add(`${toks[0][0]}.${toks[toks.length - 1]}`);
      if (toks.length >= 3) candidates.add(`${toks[0][0]}.${toks[toks.length - 2]}`);
      for (const probe of candidates) {
        const hit = workTable.byEmailLocal.get(probe.toLowerCase());
        if (hit) return hit;
      }
    }
  }
  // 3) shared 2+ tokens with a row: e.g. "ivan nunez perez" vs "iván núñez" → shared {nunez}; only one token, so reject.
  //    But: "Iván Núñez" vs "Ivan Nunez" (normalized accents) should match.
  for (const c of cands) {
    const toks = new Set(c.split(/\s+/).filter((t) => t.length >= 3));
    if (toks.size === 0) continue;
    for (const [k, v] of workTable._byNameNorm.entries()) {
      const ktoks = new Set(k.split(/\s+/).filter((t) => t.length >= 3));
      let shared = 0;
      for (const t of toks) if (ktoks.has(t)) shared++;
      if (shared >= 2) return v;
      // single shared token is enough only if it's a meaningful surname (>=4 chars) AND first names
      // share the same initial — protects against e.g. "Iván" matching multiple Iváns.
      if (shared === 1) {
        const firstA = c.split(/\s+/)[0] ?? "";
        const firstB = k.split(/\s+/)[0] ?? "";
        if (firstA && firstB && firstA[0] === firstB[0]) {
          // also require the shared token to be a "long" surname-like token
          const sharedTok = [...toks].find((t) => ktoks.has(t)) ?? "";
          if (sharedTok.length >= 5) return v;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// People aggregation from WhatsApp DB
// ---------------------------------------------------------------------------
function aggregatePeople(db) {
  // 1) Detect self-jids: any from_me=1 sender_jid (skip these as DM partners)
  const selfJids = new Set(
    db
      .prepare(
        "SELECT DISTINCT sender_jid FROM messages WHERE from_me = 1 AND sender_jid IS NOT NULL",
      )
      .all()
      .map((r) => r.sender_jid),
  );

  // 2) DM partners = distinct chat_jid LIKE '%@s.whatsapp.net' AND NOT in selfJids
  const dmRows = db
    .prepare(
      `SELECT
         chat_jid,
         MAX(CASE WHEN from_me=0 THEN sender_pushname END) AS push_name_inbound,
         MAX(CASE WHEN from_me=0 THEN chat_name END) AS chat_name_inbound,
         MAX(timestamp) AS last_ts,
         COUNT(*) FILTER(WHERE from_me=0) AS inbound_count
       FROM messages
       WHERE chat_jid LIKE '%@s.whatsapp.net'
       GROUP BY chat_jid`,
    )
    .all();

  // 3) Group senders = distinct sender_jid where chat_jid LIKE '%@g.us'
  const groupRows = db
    .prepare(
      `SELECT
         sender_jid AS jid,
         MAX(sender_pushname) AS push_name,
         MAX(timestamp) AS last_ts,
         COUNT(*) FILTER(WHERE from_me=0) AS inbound_count
       FROM messages
       WHERE chat_jid LIKE '%@g.us' AND sender_jid IS NOT NULL AND from_me = 0
       GROUP BY sender_jid`,
    )
    .all();

  // 4) Contacts table for name lookup (jid -> name)
  const contactsRows = db.prepare("SELECT jid, name, notify FROM contacts").all();
  const contactsByJid = new Map();
  for (const c of contactsRows) {
    contactsByJid.set(c.jid, { name: c.name, notify: c.notify });
  }

  // Build per-person buckets keyed by primary identifier (jid)
  const buckets = new Map(); // primaryKey -> { displayName, emails:Set, phones:Set, lids:Set, names:Set, lastTs }

  function upsert(primaryKey, fields) {
    let bucket = buckets.get(primaryKey);
    if (!bucket) {
      bucket = {
        emails: new Set(),
        phones: new Set(),
        lids: new Set(),
        names: new Set(),
        lastTs: 0,
      };
      buckets.set(primaryKey, bucket);
    }
    for (const e of fields.emails ?? []) bucket.emails.add(e);
    for (const p of fields.phones ?? []) bucket.phones.add(p);
    for (const l of fields.lids ?? []) bucket.lids.add(l);
    for (const n of fields.names ?? []) bucket.names.add(n);
    if (fields.displayName && !bucket.displayName) bucket.displayName = fields.displayName;
    if ((fields.lastTs ?? 0) > bucket.lastTs) bucket.lastTs = fields.lastTs;
  }

  for (const r of dmRows) {
    if (selfJids.has(r.chat_jid)) continue;
    const { phone, lid } = jidToPhoneOrLid(r.chat_jid);
    const contact = contactsByJid.get(r.chat_jid);
    const displayName =
      contact?.name?.trim() ||
      contact?.notify?.trim() ||
      r.push_name_inbound?.trim() ||
      r.chat_name_inbound?.trim() ||
      (phone ? phone : r.chat_jid);
    const fields = {
      emails: [],
      phones: phone ? [phone] : [],
      lids: lid ? [lid] : [],
      names: [
        ...(r.push_name_inbound ? [r.push_name_inbound] : []),
        ...(contact?.name ? [contact.name] : []),
        ...(contact?.notify ? [contact.notify] : []),
      ],
      displayName,
      lastTs: r.last_ts,
    };
    // Use chat_jid as the primaryKey for DM partners (sticky)
    upsert(r.chat_jid, fields);
  }

  for (const r of groupRows) {
    if (!r.jid || selfJids.has(r.jid)) continue;
    if (r.jid === "status@broadcast") continue;
    const { phone, lid } = jidToPhoneOrLid(r.jid);
    const contact = contactsByJid.get(r.jid);
    const displayName =
      contact?.name?.trim() ||
      contact?.notify?.trim() ||
      r.push_name?.trim() ||
      (phone ? phone : r.jid);
    const fields = {
      emails: [],
      phones: phone ? [phone] : [],
      lids: lid ? [lid] : [],
      names: [
        ...(r.push_name ? [r.push_name] : []),
        ...(contact?.name ? [contact.name] : []),
        ...(contact?.notify ? [contact.notify] : []),
      ],
      displayName,
      lastTs: r.last_ts,
    };
    upsert(r.jid, fields);
  }

  return buckets;
}

// ---------------------------------------------------------------------------
// Profile rendering / merging
// ---------------------------------------------------------------------------
const SECTION_HEADERS = {
  identity: "## Identity",
  manualContext: "## Manual context",
  rollingSummary: "## Rolling summary",
  recentAsks: "## Recent asks",
  pointers: "## Conversation state pointers (machine)",
};

function buildIdentitySection(alias) {
  const lines = ["## Identity"];
  lines.push(`- Slug: \`${alias.slug}\``);
  lines.push(`- Display name: ${alias.displayName}`);
  lines.push(
    `- Emails: ${alias.emails.length ? alias.emails.map((e) => `\`${e}\``).join(", ") : "(none)"}`,
  );
  lines.push(
    `- Phones: ${alias.phones.length ? alias.phones.map((p) => `\`${p}\``).join(", ") : "(none)"}`,
  );
  lines.push(
    `- WhatsApp JIDs: ${alias.lids.length ? alias.lids.map((l) => `\`${l}\``).join(", ") : "(none)"}`,
  );
  if (alias.role) lines.push(`- Role / org: ${alias.role}`);
  if (alias.names.length) lines.push(`- Known names: ${alias.names.join(", ")}`);
  return lines.join("\n");
}

function buildPointersSection(state) {
  return [
    "## Conversation state pointers (machine)",
    `- \`lastWaMessageId\`: ${state.lastWaMessageId ?? ""}`,
    `- \`lastWaTimestamp\`: ${state.lastWaTimestamp ?? ""}`,
    `- \`lastSummaryAt\`: ${state.lastSummaryAt ?? ""}`,
    `- \`messagesSinceLastSummary\`: ${state.messagesSinceLastSummary ?? 0}`,
    `- \`lastConsultedByOwner\`: ${state.lastConsultedByOwner ?? ""}`,
  ].join("\n");
}

function renderRecentAsksBullets(rows) {
  // rows: { ts: epoch_seconds, body: string|null }, newest first, max 30
  const out = [];
  for (const r of rows) {
    const dt = new Date(r.ts * 1000);
    const date = dt.toISOString().slice(0, 10);
    const body = (r.body ?? "").replace(/\s+/g, " ").trim();
    if (!body) continue;
    const truncated = body.slice(0, 80);
    out.push(`- ${date} — ${truncated}`);
    if (out.length >= 30) break;
  }
  return out;
}

function renderProfile({ alias, state, recentAsksBullets, lastRefreshIso }) {
  return [
    `# ${alias.displayName}`,
    "",
    `> Auto-maintained — last refresh: ${lastRefreshIso}. Manual edits in the **Manual context** section persist; the rest is rewritten by the cron summarizer.`,
    "",
    buildIdentitySection(alias),
    "",
    "## Manual context",
    "*(Hand-edited; never overwritten by cron. Use this for standing knowledge: relationships, do/don't notes, secrets, project history.)*",
    "",
    "_(empty)_",
    "",
    "## Rolling summary",
    "*(Auto-maintained narrative covering ~30 days, refreshed hourly when there's new traffic.)*",
    "",
    "_(empty — first cron run will populate.)_",
    "",
    "## Recent asks (last 14 days, newest first)",
    recentAsksBullets.length ? recentAsksBullets.join("\n") : "_(none yet)_",
    "",
    buildPointersSection(state),
    "",
  ].join("\n");
}

// Merge new identity + new asks into existing markdown WITHOUT touching Manual context.
function mergeProfile(existingMd, { alias, state, newAsksBullets, lastRefreshIso }) {
  // Walk sections, replacing Identity / Recent asks / Pointers, leaving Manual context + Rolling summary intact.
  const sections = splitSections(existingMd);

  sections.title = `# ${alias.displayName}`;
  sections.preamble = `> Auto-maintained — last refresh: ${lastRefreshIso}. Manual edits in the **Manual context** section persist; the rest is rewritten by the cron summarizer.`;
  sections["## Identity"] = buildIdentitySection(alias);

  // Merge recent asks: union of existing date-prefixed bullets + new, dedupe by line, newest first, top 30.
  const existingAsks = sections["## Recent asks"] ?? "";
  const lines = [
    ...newAsksBullets,
    ...existingAsks.split(/\r?\n/).filter((l) => /^-\s+\d{4}-\d{2}-\d{2}/.test(l)),
  ];
  const seen = new Set();
  const merged = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    merged.push(l);
  }
  // sort by date desc (the date is the second token)
  merged.sort((a, b) => {
    const da = a.match(/^-\s+(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    const db = b.match(/^-\s+(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    return db.localeCompare(da);
  });
  const recentBody = merged.slice(0, 30).join("\n") || "_(none yet)_";
  sections["## Recent asks"] = `## Recent asks (last 14 days, newest first)\n${recentBody}`;

  sections[SECTION_HEADERS.pointers] = buildPointersSection(state);

  return reassemble(sections);
}

function splitSections(md) {
  const sections = {
    title: "",
    preamble: "",
    "## Identity": "",
    "## Manual context": "",
    "## Rolling summary": "",
    "## Recent asks": "",
    "## Conversation state pointers (machine)": "",
  };
  const knownHeaders = Object.keys(sections).filter((k) => k.startsWith("## "));
  const lines = md.split(/\r?\n/);
  let current = null; // null until we see something
  let buf = [];
  function flush() {
    if (current === null) return;
    sections[current] =
      (sections[current] ? sections[current] + "\n" : "") + buf.join("\n").trimEnd();
    buf = [];
  }

  for (const ln of lines) {
    if (current === null && ln.startsWith("# ")) {
      sections.title = ln;
      continue;
    }
    if (current === null && ln.startsWith(">")) {
      sections.preamble = (sections.preamble ? sections.preamble + "\n" : "") + ln;
      continue;
    }
    const matchHeader = knownHeaders.find((h) => ln.startsWith(h));
    if (matchHeader) {
      flush();
      current = matchHeader;
      buf.push(ln);
      continue;
    }
    if (current !== null) {
      buf.push(ln);
    }
  }
  flush();
  return sections;
}

function reassemble(sections) {
  const order = [
    sections.title || "",
    "",
    sections.preamble || "",
    "",
    sections["## Identity"] || "",
    "",
    sections["## Manual context"] ||
      "## Manual context\n*(Hand-edited; never overwritten by cron.)*\n\n_(empty)_",
    "",
    sections["## Rolling summary"] ||
      "## Rolling summary\n*(Auto-maintained.)*\n\n_(empty — cron will populate.)_",
    "",
    sections["## Recent asks"] || "## Recent asks (last 14 days, newest first)\n_(none yet)_",
    "",
    sections["## Conversation state pointers (machine)"] || "",
    "",
  ];
  return order.join("\n");
}

// ---------------------------------------------------------------------------
// Aliases / state file IO
// ---------------------------------------------------------------------------
function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJson(p, val) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(val, null, 2) + "\n", "utf-8");
}

function unionArrays(a, b) {
  const set = new Set([...(a ?? []), ...(b ?? [])]);
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// _index.md rendering
// ---------------------------------------------------------------------------
function renderIndexMd(aliases, state) {
  const rows = Object.entries(aliases).map(([slug, alias]) => ({
    slug,
    displayName: alias.displayName,
    email: alias.emails?.[0] ?? "",
    phone: alias.phones?.[0] ?? "",
    last: state[slug]?.lastInteraction ?? "",
  }));
  rows.sort((a, b) => {
    if (a.last && b.last) return b.last.localeCompare(a.last);
    if (a.last) return -1;
    if (b.last) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
  const header =
    "# People — Auto Index\n\n" +
    "*Auto-maintained — every profile lives in this directory as `<slug>.md`. Edits to **Manual context** in each profile are preserved across cron runs.*\n\n" +
    "| Display name | Slug | Email | Phone | Last interaction |\n" +
    "|---|---|---|---|---|\n";
  const body = rows
    .map(
      (r) =>
        `| ${r.displayName} | [\`${r.slug}\`](./${r.slug}.md) | ${r.email} | ${r.phone} | ${r.last} |`,
    )
    .join("\n");
  return header + body + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(WHATSAPP_DB)) {
    console.error(`whatsapp-history.db not found at ${WHATSAPP_DB}`);
    process.exit(1);
  }
  const Database = loadBetterSqlite3();
  const db = new Database(WHATSAPP_DB, { readonly: true });

  console.log(`[seed] DB: ${WHATSAPP_DB}`);
  console.log(`[seed] PEOPLE_DIR: ${PEOPLE_DIR}${DRY_RUN ? "  (DRY RUN — no writes)" : ""}`);

  const workTable = parseWorkPeopleMd(WORK_PEOPLE_MD);
  console.log(`[seed] work/people.md rows: ${workTable.rows.length}`);

  const buckets = aggregatePeople(db);
  console.log(`[seed] discovered ${buckets.size} distinct people from WA history`);

  // Load existing aliases + state for idempotent merge
  const existingAliases = loadJson(ALIASES_PATH, {});
  const existingState = loadJson(STATE_PATH, {});

  // Pre-populate uniqueness set with existing slugs (sticky)
  const slugs = new Set(Object.keys(existingAliases));

  // Build a reverse lookup: any of (jid, email, phone, lid) -> existing slug
  const reverseLookup = new Map();
  for (const [slug, alias] of Object.entries(existingAliases)) {
    for (const e of alias.emails ?? []) reverseLookup.set(`email:${e.toLowerCase()}`, slug);
    for (const p of alias.phones ?? []) reverseLookup.set(`phone:${digitsOnly(p)}`, slug);
    for (const l of alias.lids ?? []) reverseLookup.set(`lid:${l.toLowerCase()}`, slug);
  }

  let newProfilesCount = 0;
  let mergedProfilesCount = 0;
  const aliasesOut = { ...existingAliases };
  const stateOut = { ...existingState };

  // Prep: fetch up to 30 most recent inbound bullets, preferring the last 14
  // days but falling back to ALL-time if recent traffic is sparse — many
  // contacts haven't messaged in the last fortnight but we still want a stub.
  // Cron path enforces the rolling "last 14 days" trim during summarization.
  const recentForJidStmt = db.prepare(
    `SELECT id, timestamp AS ts, COALESCE(text_content, caption) AS body
     FROM messages
     WHERE chat_jid = ? AND from_me = 0
       AND COALESCE(text_content, caption) IS NOT NULL
     ORDER BY timestamp DESC LIMIT 30`,
  );
  const recentForGroupSenderStmt = db.prepare(
    `SELECT id, timestamp AS ts, COALESCE(text_content, caption) AS body
     FROM messages
     WHERE sender_jid = ? AND from_me = 0
       AND COALESCE(text_content, caption) IS NOT NULL
     ORDER BY timestamp DESC LIMIT 30`,
  );
  // last message id (newest) for state pointer
  const newestForJidStmt = db.prepare(
    `SELECT id, timestamp FROM messages
     WHERE chat_jid = ? AND from_me = 0
     ORDER BY timestamp DESC LIMIT 1`,
  );
  const newestForGroupSenderStmt = db.prepare(
    `SELECT id, timestamp FROM messages
     WHERE sender_jid = ? AND from_me = 0
     ORDER BY timestamp DESC LIMIT 1`,
  );

  const cutoff = NOW_SECONDS - FOURTEEN_DAYS_SECONDS;
  const lastRefreshIso = new Date().toISOString();

  for (const [primaryKey, bucket] of buckets.entries()) {
    // bucket has emails, phones, lids, names, displayName, lastTs
    const isDmKey = primaryKey.endsWith("@s.whatsapp.net");
    const isLidKey = primaryKey.endsWith("@lid");
    if (!isDmKey && !isLidKey) continue;
    if (primaryKey === "status@broadcast") continue;

    // Cross-reference work/people.md for email + canonical name
    const matched = matchTableRow(workTable, bucket.displayName, [...bucket.names][0] ?? "");
    if (matched?.email) {
      bucket.emails.add(matched.email);
    }
    // Prefer the hand-curated table name (e.g. shortened "Iván Núñez") over
    // the auto contact full legal name ("Iván Núñez García") — shorter form
    // matches how the user refers to the person in conversation.
    if (matched?.name) {
      bucket.names.add(matched.name);
      bucket.displayName = matched.name;
    }

    // Find existing slug via reverse-lookup
    let existingSlug = null;
    for (const e of bucket.emails) {
      const hit = reverseLookup.get(`email:${e.toLowerCase()}`);
      if (hit) {
        existingSlug = hit;
        break;
      }
    }
    if (!existingSlug) {
      for (const p of bucket.phones) {
        const hit = reverseLookup.get(`phone:${digitsOnly(p)}`);
        if (hit) {
          existingSlug = hit;
          break;
        }
      }
    }
    if (!existingSlug) {
      for (const l of bucket.lids) {
        const hit = reverseLookup.get(`lid:${l.toLowerCase()}`);
        if (hit) {
          existingSlug = hit;
          break;
        }
      }
    }

    let slug;
    if (existingSlug) {
      slug = existingSlug;
    } else {
      const personForSlug = {
        emails: [...bucket.emails],
        phones: [...bucket.phones],
        lids: [...bucket.lids],
        displayName: bucket.displayName ?? "",
      };
      slug = pickSlug(personForSlug, slugs);
      slugs.add(slug);
    }

    // Build merged alias entry. If we have a freshly-matched table row, the
    // hand-curated name wins over any prior auto-derived displayName.
    const prior = aliasesOut[slug] ?? {
      displayName: "",
      emails: [],
      phones: [],
      lids: [],
      names: [],
    };
    const preferredDisplay =
      matched?.name?.trim() || prior.displayName?.trim() || bucket.displayName || slug;
    const merged = {
      displayName: preferredDisplay,
      emails: unionArrays(prior.emails, [...bucket.emails]),
      phones: unionArrays(prior.phones, [...bucket.phones]),
      lids: unionArrays(prior.lids, [...bucket.lids]),
      names: unionArrays(prior.names, [...bucket.names]),
    };
    aliasesOut[slug] = merged;

    // Update reverse lookup so subsequent buckets in this run can hit it
    for (const e of merged.emails) reverseLookup.set(`email:${e.toLowerCase()}`, slug);
    for (const p of merged.phones) reverseLookup.set(`phone:${digitsOnly(p)}`, slug);
    for (const l of merged.lids) reverseLookup.set(`lid:${l.toLowerCase()}`, slug);

    // Pull recent asks (inbound, up to 30 most recent — cron enforces 14d rolling trim)
    void cutoff;
    const recentRows = isDmKey
      ? recentForJidStmt.all(primaryKey)
      : recentForGroupSenderStmt.all(primaryKey);

    // Newest message overall for state pointer (regardless of 14d cutoff)
    const newest = isDmKey
      ? newestForJidStmt.get(primaryKey)
      : newestForGroupSenderStmt.get(primaryKey);

    const askBullets = renderRecentAsksBullets(recentRows);

    const lastInteractionIso = newest?.timestamp
      ? new Date(newest.timestamp * 1000).toISOString()
      : undefined;
    const stateForPerson = stateOut[slug] ?? {};
    const newState = {
      ...stateForPerson,
      // Sticky: if pointer already exists, keep it (cron path advances it).
      // Otherwise seed from newest known message, so cron runs only emit "since seed".
      lastWaMessageId: stateForPerson.lastWaMessageId ?? newest?.id,
      lastWaTimestamp: stateForPerson.lastWaTimestamp ?? newest?.timestamp,
      lastSummaryAt: stateForPerson.lastSummaryAt,
      messagesSinceLastSummary: stateForPerson.messagesSinceLastSummary ?? 0,
      lastConsultedByOwner: stateForPerson.lastConsultedByOwner,
      lastInteraction: lastInteractionIso ?? stateForPerson.lastInteraction,
    };
    stateOut[slug] = newState;

    const aliasForRender = { ...merged, slug, role: matched?.role ?? "" };
    const profilePath = path.join(PEOPLE_DIR, `${slug}.md`);
    if (!DRY_RUN) {
      fs.mkdirSync(PEOPLE_DIR, { recursive: true });
    }
    if (fs.existsSync(profilePath)) {
      mergedProfilesCount += 1;
      if (!DRY_RUN) {
        const existingMd = fs.readFileSync(profilePath, "utf-8");
        const updated = mergeProfile(existingMd, {
          alias: aliasForRender,
          state: newState,
          newAsksBullets: askBullets,
          lastRefreshIso,
        });
        fs.writeFileSync(profilePath, updated, "utf-8");
      }
    } else {
      newProfilesCount += 1;
      if (!DRY_RUN) {
        const md = renderProfile({
          alias: aliasForRender,
          state: newState,
          recentAsksBullets: askBullets,
          lastRefreshIso,
        });
        fs.writeFileSync(profilePath, md, "utf-8");
      }
    }
    if (VERBOSE) {
      console.log(
        `  [${existingSlug ? "merge" : "new"}] ${slug.padEnd(28)} ${aliasForRender.displayName} (emails=${merged.emails.length}, phones=${merged.phones.length}, lids=${merged.lids.length}, asks=${askBullets.length})`,
      );
    }
  }

  if (!DRY_RUN) {
    saveJson(ALIASES_PATH, aliasesOut);
    saveJson(STATE_PATH, stateOut);
    fs.writeFileSync(INDEX_PATH, renderIndexMd(aliasesOut, stateOut), "utf-8");
  }

  const totalAliases = Object.keys(aliasesOut).length;
  const totalProfiles = newProfilesCount + mergedProfilesCount;
  console.log(
    `[seed] seeded ${totalProfiles} profiles (${newProfilesCount} new, ${mergedProfilesCount} merged), ${totalAliases} aliases${DRY_RUN ? "  (dry run, not written)" : ""}`,
  );
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
