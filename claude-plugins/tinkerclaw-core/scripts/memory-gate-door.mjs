/**
 * The memory write gate's door: everything around the decision that touches the disk.
 *
 * FORK 2026-10-25. memory-write-gate.mjs decides (pure); this file finds the memory root a write lands in, reads the
 * other notes of that folder and the always-loaded rule files, runs the decision, applies the outcome (a deny, a
 * rewritten tool input, the stamp on a superseded note, an ask queued for the owner) and logs one row per decision.
 * Both doors call runMemoryGate: the tinkerclaw-core Claude Code hook (memory-gate-hook.mjs) and the
 * tinkerclaw-memory-enhancements plugin's before_tool_call (through openclaw/plugin-sdk/memory-engram).
 *
 * The config both read is <state dir>/memory-gate/config.json, which the memory-enhancements plugin publishes on
 * gateway start (publishGateConfig). Rows go to <state dir>/data/memory-gate/gate.jsonl, enforced asks to asks.jsonl.
 * runMemoryGate never throws: an internal error is a row with the error and an allowed write.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyOp,
  DEFAULT_EXCLUDE_DIRS,
  GATE_CONFIG_VERSION,
  gateMemoryWrite,
  INDEX_NAMES,
  inputWithOp,
  isRuleLine,
  MEMORY_GATE_MODES,
  readFrontmatter,
  setFrontmatterFields,
  splitFrontmatter,
  stampSupersededNote,
  transformOp,
  writeOpOf,
} from "./memory-write-gate.mjs";

const MAX_NOTE_BYTES = 32 * 1024;
/**
 * A folder up to this size is read whole (the owner's flat auto-memory folder: 955 notes, about 50 ms). A larger one is a
 * folder of one note per subject (people/: 5,500 profiles, a second to read); there the same topic is the notes whose
 * file name shares a word with the target's, at most MAX_NAMED_CANDIDATES of them.
 */
const MAX_FOLDER_SCAN = 1200;
const MAX_NAMED_CANDIDATES = 200;

function byteOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── config and roots ────────────────────────────────────────────────────────────────────────────────────────

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** TinkerClaw's state dir: OPENCLAW_STATE_DIR (a leading `~` expanded), else ~/.openclaw. */
export function gateStateDir(env = process.env) {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  return override ? expandHome(override) : path.join(os.homedir(), ".openclaw");
}

export function gateConfigPath(stateDir) {
  return path.join(stateDir, "memory-gate", "config.json");
}

/** The published config, or null when there is none, it is not valid, or the gate is off. */
export function readGateConfig(stateDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(gateConfigPath(stateDir), "utf8"));
    if (!cfg || !MEMORY_GATE_MODES.includes(cfg.mode) || !Array.isArray(cfg.roots)) {
      return null;
    }
    return {
      mode: cfg.mode,
      roots: cfg.roots.filter((r) => typeof r === "string" && r),
      rulesFiles: Array.isArray(cfg.rulesFiles)
        ? cfg.rulesFiles.filter((r) => typeof r === "string" && r)
        : [],
      excludeDirs: Array.isArray(cfg.excludeDirs)
        ? cfg.excludeDirs.filter((r) => typeof r === "string")
        : DEFAULT_EXCLUDE_DIRS,
      claudeProjectMemory: cfg.claudeProjectMemory !== false,
    };
  } catch {
    return null;
  }
}

/**
 * Publish the config both doors read (mode off or null removes it). A file with the same content is not rewritten.
 * Returns the path written, or null when the gate is off.
 */
export function publishGateConfig(stateDir, config) {
  const file = gateConfigPath(stateDir);
  if (!config || !MEMORY_GATE_MODES.includes(config.mode)) {
    fs.rmSync(file, { force: true });
    return null;
  }
  const body = `${JSON.stringify(
    {
      v: GATE_CONFIG_VERSION,
      mode: config.mode,
      roots: [...new Set(config.roots.map(expandHome))].toSorted(byteOrder),
      rulesFiles: [...new Set(config.rulesFiles.map(expandHome))].toSorted(byteOrder),
      excludeDirs: [...(config.excludeDirs ?? DEFAULT_EXCLUDE_DIRS)],
      claudeProjectMemory: config.claudeProjectMemory !== false,
    },
    null,
    2,
  )}\n`;
  try {
    if (fs.readFileSync(file, "utf8") === body) {
      return file;
    }
  } catch {
    // not there yet
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** The Claude Code auto-memory folder from ~/.claude/settings.json (`autoMemoryDirectory`), if one is set. */
export function claudeAutoMemoryDir(home = os.homedir()) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    const dir = typeof s?.autoMemoryDirectory === "string" ? s.autoMemoryDirectory.trim() : "";
    return dir ? path.resolve(dir.startsWith("~") ? path.join(home, dir.slice(1)) : dir) : null;
  } catch {
    return null;
  }
}

function within(file, root) {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The memory root a file sits under, or null. A root is a folder or a single file. Claude Code's per-project memory
 * folders (~/.claude/projects/<project>/memory) count when `claudeProjectMemory` is on.
 */
export function memoryRootOf(file, config, home = os.homedir()) {
  const abs = path.resolve(file);
  if (!/\.md$/i.test(abs)) {
    return null;
  }
  const roots = [...config.roots];
  if (config.claudeProjectMemory) {
    const m = /^(.*\/\.claude\/projects\/[^/]+\/memory)(\/|$)/.exec(abs);
    if (m && within(m[1], path.join(home, ".claude", "projects"))) {
      roots.push(m[1]);
    }
  }
  for (const root of roots) {
    if (!within(abs, root)) {
      continue;
    }
    const rel = path.relative(root, abs).split(path.sep);
    if (
      rel.slice(0, -1).some((seg) => (config.excludeDirs ?? DEFAULT_EXCLUDE_DIRS).includes(seg))
    ) {
      return null;
    }
    return root;
  }
  return null;
}

function readCapped(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(MAX_NOTE_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_NOTE_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** The other Markdown notes in the target's folder (the same topic, in a folder-per-topic layout). */
export function loadFolderNotes(file, { maxScan = MAX_FOLDER_SCAN } = {}) {
  const dir = path.dirname(path.resolve(file));
  const self = path.resolve(file);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.md$/i.test(n));
  } catch {
    return [];
  }
  let pick = names.toSorted(byteOrder);
  if (pick.length > maxScan) {
    const words = path
      .basename(self, path.extname(self))
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((x) => x.length >= 4);
    pick = pick
      .filter((n) => words.some((x) => n.toLowerCase().includes(x)))
      .slice(0, MAX_NAMED_CANDIDATES);
  }
  const out = [];
  for (const n of pick) {
    const p = path.join(dir, n);
    if (p === self || INDEX_NAMES.has(n.toLowerCase())) {
      continue;
    }
    try {
      out.push({ file: p, text: readCapped(p) });
    } catch {
      // unreadable: not a candidate
    }
  }
  return out;
}

/** The directive lines of the always-loaded rule files. */
export function loadRuleLines(rulesFiles) {
  const out = [];
  for (const f of rulesFiles) {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (isRuleLine(l)) {
        out.push({ file: f, line: i + 1, text: l });
      }
    }
  }
  return out;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function localDate(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── logs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function appendRow(stateDir, name, row) {
  try {
    const dir = path.join(stateDir, "data", "memory-gate");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, name), `${JSON.stringify(row)}\n`);
  } catch {
    // A lost row costs the row, never the write.
  }
}

// ─── the door ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the agent is told when a write is refused. */
export function denyReason(decision) {
  const where = (decision.matches ?? [])
    .map((m) => (m.line ? `${m.file}:${m.line}` : m.file))
    .join(", ");
  switch (decision.label) {
    case "repeat":
      return `Memory gate: not saved, it is a repeat. Every new line is already in ${where || "a note"}. Nothing to write; if something changed, edit that note instead.`;
    case "clash":
      return (
        `Memory gate: not saved. This line contradicts an always-loaded rule (${where}): "${decision.clash?.rule ?? ""}". ` +
        "Ask the owner which one holds before saving anything. If he confirms the new one, the rule itself changes first. " +
        "In a scheduled run with nobody to ask, list it in your report; the question is queued in data/memory-gate/asks.jsonl."
      );
    case "unsourced-rule":
      return (
        "Memory gate: not saved. A rule (a note of type feedback) can only come from the owner's own words. " +
        "If these are his words, quote them and set `source: owner` in the frontmatter; otherwise save it as project or reference."
      );
    default:
      return `Memory gate: not saved (${decision.label}).`;
  }
}

/**
 * Run the gate on one tool call. Returns `{ action: "allow" }`, `{ action: "deny", reason }` or
 * `{ action: "rewrite", input, note }`, and applies the side effects: the log row, an enforced supersede stamp on the
 * old note, an enforced ask queued. Never throws: an error is `allow`.
 *
 * args: { door: "claude-code" | "gateway", toolName, input, config, stateDir, sessionKey?, origin?, cwd?, now? }
 */
export function runMemoryGate(args) {
  try {
    return runMemoryGateUnsafe(args);
  } catch (err) {
    appendRow(args.stateDir, "gate.jsonl", {
      v: 1,
      ts: new Date().toISOString(),
      door: args.door,
      error: String(err?.message ?? err).slice(0, 200),
    });
    return { action: "allow" };
  }
}

function runMemoryGateUnsafe(args) {
  const { config, stateDir } = args;
  if (!config || !MEMORY_GATE_MODES.includes(config.mode)) {
    return { action: "allow" };
  }
  const op = writeOpOf(args.toolName, args.input);
  if (!op) {
    return { action: "allow" };
  }
  const abs = path.resolve(args.cwd ?? process.cwd(), expandHome(op.file));
  const root = memoryRootOf(abs, config);
  if (!root) {
    return { action: "allow" };
  }
  const before = readOrNull(abs);
  const after = applyOp(before, op);
  if (after === null) {
    return { action: "allow" };
  }
  const now = args.now ?? Date.now();
  const date = localDate(now);
  const rulesFiles = config.rulesFiles.map((f) => path.resolve(f));
  const decision = gateMemoryWrite({
    file: abs,
    before,
    after,
    sessionKey: args.sessionKey,
    date,
    notes: loadFolderNotes(abs),
    rules: loadRuleLines(rulesFiles),
    isIndex: INDEX_NAMES.has(path.basename(abs).toLowerCase()),
    rulesFileSelf: rulesFiles.includes(abs),
  });

  const enforce = config.mode === "enforce";
  const refuse = decision.outcome === "skip" || decision.outcome === "ask";
  const nextOp = refuse ? op : transformOp(op, before, decision, { date, origin: args.origin });
  const rewrites = !refuse && JSON.stringify(nextOp) !== JSON.stringify(op);
  const would = refuse ? "deny" : rewrites || decision.supersedes ? "rewrite" : "allow";

  appendRow(stateDir, "gate.jsonl", {
    v: 1,
    ts: new Date(now).toISOString(),
    door: args.door,
    mode: config.mode,
    tool: String(args.toolName),
    file: abs,
    label: decision.label,
    outcome: decision.outcome,
    decision: enforce ? would : `would-${would}`,
    source: decision.source,
    sourceDeclared: decision.sourceDeclared,
    reason: decision.reason,
    matches: (decision.matches ?? []).map((m) =>
      m.line ? { file: m.file, line: m.line } : { file: m.file },
    ),
    sessionKey: args.sessionKey ?? "",
  });

  if (!enforce) {
    return { action: "allow", decision };
  }
  if (refuse) {
    if (decision.outcome === "ask") {
      appendRow(stateDir, "asks.jsonl", {
        v: 1,
        ts: new Date(now).toISOString(),
        file: abs,
        label: decision.label,
        rule: decision.clash
          ? { at: decision.matches[0], text: decision.clash.rule.slice(0, 300) }
          : undefined,
        proposed: (decision.clash?.line ?? "").slice(0, 300),
        sessionKey: args.sessionKey ?? "",
      });
    }
    return { action: "deny", reason: denyReason(decision), decision };
  }
  if (decision.supersedes) {
    const old = readOrNull(decision.supersedes.file);
    if (old !== null) {
      // A new note that took the old one's name is named by its file, so the stamp never points at itself.
      const newName = readFrontmatter(splitFrontmatter(after).fm).name;
      const byName =
        newName && newName !== decision.supersedes.name ? newName : path.basename(abs, ".md");
      const stamped = stampSupersededNote(old, byName, date, decision.label);
      if (stamped !== old) {
        fs.writeFileSync(decision.supersedes.file, stamped);
      }
    }
  }
  if (!rewrites) {
    return { action: "allow", decision };
  }
  const note =
    decision.outcome === "quote"
      ? "Memory gate: saved as a quote only (someone else's words, never an instruction)."
      : decision.outcome === "supersede"
        ? "Memory gate: saved; the old line is kept, struck and dated."
        : "Memory gate: saved with its source and date stamped.";
  return {
    action: "rewrite",
    input: inputWithOp(args.toolName, args.input, nextOp),
    note,
    decision,
  };
}

// ─── backfill ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Give every note in `dir` that has frontmatter but no `source:` the field `source: unknown`. Dry run unless
 * `apply`. Returns { scanned, missing, written }.
 */
export function backfillSources(dir, { apply = false } = {}) {
  let scanned = 0;
  let missing = 0;
  let written = 0;
  for (const n of fs
    .readdirSync(dir)
    .filter((x) => /\.md$/i.test(x))
    .toSorted()) {
    const p = path.join(dir, n);
    const text = readOrNull(p);
    if (text === null) {
      continue;
    }
    scanned++;
    const { fm } = splitFrontmatter(text);
    if (!fm || readFrontmatter(fm).source) {
      continue;
    }
    missing++;
    if (apply) {
      fs.writeFileSync(p, setFrontmatterFields(text, { source: "unknown" }));
      written++;
    }
  }
  return { scanned, missing, written };
}
