// The THALAMUS v4 runtime (charter phase D1): starts and stops everything as one unit.
//
// WHAT THIS IS FOR. The plugin ships disabled. When an owner enables it, this decides what actually runs from the one
// setting `mode`:
//   off      nothing. No folder, no file, no listener, no router, no provider: `start()` returns before opening anything.
//   shadow   the per-call router computes and records; the short list is computed and recorded; use is observed.
//            Nothing the agent sees or does changes.
//   enforce  as shadow, and the agent is handed the short list. (Per-call model changes are not built in D1.)
//
// EVERY DEPENDENCY THAT TOUCHES THE LIVE GATEWAY IS INJECTED. The defaults load the runtime SDK lazily, so a test (or a
// build with the plugin off) never loads the model catalog, the session store or the plugin registry.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JevClient } from "openclaw/plugin-sdk/fork-jev";
import {
  createStuckTracker,
  DEFAULT_RUNG_TIME,
  domainStrengthFor,
  failureSignature,
  isPrivateSource,
  learnedStrengthFor,
  refusalRecordsFrom,
  rungTimeFrom,
  registerCallRouter,
  registerLeafModelResolver,
  registerToolResultDigester,
  registerWorkerProvider,
  setRoutingReadProvider,
  type CallRouter,
  type EnhancementCard,
  type Estimate,
  type RefusalRecord,
  type RungTimeStats,
  type ThalamusBoardLike,
  type ToolResultDigester,
  type UsageMark,
  type WorkerProvider,
  type WorkerSpawnExtras,
  type WorkerSpawnInfo,
} from "openclaw/plugin-sdk/fork-thalamus";
import { createCacheFeed, newLedgerHolder, type AgentEventLike } from "./cache-feed.js";
import { createCardLoop, type CardLoop } from "./card-loop.js";
import { createModelCardWriter } from "./card-writer.js";
import { createCheckService, type CheckService } from "./check.js";
import type { ThalamusConfig, ThalamusMode } from "./config.js";
import { sourceOfSessionKey } from "./context-view.js";
import { createDigestService, type DigestService } from "./digest.js";
import { createFinishService, type FinishService } from "./finish.js";
import { createFreshRecorder } from "./fresh-record.js";
import { newToken } from "./http.js";
import { createLeafResolver } from "./leaf-resolver.js";
import { createLearning, type Learning } from "./learning-run.js";
import { createSdkModelCaller, type ModelCaller } from "./model-caller.js";
import { parsePlanRequest } from "./plan-input.js";
import { createRawStore } from "./raw-store.js";
import { createRoutingProvider } from "./reads/provider.js";
import { loadQuestions } from "./reads/questions.js";
import { buildRoutingState, redactForRouting } from "./reads/redact.js";
import {
  DEFAULT_READER_CONFIG,
  RoutingReader,
  type AskFn,
  type ReaderConfig,
  type RoutingSituation,
} from "./reads/routing-reader.js";
import { seedFromRegistry, type RegistryListing } from "./reads/seed.js";
import { createRefusalWatcher, type RefusalWatcher } from "./refusal.js";
import { createRunStates } from "./run-state.js";
import { createScheduler, type PlanDecision, type Scheduler } from "./scheduler.js";
import { createShadowRouter, type ShadowStats } from "./shadow.js";
import { createShortlistSeam } from "./shortlist-seam.js";
import { ThalamusStore, type SubagentCallRow } from "./store.js";
import { createUseTracker } from "./use-tracker.js";

export type Logger = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
};

export type RuntimeDeps = {
  config: ThalamusConfig;
  extensionRoot: string;
  gatewayPort: number;
  /** The live gateway config, read when the board is built. */
  gatewayCfg: () => unknown;
  onAgentEvent: (listener: (evt: AgentEventLike) => void) => () => void;
  broadcast: (name: string, payload: unknown) => void;
  logger: Logger;
  now?: () => number;
  // Injectable for tests; the defaults use the runtime SDK, loaded lazily.
  readBoard?: (cfg: unknown, nowMs: number) => ThalamusBoardLike | undefined;
  handPicked?: (
    cfg: unknown,
    agentId: string | undefined,
    sessionKey: string | undefined,
  ) => boolean;
  listing?: () => RegistryListing[];
  attribute?: (call: { name: string; args?: unknown; toolCallId?: string }) => UsageMark[];
  store?: ThalamusStore;
  ask?: AskFn;
  defer?: (fn: () => void) => void;
  /** A draw in [0, 1) for exploration; default `Math.random`. */
  rand?: () => number;
  /** The ranker the card loop replays with; default is local word matching. */
  rank?: import("openclaw/plugin-sdk/fork-thalamus").Ranker;
  /** The model call the digest, check and finish services make. Default: the gateway's simple-completion runtime. */
  caller?: ModelCaller;
  /**
   * What the Claude Code worker should get for a spawn (design D5). Nothing decides this yet, so the default is none;
   * whatever it returns is still filtered by `enforce.workerAgents` and `enforce.workerModel`.
   */
  workerExtras?: (info: WorkerSpawnInfo) => WorkerSpawnExtras | undefined;
  /** Reads a card's text; defaults to the head of the file. */
  readText?: (path: string) => string | undefined;
};

export type RuntimeStatus = {
  mode: ThalamusMode;
  running: boolean;
  jev: { enabled: boolean; sendRealSituations: boolean; hasKey: boolean };
  counts?: ReturnType<ThalamusStore["counts"]>;
  shadow?: ShadowStats;
  cache: { runs: number };
  cards: number;
  providerReads: number;
  /** The same reads by kind; an outcome read is the one that can say "refused". */
  providerReadsByKind: { task: number; step: number; outcome: number };
  /** Refusals announced as `thalamus.refusal` since start. Detected only: nothing is re-routed or retried for them. */
  refusals?: { refusals: number; lastAt?: number };
  lastDecisionAt?: number;
};

const CARD_REFRESH_MS = 10 * 60 * 1000;

/** A plan decision as a preview returns it: ids, routes and times, no task text. */
export function planSummary(dec: PlanDecision) {
  return {
    planId: dec.planId,
    collapsed: dec.collapsed,
    lengthSec: dec.lengthSec,
    costEur: dec.costEur,
    criticalPath: dec.criticalPath,
    edges: dec.graph.edges,
    groups: dec.groups,
    hedges: dec.hedges,
    unplaced: dec.unplaced,
    units: dec.placements.map((p) => ({
      unitId: p.unitId,
      copy: p.copy,
      model: p.routeKey,
      effort: p.effort,
      startSec: p.startSec,
      endSec: p.endSec,
      slackSec: p.slackSec,
      onCritical: p.onCritical,
      ...(p.spilledFrom ? { spilledFrom: p.spilledFrom } : {}),
      ...(p.checker ? { checker: p.checker } : {}),
    })),
  };
}

/** The text of a tool result as the model sees it: the text blocks, or the string itself. Empty when it has none. */
export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

export function createRuntime(deps: RuntimeDeps) {
  const cfg = deps.config;
  const now = deps.now ?? Date.now;

  let running = false;
  let store: ThalamusStore | undefined;
  let ownStore = false;
  const cardMap = new Map<string, EnhancementCard>();
  const cleanups: Array<() => void> = [];
  let token = "";
  let shadowStats: () => ShadowStats = () => ({
    calls: 0,
    decisions: 0,
    noBoard: 0,
    noOption: 0,
    errors: 0,
    slow: 0,
    maxMs: 0,
  });
  let lastCardRefresh = 0;
  let providerReads = 0;
  const providerReadsByKind = { task: 0, step: 0, outcome: 0 };
  let feedRuns: () => number = () => 0;
  let seam: ReturnType<typeof createShortlistSeam> | undefined;
  let hasKey = false;
  let services: { digest: DigestService; check: CheckService; finish: FinishService } | undefined;
  let runStates: ReturnType<typeof createRunStates> | undefined;
  let scheduler: Scheduler | undefined;
  let refusals: RefusalWatcher | undefined;
  let learning: Learning | undefined;
  // What the nightly run taught the router (phase F). Empty until a run, or a store that holds an earlier one.
  let learnedStrength: ReturnType<typeof learnedStrengthFor> | undefined;
  let learnedRefusals: RefusalRecord[] = [];
  let learnedTimes = new Map<string, RungTimeStats>();
  const setLearned = (
    table: readonly Estimate[],
    times: readonly RungTimeStats[],
    refusals: RefusalRecord[],
  ): void => {
    learnedStrength = table.length
      ? learnedStrengthFor((k, dom) => domainStrengthFor(k, dom)?.p, table)
      : undefined;
    learnedTimes = new Map(times.map((t) => [t.rung, t]));
    learnedRefusals = refusals;
  };
  /** Only with `learning.apply` on does the router read any of it; otherwise it reads the public map alone. */
  const learnedNow = (): {
    strengthFor?: typeof learnedStrength;
    refusals?: RefusalRecord[];
  } =>
    cfg.learning.apply
      ? {
          ...(learnedStrength ? { strengthFor: learnedStrength } : {}),
          ...(learnedRefusals.length ? { refusals: learnedRefusals } : {}),
        }
      : {};
  const timeFrom = (which: "typical" | "slow") => (key: string) =>
    rungTimeFrom(learnedTimes.get(key), DEFAULT_RUNG_TIME, which);

  const readerConfig = (): ReaderConfig => ({
    ...DEFAULT_READER_CONFIG,
    jevEnabled: cfg.jev.enabled,
    sendRealSituations: cfg.jev.sendRealSituations,
    confidenceFloor: cfg.reads.confidenceFloor,
    privateSources: cfg.privacy.privateSources,
    jevApprovedSources: cfg.privacy.jevApprovedSources,
    budgetMs: cfg.jev.timeoutMs,
  });

  async function defaults(): Promise<
    Required<Pick<RuntimeDeps, "readBoard" | "handPicked" | "listing" | "attribute">>
  > {
    const rt = await import("openclaw/plugin-sdk/fork-thalamus-runtime");
    return {
      readBoard: deps.readBoard ?? ((c, n) => rt.readThalamusBoard(c as never, n)),
      handPicked: deps.handPicked ?? ((c, agent, key) => rt.isHandPicked(c as never, agent, key)),
      listing: deps.listing ?? (() => rt.getUsageRegistry().list?.() ?? []),
      attribute: deps.attribute ?? ((call) => rt.attributeToolUsage(call, rt.getUsageRegistry())),
    };
  }

  /** Seed cards for anything installed that has none yet, then reload the active set. */
  function refreshCards(listing: () => RegistryListing[]): number {
    if (!store) return 0;
    let added = 0;
    try {
      added = store.seedCards(seedFromRegistry(listing(), deps.readText), now());
    } catch (err) {
      deps.logger.warn(`[thalamus] card seeding failed: ${String(err)}`);
    }
    cardMap.clear();
    for (const c of store.activeCards()) cardMap.set(c.id, c);
    lastCardRefresh = now();
    return added;
  }

  return {
    get mode(): ThalamusMode {
      return cfg.mode;
    },

    /** Start everything the mode calls for. In mode `off` this opens nothing at all. */
    async start(): Promise<void> {
      if (running || cfg.mode === "off") return;
      if (process.env.OPENCLAW_THALAMUS_V4 === "off") {
        deps.logger.info("[thalamus] OPENCLAW_THALAMUS_V4=off, not starting");
        return;
      }
      const d = await defaults();
      mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(cfg.dataDir, 0o700);
      } catch {
        /* not ours to chmod */
      }
      store = deps.store ?? new ThalamusStore(join(cfg.dataDir, "thalamus.sqlite"));
      ownStore = deps.store === undefined;
      refreshCards(d.listing);

      const questions = loadQuestions(join(deps.extensionRoot, "questions"));

      // Jev: only when asked for, and the key is read per call, never kept.
      let ask = deps.ask;
      if (!ask && cfg.jev.enabled) {
        const client = new JevClient<RoutingSituation>({
          apiKey: () => process.env.TYPESAFE_API_KEY,
          baseUrl: cfg.jev.baseUrl,
          model: cfg.jev.model,
          buildState: (s, qs) => buildRoutingState(s, qs),
        });
        ask = (s, qs, o) => client.ask(s, qs as never, o);
      }
      hasKey = Boolean(process.env.TYPESAFE_API_KEY);

      const cards = (): EnhancementCard[] => [...cardMap.values()];
      const reader = new RoutingReader({ ask, questions, cards, config: readerConfig() });
      const tracker = createUseTracker({
        store: () => store,
        cards: () => cardMap,
        attribute: d.attribute,
        now,
        mode: () => cfg.mode,
      });
      seam = createShortlistSeam({
        reader,
        cards,
        mode: () => cfg.mode,
        inject: () => cfg.enforce.shortlist,
        budgetMs: () => cfg.shortlist.budgetMs,
        tracker,
        learning: {
          shuffle: () => cfg.learning.shuffle,
          rand: Math.random,
          // Replay text is kept only with learning on, only for a source Jev is approved for, and redacted.
          replayAllowed: (i) =>
            cfg.learning.enabled &&
            (!isPrivateSource(i.source, cfg.privacy.privateSources) ||
              isPrivateSource(i.source, cfg.privacy.jevApprovedSources)),
          recordReplay: (id, text) =>
            store?.putReplayText(
              id,
              redactForRouting(text).slice(0, cfg.learning.replayMaxChars),
              now(),
            ),
        },
      });

      const holder = newLedgerHolder();
      const feed = createCacheFeed({
        holder,
        onCallEnd: (e) => {
          // Join the call's counts to its decision by run and call index.
          try {
            const decisionId = `${e.runId}:${e.callIndex}`;
            if (!store?.getDecision(decisionId)) return;
            store.insertOutcome({
              decisionId,
              ts: now(),
              actualModel: e.modelKey,
              input: e.input,
              cacheRead: e.cacheRead,
              cacheWrite: e.cacheWrite,
              output: e.output,
              durationMs: 0,
              ...(e.stopReason ? { stopReason: e.stopReason } : {}),
              outcome: "done",
              refused: false,
              moneyBasis: "list",
            });
          } catch {
            /* an outcome for a decision that was not recorded is simply dropped */
          }
        },
      });
      feedRuns = () => feed.runCount();

      const defer = deps.defer ?? ((fn: () => void) => void setImmediate(fn));
      const onError = (err: unknown) => deps.logger.warn(`[thalamus] ${String(err)}`);
      const runs = createRunStates();
      const stuck = createStuckTracker();
      const caller: ModelCaller = deps.caller ?? createSdkModelCaller({ cfg: deps.gatewayCfg });
      const record = createFreshRecorder({
        cfg: () => cfg,
        store: () => store,
        now,
        defer,
        onError,
      });
      const svc = {
        digest: createDigestService({
          cfg: () => cfg,
          runs,
          store: () => store,
          raw: createRawStore({ dir: join(cfg.dataDir, "raw"), store: () => store, now }),
          caller: () => caller,
          now,
          defer,
          onError,
        }),
        check: createCheckService({ cfg: () => cfg, runs, record, caller: () => caller, onError }),
        finish: createFinishService({
          cfg: () => cfg,
          runs,
          record,
          caller: () => caller,
          onError,
        }),
      };
      services = svc;
      runStates = runs;

      // Refusals are DETECTED here and nowhere acted on (the architect, 2026-10-02): the page gets an event and a method.
      refusals = createRefusalWatcher({
        cfg: () => cfg,
        board: (n) => d.readBoard(deps.gatewayCfg(), n),
        now,
        broadcast: deps.broadcast,
        onError,
      });

      const shadow = createShadowRouter({
        runs,
        stuck,
        learned: learnedNow as never,
        cfg: () => cfg,
        board: (n) => d.readBoard(deps.gatewayCfg(), n),
        handPicked: (key, agent) => d.handPicked(deps.gatewayCfg(), agent, key),
        holder,
        feed,
        store: () => store,
        broadcast: deps.broadcast,
        now,
        defer: deps.defer,
        onError: (err) => deps.logger.warn(`[thalamus] shadow router: ${String(err)}`),
      });
      shadowStats = shadow.stats;
      cleanups.push(registerCallRouter(shadow.router as CallRouter));

      // The scheduler, and its first consumer: `model: "auto"` in an orchestrate script. In shadow the resolver writes
      // down the model it would pick and answers nothing, so "auto" stays an omitted model.
      const sched = createScheduler({
        cfg: () => cfg,
        board: (n) => d.readBoard(deps.gatewayCfg(), n),
        ledger: () => holder.ledger,
        now,
        store: () => store,
        broadcast: deps.broadcast,
        defer,
        onError,
        learned: learnedNow as never,
        ...(cfg.learning.apply
          ? { timeFor: timeFrom("typical") as never, slowTimeFor: timeFrom("slow") as never }
          : {}),
        ...(deps.rand ? { rand: deps.rand } : {}),
      });
      scheduler = sched;

      // The nightly run and the card loop. Nothing here schedules itself; the owner (or a cron he registers) calls it.
      const writer = createModelCardWriter({
        caller: () => caller,
        modelKey: () => {
          const full = d.readBoard(deps.gatewayCfg(), now());
          if (!full) return undefined;
          const allowed = new Set(cfg.orchestrate.allowedLeafProviders);
          const unit = {
            id: "writer",
            task: "",
            kind: "write" as const,
            inputs: [],
            outputs: [],
            writes: [],
            estIn: 3000,
            estOut: 300,
            model: "auto" as const,
            urgency: "whenever" as const,
            private: false,
          };
          const dec = sched.priceUnit(
            {
              id: `writer:${now()}`,
              units: [unit],
              task: { kind: "general", urgency: "whenever", shape: "answer" },
            },
            unit,
            { nowMs: now(), ledger: new Map(), conversationKey: "writer", slackSec: 0, index: 0 },
            {
              ...full,
              rungs: full.rungs.filter((r) =>
                allowed.has(r.key.slice(0, Math.max(0, r.key.indexOf("/")))),
              ),
            },
          );
          return dec?.chosen.rung.key;
        },
        extensionRoot: deps.extensionRoot,
        onError,
      });
      const loop: CardLoop = createCardLoop({
        store: () => store,
        now,
        writer,
        rank: deps.rank,
        onError,
      });
      learning = createLearning({
        cfg: () => cfg,
        store: () => store,
        now,
        cardLoop: () => loop,
        onError,
        onApplied: (table, times) => setLearned(table, times, learnedRefusals),
      });
      // A store that already holds a run gives the router what it learned, without waiting for tonight.
      if (cfg.learning.apply && store) {
        try {
          setLearned(
            store.getEstimates(),
            store.getRungTimes(),
            refusalRecordsFrom(store.outcomeFacts({ sinceTs: now() - 30 * 86_400_000 }), now()),
          );
        } catch (err) {
          onError(err);
        }
      }
      cleanups.push(
        registerLeafModelResolver(
          createLeafResolver({
            cfg: () => cfg,
            board: (n) => d.readBoard(deps.gatewayCfg(), n),
            priceUnit: sched.priceUnit,
            now,
            record,
            onError,
          }),
        ),
      );

      // Enforce with the digest flag: long tool results are replaced by a digest, the raw kept on disk.
      if (svc.digest.acts()) {
        cleanups.push(registerToolResultDigester(svc.digest as ToolResultDigester));
      }

      // The Claude Code lane. Counting sub-agent calls spends nothing and runs in shadow too; spawn extras are
      // enforce only, each behind its own flag, and nothing decides them yet (`workerExtras` defaults to none).
      const open = new Map<string, { id: string; row: SubagentCallRow }>();
      const worker: WorkerProvider = {
        spawnExtras(info) {
          if (cfg.mode !== "enforce" || !(cfg.enforce.workerAgents || cfg.enforce.workerModel)) {
            return undefined;
          }
          const x = deps.workerExtras?.(info);
          if (!x) return undefined;
          return {
            ...(cfg.enforce.workerModel && x.model ? { model: x.model } : {}),
            ...(cfg.enforce.workerAgents && x.agentsJson ? { agentsJson: x.agentsJson } : {}),
            ...(cfg.enforce.workerAgents && x.env ? { env: x.env } : {}),
          };
        },
        noteSubagentCall(e) {
          const session = e.sessionKey ?? "";
          const key = `${session}:${e.parentToolUseId}`;
          if (e.phase === "start") {
            const id = `${key}:${e.t}`;
            const row: SubagentCallRow = {
              id,
              ts: e.t,
              session,
              parentToolUseId: e.parentToolUseId,
              ...(e.model ? { model: e.model } : {}),
              ...(e.inputTokens !== undefined ? { input: e.inputTokens } : {}),
              ...(e.cacheReadTokens !== undefined ? { cacheRead: e.cacheReadTokens } : {}),
              ...(e.cacheWriteTokens !== undefined ? { cacheWrite: e.cacheWriteTokens } : {}),
            };
            open.set(key, { id, row });
            if (open.size > 256) open.delete(open.keys().next().value as string);
            defer(() => {
              try {
                store?.insertSubagentCall(row);
              } catch (err) {
                onError(err);
              }
            });
          } else {
            const prior = open.get(key);
            if (!prior || e.outputTokens === undefined) return;
            open.delete(key);
            const row = { ...prior.row, output: e.outputTokens };
            defer(() => {
              try {
                store?.insertSubagentCall(row);
              } catch (err) {
                onError(err);
              }
            });
          }
        },
      };
      cleanups.push(registerWorkerProvider(worker));

      cleanups.push(
        deps.onAgentEvent((evt) => {
          try {
            feed.handle(evt);
            refusals?.noteEvent(evt as never);
            if (evt.stream === "tool" && evt.data.phase === "start") {
              tracker.onToolStart(evt.runId, evt.data);
              runs.toolStart(
                evt.runId,
                String(evt.data.toolCallId ?? ""),
                String(evt.data.name ?? ""),
                evt.data.args,
              );
            } else if (evt.stream === "tool" && evt.data.phase === "result") {
              const toolName = String(evt.data.name ?? "");
              const toolCallId = String(evt.data.toolCallId ?? "");
              const text = resultText(evt.data.result);
              const isError = evt.data.isError === true;
              runs.toolResult(evt.runId, toolCallId, toolName, text, isError);
              stuck.note(
                evt.runId,
                isError ? failureSignature({ toolName, error: text }) : undefined,
              );
              // Shadow only writes down what it would do; an acted record is the enforce path's, never overwritten.
              if (!svc.digest.acts())
                svc.digest.observe({ runId: evt.runId, toolCallId, toolName, text });
            } else if (evt.stream === "lifecycle") {
              if (evt.data.phase === "end" || evt.data.phase === "error") {
                if (!svc.check.acts()) svc.check.observeEnd(evt.runId);
                if (!svc.finish.acts()) svc.finish.observeEnd(evt.runId);
              }
              if (evt.data.phase === "end") tracker.finish(evt.runId, "done");
              else if (evt.data.phase === "error") tracker.finish(evt.runId, "retried");
            }
          } catch {
            /* observing never breaks the bus */
          }
        }),
      );

      // The step read rides on the amygdala's call, but only when Jev is on at all.
      if (cfg.jev.enabled) {
        const riding = new RoutingReader({ rides: true, questions, cards, config: readerConfig() });
        cleanups.push(
          setRoutingReadProvider(
            createRoutingProvider({
              reader: riding,
              sourceOf: sourceOfSessionKey,
              onRead: (r) => {
                providerReads += 1;
                providerReadsByKind[r.kind] += 1;
                if (r.kind === "outcome") refusals?.observeOutcome(r);
              },
              now,
            }),
          ),
        );
      }

      token = newToken();
      const endpoint = join(cfg.dataDir, "endpoint.json");
      writeFileSync(endpoint, JSON.stringify({ port: deps.gatewayPort, token }), { mode: 0o600 });
      try {
        chmodSync(endpoint, 0o600);
      } catch {
        /* best effort */
      }

      running = true;
      deps.logger.info(
        `[thalamus] started (mode=${cfg.mode}, dataDir=${cfg.dataDir}, cards=${cardMap.size})`,
      );
    },

    stop(): void {
      for (const off of cleanups.splice(0).reverse()) {
        try {
          off();
        } catch {
          /* nothing to do */
        }
      }
      if (store && ownStore) {
        try {
          store.close();
        } catch {
          /* already closed */
        }
      }
      store = undefined;
      seam = undefined;
      services = undefined;
      runStates = undefined;
      scheduler = undefined;
      refusals = undefined;
      learning = undefined;
      learnedStrength = undefined;
      learnedRefusals = [];
      learnedTimes = new Map();
      running = false;
    },

    /** Reseed cards now and then, so a skill installed after start gets a card. */
    async maybeRefreshCards(): Promise<void> {
      if (!running || now() - lastCardRefresh < CARD_REFRESH_MS) return;
      const d = await defaults();
      refreshCards(d.listing);
    },

    token: (): string => token,

    /** The seam the prompt hook and the HTTP route both call. Undefined when nothing is running. */
    shortlist: () => seam,

    /**
     * `thalamus.plan.preview`: the plan a caller describes, on a virtual clock. Nothing is started, recorded or spent.
     * Undefined while nothing is running.
     */
    previewPlan(
      raw: Record<string, unknown>,
    ):
      | { ok: true; plan: ReturnType<typeof planSummary> }
      | { ok: false; error: string }
      | undefined {
      if (!scheduler) return undefined;
      const parsed = parsePlanRequest(raw);
      if (!parsed.ok) return parsed;
      // `record: true` writes the plan down as a shadow plan, so the panel can show it afterwards; the default writes nothing.
      const dec =
        raw.record === true
          ? scheduler.shadow(parsed.req)
          : scheduler.simulate(parsed.req, { mode: "preview" });
      return dec ? { ok: true, plan: planSummary(dec) } : { ok: false, error: "no-board" };
    },

    /**
     * `thalamus.learning.run`: the nightly update. A dry run writes nothing and returns what a run would change; a real run
     * needs `learning.enabled`. Nothing calls this on a schedule.
     */
    async learningRun(o: { dry: boolean }) {
      if (!learning) return { ok: false as const, error: "not-running" };
      return learning.run(o);
    },

    /**
     * `thalamus.panel`: everything the Tinker panel draws, in one call: the one-line status, the newest per-call decisions, the
     * newest short lists with what the agent used, and the newest plan. No task text, no session key, no prompt. A plugin
     * that is off or missing has no such method, which is how the panel knows to show nothing at all.
     */
    panel() {
      if (!store || !running) return { ok: false as const, error: "not-running" };
      const at = now();
      const day = new Date(at);
      day.setHours(0, 0, 0, 0);
      const tally = store.decisionTally(day.getTime());
      const decisions = store.listDecisions({ limit: 12 }).map((d) => ({
        id: d.id,
        ts: d.ts,
        lane: d.lane,
        mode: d.mode,
        incumbent: d.incumbent,
        chosen: d.chosen,
        chosenEffort: d.chosenEffort,
        pick: d.pick,
        switchKind: d.switchKind,
        switchReason: d.switchReason,
        nStar: d.nStar,
        wouldChange: d.wouldChange,
        degraded: d.degraded,
        private: d.private,
        price: d.price,
        incumbentPrice: d.incumbentPrice,
        reservedReason: d.reservedReason,
        options: d.options,
        vetoes: d.vetoes,
        ...(d.domain ? { domain: d.domain } : {}),
        ...(d.topic ? { topic: d.topic } : {}),
        ...(d.stepKind ? { stepKind: d.stepKind } : {}),
      }));
      const uses = store.recentUses(10).map((u) => ({
        taskId: u.taskId,
        ts: u.ts,
        source: u.source,
        private: u.private,
        shuffled: u.shuffled,
        listShown: u.listShown,
        listReason: u.listReason,
        listSource: u.listSource,
        noneFits: u.noneFits,
        shown: u.shown,
        used: u.used.map((x) => ({ cardId: x.cardId, onList: x.onList, rank: x.rank, via: x.via })),
        outcome: u.outcome,
        mode: u.mode,
        ...(u.taskKind ? { taskKind: u.taskKind } : {}),
      }));
      const named = new Map(store.activeCards().map((c) => [c.id, { name: c.name, kind: c.kind }]));
      const cardNames: Record<string, { name: string; kind: string }> = {};
      for (const u of uses) {
        for (const id of [...u.shown.map((e) => e.cardId), ...u.used.map((x) => x.cardId)]) {
          const c = named.get(id);
          if (c) cardNames[id] = c;
        }
      }
      const plans = store.listPlans(2).map((p) => ({
        planId: p.planId,
        ts: p.ts,
        mode: p.mode,
        units: p.units.map((x) => ({
          unitId: x.unitId,
          copy: x.copy,
          model: x.model,
          effort: x.effort,
          startSec: x.startSec,
          endSec: x.endSec,
          slackSec: x.slackSec,
          onCritical: x.onCritical,
          hedged: x.hedged,
          status: x.status,
          deps: x.deps,
        })),
      }));
      return {
        ok: true as const,
        mode: cfg.mode,
        ts: at,
        today: tally,
        lastDecisionAt: decisions[0]?.ts,
        learning: { enabled: cfg.learning.enabled, apply: cfg.learning.apply },
        decisions,
        uses,
        cardNames,
        plans,
      };
    },

    /** `thalamus.learning.report`: the report of the last real run, and what the router is using now. */
    learningReport() {
      const last = store?.lastLearningRun({ dry: false });
      return {
        ok: true as const,
        last: last ? { id: last.id, ts: last.ts, report: last.report } : null,
        applying: cfg.learning.apply,
        estimates: store?.getEstimates().length ?? 0,
        rungTimes: store?.getRungTimes().length ?? 0,
        proposals: store?.listProposals({ status: "open" }) ?? [],
      };
    },

    /** `thalamus.learning.pin`: the owner says this task should have used this enhancement. The strongest label. */
    pin(p: { taskId: string; cardId: string; by?: string }) {
      if (!store) return { ok: false as const, error: "not-running" };
      if (!store.getUse(p.taskId)) return { ok: false as const, error: "unknown-task" };
      store.addPin({
        id: `${p.taskId}:${p.cardId}`,
        taskId: p.taskId,
        cardId: p.cardId,
        by: p.by ?? "owner",
        createdAt: now(),
      });
      return { ok: true as const };
    },

    /**
     * `thalamus.retryPick {sessionKey, model?, domain?}`: the model the "Rewind and retry with X" button would use after a
     * refused reply. Reads the board, sends nothing, retries nothing.
     */
    retryPick(i: { sessionKey?: unknown; model?: unknown; domain?: unknown }) {
      return refusals?.retryPick(i) ?? { ok: false as const, error: "not-running" };
    },

    /** The scheduler, for callers inside the plugin. Undefined when nothing is running. */
    scheduler: (): Scheduler | undefined => scheduler,

    /** The fresh-point services, for the plugin hooks and the Claude Code route. Undefined when nothing is running. */
    services: () => services,

    /** The Claude Code `PostToolUse` route's entry: a digest for a long result of this session's latest run, or undefined. */
    async digestForSession(i: {
      sessionKey: string;
      toolName: string;
      toolCallId: string;
      text: string;
    }): Promise<string | undefined> {
      const run = runStates?.latestForSession(i.sessionKey);
      if (!run || !services) return undefined;
      return services.digest.digest({
        meta: {
          runId: run.runId,
          sessionKey: i.sessionKey,
          provider: "claude-code",
          model: run.base?.incumbentKey ?? "",
        },
        toolName: i.toolName,
        toolCallId: i.toolCallId,
        params: {},
        text: i.text,
      });
    },

    status(): RuntimeStatus {
      const lastDecision = store?.listDecisions({ limit: 1 })[0]?.ts;
      return {
        mode: cfg.mode,
        running,
        jev: { enabled: cfg.jev.enabled, sendRealSituations: cfg.jev.sendRealSituations, hasKey },
        ...(store ? { counts: store.counts() } : {}),
        ...(running ? { shadow: shadowStats() } : {}),
        cache: { runs: feedRuns() },
        cards: cardMap.size,
        providerReads,
        providerReadsByKind: { ...providerReadsByKind },
        ...(refusals ? { refusals: refusals.stats() } : {}),
        ...(lastDecision ? { lastDecisionAt: lastDecision } : {}),
      };
    },

    feed(o: { sessionKey?: string; sinceTs?: number; limit?: number } = {}) {
      return store ? store.listDecisions(o) : [];
    },

    explain(id: string) {
      return store?.getDecision(id);
    },

    cardCount: (): number => cardMap.size,
  };
}

export type ThalamusRuntime = ReturnType<typeof createRuntime>;
