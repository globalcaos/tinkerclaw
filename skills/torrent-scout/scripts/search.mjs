#!/usr/bin/env node
// search.mjs — fan out across configured sources, rank, persist, present.
//
// Usage:
//   node scripts/search.mjs "dune part two" [options]
//     --kind movie|tv|models|docs|any   what we are looking for (default auto)
//     --profile best|balanced|compact   ranking profile (default from config)
//     --runtime <min>                   runtime for size-plausibility (default 105)
//     --limit <n>                       per-source result cap (default 50)
//     --deeper                          widen: raise limits, drop the cat filter
//     --only <source>                   restrict to one source name
//     --allow-cam                       DISABLE the camcorder gate (off by default)
//     --json                            machine-readable output

import { searchArchiveOrg, searchTorznab } from "../lib/adapters.mjs";
import { loadConfig, saveSearch, LAST_SEARCH } from "../lib/config.mjs";
import { parseRelease } from "../lib/parse.mjs";
import { rank } from "../lib/score.mjs";

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.flags[k] = next;
        i += 1;
      } else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const fmtSize = (b) => {
  if (!b) return "?";
  const g = b / 1024 ** 3;
  return g >= 1 ? `${g.toFixed(1)}G` : `${(b / 1024 ** 2).toFixed(0)}M`;
};

function describe(c) {
  const p = c.parsed;
  const bits = [
    p.resolution ? `${p.resolution}p` : null,
    p.source,
    p.videoCodec,
    [p.audioCodec, p.audioChannels].filter(Boolean).join(" "),
    p.hdr.join("/") || null,
    p.edition,
    p.group ? `-${p.group}` : null,
  ].filter(Boolean);
  return bits.join(" · ") || "(no quality tags in name)";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args._.join(" ").trim();
  if (!query) {
    console.error('usage: search.mjs "<title>" [--kind movie] [--profile best] [--deeper]');
    process.exit(2);
  }
  const cfg = loadConfig();
  const deeper = Boolean(args.flags.deeper);
  const limit = Number(args.flags.limit) || (deeper ? 100 : 50);
  const kind = args.flags.kind || "auto";
  const profile = args.flags.profile || cfg.profile || "best";
  const runtimeMin = Number(args.flags.runtime) || 105;
  const only = args.flags.only || null;

  const jobs = [];
  const sourcesTried = [];
  if (cfg.useArchiveOrg && (!only || only === "archive.org")) {
    sourcesTried.push("archive.org");
    const mediatype =
      kind === "movie" || kind === "tv" ? "movies" : kind === "docs" ? "texts" : null;
    jobs.push(
      searchArchiveOrg(`title:(${query})`, {
        limit: Math.min(limit, 50),
        timeoutMs: cfg.timeoutMs,
        mediatype: deeper ? null : mediatype,
      })
        .then((r) => ({ ok: true, source: "archive.org", results: r }))
        .catch((e) => ({ ok: false, source: "archive.org", error: e.message, results: [] })),
    );
  }
  for (const ix of cfg.indexers || []) {
    if (only && ix.name !== only) continue;
    sourcesTried.push(ix.name);
    jobs.push(
      searchTorznab(ix, query, { limit, timeoutMs: cfg.timeoutMs, cat: deeper ? null : undefined })
        .then((r) => ({ ok: true, source: ix.name, results: r }))
        .catch((e) => ({ ok: false, source: ix.name, error: e.message, results: [] })),
    );
  }

  if (!jobs.length) {
    console.error(
      "No sources configured. archive.org is disabled and no Torznab indexers are set.",
    );
    console.error("See references/indexers.md, then edit ~/.torrent-scout/config.json");
    process.exit(3);
  }

  const settled = await Promise.all(jobs);
  const errors = settled.filter((s) => !s.ok).map((s) => `${s.source}: ${s.error}`);
  const raw = settled.flatMap((s) => s.results);

  // De-duplicate across sources by infohash, else by normalized title+size.
  const seen = new Map();
  for (const r of raw) {
    const key =
      r.infoHash?.toLowerCase() ||
      `${(r.title || "").toLowerCase().replace(/[^a-z0-9]/g, "")}|${r.sizeBytes}`;
    const prev = seen.get(key);
    if (!prev || (r.seeders || 0) > (prev.seeders || 0)) seen.set(key, r);
  }
  const deduped = [...seen.values()].map((r) => ({ ...r, parsed: parseRelease(r.title) }));

  const { kept, rejected } = rank(deduped, {
    wantedTitle: query,
    kind,
    runtimeMin,
    profile,
    allowCamcorder: Boolean(args.flags["allow-cam"]),
  });

  const state = {
    query,
    kind,
    profile,
    runtimeMin,
    deeper,
    at: new Date().toISOString(),
    sourcesTried,
    errors,
    totalFound: raw.length,
    kept,
    rejected,
  };
  saveSearch(state);

  if (args.flags.json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  console.log(
    `\n"${query}" — ${raw.length} raw / ${deduped.length} unique across [${sourcesTried.join(", ")}]`,
  );
  if (errors.length) console.log(`  ! source errors: ${errors.join(" ; ")}`);
  console.log(`  profile=${profile} kind=${kind} assumed-runtime=${runtimeMin}min\n`);

  if (!kept.length) {
    console.log("NOTHING ACCEPTABLE.");
    if (rejected.length) {
      console.log(`${rejected.length} result(s) were rejected outright:\n`);
      for (const r of rejected.slice(0, 8)) {
        console.log(`  x ${r.title.slice(0, 72)}`);
        console.log(`      ${r.rejectReasons.join(" | ")}`);
      }
      const onlyCam = rejected.every((r) => r.parsed.isCamcorder);
      if (onlyCam)
        console.log("\n=> Only cinema-recorded copies exist. Treat this as NOT AVAILABLE YET.");
    }
  } else {
    kept.slice(0, 12).forEach((c, i) => {
      const mark = c.verdict === "suspect" ? "!!" : c.verdict === "ok" ? " ~" : " +";
      console.log(
        `${mark} ${String(i + 1).padStart(2)}. [${String(c.score).padStart(3)}] ${c.title.slice(0, 78)}`,
      );
      console.log(`         ${describe(c)}`);
      console.log(
        `         ${fmtSize(c.sizeBytes)} · ${c.webseed ? "http webseed" : `${c.seeders ?? "?"} seed / ${c.leechers ?? "?"} leech`} · ${c.source}`,
      );
      if (c.flags.length) console.log(`         flags: ${c.flags.join(", ")}`);
    });
    if (rejected.length) {
      const cams = rejected.filter((r) => r.parsed.isCamcorder).length;
      console.log(
        `\n  (${rejected.length} rejected — ${cams} camcorder, ${rejected.length - cams} other)`,
      );
    }
  }
  console.log(`\nstate: ${LAST_SEARCH}`);
  console.log(
    'next: inspect.mjs <n>  (verify file list before downloading) | search.mjs "<q>" --deeper',
  );
}

main().catch((e) => {
  console.error("search failed:", e.message);
  process.exit(1);
});
