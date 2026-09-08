#!/usr/bin/env node
// backlink-audit — discover inbound links to a domain/URL and classify each as
// "ours" (we created/control the source) vs "organic". Self-contained, Node 22+.
//
// Sources:
//   --source github     target = "owner/repo"; uses `gh api .../traffic/popular/referrers`
//                        (repo-scoped REFERRERS = traffic proxy, not raw backlinks)
//   --source backlinks  target = "domain"; uses backlinks.sh API (Common Crawl webgraph);
//                        needs env BACKLINKS_SH_API_KEY (3 free calls, then paid)
//   --source gsc-csv    target = "domain"; parses a Google Search Console "linking sites"
//                        CSV export (--csv path); authoritative for sites we OWN
//
// Classification: a link is "ours" if its source host/url matches a rule in the
// allowlist (default assets/ours-allowlist.json); hosts in ambiguous_domains that
// no path-rule resolves are reported "ambiguous"; everything else "organic".
//
// Flags: --json  --allowlist <path>  --csv <path>
//        --write-state --target-key <tinkerclaw|thetinkerzone|sprintpaper>
//          → writes inbound_targets.<key>.{ours,external} into
//            ~/.openclaw/workspace/memory/online-presence/inbound-campaign-state.json

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(os.homedir(), ".openclaw", "workspace", "memory", "online-presence", "inbound-campaign-state.json");

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { a[k] = next; i++; } else a[k] = true;
    } else a._.push(t);
  }
  return a;
}

function hostOf(u) {
  try { return new URL(u.includes("://") ? u : `https://${u}`).host.replace(/^www\./, ""); }
  catch { return String(u).replace(/^www\./, "").split("/")[0]; }
}
function pathOf(u) {
  try { return new URL(u.includes("://") ? u : `https://${u}`).pathname; } catch { return "/"; }
}

function classify(sourceUrl, allow) {
  const host = hostOf(sourceUrl);
  const p = pathOf(sourceUrl);
  const norm = (u) => String(u).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  // Exact-URL override: links we authored on otherwise-ambiguous hosts (e.g. our
  // comment on a third-party GitHub issue) — listed in ours_urls.
  if ((allow.ours_urls ?? []).some((u) => norm(u) === norm(sourceUrl))) return { cls: "ours", why: "we authored this link" };
  for (const r of allow.rules ?? []) {
    if (host === r.domain.replace(/^www\./, "")) {
      if (!r.path_prefix || p.startsWith(r.path_prefix)) return { cls: "ours", why: r.label };
    }
  }
  if ((allow.ambiguous_domains?.domains ?? []).includes(host)) return { cls: "ambiguous", why: "host can be ours or organic — resolve by authored-link records" };
  return { cls: "organic", why: "" };
}

// ── sources ────────────────────────────────────────────────────────────────
function fromGithub(target) {
  if (!/^[^/]+\/[^/]+$/.test(target)) throw new Error(`github source needs "owner/repo", got "${target}"`);
  const out = execFileSync("gh", ["api", `repos/${target}/traffic/popular/referrers`], { encoding: "utf8" });
  return JSON.parse(out).map((r) => ({ source: r.referrer, count: r.count, uniques: r.uniques, unit: "referrer-views" }));
}

function backlinksKey() {
  if (process.env.BACKLINKS_SH_API_KEY) return process.env.BACKLINKS_SH_API_KEY;
  const f = path.join(os.homedir(), ".config", "backlinks-sh", "credentials.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")).api_key; } catch { return null; }
}
async function fromBacklinks(target) {
  const key = backlinksKey();
  if (!key) throw new Error("backlinks source needs BACKLINKS_SH_API_KEY env or ~/.config/backlinks-sh/credentials.json");
  // API wants a bare domain via ?target= (NOT scheme/path); it is host-level.
  const res = await fetch(`https://api.backlinks.sh/v1/backlinks?target=${encodeURIComponent(target)}`, { headers: { "x-api-key": key } });
  if (!res.ok) throw new Error(`backlinks.sh HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Shape (confirmed 2026-06-05): { target_domain, status, data_tier:"domain",
  //   data: { backlinks: [...], total_backlinks, referring_domains }, pagination }.
  // status "no_data" → empty (site not in the Common-Crawl graph — common for new sites).
  const rows = data?.data?.backlinks ?? data.backlinks ?? data.results ?? [];
  return rows.map((it) => typeof it === "string"
    ? { source: it, count: 1, unit: "backlink" }
    : { source: it.source_url ?? it.url ?? it.source_domain ?? it.domain ?? it.referring_domain, count: it.count ?? it.links ?? 1, unit: "backlink" });
}

// Discovered links from any method (web search, manual list). The agent runs a
// web search for the target term, collects referring URLs, and passes them here.
function fromUrls(args) {
  let list = [];
  if (args.urls) list = String(args.urls).split(",").map((s) => s.trim()).filter(Boolean);
  else if (args["urls-file"]) list = fs.readFileSync(args["urls-file"], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('urls source needs --urls "a,b,c" or --urls-file <path>');
  return list.map((u) => ({ source: u, count: 1, unit: "discovered-link" }));
}

function fromGscCsv(csvPath) {
  if (!csvPath) throw new Error("gsc-csv source needs --csv <path to GSC linking-sites export>");
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  // GSC export header varies; first column = linking site/domain, a later column = count.
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    if (!cols[0]) continue;
    const n = cols.slice(1).map(Number).find((x) => Number.isFinite(x));
    rows.push({ source: cols[0], count: Number.isFinite(n) ? n : 1, unit: "linking-pages" });
  }
  return rows;
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const target = args._[0];
const source = args.source ?? (target && /^[^/]+\/[^/]+$/.test(target) ? "github" : null);
if (!target || !source) {
  console.error("usage: backlink-audit <target> --source github|backlinks|gsc-csv [--csv f] [--json] [--write-state --target-key k]");
  process.exit(2);
}
const allowPath = args.allowlist ?? path.join(HERE, "..", "assets", "ours-allowlist.json");
const allow = JSON.parse(fs.readFileSync(allowPath, "utf8"));

let links;
if (source === "github") links = fromGithub(target);
else if (source === "backlinks") links = await fromBacklinks(target);
else if (source === "gsc-csv") links = fromGscCsv(args.csv);
else if (source === "urls") links = fromUrls(args);
else throw new Error(`unknown --source ${source}`);

const classified = links.map((l) => ({ ...l, ...classify(l.source, allow) }));
const sum = (cls) => classified.filter((l) => l.cls === cls).reduce((s, l) => s + (l.count || 0), 0);
const report = {
  target, source, unit: links[0]?.unit ?? "n/a",
  totals: { ours: sum("ours"), organic: sum("organic"), ambiguous: sum("ambiguous"), links: classified.length },
  links: classified.sort((a, b) => (b.count || 0) - (a.count || 0)),
  caveat: source === "github" ? "GitHub gives traffic REFERRERS for the repo, not raw backlinks; counts are views." : undefined,
};

if (args.json) { console.log(JSON.stringify(report, null, 2)); }
else {
  console.log(`\nBacklink audit — ${target}  (source: ${source}, unit: ${report.unit})`);
  if (report.caveat) console.log(`  ⚠ ${report.caveat}`);
  console.log(`  ours=${report.totals.ours}  organic=${report.totals.organic}  ambiguous=${report.totals.ambiguous}  (${report.totals.links} sources)\n`);
  for (const l of report.links) {
    const tag = l.cls === "ours" ? "OURS  " : l.cls === "ambiguous" ? "AMBIG " : "ORGNC ";
    console.log(`  [${tag}] ${String(l.count).padStart(5)}  ${l.source}${l.why ? `   — ${l.why}` : ""}`);
  }
  console.log("");
}

if (args["write-state"]) {
  const key = args["target-key"];
  if (!key) { console.error("--write-state needs --target-key <tinkerclaw|thetinkerzone|sprintpaper>"); process.exit(2); }
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  st.inbound_targets = st.inbound_targets ?? {};
  st.inbound_targets[key] = { external: report.totals.organic, ours: report.totals.ours };
  st.last_run = new Date().toISOString();
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + "\n");
  console.error(`wrote inbound_targets.${key} = {external:${report.totals.organic}, ours:${report.totals.ours}} (ambiguous ${report.totals.ambiguous} excluded) → ${STATE}`);
}
