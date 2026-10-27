/**
 * FORK 2026-10-09 — what the tinkerclaw-core hooks share. Moved here unchanged from
 * moral-code-session-start.mjs (stdin, state dir, slot, dedupe lock) and moral-code-parts.mjs (the
 * cut-and-pack) when the harness-context and recipe-hint hooks joined the moral code. The moral code
 * hook prints exactly what it printed before; delivery-parts.test.ts runs it to keep it that way.
 *
 * No dependencies, by design: every importer runs on every new session, compaction or prompt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Two firings of one slot inside this window are one delivery (the plugin loaded twice). */
export const DEDUPE_WINDOW_MS = 10_000;

/** The hook input the CLI writes on stdin; {} when there is none or it is not JSON. */
export function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

/** A leading `~` stands for the home directory. */
export function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** TinkerClaw's state dir: OPENCLAW_STATE_DIR (a leading `~` expanded), else ~/.openclaw. */
export function stateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return expandHome(override);
  }
  return path.join(os.homedir(), ".openclaw");
}

/** The slot this invocation fills: `--part <n>`, 1-based (no flag: part 1). */
export function partArg(argv = process.argv) {
  const at = argv.indexOf("--part");
  const n = at >= 0 ? Number(argv[at + 1]) : 1;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** A JSON file, parsed; undefined when it is missing or not JSON. */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Which harness runs this hook: "worker" for a TinkerClaw chat worker, "claude-code" otherwise. The
 * tinker-bridge exports TC_SESSION_KEY to every `claude` child it spawns (worker.ts); plain Claude
 * Code never sets it.
 */
export function harnessSide(env = process.env) {
  return env.TC_SESSION_KEY?.trim() ? "worker" : "claude-code";
}

/**
 * True for the first invocation per kind+session+source+part inside the window. The same plugin can
 * be loaded twice in one session (installed from the marketplace AND passed with --plugin-dir by the
 * Tinker bridge), which fires every slot twice: the first claims an exclusive lock file, the second
 * stays silent. Each kind locks in its own directory, <tmp>/tinkerclaw-<kind>, so two hooks never
 * take each other's lock. The moral code's lock keeps the path it had before kinds existed
 * (<tmp>/tinkerclaw-moral-code/<session>-<source>-p<part>-<bucket>), so a cached older copy of this
 * plugin, loaded beside the current one, still dedupes against it.
 *
 * FORK 2026-10-09: a lock from the PREVIOUS bucket also counts. Buckets are fixed 10 s slots, so two
 * copies a few seconds apart that straddle a slot boundary each found a free slot and both delivered.
 * With 22 SessionStart slots instead of 10 a run lasts long enough for that to happen often
 * (delivery-parts.test.ts "loaded twice" failed on it under load). Within one bucket the exclusive
 * create still decides the race.
 */
export function claim(kind, sessionId, source, part) {
  if (!sessionId) {
    return true;
  }
  const dir = path.join(os.tmpdir(), `tinkerclaw-${kind}`);
  const bucket = Math.floor(Date.now() / DEDUPE_WINDOW_MS);
  const lockName = (b) => `${sessionId}-${source}-p${part}-${b}`.replace(/[^A-Za-z0-9_-]/g, "_");
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(path.join(dir, lockName(bucket - 1)))) {
      return false;
    }
    fs.writeFileSync(path.join(dir, lockName(bucket)), String(process.pid), { flag: "wx" });
    if (Number(part) === 1) {
      sweepStaleLocks(dir, bucket);
    }
    return true;
  } catch (err) {
    return err?.code !== "EEXIST";
  }
}

/**
 * FORK 2026-10-23 (JarvisPi): nothing ever removed these locks. Each new session leaves one per slot, and on
 * the Pi /tmp is RAM with 16 KB pages, so after a day and a half 21,000 empty-looking files held about 330 MB.
 * A lock only counts in its own bucket and the next one (see claim), so the first slot sweeps older ones.
 */
export function sweepStaleLocks(dir, bucket) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const b = Number(name.slice(name.lastIndexOf("-") + 1));
    if (Number.isInteger(b) && b < bucket - 1) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // another session's sweep got there first
      }
    }
  }
}

/** Cut `text` just before every match of `re` (a heading line), keeping every character. */
function cutBefore(text, re) {
  const out = [];
  let from = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > from) {
      out.push(text.slice(from, m.index));
      from = m.index;
    }
  }
  out.push(text.slice(from));
  return out;
}

/** Cut `text` just after every match of `re` (a blank-line run, a newline), keeping every character. */
function cutAfter(text, re) {
  const out = [];
  let from = 0;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (end > from && end < text.length) {
      out.push(text.slice(from, end));
      from = end;
    }
  }
  out.push(text.slice(from));
  return out;
}

const CUTS = [
  (t) => cutBefore(t, /^#{1,2} /gm),
  (t) => cutAfter(t, /\n{2,}/g),
  (t) => cutAfter(t, /\n/g),
];

/** `text` as pieces of at most `budget` chars, cut at the coarsest boundary that works. */
function pieces(text, budget, level = 0) {
  if (text.length <= budget) {
    return [text];
  }
  if (level >= CUTS.length) {
    const out = [];
    for (let i = 0; i < text.length; i += budget) {
      out.push(text.slice(i, i + budget));
    }
    return out;
  }
  const segs = CUTS[level](text).filter((s) => s.length > 0);
  if (segs.length <= 1) {
    return pieces(text, budget, level + 1);
  }
  return segs.flatMap((s) => pieces(s, budget, level + 1));
}

/**
 * `text` as bodies of at most `budget` chars each, in order: bodies.join("") is `text` exactly.
 *
 * WHERE IT CUTS. Before a `#` or `##` heading, so a body opens on a section; a section bigger than a
 * body at its blank lines, then at its lines, and only a single line longer than a body mid-line. The
 * pieces are packed greedily, and a `#` heading left with nothing of its section after it moves on
 * with its section when the two fit together. (Moved unchanged from moral-code-parts.mjs on
 * 2026-10-09: the moral code's parts depend on every rule here.)
 */
export function splitIntoParts(text, budget) {
  if (!(budget >= 1)) {
    throw new RangeError(`splitIntoParts: the budget must be at least 1 char, got ${budget}`);
  }
  const atoms = pieces(text, budget);
  const bodies = [];
  let cur = [];
  let len = 0;
  for (const atom of atoms) {
    if (len + atom.length > budget && cur.length > 0) {
      // A `#` heading with nothing of its section after it moves on with its section, when it fits.
      let carry = [];
      while (cur.length > 1 && /^# [^\n]*\n+$/.test(cur[cur.length - 1])) {
        carry.unshift(cur.pop());
      }
      const carried = carry.reduce((a, s) => a + s.length, 0);
      if (carried + atom.length > budget) {
        cur.push(...carry);
        carry = [];
      }
      bodies.push(cur.join(""));
      cur = carry;
      len = carry.reduce((a, s) => a + s.length, 0);
    }
    cur.push(atom);
    len += atom.length;
  }
  if (cur.length > 0) {
    bodies.push(cur.join(""));
  }
  return bodies;
}
