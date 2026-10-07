// THALAMUS v4 plugin config (design doc section 11.3). Every key is optional; every default is the safe one.
import { homedir } from "node:os";
import { join } from "node:path";
import type { PolicyTable } from "openclaw/plugin-sdk/fork-thalamus";

export type ThalamusMode = "off" | "shadow" | "enforce";

export type ThalamusConfig = {
  mode: ThalamusMode;
  jev: {
    enabled: boolean;
    sendRealSituations: boolean;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    /** Where an owner gets a token. No default: the pointer is the owner's decision. */
    tokenHelpUrl?: string;
  };
  reads: { confidenceFloor: number };
  privacy: {
    privateSources: string[];
    privatePaths: string[];
    approvedProviders: string[];
    jevApprovedSources: string[];
  };
  policy: { table: PolicyTable };
  /** `rank`: the short list comes from the ranked result (recall, then Jev's USE / INSPIRE split) and the matcher reads the same one. Off: the old flat read, as before 2026-10-06. */
  shortlist: { budgetMs: number; rank: boolean };
  /** What enforce mode is allowed to do. Each is off until the owner switches it on; shadow never acts on any of them. */
  enforce: {
    digest: boolean;
    check: boolean;
    finish: boolean;
    /** Claude Code lane: hand the bridge worker `--agents` sub-agents from the plugin. */
    workerAgents: boolean;
    /** Claude Code lane: let the plugin set the worker's model per turn. */
    workerModel: boolean;
    /**
     * The embedded lane replaces `model` per call (design doc 11.3). THE SEAM THAT WOULD ACT IS NOT BUILT: the call router
     * only observes (`wrapStreamFnWithCallRouter` sends the original `model`), so this stays off (the staged config says
     * false) and a switch that is on and does nothing would read as a lie on the status.
     */
    perCall: boolean;
    /** A running thread may be switched at all. Off: only fresh points switch (a new unit, a check, a finish, a digest). */
    midThread: boolean;
    /** A second copy of a slow critical-path unit on another provider. Shadow records the hedge and sends nothing. */
    hedge: boolean;
    /** `model: "auto"` in an orchestrate script resolves to a routed model instead of the default leaf. */
    orchestrateAuto: boolean;
    /**
     * Thalamus owns every model choice that used to name a fixed model: a leaf with no model, a sub-agent spawned with no
     * model, the Claude roles of a round-table. Each keeps its fixed model as the fallback when no pick comes back. A model
     * named on purpose (by the architect, a script, a recipe step or the agent) is never replaced.
     */
    ownModelChoices: boolean;
    /** Enforce hands the agent the enhancement short list on every prompt (and answers the Claude Code hook route). Off: it routes but injects nothing, as shadow does. */
    shortlist: boolean;
  };
  scheduler: { providerCaps: Record<string, number> };
  /**
   * Learning (paper section 8). Every switch is off until the owner turns it on; shadow never acts on any of them.
   * `enabled` lets the nightly run WRITE its estimates and card versions (a dry run never writes); `apply` lets the router
   * USE the learned estimates; `explore` lets overnight jobs try an option they would not take; `shuffle` shows overnight
   * short lists in a shuffled order to measure how much the agent follows position.
   */
  learning: {
    enabled: boolean;
    apply: boolean;
    explore: boolean;
    shuffle: boolean;
    /** Characters of a redacted task kept for replay. */
    replayMaxChars: number;
  };
  /** The charter's ruling C2: `model: "auto"` mixes only models of these providers until the owner widens the list. */
  orchestrate: { allowedLeafProviders: string[] };
  hedge: { margin: number };
  digest: { minResultTokens: number; digestTokens: number; timeoutMs: number };
  check: { timeoutMs: number; maxChars: number };
  finish: {
    timeoutMs: number;
    maxChars: number;
    preferred: { en: string[]; es: string[]; ca: string[]; default: string[] };
  };
  dataDir: string;
  retentionDays: number;
};

export const DEFAULT_DATA_DIR = join(homedir(), ".openclaw", "data", "thalamus-v4");

type Raw = Record<string, unknown> | undefined | null;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
const str = (v: unknown, d: string): string => (typeof v === "string" && v.length > 0 ? v : d);
const strs = (v: unknown, d: string[]): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : d;

/** Concurrent calls per provider. A missing, non-numeric or sub-one entry falls back to the default for that provider. */
export const DEFAULT_PROVIDER_CAPS: Readonly<Record<string, number>> = {
  "claude-code": 4,
  xai: 4,
  "openai-codex": 4,
  copilot: 2,
};
const caps = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = { ...DEFAULT_PROVIDER_CAPS };
  for (const [k, n] of Object.entries(obj(v))) {
    if (typeof n === "number" && Number.isFinite(n) && n >= 1) out[k] = Math.floor(n);
  }
  return out;
};

/** Anything but the two named modes is `off`: a typo must never switch routing on. A missing mode is `shadow`. */
export function parseMode(v: unknown): ThalamusMode {
  return v === "shadow" || v === "enforce" ? v : "off";
}

const optStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

export function parseConfig(raw: Raw): ThalamusConfig {
  const r = obj(raw);
  const jev = obj(r.jev);
  const reads = obj(r.reads);
  const privacy = obj(r.privacy);
  const policy = obj(r.policy);
  const shortlist = obj(r.shortlist);
  const enforce = obj(r.enforce);
  const digest = obj(r.digest);
  const check = obj(r.check);
  const finish = obj(r.finish);
  const scheduler = obj(r.scheduler);
  const orchestrate = obj(r.orchestrate);
  const learning = obj(r.learning);
  const hedge = obj(r.hedge);
  const preferred = obj(finish.preferred);
  return {
    mode: r.mode === undefined ? "shadow" : parseMode(r.mode),
    jev: {
      // On by default: with no token the shared Jev source keeps every read local, and a token arms it by itself.
      enabled: bool(jev.enabled, true),
      sendRealSituations: bool(jev.sendRealSituations, false),
      baseUrl: str(jev.baseUrl, "https://api.typesafe.ai"),
      model: str(jev.model, "jev-latest"),
      timeoutMs: num(jev.timeoutMs, 2600),
      ...(optStr(jev.tokenHelpUrl) ? { tokenHelpUrl: optStr(jev.tokenHelpUrl) } : {}),
    },
    reads: { confidenceFloor: Math.min(1, Math.max(0, num(reads.confidenceFloor, 0.6))) },
    privacy: {
      privateSources: strs(privacy.privateSources, ["channel:*"]),
      privatePaths: strs(privacy.privatePaths, []),
      approvedProviders: strs(privacy.approvedProviders, ["claude-code"]),
      jevApprovedSources: strs(privacy.jevApprovedSources, []),
    },
    policy: { table: obj(policy.table) as PolicyTable },
    shortlist: {
      budgetMs: Math.max(0, num(shortlist.budgetMs, 1500)),
      rank: bool(shortlist.rank, true),
    },
    enforce: {
      digest: bool(enforce.digest, false),
      check: bool(enforce.check, false),
      finish: bool(enforce.finish, false),
      workerAgents: bool(enforce.workerAgents, false),
      workerModel: bool(enforce.workerModel, false),
      perCall: bool(enforce.perCall, false),
      midThread: bool(enforce.midThread, false),
      hedge: bool(enforce.hedge, false),
      orchestrateAuto: bool(enforce.orchestrateAuto, false),
      ownModelChoices: bool(enforce.ownModelChoices, false),
      shortlist: bool(enforce.shortlist, true),
    },
    scheduler: { providerCaps: caps(scheduler.providerCaps) },
    learning: {
      enabled: bool(learning.enabled, false),
      apply: bool(learning.apply, false),
      explore: bool(learning.explore, false),
      shuffle: bool(learning.shuffle, false),
      replayMaxChars: Math.min(8000, Math.max(200, num(learning.replayMaxChars, 2000))),
    },
    orchestrate: { allowedLeafProviders: strs(orchestrate.allowedLeafProviders, ["claude-code"]) },
    hedge: { margin: Math.max(1, num(hedge.margin, 1.5)) },
    digest: {
      minResultTokens: Math.max(200, num(digest.minResultTokens, 2000)),
      digestTokens: Math.max(50, num(digest.digestTokens, 1200)),
      timeoutMs: Math.max(1000, num(digest.timeoutMs, 20_000)),
    },
    check: {
      timeoutMs: Math.max(1000, num(check.timeoutMs, 20_000)),
      maxChars: Math.max(1000, num(check.maxChars, 12_000)),
    },
    finish: {
      timeoutMs: Math.max(1000, num(finish.timeoutMs, 30_000)),
      maxChars: Math.max(1000, num(finish.maxChars, 16_000)),
      preferred: {
        en: strs(preferred.en, []),
        es: strs(preferred.es, []),
        ca: strs(preferred.ca, []),
        default: strs(preferred.default, []),
      },
    },
    dataDir: str(r.dataDir, DEFAULT_DATA_DIR),
    retentionDays: Math.max(1, num(r.retentionDays, 90)),
  };
}
