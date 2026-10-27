#!/usr/bin/env node
/**
 * Memory breakeven: how much memory should be always loaded, and how much fetched when needed.
 *
 * FOR    The nightly memory routine sizes the files the agent loads every session (the memory index,
 *        the notes read at startup) and decides what deserves an index line. A fixed limit ("under 200
 *        lines", "trim logs over 5 KB") has no reason behind it and goes stale when prices or habits
 *        change. This derives the limits from what the chats cost now.
 * FROM   A token kept in the context is re-read from the prompt cache on every later call (price r). A
 *        token fetched with a tool costs one extra call, which re-sends the whole context (the hop), plus
 *        a cache write (w) of what was fetched. Inputs are measured from the chat transcripts of the last
 *        --days; price ratios come from price-ratios.json.
 * CHANGE Re-run nightly. Prices change: edit the owner copy of the price ratios. Sessions get longer or
 *        shorter, the cache lifetime changes, or the context per call grows: the measured inputs move
 *        the answer.
 * NOT    Price is one cost. Attention is the other: a long always-loaded file is followed less well line
 *        by line. And a harness may cut what it loads (Claude Code reads only the start of MEMORY.md).
 *        The result is an economic optimum, to read against those two ceilings.
 *
 * Per session, carrying s tokens costs  s * r * R               (R = calls in the session)
 * Fetching them when needed costs       P * (H + s * (w + r * R / 2))
 * where H = cost of one extra call = C * r_mix + o * g, and P = share of sessions that need it.
 * Carrying wins while s < s*(P) = P * H / (r * R - P * (w + r * R / 2)); a non-positive denominator
 * means carrying wins at any size.
 *
 * Sources: the Claude Code transcripts of sessions whose working folder is inside the state dir (the
 * chat workers run in the agent workspace), one usage record per API call; and the gateway's session
 * files for chats on other providers, one usage record per assistant message. The gateway's copy of a
 * claude-code turn sums many calls, so it is skipped: those calls are already in the transcripts.
 *
 * Usage: node memory-breakeven.mjs [--days 7] [--max-files 1500] [--dir <folder>]... [--prices <file>]
 *                                  [--out <file>] [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function resolvePaths(env = process.env, home = os.homedir()) {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(home, ".openclaw");
  const workspace = env.OPENCLAW_WORKSPACE?.trim() || path.join(stateDir, "workspace");
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const ownerPrices = path.join(workspace, "memory", "co-access", "price-ratios.json");
  return {
    stateDir,
    workspace,
    claudeHome,
    prices: fs.existsSync(ownerPrices) ? ownerPrices : path.join(HERE, "price-ratios.json"),
    out: path.join(workspace, "memory", "co-access", "breakeven.json"),
  };
}

/** Claude Code names a project folder after its working folder, every non-alphanumeric char a dash. */
export function claudeProjectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
}

/** Claude Code transcript folders for sessions that ran inside the state dir, plus gateway session folders. */
export function defaultSourceDirs({ stateDir, claudeHome }) {
  const prefix = `${claudeProjectSlug(stateDir)}-`;
  const list = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return [];
    }
  };
  const projects = path.join(claudeHome, "projects");
  return [
    ...list(projects)
      .filter((e) => e.name.startsWith(prefix))
      .map((e) => ({ dir: path.join(projects, e.name), kind: "claude-code" })),
    ...list(path.join(stateDir, "agents")).map((e) => ({
      dir: path.join(stateDir, "agents", e.name, "sessions"),
      kind: "gateway",
    })),
  ];
}

/**
 * One call's usage as [uncached input, cache written, cache read, output, written 1h, written 5m, model],
 * or null when the record is not an assistant call with usage.
 */
export function callUsage(record, kind) {
  const m = record?.message;
  if (!m || m.role !== "assistant" || !m.usage || typeof m.usage !== "object") {
    return null;
  }
  if (m.model === "<synthetic>") {
    return null; // a placeholder Claude Code writes for an error or an interrupt; no call was made
  }
  const u = m.usage;
  if (kind === "claude-code") {
    const cc = u.cache_creation ?? {};
    const written = u.cache_creation_input_tokens ?? 0;
    const w1h = cc.ephemeral_1h_input_tokens ?? 0;
    return [
      u.input_tokens ?? 0,
      written,
      u.cache_read_input_tokens ?? 0,
      u.output_tokens ?? 0,
      w1h,
      cc.ephemeral_5m_input_tokens ?? written - w1h,
      m.model ?? "unknown",
    ];
  }
  if (m.provider === "claude-code") {
    return null; // a whole turn of a claude-code worker, already counted per call in its transcript
  }
  const written = u.cacheWrite ?? 0;
  return [
    u.input ?? 0,
    written,
    u.cacheRead ?? 0,
    u.output ?? 0,
    0,
    written, // the lifetime is not recorded; price it as the default 5-minute write
    m.model ? `${m.provider ?? "?"}/${m.model}` : (m.provider ?? "unknown"),
  ];
}

export async function scan(sources, days, maxFiles, nowMs = Date.now()) {
  const cutoff = nowMs - days * 86_400_000;
  const files = [];
  for (const { dir, kind } of sources) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime >= cutoff) {
          files.push({ file, kind, mtime });
        }
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const picked = files.slice(0, maxFiles);
  const seen = new Set();
  const calls = [];
  const perSession = [];
  const models = new Map();
  for (const { file, kind } of picked) {
    let n = 0;
    const lines = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.includes('"usage"')) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = callUsage(record, kind);
      if (!usage) {
        continue;
      }
      // Claude Code writes one line per content block of a call, all with the same message id.
      const id = record.message.id ?? record.id;
      if (id) {
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
      }
      calls.push(usage.slice(0, 6));
      models.set(usage[6], (models.get(usage[6]) ?? 0) + 1);
      n++;
    }
    if (n > 0) {
      perSession.push(n);
    }
  }
  return { files: picked.length, calls, perSession, models };
}

const median = (xs) => {
  const s = [...xs].toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The derivation itself, from measured calls and price ratios. Pure, so it can be tested. */
export function derive({ calls, perSession, prices }) {
  const tot = [0, 1, 2, 3, 4, 5].map((i) => calls.reduce((sum, c) => sum + c[i], 0));
  const ctx = calls.map((c) => c[0] + c[1] + c[2]);
  const cAll = ctx.reduce((a, b) => a + b, 0);
  const ttl = tot[4] >= tot[5] ? "1h" : "5m";
  const r = prices.r_cache_read;
  const w = ttl === "1h" ? prices.w_cache_write_1h : prices.w_cache_write_5m;
  const g = prices.g_output;
  const shareUnc = tot[0] / cAll;
  const shareW = tot[1] / cAll;
  const shareR = tot[2] / cAll;
  const rMix = shareUnc + shareW * w + shareR * r;
  const C = median(ctx);
  const o = median(calls.map((c) => c[3]));
  const H = C * rMix + o * g;
  const R = perSession.reduce((a, b) => a + b, 0) / perSession.length;
  const sStar = (P) => {
    const den = r * R - P * (w + (r * R) / 2);
    return den <= 0 ? null : Math.round((P * H) / den);
  };
  const table = Object.fromEntries(
    [1, 0.5, 0.25, 0.1, 0.05, 0.02].map((P) => [String(P), sStar(P)]),
  );
  const pAny = (r * R) / (w + (r * R) / 2);
  const lineTokens = 30;
  const pLine = (lineTokens * r * R) / H;
  return {
    measured: {
      context_per_call_median: Math.round(C),
      context_per_call_mean: Math.round(cAll / calls.length),
      cache_mix: {
        uncached: Number(shareUnc.toFixed(4)),
        written: Number(shareW.toFixed(4)),
        read: Number(shareR.toFixed(4)),
      },
      cache_ttl: ttl,
      output_per_call_median: Math.round(o),
      calls_per_session_mean: Number(R.toFixed(2)),
      calls_per_session_median: median(perSession),
    },
    prices: { r, w, g },
    derived: {
      price_per_context_token_r_mix: Number(rMix.toFixed(4)),
      hop_cost_H_in_input_tokens: Math.round(H),
      need_share_above_which_carry_wins_at_any_size: Number(pAny.toFixed(3)),
      max_always_loaded_tokens_by_need_share: table,
      index_line_pays_if_target_needed_in_one_of_N_sessions: pLine ? Math.round(1 / pLine) : null,
    },
  };
}

function parseArgs(argv) {
  const args = { days: 7, maxFiles: 1500, dirs: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`${a} needs a value`);
      }
      return v;
    };
    if (a === "--json") {
      args.json = true;
    } else if (a === "--days") {
      args.days = Number(next());
    } else if (a === "--max-files") {
      args.maxFiles = Number(next());
    } else if (a === "--dir") {
      args.dirs.push(next());
    } else if (a === "--prices") {
      args.prices = next();
    } else if (a === "--out") {
      args.out = next();
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!(args.days > 0) || !(args.maxFiles > 0)) {
    throw new Error("--days and --max-files must be positive numbers");
  }
  return args;
}

// Under this many calls the medians are noise; nothing is written and the routine keeps its sizes.
const MIN_CALLS = 50;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolvePaths();
  const pricesFile = args.prices ?? paths.prices;
  const outFile = args.out ?? paths.out;
  const prices = JSON.parse(fs.readFileSync(pricesFile, "utf8"));
  // A --dir is read as Claude Code transcripts unless it is a gateway sessions folder.
  const sources =
    args.dirs.length > 0
      ? args.dirs.map((dir) => ({
          dir,
          kind: path.basename(dir) === "sessions" ? "gateway" : "claude-code",
        }))
      : defaultSourceDirs(paths);
  const { files, calls, perSession, models } = await scan(sources, args.days, args.maxFiles);
  if (calls.length < MIN_CALLS) {
    process.stderr.write(
      `too little data: ${calls.length} calls in ${files} files; nothing written\n`,
    );
    process.exit(1);
  }
  const res = derive({ calls, perSession, prices });
  const topModels = [...models.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 3);
  const result = {
    generated: new Date().toISOString(),
    window: { days: args.days, files, sessions: perSession.length, calls: calls.length },
    models_by_calls: Object.fromEntries(topModels),
    ...res,
    prices: { ...res.prices, file: pricesFile, updated: prices.updated ?? null },
    how_to_use: [
      "A memory needed in share P of sessions belongs in an always-loaded file while it is under max_always_loaded_tokens_by_need_share[P] tokens (null = any size). Above it, keep it in its own file behind an index line.",
      "An index line (about 30 tokens) is worth keeping whenever its target is needed in at least one of N sessions; below that, drop the line and rely on search.",
      "Merge two files when they are read together and the merged size stays under the carry limit for their joint need share; split a file only read in part when its unread part is over that limit.",
      "These are economic limits. The attention ceiling and the harness's own load limits still cap them.",
    ],
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  fs.renameSync(tmp, outFile);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const m = result.measured;
  const d = result.derived;
  const fmt = (v) => (v === null ? "any" : v.toLocaleString("en-US"));
  process.stdout.write(
    [
      `${calls.length} calls / ${perSession.length} sessions / ${args.days} d · context ${fmt(m.context_per_call_median)} tok/call · cache ${m.cache_ttl} read ${Math.round(m.cache_mix.read * 100)}% · ${m.calls_per_session_mean} calls/session`,
      `most used: ${topModels.map(([k, v]) => `${k} (${v})`).join(", ")} · prices from ${pricesFile}`,
      `hop = ${fmt(d.hop_cost_H_in_input_tokens)} input-token equivalents · carry wins at any size when needed in > ${Math.round(d.need_share_above_which_carry_wins_at_any_size * 100)}% of sessions`,
      `max always-loaded tokens by need share: ${Object.entries(
        d.max_always_loaded_tokens_by_need_share,
      )
        .map(([k, v]) => `${k}: ${fmt(v)}`)
        .join(", ")}`,
      `an index line pays if its target is needed in 1 of ${fmt(d.index_line_pays_if_target_needed_in_one_of_N_sessions)} sessions`,
      `written: ${outFile}`,
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`memory-breakeven: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
