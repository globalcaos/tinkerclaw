#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * CAPABILITY COVERAGE — what does this fork DO, and can it prove each thing is working?
 *
 * THE OPTIC IS THE AUTHORITY. TINKER_UI_DESIGN_BIBLE/observability.md holds the principle and the
 * judgement. This file is ONE ENCODING of it. When the two disagree, the optic is right and this
 * script is the bug. Same contract as scripts/bible/check-foundation-bounded.mjs, and for the same
 * reasons: a predicate cannot hold the useful ambiguity a principle carries, and code buried in
 * YAML frontmatter cannot be linted, unit-tested or reviewed as code.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────────────────────
 * On 2026-08-04 four features were found dead while looking perfectly healthy, each for weeks:
 *
 *   Fractal Reflection      2,379 result rows, ZERO successes since 2026-06-11 (two prompt assets
 *                           were never staged into dist).
 *   Semantic memory search  5,258 chunks indexed, ZERO vectors — a table declared FLOAT[3072]
 *                           against an embedder that emits 1024. Surfaced only as a log.warn.
 *   Overseer nudges         188 scope refusals, 0 nudges — 19 fork.* RPCs unclassified, and
 *                           unclassified means default-deny.
 *   ENGRAM ingestion        dead since 2026-07-28: the hook read `payload.text` while the emitter
 *                           passes `assistantTexts`. It bailed silently on EVERY turn.
 *
 * The common shape is a PLAUSIBLE NON-ERROR: an empty result, a healthy-looking no-op, a warn
 * nobody reads. None of them threw. None of them was hard to fix. Finding out they existed was
 * the entire cost. That is a coverage problem, and coverage is measurable — so measure it.
 *
 * ── THE THREE BUCKETS ────────────────────────────────────────────────────────────────────────
 *   OBSERVED  a signal exists AND has produced a positive in the window (an artefact on disk, a
 *             ledger row, a `res ✓`, a census row out of the never-list). Says IT RAN. It does
 *             NOT say it ran CORRECTLY — fractal was OBSERVED-by-ledger for eight weeks while
 *             every row said failure.
 *   DECLARED  the signal MECHANISM exists — an instrument, a success-path log, an expected
 *             artefact path, a ledger column — and has never produced a positive. A DECLARED row
 *             is a LIVE BUG, not a doc gap. It is worse than blind, because the report says a
 *             reassuring word ("pending") about something that is broken.
 *   BLIND     nothing anywhere would change if this stopped working today.
 *
 * ── DERIVED, NOT WRITTEN ─────────────────────────────────────────────────────────────────────
 * FOUNDATION #2 forbids frozen lists: a hand-maintained inventory is a lie with a timestamp. Every
 * row below is computed on each run from the tree and from ~/.openclaw. Each row carries the query
 * that produced it (R1…R20, printed with --queries), so anyone can re-derive it by hand and get
 * the same answer. The ONLY hand-written content is JUDGEMENTS (below) — a short, explicitly
 * labelled table where each entry carries its reason inline, exactly like the `byConfig` bucket in
 * src/infra/instrument-liveness.ts. If you find yourself adding a capability NAME to this file,
 * you have found a missing derivation, not a missing list entry.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CLAIM ────────────────────────────────────────────────────
 *   1. Coverage is scored per SEAM, not per code path. A plugin with one instrument is not proven
 *      healthy in its other nine paths. Read a row as "would anything tell me if THIS seam died".
 *   2. `⇄ res ✓/✗` is emitted ONLY on the [ws] transport. In-process dispatch through
 *      callGatewayLeastPrivilege emits nothing — proven 2026-08-04 when fork.curiosity.topGaps
 *      succeeded six times with zero res lines. So "never on the wire" is NOT "never invoked",
 *      and this script says so in the footer every run rather than quietly overstating BLIND.
 *   3. Absence of journal evidence inside the window is not proof of death for a rare producer.
 *      That is why the window is a flag and the ratchet is on BLIND (a structural fact) and not
 *      on DECLARED (a timing-sensitive one).
 *
 * ── NO DAEMON ────────────────────────────────────────────────────────────────────────────────
 * This must run with the gateway down. Every runtime input is a FILE or the systemd journal, both
 * read best-effort with a timeout; each missing input degrades one subsystem to "unknown" and is
 * reported, never silently dropped. A doc/coverage tool that needs a daemon is the mistake INDEX.md
 * already reverted on 2026-08-02.
 *
 * Usage:
 *   node scripts/bible/capability-coverage.mjs              # table + headline + ratchet
 *   node scripts/bible/capability-coverage.mjs --blind      # only the gaps
 *   node scripts/bible/capability-coverage.mjs --declared   # only the live bugs
 *   node scripts/bible/capability-coverage.mjs --json       # machine-readable
 *   node scripts/bible/capability-coverage.mjs --pipe       # id | name | source | observable | evidence
 *   node scripts/bible/capability-coverage.mjs --queries    # print the derivation legend
 *   node scripts/bible/capability-coverage.mjs --since=-72h # widen the evidence window
 *   node scripts/bible/capability-coverage.mjs --no-journal # tree + filesystem only
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPENCLAW = process.env.OPENCLAW_DIR || path.join(homedir(), ".openclaw");

/**
 * RATCHET — the MEASURED status quo on 2026-08-04, not a target.
 *
 * BLIND may FALL, never RISE. Adding a capability with nothing watching it fails the build;
 * instrumenting one and lowering this number in the same commit passes. Same discipline as
 * scripts/check-broken-relative-imports.mjs and canonical-ledger-ratchet.mjs, and for the same
 * reason: a gate that demanded zero on day one would be switched off by Friday.
 *
 * Raising this number is not a fix. If a genuinely unobservable capability arrives, say why in
 * TINKER_UI_DESIGN_BIBLE/observability.md and add it to JUDGEMENTS below WITH ITS REASON.
 *
 * IT IS MEASURED ON THE STRUCTURAL PASS ONLY — the tree and the filesystem, never the journal —
 * so it is identical on this host, on CI and on a fresh clone. A ratchet that moved because a
 * machine happened to have three days of logs would be switched off the first time it flapped.
 * The journal makes the REPORT sharper; it must never make the GATE non-deterministic.
 */
export const BLIND_CAP = 358;
// 2026-08-05: 377 -> 358, pulled down in the same session that earned it. A ratchet only means
// something if the number moves the moment the work lands; a cap left above the measured value is
// slack that silently absorbs the next regression. What moved it: fractal-reflection's first
// instruments, the gateway RPC dispatch/refusal counters covering 337 methods at one chokepoint,
// and per-hook liveness wrapped at the registerTypedHook seam (19 fork hooks BLIND -> DECLARED).

/** Directories that must never be walked. A recursive glob over an extension tree hung the bible gate once. */
const PRUNE = new Set([
  "node_modules",
  "dist",
  "dist-runtime",
  "build",
  ".git",
  "coverage",
  "__snapshots__",
  ".turbo",
  ".next",
]);
const IS_TEST = /\.test\.ts$|\.spec\.ts$|__tests__|test-harness|test-support|test-helpers/;

/**
 * JUDGEMENTS — the ONLY hand-written content in this file, and each entry carries its reason
 * inline, per the pattern of the `conditional` field in src/infra/instrument-liveness.ts. These are
 * not capability names; they are RULES about how derived rows are scored. Adding a capability name
 * here is forbidden — that is the frozen list FOUNDATION #2 rejects.
 */
const JUDGEMENTS = [
  {
    id: "scope:allow-gated-plugins-are-one-rollup",
    rule: "Plugins built into the tree but absent from plugins.allow collapse into ONE rollup row.",
    reason:
      "plugins.allow is a HARD gate: an unlisted plugin never registers, so no per-plugin signal is even possible. 120+ individual BLIND rows would drown the rows that can actually be fixed. The rollup is still reported, so the number never reads as zero.",
  },
  {
    id: "scope:tests-excluded",
    rule: "*.test.ts / *.spec.ts / test-helpers are excluded from every derivation.",
    reason:
      "test fixtures declare instrument ids ('peer-a', 'undeclared', 'healthy') that would inflate the declared count and mask the real one. Verified 2026-08-04: 7 fixture ids leak into a naive grep.",
  },
  {
    id: "signal:algorithm-families-cannot-read-never",
    rule: "An algorithm-metrics family is scored from its ledger rows only, never from absence.",
    reason:
      "families auto-register by FIRING, so fireCount===0 is unreachable — if a family stops recording, its row simply vanishes at the next restart and no line is emitted. Absence here is not evidence, so it is not scored as one.",
  },
  {
    id: "signal:byconfig-is-declared-not-observed",
    rule: "An instrument the live census marks 'silent BY CONFIGURATION' is DECLARED, not OBSERVED, and carries the runtime reason string verbatim.",
    reason:
      "a deliberate off must not read as a defect (that is what byConfig is for) but it must not read as WORKING either. The reason is READ FROM THE JOURNAL, not written here, so it cannot go stale against the code.",
  },
  {
    id: "signal:wire-evidence-understates",
    rule: "RPC methods with no `res` line are BLIND, and the footer says every run that this OVERSTATES the gap.",
    reason:
      "`⇄ res ✓/✗` is [ws]-transport-only; in-process dispatch emits nothing. Reporting the caveat every run is honest; silently narrowing the number would let a real gap hide behind a caveat nobody re-reads.",
  },
];

// ── primitives ────────────────────────────────────────────────────────────────────────────────

function walk(dir, out = [], filter = (n) => n.endsWith(".ts")) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) walk(path.join(dir, e.name), out, filter);
    } else if (e.isFile() && filter(e.name) && !IS_TEST.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const readText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const mtime = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};
const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—");

/**
 * The journal, best-effort. A hard timeout and a swallowed failure: the whole point is that this
 * tool works on a machine where the gateway is down, or on a clone where systemd is not the
 * supervisor. What we cannot read, we report as unknown.
 */
function journal(since) {
  const r = spawnSync(
    "journalctl",
    ["--user", "-u", "openclaw-gateway.service", "--since", since, "--no-pager", "-o", "cat"],
    { encoding: "utf8", timeout: 25_000, maxBuffer: 512 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout;
}

// ── derivations (the query legend lives in QUERIES, printed with --queries) ────────────────────

const QUERIES = {
  R1: "find extensions -maxdepth 2 -name openclaw.plugin.json",
  R2: "jq -r '.plugins.allow[]' $OPENCLAW/openclaw.json",
  R3: "journal | grep -oP 'http server listening \\(\\d+ plugins: [^)]+' (INCOMPLETE — see footer)",
  R4: 'multiline scan for api.on("<event>" under extensions/, bounded window per match',
  R5: '"<method>": handler literals at handler-table indentation in src/gateway/server-methods/*.ts',
  R6: 'registerGatewayMethod("<name>" literals under extensions/',
  R7: "journal | grep -oP '⇄ res (✓|✗) [A-Za-z0-9._-]+' | aggregate per method",
  R9: 'registerTool( windows carrying name:"x" or names:[…]; optional:true noted',
  R10: "$OPENCLAW/cron/jobs.json ⋈ cron/jobs-state.json ⋈ cron/reports/*/* ⋈ cron/runs/*.jsonl",
  R11: "declareInstrument({ … id: … }) bounded windows, WITH const-indirected ids resolved",
  R12: "noteInstrumentFired(<id>) call sites, const-indirected ids resolved",
  R13: "journal | last '[instrument-liveness] declared=… ' census + its named per-id rows",
  R14: "$OPENCLAW/data/algorithm-metrics.jsonl grouped by algorithm family",
  R16: "grep -oP 'data-tab=\"…\"' tinker-ui/src/app.ts ∪ tinker-ui/src/panels/*.ts modules",
  R17: "jq keys of $OPENCLAW/data/tinker-ui-state.json",
  R18: "first backticked cell of each row of TINKER_UI_DESIGN_BIBLE/probes.md",
  R20: "mtime of each runtime store under $OPENCLAW (depth 1) and $OPENCLAW/data (depth 1)",
};

/** R11 + R12. Resolves `id: SOME_CONST` — the literal-only grep undercounts, verified 2026-08-04. */
export function deriveInstruments(files) {
  const consts = new Map(); // CONST_NAME -> "literal"
  const declared = new Map(); // id -> {file, label}
  const fired = new Map(); // id -> count
  const rawDeclared = []; // [{token, file}] before const resolution
  const rawFired = [];

  for (const f of files) {
    const text = readText(f);
    if (!text.includes("declareInstrument") && !text.includes("noteInstrumentFired")) {
      // still harvest consts: the id may be defined in a module that does neither
      for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g))
        consts.set(m[1], m[2]);
      continue;
    }
    for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g))
      consts.set(m[1], m[2]);

    // Bounded-slice scan, NOT brace counting. Counting delimiters to reconstruct structure is how
    // you get a parser that is subtly wrong on the one file that matters; a regex over a bounded
    // window either matches or does not, and a miss shows up as a LOWER number, not a wrong one.
    for (const chunk of text.split("declareInstrument({").slice(1)) {
      const end = chunk.indexOf("})");
      const win = end === -1 ? chunk.slice(0, 600) : chunk.slice(0, end);
      const m = /\bid:\s*("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*)/.exec(win);
      if (!m) continue;
      const label = /\blabel:\s*"([^"]+)"/.exec(win)?.[1] ?? "";
      rawDeclared.push({ token: m[2] ?? m[1], file: f, label, literal: Boolean(m[2]) });
    }
    for (const m of text.matchAll(/noteInstrumentFired\(\s*("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*)/g)) {
      rawFired.push({ token: m[2] ?? m[1], file: f, literal: Boolean(m[2]) });
    }
  }

  const resolve = (t, literal) => (literal ? t : (consts.get(t) ?? null));
  for (const d of rawDeclared) {
    const id = resolve(d.token, d.literal);
    if (id) declared.set(id, { file: path.relative(repoRoot, d.file), label: d.label });
  }
  for (const f of rawFired) {
    const id = resolve(f.token, f.literal);
    if (id) fired.set(id, (fired.get(id) ?? 0) + 1);
  }
  return { declared, fired, sites: rawDeclared.length, fireSites: rawFired.length };
}

/** R13. The live census — aggregate counts plus the only two NAMEABLE buckets it emits. */
export function deriveCensus(log) {
  if (!log) return null;
  const head =
    /\[instrument-liveness\] declared=(\d+) live=(\d+) pending=(\d+) never=(\d+) stale=(\d+) idle=(\d+) byConfig=(\d+)/g;
  let last = null;
  let lastIdx = -1;
  for (const m of log.matchAll(head)) {
    last = m;
    lastIdx = m.index;
  }
  if (!last) return null;
  const tail = log.slice(lastIdx, lastIdx + 40_000);
  const flagged = new Map(); // id -> {state, reason}
  for (const m of tail.matchAll(/\[instrument-liveness\] ([a-z][\w:./-]+) — ([^\n]+)/g)) {
    const [, id, rest] = m;
    if (/silent BY CONFIGURATION, not broken: /.test(rest)) {
      flagged.set(id, {
        state: "byConfig",
        reason: rest.split("silent BY CONFIGURATION, not broken: ")[1],
      });
    } else if (/has NEVER fired/.test(rest)) {
      flagged.set(id, { state: "never", reason: rest.split("; ")[1] ?? rest });
    } else if (/stale|has not fired/i.test(rest)) {
      flagged.set(id, { state: "stale", reason: rest });
    }
  }
  return {
    declared: +last[1],
    live: +last[2],
    pending: +last[3],
    never: +last[4],
    stale: +last[5],
    idle: +last[6],
    byConfig: +last[7],
    flagged,
    // The census names ONLY never/stale/byConfig. live/pending/idle are structurally unnameable
    // (instrument-liveness.ts:528-540 enumerates only those three), so 15 of 25 rows — every
    // healthy one — cannot be identified from the log. Reported, not worked around.
    nameable: flagged.size,
  };
}

/** R14. Algorithm-effectiveness ledger, grouped. Read from the tail: the file grows without bound. */
export function deriveLedger(file, sinceMs) {
  if (!existsSync(file)) return null;
  let text = "";
  try {
    const size = statSync(file).size;
    const cap = 24 * 1024 * 1024;
    if (size <= cap) text = readFileSync(file, "utf8");
    else {
      const fd = readFileSync(file); // node has no cheap tail; slice the buffer
      text = fd.subarray(size - cap).toString("utf8");
    }
  } catch {
    return null;
  }
  const fam = new Map();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const a = r.algorithm;
    if (!a) continue;
    const t = Date.parse(r.ts ?? "") || 0;
    const cur = fam.get(a) ?? { rows: 0, recent: 0, last: 0, variants: new Set() };
    cur.rows++;
    if (t > cur.last) cur.last = t;
    if (t >= sinceMs) cur.recent++;
    if (r.variant) cur.variants.add(r.variant);
    fam.set(a, cur);
  }
  return fam;
}

/** R7. Wire evidence per gateway method. */
export function deriveWire(log) {
  if (!log) return null;
  const ok = new Map();
  const err = new Map();
  for (const m of log.matchAll(/⇄ res (✓|✗) ([A-Za-z0-9._-]+)/g)) {
    const t = m[1] === "✓" ? ok : err;
    t.set(m[2], (t.get(m[2]) ?? 0) + 1);
  }
  return { ok, err };
}

/** R5. Core gateway methods, extracted statically so this never needs to import the gateway. */
export function extractRpcMethods(text) {
  const out = [];
  for (const m of text.matchAll(
    /^[ \t]{2,}"([a-z][a-zA-Z0-9_.]*)":\s*(?:async\s*)?(?:\(|function|[A-Za-z_])/gm,
  ))
    out.push(m[1]);
  return out;
}

/** R4. Hook seams. Multiline-tolerant: `api.on(\n  "llm_output",` is the common formatting. */
export function extractHooks(text) {
  const out = [];
  for (const m of text.matchAll(/\bapi\.on\(\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g)) {
    // Bounded window: to the next api.on( or 6000 chars, whichever comes first.
    const from = m.index + m[0].length;
    const nextIdx = text.indexOf("api.on(", from);
    const win = text.slice(from, nextIdx === -1 ? from + 6000 : Math.min(nextIdx, from + 6000));
    const instrumented = /noteInstrumentFired\(|recordAlgorithmOutcome\(/.test(win);
    // A log that only exists inside a catch is the ENGRAM/memory-core shape: the failure path is
    // loud and the success path is silent, so a hook that bails on EVERY turn looks identical to a
    // hook that never had work to do. Approximate but cheap: is there a log call before the first
    // catch in the window?
    const firstCatch = win.search(/\bcatch\s*[({]/);
    const logs = [...win.matchAll(/\blog\.(info|warn|error|debug)\(/g)].map((x) => x.index);
    const successLog = logs.some((i) => firstCatch === -1 || i < firstCatch);
    const catchOnlyLog = logs.length > 0 && !successLog;
    out.push({ event: m[1], instrumented, successLog, catchOnlyLog });
  }
  return out;
}

/** R9. Tool registrations, with the optional-tool trap flagged. */
export function extractTools(text) {
  const out = [];
  for (const m of text.matchAll(/\bapi\.registerTool\(/g)) {
    const win = text.slice(m.index, m.index + 900);
    const optional = /\boptional:\s*true/.test(win);
    const single = /\bname:\s*"([a-z][a-zA-Z0-9_]*)"/.exec(win);
    if (single) out.push({ name: single[1], optional });
    const many = /\bnames:\s*\[([^\]]+)\]/.exec(win);
    if (many)
      for (const n of many[1].matchAll(/"([a-z][a-zA-Z0-9_]*)"/g))
        out.push({ name: n[1], optional });
  }
  return out;
}

// ── assembly ──────────────────────────────────────────────────────────────────────────────────

function build(opts) {
  const caps = [];
  const notes = [];
  const add = (c) => caps.push(c);
  const log = opts.journal ? journal(opts.since) : null;
  if (opts.journal && log === null)
    notes.push(
      "journal unreadable (gateway never ran here, or no systemd) — RPC/plugin/instrument liveness degraded to structural evidence only",
    );
  const sinceMs = Date.now() - opts.windowMs;
  const wire = deriveWire(log);
  const census = deriveCensus(log);

  // ── OBS: the observability machinery itself ────────────────────────────────────────────────
  const srcFiles = walk(path.join(repoRoot, "src"));
  const extRoot = path.join(repoRoot, "extensions");
  const extDirs = (() => {
    try {
      return readdirSync(extRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  })();
  const forkExtFiles = extDirs
    .filter((d) => d.startsWith("tinkerclaw-"))
    .flatMap((d) => walk(path.join(extRoot, d)));

  const inst = deriveInstruments([...srcFiles, ...forkExtFiles]);
  for (const [id, meta] of [...inst.declared].sort()) {
    const fireSites = inst.fired.get(id) ?? 0;
    const flag = census?.flagged.get(id);
    let status, evidence;
    if (fireSites === 0) {
      status = "DECLARED";
      evidence = `declared at ${meta.file}, ZERO noteInstrumentFired sites anywhere — it can never fire, whatever the config says`;
    } else if (flag?.state === "byConfig") {
      status = "DECLARED";
      evidence = `silent BY CONFIGURATION (runtime reason, verbatim): ${flag.reason}`;
    } else if (flag?.state === "never") {
      status = "DECLARED";
      evidence = `census ${iso(census ? Date.now() : 0)}: NEVER fired — ${flag.reason}`;
    } else if (flag?.state === "stale") {
      status = "DECLARED";
      evidence = `census: stale — ${flag.reason}`;
    } else if (census) {
      status = "OBSERVED";
      evidence = `${fireSites} firing site(s); absent from the census never/stale list at the last report`;
    } else {
      status = "DECLARED";
      evidence = `${fireSites} firing site(s) in source; no census available to prove a positive`;
    }
    add({
      id: `obs.instrument.${id}`,
      name: meta.label || id,
      subsystem: "OBS",
      query: "R11,R12,R13",
      source: meta.file,
      signal: "declareInstrument/noteInstrumentFired + hourly census",
      status,
      evidence,
      lastSeen: null,
    });
  }
  notes.push(
    `instruments: ${inst.sites} declareInstrument site(s) → ${inst.declared.size} unique id(s); ${inst.fireSites} firing site(s) → ${inst.fired.size} unique id(s). Const-indirected ids ARE resolved; a literal-only grep undercounts.`,
  );

  // Ledger families. Scored from rows only — see JUDGEMENTS/algorithm-families-cannot-read-never.
  const ledger = deriveLedger(path.join(OPENCLAW, "data", "algorithm-metrics.jsonl"), sinceMs);
  if (ledger) {
    for (const [fam, v] of [...ledger].sort()) {
      add({
        id: `obs.ledger.${fam}`,
        name: `algorithm-metrics family: ${fam}`,
        subsystem: "OBS",
        query: "R14",
        source: "~/.openclaw/data/algorithm-metrics.jsonl",
        signal: "numeric outcome ledger",
        status: v.recent > 0 ? "OBSERVED" : "DECLARED",
        evidence:
          v.recent > 0
            ? `${v.recent} row(s) in window of ${v.rows} total; variants: ${[...v.variants].join(",")}`
            : `${v.rows} row(s) total but NONE in the window — a family that stops recording simply vanishes at the next restart and emits no line`,
        lastSeen: v.last,
      });
    }
  } else {
    notes.push("algorithm-metrics ledger not readable — ledger families unscored");
  }

  // ── plugins (R1 ∩ R2 ∩ journal) ────────────────────────────────────────────────────────────
  const cfg = readJson(path.join(OPENCLAW, "openclaw.json"));
  const allow = new Set(cfg?.plugins?.allow ?? []);
  const manifests = [];
  for (const d of extDirs) {
    const mf = path.join(extRoot, d, "openclaw.plugin.json");
    if (!existsSync(mf)) continue;
    const j = readJson(mf);
    manifests.push({ dir: d, id: (j?.id ?? d).trim() });
  }
  let gatedOff = 0;
  const countOf = (needle) => {
    if (!log) return 0;
    let n = 0;
    let i = 0;
    for (;;) {
      i = log.indexOf(needle, i);
      if (i === -1) return n;
      n++;
      i += needle.length;
    }
  };
  const loadable = manifests.filter((m) => allow.has(m.id) || allow.has(m.dir));
  // A plugin's own log tag is its SHORT name (`[prefrontal]`, verified 2026-08-04). Two manifests
  // can collapse onto the same short tag — `whatsapp` and `tinkerclaw-whatsapp` both log
  // `[whatsapp]` — and when they do, the tag proves ONE of them ran and cannot say which. That
  // ambiguity is itself a finding (the upstream allow entry is a no-op), so it is reported, not
  // resolved by a guess.
  const shortOf = (id) => id.replace(/^tinkerclaw-/, "");
  const tagOwners = new Map();
  for (const m of loadable) tagOwners.set(shortOf(m.id), (tagOwners.get(shortOf(m.id)) ?? 0) + 1);
  for (const { dir, id } of manifests.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!allow.has(id) && !allow.has(dir)) {
      gatedOff++;
      continue;
    }
    // Two DIFFERENT signals, deliberately not merged: a tagged line means TRAFFIC; a bare mention
    // of the id (the `http server listening (N plugins: …)` line, a path, a config echo) means at
    // most REGISTRATION — precisely the static property that hid the disabled-crons bug.
    const short = shortOf(id);
    const ambiguous = (tagOwners.get(short) ?? 0) > 1;
    const traffic = countOf(`[${short}]`);
    // Word-bounded, or `tinkerclaw-tinker` inherits every mention of `tinkerclaw-tinker-bridge`
    // and reports 6,368 phantom registrations.
    const mentions = log
      ? (log.match(new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![-\\w])`, "g")) ?? [])
          .length
      : 0;
    add({
      id: `plugin:${id}`,
      name: `plugin ${id}`,
      subsystem: "plugins",
      query: "R1∩R2∩R3",
      source: `extensions/${dir}/openclaw.plugin.json`,
      signal: `journal lines tagged [${short}] (traffic) vs bare mentions of the id (registration)`,
      status: !log
        ? "DECLARED"
        : traffic > 0 && !ambiguous
          ? "OBSERVED"
          : traffic > 0 || mentions > 0
            ? "DECLARED"
            : "BLIND",
      evidence: !log
        ? "allow-listed; no journal available to prove it even loaded"
        : traffic > 0 && ambiguous
          ? `${traffic} [${short}] line(s) — but that tag is shared by ${tagOwners.get(short)} allow-listed manifests, so it proves one of them ran and cannot say which`
          : traffic > 0
            ? `${traffic} tagged journal line(s) in window`
            : mentions > 0
              ? `id mentioned ${mentions}× (load line / paths / config echoes) but ZERO lines carry its own [${short}] tag — registration is not liveness`
              : "allow-listed and BUILT, yet absent from the journal entirely — indistinguishable from not loaded",
      lastSeen: null,
    });
  }
  if (gatedOff)
    add({
      id: "plugin-rollup:gated-off",
      name: `${gatedOff} plugins built into the tree and blocked by plugins.allow`,
      subsystem: "plugins",
      query: "R1 minus R2",
      source: "extensions/*/openclaw.plugin.json",
      signal: "none — plugins.allow is a hard gate, so no per-plugin signal is possible",
      status: "BLIND",
      evidence: `${gatedOff} of ${manifests.length} manifests are unreachable by construction, and nothing anywhere reports that`,
      lastSeen: null,
    });

  // ── hook seams (R4) ────────────────────────────────────────────────────────────────────────
  // Every LOADABLE extension, not just tinkerclaw-*: memory-core and codex register hooks into our
  // agent loop too, and memory-core's three hooks log ONLY in catch — the exact ENGRAM shape.
  for (const d of extDirs) {
    const pid = manifests.find((m) => m.dir === d)?.id ?? d;
    if (!allow.has(pid) && !allow.has(d)) continue;
    const seen = new Map();
    for (const f of walk(path.join(extRoot, d))) {
      for (const h of extractHooks(readText(f))) {
        const prev = seen.get(h.event);
        seen.set(h.event, {
          instrumented: (prev?.instrumented ?? false) || h.instrumented,
          successLog: (prev?.successLog ?? false) || h.successLog,
          catchOnlyLog: (prev?.catchOnlyLog ?? false) || h.catchOnlyLog,
          file: prev?.file ?? path.relative(repoRoot, f),
        });
      }
    }
    // FORK 2026-08-05 — CENTRAL WRAPPING. `registerTypedHook` (src/plugins/registry.ts) now passes
    // every `tinkerclaw-*` handler through `wrapHookForLiveness` (src/plugins/hook-liveness.ts),
    // which declares `hook:<plugin>:<event>` and fires it on dispatch. So a fork hook carries a
    // real signal even when its own body has none, and scoring it BLIND became the wrong answer.
    //
    // Credited as DECLARED, never OBSERVED, and the distinction is the whole point. The wrapper
    // proves DISPATCH — the handler was reached. It cannot prove the handler did anything, because
    // from the registry a handler that worked and a handler that hit an early return on line one
    // are the same event. total-recall's llm_output would have scored "observed" for eleven days
    // while writing nothing. DECLARED says "a mechanism exists and this static pass cannot show it
    // firing", which is exactly true; the journal pass promotes it to OBSERVED off the live census.
    const centrallyWrapped = pid.startsWith("tinkerclaw-");
    for (const [ev, v] of [...seen].sort()) {
      const status = v.instrumented
        ? "OBSERVED"
        : v.successLog || centrallyWrapped
          ? "DECLARED"
          : "BLIND";
      add({
        id: `hook:${pid}/${ev}`,
        name: `${pid} hook ${ev}`,
        subsystem: "hooks",
        query: "R4",
        source: v.file,
        signal: v.instrumented
          ? "instrument fired inside the handler"
          : centrallyWrapped
            ? "central dispatch instrument (registerTypedHook wrapper)"
            : v.successLog
              ? "success-path log line"
              : v.catchOnlyLog
                ? "log ONLY inside catch"
                : "none",
        status,
        evidence: v.instrumented
          ? "handler body reaches noteInstrumentFired/recordAlgorithmOutcome"
          : centrallyWrapped
            ? `wrapped at the registerTypedHook seam -> hook:${pid}:${ev} fires on DISPATCH. Proves the handler was reached, NOT that it did work — a handler that bails on line one looks identical from out here. For work, the plugin must declare its own success instrument.`
            : v.successLog
              ? "a log exists on the success path, but a log nobody greps is not a signal — no counter, no artefact"
              : v.catchOnlyLog
                ? "logs ONLY in catch — the exact ENGRAM shape: bailing on every turn is indistinguishable from having no work to do"
                : "no log on any path, no instrument, no artefact",
        lastSeen: null,
      });
    }
  }

  // ── gateway RPC (R5/R6 ⋈ R7) ───────────────────────────────────────────────────────────────
  const rpcOwner = new Map();
  for (const f of walk(path.join(repoRoot, "src", "gateway", "server-methods")))
    for (const m of extractRpcMethods(readText(f)))
      if (!rpcOwner.has(m)) rpcOwner.set(m, { kind: "core", src: path.relative(repoRoot, f) });
  for (const d of extDirs) {
    const pid = manifests.find((x) => x.dir === d)?.id ?? d;
    for (const f of walk(path.join(extRoot, d))) {
      const text = readText(f);
      if (!text.includes("registerGatewayMethod")) continue;
      for (const m of text.matchAll(/registerGatewayMethod\(\s*"([^"]+)"/g))
        if (!rpcOwner.has(m[1]))
          rpcOwner.set(m[1], {
            kind: "plugin",
            src: path.relative(repoRoot, f),
            owner: pid,
            gated: !(allow.has(pid) || allow.has(d)),
          });
    }
  }
  for (const [m, meta] of [...rpcOwner].sort()) {
    const ok = wire?.ok.get(m) ?? 0;
    const err = wire?.err.get(m) ?? 0;
    let status, evidence;
    if (meta.gated) {
      status = "BLIND";
      evidence = `registered in dist but owner '${meta.owner}' is NOT in plugins.allow — no signal is possible and nothing warns`;
    } else if (!wire) {
      status = "BLIND";
      evidence = "no journal — wire evidence unavailable";
    } else if (ok > 0) {
      status = "OBSERVED";
      const ratio = err / (ok + err);
      evidence =
        ratio > 0.2
          ? `${ok}✓/${err}✗ — ${Math.round(ratio * 100)}% FAILING and indistinguishable from healthy, because it does return successes`
          : `${ok}✓/${err}✗ on the wire in window`;
    } else if (err > 0) {
      status = "DECLARED";
      evidence = `${err}✗ and ZERO ✓ in window — called and never once succeeded`;
    } else {
      status = "BLIND";
      evidence =
        "no res line in window; note in-process dispatch emits none, so this is an upper bound on death, not a proof of it";
    }
    add({
      id: `rpc:${m}`,
      name: `gateway method ${m}`,
      subsystem: meta.kind === "core" ? "gateway-core" : "gateway-plugin",
      query: meta.kind === "core" ? "R5⋈R7" : "R6⋈R7",
      source: meta.src,
      signal: "⇄ res ✓/✗ (ws transport only)",
      status,
      evidence,
      lastSeen: null,
    });
  }

  // ── tools (R9) ─────────────────────────────────────────────────────────────────────────────
  const toolHits = new Map();
  if (log)
    for (const m of log.matchAll(/\btool=([a-zA-Z0-9_-]+)/g))
      toolHits.set(m[1], (toolHits.get(m[1]) ?? 0) + 1);
  for (const d of extDirs) {
    const pid = manifests.find((x) => x.dir === d)?.id ?? d;
    if (!(allow.has(pid) || allow.has(d))) continue;
    for (const f of walk(path.join(extRoot, d))) {
      for (const t of extractTools(readText(f))) {
        const hits = toolHits.get(t.name) ?? 0;
        add({
          id: `tool:${t.name}`,
          name: `agent tool ${t.name}`,
          subsystem: "tools",
          query: "R9",
          source: path.relative(repoRoot, f),
          signal: "tool=<name> journal lines (emitted by ONE plugin's hook, not by the core seam)",
          status: hits > 0 ? "OBSERVED" : t.optional ? "DECLARED" : "BLIND",
          evidence:
            hits > 0
              ? `${hits} tool= line(s) in window`
              : t.optional
                ? "registered {optional:true} → stripped by the empty-allowlist gate at tools.ts; registered and unreachable, and nothing says so"
                : "0 tool= lines in window; and the only per-tool logging in the system belongs to one plugin's hook — disable it and the whole tool surface goes dark",
          lastSeen: null,
        });
      }
    }
  }

  // ── crons (R10) ────────────────────────────────────────────────────────────────────────────
  const jobs = readJson(path.join(OPENCLAW, "cron", "jobs.json"))?.jobs ?? [];
  const state = readJson(path.join(OPENCLAW, "cron", "jobs-state.json"))?.jobs ?? {};
  const reportsRoot = path.join(OPENCLAW, "cron", "reports");
  const artefacts = new Map(); // jobSlug -> newest mtime
  try {
    for (const day of readdirSync(reportsRoot)) {
      for (const f of readdirSync(path.join(reportsRoot, day))) {
        const slug = f.replace(/\.md$/, "");
        const t = mtime(path.join(reportsRoot, day, f));
        if (t > (artefacts.get(slug) ?? 0)) artefacts.set(slug, t);
      }
    }
  } catch {
    notes.push("cron reports dir unreadable — cron artefact evidence unavailable");
  }
  for (const j of jobs) {
    const st = state[j.id]?.state ?? {};
    const slug = j.id;
    const art = artefacts.get(slug) ?? 0;
    const receipt = mtime(path.join(OPENCLAW, "cron", "runs", `${j.id}.jsonl`));
    let status, evidence;
    if (!j.enabled) {
      status = "BLIND";
      evidence = `disabled${st.consecutiveErrors ? `, ${st.consecutiveErrors} consecutive error(s)` : ""} — a disabled job proves nothing and nothing reports the silence`;
    } else if (st.lastError === "disabled" || st.lastStatus === "skipped") {
      status = "DECLARED";
      evidence = `enabled:true but lastStatus='${st.lastStatus}' lastError='${st.lastError}' in ${st.lastDurationMs}ms with consecutiveErrors=${st.consecutiveErrors} — it skips itself into silence and the counter stays clean`;
    } else if (art > 0) {
      status = "OBSERVED";
      evidence = `artefact on disk (${iso(art)}); status='${st.lastStatus}'${st.lastStatus !== "ok" ? " — the ARTEFACT proves the work, the status contradicts it" : ""}`;
    } else if (st.lastStatus === "ok") {
      status = "DECLARED";
      evidence =
        "lastStatus=ok and ZERO artefacts ever — status:ok is not evidence; the artefact is. (07-31…08-02 have no report dir at all while jobs-state says ok straight across the gap.)";
    } else {
      status = "DECLARED";
      evidence = `no artefact, lastStatus='${st.lastStatus}'`;
    }
    add({
      id: `cron:${j.id}`,
      name: j.name ?? j.id,
      subsystem: "crons",
      query: "R10",
      source: "~/.openclaw/cron/jobs.json",
      signal: "per-day report artefact + per-job run receipt",
      status,
      evidence,
      lastSeen: Math.max(art, receipt, st.lastRunAtMs ?? 0),
    });
  }

  // ── runtime stores (R20) ───────────────────────────────────────────────────────────────────
  // A subsystem that writes nothing is a subsystem that ran nothing. Derived by walking the
  // runtime root, so a new store appears here the day it is created — no list to update.
  const storeRoots = [OPENCLAW, path.join(OPENCLAW, "data")];
  const seenStore = new Set();
  for (const root of storeRoots) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(root, e.name);
      const rel = path.relative(OPENCLAW, p);
      // Config backups, dotfiles and rotated copies are not capabilities.
      if (
        /^\.|^openclaw\.json|\.bak|\.clobbered|^SOUL\.md\.|\.stub-|\.polluted-|-disabled-/.test(
          e.name,
        )
      )
        continue;
      if (seenStore.has(rel)) continue;
      seenStore.add(rel);
      let newest = mtime(p);
      let empty = false;
      if (e.isDirectory()) {
        try {
          const kids = readdirSync(p, { withFileTypes: true });
          empty = kids.length === 0;
          for (const k of kids.slice(0, 400))
            newest = Math.max(newest, mtime(path.join(p, k.name)));
        } catch {
          /* unreadable */
        }
      }
      const fresh = newest >= sinceMs;
      add({
        id: `store:${rel}`,
        name: `runtime store ~/.openclaw/${rel}`,
        subsystem: "stores",
        query: "R20",
        source: `~/.openclaw/${rel}`,
        signal: "mtime of the store — the only liveness proof a writer leaves behind",
        status: empty ? "DECLARED" : fresh ? "OBSERVED" : "DECLARED",
        evidence: empty
          ? `directory EXISTS and is EMPTY (dir mtime ${iso(newest)}) — enabled-and-empty is the worst possible signal`
          : fresh
            ? `written ${iso(newest)}`
            : `newest write ${iso(newest)} — outside the window; nothing alarms on a frozen mtime`,
        lastSeen: newest,
      });
    }
  }

  // ── tinker UI (R16/R17) ────────────────────────────────────────────────────────────────────
  const uiSrc = path.join(repoRoot, "tinker-ui", "src");
  const uiFiles = walk(uiSrc);
  const uiInstrumented = uiFiles.some((f) => readText(f).includes("declareInstrument("));
  const snapshot = readText(path.join(OPENCLAW, "data", "tinker-ui-snapshot.html"));
  const snapMtime = mtime(path.join(OPENCLAW, "data", "tinker-ui-snapshot.html"));
  const appText = readText(path.join(uiSrc, "app.ts"));
  const tabs = [...new Set([...appText.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1]))].sort();
  for (const t of tabs) {
    const inSnap = snapshot.includes(`data-tab="${t}"`);
    add({
      id: `ui.nav.${t}`,
      name: `Tinker UI tab: ${t}`,
      subsystem: "tinker-ui",
      query: "R16",
      source: "tinker-ui/src/app.ts",
      signal: inSnap ? "present in the live DOM snapshot" : "none",
      status: inSnap ? "OBSERVED" : "BLIND",
      evidence: inSnap
        ? `found in tinker-ui-snapshot.html (${iso(snapMtime)}) — a side-effect of a probe built for something else, not a designed signal`
        : "not in the snapshot, and the snapshot covers only the chat subtree; no UI feature has an instrument",
      lastSeen: inSnap ? snapMtime : 0,
    });
  }
  for (const f of uiFiles.filter((x) => x.includes(`${path.sep}panels${path.sep}`))) {
    const name = path.basename(f, ".ts");
    add({
      id: `ui.panel.${name}`,
      name: `Tinker UI panel: ${name}`,
      subsystem: "tinker-ui",
      query: "R16",
      source: path.relative(repoRoot, f),
      signal: "none",
      status: "BLIND",
      evidence:
        "no declareInstrument anywhere under tinker-ui/src — the hourly live/pending/never report is structurally incapable of seeing any UI feature",
      lastSeen: 0,
    });
  }
  const uiState = readJson(path.join(OPENCLAW, "data", "tinker-ui-state.json"));
  for (const k of Object.keys(uiState ?? {})) {
    const v = uiState[k];
    const nonEmpty = v && (Array.isArray(v) ? v.length : Object.keys(v).length) > 0;
    add({
      id: `ui.persist.${k}`,
      name: `Tinker UI persisted state: ${k}`,
      subsystem: "tinker-ui",
      query: "R17",
      source: "~/.openclaw/data/tinker-ui-state.json",
      signal: "durable state file content",
      status: nonEmpty ? "OBSERVED" : "DECLARED",
      evidence: nonEmpty
        ? `non-empty content proves the POST path fired (${iso(mtime(path.join(OPENCLAW, "data", "tinker-ui-state.json")))})`
        : "key present but empty — the writer may never have run",
      lastSeen: mtime(path.join(OPENCLAW, "data", "tinker-ui-state.json")),
    });
  }
  notes.push(
    `tinker-ui: declareInstrument( occurrences under tinker-ui/src = ${uiInstrumented ? ">0" : "0"}. ` +
      "Zero is the load-bearing UI fact: no UI capability can ever appear in the liveness census.",
  );

  // ── probes (R18) ───────────────────────────────────────────────────────────────────────────
  const probesMd = readText(path.join(repoRoot, "TINKER_UI_DESIGN_BIBLE", "probes.md"));
  for (const m of probesMd.matchAll(/^\| `([^`]+)`/gm)) {
    const probe = m[1];
    const line = probesMd.slice(m.index, probesMd.indexOf("\n", m.index));
    const pathRef = /~\/\.openclaw\/([^\s)`,]+)/.exec(line)?.[1];
    let status, evidence;
    if (/currently broken|is broken/i.test(line)) {
      status = "DECLARED";
      evidence = "the probe table itself documents this probe as broken, while listing it as live";
    } else if (pathRef) {
      const p = path.join(OPENCLAW, pathRef);
      const t = mtime(p);
      status = t === 0 ? "DECLARED" : t >= sinceMs ? "OBSERVED" : "DECLARED";
      evidence =
        t === 0
          ? `documented target ~/.openclaw/${pathRef} DOES NOT EXIST on this host, and nothing says so`
          : `target last written ${iso(t)}`;
    } else {
      status = "OBSERVED";
      evidence = "log/RPC probe — substrate exists; correctness of the probe itself not asserted";
    }
    add({
      id: `obs.probe.${probe
        .replace(/^Read\(~?\/?\.?openclaw\//, "")
        .replace(/^Read\(/, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48)}`,
      name: `probe ${probe}`,
      subsystem: "OBS",
      query: "R18",
      source: "TINKER_UI_DESIGN_BIBLE/probes.md",
      signal: "documented inspection primitive",
      status,
      evidence,
      lastSeen: null,
    });
  }

  // Dedup on the stable id. The canonical rule: THE CAPABILITY IS THE THING THAT CAN BE DEAD, and
  // a seam is not a separate capability — a tool registered twice (once by name, once inside a
  // names:[] batch) is one thing that can die, so it is one row.
  const uniq = new Map();
  for (const c of caps) if (!uniq.has(c.id)) uniq.set(c.id, c);
  const deduped = [...uniq.values()];
  if (deduped.length !== caps.length)
    notes.push(
      `${caps.length - deduped.length} duplicate seam(s) folded into their capability row (same stable id derived from two registration sites).`,
    );
  deduped.sort((a, b) => a.subsystem.localeCompare(b.subsystem) || a.id.localeCompare(b.id));
  return { caps: deduped, notes, census, log: Boolean(log) };
}

// ── report ────────────────────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => (argv.find((a) => a.startsWith(`${k}=`)) ?? `${k}=${d}`).split("=")[1];
  const since = arg("--since", "-24h");
  const hours = Number(/(\d+)h/.exec(since)?.[1] ?? 24) || 24;
  const opts = { since, windowMs: hours * 3600_000, journal: !argv.includes("--no-journal") };

  if (argv.includes("--queries")) {
    console.log("Derivation legend — every row of this report is regenerable from one of these:\n");
    for (const [k, v] of Object.entries(QUERIES)) console.log(`  ${k.padEnd(4)} ${v}`);
    console.log("\nJudgement calls (the ONLY hand-written content; each carries its reason):\n");
    for (const j of JUDGEMENTS)
      console.log(`  ${j.id}\n    rule:   ${j.rule}\n    reason: ${j.reason}\n`);
    return;
  }

  const t0 = Date.now();
  const { caps, notes, census, log } = build(opts);
  const ms = Date.now() - t0;
  const by = (s) => caps.filter((c) => c.status === s);
  const [observed, declared, blind] = ["OBSERVED", "DECLARED", "BLIND"].map(by);

  // The GATE is always measured on the structural pass — tree + filesystem, no journal — so the
  // same commit yields the same verdict on this host, on CI and on a fresh clone. When the journal
  // is unavailable the run above already IS the structural pass; do not pay for it twice.
  const structural = log
    ? build({ ...opts, journal: false }).caps.filter((c) => c.status === "BLIND").length
    : blind.length;

  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          window: since,
          journalAvailable: log,
          elapsedMs: ms,
          total: caps.length,
          observed: observed.length,
          declared: declared.length,
          blind: blind.length,
          blindStructural: structural,
          blindCap: BLIND_CAP,
          census,
          notes,
          judgements: JUDGEMENTS,
          queries: QUERIES,
          capabilities: caps,
        },
        (k, v) => (v instanceof Map ? Object.fromEntries(v) : v),
        2,
      )}\n`,
    );
    process.exit(structural > BLIND_CAP ? 1 : 0);
  }

  // Machine-mergeable one-line-per-capability form, for merging this surface with the other
  // inventories by hand or by script. Pipe-separated because a capability's evidence contains
  // commas, colons and quotes and CSV quoting would make it unreadable in a terminal.
  if (argv.includes("--pipe")) {
    console.log("# stable-id | name | source-of-truth | observable | evidence");
    for (const c of caps) {
      const observable =
        c.status === "OBSERVED" ? "yes" : c.status === "DECLARED" ? "partial" : "no";
      console.log(
        `${c.id} | ${c.name} | ${c.query} @ ${c.source} | ${observable} | ${c.status}: ${c.evidence.replace(/\s+/g, " ")}`,
      );
    }
    console.log(
      `# ${caps.length} capabilities | yes ${observed.length} | partial ${declared.length} | no ${blind.length} | structural-blind ${structural} / cap ${BLIND_CAP}`,
    );
    process.exit(structural > BLIND_CAP ? 1 : 0);
  }

  const rows = argv.includes("--blind") ? blind : argv.includes("--declared") ? declared : caps;
  const title = argv.includes("--blind")
    ? "BLIND — nothing would tell you if these stopped working"
    : argv.includes("--declared")
      ? "DECLARED — a signal exists and has NEVER produced a positive. These are LIVE BUGS."
      : "capability coverage";
  console.log(`\n${title}\n`);
  let sub = "";
  for (const c of rows) {
    if (c.subsystem !== sub) {
      sub = c.subsystem;
      const of = caps.filter((x) => x.subsystem === sub);
      const o = of.filter((x) => x.status === "OBSERVED").length;
      const d = of.filter((x) => x.status === "DECLARED").length;
      console.log(
        `\n── ${sub}  (${of.length} capabilities · ${o} observed · ${d} declared · ${of.length - o - d} blind)`,
      );
    }
    console.log(
      `  ${c.status.padEnd(8)} ${c.id.padEnd(46)} ${iso(c.lastSeen).padEnd(17)} ${c.query.padEnd(9)} ${c.evidence}`,
    );
  }

  console.log("");
  console.log(
    `HEADLINE  ${caps.length} capabilities derived in ${ms}ms — ` +
      `OBSERVED ${observed.length} (${Math.round((observed.length / caps.length) * 100)}%) · ` +
      `DECLARED ${declared.length} (${Math.round((declared.length / caps.length) * 100)}%) · ` +
      `BLIND ${blind.length} (${Math.round((blind.length / caps.length) * 100)}%)`,
  );
  console.log(
    `RATCHET   structural BLIND ${structural} / cap ${BLIND_CAP}` +
      (log
        ? `  (measured with the journal IGNORED, so the gate is identical on CI and on a fresh clone; the ${blind.length} above is the sharper, journal-informed number)`
        : "  (this run had no journal, so the report and the gate are the same pass)"),
  );
  console.log(
    `          DECLARED is the actionable bucket: a signal that has never fired is a bug, not a doc gap.`,
  );
  for (const s of [...new Set(caps.map((c) => c.subsystem))]) {
    const of = caps.filter((c) => c.subsystem === s);
    const o = of.filter((c) => c.status === "OBSERVED").length;
    const d = of.filter((c) => c.status === "DECLARED").length;
    console.log(
      `  ${s.padEnd(15)} ${String(of.length).padStart(4)} · observed ${String(o).padStart(4)} · declared ${String(d).padStart(3)} · blind ${String(of.length - o - d).padStart(4)}`,
    );
  }
  if (census)
    console.log(
      `\n  live census: declared=${census.declared} live=${census.live} pending=${census.pending} never=${census.never} stale=${census.stale} byConfig=${census.byConfig} — ` +
        `only ${census.nameable} of ${census.declared} rows are NAMEABLE from the log (live/pending/idle are structurally unnameable).`,
    );
  for (const n of notes) console.log(`  note: ${n}`);
  console.log(
    `  caveat: '⇄ res' is ws-transport-only — in-process gateway dispatch emits nothing, so BLIND on the RPC surface is an UPPER BOUND on death, not a proof of it.`,
  );
  console.log(`  derivations: node ${path.relative(process.cwd(), process.argv[1])} --queries\n`);

  if (structural > BLIND_CAP) {
    console.error(
      `FAIL: structural BLIND rose to ${structural}, above the ratchet of ${BLIND_CAP}.\n` +
        `A capability arrived with nothing watching it. Instrument it — declareInstrument plus\n` +
        `noteInstrumentFired where the WORK happens, not where it registers and not behind the same\n` +
        `condition that decides whether it registers — then lower BLIND_CAP in the same commit.\n` +
        `Raising the cap is not a fix. See what changed:\n` +
        `  node scripts/bible/capability-coverage.mjs --blind\n`,
    );
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
