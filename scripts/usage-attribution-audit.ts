/**
 * FORK 2026-10-21 — replay audit of the chat usage chips (bible tinker-ui.md §5.8AA).
 *
 * the architect, 2026-10-21: "I feel like you do not report all the skills and recipes used". This walks the
 * cc-bridge worker's Claude Code transcripts, feeds every tool_use to the REAL attributeToolUsage
 * (src/fork/usage-attribution.ts, the registry the gateway builds), and compares the marks with an
 * independent ORACLE that shares no code with the attributor:
 *   - a Skill tool call → that skill (plus the recipe a `jarvis-recipe <slug>` call names);
 *   - any string in the tool input holding `<prefix>/skills/<n>/<more>` where `<prefix>/skills/<n>/SKILL.md`
 *     exists → skill <n> (`<plugin>:<n>` inside the Claude plugin cache);
 *   - any `…/recipes/….md` (or `…/kits/….md`) that exists and is not CATALOG/README/INDEX/AUTHORING → recipe;
 *   - a command word that is a PATH symlink into a skill directory (`teams`, `jarvis`) → that skill.
 * Write-shaped calls (Write/Edit/MultiEdit/NotebookEdit) are excluded from the oracle: editing a skill is not using it.
 *
 * Usage:  npx tsx scripts/usage-attribution-audit.ts [--since 2026-10-15] [--dir <projects dir>] [--impl <usage-attribution.ts>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { UsageMark, UsageRegistry } from "../src/fork/usage-attribution.js";

// `--impl <file>` replays another tree's attributor (the "before" run points at develop's copy).
const implArg = process.argv.indexOf("--impl");
const IMPL =
  implArg >= 0 && process.argv[implArg + 1]
    ? path.resolve(process.argv[implArg + 1])
    : new URL("../src/fork/usage-attribution.ts", import.meta.url).pathname;
const UA = (await import(IMPL)) as typeof import("../src/fork/usage-attribution.js");
const { attributeToolUsage, getUsageRegistry } = UA;
/** Added by the 2026-10-21 fix; absent on the "before" run. */
const attributeSubagentUsage = (UA as Record<string, unknown>).attributeSubagentUsage as
  | ((dir: string, reg: UsageRegistry, opts?: { cwd?: string }) => UsageMark[])
  | undefined;

const HOME = os.homedir();
const argv = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const SINCE = Date.parse(opt("--since", "2026-10-15") + "T00:00:00Z");
const DIR = opt(
  "--dir",
  path.join(HOME, ".claude/projects/-home-user--openclaw-jarvis-workspace"),
);
const BRIDGE_CWD = opt("--cwd", path.join(HOME, ".openclaw/jarvis-workspace"));

type Call = {
  file: string;
  sub: boolean;
  turn: string; // `<file>#<n>` for a main transcript
  ts: number;
  id: string;
  cwd?: string;
  name: string;
  input: unknown;
};

// ── Oracle ──────────────────────────────────────────────────────────────────────────────────────

const exists = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const expand = (s: string) =>
  s
    .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, HOME)
    .replace(/(^|[\s'"=:(])~(?=\/)/g, `$1${HOME}`);
const SKILL_RE = /(\/[^\s'"`;|&()<>=,]*?)\/skills\/([A-Za-z0-9._-]+)\/([^\s'"`;|&()<>,]*)/g;
const RECIPE_RE = /(\/[^\s'"`;|&()<>=,]*\/(?:recipes|kits)\/[^\s'"`;|&()<>=,]*?\.md)\b/g;
const NON_RECIPE = new Set(["catalog.md", "readme.md", "index.md", "authoring.md"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const DISPATCH_TOOLS = new Set(["Workflow", "Agent", "Task"]);

const pathBinSkills = new Map<string, string>();
for (const d of [path.join(HOME, ".local/bin"), path.join(HOME, "bin")]) {
  let names: string[] = [];
  try {
    names = fs.readdirSync(d);
  } catch {
    continue;
  }
  for (const n of names) {
    try {
      const target = fs.realpathSync(path.join(d, n));
      const m = /\/skills\/([^/]+)\//.exec(target);
      if (
        m &&
        exists(target.slice(0, target.indexOf(`/skills/${m[1]}/`)) + `/skills/${m[1]}/SKILL.md`)
      ) {
        pathBinSkills.set(n, m[1]);
      }
    } catch {
      /* dangling */
    }
  }
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    out.push(v);
  } else if (Array.isArray(v)) {
    v.forEach((x) => strings(x, out));
  } else if (v && typeof v === "object") {
    Object.values(v).forEach((x) => strings(x, out));
  }
  return out;
}

type OracleHit = { kind: "skill" | "recipe"; name: string; evidence: string };

function oracle(call: Call): OracleHit[] {
  const hits: OracleHit[] = [];
  if (WRITE_TOOLS.has(call.name) || DISPATCH_TOOLS.has(call.name)) {
    return hits;
  }
  const input = (call.input ?? {}) as Record<string, unknown>;
  if (call.name === "Skill") {
    const s = String(input.skill ?? "")
      .replace(/^\//, "")
      .split(/\s+/)[0];
    if (s) {
      hits.push({ kind: "skill", name: s, evidence: "Skill tool" });
      if (/(^|:)jarvis-recipe$/.test(s)) {
        const slug = String(typeof input.args === "string" ? input.args : "")
          .trim()
          .split(/\s+/)[0];
        if (slug) {
          hits.push({ kind: "recipe", name: `slug:${slug}`, evidence: "jarvis-recipe" });
        }
      }
    }
    return hits;
  }
  for (const raw of strings(input)) {
    const s = expand(raw).slice(0, 16_000);
    for (const m of s.matchAll(SKILL_RE)) {
      const [, prefix, n, rest] = m;
      if (!rest || n === "." || n === "..") {
        continue;
      }
      if (exists(`${prefix}/skills/${n}/SKILL.md`)) {
        const cache = /\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+$/.exec(prefix);
        hits.push({ kind: "skill", name: cache ? `${cache[1]}:${n}` : n, evidence: m[0] });
      }
    }
    for (const m of s.matchAll(RECIPE_RE)) {
      const file = m[1];
      if (!NON_RECIPE.has(path.basename(file).toLowerCase()) && exists(file)) {
        hits.push({ kind: "recipe", name: `file:${path.resolve(file)}`, evidence: file });
      }
    }
    if (call.name === "Bash") {
      // Command position only: segment start, after a separator, or inside `$(`.
      // A heredoc body is text, not commands: drop it before looking for command words.
      const noBodies = s.replace(
        /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?([^\n]*)\n[\s\S]*?\n\t*\1(?=\n|$)/g,
        "<<$1$2",
      );
      for (const m of noBodies.matchAll(
        /(?:^|[;&|(\n]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:sudo\s+|nohup\s+|timeout\s+\d+\s+)?([A-Za-z][\w.-]*)(?=[ \t]|$)/gm,
      )) {
        const skill = pathBinSkills.get(m[1]);
        if (skill) {
          hits.push({ kind: "skill", name: skill, evidence: `PATH ${m[1]}` });
        }
      }
    }
  }
  if (call.name === "Bash" && typeof input.command === "string") {
    const cmd = expand(input.command);
    return hits.filter(
      (h) => h.evidence.startsWith("PATH ") || !onlyInWriteSegments(cmd, h.evidence),
    );
  }
  return hits;
}

const MAINT = new Set([
  "rm",
  "rmdir",
  "mv",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "truncate",
  "unlink",
  "git",
  "tee",
]);
/** Editing a skill is not using it: every occurrence sits in a write-shaped segment. */
function onlyInWriteSegments(cmd: string, evidence: string): boolean {
  let at = cmd.indexOf(evidence);
  if (at < 0) {
    return false;
  }
  while (at >= 0) {
    const before = cmd.slice(0, at);
    const segStart = Math.max(...[";", "&", "|", "\n", "("].map((c) => before.lastIndexOf(c))) + 1;
    const seg = before.slice(segStart);
    const head = seg.trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
    const write =
      MAINT.has(head) ||
      />{1,2}\s*["']?$/.test(seg) ||
      ((head === "sed" || head === "perl") && /\s-[A-Za-z]*i/.test(seg));
    if (!write) {
      return false;
    }
    at = cmd.indexOf(evidence, at + 1);
  }
  return true;
}

// ── Transcript walk ────────────────────────────────────────────────────────────────────────────

function listFiles(): { main: string[]; sub: string[] } {
  const main: string[] = [];
  const sub: string[] = [];
  for (const e of fs.readdirSync(DIR, { withFileTypes: true })) {
    const p = path.join(DIR, e.name);
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      if (fs.statSync(p).mtimeMs >= SINCE) {
        main.push(p);
      }
    } else if (e.isDirectory()) {
      const subDir = path.join(p, "subagents");
      if (!fs.existsSync(subDir)) {
        continue;
      }
      const walk = (d: string) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, f.name);
          if (f.isDirectory()) {
            walk(fp);
          } else if (/^agent-.*\.jsonl$/.test(f.name) && fs.statSync(fp).mtimeMs >= SINCE) {
            sub.push(fp);
          }
        }
      };
      walk(subDir);
    }
  }
  return { main, sub };
}

const dispatchDirs = new Map<string, string>(); // subagent dir → parent turn
const skillMdSeen = new Map<string, number>(); // SKILL.md path → earliest time a transcript proves it existed

async function readFile(file: string, sub: boolean, calls: Call[]): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let turnNo = 0;
  const seen = new Set<string>();
  for await (const line of rl) {
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) {
      continue;
    }
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "assistant" && e.type !== "user") {
      continue;
    }
    const ts = Date.parse(e.timestamp ?? "");
    const content = e.message?.content;
    if (e.type === "user") {
      const isPrompt =
        !e.isMeta &&
        (typeof content === "string" ||
          (Array.isArray(content) && content.some((b: any) => b?.type === "text")));
      if (isPrompt && !sub) {
        turnNo += 1;
      }
      const tur = e.toolUseResult;
      const dirText =
        (tur &&
          typeof tur === "object" &&
          typeof tur.transcriptDir === "string" &&
          tur.transcriptDir) ||
        undefined;
      if (dirText && !sub) {
        dispatchDirs.set(path.resolve(dirText), `${file}#${turnNo}`);
      }
      if (tur && typeof tur === "object" && typeof tur.agentId === "string" && !sub) {
        dispatchDirs.set(
          path.join(file.replace(/\.jsonl$/, ""), "subagents", `agent-${tur.agentId}.jsonl`),
          `${file}#${turnNo}`,
        );
      }
      continue;
    }
    if (!Array.isArray(content) || !(ts >= SINCE)) {
      continue;
    }
    for (const b of content) {
      if (b?.type !== "tool_use" || typeof b.id !== "string" || seen.has(b.id)) {
        continue;
      }
      seen.add(b.id);
      calls.push({
        file,
        sub,
        turn: sub ? file : `${file}#${turnNo}`,
        ts,
        id: b.id,
        name: String(b.name),
        input: b.input,
      });
      const fp = b.input?.file_path ?? b.input?.path;
      if (typeof fp === "string" && fp.endsWith("/SKILL.md")) {
        const abs = path.resolve(expand(fp));
        const prev = skillMdSeen.get(abs);
        if (b.name !== "Write" && (prev === undefined || ts < prev)) {
          skillMdSeen.set(abs, ts); // a Read/Edit of it proves it existed
        }
      }
    }
  }
}

function skillCreatedAt(name: string, evidence: string): number | undefined {
  const m = /^(.*?\/skills\/[^/]+)\//.exec(evidence);
  if (!m) {
    return undefined;
  }
  const md = `${m[1]}/SKILL.md`;
  let birth: number | undefined;
  try {
    birth = fs.statSync(md).birthtimeMs || undefined;
  } catch {
    return undefined;
  }
  const seen = skillMdSeen.get(md);
  return seen !== undefined && birth !== undefined ? Math.min(seen, birth) : birth;
}

/** Why the oracle has no hit for a real mark: a known blind spot of the oracle, or unexplained. */
function fpReason(call: Call, mark: UsageMark): string {
  if (mark.kind === "plugin") {
    return "plugin/mcp (oracle does not model D2)";
  }
  const input = (call.input ?? {}) as Record<string, unknown>;
  const text = expand(
    [input.command, input.workdir, input.cwd].filter((v) => typeof v === "string").join(" "),
  );
  const dir = mark.path ? path.dirname(mark.path) : "";
  if (
    dir &&
    (new RegExp(
      `(^|[\\s;&|(])(cd|pushd)\\s+["']?${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ).test(text) ||
      text.startsWith(dir))
  ) {
    return "relative path after cd/workdir (oracle blind)";
  }
  for (const m of text.matchAll(/(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*=["']?([^\s'";&|]+)/g)) {
    const v = m[1].replace(/\/+$/, "");
    if (v.startsWith("/") && mark.path && mark.path.startsWith(`${v}/`)) {
      return "shell variable (oracle blind)";
    }
  }
  if (
    [...pathBinSkills].some(
      ([bin, sk]) => sk === mark.name && new RegExp(`\\b${bin}\\b`).test(text),
    )
  ) {
    return "PATH word outside the oracle's command positions";
  }
  if (mark.kind === "recipe" && /recipe-state/.test(text)) {
    return "recipe-state slug (oracle blind)";
  }
  return "unexplained";
}

// ── Compare ────────────────────────────────────────────────────────────────────────────────────

function markKey(m: UsageMark): string {
  if (m.kind === "recipe") {
    return m.path ? `file:${path.resolve(m.path)}` : `slug:${m.name}`;
  }
  return m.name;
}

function hitMatches(hit: OracleHit, marks: UsageMark[]): boolean {
  if (hit.kind === "skill") {
    return marks.some(
      (m) => m.kind === "skill" && (m.name === hit.name || m.name.endsWith(`:${hit.name}`)),
    );
  }
  if (hit.name.startsWith("slug:")) {
    const slug = hit.name.slice(5);
    return marks.some(
      (m) =>
        m.kind === "recipe" &&
        (m.name === slug ||
          (m.path
            ? path.basename(path.dirname(m.path)) === slug || path.basename(m.path, ".md") === slug
            : false)),
    );
  }
  return marks.some(
    (m) => m.kind === "recipe" && m.path && path.resolve(m.path) === hit.name.slice(5),
  );
}

function classify(call: Call, hit: OracleHit): string {
  const cmd =
    typeof (call.input as any)?.command === "string"
      ? expand((call.input as any).command as string)
      : "";
  if (hit.evidence.startsWith("PATH ")) {
    return "path-bin";
  }
  if (call.name === "Bash") {
    const at = cmd.indexOf(hit.evidence);
    if (at >= 0 && /[A-Za-z_][A-Za-z0-9_]*=["']?$/.test(cmd.slice(Math.max(0, at - 80), at))) {
      return "shell-var";
    }
  }
  if (hit.kind === "skill") {
    const created = skillCreatedAt(hit.name, hit.evidence);
    if (created !== undefined && created > call.ts) {
      return "created-same-turn";
    }
  }
  if (hit.kind === "recipe") {
    return "recipe-odd";
  }
  if (call.name === "Grep" || call.name === "Glob") {
    return "search-tool";
  }
  return `other:${call.name}`;
}

async function main() {
  const { main: mainFiles, sub: subFiles } = listFiles();
  const calls: Call[] = [];
  for (const f of mainFiles) {
    await readFile(f, false, calls);
  }
  for (const f of subFiles) {
    await readFile(f, true, calls);
  }
  const reg = getUsageRegistry();
  const misses = new Map<string, Array<{ call: Call; hit: OracleHit }>>();
  const fps: Array<{ call: Call; mark: UsageMark; why: string }> = [];
  const excluded = { writeTools: 0, dispatch: 0 };
  const realByTurn = new Map<string, Set<string>>();
  const oracleBySubTurn = new Map<string, Map<string, Call>>();
  const subMarksByTurn = new Map<string, Set<string>>();
  let oracleHits = 0;
  let realMarks = 0;
  for (const call of calls) {
    if (WRITE_TOOLS.has(call.name)) {
      excluded.writeTools += 1;
    }
    if (DISPATCH_TOOLS.has(call.name)) {
      excluded.dispatch += 1;
    }
    const real = attributeToolUsage(
      { name: call.name, args: call.input, toolCallId: call.id },
      reg,
      { cwd: BRIDGE_CWD },
    );
    const hits = oracle(call);
    if (!call.sub) {
      oracleHits += hits.length;
      realMarks += real.length;
      const set = realByTurn.get(call.turn) ?? new Set<string>();
      real.forEach((m) => set.add(`${m.kind}:${m.name}`));
      realByTurn.set(call.turn, set);
      for (const hit of hits) {
        if (!hitMatches(hit, real)) {
          const cls = classify(call, hit);
          (misses.get(cls) ?? misses.set(cls, []).get(cls)!).push({ call, hit });
        }
      }
      for (const mark of real) {
        const ok = hits.some((h) => hitMatches(h, [mark]));
        if (!ok && !WRITE_TOOLS.has(call.name)) {
          fps.push({ call, mark, why: fpReason(call, mark) });
        }
      }
    } else {
      const dir = path.dirname(call.file);
      const parent = dispatchDirs.get(dir) ?? dispatchDirs.get(call.file);
      if (!parent) {
        continue;
      }
      const map = oracleBySubTurn.get(parent) ?? new Map<string, Call>();
      for (const hit of hits) {
        map.set(`${hit.kind}:${hit.name}`, call);
      }
      oracleBySubTurn.set(parent, map);
    }
  }
  // The subagent class is per parent turn: a skill a child used that the parent turn's chips lack.
  // AFTER the fix the parent turn also carries what attributeSubagentUsage returns for its dispatch dirs.
  const subMisses: Array<{ turn: string; key: string; call: Call }> = [];
  const dirsByTurn = new Map<string, string[]>();
  for (const [dir, turn] of dispatchDirs) {
    (dirsByTurn.get(turn) ?? dirsByTurn.set(turn, []).get(turn)!).push(dir);
  }
  for (const [turn, map] of oracleBySubTurn) {
    const parent = realByTurn.get(turn) ?? new Set<string>();
    const viaSub = new Set<string>();
    if (typeof attributeSubagentUsage === "function") {
      for (const dir of dirsByTurn.get(turn) ?? []) {
        for (const m of attributeSubagentUsage(dir, reg, { cwd: BRIDGE_CWD })) {
          viaSub.add(`${m.kind}:${m.name}`);
          viaSub.add(
            m.kind === "recipe" && m.path
              ? `recipe:file:${path.resolve(m.path)}`
              : `${m.kind}:${m.name}`,
          );
        }
      }
    }
    subMarksByTurn.set(turn, viaSub);
    for (const [key, call] of map) {
      const [kind, ...rest] = key.split(":");
      const name = rest.join(":");
      const have = [...parent, ...viaSub].some((k) => {
        if (kind === "skill") {
          return k === `skill:${name}` || k.endsWith(`:${name}`);
        }
        return (
          k === `recipe:${name}` || (name.startsWith("slug:") && k === `recipe:${name.slice(5)}`)
        );
      });
      if (!have) {
        subMisses.push({ turn, key, call });
      }
    }
  }
  const short = (c: Call) => {
    const s = JSON.stringify(c.input);
    return `${path.basename(c.file)} ${new Date(c.ts).toISOString()} ${c.name} ${s.length > 260 ? s.slice(0, 260) + "…" : s}`;
  };
  const report: Record<string, unknown> = {
    since: new Date(SINCE).toISOString(),
    files: { main: mainFiles.length, subagent: subFiles.length },
    calls: {
      main: calls.filter((c) => !c.sub).length,
      subagent: calls.filter((c) => c.sub).length,
    },
    oracleHits,
    realMarks,
    excluded,
    misses: Object.fromEntries(
      [...misses].map(([cls, list]) => [
        cls,
        {
          count: list.length,
          distinctSkills: [...new Set(list.map((m) => m.hit.name))].length,
          examples: list.slice(0, 2).map((m) => ({ hit: m.hit, call: short(m.call) })),
        },
      ]),
    ),
    subagent: {
      parentTurnsWithChildren: oracleBySubTurn.size,
      count: subMisses.length,
      examples: subMisses.slice(0, 2).map((m) => ({ key: m.key, child: short(m.call) })),
    },
    falsePositives: {
      count: fps.length,
      byReason: fps.reduce<Record<string, number>>((acc, f) => {
        acc[f.why] = (acc[f.why] ?? 0) + 1;
        return acc;
      }, {}),
      unexplained: fps
        .filter((f) => f.why === "unexplained")
        .slice(0, 8)
        .map((f) => ({ mark: `${f.mark.kind}:${f.mark.name}`, call: short(f.call) })),
      byName: Object.fromEntries(
        Object.entries(
          fps.reduce<Record<string, number>>((acc, f) => {
            const k = `${f.mark.kind}:${f.mark.name} via ${f.mark.via}`;
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          }, {}),
        )
          .toSorted((a, b) => b[1] - a[1])
          .slice(0, 15),
      ),
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

void main();
