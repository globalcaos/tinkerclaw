/**
 * FORK 2026-10-09 (Fractal v2 M4, charter contract C2) — the ledger row of a background Fractal run.
 *
 * The census of 2026-10-09 read 2,675 reflections: 131 of the 536 claims that failed named a file
 * that was never on disk, and the only way to tell a reflection that fixed something from one that
 * said it did was to read it by hand. The owner does not want to vote cards ("I just don't have the
 * time, find a better way"), so the bridge, which sees every tool call of the run, writes down what
 * the run actually did and checks what its text says it did:
 *
 * - `writes`: the files its own Edit/Write/NotebookEdit calls changed (a failed call changed none);
 * - `commits`: the `[branch sha] subject` lines its Bash calls printed, with the repo when the
 *   command named one (`cd …`, `git -C …`) or when one of the known repos holds the SHA;
 * - `claims`: every path and commit SHA in its final text, each checked on disk / with
 *   `git cat-file -e <sha>^{commit}`, and marked `byThisRun` when the run made it itself.
 *
 * One JSON line per run goes to `<stateDir>/data/fractal/ledger.jsonl` and the same row rides an
 * agent event `{ stream: "fractal-check" }`, so the card under the reply can show ✓/✗ live and the
 * weekly script (C6) can measure what survived. Only `fractal-<P>` runs pay anything: every other
 * run returns before the first check. Nothing here may cost the turn; stream.ts calls
 * {@link scheduleFractalLedger}, which never throws and logs one line on failure.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { forkParentRunId } from "./fork-parent.js";
import { peekToolEventsForRun } from "./tool-buffer.js";
import type { ToolBufferedEvent } from "./tool-buffer.types.js";

const log = createSubsystemLogger("tinkerclaw-tinker-bridge");

export const LEDGER_VERSION = 1;
export const FRACTAL_TRIGGERS = ["correction", "friction", "delivery", "channel"] as const;
export type FractalTrigger = (typeof FRACTAL_TRIGGERS)[number];

export type LedgerCommit = { sha: string; repo?: string };
export type ClaimRef = { ref: string; kind: "path" | "commit" };
export type LedgerClaim = ClaimRef & { ok: boolean; byThisRun: boolean; why: string };
export type LedgerUsage = { cacheRead: number; cacheWrite: number; input: number; output: number };
export type LedgerVerdict = "acted" | "clean" | "unverified";

export type FractalLedgerRow = {
  v: typeof LEDGER_VERSION;
  ts: number;
  parentRunId: string;
  runId: string;
  sessionKey?: string;
  model: string;
  durationMs: number;
  usage: LedgerUsage;
  triggers: FractalTrigger[];
  writes: string[];
  commits: LedgerCommit[];
  claims: LedgerClaim[];
  verdict: LedgerVerdict;
  firstLine: string;
};

/** What stream.ts knows when a Fractal run's result line arrives. */
export type FractalTurnEnd = {
  runId: string | undefined;
  sessionKey?: string;
  model: string;
  /** The user text of the turn (the C4 Fractal prompt), before the bridge's chat-row directive. */
  prompt: string;
  /** The run's final text: the CLI's own `result.result`, else what streamed. */
  finalText: string;
  usage: LedgerUsage;
  durationMs: number;
  /** The worker's cwd, a base for relative paths in the text. */
  cwd?: string;
  toolEvents: ToolBufferedEvent[];
};

export type FractalLedgerEvent = {
  runId: string;
  sessionKey?: string;
  stream: string;
  data: Record<string, unknown>;
};

export type FractalLedgerDeps = {
  stateDir?: string;
  home?: string;
  /** Repos a commit claim is looked up in (C2: tinkerclaw, jarvis-icu, ~/.openclaw). */
  repos?: string[];
  /** Directories a relative path claim is resolved against, besides the run's cwd. */
  bases?: string[];
  pathExists?: (absPath: string) => Promise<boolean>;
  commitExists?: (repo: string, sha: string) => Promise<boolean>;
  append?: (file: string, line: string) => Promise<void>;
  emit?: (event: FractalLedgerEvent) => void;
  now?: () => number;
};

/** A run's claims are checked up to this many; a reflection that names more is an outlier. */
export const MAX_CLAIMS = 100;
const FIRST_LINE_CAP = 240;
const GIT_TIMEOUT_MS = 5_000;

export function ledgerPathFor(stateDir: string): string {
  return path.join(stateDir, "data", "fractal", "ledger.jsonl");
}

export function defaultRepos(home: string = os.homedir()): string[] {
  return [
    path.join(home, "src", "tinkerclaw"),
    path.join(home, "src", "jarvis-icu"),
    path.join(home, ".openclaw"),
  ];
}

function expandHome(p: string, home: string): string {
  if (p === "~" || p === "$HOME") {
    return home;
  }
  if (p.startsWith("~/")) {
    return path.join(home, p.slice(2));
  }
  if (p.startsWith("$HOME/")) {
    return path.join(home, p.slice(6));
  }
  return p;
}

/** The triggers of the C4 prompt line `Triggers: a, b — reasons`; empty when absent. */
export function parseTriggersLine(prompt: string): FractalTrigger[] {
  const line = /^Triggers:[ \t]*(.*)$/m.exec(prompt)?.[1] ?? "";
  const names = line.split(/\s+[—–-]\s+/, 1)[0] ?? "";
  const out: FractalTrigger[] = [];
  for (const raw of names.split(",")) {
    const name = raw.trim().toLowerCase() as FractalTrigger;
    if (FRACTAL_TRIGGERS.includes(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

/** Pair each tool start with its result (by call id), in start order. */
function pairToolCalls(
  events: ToolBufferedEvent[],
): Array<{ name: string; args: Record<string, unknown>; result?: string; isError?: boolean }> {
  const calls = new Map<
    string,
    { name: string; args: Record<string, unknown>; result?: string; isError?: boolean }
  >();
  for (const ev of events) {
    if (ev.phase === "start") {
      if (!calls.has(ev.toolCallId)) {
        calls.set(ev.toolCallId, { name: ev.name, args: ev.args ?? {} });
      }
    } else {
      const call = calls.get(ev.toolCallId);
      if (call && call.result === undefined) {
        call.result = ev.result;
        call.isError = ev.isError;
      }
    }
  }
  return [...calls.values()];
}

const WRITE_TOOLS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

/** Absolute paths the run's own Edit/Write/NotebookEdit calls changed; a failed call changed none. */
export function collectWrites(events: ToolBufferedEvent[], home: string = os.homedir()): string[] {
  const out: string[] = [];
  for (const call of pairToolCalls(events)) {
    const key = WRITE_TOOLS[call.name];
    const raw = key ? call.args[key] : undefined;
    if (typeof raw !== "string" || !raw.trim() || call.isError === true) {
      continue;
    }
    const abs = path.resolve(expandHome(raw.trim(), home));
    if (!out.includes(abs)) {
      out.push(abs);
    }
  }
  return out;
}

/** git's `[branch sha] subject` lines (`git commit`, `cherry-pick`, `--amend`). */
export function parseCommitLines(
  text: string,
): Array<{ branch: string; sha: string; subject: string }> {
  const out: Array<{ branch: string; sha: string; subject: string }> = [];
  const re = /^\[(.+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/gm;
  for (const m of text.matchAll(re)) {
    out.push({ branch: m[1], sha: m[2], subject: m[3].trim() });
  }
  return out;
}

/** The repo a Bash command committed in: its last `cd <dir>` or `git -C <dir>`, if any. */
export function inferRepoFromCommand(
  command: string,
  home: string = os.homedir(),
): string | undefined {
  const re = /(?:^|[\s;&|(])(?:cd|git\s+-C)\s+("([^"]+)"|'([^']+)'|([^\s;&|)]+))/g;
  let last: string | undefined;
  for (const m of command.matchAll(re)) {
    last = m[2] ?? m[3] ?? m[4];
  }
  if (!last) {
    return undefined;
  }
  const expanded = expandHome(last, home);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : undefined;
}

/** Commits the run's Bash calls printed, once each, with the repo the command named. */
export function collectCommits(
  events: ToolBufferedEvent[],
  home: string = os.homedir(),
): LedgerCommit[] {
  const out: LedgerCommit[] = [];
  for (const call of pairToolCalls(events)) {
    if (call.name !== "Bash" || typeof call.result !== "string") {
      continue;
    }
    const command = typeof call.args.command === "string" ? call.args.command : "";
    const repo = inferRepoFromCommand(command, home);
    for (const { sha } of parseCommitLines(call.result)) {
      if (out.some((c) => c.sha === sha)) {
        continue;
      }
      out.push(repo ? { sha, repo } : { sha });
    }
  }
  return out;
}

const RELATIVE_PATH_RE = /^[\w.@-]+(?:\/[\w.@-]+)+$/;
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Drop a `:12`, `:12:3` or `#L12` locator and trailing sentence punctuation. */
function cleanPathToken(token: string): string {
  return token
    .replace(/[.,;:!?)]+$/, "")
    .replace(/#L\d+(?:-L?\d+)?$/, "")
    .replace(/(?::\d+){1,2}$/, "");
}

function looksLikePath(token: string): boolean {
  if (!token || /[*<>{}$|]|:\/\//.test(token)) {
    return false;
  }
  if (token.startsWith("~/") || token.startsWith("/")) {
    return token.length > 2;
  }
  // A relative token counts only with a file extension: `fx/bridge-ledger` is a branch and
  // `openclaw/plugin-sdk` a module specifier, `src/stream.ts` is a file.
  return RELATIVE_PATH_RE.test(token) && FILE_EXT_RE.test(token);
}

/**
 * Every path and commit SHA the final text names, in text order, once each.
 *
 * Paths: a backticked span that is a path as a whole (absolute, `~/`, or relative with a file
 * extension; spaces allowed inside backticks), and bare `~/…` and `/home/…` tokens elsewhere. A
 * bare path with a space in it is cut at the space, which can turn into a false ✗: the doctrine
 * asks for backticks (P3). SHAs: 7–40 hex; outside backticks a token needs a digit AND a letter,
 * so counts (20261009) and words (deadbeef) are not commits.
 */
export function extractClaimRefs(text: string): ClaimRef[] {
  const found: Array<ClaimRef & { at: number }> = [];
  const seen = new Set<string>();
  const add = (ref: string, kind: ClaimRef["kind"], at: number) => {
    const key = `${kind}:${ref}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ ref, kind, at });
    }
  };
  let rest = text;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const at = m.index ?? 0;
    const inner = m[1].trim();
    if (SHA_RE.test(inner)) {
      add(inner, "commit", at);
    } else {
      const cleaned = cleanPathToken(inner);
      if (!looksLikePath(cleaned) || (/\s/.test(cleaned) && !/^(?:~\/|\/)/.test(cleaned))) {
        continue;
      }
      add(cleaned, "path", at);
    }
    // Blank the span so the bare scans below neither cut it at a space nor count it twice.
    rest = rest.slice(0, at) + " ".repeat(m[0].length) + rest.slice(at + m[0].length);
  }
  for (const m of rest.matchAll(/(?<![\w/.~:-])(?:~|\/home)\/[^\s`'"()<>[\]{},;]+/g)) {
    const cleaned = cleanPathToken(m[0]);
    if (looksLikePath(cleaned)) {
      add(cleaned, "path", m.index ?? 0);
    }
  }
  for (const m of rest.matchAll(/(?<![\w/.#~-])[0-9a-f]{7,40}(?![\w/-])/g)) {
    if (/[0-9]/.test(m[0]) && /[a-f]/.test(m[0])) {
      add(m[0], "commit", m.index ?? 0);
    }
  }
  return found.toSorted((a, b) => a.at - b.at).map(({ ref, kind }) => ({ ref, kind }));
}

const sameSha = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

async function defaultPathExists(absPath: string): Promise<boolean> {
  try {
    await fs.promises.access(absPath);
    return true;
  } catch {
    return false;
  }
}

function defaultCommitExists(repo: string, sha: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-C", repo, "cat-file", "-e", `${sha}^{commit}`],
        { timeout: GIT_TIMEOUT_MS },
        (err) => resolve(!err),
      );
    } catch {
      resolve(false);
    }
  });
}

async function findCommitRepo(
  sha: string,
  repos: string[],
  commitExists: (repo: string, sha: string) => Promise<boolean>,
  preferred?: string,
): Promise<string | undefined> {
  const order = preferred ? [preferred, ...repos.filter((r) => r !== preferred)] : repos;
  for (const repo of order) {
    if (await commitExists(repo, sha)) {
      return repo;
    }
  }
  return undefined;
}

/**
 * Settle each commit's repo: the one its command named when that repo holds it, else the first
 * known repo that does, else whatever the command named (a repo outside the known three).
 */
export async function resolveCommitRepos(
  commits: LedgerCommit[],
  deps: Pick<FractalLedgerDeps, "repos" | "commitExists" | "home"> = {},
): Promise<LedgerCommit[]> {
  const repos = deps.repos ?? defaultRepos(deps.home);
  const commitExists = deps.commitExists ?? defaultCommitExists;
  return Promise.all(
    commits.map(async (c) => {
      const repo = await findCommitRepo(c.sha, repos, commitExists, c.repo);
      const settled = repo ?? c.repo;
      return settled ? { sha: c.sha, repo: settled } : { sha: c.sha };
    }),
  );
}

/** Check every claim: does it exist, and did this run make it. */
export async function checkClaims(
  refs: ClaimRef[],
  made: { writes: string[]; commits: LedgerCommit[]; cwd?: string },
  deps: Pick<FractalLedgerDeps, "home" | "repos" | "bases" | "pathExists" | "commitExists"> = {},
): Promise<LedgerClaim[]> {
  const home = deps.home ?? os.homedir();
  const repos = deps.repos ?? defaultRepos(home);
  const bases = [
    ...(made.cwd ? [made.cwd] : []),
    ...(deps.bases ?? [...repos, path.join(home, ".openclaw", "workspace")]),
  ];
  const pathExists = deps.pathExists ?? defaultPathExists;
  const commitExists = deps.commitExists ?? defaultCommitExists;
  const repoLabel = (repo: string) => path.basename(repo);

  const settle = (claim: ClaimRef, ok: boolean, byThisRun: boolean, why: string): LedgerClaim => ({
    ref: claim.ref,
    kind: claim.kind,
    ok,
    byThisRun,
    why,
  });

  return Promise.all(
    refs.slice(0, MAX_CLAIMS).map(async (claim): Promise<LedgerClaim> => {
      if (claim.kind === "commit") {
        const own = made.commits.find((c) => sameSha(c.sha, claim.ref));
        const repo = await findCommitRepo(claim.ref, repos, commitExists, own?.repo);
        if (own) {
          const why = repo ? "committed by this run" : "committed by this run, gone now";
          return settle(claim, repo !== undefined, true, why);
        }
        return repo
          ? settle(claim, true, false, `in ${repo}`)
          : settle(claim, false, false, `in none of ${repos.map(repoLabel).join(", ")}`);
      }
      const expanded = expandHome(claim.ref, home);
      const candidates = path.isAbsolute(expanded)
        ? [path.normalize(expanded)]
        : bases.map((base) => path.join(base, expanded));
      const byThisRun = made.writes.some(
        (w) => candidates.includes(w) || (!path.isAbsolute(expanded) && w.endsWith(`/${expanded}`)),
      );
      let ok = false;
      for (const candidate of candidates) {
        if (await pathExists(candidate)) {
          ok = true;
          break;
        }
      }
      if (byThisRun) {
        return settle(
          claim,
          ok,
          true,
          ok ? "written by this run" : "written by this run, gone now",
        );
      }
      return settle(claim, ok, false, ok ? "exists" : "not on disk");
    }),
  );
}

export function decideVerdict(
  writes: string[],
  commits: LedgerCommit[],
  claims: LedgerClaim[],
): LedgerVerdict {
  if (claims.some((c) => !c.ok)) {
    return "unverified";
  }
  return writes.length > 0 || commits.length > 0 ? "acted" : "clean";
}

export function firstLineOf(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, FIRST_LINE_CAP);
}

export function buildLedgerRow(input: {
  ts: number;
  runId: string;
  parentRunId: string;
  sessionKey?: string;
  model: string;
  durationMs: number;
  usage: LedgerUsage;
  triggers: FractalTrigger[];
  writes: string[];
  commits: LedgerCommit[];
  claims: LedgerClaim[];
  finalText: string;
}): FractalLedgerRow {
  return {
    v: LEDGER_VERSION,
    ts: input.ts,
    parentRunId: input.parentRunId,
    runId: input.runId,
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    model: input.model,
    durationMs: input.durationMs,
    usage: input.usage,
    triggers: input.triggers,
    writes: input.writes,
    commits: input.commits,
    claims: input.claims,
    verdict: decideVerdict(input.writes, input.commits, input.claims),
    firstLine: firstLineOf(input.finalText),
  };
}

async function defaultAppend(file: string, line: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, line, "utf8");
}

/**
 * Build, append and announce the ledger row of a Fractal run. Null for any other run (no cost).
 * Rejects on an I/O failure; {@link scheduleFractalLedger} is the caller that may not throw.
 */
export async function recordFractalLedger(
  input: FractalTurnEnd,
  deps: FractalLedgerDeps = {},
): Promise<FractalLedgerRow | null> {
  const parentRunId = forkParentRunId(input.runId);
  if (!parentRunId || !input.runId) {
    return null;
  }
  const home = deps.home ?? os.homedir();
  const writes = collectWrites(input.toolEvents, home);
  const commits = await resolveCommitRepos(collectCommits(input.toolEvents, home), deps);
  const claims = await checkClaims(
    extractClaimRefs(input.finalText),
    { writes, commits, cwd: input.cwd },
    { ...deps, home },
  );
  const row = buildLedgerRow({
    ts: (deps.now ?? Date.now)(),
    runId: input.runId,
    parentRunId,
    sessionKey: input.sessionKey,
    model: input.model,
    durationMs: input.durationMs,
    usage: input.usage,
    triggers: parseTriggersLine(input.prompt),
    writes,
    commits,
    claims,
    finalText: input.finalText,
  });
  const stateDir = deps.stateDir ?? resolveStateDir();
  await (deps.append ?? defaultAppend)(ledgerPathFor(stateDir), `${JSON.stringify(row)}\n`);
  (deps.emit ?? emitAgentEvent)({
    runId: input.runId,
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    stream: "fractal-check",
    data: row as unknown as Record<string, unknown>,
  });
  return row;
}

/**
 * The stream.ts hook at a Fractal run's result line. Synchronous and throw-proof: it snapshots the
 * run's buffered tool events (the turn-end drain in attempt-hooks.ts has not run yet: the `done`
 * event that leads to it is pushed after this call), then records in the background. Any failure,
 * sync or async, is one warn line and never reaches the turn. A non-Fractal run returns at once.
 */
export function scheduleFractalLedger(
  input: Omit<FractalTurnEnd, "toolEvents">,
  deps: FractalLedgerDeps & { record?: typeof recordFractalLedger } = {},
): void {
  try {
    if (!forkParentRunId(input.runId) || !input.runId) {
      return;
    }
    const runId = input.runId;
    const toolEvents = peekToolEventsForRun(runId);
    const record = deps.record ?? recordFractalLedger;
    void Promise.resolve()
      .then(() => record({ ...input, toolEvents }, deps))
      .catch((err: unknown) => {
        log.warn(`[fractal-ledger] run ${runId}: no ledger row (${formatErrorMessage(err)})`);
      });
  } catch (err) {
    log.warn(
      `[fractal-ledger] run ${input.runId ?? "?"}: no ledger row (${formatErrorMessage(err)})`,
    );
  }
}
