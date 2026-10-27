// The nightly lesson pass (2026-10-25; post "Why your AI assistant forgets what you told it", section 7). The gateway
// method `thalamus.lessons.run` calls this; the bundled sleep routine (tinker-bridge `crons/memory-consolidation`) calls
// the method and puts the report in the one morning report. Nothing here schedules itself.
//
// WHAT IT DOES. Reads the owner's corrections since the last pass (table `corrections`, written by correction-capture
// while `lessons.mode` is not off), adds each to its lesson in the ledger, and for every lesson that slipped again finds
// where its rule lives on disk (rungs 1-3: notes, task notes, files read every turn), why it slipped, and the repair
// (`lesson-ladder.ts`). It writes the ledger, the report, and a drafted check for a lesson that moved up to rung 4.
//
// WATCH (the default) CHANGES NO RULE FILE. Everything it writes stays under `<dataDir>/lessons/`. `apply` also makes
// the repairs that can only tighten: it adds the concrete rule line to `lessons.target`. A repair that strikes or scopes
// a line already there may loosen a rule, so it is never applied: it waits in the report for the owner. A dry run writes
// nothing at all and returns the same report.
//
// COST. The files are read only on a night with a lesson to decide, asynchronously, at most `MAX_FILES_PER_DIR` per
// folder, two levels deep, so the gateway's event loop is never held for the whole read.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { EnhancementCard } from "openclaw/plugin-sdk/fork-thalamus";
import type { LessonsConfig } from "./config.js";
import { CORRECTION_CLASSES, type CorrectionClass } from "./correction-capture.js";
import {
  addSlip,
  decide,
  locate,
  parseLedger,
  renderCheckDraft,
  renderLessonsReport,
  specFor,
  type Ledger,
  type LessonVerdict,
  type SourceFile,
} from "./lesson-ladder.js";
import type { ThalamusStore } from "./store.js";

/** The always-read files when `lessons.alwaysRead` is empty: the workspace files every turn loads. */
export const DEFAULT_ALWAYS_READ = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
  "IDENTITY.md",
  "MEMORY.md",
];
export const MAX_FILES_PER_DIR = 3000;
const MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set([
  "archive",
  "people",
  "consolidation-logs",
  "co-access",
  "node_modules",
  ".git",
]);
/** The owner's words a correction row keeps, after redaction. */
export const LESSON_WORDS_MAX = 240;
const SLIP_WORDS_MAX = 160;
export const LESSONS_HEADING = "## Lessons from the nightly pass";

export type LessonSleepDeps = {
  store: () => ThalamusStore | undefined;
  config: () => LessonsConfig;
  dataDir: string;
  /** The agent workspace: where the default always-read files, `skills` and `memory` are. */
  workspaceDir: () => string | undefined;
  /** The note folders when `lessons.noteDirs` is empty (Thalamus passes the anticipation note's). */
  noteDirs: () => string[];
  cards: () => readonly EnhancementCard[];
  now: () => number;
};

export type LessonsRunResult = {
  ok: true;
  dry: boolean;
  mode: "watch" | "apply";
  corrections: number;
  lessons: Array<Pick<LessonVerdict, "id" | "status" | "cause" | "rungBefore" | "rungAfter">>;
  applied: string[];
  report: string;
  reportPath?: string;
};

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES_PER_DIR) {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= MAX_FILES_PER_DIR) {
      return;
    }
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
        await walk(p, depth - 1, out);
      }
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(p);
    }
  }
}

async function readSource(path: string, rung: 1 | 2 | 3): Promise<SourceFile | undefined> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > MAX_FILE_BYTES) {
      return undefined;
    }
    return { path, rung, mtimeMs: s.mtimeMs, text: await readFile(path, "utf8") };
  } catch {
    return undefined;
  }
}

/** Every file a rule can live in, each once, on its strongest rung. */
export async function readSources(o: {
  alwaysRead: readonly string[];
  taskDirs: readonly string[];
  noteDirs: readonly string[];
}): Promise<SourceFile[]> {
  const seen = new Set<string>();
  const out: SourceFile[] = [];
  const add = async (path: string, rung: 1 | 2 | 3) => {
    const p = resolve(path);
    if (seen.has(p)) {
      return;
    }
    seen.add(p);
    const f = await readSource(p, rung);
    if (f) {
      out.push(f);
    }
  };
  for (const f of o.alwaysRead) {
    await add(f, 3);
  }
  for (const [dirs, rung] of [
    [o.taskDirs, 2],
    [o.noteDirs, 1],
  ] as const) {
    for (const d of dirs) {
      const files: string[] = [];
      await walk(d, 2, files);
      for (const f of files) {
        await add(f, rung);
      }
    }
  }
  return out;
}

const writeAtomic = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
};

/**
 * Adds one rule line under the lessons heading of `target`, read again right before the write. A line already in the
 * file is not added twice. The target must exist: a missing always-read file is a setup the owner owns.
 */
export function appendLessonLine(
  target: string,
  line: string,
  note: string,
): "added" | "present" | "missing" {
  if (!existsSync(target)) {
    return "missing";
  }
  const real = realpathSync(target);
  const text = readFileSync(real, "utf8");
  if (text.includes(line)) {
    return "present";
  }
  const item = `- ${line} ${note}`;
  const at = text.indexOf(`\n${LESSONS_HEADING}\n`);
  let next: string;
  if (at < 0) {
    next = `${text.replace(/\n*$/, "\n")}\n${LESSONS_HEADING}\n\nAdded by the nightly lesson pass (Thalamus \`lessons.mode: apply\`): each line is a rule the owner had to give again.\n\n${item}\n`;
  } else {
    const after = text.indexOf("\n## ", at + LESSONS_HEADING.length + 1);
    const end = after < 0 ? text.length : after;
    const head = text.slice(0, end).replace(/\n*$/, "\n");
    next = `${head}${item}\n${after < 0 ? "" : `\n${text.slice(after + 1)}`}`;
  }
  writeAtomic(real, next);
  return "added";
}

const isClass = (s: string): s is CorrectionClass =>
  (CORRECTION_CLASSES as readonly string[]).includes(s);

const DAY_MS = 86_400_000;

export function createLessonSleep(d: LessonSleepDeps) {
  const dir = join(d.dataDir, "lessons");
  const ledgerPath = join(dir, "ledger.json");

  const readLedger = (): Ledger => {
    try {
      return parseLedger(JSON.parse(readFileSync(ledgerPath, "utf8")));
    } catch {
      return parseLedger(undefined);
    }
  };

  const paths = () => {
    const cfg = d.config();
    const ws = d.workspaceDir();
    const inWs = (names: readonly string[]) => (ws ? names.map((n) => join(ws, n)) : []);
    return {
      alwaysRead: cfg.alwaysRead.length > 0 ? cfg.alwaysRead : inWs(DEFAULT_ALWAYS_READ),
      taskDirs: cfg.taskDirs.length > 0 ? cfg.taskDirs : inWs(["skills"]),
      noteDirs: cfg.noteDirs.length > 0 ? cfg.noteDirs : d.noteDirs(),
      target: cfg.target || (ws ? join(ws, "AGENTS.md") : ""),
    };
  };

  return {
    ledgerPath,
    dir,
    async run(o: { dry: boolean }): Promise<LessonsRunResult | { ok: false; error: string }> {
      const cfg = d.config();
      if (cfg.mode === "off") {
        return { ok: false, error: "lessons-off" };
      }
      const store = d.store();
      if (!store) {
        return { ok: false, error: "not-running" };
      }
      const now = d.now();
      const ledger = readLedger();
      const since = ledger.lastRunTs > 0 ? ledger.lastRunTs : now - cfg.windowHours * 3_600_000;
      const rows = store.listCorrections({ sinceTs: since }).filter((r) => r.ts <= now);

      const cardInfo = new Map(d.cards().map((c) => [c.id, c]));
      const touched = new Set<string>();
      for (const r of rows) {
        if (!isClass(r.cls)) {
          continue;
        }
        const words = r.words.slice(0, SLIP_WORDS_MAX);
        const named = r.cls === "use_existing" && r.cards.length > 0 ? r.cards : [undefined];
        for (const c of named) {
          const card = c ? { name: c.name, kind: c.kind } : undefined;
          const spec = specFor(
            r.cls,
            c ? { ...c, purpose: cardInfo.get(c.id)?.purpose } : undefined,
          );
          const e = addSlip(
            ledger,
            { ts: r.ts, runId: r.runId, via: r.via, words, cls: r.cls, ...(card ? { card } : {}) },
            spec,
          );
          touched.add(e.id);
        }
      }

      const p = paths();
      const files = touched.size > 0 ? await readSources(p) : [];
      const verdicts: LessonVerdict[] = [];
      const applied = new Set<string>();
      const day = new Date(now).toISOString().slice(0, 10);
      for (const id of [...touched].toSorted()) {
        const e = ledger.lessons[id];
        const cardId = e.card ? `${e.card.kind}:${e.card.name}` : undefined;
        const spec = specFor(
          e.cls,
          e.card
            ? { ...e.card, purpose: cardId ? cardInfo.get(cardId)?.purpose : undefined }
            : undefined,
        );
        // Matching every line of a few thousand files takes about 0.2 s a lesson on a Pi: give the loop a turn between them.
        await new Promise<void>((r) => setImmediate(r));
        const v = decide(e, spec, locate(spec, files), {
          now,
          minSlips: cfg.minSlips,
          checkExists: e.check !== undefined && existsSync(join(dir, e.check.path)),
          target: p.target ? basename(p.target) : "the always-read file",
        });
        verdicts.push(v);
        if (o.dry) {
          continue;
        }
        if (v.status === "promoted" && e.check) {
          writeAtomic(join(dir, e.check.path), renderCheckDraft(e, spec, now));
        }
        if (cfg.mode === "apply" && p.target) {
          for (const r of v.repairs) {
            if (r.kind !== "add-line" || r.owner) {
              continue;
            }
            const note = `_(nightly lesson ${day}: corrected ${e.slipCount} times)_`;
            if (appendLessonLine(p.target, r.text, note) === "added") {
              applied.add(`${v.id}|${r.kind}|${r.text}`);
            }
          }
        }
      }

      const mode = cfg.mode;
      const report = renderLessonsReport(verdicts, ledger, {
        now,
        mode,
        applied,
        corrections: rows.length,
      });
      let reportPath: string | undefined;
      if (!o.dry) {
        ledger.lastRunTs = now;
        // Lessons not corrected for a year leave the ledger; their rule text stays wherever it was written.
        for (const [id, e] of Object.entries(ledger.lessons)) {
          if ((e.slips.at(-1)?.ts ?? 0) < now - 365 * DAY_MS) {
            delete ledger.lessons[id];
          }
        }
        writeAtomic(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
        reportPath = join(dir, "reports", `${day}.md`);
        writeAtomic(reportPath, `${report}\n`);
      }
      return {
        ok: true,
        dry: o.dry,
        mode,
        corrections: rows.length,
        lessons: verdicts.map((v) => ({
          id: v.id,
          status: v.status,
          cause: v.cause,
          rungBefore: v.rungBefore,
          rungAfter: v.rungAfter,
        })),
        applied: [...applied],
        report,
        ...(reportPath ? { reportPath } : {}),
      };
    },
  };
}

export type LessonSleep = ReturnType<typeof createLessonSleep>;
