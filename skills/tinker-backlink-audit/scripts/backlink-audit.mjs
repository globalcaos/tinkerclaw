#!/usr/bin/env node
// backlink-audit — discover inbound links to a domain/URL and classify each as
// "ours" (we created/control the source) vs "organic". Self-contained, Node 22+.
//
// Sources:
//   --source github     target = "owner/repo"; uses `gh api .../traffic/popular/referrers`
//                        (repo-scoped REFERRERS = traffic proxy, not raw backlinks)
//   --source urls       any target; classifies a list of links you found yourself
//                        (--urls "a,b,c" or --urls-file <path>). Fully offline.
//   --source backlinks  target = "domain"; uses backlinks.sh API (Common Crawl webgraph);
//                        needs env BACKLINKS_SH_API_KEY (3 free calls, then paid)
//   --source gsc-csv    target = "domain"; parses a Google Search Console "linking sites"
//                        CSV export (--csv path); authoritative for sites you OWN
//
// Classification: a link is "ours" if its source host/url matches a rule in YOUR
// allowlist; hosts in ambiguous_domains that no path-rule resolves are reported
// "ambiguous"; everything else "organic".
//
// Which allowlist (first match wins; the two explicit choices never fall back):
//   1. --allowlist <path>
//   2. BACKLINK_AUDIT_ALLOWLIST=<path>
//   3. ~/.config/backlink-audit/ours-allowlist.json
//   4. assets/ours-allowlist.json beside this script (git-ignored; for a private install)
//   5. assets/ours-allowlist.example.json — placeholders only: warns, and --write-state refuses
//
// Flags: --json  --allowlist <path>  --csv <path>  --urls a,b  --urls-file <path>
//        --write-state --target-key <key> [--state <path>]
//          → writes inbound_targets.<key>.{ours,external} into the state file:
//            --state, else BACKLINK_AUDIT_STATE, else
//            ~/.openclaw/workspace/memory/online-presence/inbound-campaign-state.json
//            (the directory the pulse-panel `localstate:` poller reads)
//        --login   read a backlinks.sh API key from STDIN and store it in the OS keychain
//        --logout  clear that key from the keychain, and delete any legacy plaintext file (off switch)
//
// Only the `backlinks` source needs a credential. Nothing else here reads, writes
// or transmits a secret. See the "Permissions, Data Flow & Consent" section of
// SKILL.md for the full map.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "memory",
  "online-presence",
  "inbound-campaign-state.json",
);
const USER_ALLOWLIST = path.join(os.homedir(), ".config", "backlink-audit", "ours-allowlist.json");
const LOCAL_ALLOWLIST = path.join(HERE, "..", "assets", "ours-allowlist.json");
const EXAMPLE_ALLOWLIST = path.join(HERE, "..", "assets", "ours-allowlist.example.json");
const TARGET_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        a[k] = next;
        i++;
      } else a[k] = true;
    } else a._.push(t);
  }
  return a;
}

function hostOf(u) {
  try {
    return new URL(u.includes("://") ? u : `https://${u}`).host.replace(/^www\./, "");
  } catch {
    return String(u)
      .replace(/^www\./, "")
      .split("/")[0];
  }
}
function pathOf(u) {
  try {
    return new URL(u.includes("://") ? u : `https://${u}`).pathname;
  } catch {
    return "/";
  }
}

function classify(sourceUrl, allow) {
  const host = hostOf(sourceUrl);
  const p = pathOf(sourceUrl);
  const norm = (u) =>
    String(u)
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  // Exact-URL override: links we authored on otherwise-ambiguous hosts (e.g. our
  // comment on a third-party GitHub issue) — listed in ours_urls.
  if ((allow.ours_urls ?? []).some((u) => norm(u) === norm(sourceUrl)))
    return { cls: "ours", why: "we authored this link" };
  for (const r of allow.rules ?? []) {
    if (host === r.domain.replace(/^www\./, "")) {
      if (!r.path_prefix || p.startsWith(r.path_prefix)) return { cls: "ours", why: r.label };
    }
  }
  if ((allow.ambiguous_domains?.domains ?? []).includes(host))
    return {
      cls: "ambiguous",
      why: "host can be ours or organic — resolve by authored-link records",
    };
  return { cls: "organic", why: "" };
}

// ── allowlist (owner data — never shipped, only the placeholder example is) ──
function resolveAllowlist(args) {
  // An explicit choice that does not exist is an error, never a silent fallback:
  // classifying against a different list than the one you named is a wrong answer
  // that looks like a right one.
  const explicit = [
    [args.allowlist, "--allowlist"],
    [process.env.BACKLINK_AUDIT_ALLOWLIST, "BACKLINK_AUDIT_ALLOWLIST"],
  ];
  for (const [val, label] of explicit) {
    if (val === true) die(`${label} needs a path`);
    if (val) {
      if (!fs.existsSync(val))
        die(`${label} points at ${val}, which does not exist. Nothing was classified.`);
      return { file: val, from: label, example: false };
    }
  }
  if (fs.existsSync(USER_ALLOWLIST))
    return { file: USER_ALLOWLIST, from: "~/.config/backlink-audit", example: false };
  if (fs.existsSync(LOCAL_ALLOWLIST))
    return { file: LOCAL_ALLOWLIST, from: "skill assets", example: false };
  return { file: EXAMPLE_ALLOWLIST, from: "shipped example", example: true };
}

function loadAllowlist(r) {
  let allow;
  try {
    allow = JSON.parse(fs.readFileSync(r.file, "utf8"));
  } catch (e) {
    die(`cannot read allowlist ${r.file}: ${e.message}`);
  }
  for (const rule of allow.rules ?? []) {
    if (!rule || typeof rule.domain !== "string" || !rule.domain)
      die(`allowlist ${r.file}: every rule needs a "domain" string (got ${JSON.stringify(rule)})`);
  }
  // A copied-but-unedited example still carries "_example": true — treat it as the example.
  return { allow, example: r.example || allow._example === true };
}

function warnExampleAllowlist() {
  console.error(
    `⚠ Classifying against the PLACEHOLDER example allowlist — no allowlist of your own was found`,
  );
  console.error(
    `  (or the one found still carries "_example": true). Nearly every link will come out`,
  );
  console.error(`  "organic", which flatters you. Make your own:`);
  console.error(`    mkdir -p ~/.config/backlink-audit`);
  console.error(`    cp ${EXAMPLE_ALLOWLIST} ~/.config/backlink-audit/ours-allowlist.json`);
  console.error(
    `  then replace the placeholders and delete "_example" — or pass --allowlist <path>,`,
  );
  console.error(`  or set BACKLINK_AUDIT_ALLOWLIST.`);
}

// ── sources ────────────────────────────────────────────────────────────────
function fromGithub(target) {
  if (!/^[^/]+\/[^/]+$/.test(target))
    throw new Error(`github source needs "owner/repo", got "${target}"`);
  const out = execFileSync("gh", ["api", `repos/${target}/traffic/popular/referrers`], {
    encoding: "utf8",
  });
  return JSON.parse(out).map((r) => ({
    source: r.referrer,
    count: r.count,
    uniques: r.uniques,
    unit: "referrer-views",
  }));
}

// ── credential handling (backlinks.sh API key) ──────────────────────────────
// TWO places, and neither of them is a plain file:
//   1. BACKLINKS_SH_API_KEY  — transient, nothing on disk. Preferred.
//   2. the OS keychain       — secret-tool (libsecret) on Linux, `security` on macOS.
//
// There is deliberately no third tier. Earlier versions wrote the key to
// ~/.config/backlinks-sh/credentials.json when no keychain was present and warned about
// it on every use — but a warning is not a control, and the file it warned about was a
// long-lived API key sitting in the clear. `--login` now REFUSES rather than downgrading
// your storage silently; a legacy file is still detected (so you are told why your key
// stopped working) and still deleted by `--logout`, but it is never read as a credential.
const KC_SERVICE = "backlinks-sh";
const KC_ACCOUNT = "api-key";
const CRED_FILE = path.join(os.homedir(), ".config", "backlinks-sh", "credentials.json");
const ACCOUNT_URL = "https://backlinks.sh";
const QUIET = { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] };
const KC_BIN = process.platform === "darwin" ? "security" : "secret-tool";

function kcGet() {
  try {
    const out =
      process.platform === "darwin"
        ? execFileSync(
            "security",
            ["find-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w"],
            QUIET,
          )
        : execFileSync(
            "secret-tool",
            ["lookup", "service", KC_SERVICE, "account", KC_ACCOUNT],
            QUIET,
          );
    return out.trim() || null;
  } catch {
    return null;
  } // tool absent, keychain locked, or no entry — all "not found"
}

function kcSet(key) {
  try {
    if (process.platform === "darwin") {
      // `security add-generic-password -w <key>` puts the secret in an argv element,
      // where `ps` shows it to every process on the machine for the life of the call.
      // `security -i` reads the SAME command from stdin instead, so the key never
      // appears in the process table. Quote it, because -i uses shell-like tokenising.
      const q = '"' + String(key).replace(/([\\"])/g, "\\$1") + '"';
      execFileSync("security", ["-i"], {
        ...QUIET,
        input: `add-generic-password -U -s ${KC_SERVICE} -a ${KC_ACCOUNT} -w ${q}\n`,
      });
      // -i reports per-command failures on stderr but still exits 0, so confirm the
      // entry is actually readable rather than trusting the exit code.
      if (kcGet() !== key) return false;
    } else {
      execFileSync(
        "secret-tool",
        ["store", "--label=backlinks.sh API key", "service", KC_SERVICE, "account", KC_ACCOUNT],
        { ...QUIET, input: key },
      );
    }
    return true;
  } catch {
    return false;
  }
}

function kcDelete() {
  try {
    if (process.platform === "darwin")
      execFileSync(
        "security",
        ["delete-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT],
        QUIET,
      );
    else
      execFileSync("secret-tool", ["clear", "service", KC_SERVICE, "account", KC_ACCOUNT], QUIET);
    return true;
  } catch {
    return false;
  }
}

/** Does a legacy plaintext credentials file exist? Used ONLY to explain, never to authenticate. */
function legacyFileExists() {
  try {
    return Boolean(JSON.parse(fs.readFileSync(CRED_FILE, "utf8"))?.api_key);
  } catch {
    return false;
  }
}

function warnLegacyFile() {
  console.error(`⚠ A legacy plaintext key file exists and is NO LONGER READ: ${CRED_FILE}`);
  console.error(`  An API key in a plain file is readable by anything running as you, so this`);
  console.error(`  version does not accept it. Move it into the keychain, then delete the file:`);
  console.error(`    printf %s "$YOUR_KEY" | node backlink-audit.mjs --login`);
  console.error(`    node backlink-audit.mjs --logout        # deletes the stale file`);
}

function backlinksKey() {
  if (process.env.BACKLINKS_SH_API_KEY) return process.env.BACKLINKS_SH_API_KEY;
  const k = kcGet();
  if (k) return k;
  if (legacyFileExists()) warnLegacyFile();
  return null;
}

function cmdLogin() {
  let key = "";
  try {
    key = fs.readFileSync(0, "utf8").trim();
  } catch {
    /* no stdin */
  }
  if (!key) {
    console.error("--login reads the key from STDIN (never from argv, which `ps` can see):");
    console.error('  printf %s "$BACKLINKS_SH_API_KEY" | node backlink-audit.mjs --login');
    process.exit(2);
  }
  if (kcSet(key)) {
    console.error(
      `stored the backlinks.sh API key in the OS keychain via ${KC_BIN} (service=${KC_SERVICE}, account=${KC_ACCOUNT}).`,
    );
    console.error(`clear it any time with: node backlink-audit.mjs --logout`);
    process.exit(0);
  }
  // No keychain => REFUSE. Writing the key to a plain file would be silently
  // downgrading the storage you asked for, and a long-lived API key in the clear is
  // exactly what --login exists to avoid. Nothing is written.
  console.error(
    `✋ No usable OS keychain (${KC_BIN} not found, locked, or refused). Nothing was stored.`,
  );
  console.error(``);
  console.error(
    `   This command will not fall back to a plaintext file — a key on disk in the clear`,
  );
  console.error(`   is readable by anything running as you, and you asked for a keychain.`);
  console.error(``);
  console.error(`   Either install a keychain and re-run:`);
  console.error(`     Linux:  apt install libsecret-tools   (or your distro's libsecret package)`);
  console.error(
    `     macOS:  \`security\` ships with the OS — check your login keychain is unlocked`,
  );
  console.error(``);
  console.error(`   Or skip storage entirely and pass the key per-run, which never touches disk:`);
  console.error(`     BACKLINKS_SH_API_KEY=... node backlink-audit.mjs --source backlinks ...`);
  process.exit(1);
}

function cmdLogout() {
  const hadKc = Boolean(kcGet());
  const kcCleared = hadKc ? kcDelete() : false;
  let fileCleared = false;
  try {
    fs.unlinkSync(CRED_FILE);
    fileCleared = true;
  } catch {
    /* nothing to delete */
  }
  console.error(
    `keychain (${KC_SERVICE}/${KC_ACCOUNT}): ${hadKc ? (kcCleared ? "cleared" : "FOUND BUT COULD NOT CLEAR") : "nothing stored"}`,
  );
  console.error(`file (${CRED_FILE}): ${fileCleared ? "deleted" : "nothing stored"}`);
  if (process.env.BACKLINKS_SH_API_KEY) {
    console.error(
      `⚠ BACKLINKS_SH_API_KEY is still set in this environment. Unset it in your shell and in any`,
    );
    console.error(
      `  profile/env file that exports it — this command cannot reach into your shell.`,
    );
  }
  console.error(`\nLocal removal does NOT revoke the key server-side. Rotate or delete it in your`);
  console.error(`backlinks.sh account: ${ACCOUNT_URL}`);
  process.exit(0);
}
async function fromBacklinks(target) {
  const key = backlinksKey();
  if (!key)
    throw new Error(
      "backlinks source needs BACKLINKS_SH_API_KEY in the environment, or a key stored with --login (OS keychain). Plaintext credential files are not read.",
    );
  // API wants a bare domain via ?target= (NOT scheme/path); it is host-level.
  const res = await fetch(
    `https://api.backlinks.sh/v1/backlinks?target=${encodeURIComponent(target)}`,
    { headers: { "x-api-key": key } },
  );
  if (!res.ok) throw new Error(`backlinks.sh HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Shape (confirmed 2026-06-05): { target_domain, status, data_tier:"domain",
  //   data: { backlinks: [...], total_backlinks, referring_domains }, pagination }.
  // status "no_data" → empty (site not in the Common-Crawl graph — common for new sites).
  const rows = data?.data?.backlinks ?? data.backlinks ?? data.results ?? [];
  return rows.map((it) =>
    typeof it === "string"
      ? { source: it, count: 1, unit: "backlink" }
      : {
          source: it.source_url ?? it.url ?? it.source_domain ?? it.domain ?? it.referring_domain,
          count: it.count ?? it.links ?? 1,
          unit: "backlink",
        },
  );
}

// Discovered links from any method (web search, manual list). The agent runs a
// web search for the target term, collects referring URLs, and passes them here.
function fromUrls(args) {
  let list = [];
  if (args.urls)
    list = String(args.urls)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  else if (args["urls-file"])
    list = fs
      .readFileSync(args["urls-file"], "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
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
    const n = cols
      .slice(1)
      .map(Number)
      .find((x) => Number.isFinite(x));
    rows.push({ source: cols[0], count: Number.isFinite(n) ? n : 1, unit: "linking-pages" });
  }
  return rows;
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (args.logout) cmdLogout();
if (args.login) cmdLogin();
const target = args._[0];
const source = args.source ?? (target && /^[^/]+\/[^/]+$/.test(target) ? "github" : null);
if (!target || !source) {
  console.error(
    "usage: backlink-audit <target> --source github|urls|backlinks|gsc-csv [--csv f] [--urls a,b | --urls-file f]",
  );
  console.error(
    "                      [--allowlist f] [--json] [--write-state --target-key k [--state f]]",
  );
  console.error("       backlink-audit --login    (backlinks.sh API key on stdin → OS keychain)");
  console.error(
    "       backlink-audit --logout   (clear the key from the OS keychain; also deletes a legacy plaintext file)",
  );
  process.exit(2);
}

// Check the --write-state inputs BEFORE any source runs, so a bad key or a
// placeholder allowlist never costs a paid backlinks.sh call.
const allowRes = resolveAllowlist(args);
const { allow, example: allowIsExample } = loadAllowlist(allowRes);
if (allowIsExample) warnExampleAllowlist();
let statePath = null;
let targetKey = null;
if (args["write-state"]) {
  targetKey = args["target-key"];
  if (!targetKey || targetKey === true)
    die("--write-state needs --target-key <key> (e.g. my-repo, my-site)");
  if (!TARGET_KEY_RE.test(targetKey))
    die(
      `--target-key "${targetKey}": use letters, digits, dot, dash or underscore (max 64), starting with a letter or digit`,
    );
  if (allowIsExample)
    die(
      "✋ --write-state refused: the allowlist is the placeholder example, so the ours/organic split would be wrong. Nothing was written.",
    );
  if (args.state === true) die("--state needs a path");
  statePath =
    (typeof args.state === "string" && args.state) ||
    process.env.BACKLINK_AUDIT_STATE ||
    DEFAULT_STATE;
}

let links;
if (source === "github") links = fromGithub(target);
else if (source === "backlinks") links = await fromBacklinks(target);
else if (source === "gsc-csv") links = fromGscCsv(args.csv);
else if (source === "urls") links = fromUrls(args);
else throw new Error(`unknown --source ${source}`);

const classified = links.map((l) => ({ ...l, ...classify(l.source, allow) }));
const sum = (cls) =>
  classified.filter((l) => l.cls === cls).reduce((s, l) => s + (l.count || 0), 0);
const report = {
  target,
  source,
  unit: links[0]?.unit ?? "n/a",
  allowlist: allowRes.from,
  allowlist_is_example: allowIsExample,
  totals: {
    ours: sum("ours"),
    organic: sum("organic"),
    ambiguous: sum("ambiguous"),
    links: classified.length,
  },
  links: classified.sort((a, b) => (b.count || 0) - (a.count || 0)),
  caveat:
    source === "github"
      ? "GitHub gives traffic REFERRERS for the repo, not raw backlinks; counts are views."
      : undefined,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `\nBacklink audit — ${target}  (source: ${source}, unit: ${report.unit}, allowlist: ${report.allowlist})`,
  );
  if (report.caveat) console.log(`  ⚠ ${report.caveat}`);
  if (allowIsExample)
    console.log(`  ⚠ placeholder allowlist — the ours/organic split below is not meaningful`);
  console.log(
    `  ours=${report.totals.ours}  organic=${report.totals.organic}  ambiguous=${report.totals.ambiguous}  (${report.totals.links} sources)\n`,
  );
  for (const l of report.links) {
    const tag = l.cls === "ours" ? "OURS  " : l.cls === "ambiguous" ? "AMBIG " : "ORGNC ";
    console.log(
      `  [${tag}] ${String(l.count).padStart(5)}  ${l.source}${l.why ? `   — ${l.why}` : ""}`,
    );
  }
  console.log("");
}

if (statePath) {
  // Opt-in by flag: this is the only thing the tool writes outside its own folder.
  // Start from an empty store if the file does not exist yet (fresh install).
  let st = {};
  try {
    st = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  }
  st.inbound_targets = st.inbound_targets ?? {};
  st.inbound_targets[targetKey] = { external: report.totals.organic, ours: report.totals.ours };
  st.last_run = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
  console.error(
    `wrote inbound_targets.${targetKey} = {external:${report.totals.organic}, ours:${report.totals.ours}} (ambiguous ${report.totals.ambiguous} excluded) → ${statePath}`,
  );
}
