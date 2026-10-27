/**
 * One forget request, end to end: find every copy, redact what can be redacted, rebuild the
 * indexes from the clean files, count what git and the backups still hold, and hand back a receipt.
 *
 * Two steps, always. A call without `confirm` is a preview: it searches everything and changes
 * nothing. In apply mode the preview carries a one-time `confirm` code (15 minutes, kept in memory
 * only, bound to the same fact); passing it back redacts. A fuzzy match over every chat can hit
 * more than the owner meant, and the preview is where he sees that first.
 *
 * The request itself is a copy: the owner typed the fact, the tool call carries it, the reply may
 * repeat it. Those land in the chat record after the redaction, so the chat record is swept again
 * 1 and 10 minutes later for files changed since, and each pass is added to the receipt.
 */

import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { reposOf, searchHistory } from "./history.js";
import { purgeTranscriptIndexes, resyncMemoryIndexes, type GetMemoryManager } from "./indexes.js";
import {
  buildMatcher,
  FactError,
  forgottenToken,
  normalizeFact,
  type FactMatcher,
} from "./matcher.js";
import {
  displayPath,
  resolveEngramBaseDir,
  resolveRoots,
  type PlaceId,
  type Root,
} from "./places.js";
import {
  buildPlaces,
  compactReceipt,
  formatReceipt,
  writeReceipt,
  type FollowUp,
  type Receipt,
  type ReceiptItem,
} from "./receipt.js";
import { fileHolds } from "./redact.js";
import { sweep, type SweepResult } from "./sweep.js";

export type ForgetMode = "off" | "preview" | "apply";

export type ForgetConfig = {
  mode: ForgetMode;
  extraRoots: string[];
  backupDirs: string[];
  /** Copies outside this machine the owner knows of (an encrypted cloud backup): listed, never reached. */
  remoteCopies: string[];
  claudeCode: boolean;
  gitHistory: boolean;
  maxBinaryScanMB: number;
};

export type ForgetEnv = {
  stateDir: string;
  home: string;
  workspaceDirs: string[];
  agentIds: string[];
  memoryExtraPaths: string[];
  autoMemoryDir: string | null;
  config: ForgetConfig;
  getMemoryManager: GetMemoryManager;
  now?: () => Date;
  /** Follow-up passes over the chat record after an apply, in ms. Tests pass []. */
  followUpDelaysMs?: readonly number[];
  log?: (msg: string) => void;
};

export type ForgetRequest = {
  fact?: unknown;
  variants?: unknown;
  label?: unknown;
  confirm?: unknown;
};

const CONFIRM_TTL_MS = 15 * 60_000;
const MAX_VARIANTS = 5;
const MAX_LABEL_CHARS = 80;
export const FOLLOW_UP_DELAYS_MS = [60_000, 600_000] as const;

/** Process-wide: register() runs several times per gateway process, the codes and queue must not split. */
type ForgetState = {
  pending: Map<string, { key: string; expires: number }>;
  queue: Promise<unknown>;
  timers: Set<ReturnType<typeof setTimeout>>;
};
const STATE_KEY = Symbol.for("openclaw.tinkerclaw-forget.state");

export function forgetState(): ForgetState {
  const g = globalThis as Record<symbol, ForgetState | undefined>;
  g[STATE_KEY] ??= { pending: new Map(), queue: Promise.resolve(), timers: new Set() };
  return g[STATE_KEY];
}

/** Every sweep runs alone: two passes renaming the same file would undo each other's redaction. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const state = forgetState();
  const next = state.queue.then(fn, fn);
  state.queue = next.catch(() => undefined);
  return next;
}

function parseVariants(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    throw new FactError("variants must be a list of strings");
  }
  if (raw.length > MAX_VARIANTS) {
    throw new FactError(`at most ${MAX_VARIANTS} variants`);
  }
  return raw.map(normalizeFact);
}

function parseLabel(raw: unknown, matcher: FactMatcher): string | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new FactError("label must be a string");
  }
  const label = raw.trim().slice(0, MAX_LABEL_CHARS);
  matcher.replace.lastIndex = 0;
  if (matcher.replace.test(label)) {
    matcher.replace.lastIndex = 0;
    throw new FactError("the label must describe the fact without containing it");
  }
  matcher.replace.lastIndex = 0;
  return label || undefined;
}

function factKey(fact: string, variants: readonly string[]): string {
  const norm = [fact, ...variants.toSorted()].map((s) => s.toLowerCase());
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

function receiptId(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
}

function roots(env: ForgetEnv): { roots: Root[]; engramBaseDir: string } {
  const engramBaseDir = resolveEngramBaseDir(env.stateDir);
  return {
    engramBaseDir,
    roots: resolveRoots({
      stateDir: env.stateDir,
      home: env.home,
      workspaceDirs: env.workspaceDirs,
      memoryExtraPaths: env.memoryExtraPaths,
      autoMemoryDir: env.autoMemoryDir,
      engramBaseDir,
      claudeCode: env.config.claudeCode,
      extraRoots: env.config.extraRoots,
      backupDirs: env.config.backupDirs,
    }),
  };
}

/**
 * Live gateway transcripts that were redacted, by agent id: memory-core can index sessions too.
 * Only `<sessionId>.jsonl`: handing it a checkpoint copy or a prompt dump would index one more copy.
 */
function sessionFilesByAgent(stateDir: string, files: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const agentsDir = join(stateDir, "agents");
  for (const f of files) {
    const parts = relative(agentsDir, f).split(sep);
    if (
      parts.length === 3 &&
      parts[0] !== ".." &&
      parts[1] === "sessions" &&
      /^[^.]+\.jsonl$/.test(parts[2])
    ) {
      out.set(parts[0], [...(out.get(parts[0]) ?? []), f]);
    }
  }
  return out;
}

type Phase = {
  items: Map<PlaceId, ReceiptItem[]>;
  redacted: string[];
};

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function push(items: Map<PlaceId, ReceiptItem[]>, place: PlaceId, item: ReceiptItem) {
  items.set(place, [...(items.get(place) ?? []), item]);
}

function recordSweep(
  env: ForgetEnv,
  sw: SweepResult,
  apply: boolean,
  items: Phase["items"],
): string[] {
  const redacted: string[] = [];
  const mb = env.config.maxBinaryScanMB;
  for (const f of sw.found) {
    if (f.kind === "binary") {
      continue; // judged after the indexes are rebuilt
    }
    const path = displayPath(f.path, env.home);
    const bad = (f.unredacted ?? 0) > 0;
    if (f.wrote) {
      redacted.push(f.path);
    }
    push(items, f.place, {
      path,
      status: apply ? (bad ? "failed" : "done") : "found",
      copies: f.copies,
      detail: bad
        ? `${plural(f.unredacted ?? 0, "line")} in ${path} cannot be cleaned without breaking the file`
        : undefined,
    });
  }
  for (const s of sw.skipped) {
    const path = displayPath(s.path, env.home);
    push(items, s.place, {
      path,
      status: "out_of_reach",
      detail:
        s.why === "archive"
          ? `${path} is an archive or encrypted bundle: it may hold it, and nothing here can open it`
          : `${path} is a ${Math.round(s.size / 1e6)} MB binary store, over the ${mb} MB cap: not searched`,
    });
  }
  return redacted;
}

async function judgeBinaries(
  env: ForgetEnv,
  sw: SweepResult,
  matcher: FactMatcher,
  apply: boolean,
  items: Phase["items"],
): Promise<void> {
  for (const f of sw.found) {
    if (f.kind !== "binary") {
      continue;
    }
    const path = displayPath(f.path, env.home);
    // An index step may already have reported this file (the engram transcript index): the byte
    // check then refines that row instead of adding a second one.
    const same = (items.get(f.place) ?? []).find((it) => it.path === path);
    if (!apply) {
      if (!same) {
        push(items, f.place, {
          path,
          status: "found",
          detail: `${path} is a binary store that holds it: rebuilt from the redacted files where its owner can, else out of reach`,
        });
      }
      continue;
    }
    const still = await fileHolds(f.path, matcher).catch(() => false);
    if (!still) {
      if (!same) {
        push(items, f.place, {
          path,
          status: "done",
          detail: "the rebuilt store no longer holds it",
        });
      }
      continue;
    }
    const detail = `${path} is a binary store that still holds it after the rebuilds; nothing here can edit it: rebuild or delete it`;
    if (same) {
      same.status = "out_of_reach";
      same.detail = detail;
    } else {
      push(items, f.place, { path, status: "out_of_reach", detail });
    }
  }
}

async function recordHistory(
  env: ForgetEnv,
  rootList: readonly Root[],
  matcher: FactMatcher,
  items: Phase["items"],
): Promise<void> {
  if (!env.config.gitHistory) {
    return;
  }
  const repos = await reposOf(
    rootList.map((r) => ({
      path: r.path,
      isFile: statSync(r.path, { throwIfNoEntry: false })?.isFile() ?? false,
      topGlob: r.topGlob,
    })),
  );
  for (const h of await searchHistory({ repos, literals: matcher.literals })) {
    const repo = displayPath(h.repo, env.home);
    if (h.commits === 0) {
      push(items, "old_versions", { path: `git history of ${repo}`, status: "not_present" });
      continue;
    }
    push(items, "old_versions", {
      path: `git history of ${repo}`,
      status: "out_of_reach",
      detail:
        h.commits === null
          ? `the git history of ${repo} could not be searched (${h.error}); assume old commits hold it`
          : `it stays in the git history of ${repo} (${plural(h.commits, "commit")} added or removed it); erasing it needs a history rewrite (git filter-repo --replace-text), not done`,
    });
    for (const remote of h.remotes) {
      push(items, "backups", {
        path: `${repo} → remote ${remote}`,
        status: "out_of_reach",
        detail: `remote "${remote}" of ${repo} keeps every commit that was pushed`,
      });
    }
  }
}

/**
 * Run one forget request. Throws FactError for a request it refuses (bad fact, wrong mode,
 * unknown confirm code); everything else ends in a receipt, failures included.
 */
export async function runForget(req: ForgetRequest, env: ForgetEnv): Promise<Receipt> {
  const now = env.now?.() ?? new Date();
  const fact = normalizeFact(req.fact);
  const variants = parseVariants(req.variants);
  const matcher = buildMatcher(fact, variants);
  const label = parseLabel(req.label, matcher);
  const key = factKey(fact, variants);
  const state = forgetState();
  const confirm = typeof req.confirm === "string" && req.confirm.trim() ? req.confirm.trim() : null;
  const apply = confirm !== null;
  if (apply) {
    if (env.config.mode !== "apply") {
      throw new FactError(
        "forget is in preview mode: it searches and changes nothing. The owner turns redaction on with " +
          'plugins.entries.tinkerclaw-forget.config.mode = "apply"',
      );
    }
    const pending = state.pending.get(confirm);
    if (!pending || pending.expires < now.getTime() || pending.key !== key) {
      throw new FactError(
        "that confirm code is unknown, expired or for another fact: run a preview first",
      );
    }
    state.pending.delete(confirm);
  }

  return serialized(async () => {
    const { roots: rootList, engramBaseDir } = roots(env);
    const token = forgottenToken(now);
    const startedMs = Date.now();
    const sw = await sweep({
      roots: rootList,
      matcher,
      token,
      dryRun: !apply,
      maxBinaryBytes: env.config.maxBinaryScanMB * 1024 * 1024,
      excludeDirs: [join(env.stateDir, "data", "forget")],
    });
    const items = new Map<PlaceId, ReceiptItem[]>();
    const redacted = recordSweep(env, sw, apply, items);
    const touched = apply ? redacted : sw.found.filter((f) => f.kind === "text").map((f) => f.path);

    for (const it of await purgeTranscriptIndexes({
      engramBaseDir,
      redacted: touched,
      dryRun: !apply,
    })) {
      push(items, "search_index", { ...it, path: displayPath(it.path, env.home) });
    }
    for (const it of await resyncMemoryIndexes({
      agentIds: env.agentIds,
      getManager: env.getMemoryManager,
      fact,
      matcher,
      sessionFilesByAgent: sessionFilesByAgent(env.stateDir, touched),
      dryRun: !apply,
    })) {
      push(items, "search_index", it);
    }
    await judgeBinaries(env, sw, matcher, apply, items);
    await recordHistory(env, rootList, matcher, items);
    for (const remote of env.config.remoteCopies) {
      push(items, "backups", {
        path: remote,
        status: "out_of_reach",
        detail: `${remote}: a copy outside this machine; delete or rotate it there`,
      });
    }
    push(items, "provider", {
      path: "the model provider",
      status: "out_of_reach",
      detail:
        "the model provider received every chat turn that held it, this request included; what it keeps follows its own retention, and nothing here can delete it",
    });

    const receipt: Receipt = {
      id: receiptId(now),
      at: now.toISOString(),
      mode: apply ? "apply" : "preview",
      label,
      fact: { kind: matcher.kind, spellings: matcher.variants },
      places: buildPlaces(items),
      searched: rootList.map((r) => displayPath(r.path, env.home)),
    };
    env.log?.(
      `[forget] ${receipt.mode} ${receipt.id}: read ${sw.filesRead} files (${Math.round(sw.bytesRead / 1e6)} MB) in ${Date.now() - startedMs} ms; ` +
        receipt.places.map((p) => `${p.place}=${p.status}`).join(" "),
    );
    if (apply) {
      const dir = join(env.stateDir, "data", "forget");
      receipt.file = displayPath(await writeReceipt(dir, receipt), env.home);
      scheduleFollowUps(env, {
        matcher,
        token,
        fact,
        startedMs,
        receiptPath: join(dir, "receipts", `${receipt.id}.json`),
        dir,
        id: receipt.id,
      });
    } else if (env.config.mode === "apply") {
      const code = randomBytes(4).toString("hex");
      state.pending.set(code, { key, expires: now.getTime() + CONFIRM_TTL_MS });
      receipt.confirm = code;
    } else {
      receipt.note =
        "Redaction is off: this plugin runs in preview mode. The owner turns it on with " +
        'plugins.entries.tinkerclaw-forget.config.mode = "apply".';
    }
    return receipt;
  });
}

/** One later pass over everything changed since the apply began: the request's own copies. */
export async function followUpPass(
  env: ForgetEnv,
  job: { matcher: FactMatcher; token: string; fact: string; startedMs: number },
): Promise<FollowUp> {
  return serialized(async () => {
    const { roots: rootList, engramBaseDir } = roots(env);
    const sw = await sweep({
      roots: rootList,
      matcher: job.matcher,
      token: job.token,
      dryRun: false,
      maxBinaryBytes: 0,
      modifiedSince: job.startedMs,
      excludeDirs: [join(env.stateDir, "data", "forget")],
    });
    const text = sw.found.filter((f) => f.kind === "text");
    const redacted = text.filter((f) => f.wrote).map((f) => f.path);
    if (redacted.length > 0) {
      await purgeTranscriptIndexes({ engramBaseDir, redacted, dryRun: false });
      await resyncMemoryIndexes({
        agentIds: env.agentIds,
        getManager: env.getMemoryManager,
        fact: job.fact,
        matcher: job.matcher,
        sessionFilesByAgent: sessionFilesByAgent(env.stateDir, redacted),
        dryRun: false,
      });
    }
    return {
      at: new Date().toISOString(),
      files: text.length,
      copies: text.reduce((n, f) => n + (f.copies ?? 0), 0),
      failed: text.filter((f) => (f.unredacted ?? 0) > 0).length,
    };
  });
}

function scheduleFollowUps(
  env: ForgetEnv,
  job: {
    matcher: FactMatcher;
    token: string;
    fact: string;
    startedMs: number;
    receiptPath: string;
    dir: string;
    id: string;
  },
): void {
  const state = forgetState();
  for (const delay of env.followUpDelaysMs ?? FOLLOW_UP_DELAYS_MS) {
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      void (async () => {
        try {
          const pass = await followUpPass(env, job);
          const receipt = JSON.parse(await readFile(job.receiptPath, "utf8")) as Receipt;
          receipt.followUps = [...(receipt.followUps ?? []), pass];
          await writeFile(job.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
            mode: 0o600,
          });
          await appendFile(
            join(job.dir, "receipts.md"),
            `  - follow-up ${pass.at.slice(0, 16).replace("T", " ")} for ${job.id}: ${plural(pass.copies, "new copy", "new copies")} in ${plural(pass.files, "file")}${pass.failed ? `, ${pass.failed} FAILED` : ""}\n`,
          );
          env.log?.(
            `[forget] follow-up ${job.id}: ${plural(pass.copies, "copy", "copies")} in ${plural(pass.files, "file")}`,
          );
        } catch (err) {
          console.error("[forget] follow-up pass failed", err);
        }
      })();
    }, delay);
    timer.unref?.();
    state.timers.add(timer);
  }
}

export function stopFollowUps(): void {
  const state = forgetState();
  for (const t of state.timers) {
    clearTimeout(t);
  }
  state.timers.clear();
}

export { compactReceipt, FactError, formatReceipt };
