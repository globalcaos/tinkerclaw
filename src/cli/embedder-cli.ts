/**
 * FORK 2026-10-29: `openclaw embedder fit` and `openclaw embedder status`, the per-machine embedder
 * fit (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
 * - fit measures this machine and writes <stateDir>/memory/embedder-fit.json through
 *   src/fork/embedder-fit-measure.ts. In a terminal it asks before a download and, only when no
 *   local model fits and a remote key exists, whether memory text may leave the machine. Without a
 *   terminal it never asks: it downloads only with --pull and goes remote only with --allow-remote.
 * - status reads that record and the governor's snapshot file, makes no gateway call, and exits 0.
 * Neither prints a key: remote providers appear by id only.
 */
import { stdin, stdout } from "node:process";
import type { Command } from "commander";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  EmbedderFitBusyError,
  runEmbedderFit,
  type EmbedderFitDeps,
} from "../fork/embedder-fit-measure.js";
import {
  cheapFingerprint,
  embedderFitPaths,
  fingerprintDiff,
  fitEndpointKeyFor,
  normalizeEmbeddingModelName,
  readEmbedderFit,
  type EmbedderConsent,
  type EmbedderFitRecord,
  type FitDecision,
  type FitMode,
} from "../fork/embedder-fit.js";
import {
  readEmbedGovernorSnapshots,
  type EmbedGovernorSnapshot,
} from "../fork/embedder-governor.js";
import { defaultRuntime, type OutputRuntimeEnv } from "../runtime.js";

/** sysexits EX_TEMPFAIL: another fit holds the lock, or a background fit found no idle CPU; try later. */
const EXIT_TRY_LATER = 75;
/** 128 + SIGINT: the fit was interrupted; its lock is released. */
const EXIT_INTERRUPTED = 130;

type CliRuntime = Pick<OutputRuntimeEnv, "log" | "error" | "writeJson">;

export type EmbedderFitCliOptions = {
  pull?: boolean;
  allowRemote?: string;
  background?: boolean;
  installer?: boolean;
  yes?: boolean;
  json?: boolean;
};

/** Injection points for tests; the command itself uses the defaults. */
export type EmbedderCliDeps = {
  runtime?: CliRuntime;
  config?: () => OpenClawConfig;
  stateDir?: string;
  isTTY?: boolean;
  signal?: AbortSignal;
  fit?: Partial<EmbedderFitDeps>;
};

/** One line for setup.sh and the first line of status: what memory search does on this machine. */
export function summarizeEmbedderRecord(
  record: EmbedderFitRecord | null,
  changed: readonly string[] = [],
): string {
  if (!record) {
    return "not measured on this machine yet, so word index only (measure it: openclaw embedder fit)";
  }
  if (changed.length > 0) {
    return `word index only: the record was measured on another machine (${changed.join(", ")} changed); re-measure: openclaw embedder fit`;
  }
  const d = record.decision;
  if (d.mode === "off" || !d.model) {
    return `word index only (${d.reasons[0] ?? "no embedding model fits this machine"}); turn on: ${d.proposal?.command ?? "openclaw embedder fit --pull"}`;
  }
  const model = d.provider && d.provider !== "ollama" ? `${d.provider}/${d.model}` : d.model;
  const what =
    d.mode === "memory+sessions" ? "memory files and session transcripts" : "memory files";
  if (!d.dormantUntilDemand) {
    return `${model} for ${what}, armed`;
  }
  return d.demandBreakEvenPerDay === undefined
    ? `${model} for ${what}, dormant: background embedding does not repay itself here (words answer)`
    : `${model} for ${what}, dormant until real searches reach ${fmt(d.demandBreakEvenPerDay)}/day (words answer meanwhile)`;
}

/** Runs the fit for the CLI and returns its exit code: 0 recorded, 1 failed, 75 try later, 130 interrupted. */
export async function runEmbedderFitCommand(
  opts: EmbedderFitCliOptions,
  deps: EmbedderCliDeps = {},
): Promise<number> {
  const runtime = deps.runtime ?? defaultRuntime;
  const background = opts.background === true;
  const terminal = deps.isTTY ?? Boolean(stdin.isTTY && stdout.isTTY);
  const interactive = terminal && !background && opts.json !== true;
  const quiet = opts.installer === true || opts.json === true;
  const allowRemote = opts.allowRemote?.trim();
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error("interrupted"));
  const ownSignal = deps.signal === undefined;
  if (ownSignal) {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
  }
  const signal = deps.signal ?? controller.signal;
  const fitDeps: Partial<EmbedderFitDeps> = { ...deps.fit };
  if (!interactive && fitDeps.confirm === undefined) {
    fitDeps.confirm = async () => false;
  }
  try {
    const record = await runEmbedderFit({
      cfg: (deps.config ?? getRuntimeConfig)(),
      interactive,
      // --yes answers the download question in a terminal; it never answers the remote one.
      allowPull: !background && (opts.pull === true || (interactive && opts.yes === true)),
      askPull: opts.installer !== true,
      ...(allowRemote ? { allowRemote } : {}),
      consentVia: opts.installer === true ? "installer" : "flag",
      background,
      log: {
        info: (message) => {
          if (!quiet) {
            runtime.log(message);
          }
        },
        warn: (message) => {
          if (!quiet) {
            runtime.error(message);
          }
        },
      },
      signal,
      ...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
      command: fitCommandLine(opts),
      deps: fitDeps,
    });
    if (opts.json === true) {
      runtime.writeJson(record);
    } else {
      runtime.log(`memory search: ${summarizeEmbedderRecord(record)}`);
    }
    return 0;
  } catch (err) {
    const busy = err instanceof EmbedderFitBusyError;
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json === true) {
      runtime.writeJson({ ok: false, busy, error: message });
    } else if (opts.installer === true) {
      runtime.error(
        `memory search: the fit did not finish (${message}); word index only for now. Retry: openclaw embedder fit`,
      );
    } else {
      runtime.error(`embedder fit: ${message}`);
    }
    if (signal.aborted) {
      return EXIT_INTERRUPTED;
    }
    return busy ? EXIT_TRY_LATER : 1;
  } finally {
    if (ownSignal) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

export type EmbedderStatus = {
  summary: string;
  recordPath: string;
  measuredAt?: string;
  command?: string;
  /** Fingerprint fields that differ from this machine; empty when the record was measured here. */
  fingerprintChanged: string[];
  mode: FitMode | "not-measured";
  provider?: string;
  model?: string;
  state: "not-measured" | "off" | "dormant" | "armed";
  stateFrom?: "governor" | "fit-record";
  demandBreakEvenPerDay?: number;
  keepUp?: { k: number; burst: number; minIdleShare?: number };
  endpointKey?: string;
  breaker?: EmbedGovernorSnapshot["breaker"];
  demand?: {
    perDay: number;
    agent: number;
    rpc: number;
    probe: number;
    internal: number;
    days: number;
  };
  trials: Record<string, { invocations: number; recoveries: number }>;
  consent: EmbedderConsent["remote"];
  reasons: string[];
  proposal?: { text: string; command: string };
};

/** The record plus the governor's snapshot of the decided endpoint. Files only; no gateway call. */
export function readEmbedderStatus(opts: { stateDir?: string } = {}): EmbedderStatus {
  const stateDir = opts.stateDir ?? resolveStateDir();
  const recordPath = embedderFitPaths(stateDir).record;
  const record = readEmbedderFit(stateDir);
  if (!record) {
    return {
      summary: summarizeEmbedderRecord(null),
      recordPath,
      fingerprintChanged: [],
      mode: "not-measured",
      state: "not-measured",
      trials: {},
      consent: null,
      reasons: [],
    };
  }
  const d = record.decision;
  const changed = fingerprintDiff(record.fingerprint, cheapFingerprint());
  const status: EmbedderStatus = {
    summary: summarizeEmbedderRecord(record, changed),
    recordPath,
    measuredAt: record.createdAt,
    command: record.tool?.command,
    fingerprintChanged: changed,
    mode: d.mode,
    state:
      d.mode === "off" || changed.length > 0 ? "off" : d.dormantUntilDemand ? "dormant" : "armed",
    stateFrom: "fit-record",
    trials: {},
    consent: record.consent?.remote ?? null,
    reasons: d.reasons,
  };
  if (d.provider) {
    status.provider = d.provider;
  }
  if (d.model) {
    status.model = d.model;
  }
  if (d.demandBreakEvenPerDay !== undefined) {
    status.demandBreakEvenPerDay = d.demandBreakEvenPerDay;
  }
  if (d.proposal) {
    status.proposal = d.proposal;
  }
  const keepUp = keepUpOf(d);
  if (keepUp) {
    status.keepUp = keepUp;
  }
  if (!d.provider || d.mode === "off") {
    return status;
  }
  // FORK 2026-10-30: the key the governor writes, from the URL the fit measured the provider at.
  // Built here with a URL for Ollama only, a remote decision's snapshot was never found.
  const endpointKey = fitEndpointKeyFor(record, d.provider);
  status.endpointKey = endpointKey;
  const snapshot = readEmbedGovernorSnapshots(stateDir)[endpointKey];
  if (!snapshot) {
    return status;
  }
  status.breaker = snapshot.breaker;
  status.demand = demandOf(snapshot);
  status.trials = trialsOf(snapshot);
  const model = normalizeEmbeddingModelName(d.model ?? "");
  if (changed.length === 0 && normalizeEmbeddingModelName(snapshot.model ?? "") === model) {
    if (snapshot.dormant === true) {
      status.state = "dormant";
      status.stateFrom = "governor";
    } else if (snapshot.armedModel === model) {
      status.state = "armed";
      status.stateFrom = "governor";
    }
  }
  return status;
}

export function formatEmbedderStatus(s: EmbedderStatus): string[] {
  const lines = [`memory search: ${s.summary}`];
  if (s.mode === "not-measured") {
    lines.push(`  record: ${s.recordPath} (not written yet)`);
    return lines;
  }
  const machine =
    s.fingerprintChanged.length === 0
      ? "this machine"
      : `another machine (${s.fingerprintChanged.join(", ")} changed)`;
  lines.push(
    `  record: ${s.recordPath}, measured ${s.measuredAt ?? "at an unknown time"} on ${machine} by ${s.command ?? "an unknown command"}`,
  );
  const model = s.model ? `${s.provider ?? "ollama"}/${s.model}` : "none (word index only)";
  lines.push(`  mode: ${s.mode}; model: ${model}`);
  const from = s.stateFrom === "governor" ? "the governor's snapshot" : "the fit record";
  lines.push(`  state: ${s.state} (from ${from})`);
  if (s.reasons[0]) {
    lines.push(`  why: ${s.reasons[0]}`);
  }
  const qStar =
    s.demandBreakEvenPerDay !== undefined
      ? `${fmt(s.demandBreakEvenPerDay)}/day`
      : s.mode === "off"
        ? "n/a"
        : "never repays here";
  const demand = s.demand
    ? `${fmt(s.demand.perDay)} real searches/day (agent ${s.demand.agent}, rpc ${s.demand.rpc}; not counted: probe ${s.demand.probe}, internal ${s.demand.internal}; ${s.demand.days} days kept)`
    : "not counted yet (no governor snapshot)";
  lines.push(`  demand: ${demand}; Q* ${qStar}`);
  const idle =
    s.keepUp?.minIdleShare !== undefined
      ? `, needs at least ${fmt(s.keepUp.minIdleShare * 100)}% idle`
      : "";
  lines.push(
    `  keep-up: ${s.keepUp ? `K ${fmt(s.keepUp.k)} at full idle vs burst ${fmt(s.keepUp.burst)}${idle}` : "n/a"}`,
  );
  lines.push(`  breaker: ${s.breaker ? describeBreaker(s.breaker) : "no governor snapshot yet"}`);
  const trials = Object.entries(s.trials).map(
    ([consumer, t]) => `${consumer} ${t.invocations} invocations, ${t.recoveries} recoveries`,
  );
  lines.push(`  trials: ${trials.length > 0 ? trials.join("; ") : "none"}`);
  if (s.consent) {
    lines.push(
      `  remote consent: ${s.consent.provider}, granted ${s.consent.grantedAt} via ${s.consent.via} (withdraw: openclaw embedder fit --allow-remote none)`,
    );
  }
  if (s.proposal) {
    lines.push(`  proposal: ${s.proposal.text} ${s.proposal.command}`);
  }
  return lines;
}

/** Always returns normally (exit 0): setup.sh prints its first line into the install summary. */
export function runEmbedderStatusCommand(
  opts: { json?: boolean },
  deps: EmbedderCliDeps = {},
): void {
  const runtime = deps.runtime ?? defaultRuntime;
  let status: EmbedderStatus;
  try {
    status = readEmbedderStatus(deps.stateDir ? { stateDir: deps.stateDir } : {});
  } catch (err) {
    const summary = `status unreadable (${err instanceof Error ? err.message : String(err)})`;
    if (opts.json === true) {
      runtime.writeJson({ summary });
    } else {
      runtime.log(`memory search: ${summary}`);
    }
    return;
  }
  if (opts.json === true) {
    runtime.writeJson(status);
    return;
  }
  runtime.log(formatEmbedderStatus(status).join("\n"));
}

export function registerEmbedderCli(program: Command) {
  const embedder = program
    .command("embedder")
    .description("Measure this machine and choose its embedding model for memory search, or none");
  embedder
    .command("fit")
    .description(
      "Measure this machine and record which embedding model fits it (word search when none does)",
    )
    .option("--pull", "Download the model the fit asks for (never with --background)", false)
    .option(
      "--allow-remote <provider>",
      "Allow a keyed remote provider (openai, gemini, voyage or mistral): memory text would leave this machine; 'none' withdraws a recorded yes",
    )
    .option("--background", "Lowest priority and idle CPU only; never downloads, never asks", false)
    .option("--installer", "Print one compact line (for setup.sh)", false)
    .option(
      "--yes",
      "In a terminal, answer yes to the download question (never to remote consent)",
      false,
    )
    .option("--json", "Print the written record as JSON", false)
    .action(async (opts: EmbedderFitCliOptions) => {
      const code = await runEmbedderFitCommand(opts);
      if (code !== 0) {
        defaultRuntime.exit(code);
      }
    });
  embedder
    .command("status")
    .description(
      "Show this machine's embedder decision and the governor's state (files only, no gateway call)",
    )
    .option("--json", "Print the status as JSON", false)
    .action((opts: { json?: boolean }) => {
      runEmbedderStatusCommand(opts);
    });
}

function fitCommandLine(opts: EmbedderFitCliOptions): string {
  const flags = [
    opts.pull ? "--pull" : "",
    opts.allowRemote ? `--allow-remote ${opts.allowRemote}` : "",
    opts.background ? "--background" : "",
    opts.installer ? "--installer" : "",
    opts.yes ? "--yes" : "",
    opts.json ? "--json" : "",
  ].filter(Boolean);
  return ["openclaw embedder fit", ...flags].join(" ");
}

function keepUpOf(d: FitDecision): EmbedderStatus["keepUp"] {
  if (d.mode === "off" || !d.model) {
    return undefined;
  }
  const label = d.provider && d.provider !== "ollama" ? `${d.provider}/${d.model}` : d.model;
  const isKeepUp = (v: FitDecision["verdicts"][number]): boolean =>
    v.name === "keep-up" && v.model === label;
  // With sessions the last keep-up verdict is the one that includes their ingest.
  const verdict =
    d.mode === "memory+sessions" ? d.verdicts.findLast(isKeepUp) : d.verdicts.find(isKeepUp);
  if (!verdict) {
    return undefined;
  }
  const minIdle = verdict.inputs?.minIdleShare?.value;
  return typeof minIdle === "number" && Number.isFinite(minIdle)
    ? { k: verdict.value, burst: verdict.breakEven, minIdleShare: minIdle }
    : { k: verdict.value, burst: verdict.breakEven };
}

function demandOf(s: EmbedGovernorSnapshot): NonNullable<EmbedderStatus["demand"]> {
  const days = Array.isArray(s.days) ? s.days : [];
  const out = {
    perDay: count(s.derived?.demandPerDay),
    agent: 0,
    rpc: 0,
    probe: 0,
    internal: 0,
    days: days.length,
  };
  for (const d of days) {
    out.agent += count(d.agent);
    out.rpc += count(d.rpc);
    out.probe += count(d.probe);
    out.internal += count(d.internal);
  }
  return out;
}

function trialsOf(s: EmbedGovernorSnapshot): EmbedderStatus["trials"] {
  const out: EmbedderStatus["trials"] = {};
  for (const [consumer, t] of Object.entries(s.trials ?? {})) {
    if (t && typeof t === "object") {
      out[consumer] = { invocations: count(t.invocations), recoveries: count(t.recoveries) };
    }
  }
  return out;
}

function describeBreaker(b: EmbedGovernorSnapshot["breaker"]): string {
  if (b.state === "closed") {
    return `closed (${count(b.consecutiveFailures)} consecutive failures, ${count(b.cleanCalls)} clean calls)`;
  }
  const since =
    typeof b.openedAt === "number" ? `, since ${new Date(b.openedAt).toISOString()}` : "";
  const cool = typeof b.cooldownMs === "number" ? `, cool-down ${fmt(b.cooldownMs / 1000)} s` : "";
  return `${b.state} (trip ${count(b.consecutiveTrips)}${since}${cool})`;
}

function count(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

/** Declared twin of fit-core's number format, so status reads like the record's reasons. */
function fmt(n: number): string {
  if (Number.isNaN(n)) {
    return "n/a";
  }
  if (!Number.isFinite(n)) {
    return n > 0 ? "inf" : "-inf";
  }
  const abs = Math.abs(n);
  if (abs >= 100) {
    return String(Math.round(n));
  }
  if (abs >= 1) {
    return String(Math.round(n * 10) / 10);
  }
  return String(Number(n.toPrecision(2)));
}
