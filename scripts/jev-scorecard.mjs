#!/usr/bin/env node
/**
 * Jev scorecard (2026-10-25): how every consumer of Jev and its tutors is doing, per check, from the stores on disk.
 *
 * FOR: answering "is Jev dumb, or under-fed?" with counts instead of impressions, and seeing which check earns its
 * place. FROM: the amygdala's reviews, the Fractal ledger, outcomes, gate log and gate reviews, Thalamus's enhancement
 * uses and its two tutor tables, and the humor plugin's spoken lines. Read only; a store that is missing or unreadable is
 * reported as such and the rest still prints. CHANGES: when a consumer or a store is added, add a section here.
 *
 * Columns, the same for every row:
 *   flags      what the check raised (a flag, a fired reflection, a shown card, a reviewed run)
 *   useful     raised and right (reviewer: useful; Fractal: acted; list: used; routing: right)
 *   harmless   raised, accurate, changed nothing (amygdala only)
 *   noise      raised and beside the point (reviewer: noise; Fractal: clean; list: shown, not used; routing: too strong)
 *   harmful    raised and wrong in a way that would have hurt (amygdala only)
 *   misses     what it should have raised and did not (reviewer: missed pass; gate tutor: should-fire; list: used off it;
 *              routing: too weak)
 *   precision  useful / (useful + harmless + noise + harmful), over the rows that have a verdict
 *
 * Usage: node scripts/jev-scorecard.mjs [--days N] [--state-dir DIR] [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const days = Number(opt("--days") ?? 0);
const since = days > 0 ? Date.now() - days * 86_400_000 : 0;
const stateDir =
  opt("--state-dir") ?? process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
const asJson = args.includes("--json");

/** @type {{consumer: string, check: string, flags: number, useful: number|null, harmless: number|null, noise: number|null, harmful: number|null, misses: number|null, note?: string}[]} */
const rows = [];
/** @type {{consumer: string, store: string, status: string}[]} */
const stores = [];

const row = (consumer, check, c) =>
  rows.push({
    consumer,
    check,
    flags: c.flags ?? 0,
    useful: c.useful ?? null,
    harmless: c.harmless ?? null,
    noise: c.noise ?? null,
    harmful: c.harmful ?? null,
    misses: c.misses ?? null,
    ...(c.note ? { note: c.note } : {}),
  });

let Database;
async function sqlite(path) {
  if (!existsSync(path)) {
    return { error: "missing" };
  }
  try {
    Database ??= (await import("better-sqlite3")).default;
    return { db: new Database(path, { readonly: true, fileMustExist: true }) };
  } catch (err) {
    return { error: `unreadable: ${String(err).slice(0, 120)}` };
  }
}

function jsonl(path) {
  if (!existsSync(path)) {
    return { error: "missing" };
  }
  try {
    const out = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const s = line.trim();
      if (!s.startsWith("{")) {
        continue;
      }
      try {
        out.push(JSON.parse(s));
      } catch {
        /* a torn line is skipped */
      }
    }
    return { rows: out };
  } catch (err) {
    return { error: `unreadable: ${String(err).slice(0, 120)}` };
  }
}

const tsOk = (ts) => typeof ts === "number" && ts >= since;
const rule = (rc) => String(rc ?? "").split("[")[0];

// ── Amygdala: the reviewer's verdicts per rule, and the passes it judged missed ───────────────────
{
  const path = join(stateDir, "data", "amygdala-jev", "amygdala.sqlite");
  const s = await sqlite(path);
  stores.push({ consumer: "amygdala", store: path, status: s.error ?? "ok" });
  if (s.db) {
    try {
      const flags = s.db
        .prepare(
          `SELECT d.family AS family, d.reason_code AS rc, r.verdict AS v, COUNT(*) AS n
           FROM reviews r JOIN decisions d ON d.id = r.decision_id
           WHERE r.status = 'done' AND r.kind = 'flag' AND r.ts >= ? GROUP BY 1, 2, 3`,
        )
        .all(since);
      const per = new Map();
      for (const f of flags) {
        const key = `${f.family} · ${rule(f.rc)}`;
        const e = per.get(key) ?? { flags: 0, useful: 0, harmless: 0, noise: 0, harmful: 0 };
        e.flags += f.n;
        if (f.v in e) {
          e[f.v] += f.n;
        }
        per.set(key, e);
      }
      const passes = s.db
        .prepare(
          `SELECT d.family AS family, r.verdict AS v, COUNT(*) AS n
           FROM reviews r JOIN decisions d ON d.id = r.decision_id
           WHERE r.status = 'done' AND r.kind = 'pass' AND r.ts >= ? GROUP BY 1, 2`,
        )
        .all(since);
      for (const [check, e] of [...per].toSorted((a, b) => b[1].flags - a[1].flags)) {
        row("amygdala", check, e);
      }
      const byFam = new Map();
      for (const p of passes) {
        const e = byFam.get(p.family) ?? { fine: 0, missed: 0 };
        if (p.v === "fine" || p.v === "missed") {
          e[p.v] += p.n;
        }
        byFam.set(p.family, e);
      }
      for (const [family, e] of byFam) {
        row("amygdala", `${family} · passes`, {
          flags: 0,
          misses: e.missed,
          note: `${e.fine + e.missed} passes judged, ${e.fine} fine`,
        });
      }
    } catch (err) {
      stores.at(-1).status = `query failed: ${String(err).slice(0, 120)}`;
    } finally {
      s.db.close();
    }
  }
}

// ── Fractal: what fired and what it did, what the gate skipped and its tutor's verdicts ─────────────
{
  const dir = join(stateDir, "data", "fractal");
  const ledger = jsonl(join(dir, "ledger.jsonl"));
  const outcomes = jsonl(join(dir, "outcomes.jsonl"));
  const gate = jsonl(join(dir, "gate.jsonl"));
  const reviews = jsonl(join(dir, "gate-reviews.jsonl"));
  for (const [name, r] of [
    ["ledger.jsonl", ledger],
    ["outcomes.jsonl", outcomes],
    ["gate.jsonl", gate],
    ["gate-reviews.jsonl", reviews],
  ]) {
    stores.push({ consumer: "fractal", store: join(dir, name), status: r.error ?? "ok" });
  }
  if (ledger.rows) {
    const fired = ledger.rows.filter((x) => tsOk(x.ts));
    const count = (v) => fired.filter((x) => x.verdict === v).length;
    const kept = (outcomes.rows ?? []).filter((x) => tsOk(x.ts) && x.outcome === "kept").length;
    row("fractal", "reflection (ledger)", {
      flags: fired.length,
      useful: count("acted"),
      noise: count("clean"),
      note: `${count("unverified")} unverified; weekly check: ${kept} kept of ${(outcomes.rows ?? []).filter((x) => tsOk(x.ts)).length} checked`,
    });
  }
  if (gate.rows) {
    const g = gate.rows.filter((x) => tsOk(x.ts));
    const skipped = g.filter((x) => x.fire === false).length;
    const judged = (reviews.rows ?? []).filter((x) => tsOk(x.ts) && x.status === "done");
    const should = judged.filter((x) => x.review?.verdict === "should-fire").length;
    row("fractal", "gate", {
      flags: g.length - skipped,
      misses: reviews.rows ? should : null,
      note: `${g.length} decisions, ${skipped} skipped, Jev answered ${g.filter((x) => x.jev === "answered").length}; tutor judged ${judged.length} skips`,
    });
  }
}

// ── Thalamus: the enhancement list (shown vs used), and the two tutors ─────────────────────────────
{
  const path = join(stateDir, "data", "thalamus-v4", "thalamus.sqlite");
  const s = await sqlite(path);
  stores.push({ consumer: "thalamus", store: path, status: s.error ?? "ok" });
  if (s.db) {
    try {
      const uses = s.db
        .prepare("SELECT shown_json, used_json, list_source FROM enh_uses WHERE ts >= ?")
        .all(since);
      const bySource = new Map();
      for (const u of uses) {
        let shown = [];
        let used = [];
        try {
          shown = JSON.parse(u.shown_json ?? "[]");
          used = JSON.parse(u.used_json ?? "[]");
        } catch {
          continue;
        }
        const e = bySource.get(u.list_source) ?? { flags: 0, useful: 0, noise: 0, misses: 0 };
        const usedIds = new Set(used.map((x) => x.cardId));
        e.flags += shown.length;
        e.useful += shown.filter((x) => usedIds.has(x.cardId)).length;
        e.noise += shown.filter((x) => !usedIds.has(x.cardId)).length;
        e.misses += used.filter((x) => !x.onList).length;
        bySource.set(u.list_source, e);
      }
      for (const [source, e] of bySource) {
        row("thalamus", `enhancement list (${source})`, e);
      }
      const have = (t) =>
        s.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) !==
        undefined;
      if (have("enh_reviews")) {
        const r = s.db
          .prepare(
            "SELECT not_fit_json, should_suggest_json, shown_json FROM enh_reviews WHERE status='done' AND ts >= ?",
          )
          .all(since);
        let shown = 0;
        let notFit = 0;
        let should = 0;
        for (const x of r) {
          shown += JSON.parse(x.shown_json ?? "[]").length;
          notFit += JSON.parse(x.not_fit_json ?? "[]").length;
          should += JSON.parse(x.should_suggest_json ?? "[]").length;
        }
        row("thalamus", "enhancement tutor", {
          flags: shown,
          useful: shown - notFit,
          noise: notFit,
          misses: should,
          note: `${r.length} tasks judged`,
        });
      } else {
        row("thalamus", "enhancement tutor", { flags: 0, note: "no enh_reviews table yet" });
      }
      if (have("routing_reviews")) {
        const r = s.db
          .prepare(
            "SELECT verdict, COUNT(*) AS n FROM routing_reviews WHERE status='done' AND ts >= ? GROUP BY verdict",
          )
          .all(since);
        const n = (v) => r.find((x) => x.verdict === v)?.n ?? 0;
        row("thalamus", "routing tutor", {
          flags: n("right") + n("too-strong") + n("too-weak"),
          useful: n("right"),
          noise: n("too-strong"),
          misses: n("too-weak"),
          note: "useful = right, noise = too strong, misses = too weak",
        });
      } else {
        row("thalamus", "routing tutor", { flags: 0, note: "no routing_reviews table yet" });
      }
      const outcomes = s.db
        .prepare("SELECT outcome, COUNT(*) AS n FROM outcomes WHERE ts >= ? GROUP BY outcome")
        .all(since);
      row("thalamus", "routing outcomes (raw)", {
        flags: outcomes.reduce((a, x) => a + x.n, 0),
        note: outcomes.map((x) => `${x.outcome} ${x.n}`).join(", ") || "none",
      });
    } catch (err) {
      stores.at(-1).status = `query failed: ${String(err).slice(0, 120)}`;
    } finally {
      s.db.close();
    }
  }
}

// ── Humor: which spoken lines the joke judge marked ─────────────────────────────────────────────────
{
  const path = join(stateDir, "cognitive", "computational-humor.json");
  if (!existsSync(path)) {
    stores.push({ consumer: "humor", store: path, status: "missing" });
  } else {
    try {
      const lines = (JSON.parse(readFileSync(path, "utf8")).recentSpokenLines ?? []).filter((x) =>
        tsOk(x.ts),
      );
      const jokes = lines.filter((x) => x.isJoke === true).length;
      const plain = lines.filter((x) => x.isJoke === false).length;
      row("humor", "joke judge", {
        flags: jokes,
        note: `${lines.length} lines: ${jokes} joke, ${plain} plain, ${lines.length - jokes - plain} unjudged (no tutor by design)`,
      });
      stores.push({ consumer: "humor", store: path, status: "ok" });
    } catch (err) {
      stores.push({
        consumer: "humor",
        store: path,
        status: `unreadable: ${String(err).slice(0, 120)}`,
      });
    }
  }
}

const precision = (r) => {
  const judged = (r.useful ?? 0) + (r.harmless ?? 0) + (r.noise ?? 0) + (r.harmful ?? 0);
  return r.useful === null || judged === 0 ? null : r.useful / judged;
};

if (asJson) {
  console.log(
    JSON.stringify(
      { since: since || null, stores, rows: rows.map((r) => ({ ...r, precision: precision(r) })) },
      null,
      2,
    ),
  );
} else {
  const cell = (v) => (v === null || v === undefined ? "–" : String(v));
  const head = [
    "consumer",
    "check",
    "flags",
    "useful",
    "harmless",
    "noise",
    "harmful",
    "misses",
    "precision",
    "note",
  ];
  const body = rows.map((r) => {
    const p = precision(r);
    return [
      r.consumer,
      r.check,
      cell(r.flags),
      cell(r.useful),
      cell(r.harmless),
      cell(r.noise),
      cell(r.harmful),
      cell(r.misses),
      p === null ? "–" : `${(p * 100).toFixed(1)}%`,
      r.note ?? "",
    ];
  });
  const width = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(width[i]))).join("  ");
  console.log(`Jev scorecard${since ? `, last ${days} days` : ", all history"} (${stateDir})\n`);
  console.log(line(head));
  for (const b of body) {
    console.log(line(b));
  }
  console.log("\nStores:");
  for (const s of stores) {
    console.log(
      `  ${s.status === "ok" ? "ok  " : "--  "}${s.consumer}: ${s.store}${s.status === "ok" ? "" : ` (${s.status})`}`,
    );
  }
}
