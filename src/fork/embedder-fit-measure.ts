// FORK 2026-10-29: the measuring half of the per-machine embedder fit
// (TINKER_UI_DESIGN_BIBLE/embedder-fit.md). It runs inside the `openclaw embedder fit` CLI process,
// never on the gateway's thread. The installer (setup.sh step 4d), doctor --fix and the gateway's
// background re-fit all reach this one implementation through that command.
//
// It probes the machine, measures candidate models through POST /api/embed with input arrays, reads
// the memory corpus and the install's own prompt profile, then hands everything to decideEmbedderFit
// and writes the record with writeEmbedderFit (src/fork/embedder-fit.ts). Every gate, break-even and
// working bound belongs to fit-core (#18); this file measures and derives none of them. Its own
// constants are measurement budgets and sample sizes, each with its objective, its source and what
// would move it (#19, #20).
//
// One request in flight at a time, except one deliberate two-in-flight probe: the fit must not
// recreate the fan-out it exists to prevent. It holds <stateDir>/memory/embedder-fit.lock while it
// measures, so the governor keeps background embedding off the endpoint and out of the numbers.
//
// Privacy: every request carries the neutral fixture text at the end of this file and nothing else.
// The transcript pass keeps counts, lengths and timestamps, never prompt text. A remote provider is
// listed by id when a key resolves for it; no key is printed, logged or stored.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
import { hasAnyAuthProfileStoreSource } from "../agents/auth-profiles.js";
import {
  resolveMemorySearchConfig,
  type ResolvedMemorySearchConfig,
} from "../agents/memory-search.js";
import {
  requireApiKey,
  resolveApiKeyForProvider,
  resolveEnvApiKey,
  resolveUsableCustomProviderApiKey,
} from "../agents/model-auth.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { createGeminiEmbeddingProvider } from "../memory/embeddings-gemini.js";
import { createMistralEmbeddingProvider } from "../memory/embeddings-mistral.js";
import {
  createOllamaEmbeddingProvider,
  resolveOllamaEmbeddingBaseUrl,
} from "../memory/embeddings-ollama.js";
import { createOpenAiEmbeddingProvider } from "../memory/embeddings-openai.js";
import { createVoyageEmbeddingProvider } from "../memory/embeddings-voyage.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderOptions,
  EmbedMeasurement,
} from "../memory/embeddings.js";
import { cosineSimilarity, listMemoryFiles } from "../memory/internal.js";
import { importNodeLlamaCpp } from "../memory/node-llama.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "../memory/remote-http.js";
import { extractSessionText } from "../memory/session-files.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateTokensFromChars,
} from "../utils/cjk-chars.js";
import { countToolResults } from "../utils/transcript-tools.js";
import { VERSION } from "../version.js";
import {
  cheapFingerprint,
  classifyEmbeddingEndpoint,
  decideEmbedderFit,
  EMBED_CEILINGS,
  EMBEDDER_LADDER,
  embedderFitPaths,
  fitEndpointKeyFor,
  idleGateOpen,
  ladderEntryFor,
  MISS_COST_PRIOR,
  NON_ENGLISH_SHARE_PRIOR,
  normalizeEmbeddingModelName,
  readEmbedderFit,
  readRawMemorySearchProvider,
  writeEmbedderFit,
  type CandidateMeasurement,
  type CheapFingerprint,
  type CorpusStats,
  type EmbedderConsent,
  type EmbedderFitInput,
  type EmbedderFitRecord,
  type EmbedderInventory,
  type FitDecision,
  type LadderEntry,
  type Measured,
} from "./embedder-fit.js";
import { readEmbedGovernorSnapshots } from "./embedder-governor.js";

const MIB = 2 ** 20;
const DAY_MS = 86_400_000;

// -------------------------------------------------------------------------------------------------
// Budgets and sample sizes (#19: objective, source, break-even, what would move each)
// -------------------------------------------------------------------------------------------------

/**
 * The hard ceiling: 5 minutes of wall time, downloads excluded. Objective: a fit holds the embedder,
 * and pauses background embedding through its lock, for a bounded time. Source: the reference host's
 * estimate of 2-3 minutes for two models at its 2-CPU share. Break-even: below about 2 minutes no
 * step-up model could be measured there. Declared twin: the governor treats a lock younger than 10
 * minutes (twice this) as a fit in progress. Changes with the per-model budget or a longer ladder.
 */
export const FIT_CEILING_MS = 300_000;

/**
 * Throughput repetition stops 90 s after a model's measurement began, settled or not. Objective: a
 * model whose verdicts will not settle cannot take the whole ceiling. Source: 16 batches of about
 * 1,600 tokens take about 76 s at the reference host's 338 tokens/s. Break-even: below about 55
 * tokens/s the 3 required batches no longer fit in it. Changes with the batch size or a slower ladder.
 */
const MODEL_THROUGHPUT_BUDGET_MS = 90_000;

/**
 * GET /api/version and /api/tags wait 1.5 s each. Objective: an absent endpoint costs the probe at
 * most 3 s. Source: a local Ollama answers both in milliseconds. Break-even: a local server slower
 * than this is too busy to be measured now. Changes for an embedder reached over a slow link.
 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * A throughput batch carries 4 passages of about 400 tokens, each one index chunk (chunking.tokens
 * defaults to 400), so a batch has the shape of the index's own work.
 */
const BATCH_PASSAGES = 4;

/**
 * At least 3 batches before the stopping rule may end the repetition. Objective: a 95% band needs a
 * variance (n >= 2), and at n = 2 the t quantile (12.7) leaves the band too wide to settle a verdict
 * near its threshold; n = 3 (t = 4.3) is the smallest sample that can. At most 200: a guard against a
 * clock that does not advance; 90 s holds 200 batches only above about 3,500 tokens/s, where the band
 * settles long before. Changes if per-batch noise proves much larger than on the reference host.
 */
const MIN_THROUGHPUT_BATCHES = 3;
const MAX_THROUGHPUT_BATCHES = 200;

/**
 * Two pairs of batches with 2 requests in flight, and 2 batches at another options.num_thread. Each
 * answers one question (does it beat the default by more than 2 sigma of per-batch throughput?), with
 * sigma from the throughput batches, so two samples keep each probe near 4 batch times. Source: the
 * reference bench's num_thread experiment (+23% over 4 batches). Changes if a kept gain does not hold
 * at runtime: the governor's theta-drift check would show it.
 */
const PARALLEL_PAIRS = 2;
const NUM_THREAD_BATCHES = 2;

/**
 * keep_alive on every measuring request: Ollama's own default, 5 minutes, stated so every request
 * carries it. The cold-load step first sends 0 to unload the model. The runtime keep_alive is the
 * governor's to derive; nothing here moves it.
 */
const MEASURE_KEEP_ALIVE = "5m";

/**
 * After keep_alive 0, /api/ps is polled every 250 ms for up to 10 s. Objective: send the cold-load
 * request only once the model is gone. Source: an idle Ollama unloads within its scheduler tick, well
 * under a second. Break-even: a model still listed after 10 s is held by another client, so the cold
 * load is left unmeasured rather than recorded from a warm request.
 */
const UNLOAD_WAIT_MS = 10_000;
const UNLOAD_POLL_MS = 250;

/**
 * The CPU baseline is 1 s with nothing in flight: /proc/stat's 100 Hz ticks then resolve about a
 * hundredth of a core on 4 cores, for 1 s of a 90 s budget.
 */
const CPU_BASELINE_MS = 1000;

/** Background mode polls the idle gate every 15 s: load1 is a one-minute average, so a faster poll reads the same value. */
const IDLE_POLL_MS = 15_000;

/**
 * The lock is refreshed every minute, so a long download keeps it inside the governor's 10-minute
 * freshness window. A lock nobody refreshed for 10 minutes, or whose process is gone, is stale.
 */
const LOCK_REFRESH_MS = 60_000;
const LOCK_STALE_MS = 600_000;

/**
 * The prompt profile reads the 60 newest transcripts of the default agent, each under 40 MB.
 * Objective: enough model steps and typed prompts for a median and a share, in one bounded pass.
 * Source: on the reference install the 60 newest transcripts held 81 model steps, and its transcripts
 * average under 1 MB, so the cap only skips a runaway file. Changes if few steps per transcript leave
 * the miss cost on its prior.
 */
const TRANSCRIPTS_READ = 60;
const TRANSCRIPT_MAX_BYTES = 40 * MIB;

/**
 * Below 20 model steps the miss cost is MISS_COST_PRIOR, and below 50 typed prompts the language
 * share is NON_ENGLISH_SHARE_PRIOR: fit-core's rules for its two priors (src/fork/embedder-fit.ts). A
 * typed prompt has at least 3 words, the fewest that carry a stopword to vote on its language.
 */
const MIN_MISS_STEPS = 20;
const MIN_TYPED_PROMPTS = 50;
const MIN_PROMPT_WORDS = 3;

/** Ingest and burst come from 14 days of memory-file changes, session ingest from 7 days of messages. */
const INGEST_DAYS = 14;
const SESSION_DAYS = 7;

/** Two-sided 95% Student t quantiles for 1 to 30 degrees of freedom; 1.96 beyond. */
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];

// -------------------------------------------------------------------------------------------------
// Remote providers
// -------------------------------------------------------------------------------------------------

/**
 * The keyed remote providers core can embed with, in the order upstream 'auto' tried them, and the
 * auth provider each client resolves its key from. Declared twin of REMOTE_EMBEDDING_PROVIDER_IDS in
 * src/memory/embeddings.ts and of the clients' own auth ids (the gemini client resolves 'google').
 */
const REMOTE_PROVIDERS = [
  { id: "openai", authProvider: "openai" },
  { id: "gemini", authProvider: "google" },
  { id: "voyage", authProvider: "voyage" },
  { id: "mistral", authProvider: "mistral" },
] as const;

export type RemoteEmbeddingProviderId = (typeof REMOTE_PROVIDERS)[number]["id"];

/**
 * The ungoverned clients: a governed one in this process would write the governor's snapshot file.
 * Each returns its client too, whose base URL is where the fit measures (FORK 2026-10-30).
 */
const REMOTE_FACTORIES: Record<
  RemoteEmbeddingProviderId,
  (
    options: EmbeddingProviderOptions,
  ) => Promise<{ provider: EmbeddingProvider; client: { baseUrl: string } }>
> = {
  openai: createOpenAiEmbeddingProvider,
  gemini: createGeminiEmbeddingProvider,
  voyage: createVoyageEmbeddingProvider,
  mistral: createMistralEmbeddingProvider,
};

/**
 * List prices the consent question quotes, in US dollars per 1M input tokens: third-party figures
 * recorded in 2025 from the providers' pricing pages and never verified here. The question says so
 * and asks the owner to check them; a model missing here gets the token volume and no price.
 */
const REMOTE_LIST_PRICES_PER_MTOK: Readonly<Record<string, number | undefined>> = {
  "openai/text-embedding-3-small": 0.02,
  "gemini/gemini-embedding-001": 0.15,
  "mistral/mistral-embed": 0.1,
};

// -------------------------------------------------------------------------------------------------
// Public types
// -------------------------------------------------------------------------------------------------

export type FitLog = { info: (message: string) => void; warn: (message: string) => void };

/** What the fit reads from the machine and asks the owner; every field is injectable for tests. */
export type EmbedderFitDeps = {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  loadavg: () => number[];
  memAvailableBytes: () => number;
  totalMemBytes: () => number;
  /** Cumulative host CPU time, busy and total, in one unit; undefined where it cannot be read. */
  cpuTimes: () => CpuTimes | undefined;
  /** /proc/pressure/cpu 'some avg10' in percent; undefined where PSI is absent. */
  readPsi: () => number | undefined;
  hasNodeLlamaCpp: () => Promise<boolean>;
  /** Whether a key resolves for the provider. The key itself never leaves this check. */
  hasRemoteKey: (
    providerId: RemoteEmbeddingProviderId,
    cfg: OpenClawConfig,
    agentDir: string,
  ) => Promise<boolean>;
  lowerPriority: () => void;
  /** One yes/no question to the owner; the default asks on the terminal and defaults to no. */
  confirm: (question: string) => Promise<boolean>;
};

export type CpuTimes = { busy: number; total: number };

export type MachineProbe = { fingerprint: CheapFingerprint; inventory: EmbedderInventory };

/** The fit's clock: the 5-minute ceiling, moved out by the time spent downloading. */
export type FitClock = {
  readonly startedAt: number;
  downloadMs: number;
  now: () => number;
  remainingMs: () => number;
  /** Throws once the ceiling has passed. */
  check: () => void;
};

/** What measuring a model observed beyond its CandidateMeasurement. */
export type CandidateObservations = {
  downloadMs: number;
  pulled: string[];
  /** The fixture's characters and the first measured model's own token count of them. */
  charsPerToken?: { chars: number; tokens: number; model: string };
  /** CPU pressure 'some avg10' before each local model's requests and after each of its batches. */
  pressure: { before: number[]; during: number[] };
};

export type MeasureCandidateOptions = {
  baseUrl: string;
  /** Pull the model with POST /api/pull first when /api/tags does not list it. */
  allowPull: boolean;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  /** Config and memorySearch.remote for the request headers and key; the base URL above wins. */
  cfg?: OpenClawConfig;
  remote?: EmbeddingProviderOptions["remote"];
  /**
   * The decision's other inputs, so the batches stop as soon as no verdict differs between theta's
   * 95% bounds. Without them the batches run to the per-model budget.
   */
  decideInput?: () => EmbedderFitInput;
  fingerprint?: CheapFingerprint;
  observed?: CandidateObservations;
  clock?: FitClock;
  deps?: Partial<EmbedderFitDeps>;
};

export type PromptProfile = {
  missCostSec: Measured;
  nonEnglishShare: Measured;
  transcriptsRead: number;
  /**
   * User and assistant text characters with timestamps in the last 7 days: the session ingest. Only
   * when it was asked for and the pass read every transcript that changed in that window.
   */
  sessionChars7d?: number;
};

export type RunEmbedderFitOptions = {
  cfg: OpenClawConfig;
  /** May ask the owner: before a download (unless allowPull, or askPull is false) and for consent. */
  interactive: boolean;
  /** Downloads are agreed already (--pull). */
  allowPull: boolean;
  /** Ask before a download when interactive; false when the installer asked already. */
  askPull?: boolean;
  /** A remote provider the owner allowed (--allow-remote <provider>); 'none' withdraws a recorded yes. */
  allowRemote?: string;
  consentVia?: "installer" | "doctor" | "flag";
  /** Lowest CPU and IO priority, idle-gated before each model; never downloads, never asks. */
  background: boolean;
  log?: FitLog | ((line: string) => void);
  signal?: AbortSignal;
  stateDir?: string;
  /** The command line recorded in the record's tool field. */
  command?: string;
  deps?: Partial<EmbedderFitDeps>;
};

/** Another fit holds the lock, or a background fit found no idle CPU: try again later. */
export class EmbedderFitBusyError extends Error {
  readonly code = "EMBEDDER_FIT_BUSY";

  constructor(message: string) {
    super(message);
    this.name = "EmbedderFitBusyError";
  }
}

/** The 5-minute ceiling passed; what was measured before it is kept. */
class FitCeilingError extends Error {
  constructor() {
    super("the fit reached its ceiling");
    this.name = "FitCeilingError";
  }
}

// -------------------------------------------------------------------------------------------------
// The machine
// -------------------------------------------------------------------------------------------------

function defaultDeps(): EmbedderFitDeps {
  return {
    now: () => Date.now(),
    sleep: sleepFor,
    loadavg: () => os.loadavg(),
    memAvailableBytes: () => os.freemem(),
    totalMemBytes: () => os.totalmem(),
    cpuTimes: readCpuTimes,
    readPsi: readCpuPressure,
    hasNodeLlamaCpp: async () => {
      try {
        await importNodeLlamaCpp();
        return true;
      } catch {
        return false;
      }
    },
    hasRemoteKey: hasRemoteKeyFor,
    lowerPriority: lowerOwnPriority,
    confirm: askOnTerminal,
  };
}

function resolveDeps(over: Partial<EmbedderFitDeps> | undefined): EmbedderFitDeps {
  return { ...defaultDeps(), ...over };
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal ? abortReason(signal) : new Error("aborted"));
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** /proc/stat's first line on Linux (user nice system idle iowait irq softirq steal), else os.cpus(). */
function readCpuTimes(): CpuTimes | undefined {
  if (process.platform === "linux") {
    try {
      const line = fs.readFileSync("/proc/stat", "utf8").split("\n", 1)[0] ?? "";
      const f = line.trim().split(/\s+/).slice(1).map(Number);
      if (f.length >= 8 && f.every((x) => Number.isFinite(x))) {
        const busy = f[0] + f[1] + f[2] + f[5] + f[6] + f[7];
        return { busy, total: busy + f[3] + f[4] };
      }
    } catch {
      // fall back to os.cpus below
    }
  }
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return total > 0 ? { busy, total } : undefined;
}

/** 'some avg10' of /proc/pressure/cpu: the share of the last 10 s some task waited for a CPU. */
function readCpuPressure(): number | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const match = /^some\b.*?\bavg10=([\d.]+)/m.exec(fs.readFileSync("/proc/pressure/cpu", "utf8"));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The resolution the provider clients use (src/memory/embeddings-remote-client.ts): environment,
 * configured key, then auth profiles, the last only when a profile store exists (as doctor checks,
 * so the probe creates no store). The key is checked for presence and dropped.
 */
async function hasRemoteKeyFor(
  providerId: RemoteEmbeddingProviderId,
  cfg: OpenClawConfig,
  agentDir: string,
): Promise<boolean> {
  const authProvider =
    REMOTE_PROVIDERS.find((p) => p.id === providerId)?.authProvider ?? providerId;
  if (
    resolveEnvApiKey(authProvider) ||
    resolveUsableCustomProviderApiKey({ cfg, provider: authProvider })
  ) {
    return true;
  }
  if (!hasAnyAuthProfileStoreSource(agentDir)) {
    return false;
  }
  try {
    requireApiKey(
      await resolveApiKeyForProvider({ provider: authProvider, cfg, agentDir }),
      authProvider,
    );
    return true;
  } catch {
    return false;
  }
}

/** nice 19 for this process, and IO class idle on Linux when ionice exists. */
function lowerOwnPriority(): void {
  try {
    os.setPriority(19);
  } catch {
    // not permitted here: the inherited priority stays
  }
  if (process.platform === "linux") {
    // A missing ionice binary, or a refusal, is not an error for the fit.
    execFile("ionice", ["-c", "3", "-p", String(process.pid)], () => undefined);
  }
}

async function askOnTerminal(question: string): Promise<boolean> {
  if (!stdin.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function createFitClock(now: () => number): FitClock {
  const startedAt = now();
  const clock: FitClock = {
    startedAt,
    downloadMs: 0,
    now,
    remainingMs: () => startedAt + FIT_CEILING_MS + clock.downloadMs - now(),
    check: () => {
      if (clock.remainingMs() <= 0) {
        throw new FitCeilingError();
      }
    },
  };
  return clock;
}

function newObservations(): CandidateObservations {
  return { downloadMs: 0, pulled: [], pressure: { before: [], during: [] } };
}

// -------------------------------------------------------------------------------------------------
// The probe
// -------------------------------------------------------------------------------------------------

type OllamaClient = { baseUrl: string; headers: Record<string, string>; ssrfPolicy?: SsrFPolicy };

/**
 * memorySearch.remote configures whichever provider memory search uses, so it points at Ollama only
 * when the provider is 'auto' (the fit's choice) or pinned to 'ollama'.
 */
function ollamaRemote(
  ms: ResolvedMemorySearchConfig | null,
  rawProvider: string,
): EmbeddingProviderOptions["remote"] {
  return (rawProvider === "auto" || rawProvider === "ollama") && ms?.remote ? ms.remote : undefined;
}

async function resolveOllamaClient(
  cfg: OpenClawConfig,
  remote: EmbeddingProviderOptions["remote"],
): Promise<OllamaClient> {
  const baseUrl = trimSlash(resolveOllamaEmbeddingBaseUrl({ config: cfg, remote }));
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    // The provider's own client: the headers and key the index itself will send.
    const { client } = await createOllamaEmbeddingProvider({
      config: cfg,
      provider: "ollama",
      model: "",
      fallback: "none",
      ...(remote ? { remote } : {}),
    });
    headers = client.headers;
  } catch {
    // An unresolved key reference: probe without it; the provider reports the reference itself.
  }
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}

async function ollamaJson(
  client: OllamaClient,
  route: string,
  p: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number; signal?: AbortSignal },
): Promise<unknown> {
  return await withRemoteHttpResponse({
    url: `${client.baseUrl}${route}`,
    ssrfPolicy: client.ssrfPolicy,
    auditContext: "embedder-fit",
    ...(p.signal ? { signal: p.signal } : {}),
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
    init: {
      method: p.method,
      headers: client.headers,
      ...(p.body !== undefined ? { body: JSON.stringify(p.body) } : {}),
    },
    onResponse: async (res) => {
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Ollama ${route} answered HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const parsed: unknown = text ? JSON.parse(text) : {};
      return parsed;
    },
  });
}

function modelsOf(body: unknown): Array<{ name: string; digest: string }> {
  const models: unknown[] = isRecord(body) && Array.isArray(body.models) ? body.models : [];
  const out: Array<{ name: string; digest: string }> = [];
  for (const raw of models) {
    if (!isRecord(raw)) {
      continue;
    }
    const name =
      typeof raw.name === "string" ? raw.name : typeof raw.model === "string" ? raw.model : "";
    if (name) {
      out.push({ name, digest: typeof raw.digest === "string" ? raw.digest : "" });
    }
  }
  return out;
}

async function probeOllama(
  client: OllamaClient,
  signal: AbortSignal | undefined,
): Promise<EmbedderInventory["ollama"]> {
  const ollama: EmbedderInventory["ollama"] = {
    baseUrl: client.baseUrl,
    reachable: false,
    models: [],
  };
  try {
    const body = await ollamaJson(client, "/api/version", {
      method: "GET",
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    });
    if (isRecord(body) && typeof body.version === "string") {
      ollama.version = body.version;
    }
  } catch {
    // the tags call below decides whether the endpoint is reachable
  }
  try {
    const body = await ollamaJson(client, "/api/tags", {
      method: "GET",
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    });
    ollama.models = modelsOf(body);
    ollama.reachable = true;
  } catch {
    ollama.reachable = false;
  }
  signal?.throwIfAborted();
  return ollama;
}

type ProbeContext = {
  agentId: string;
  ms: ResolvedMemorySearchConfig | null;
  rawProvider: string;
  deps: EmbedderFitDeps;
  signal?: AbortSignal;
};

async function probeWithClient(
  cfg: OpenClawConfig,
  ctx: ProbeContext,
): Promise<{ probe: MachineProbe; client: OllamaClient }> {
  const client = await resolveOllamaClient(cfg, ollamaRemote(ctx.ms, ctx.rawProvider));
  const ollama = await probeOllama(client, ctx.signal);
  const agentDir = resolveAgentDir(cfg, ctx.agentId);
  const remoteKeys: string[] = [];
  for (const provider of REMOTE_PROVIDERS) {
    if (await ctx.deps.hasRemoteKey(provider.id, cfg, agentDir)) {
      remoteKeys.push(provider.id);
    }
  }
  const nodeLlamaCpp = await ctx.deps.hasNodeLlamaCpp();
  return {
    client,
    probe: { fingerprint: cheapFingerprint(), inventory: { ollama, nodeLlamaCpp, remoteKeys } },
  };
}

/**
 * The machine: its cheap fingerprint plus what can embed here. Ollama is asked for /api/version and
 * /api/tags (1.5 s each) at the base URL the provider would use, resolveOllamaEmbeddingBaseUrl over
 * memorySearch.remote; node-llama-cpp is looked for through a guarded import (informational: no GGUF
 * model is on the ladder yet); remote providers are listed by id when a key resolves for them.
 */
export async function probeMachine(
  cfg: OpenClawConfig,
  opts: { agentId?: string; signal?: AbortSignal; deps?: Partial<EmbedderFitDeps> } = {},
): Promise<MachineProbe> {
  const agentId = opts.agentId ?? resolveDefaultAgentId(cfg);
  let ms: ResolvedMemorySearchConfig | null = null;
  try {
    ms = resolveMemorySearchConfig(cfg, agentId);
  } catch {
    ms = null;
  }
  const { probe } = await probeWithClient(cfg, {
    agentId,
    ms,
    rawProvider: readRawMemorySearchProvider(cfg, agentId),
    deps: resolveDeps(opts.deps),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return probe;
}

// -------------------------------------------------------------------------------------------------
// Measuring one model
// -------------------------------------------------------------------------------------------------

type EmbedSample = {
  vectors: number[][];
  wallMs: number;
  chars: number;
  /** Ollama's prompt_eval_count when it reports one, else estimateTokensFromChars. */
  tokens: number;
  counted: boolean;
  /** Ollama's total_duration minus load_duration when reported, else the wall time. */
  serviceMs: number;
  loadMs?: number;
};

type Embed = (
  texts: string[],
  o?: { keepAlive?: string; numThread?: number },
) => Promise<EmbedSample>;

type MeasureContext = {
  provider: EmbeddingProvider;
  providerId: string;
  model: string;
  /** Ollama only: /api/ps, the cold load and, on a local endpoint, the in-flight and thread probes. */
  ollama?: { client: OllamaClient; fingerprint: CheapFingerprint; local: boolean };
  /** The longest one request may take: the batch-deadline ceiling, or the remote prior. */
  requestCeilingMs: number;
  clock: FitClock;
  deps: EmbedderFitDeps;
  signal?: AbortSignal;
  progress: (line: string) => void;
  decideInput?: () => EmbedderFitInput;
  observed: CandidateObservations;
};

type MeasureBase = {
  providerId: string;
  model: string;
  coldLoadMs: number | undefined;
  queryMs: number[];
  overheadMs: number;
  sanityOk: boolean;
};

type CandidateExtras = {
  rssBytes?: number;
  embedCores?: number;
  parallelGain?: { delta: number; sigma: number };
  numThread?: number;
  /** Throughput at numThread over the default threads, as the thread probe measured it. */
  threadGain?: number;
};

/**
 * Measure one ladder model on an Ollama endpoint. Every request is POST /api/embed with an input
 * array, truncate true and an explicit keep_alive, through the same provider client the index uses:
 * - a download through POST /api/pull first, only when allowPull and /api/tags lacks the model;
 * - cold load: the first request after a keep_alive 0 has unloaded the model;
 * - 16 sequential short queries: p50 and p95;
 * - 3 paraphrase / unrelated triples: the sanity check;
 * - one 1-token request: the per-request overhead;
 * - batches of 4 fixture passages of about 400 tokens, repeated until no decideEmbedderFit verdict
 *   differs between theta's low and high 95% bounds, or 90 s: throughput, its band and dispersion,
 *   with host CPU busy during them minus an idle baseline (embedCores) and CPU pressure (contention);
 * - /api/ps: the resident size, and whether the model sits on a GPU;
 * - on a local endpoint, 2 pairs with 2 requests in flight (the only overlap the fit makes), and on
 *   a CPU-only one 2 batches at another options.num_thread, kept only when faster beyond 2 sigma.
 */
export async function measureCandidate(
  entry: LadderEntry,
  opts: MeasureCandidateOptions,
): Promise<CandidateMeasurement> {
  const deps = resolveDeps(opts.deps);
  const clock = opts.clock ?? createFitClock(deps.now);
  const observed = opts.observed ?? newObservations();
  const progress = opts.onProgress ?? (() => undefined);
  const { provider, client } = await createOllamaEmbeddingProvider({
    config: opts.cfg ?? ({} as OpenClawConfig),
    provider: "ollama",
    model: entry.model,
    fallback: "none",
    remote: { ...opts.remote, baseUrl: opts.baseUrl },
  });
  const baseUrl = trimSlash(client.baseUrl);
  const endpoint: OllamaClient = {
    baseUrl,
    headers: client.headers,
    ssrfPolicy: client.ssrfPolicy,
  };
  if (opts.allowPull && !(await isInstalled(endpoint, entry.model, opts.signal))) {
    progress(`${entry.model}: downloading (${entry.sizeMB} MB; the ceiling does not count it)`);
    const started = deps.now();
    try {
      await pullModel(endpoint, entry.model, opts.signal, progress);
    } finally {
      const spent = Math.max(0, deps.now() - started);
      clock.downloadMs += spent;
      observed.downloadMs += spent;
    }
    observed.pulled.push(entry.model);
  }
  return await measureWith({
    provider,
    providerId: "ollama",
    model: entry.model,
    ollama: {
      client: endpoint,
      fingerprint: opts.fingerprint ?? cheapFingerprint(),
      local: classifyEmbeddingEndpoint({ providerId: "ollama", baseUrl }) !== "remote",
    },
    requestCeilingMs: EMBED_CEILINGS.batchDeadlineMs,
    clock,
    deps,
    ...(opts.signal ? { signal: opts.signal } : {}),
    progress,
    ...(opts.decideInput ? { decideInput: opts.decideInput } : {}),
    observed,
  });
}

async function measureWith(ctx: MeasureContext): Promise<CandidateMeasurement> {
  const { clock, deps, observed, ollama } = ctx;
  const label = ctx.providerId === "ollama" ? ctx.model : `${ctx.providerId}/${ctx.model}`;
  const local = ollama?.local === true;
  const startedAt = deps.now();
  const embed: Embed = async (texts, o = {}) => {
    clock.check();
    ctx.signal?.throwIfAborted();
    return await embedOnce(ctx.provider, texts, {
      ...(ollama ? { keepAlive: o.keepAlive ?? MEASURE_KEEP_ALIVE } : {}),
      ...(o.numThread !== undefined ? { numThread: o.numThread } : {}),
      timeoutMs: Math.min(ctx.requestCeilingMs, clock.remainingMs()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  };
  if (local) {
    pushDefined(observed.pressure.before, deps.readPsi());
  }

  let coldLoadMs: number | undefined;
  if (ollama) {
    ctx.progress(`${label}: cold load (unload, then one request)`);
    await embed([FIXTURE_WARMUP], { keepAlive: "0" });
    const unloaded = await waitUntilUnloaded(ollama.client, ctx.model, deps, ctx.signal);
    const cold = await embed([FIXTURE_COLD]);
    // A first request that loaded nothing (another client kept the model) is no cold load.
    if (unloaded && (cold.loadMs === undefined || cold.loadMs > 0)) {
      coldLoadMs = round1(cold.wallMs);
    }
  }

  ctx.progress(`${label}: ${FIXTURE_QUERIES.length} sequential queries`);
  const queryMs: number[] = [];
  for (const query of FIXTURE_QUERIES) {
    queryMs.push((await embed([query])).wallMs);
  }
  const sanityOk = sanityHolds((await embed([...SANITY_TEXTS])).vectors);
  const overheadMs = (await embed([FIXTURE_ONE_TOKEN])).wallMs;
  const base: MeasureBase = {
    providerId: ctx.providerId,
    model: ctx.model,
    coldLoadMs,
    queryMs,
    overheadMs,
    sanityOk,
  };

  ctx.progress(`${label}: throughput in batches of ${BATCH_PASSAGES} passages`);
  const cores = ollama?.fingerprint.logicalCores ?? 1;
  const baselineCores = local ? await busyCoresOver(deps, cores, ctx.signal) : undefined;
  const cpuStart = local ? deps.cpuTimes() : undefined;
  const batches: EmbedSample[] = [];
  let round = 0;
  for (;;) {
    if (batches.length >= MIN_THROUGHPUT_BATCHES) {
      const spent = deps.now() - startedAt >= MODEL_THROUGHPUT_BUDGET_MS;
      if (spent || batches.length >= MAX_THROUGHPUT_BATCHES || clock.remainingMs() <= 0) {
        break;
      }
      if (
        ctx.decideInput &&
        verdictsSettled(ctx.decideInput(), assembleCandidate(base, batches, {}))
      ) {
        break;
      }
    }
    batches.push(await embed(fixtureBatch(round)));
    round += 1;
    if (local) {
      pushDefined(observed.pressure.during, deps.readPsi());
    }
  }
  const extras: CandidateExtras = {};
  const duringCores = local ? busyCores(cpuStart, deps.cpuTimes(), cores) : undefined;
  if (baselineCores !== undefined && duringCores !== undefined) {
    extras.embedCores = round2(Math.max(0, duringCores - baselineCores));
  }
  if (!observed.charsPerToken && batches.every((b) => b.counted)) {
    observed.charsPerToken = {
      chars: sum(batches.map((b) => b.chars)),
      tokens: sum(batches.map((b) => b.tokens)),
      model: label,
    };
  }
  if (ollama) {
    try {
      await measureEndpointExtras(ctx, ollama, { batches, embed, round }, extras);
    } catch (err) {
      if (!(err instanceof FitCeilingError)) {
        throw err;
      }
      ctx.progress(`${label}: the ceiling is near, so the remaining endpoint probes are skipped`);
    }
  }
  return assembleCandidate(base, batches, extras);
}

/** /api/ps, then on a local endpoint the two-in-flight probe and, CPU-only, the thread probe. */
async function measureEndpointExtras(
  ctx: MeasureContext,
  ollama: NonNullable<MeasureContext["ollama"]>,
  p: { batches: EmbedSample[]; embed: Embed; round: number },
  extras: CandidateExtras,
): Promise<void> {
  const ps = await psEntry(ollama.client, ctx.model, ctx.signal);
  if (ps?.size !== undefined) {
    extras.rssBytes = Math.max(0, ps.size - (ps.sizeVram ?? 0));
  }
  if (!ollama.local) {
    return;
  }
  const batchWallMs = mean(p.batches.map((b) => b.wallMs));
  let round = p.round;
  if (ctx.clock.remainingMs() > PARALLEL_PAIRS * 2 * batchWallMs) {
    ctx.progress(`${ctx.model}: ${PARALLEL_PAIRS} pairs of batches with 2 requests in flight`);
    const single = p.batches.map((b) => b.tokens / (b.wallMs / 1000));
    const paired: number[] = [];
    for (let i = 0; i < PARALLEL_PAIRS; i += 1) {
      const started = performance.now();
      const [a, b] = await Promise.all([
        p.embed(fixtureBatch(round)),
        p.embed(fixtureBatch(round + 1)),
      ]);
      round += 2;
      paired.push((a.tokens + b.tokens) / ((performance.now() - started) / 1000));
    }
    extras.parallelGain = {
      delta: round1(mean(paired) - mean(single)),
      sigma: round1(sampleSd(single)),
    };
  }
  // GPU offload shows as size_vram > 0 in /api/ps and is never assumed; without that field the
  // host's own device nodes decide.
  const cpuOnly =
    ps?.sizeVram !== undefined ? ps.sizeVram === 0 : !hasAccelerator(ollama.fingerprint);
  if (cpuOnly && ctx.clock.remainingMs() > NUM_THREAD_BATCHES * 2 * batchWallMs) {
    const threads = threadsToTry(ollama.fingerprint, extras.embedCores);
    ctx.progress(`${ctx.model}: ${NUM_THREAD_BATCHES} batches with options.num_thread ${threads}`);
    const defaults = p.batches.map(serviceTheta);
    const tried: number[] = [];
    for (let i = 0; i < NUM_THREAD_BATCHES; i += 1) {
      tried.push(serviceTheta(await p.embed(fixtureBatch(round), { numThread: threads })));
      round += 1;
    }
    // Kept only when faster beyond 2 sigma of the default batches' throughput.
    if (mean(tried) - mean(defaults) > 2 * sampleSd(defaults)) {
      extras.numThread = threads;
      extras.threadGain = mean(tried) / mean(defaults);
    }
  }
}

function assembleCandidate(
  base: MeasureBase,
  batches: EmbedSample[],
  extras: CandidateExtras,
): CandidateMeasurement {
  const scale =
    extras.numThread !== undefined && extras.threadGain !== undefined ? extras.threadGain : 1;
  const band = thetaBand(batches.map(serviceTheta));
  const services = batches.map((b) => b.serviceMs);
  const p50 = quantile(services, 0.5);
  const counted = batches.length > 0 && batches.every((b) => b.counted);
  const timing = counted
    ? "tokens from the server's prompt_eval_count, time from its total_duration minus load_duration"
    : "tokens estimated from characters, wall time";
  const threads =
    scale === 1
      ? ""
      : `; scaled x${fmt(scale)} for options.num_thread ${extras.numThread}, the gain its ${NUM_THREAD_BATCHES} batches measured`;
  const candidate: CandidateMeasurement = {
    provider: base.providerId,
    model: base.model,
    queryP50Ms: round1(quantile(base.queryMs, 0.5)),
    queryP95Ms: round1(quantile(base.queryMs, 0.95)),
    tokensPerSec: {
      value: round1(band.value * scale),
      unit: "tokens/s",
      n: batches.length,
      provenance: "local-measured",
      source: `fit on this machine: mean of ${batches.length} batches of ${BATCH_PASSAGES} fixture passages (${timing}) with a Student t 95% band${threads}; query p50 and p95 over ${base.queryMs.length} sequential queries`,
    },
    tokensPerSecLow95: round1(band.low * scale),
    tokensPerSecHigh95: round1(band.high * scale),
    batchDispersion: p50 > 0 ? round3(quantile(services, 0.95) / p50) : 1,
    overheadMs: round1(base.overheadMs),
    sanityOk: base.sanityOk,
  };
  if (base.coldLoadMs !== undefined) {
    candidate.coldLoadMs = base.coldLoadMs;
  }
  if (extras.rssBytes !== undefined) {
    candidate.rssBytes = extras.rssBytes;
  }
  if (extras.embedCores !== undefined) {
    candidate.embedCores = extras.embedCores;
  }
  if (extras.parallelGain !== undefined) {
    candidate.parallelGain = extras.parallelGain;
  }
  if (extras.numThread !== undefined) {
    candidate.numThread = extras.numThread;
  }
  return candidate;
}

/** The stopping rule: every verdict and the decision itself agree at theta's low and high bound. */
function verdictsSettled(input: EmbedderFitInput, partial: CandidateMeasurement): boolean {
  const at = (theta: number): string => {
    const candidate = { ...partial, tokensPerSec: { ...partial.tokensPerSec, value: theta } };
    return decisionSignature(
      decideEmbedderFit({ ...input, candidates: [...input.candidates, candidate] }),
    );
  };
  return at(partial.tokensPerSecLow95) === at(partial.tokensPerSecHigh95);
}

function decisionSignature(d: FitDecision): string {
  return JSON.stringify([
    d.mode,
    d.provider ?? "",
    d.model ?? "",
    d.dormantUntilDemand,
    d.verdicts.map((v) => `${v.name}|${v.model ?? ""}|${v.pass}`),
  ]);
}

async function embedOnce(
  provider: EmbeddingProvider,
  texts: string[],
  o: { keepAlive?: string; numThread?: number; timeoutMs: number; signal?: AbortSignal },
): Promise<EmbedSample> {
  const seen: { m?: EmbedMeasurement } = {};
  const timeout = AbortSignal.timeout(Math.max(1, Math.round(o.timeoutMs)));
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const started = performance.now();
  // Raced as well as passed on: a provider that ignores the signal is still left at the deadline.
  const vectors = await raceSignal(
    provider.embedBatch(texts, {
      signal,
      ...(o.keepAlive ? { keepAlive: o.keepAlive } : {}),
      ...(o.numThread !== undefined ? { numThread: o.numThread } : {}),
      onMeasure: (m) => {
        seen.m = m;
      },
    }),
    signal,
  );
  const wallMs = performance.now() - started;
  const m = seen.m;
  const chars = texts.reduce((n, text) => n + estimateStringChars(text), 0);
  const evalCount = m?.promptEvalCount;
  const total = m?.totalDurationNs;
  const load = m?.loadDurationNs;
  const sample: EmbedSample = {
    vectors,
    wallMs,
    chars,
    tokens: evalCount !== undefined && evalCount > 0 ? evalCount : estimateTokensFromChars(chars),
    counted: evalCount !== undefined && evalCount > 0,
    serviceMs:
      total !== undefined && total > 0 ? Math.max(0.001, (total - (load ?? 0)) / 1e6) : wallMs,
  };
  if (load !== undefined) {
    sample.loadMs = load / 1e6;
  }
  return sample;
}

async function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  const holder: { onAbort?: () => void } = {};
  const stop = new Promise<never>((_, reject) => {
    holder.onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", holder.onAbort, { once: true });
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, stop]);
  } finally {
    if (holder.onAbort) {
      signal.removeEventListener("abort", holder.onAbort);
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("the request was aborted");
}

async function isInstalled(
  client: OllamaClient,
  model: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const body = await ollamaJson(client, "/api/tags", {
    method: "GET",
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
  });
  return modelsOf(body).some((m) => sameModel(m.name, model));
}

async function pullModel(
  client: OllamaClient,
  model: string,
  signal: AbortSignal | undefined,
  progress: (line: string) => void,
): Promise<void> {
  await withRemoteHttpResponse({
    url: `${client.baseUrl}/api/pull`,
    ssrfPolicy: client.ssrfPolicy,
    auditContext: "embedder-fit",
    ...(signal ? { signal } : {}),
    init: {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ model, stream: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        throw new Error(
          `Ollama /api/pull answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      // The streamed form keeps bytes flowing through a long download, so no idle timeout fires.
      let status = "";
      let shown = -10;
      let pending = "";
      const take = (line: string): void => {
        const event = parseJson(line);
        if (!isRecord(event)) {
          return;
        }
        if (typeof event.error === "string") {
          throw new Error(`Ollama /api/pull: ${event.error}`);
        }
        if (typeof event.status === "string") {
          status = event.status;
        }
        if (isCount(event.total) && isCount(event.completed) && event.total > 0) {
          const percent = Math.floor((100 * event.completed) / event.total);
          if (percent >= shown + 10) {
            shown = percent;
            progress(`${model}: ${status} ${percent}%`);
          }
        }
      };
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            take(line);
          }
        }
      }
      take(pending + decoder.decode());
      if (status !== "success") {
        throw new Error(
          `Ollama /api/pull ended without success (last status: ${status || "none"})`,
        );
      }
    },
  });
}

type PsEntry = { size?: number; sizeVram?: number };

async function psEntry(
  client: OllamaClient,
  model: string,
  signal: AbortSignal | undefined,
): Promise<PsEntry | undefined> {
  const body = await ollamaJson(client, "/api/ps", {
    method: "GET",
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
  });
  const want = normalizeEmbeddingModelName(model);
  const models: unknown[] = isRecord(body) && Array.isArray(body.models) ? body.models : [];
  for (const raw of models) {
    if (!isRecord(raw)) {
      continue;
    }
    const name =
      typeof raw.name === "string" ? raw.name : typeof raw.model === "string" ? raw.model : "";
    if (normalizeEmbeddingModelName(name) !== want) {
      continue;
    }
    const entry: PsEntry = {};
    if (isCount(raw.size)) {
      entry.size = raw.size;
    }
    if (isCount(raw.size_vram)) {
      entry.sizeVram = raw.size_vram;
    }
    return entry;
  }
  return undefined;
}

async function waitUntilUnloaded(
  client: OllamaClient,
  model: string,
  deps: EmbedderFitDeps,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  for (let poll = 0; poll * UNLOAD_POLL_MS <= UNLOAD_WAIT_MS; poll += 1) {
    let entry: PsEntry | undefined;
    try {
      entry = await psEntry(client, model, signal);
    } catch {
      return false;
    }
    if (!entry) {
      return true;
    }
    await deps.sleep(UNLOAD_POLL_MS, signal);
  }
  return false;
}

async function busyCoresOver(
  deps: EmbedderFitDeps,
  cores: number,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const start = deps.cpuTimes();
  await deps.sleep(CPU_BASELINE_MS, signal);
  return busyCores(start, deps.cpuTimes(), cores);
}

function busyCores(
  a: CpuTimes | undefined,
  b: CpuTimes | undefined,
  cores: number,
): number | undefined {
  if (!a || !b) {
    return undefined;
  }
  const total = b.total - a.total;
  return total > 0 ? ((b.busy - a.busy) / total) * cores : undefined;
}

function thetaBand(thetas: readonly number[]): { value: number; low: number; high: number } {
  const value = mean(thetas);
  if (thetas.length < 2) {
    return { value, low: value, high: value };
  }
  const half = (t95(thetas.length - 1) * sampleSd(thetas)) / Math.sqrt(thetas.length);
  return { value, low: Math.max(0, value - half), high: value + half };
}

function serviceTheta(b: EmbedSample): number {
  return b.tokens / (b.serviceMs / 1000);
}

/** A compute accelerator Ollama can use. A render node alone is not one (many SoCs have one). */
function hasAccelerator(fp: CheapFingerprint): boolean {
  return fp.gpu.nvidia || fp.gpu.amdKfd || fp.gpu.appleSilicon;
}

/**
 * The thread count the probe tries: this process's cgroup quota when one is set (an embedder in the
 * same cgroup), else the cores the embedder was measured to keep busy when that is below the logical
 * cores (a containerised Ollama's own quota shows up there: about 2 on the reference host, where the
 * bench's +23% was measured at num_thread 2), else the logical cores.
 */
function threadsToTry(fp: CheapFingerprint, embedCores: number | undefined): number {
  if (fp.cpuQuotaCores !== null && fp.cpuQuotaCores >= 1) {
    return Math.floor(fp.cpuQuotaCores);
  }
  if (embedCores !== undefined && Math.round(embedCores) < fp.logicalCores) {
    return Math.max(1, Math.round(embedCores));
  }
  return Math.max(1, fp.logicalCores);
}

function sanityHolds(vectors: number[][]): boolean {
  if (vectors.length !== SANITY_TRIPLES.length * 3) {
    return false;
  }
  return SANITY_TRIPLES.every((_, i) => {
    const anchor = vectors[3 * i];
    return (
      cosineSimilarity(anchor, vectors[3 * i + 1]) > cosineSimilarity(anchor, vectors[3 * i + 2])
    );
  });
}

/** One throughput batch: every passage once, rotated, each opened by a line no earlier batch had. */
function fixtureBatch(round: number): string[] {
  const batch: string[] = [];
  for (let k = 0; k < BATCH_PASSAGES; k += 1) {
    const passage = FIXTURE_PASSAGES[(round + k) % FIXTURE_PASSAGES.length];
    batch.push(`Note ${round + 1}.${k + 1}. ${passage}`);
  }
  return batch;
}

/**
 * The next preferred model as the ladder priors predict it here: the measured model's numbers scaled
 * by the two models' reference ratios (throughput, p50 latency, and download size for the cold load).
 * Used only to decide whether measuring the next model could change the decision; never recorded.
 */
function predictCandidate(
  measured: CandidateMeasurement,
  from: LadderEntry,
  to: LadderEntry,
): CandidateMeasurement {
  const theta = to.priors.tokensPerSecRef / from.priors.tokensPerSecRef;
  const latency = to.priors.queryP50MsRef / from.priors.queryP50MsRef;
  const predicted: CandidateMeasurement = {
    provider: "ollama",
    model: to.model,
    queryP50Ms: measured.queryP50Ms * latency,
    queryP95Ms: measured.queryP95Ms * latency,
    tokensPerSec: labelled(
      measured.tokensPerSec.value * theta,
      "tokens/s",
      "estimated",
      `predicted: ${from.model}'s measured throughput x the ladder's reference ratio ${fmt(theta)}`,
    ),
    tokensPerSecLow95: measured.tokensPerSecLow95 * theta,
    tokensPerSecHigh95: measured.tokensPerSecHigh95 * theta,
    batchDispersion: measured.batchDispersion,
    overheadMs: measured.overheadMs * latency,
    sanityOk: true,
  };
  if (measured.coldLoadMs !== undefined) {
    predicted.coldLoadMs = measured.coldLoadMs * (to.sizeMB / from.sizeMB);
  }
  return predicted;
}

// -------------------------------------------------------------------------------------------------
// The memory corpus
// -------------------------------------------------------------------------------------------------

type CorpusScan = {
  files: number;
  /** CJK-weighted characters (estimateStringChars) over every file. */
  chars: number;
  /** Bytes of files by modification day; index 0 is the last 24 hours. */
  bytesByDay: number[];
  recentFiles: number;
  chunkTokens: number;
  overlapTokens: number;
};

type CharsPerToken = { value: number; provenance: Measured["provenance"]; source: string };

async function scanCorpus(
  cfg: OpenClawConfig,
  agentId: string,
  ms: ResolvedMemorySearchConfig,
  now: () => number,
): Promise<CorpusScan> {
  const files = await listMemoryFiles(resolveAgentWorkspaceDir(cfg, agentId), ms.extraPaths);
  const bytesByDay = Array.from({ length: INGEST_DAYS }, () => 0);
  const at = now();
  let read = 0;
  let chars = 0;
  let recentFiles = 0;
  for (const file of files) {
    let stat: fs.Stats;
    let text: string;
    try {
      stat = await fs.promises.stat(file);
      text = await fs.promises.readFile(file, "utf8");
    } catch {
      continue;
    }
    read += 1;
    chars += estimateStringChars(text);
    const day = Math.max(0, Math.floor((at - stat.mtimeMs) / DAY_MS));
    if (day < INGEST_DAYS) {
      bytesByDay[day] += stat.size;
      recentFiles += 1;
    }
  }
  return {
    files: read,
    chars,
    bytesByDay,
    recentFiles,
    chunkTokens: ms.chunking.tokens,
    overlapTokens: ms.chunking.overlap,
  };
}

function charsPerTokenOf(observed: CandidateObservations["charsPerToken"]): CharsPerToken {
  if (!observed || !(observed.tokens > 0) || !(observed.chars > 0)) {
    return {
      value: CHARS_PER_TOKEN_ESTIMATE,
      provenance: "estimated",
      source: `estimateTokensFromChars's ${CHARS_PER_TOKEN_ESTIMATE} characters per token`,
    };
  }
  return {
    value: round3(observed.chars / observed.tokens),
    provenance: "local-measured",
    source: `${observed.model}'s own token count of the fit's fixture prose (${observed.chars} characters, ${observed.tokens} tokens)`,
  };
}

function corpusStatsFrom(
  scan: CorpusScan,
  ratio: CharsPerToken,
  sessions: { chars: number; transcripts: number } | undefined,
): CorpusStats {
  const recentBytes = sum(scan.bytesByDay);
  const meanDay = recentBytes / INGEST_DAYS;
  const peakDay = Math.max(0, ...scan.bytesByDay);
  const stats: CorpusStats = {
    files: scan.files,
    tokens: labelled(
      estimateTokensFromChars(scan.chars),
      "tokens",
      "estimated",
      `estimateTokensFromChars over ${scan.files} memory files (${scan.chars} CJK-weighted characters)`,
      scan.files,
    ),
    ingestTokensPerDay: labelled(
      round1(recentBytes / INGEST_DAYS / ratio.value),
      "tokens/day",
      "estimated",
      `upper bound: whole memory files modified in the last ${INGEST_DAYS} days (${scan.recentFiles} files, ${recentBytes} bytes) / ${INGEST_DAYS} days / ${fmt(ratio.value)} characters per token (${ratio.source}); the index re-embeds only changed chunks`,
      scan.recentFiles,
    ),
    burstFactor: labelled(
      meanDay > 0 ? round2(peakDay / meanDay) : 1,
      "peak day / mean day",
      "estimated",
      meanDay > 0
        ? `memory-file bytes by modification day over the last ${INGEST_DAYS} days: peak ${peakDay} vs mean ${round1(meanDay)}`
        : `no memory file changed in the last ${INGEST_DAYS} days`,
      INGEST_DAYS,
    ),
    chunkTokens: scan.chunkTokens,
    overlapTokens: scan.overlapTokens,
  };
  if (sessions) {
    stats.sessionIngestTokensPerDay = labelled(
      round1(sessions.chars / SESSION_DAYS / ratio.value),
      "tokens/day",
      "estimated",
      `user and assistant text in session transcripts with timestamps in the last ${SESSION_DAYS} days (${sessions.transcripts} transcripts read) / ${SESSION_DAYS} days / ${fmt(ratio.value)} characters per token`,
      sessions.transcripts,
    );
  }
  return stats;
}

/**
 * The memory corpus as the index sees it: files from listMemoryFiles with memorySearch.extraPaths,
 * tokens through estimateTokensFromChars, and the write rate from 14 days of modification times.
 * Ingest is the bytes of changed files / 14 days / characters per token (the measured ratio when
 * given, else estimateTokensFromChars's 4), labelled 'estimated' as an upper bound, since the index
 * re-embeds only changed chunks; burst is the peak day over the mean day. Undefined when memory
 * search is disabled.
 */
export async function measureCorpus(
  cfg: OpenClawConfig,
  opts: {
    agentId?: string;
    now?: () => number;
    charsPerToken?: { chars: number; tokens: number; model: string };
  } = {},
): Promise<CorpusStats | undefined> {
  const agentId = opts.agentId ?? resolveDefaultAgentId(cfg);
  const ms = resolveMemorySearchConfig(cfg, agentId);
  if (!ms) {
    return undefined;
  }
  const scan = await scanCorpus(cfg, agentId, ms, opts.now ?? Date.now);
  return corpusStatsFrom(scan, charsPerTokenOf(opts.charsPerToken), undefined);
}

// -------------------------------------------------------------------------------------------------
// The prompt profile
// -------------------------------------------------------------------------------------------------

type TranscriptFile = { file: string; mtimeMs: number; size: number };

type ProfileTally = {
  gaps: number[];
  prompts: number;
  nonEnglish: number;
  /** Hashes of prompts already counted, kept in memory for this pass only. */
  seen: Set<string>;
  sessionChars: number;
};

/**
 * One pass over the 60 newest transcripts (each under 40 MB) of the default agent:
 * - missCostSec: the median gap from a tool result to the next assistant message, one model step;
 *   with fewer than 20 steps, MISS_COST_PRIOR (21.57 s, 'third-party-reported');
 * - nonEnglishShare: the share of typed user prompts of at least 3 words whose stopword counts favour
 *   Spanish or Catalan over English; with fewer than 50 prompts, NON_ENGLISH_SHARE_PRIOR (0.25,
 *   'estimated');
 * - when sessions are asked for: user and assistant text characters of the last 7 days.
 * No prompt text is logged, stored or returned.
 */
export async function measurePromptProfile(
  cfg: OpenClawConfig,
  opts: { agentId?: string; now?: () => number; sessions?: boolean; signal?: AbortSignal } = {},
): Promise<PromptProfile> {
  const agentId = opts.agentId ?? resolveDefaultAgentId(cfg);
  const now = (opts.now ?? Date.now)();
  const listed = listTranscripts(resolveSessionTranscriptsDirForAgent(agentId));
  const picked = listed.filter((t) => t.size < TRANSCRIPT_MAX_BYTES).slice(0, TRANSCRIPTS_READ);
  const sessionsFrom = now - SESSION_DAYS * DAY_MS;
  // Session ingest only when every transcript that changed in the window was read: a partial count
  // understates it, and keep-up would then pass on a number that is too small.
  const sessionsCovered =
    opts.sessions === true && listed.every((t) => t.mtimeMs < sessionsFrom || picked.includes(t));
  const tally: ProfileTally = {
    gaps: [],
    prompts: 0,
    nonEnglish: 0,
    seen: new Set(),
    sessionChars: 0,
  };
  for (const transcript of picked) {
    opts.signal?.throwIfAborted();
    await tallyTranscript(transcript.file, tally, sessionsCovered ? sessionsFrom : undefined);
  }
  const missCostSec: Measured =
    tally.gaps.length >= MIN_MISS_STEPS
      ? labelled(
          round2(quantile(tally.gaps, 0.5) / 1000),
          "s",
          "local-measured",
          `median gap from a tool result to the next assistant message: ${tally.gaps.length} model steps in the ${picked.length} newest transcripts of agent ${agentId}`,
          tally.gaps.length,
        )
      : { ...MISS_COST_PRIOR };
  const nonEnglishShare: Measured =
    tally.prompts >= MIN_TYPED_PROMPTS
      ? {
          value: round3(tally.nonEnglish / tally.prompts),
          unit: "share",
          n: tally.prompts,
          denominator: "typed prompts",
          provenance: "local-measured",
          source: `stopword vote (small English, Spanish and Catalan lists) over ${tally.prompts} distinct typed prompts of at least ${MIN_PROMPT_WORDS} words in the ${picked.length} newest transcripts; a heuristic, not a language model`,
        }
      : { ...NON_ENGLISH_SHARE_PRIOR };
  const profile: PromptProfile = { missCostSec, nonEnglishShare, transcriptsRead: picked.length };
  if (sessionsCovered) {
    profile.sessionChars7d = tally.sessionChars;
  }
  return profile;
}

function listTranscripts(dir: string): TranscriptFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: TranscriptFile[] = [];
  for (const name of names) {
    if (!isPrimarySessionTranscriptFileName(name)) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) {
        out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch {
      // removed while listing
    }
  }
  return out.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

async function tallyTranscript(
  file: string,
  tally: ProfileTally,
  sessionsFrom: number | undefined,
): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let toolResultAt: number | undefined;
  try {
    for await (const line of lines) {
      const entry = parseMessageLine(line);
      if (!entry) {
        continue;
      }
      const { message, at } = entry;
      const role = message.role;
      if (
        role === "toolResult" ||
        role === "tool" ||
        (role === "user" && countToolResults(message).total > 0)
      ) {
        toolResultAt = at ?? toolResultAt;
        continue;
      }
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      if (sessionsFrom !== undefined && at !== undefined && at >= sessionsFrom) {
        const text = extractSessionText(message.content);
        if (text) {
          // The index's own line format (buildSessionEntry): "User: ..." or "Assistant: ...".
          const label = role === "user" ? "User: " : "Assistant: ";
          tally.sessionChars += label.length + text.length + 1;
        }
      }
      if (role === "assistant") {
        if (at !== undefined && toolResultAt !== undefined && at > toolResultAt) {
          tally.gaps.push(at - toolResultAt);
        }
      } else {
        tallyTypedPrompt(message.content, tally);
      }
      toolResultAt = undefined;
    }
  } catch {
    // an unreadable transcript is skipped; the others still count
  } finally {
    lines.close();
    stream.destroy();
  }
}

function parseMessageLine(
  line: string,
): { message: Record<string, unknown>; at?: number } | undefined {
  if (!line.includes('"message"')) {
    return undefined;
  }
  const entry = parseJson(line);
  if (!isRecord(entry)) {
    return undefined;
  }
  const message = entry.message;
  if (entry.type !== "message" || !isRecord(message)) {
    return undefined;
  }
  const at = timestampOf(entry, message);
  return at === undefined ? { message } : { message, at };
}

function timestampOf(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number | undefined {
  if (typeof entry.timestamp === "string") {
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) {
      return at;
    }
  }
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? message.timestamp
    : undefined;
}

function rawTextOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function tallyTypedPrompt(content: unknown, tally: ProfileTally): void {
  const raw = rawTextOf(content);
  if (!raw) {
    return;
  }
  const cleaned = stripMessageIdHints(stripEnvelope(stripInboundMetadata(raw).trim())).trim();
  const words = cleaned.toLowerCase().match(WORD_PATTERN) ?? [];
  if (words.length < MIN_PROMPT_WORDS) {
    return;
  }
  // A hash only, kept for this pass: the prompt text itself is never stored or logged.
  const key = createHash("sha256").update(words.join(" ")).digest("hex");
  if (tally.seen.has(key)) {
    return;
  }
  tally.seen.add(key);
  tally.prompts += 1;
  if (favoursNonEnglish(words)) {
    tally.nonEnglish += 1;
  }
}

function favoursNonEnglish(words: readonly string[]): boolean {
  let en = 0;
  let es = 0;
  let ca = 0;
  for (const word of words) {
    if (EN_STOPWORDS.has(word)) {
      en += 1;
    }
    if (ES_STOPWORDS.has(word)) {
      es += 1;
    }
    if (CA_STOPWORDS.has(word)) {
      ca += 1;
    }
  }
  return Math.max(es, ca) > en;
}

// -------------------------------------------------------------------------------------------------
// The run
// -------------------------------------------------------------------------------------------------

type FitRun = {
  cfg: OpenClawConfig;
  deps: EmbedderFitDeps;
  log: FitLog;
  stateDir: string;
  signal?: AbortSignal;
  clock: FitClock;
  background: boolean;
  allowPull: boolean;
  askPull: boolean;
  consentVia: "installer" | "doctor" | "flag";
  agentId: string;
  ms: ResolvedMemorySearchConfig | null;
  rawProvider: string;
  rawModel?: string;
  client: OllamaClient;
  probe: MachineProbe;
  scan?: CorpusScan;
  profile: PromptProfile;
  prior: EmbedderFitRecord | null;
  demand?: Measured;
  consent: EmbedderConsent;
  candidates: CandidateMeasurement[];
  observed: CandidateObservations;
  /** What the fit itself ran into, appended to the decision's reasons with a 'fit:' prefix. */
  notes: string[];
  stopped: boolean;
  ceilingNoted: boolean;
  idleGateNeverOpened: boolean;
};

/**
 * Measure this machine and write <stateDir>/memory/embedder-fit.json:
 * - hold the fit lock while measuring;
 * - probe; without a local endpoint and without a consented remote provider the decision is 'off',
 *   with its reason;
 * - measure the cheapest installed preferred model, or the cheapest installed fallback when no
 *   preferred model is installed (a preferred one is pulled instead when a download is allowed);
 * - predict the next preferred model from its prior throughput ratio, and pull and measure it only
 *   when the prediction passes every gate and would be chosen; stop at the first failure;
 * - with consent and a key, measure that remote provider with fixture text only;
 * - decide with decideEmbedderFit (rawProvider from readRawMemorySearchProvider, so a pin is never
 *   changed and only gets a proposal), then writeEmbedderFit;
 * - stop at 5 minutes of wall time, downloads excluded, and write what was measured, saying so;
 * - background: nice 19 and IO idle, the idle gate before each model, never a download or a question.
 */
export async function runEmbedderFit(opts: RunEmbedderFitOptions): Promise<EmbedderFitRecord> {
  const deps = resolveDeps(opts.deps);
  const stateDir = opts.stateDir ?? resolveStateDir();
  const lock = acquireFitLock(stateDir);
  try {
    const background = opts.background === true;
    if (background) {
      deps.lowerPriority();
    }
    const run = await startRun(opts, deps, stateDir, background);
    if (run.ms && run.probe.inventory.ollama.reachable) {
      await measureLocalModels(run);
    }
    if (run.ms) {
      await measureConsentedRemote(run);
      if (!background && opts.interactive) {
        await askRemoteConsent(run);
      }
    }
    if (background && run.candidates.length === 0 && run.idleGateNeverOpened) {
      throw new EmbedderFitBusyError(
        "the host stayed busy: the idle gate did not open before the fit's ceiling, so nothing was measured and no record was written",
      );
    }
    return await finishRun(run, opts.command ?? defaultCommand(opts));
  } finally {
    lock.release();
  }
}

async function startRun(
  opts: RunEmbedderFitOptions,
  deps: EmbedderFitDeps,
  stateDir: string,
  background: boolean,
): Promise<FitRun> {
  const log = toFitLog(opts.log);
  const cfg = opts.cfg;
  const signal = opts.signal;
  const clock = createFitClock(deps.now);
  const agentId = resolveDefaultAgentId(cfg);
  const notes: string[] = [];
  let ms: ResolvedMemorySearchConfig | null = null;
  try {
    ms = resolveMemorySearchConfig(cfg, agentId);
    if (!ms) {
      notes.push(
        "fit: memory search is disabled (memorySearch.enabled is false), so nothing was measured",
      );
    }
  } catch (err) {
    notes.push(
      `fit: the memorySearch config is invalid (${errorText(err)}), so nothing was measured`,
    );
  }
  const rawProvider = readRawMemorySearchProvider(cfg, agentId);
  const { probe, client } = await probeWithClient(cfg, {
    agentId,
    ms,
    rawProvider,
    deps,
    ...(signal ? { signal } : {}),
  });
  log.info(describeProbe(probe));
  const scan = ms ? await scanCorpus(cfg, agentId, ms, deps.now) : undefined;
  signal?.throwIfAborted();
  const profile = await measurePromptProfile(cfg, {
    agentId,
    now: deps.now,
    sessions: ms?.sources.includes("sessions") === true,
    ...(signal ? { signal } : {}),
  });
  log.info(describeProfile(profile));
  const allowPull = !background && opts.allowPull === true;
  const run: FitRun = {
    cfg,
    deps,
    log,
    stateDir,
    clock,
    background,
    allowPull,
    askPull: !background && opts.interactive && !allowPull && opts.askPull !== false,
    consentVia: opts.consentVia ?? "flag",
    agentId,
    ms,
    rawProvider,
    client,
    probe,
    profile,
    prior: readEmbedderFit(stateDir),
    consent: { remote: null },
    candidates: [],
    observed: newObservations(),
    notes,
    stopped: false,
    ceilingNoted: false,
    idleGateNeverOpened: false,
  };
  if (signal) {
    run.signal = signal;
  }
  if (scan) {
    run.scan = scan;
  }
  if (rawProvider !== "auto" && ms?.model) {
    run.rawModel = ms.model;
  }
  const demand = measuredDemand(stateDir, run.prior);
  if (demand) {
    run.demand = demand;
  }
  run.consent = initialConsent(run, opts.allowRemote);
  if (scan) {
    log.info(describeCorpus(corpusFor(run)));
  }
  return run;
}

async function finishRun(run: FitRun, command: string): Promise<EmbedderFitRecord> {
  if (run.observed.pulled.length > 0) {
    // The inventory as it is now, so the gateway's start check does not see the pull as a change.
    const fresh = await probeOllama(run.client, run.signal);
    if (fresh.reachable) {
      run.probe.inventory.ollama = fresh;
    }
  }
  const input = decideInputFor(run, run.candidates);
  const decision = decideEmbedderFit(input);
  const record: EmbedderFitRecord = {
    schemaVersion: 1,
    createdAt: new Date(run.deps.now()).toISOString(),
    fingerprint: input.fingerprint,
    inventory: input.inventory,
    candidates: input.candidates,
    missCostSec: input.missCostSec,
    nonEnglishShare: input.nonEnglishShare,
    fitWallSeconds: input.fitWallSeconds,
    // fit-core's reasons first (the history keeps reasons[0]), then what the fit itself ran into.
    decision: { ...decision, reasons: [...decision.reasons, ...run.notes] },
    consent: run.consent,
    tool: { command, version: VERSION },
    history: [],
  };
  if (input.corpus) {
    record.corpus = input.corpus;
  }
  if (input.contention) {
    record.contention = input.contention;
  }
  const written = writeEmbedderFit(record, run.stateDir);
  run.log.info(`decision: ${describeDecision(written.decision)}`);
  return written;
}

async function measureLocalModels(run: FitRun): Promise<void> {
  const preferred = ladderByCost("preferred");
  const installed = (entry: LadderEntry): boolean =>
    run.probe.inventory.ollama.models.some((m) => sameModel(m.name, entry.model));
  const cheapest = preferred[0];
  let first = preferred.find(installed);
  let pullFirst = false;
  if (!first && cheapest && (await mayPull(run, cheapest))) {
    first = cheapest;
    pullFirst = true;
  }
  first ??= ladderByCost("fallback").find(installed);
  if (!first) {
    return;
  }
  const measured = await measureLadderModel(run, first, pullFirst);
  await measurePinnedModel(run, installed);
  if (!measured || first.status !== "preferred") {
    return;
  }
  let current = { entry: first, candidate: measured };
  for (const next of preferred.slice(preferred.indexOf(first) + 1)) {
    if (run.stopped) {
      break;
    }
    if (run.clock.remainingMs() <= 0) {
      noteCeiling(run, `before ${next.model} could be measured`);
      break;
    }
    const predicted = predictCandidate(current.candidate, current.entry, next);
    const pick = decideEmbedderFit(decideInputFor(run, [...run.candidates, predicted]));
    if (!sameModel(pick.model ?? "", next.model)) {
      run.log.info(
        `${next.model}: predicted from ${current.entry.model}'s measurement and the ladder priors, it would not be chosen here, so it is not measured`,
      );
      break;
    }
    const pull = !installed(next);
    if (pull && !(await mayPull(run, next))) {
      run.notes.push(
        `fit: predicted from ${current.entry.model}'s measurement and the ladder priors, ${next.model} would pass every gate and be chosen here; it is not installed and no download was allowed (${next.sizeMB} MB: openclaw embedder fit --pull)`,
      );
      break;
    }
    const got = await measureLadderModel(run, next, pull);
    const after = got ? decideEmbedderFit(decideInputFor(run, run.candidates)) : undefined;
    if (!got || !sameModel(after?.model ?? "", next.model)) {
      break;
    }
    current = { entry: next, candidate: got };
  }
}

function ladderByCost(status: LadderEntry["status"]): LadderEntry[] {
  return EMBEDDER_LADDER.filter((e) => e.status === status).toSorted(
    (a, b) => b.priors.tokensPerSecRef - a.priors.tokensPerSecRef,
  );
}

async function mayPull(run: FitRun, entry: LadderEntry): Promise<boolean> {
  if (run.background) {
    return false;
  }
  if (run.allowPull) {
    return true;
  }
  if (!run.askPull) {
    return false;
  }
  return await run.deps.confirm(
    `Download ${entry.model} (${entry.sizeMB} MB) from the Ollama library and measure it? Nothing leaves this machine.`,
  );
}

async function measureLadderModel(
  run: FitRun,
  entry: LadderEntry,
  pull: boolean,
): Promise<CandidateMeasurement | undefined> {
  const done = run.candidates.find(
    (c) => c.provider === "ollama" && sameModel(c.model, entry.model),
  );
  if (done) {
    return done;
  }
  if (run.stopped) {
    return undefined;
  }
  if (run.background && !(await waitForIdleGate(run, entry))) {
    run.stopped = true;
    if (run.candidates.length === 0) {
      run.idleGateNeverOpened = true;
    }
    run.notes.push(
      `fit: the host stayed busy (the idle gate stayed closed), so ${entry.model} was not measured`,
    );
    return undefined;
  }
  const remote = ollamaRemote(run.ms, run.rawProvider);
  try {
    const candidate = await measureCandidate(entry, {
      baseUrl: run.client.baseUrl,
      allowPull: pull,
      cfg: run.cfg,
      ...(remote ? { remote } : {}),
      ...(run.signal ? { signal: run.signal } : {}),
      onProgress: (line) => run.log.info(line),
      decideInput: () => decideInputFor(run, run.candidates),
      fingerprint: run.probe.fingerprint,
      observed: run.observed,
      clock: run.clock,
      deps: run.deps,
    });
    run.candidates.push(candidate);
    run.log.info(describeCandidate(candidate));
    return candidate;
  } catch (err) {
    if (run.signal?.aborted) {
      throw err;
    }
    if (err instanceof FitCeilingError) {
      noteCeiling(run, `while measuring ${entry.model}`);
      return undefined;
    }
    run.log.warn(`${entry.model}: not measured (${errorText(err)})`);
    run.notes.push(`fit: ${entry.model} could not be measured (${errorText(err)})`);
    return undefined;
  }
}

/** The owner's pinned Ollama model, when it is on the ladder and installed: measured so the fit can check the pin. */
async function measurePinnedModel(
  run: FitRun,
  installed: (entry: LadderEntry) => boolean,
): Promise<void> {
  if (run.rawProvider !== "ollama" || !run.rawModel) {
    return;
  }
  const entry = ladderEntryFor(run.rawModel);
  if (!entry || !installed(entry)) {
    return;
  }
  run.log.info(
    `${entry.model}: the pinned model, measured so the fit can check the pin (the pin is never changed)`,
  );
  await measureLadderModel(run, entry, false);
}

async function waitForIdleGate(run: FitRun, entry: LadderEntry): Promise<boolean> {
  const prior = run.prior?.candidates?.find(
    (c) => c.provider === "ollama" && sameModel(c.model, entry.model),
  );
  for (let poll = 0; poll * IDLE_POLL_MS < FIT_CEILING_MS; poll += 1) {
    const load1 = run.deps.loadavg()[0] ?? 0;
    const open = idleGateOpen({
      load1,
      logicalCores: run.probe.fingerprint.logicalCores,
      embedCores: prior?.embedCores ?? Number.NaN,
      ownDuty: 0,
    });
    if (open) {
      return true;
    }
    if (run.clock.remainingMs() <= IDLE_POLL_MS) {
      return false;
    }
    if (poll === 0) {
      run.log.info(
        `background fit: waiting for idle CPU before ${entry.model} (load ${fmt(load1)} on ${run.probe.fingerprint.logicalCores} cores)`,
      );
    }
    await run.deps.sleep(IDLE_POLL_MS, run.signal);
  }
  return false;
}

async function measureConsentedRemote(run: FitRun): Promise<void> {
  const id = run.consent.remote?.provider;
  if (!id || !isRemoteProviderId(id)) {
    return;
  }
  const created = await createRemoteProvider(run, id);
  if (created) {
    await measureRemote(run, id, created);
  }
}

/** Only when no local model passed and a key exists: the question says what leaves and what it costs. */
async function askRemoteConsent(run: FitRun): Promise<void> {
  if (run.consent.remote || run.stopped) {
    return;
  }
  const id = run.probe.inventory.remoteKeys.find(isRemoteProviderId);
  if (!id || decideEmbedderFit(decideInputFor(run, run.candidates)).mode !== "off") {
    return;
  }
  const created = await createRemoteProvider(run, id);
  if (!created) {
    return;
  }
  const model = created.provider.model;
  if (!(await run.deps.confirm(remoteConsentQuestion(id, model, corpusFor(run))))) {
    run.log.info(`remote embedding with ${id}: not agreed, so memory search stays on words`);
    return;
  }
  run.consent = {
    remote: {
      provider: id,
      grantedAt: new Date(run.deps.now()).toISOString(),
      via: run.consentVia,
    },
  };
  await measureRemote(run, id, created);
}

/** A remote provider's client, and the base URL it calls: where the fit measures it. */
type RemoteClient = { provider: EmbeddingProvider; baseUrl: string };

async function createRemoteProvider(
  run: FitRun,
  id: RemoteEmbeddingProviderId,
): Promise<RemoteClient | undefined> {
  const pinned = run.rawProvider === id;
  // FORK 2026-10-30: memorySearch.remote reaches whichever provider memory search uses, the fit's
  // choice under 'auto' included (as ollamaRemote has it for Ollama), so the client is built at the
  // URL the runtime will call: memorySearch.remote.baseUrl, then models.providers.<id>.baseUrl,
  // then the adapter's default, the order of resolveEmbeddingEndpointBaseUrl.
  const remote = run.rawProvider === "auto" || pinned ? run.ms?.remote : undefined;
  try {
    const created = await REMOTE_FACTORIES[id]({
      config: run.cfg,
      agentDir: resolveAgentDir(run.cfg, run.agentId),
      provider: id,
      model: pinned && run.ms?.model ? run.ms.model : "",
      fallback: "none",
      ...(remote ? { remote } : {}),
    });
    return { provider: created.provider, baseUrl: created.client.baseUrl };
  } catch (err) {
    run.log.warn(
      `${id}: its client could not be created (${errorText(err)}); nothing is measured remotely`,
    );
    return undefined;
  }
}

async function measureRemote(
  run: FitRun,
  id: RemoteEmbeddingProviderId,
  created: RemoteClient,
): Promise<void> {
  const { provider } = created;
  if (run.stopped) {
    return;
  }
  if (run.clock.remainingMs() <= 0) {
    noteCeiling(run, `before ${id} could be measured`);
    return;
  }
  run.log.info(`${id}/${provider.model}: measuring with the built-in fixture text only`);
  try {
    const candidate = await measureWith({
      provider,
      providerId: id,
      model: provider.model,
      requestCeilingMs: EMBED_CEILINGS.remotePriorBatchDeadlineMs,
      clock: run.clock,
      deps: run.deps,
      ...(run.signal ? { signal: run.signal } : {}),
      progress: (line) => run.log.info(line),
      decideInput: () => decideInputFor(run, run.candidates),
      observed: run.observed,
    });
    // FORK 2026-10-30: where it was measured, so the record keys this endpoint as the governor
    // does (fitEndpointKeyFor in src/fork/embedder-fit.ts).
    candidate.baseUrl = created.baseUrl;
    run.candidates.push(candidate);
    run.log.info(describeCandidate(candidate));
  } catch (err) {
    if (run.signal?.aborted) {
      throw err;
    }
    if (err instanceof FitCeilingError) {
      noteCeiling(run, `while measuring ${id}`);
      return;
    }
    run.log.warn(`${id}: not measured (${errorText(err)})`);
    run.notes.push(`fit: ${id} could not be measured (${errorText(err)})`);
  }
}

function remoteConsentQuestion(id: string, model: string, corpus: CorpusStats | undefined): string {
  const price = REMOTE_LIST_PRICES_PER_MTOK[`${id}/${model}`];
  const once = corpus?.tokens.value;
  const daily = corpus?.ingestTokensPerDay.value;
  const volume =
    once !== undefined && daily !== undefined
      ? `about ${fmtTokens(once)} tokens once (the memory corpus, plus chunk overlap) and up to ${fmtTokens(daily)} tokens a day after (an upper bound)`
      : "the whole memory corpus once, then every change";
  const cost =
    price !== undefined && once !== undefined && daily !== undefined
      ? ` At a list price of $${price} per 1M tokens (a third-party figure recorded in 2025; verify it before relying on it) that is about $${usd((once * price) / 1e6)} once and $${usd((daily * price) / 1e6)} a day.`
      : " No list price is on file for this model here; check the provider's pricing before agreeing.";
  return `No local embedding model fits this machine, and a key for ${id} exists. Memory search could embed with ${id}/${model}, but your memory text would then leave this machine and be sent to ${id}: ${volume}.${cost} Use ${id} for memory embeddings?`;
}

function initialConsent(run: FitRun, allowRemote: string | undefined): EmbedderConsent {
  const keys = run.probe.inventory.remoteKeys;
  const asked = allowRemote?.trim();
  const prior = run.prior?.consent?.remote ?? null;
  if (asked === "none") {
    if (prior) {
      run.log.info(`remote consent for ${prior.provider} withdrawn`);
    }
    return { remote: null };
  }
  if (asked) {
    if (!isRemoteProviderId(asked)) {
      run.log.warn(
        `--allow-remote ${asked}: not a remote embedding provider (${REMOTE_PROVIDERS.map((p) => p.id).join(", ")})`,
      );
    } else if (!keys.includes(asked)) {
      run.log.warn(
        `--allow-remote ${asked}: no key resolves for ${asked}, so nothing is measured remotely`,
      );
    } else {
      return {
        remote: {
          provider: asked,
          grantedAt: new Date(run.deps.now()).toISOString(),
          via: run.consentVia,
        },
      };
    }
  }
  // A recorded yes stands until it is withdrawn (--allow-remote none): a re-fit asks nothing new.
  if (prior && keys.includes(prior.provider)) {
    return { remote: { ...prior } };
  }
  return { remote: null };
}

/** Real searches per day as the governor counted them since the previous fit; absent at install. */
function measuredDemand(stateDir: string, prior: EmbedderFitRecord | null): Measured | undefined {
  const decision = prior?.decision;
  if (!prior || !decision?.provider || decision.mode === "off") {
    return undefined;
  }
  // FORK 2026-10-30: the key the governor writes, from the URL the fit measured the provider at.
  // Built here with a URL for Ollama only, a remote decision's demand was never found.
  const key = fitEndpointKeyFor(prior, decision.provider);
  const snapshot = readEmbedGovernorSnapshots(stateDir)[key];
  const perDay = snapshot?.derived?.demandPerDay;
  if (typeof perDay !== "number" || !Number.isFinite(perDay) || perDay < 0) {
    return undefined;
  }
  const days = snapshot?.days;
  return labelled(
    perDay,
    "searches/day",
    "local-measured",
    `the governor's count of real searches (agent and rpc callers) per day over its trailing window (${key})`,
    Array.isArray(days) ? days.length : 0,
  );
}

function decideInputFor(run: FitRun, candidates: CandidateMeasurement[]): EmbedderFitInput {
  const input: EmbedderFitInput = {
    fingerprint: run.probe.fingerprint,
    inventory: run.probe.inventory,
    candidates,
    missCostSec: run.profile.missCostSec,
    nonEnglishShare: run.profile.nonEnglishShare,
    memAvailableBytes: run.deps.memAvailableBytes(),
    totalRamBytes: run.deps.totalMemBytes(),
    explicitSources: run.ms ? [...run.ms.sources] : [],
    consent: run.consent,
    fitWallSeconds: fitWallOf(run),
    rawProvider: run.rawProvider,
  };
  const corpus = corpusFor(run);
  if (corpus) {
    input.corpus = corpus;
  }
  const contention = contentionOf(run.observed);
  if (contention) {
    input.contention = contention;
  }
  if (run.demand) {
    input.demandPerDay = run.demand;
  }
  if (run.rawModel) {
    input.rawModel = run.rawModel;
  }
  return input;
}

function corpusFor(run: FitRun): CorpusStats | undefined {
  if (!run.scan) {
    return undefined;
  }
  const sessionChars = run.profile.sessionChars7d;
  const sessions =
    run.ms?.sources.includes("sessions") === true && sessionChars !== undefined
      ? { chars: sessionChars, transcripts: run.profile.transcriptsRead }
      : undefined;
  return corpusStatsFrom(run.scan, charsPerTokenOf(run.observed.charsPerToken), sessions);
}

function contentionOf(observed: CandidateObservations): Measured | undefined {
  const { before, during } = observed.pressure;
  if (before.length === 0 || during.length === 0) {
    return undefined;
  }
  const b = mean(before);
  const d = mean(during);
  return labelled(
    round3(Math.max(0, d - b) / 100),
    "owner-s per background-s",
    "local-measured",
    `/proc/pressure/cpu some avg10 during the fit's batches (${fmt(d)}%, ${during.length} samples) vs before them (${fmt(b)}%): max(0, during - before) / 100`,
    during.length,
  );
}

function fitWallOf(run: FitRun): Measured {
  const elapsedMs = Math.max(0, run.clock.now() - run.clock.startedAt - run.clock.downloadMs);
  return labelled(
    round1(elapsedMs / 1000),
    "s",
    "local-measured",
    "this fit's own wall time on this machine, downloads excluded",
  );
}

function noteCeiling(run: FitRun, where: string): void {
  run.stopped = true;
  if (run.ceilingNoted) {
    return;
  }
  run.ceilingNoted = true;
  const minutes = FIT_CEILING_MS / 60_000;
  run.log.warn(
    `the fit reached its ${minutes}-minute ceiling ${where}; recording what was measured`,
  );
  run.notes.push(
    `fit: the ${minutes}-minute ceiling (downloads excluded) was reached ${where}; the record holds what was measured before it`,
  );
}

function toFitLog(log: RunEmbedderFitOptions["log"]): FitLog {
  if (!log) {
    return { info: () => undefined, warn: () => undefined };
  }
  if (typeof log === "function") {
    return { info: log, warn: log };
  }
  return log;
}

function defaultCommand(opts: RunEmbedderFitOptions): string {
  const flags = [
    opts.allowPull ? "--pull" : "",
    opts.allowRemote ? `--allow-remote ${opts.allowRemote}` : "",
    opts.background ? "--background" : "",
  ].filter(Boolean);
  return ["openclaw embedder fit", ...flags].join(" ");
}

// -------------------------------------------------------------------------------------------------
// The lock
// -------------------------------------------------------------------------------------------------

type FitLock = { release: () => void };

/**
 * <stateDir>/memory/embedder-fit.lock, held while the fit measures: the governor keeps background
 * calls off the endpoint while it is younger than 10 minutes, so it is refreshed every minute, a long
 * download included. A lock whose process is gone, or that nobody refreshed for 10 minutes, is stale
 * and is taken over; a live one makes this fit refuse with EmbedderFitBusyError.
 */
function acquireFitLock(stateDir: string): FitLock {
  const file = embedderFitPaths(stateDir).lock;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EEXIST") {
        throw err;
      }
      const holder = lockHolder(file);
      if (holder.live) {
        throw new EmbedderFitBusyError(
          `another fit is measuring this machine (pid ${holder.pid ?? "unknown"}); try again when it ends`,
        );
      }
      fs.rmSync(file, { force: true });
      continue;
    }
    const timer = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(file, now, now);
      } catch {
        // taken over or removed: nothing to refresh
      }
    }, LOCK_REFRESH_MS);
    timer.unref();
    return {
      release: () => {
        clearInterval(timer);
        if (lockHolder(file).pid === process.pid) {
          fs.rmSync(file, { force: true });
        }
      },
    };
  }
  throw new EmbedderFitBusyError("another fit took the lock while this one started; try again");
}

function lockHolder(file: string): { live: boolean; pid?: number } {
  let ageMs: number;
  let pid: number | undefined;
  try {
    ageMs = Date.now() - fs.statSync(file).mtimeMs;
    const parsed = parseJson(fs.readFileSync(file, "utf8"));
    pid = isRecord(parsed) && typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return { live: false };
  }
  if (pid === undefined) {
    return { live: false };
  }
  return { live: ageMs <= LOCK_STALE_MS && processAlive(pid), pid };
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === "EPERM";
  }
}

// -------------------------------------------------------------------------------------------------
// Log lines
// -------------------------------------------------------------------------------------------------

function describeProbe(p: MachineProbe): string {
  const o = p.inventory.ollama;
  const onLadder = o.models.filter((m) => ladderEntryFor(m.name) !== undefined).map((m) => m.name);
  const ollama = o.reachable
    ? `Ollama ${o.version ?? "(version unknown)"} at ${o.baseUrl}, ${o.models.length} models, on the ladder: ${onLadder.join(", ") || "none"}`
    : `Ollama not reachable at ${o.baseUrl}`;
  const keys = p.inventory.remoteKeys.length > 0 ? p.inventory.remoteKeys.join(", ") : "none";
  return `probe: ${p.fingerprint.logicalCores} cores ${p.fingerprint.arch}, ${p.fingerprint.totalRamGiB} GiB RAM; ${ollama}; node-llama-cpp ${p.inventory.nodeLlamaCpp ? "present (informational)" : "absent"}; keys for remote providers: ${keys}`;
}

function describeProfile(p: PromptProfile): string {
  const miss =
    p.missCostSec.provenance === "local-measured"
      ? `${fmt(p.missCostSec.value)} s over ${p.missCostSec.n ?? 0} model steps`
      : `${fmt(p.missCostSec.value)} s (prior: fewer than ${MIN_MISS_STEPS} model steps here)`;
  const share = `${fmt(p.nonEnglishShare.value * 100)}%`;
  const lang =
    p.nonEnglishShare.provenance === "local-measured"
      ? `${share} of ${p.nonEnglishShare.n ?? 0} typed prompts`
      : `${share} (prior: fewer than ${MIN_TYPED_PROMPTS} typed prompts here)`;
  return `prompt profile (${p.transcriptsRead} transcripts): a missed recall costs ${miss}; non-English ${lang}`;
}

function describeCorpus(corpus: CorpusStats | undefined): string {
  if (!corpus) {
    return "corpus: not measured";
  }
  return `corpus: ${corpus.files} memory files, about ${fmtTokens(corpus.tokens.value)} tokens; up to ${fmtTokens(corpus.ingestTokensPerDay.value)} new tokens a day over the last ${INGEST_DAYS} days, burst ${fmt(corpus.burstFactor.value)}`;
}

function describeCandidate(c: CandidateMeasurement): string {
  const label = c.provider === "ollama" ? c.model : `${c.provider}/${c.model}`;
  const parts = [
    `${fmt(c.tokensPerSec.value)} tokens/s (95% band ${fmt(c.tokensPerSecLow95)}-${fmt(c.tokensPerSecHigh95)}, ${c.tokensPerSec.n ?? 0} batches)`,
    `query p50 ${fmt(c.queryP50Ms)} ms, p95 ${fmt(c.queryP95Ms)} ms`,
  ];
  if (c.coldLoadMs !== undefined) {
    parts.push(`cold load ${fmt(c.coldLoadMs / 1000)} s`);
  }
  if (c.rssBytes !== undefined) {
    parts.push(`${fmt(c.rssBytes / MIB)} MiB resident`);
  }
  if (c.embedCores !== undefined) {
    parts.push(`${fmt(c.embedCores)} cores busy`);
  }
  if (c.numThread !== undefined) {
    parts.push(`num_thread ${c.numThread} kept`);
  }
  parts.push(c.sanityOk ? "sanity pairs ok" : "sanity pairs FAILED");
  return `${label}: ${parts.join(", ")}`;
}

function describeDecision(d: FitDecision): string {
  if (d.mode === "off" || !d.model) {
    return `word index only: ${d.reasons[0] ?? "no embedding model fits this machine"}`;
  }
  const model = d.provider === "ollama" ? d.model : `${d.provider}/${d.model}`;
  const state = d.dormantUntilDemand
    ? `dormant until real searches reach ${fmt(d.demandBreakEvenPerDay ?? Number.POSITIVE_INFINITY)}/day`
    : "armed";
  return `${d.mode}, ${model}, ${state}`;
}

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

function isRemoteProviderId(id: string): id is RemoteEmbeddingProviderId {
  return REMOTE_PROVIDERS.some((p) => p.id === id);
}

function sameModel(a: string, b: string): boolean {
  const x = normalizeEmbeddingModelName(a);
  return x !== "" && x === normalizeEmbeddingModelName(b);
}

function labelled(
  value: number,
  unit: string,
  provenance: Measured["provenance"],
  source: string,
  n?: number,
): Measured {
  return n === undefined
    ? { value, unit, provenance, source }
    : { value, unit, n, provenance, source };
}

function pushDefined(list: number[], value: number | undefined): void {
  if (value !== undefined) {
    list.push(value);
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : sum(values) / values.length;
}

function sampleSd(values: readonly number[]): number {
  if (values.length < 2) {
    return Number.NaN;
  }
  const mu = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (values.length - 1));
}

/** Linear-interpolated quantile; NaN for an empty list. */
function quantile(values: readonly number[], q: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  if (sorted.length === 0) {
    return Number.NaN;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const at = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function t95(df: number): number {
  return df >= 1 && df <= T95.length ? T95[df - 1] : 1.96;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Declared twin of fit-core's own number format for its reasons. */
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

function fmtTokens(n: number): string {
  if (n >= 1e6) {
    return `${fmt(n / 1e6)}M`;
  }
  if (n >= 1e3) {
    return `${fmt(n / 1e3)}k`;
  }
  return fmt(n);
}

function usd(n: number): string {
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -------------------------------------------------------------------------------------------------
// Fixtures: neutral generic prose, the only text the fit ever sends
// -------------------------------------------------------------------------------------------------

const FIXTURE_WARMUP = "A short warm-up request before the cold load is measured.";
const FIXTURE_COLD = "The first request after the model was unloaded.";
const FIXTURE_ONE_TOKEN = "ok";

/** Four passages of about 400 tokens each, one index chunk apiece. */
const FIXTURE_PASSAGES: readonly string[] = [
  "A small neighbourhood bakery starts its day long before the first customer arrives. The baker lights the ovens at four, checks the temperature of the proving cabinet and reads the order book left from the evening before. Sourdough loaves shaped the previous afternoon have spent the night in a cool room, where slow fermentation builds flavour and a crisp, blistered crust. While the ovens heat, the baker weighs flour, water and salt for the day's sandwich bread and mixes the dough until it feels smooth and elastic. Pastries come next: sheets of laminated dough are rolled, cut into triangles and rolled again into crescents, then left to rise in a warm corner. By half past five the first loaves go in, and the room fills with steam and the smell of toasted grain. Timing matters more than any recipe. A loaf that bakes five minutes too long turns dry, and one that comes out early collapses as it cools. The baker taps the base of each loaf and listens for a hollow sound before moving it to the cooling racks. Meanwhile an assistant prepares the counter, labels the shelves and brews the first pot of coffee. Deliveries to two cafes leave at seven in a small van, packed in paper bags and wooden crates. When the doors open at eight, regular customers ask for their usual order, and the baker notes which items sold out early so that tomorrow's plan can be adjusted. In the quiet hour after lunch the team cleans the mixers, scrapes the benches and feeds the sourdough starter, which has been kept alive for many years with daily care.",
  "The river that runs through the valley changes character with every season. In early spring, melting snow from the hills raises the water quickly, and the current carries branches, gravel and silt far downstream. Farmers along the banks watch the gauges closely, because a sudden rise can flood the lower meadows within a single night. As the weather warms, the water clears and slows. Herons stand still in the shallows, and swallows skim the surface to catch insects at dusk. Summer brings the lowest flow of the year. Long stretches of pebbles appear in the middle of the channel, children build small dams with stones, and anglers wade across places that were impassable a few months earlier. The water grows warmer, which leaves less oxygen for the fish, so the trout gather in deeper pools beneath overhanging trees. Autumn rain refills the channel gradually. Fallen leaves collect in eddies and slowly break down, feeding the tiny creatures at the base of the food chain. Volunteers use the cooler months to clear rubbish from the banks and to plant willows that will hold the soil together when the next floods arrive. In winter the river runs dark and fast. Ice sometimes forms along the edges on still, clear nights, and the old stone bridge in the village becomes a favourite place to watch the water rush past. Records kept at the mill for more than a century show that each season follows the same broad pattern, even though no two years are ever quite the same.",
  "Keeping a bicycle in good condition takes less time than most riders expect, as long as small tasks are done regularly. The chain deserves the most attention. After a wet ride it should be wiped with a dry cloth, and every few weeks it needs a drop of lubricant on each link, followed by another wipe to remove the excess that would otherwise attract dirt. Tyre pressure is the next thing to check. Soft tyres make every journey slower and raise the risk of punctures, while tyres that are too hard give a harsh ride and less grip on wet roads. The correct range is usually printed on the side of the tyre. Brakes should be tested before every ride by squeezing each lever firmly while pushing the bicycle forward. If a lever travels too far or feels spongy, the cable may need tightening or the pads may be worn. Rim brake pads have grooves that act as wear indicators, and disc brake pads should be replaced when the friction material is thinner than a coin. Gears that skip or hesitate often need only a small turn of the barrel adjuster near the rear derailleur. Once a season it is worth checking that the wheels spin true, that the headset has no play and that every bolt is tight. A simple routine of cleaning, lubricating and inspecting prevents most breakdowns, saves money on repairs and makes riding safer and more pleasant throughout the year, whatever the weather and however far the daily journey happens to be.",
  "Public libraries organise their collections so that any reader can find a book without help, and the system behind the shelves is more careful than it first appears. When a new book arrives, a cataloguer records its title, author, publisher, edition and number of pages, then assigns subject headings that describe what the book is about. The book also receives a classification number, which decides where it will sit on the shelf. Books on similar topics end up next to each other, so a reader looking for one title on gardening will notice several others nearby. A small label with the number is fixed to the spine, and a barcode is added for lending. The record then goes into the online catalogue, where readers can search by keyword, author or subject and see whether a copy is available at their branch. Libraries also keep track of how often each item is borrowed. Popular titles may be bought in several copies, while books that have not been borrowed for many years may be moved to a store room or offered to another collection. Damaged items are repaired when possible: loose pages are glued back, torn covers are reinforced and worn spines are rebound. Beyond books, many libraries now lend magazines, films, music, tools and even musical instruments, each with its own catalogue entry. Staff run reading groups for children, help adults use computers and answer questions on almost any subject. The careful work of description and arrangement remains the foundation that makes all of these services possible.",
];

/** Sixteen short questions: the query sample. */
const FIXTURE_QUERIES: readonly string[] = [
  "How long should bread dough rest before baking?",
  "When does the river reach its lowest level?",
  "How often should a bicycle chain be oiled?",
  "Where can I find books about gardening in the library?",
  "What time do the bakery deliveries leave?",
  "Why do trout move into deeper pools in summer?",
  "How can I tell if my brake pads are worn out?",
  "What happens to library books that nobody borrows?",
  "Which pastries are made from laminated dough?",
  "How do volunteers protect the river banks?",
  "What is the right tyre pressure for a road bike?",
  "How does a classification number decide a shelf position?",
  "Why does a loaf collapse after it comes out early?",
  "What birds can be seen near the water in spring?",
  "How do I fix gears that skip when pedalling?",
  "Can the library lend tools and musical instruments?",
];

/** Anchor, paraphrase, unrelated: a working model scores each paraphrase above its unrelated text. */
const SANITY_TRIPLES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "The morning train to the coast leaves at seven.",
    "At seven each morning a train departs for the coast.",
    "Dried basil quickly loses most of its flavour.",
  ],
  [
    "Water the tomato plants early, before the sun is strong.",
    "Give the tomato plants water early in the day, before strong sun.",
    "The museum closes at five on public holidays.",
  ],
  [
    "She fixed the leaking kitchen tap with a new washer.",
    "A new washer stopped the kitchen tap from leaking.",
    "Mountain goats climb steep rock faces easily.",
  ],
];
const SANITY_TEXTS: readonly string[] = SANITY_TRIPLES.flat();

const WORD_PATTERN = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;

/**
 * Small stopword lists that vote on a typed prompt's language. Words shared with English ('a', 'no',
 * 'me', 'on') and the Catalan 'i', which reads as the English 'I', are left out on purpose.
 */
const EN_STOPWORDS = new Set(
  "the and is are was were be been have had do does did what how why when where which who this that these those with from for of to in at by it its you your we our they their can could would should will not but or if then just please there about into than very my".split(
    " ",
  ),
);
const ES_STOPWORDS = new Set(
  "el la los las de del al en un una que qué y es está por para con lo como cómo pero más esto este esta eso hay también muy yo mi su sus son hacer puedes quiero cuando donde dónde porque ya todo sobre tiene ahora bien favor gracias".split(
    " ",
  ),
);
const CA_STOPWORDS = new Set(
  "el la els les de del al en un una que què és per amb això aquest aquesta perquè molt jo meu meva seu seva són fer pots vull ho hi també però més està com quan ara doncs gràcies bé tot fins".split(
    " ",
  ),
);
