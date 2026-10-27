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
import { homedir } from "node:os";
import { join } from "node:path";
import {
  announceJev,
  JevClient,
  jevAvailability,
  jevOn as sharedJevOn,
  jevToken,
  noteJevBreaker,
  refreshJevNow,
  reportJevResult,
  setJevProbe,
  startJevWatch,
} from "openclaw/plugin-sdk/fork-jev";
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
  registerTaskRanker,
  registerWorkerProvider,
  requestTaskRanking,
  setRoutingReadProvider,
  toHistoryItem,
  type CallRouter,
  type EnhancementCard,
  type Estimate,
  type HistoryItem,
  type RefusalRecord,
  type RungTimeStats,
  type ThalamusBoardLike,
  type ToolResultDigester,
  type UsageMark,
  type WorkerProvider,
  type WorkerSpawnExtras,
  type WorkerSpawnInfo,
} from "openclaw/plugin-sdk/fork-thalamus";
import { anticipateReport } from "./anticipate-report.js";
import { createCacheFeed, newLedgerHolder, type AgentEventLike } from "./cache-feed.js";
import { createCardLoop, type CardLoop } from "./card-loop.js";
import { createModelCardWriter } from "./card-writer.js";
import { createCatalogRefresh, type CatalogRefresh } from "./catalog-refresh.js";
import { createCheckService, type CheckService } from "./check.js";
import {
  askSessionStateDir,
  defaultChatCatalog,
  type AnticipateMode,
  type ThalamusConfig,
  type ThalamusMode,
  type WakeMode,
} from "./config.js";
import { sourceOfSessionKey } from "./context-view.js";
import { createCorrectionCapture } from "./correction-capture.js";
import { createDigestService, type DigestService } from "./digest.js";
import { createFinishService, type FinishService } from "./finish.js";
import { createFreshRecorder } from "./fresh-record.js";
import { newToken } from "./http.js";
import { createLeafResolver } from "./leaf-resolver.js";
import { createLearning, type Learning } from "./learning-run.js";
import { createLessonSleep, LESSON_WORDS_MAX, type LessonSleep } from "./lesson-sleep.js";
import { createSdkModelCaller, type ModelCaller } from "./model-caller.js";
import { parsePlanRequest } from "./plan-input.js";
import { createPointerSources, type PointerSources } from "./pointer-sources.js";
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
import { createSessionWaker, resolveAskSessionScript, type SessionWaker } from "./session-wake.js";
import { createShadowRouter, type ShadowStats } from "./shadow.js";
import { createShortlistSeam, type PrepareInput } from "./shortlist-seam.js";
import { ThalamusStore, type SubagentCallRow, type UseRow } from "./store.js";
import { createTaskRanker } from "./task-ranker.js";
import {
  createTutor,
  type EnhSnapshot,
  type RoutingSnapshot,
  type Tutor,
  type TutorRun,
} from "./tutor.js";
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
  /** Whether Jev may be asked at all. Default: the shared availability, or always on when `ask` is injected. */
  jevOn?: () => boolean;
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
  /** The tutors' model call (2026-10-25, `src/tutor.ts`); absent = no tutor. */
  tutorRun?: TutorRun;
  /** The note folders when `anticipate.noteDirs` is empty: the agent workspace's `memory` folder. Absent: none. */
  defaultNoteDirs?: () => string[];
  /** The agent workspace, for the lesson pass's default files (`lesson-sleep.ts`). Absent: only configured paths. */
  workspaceDir?: () => string | undefined;
  /** The note and past-chat sources; injectable for tests. Default: read from disk per `anticipate`. */
  pointerSources?: PointerSources;
  /** The harness wake of a matching past chat; injectable for tests. Default: per `anticipate.wake`. */
  waker?: SessionWaker;
  /** The nightly catalogue refresh; injectable for tests. Default: per `anticipate.refreshCatalog`. */
  catalogRefresh?: CatalogRefresh;
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
  /** The memory pointers: the mode and how many notes and past chats are indexed. */
  anticipate: {
    mode: AnticipateMode;
    notes: number;
    chats: number;
    builtAt?: number;
    /** The harness wake: its mode, wakes started today (on disk) and answers still pending in this process. */
    wake: { mode: WakeMode; today: number; pending: number };
    /** The nightly catalogue refresh: whether one is running and how the last one ended. */
    catalog?: ReturnType<CatalogRefresh["stats"]>;
  };
};

/** How often the gateway looks whether the past-chat catalogue is due a refresh, and the first look after start. */
const CATALOG_TICK_MS = 10 * 60_000;
const CATALOG_FIRST_TICK_MS = 5 * 60_000;

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
  // Counts stop() calls. A start() still awaiting its defaults when stop() lands must not go on to register
  // the worker provider (a process-global slot) and the listeners, because nothing would ever remove them.
  let stops = 0;
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
  let stopJevWatch: (() => void) | undefined;
  let services: { digest: DigestService; check: CheckService; finish: FinishService } | undefined;
  let runStates: ReturnType<typeof createRunStates> | undefined;
  let scheduler: Scheduler | undefined;
  let refusals: RefusalWatcher | undefined;
  let tutor: Tutor | undefined;
  let learning: Learning | undefined;
  let lessons: LessonSleep | undefined;
  let pointerSources: PointerSources | undefined;
  let waker: SessionWaker | undefined;
  let catalogRefresh: CatalogRefresh | undefined;
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

  // Whether Jev may be asked: the shared availability, or always on when a test injects its own `ask`.
  const jevOnNow = deps.jevOn ?? (deps.ask ? () => true : sharedJevOn);
  /** A token exists (the status shows this, never the token). A test that injects `ask` stands in for the source. */
  const jevHasKey = (): boolean => {
    if (deps.ask) {
      return true;
    }
    refreshJevNow();
    return jevAvailability().keySource !== null;
  };

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
      const stopsAtStart = stops;
      const d = await defaults();
      if (stops !== stopsAtStart) return;
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

      // Jev: only when asked for, and the key is read per call, never kept. No token = dormant: nothing is asked.
      let ask = deps.ask;
      if (!ask && cfg.jev.enabled) {
        const client = new JevClient<RoutingSituation>({
          apiKey: jevToken,
          baseUrl: cfg.jev.baseUrl,
          model: cfg.jev.model,
          buildState: (s, qs) => buildRoutingState(s, qs),
          report: reportJevResult,
          onBreaker: (open, until) => noteJevBreaker("thalamus", open, until),
        });
        ask = (s, qs, o) => client.ask(s, qs as never, o);
      }
      if (!deps.ask && cfg.jev.enabled) {
        announceJev("thalamus");
        stopJevWatch ??= startJevWatch();
        // With no amygdala to probe a new token, one synthetic question arms it, or shows it refused. Nothing real is sent:
        // the situation is fixed text. Without this a Thalamus-only install stays "token not checked yet" for good.
        const probeQuestion = questions.task[0];
        if (ask && probeQuestion) {
          setJevProbe(
            () =>
              ask(
                { id: "jev-probe", request: { value: "List the files in a demo folder." } },
                [probeQuestion],
                { budgetMs: cfg.jev.timeoutMs },
              ),
            "thalamus",
          );
        }
      }

      const cards = (): EnhancementCard[] => [...cardMap.values()];
      const reader = new RoutingReader({
        ask,
        questions,
        cards,
        config: readerConfig(),
        jevOn: jevOnNow,
      });
      const tracker = createUseTracker({
        store: () => store,
        cards: () => cardMap,
        attribute: d.attribute,
        now,
        mode: () => cfg.mode,
      });
      // One ranked result per task (Broca retrieval v2, phase E): the seam below and Broca's matcher hook both read it, through
      // the slot, so Jev is asked once. History is the replay set joined to what was used; it is rebuilt at most once a minute.
      let historyCache: { at: number; items: HistoryItem[] } | undefined;
      const history = (): HistoryItem[] => {
        if (historyCache && now() - historyCache.at < 60_000) return historyCache.items;
        const items: HistoryItem[] = [];
        try {
          for (const t of store?.listReplayTexts({ limit: 500 }) ?? []) {
            const used = store?.getUse(t.taskId)?.used.map((u) => u.cardId) ?? [];
            if (used.length > 0) items.push(toHistoryItem(t.text, used));
          }
        } catch {
          /* history is a convenience; recall still has its other sources */
        }
        historyCache = { at: now(), items };
        return items;
      };
      const recent = (sessionKey: string): string[] => {
        try {
          return (store?.recentUses(100) ?? [])
            .filter((u) => u.session === sessionKey)
            .flatMap((u) => u.used.map((x) => x.cardId))
            .slice(0, 6);
        } catch {
          return [];
        }
      };
      if (cfg.shortlist.rank) {
        const ranker = createTaskRanker({
          reader,
          cards,
          history,
          recent,
          budgetMs: () => cfg.shortlist.budgetMs,
          now,
        });
        cleanups.push(registerTaskRanker(ranker));
      }
      // Phase 1.3: the owner's corrections become labels (`enh_pins`, `j.correction`). Jev only for the ambiguous ones,
      // through the same client and the same privacy gate as the task read.
      const corrections = createCorrectionCapture<PrepareInput>({
        store: () => store,
        cards,
        now,
        jev: {
          ask,
          question: questions.correction[0],
          allowed: (i) => reader.gate(i).allowed,
          budgetMs: () => cfg.jev.timeoutMs,
        },
        // The nightly lesson pass reads these. His words stay local, redacted and capped; `lessons.mode: off` keeps none.
        keep: (c) => {
          if (cfg.lessons.mode === "off") return;
          store?.addCorrection({
            ts: now(),
            session: c.input.sessionKey,
            runId: c.input.runId,
            cls: c.cls,
            via: c.via,
            cards: c.cards.map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
            words: redactForRouting(c.words).slice(0, LESSON_WORDS_MAX),
          });
        },
      });
      lessons = createLessonSleep({
        store: () => store,
        config: () => cfg.lessons,
        dataDir: cfg.dataDir,
        workspaceDir: () => deps.workspaceDir?.(),
        noteDirs: () =>
          cfg.anticipate.noteDirs.length > 0
            ? cfg.anticipate.noteDirs
            : (deps.defaultNoteDirs?.() ?? []),
        cards,
        now,
      });
      // The note and past-chat legs (2026-10-25). Built in the background; a prompt never waits for it.
      if (cfg.anticipate.mode !== "off") {
        pointerSources =
          deps.pointerSources ??
          createPointerSources({
            noteDirs: () =>
              cfg.anticipate.noteDirs.length > 0
                ? cfg.anticipate.noteDirs
                : (deps.defaultNoteDirs?.() ?? []),
            chatCatalog: () => cfg.anticipate.chatCatalog,
            now,
            onError: (err) => deps.logger.warn(`[thalamus] pointer index: ${String(err)}`),
          });
        void pointerSources.warm();
      }
      // The skill's script, found once: the wake and the catalogue refresh both run it.
      const askScript = resolveAskSessionScript(deps.extensionRoot);
      // The harness wake (2026-10-25): a strong past-chat match is asked by the harness itself, only in `on`.
      if (pointerSources && cfg.anticipate.wake.mode !== "off") {
        waker =
          deps.waker ??
          createSessionWaker({
            config: () => cfg.anticipate.wake,
            script: () => askScript,
            wakesDir: () => join(askSessionStateDir(), "wakes"),
            now,
            onExit: (e) => {
              const last = e.out.trim().split("\n").at(-1) ?? "";
              deps.logger.info(
                `[thalamus] wake ${e.wakeId}: exit ${e.code}${e.code === 0 ? "" : ` (${last.slice(0, 200)})`}`,
              );
            },
          });
        const w = waker;
        cleanups.push(() => w.stop());
      }
      // The past-chat catalogue keeps itself: the skill's incremental scan once a night, and once at first start.
      if (cfg.anticipate.refreshCatalog) {
        const refresh =
          deps.catalogRefresh ??
          createCatalogRefresh({
            enabled: () => cfg.anticipate.refreshCatalog,
            script: () => askScript,
            catalogPath: () => cfg.anticipate.chatCatalog,
            defaultPath: () => defaultChatCatalog(),
            now,
            logger: deps.logger,
          });
        catalogRefresh = refresh;
        const first = setTimeout(() => void refresh.tick(), CATALOG_FIRST_TICK_MS);
        const every = setInterval(() => void refresh.tick(), CATALOG_TICK_MS);
        first.unref?.();
        every.unref?.();
        cleanups.push(() => {
          clearTimeout(first);
          clearInterval(every);
        });
      }
      const sources = pointerSources;
      seam = createShortlistSeam({
        reader,
        cards,
        corrections,
        ...(waker ? { wake: waker } : {}),
        ...(sources
          ? {
              pointers: {
                mode: () => cfg.anticipate.mode,
                find: (text: string) =>
                  sources.find(text, {
                    maxNotes: cfg.anticipate.maxNotes,
                    maxChats: cfg.anticipate.maxChats,
                  }),
              },
            }
          : {}),
        ...(cfg.shortlist.rank ? { ranking: requestTaskRanking } : {}),
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

      // The tutors (2026-10-25): a sample of finished runs judged after the fact; records only, never routes.
      if (cfg.tutor.enabled && deps.tutorRun && cfg.tutor.ladder.length > 0) {
        const st = () => store;
        tutor = createTutor({
          run: deps.tutorRun,
          ladder: cfg.tutor.ladder,
          timeoutMs: cfg.tutor.timeoutMs,
          dailyCap: { routing: cfg.tutor.routingDailyCap, enh: cfg.tutor.enhDailyCap },
          sampleRate: cfg.tutor.sampleRate,
          followUpMs: cfg.tutor.followUpMs,
          save: {
            routing: (r) => st()?.insertRoutingReview(r),
            enh: (r) => st()?.insertEnhReview(r),
          },
          now,
          homeDir: homedir(),
          logger: deps.logger,
        });
      }
      /** A run a tutor may see: not a one-shot (`temp:*`), not from a private source. */
      const tutorMaySee = (sessionKey: string | undefined): sessionKey is string =>
        !!sessionKey &&
        !sessionKey.startsWith("temp:") &&
        !isPrivateSource(sourceOfSessionKey(sessionKey), cfg.privacy.privateSources);
      const routingSnapshotOf = (
        runId: string,
        ended: "end" | "error",
      ): RoutingSnapshot | undefined => {
        const decisions = store?.decisionsForRun(runId) ?? [];
        const first = decisions[0];
        const state = runs.get(runId);
        const sessionKey = state?.sessionKey ?? first?.session ?? undefined;
        if (!first || !tutorMaySee(sessionKey)) return undefined;
        const ran = new Set<string>();
        const stops: string[] = [];
        let output = 0;
        for (const d of decisions) {
          const o = store?.getOutcome(d.id);
          ran.add(
            typeof o?.actual_model === "string" && o.actual_model ? o.actual_model : d.incumbent,
          );
          if (typeof o?.stop_reason === "string" && o.stop_reason) stops.push(o.stop_reason);
          if (typeof o?.output === "number") output += o.output;
        }
        const work = state?.work ?? [];
        return {
          runId,
          sessionKey,
          ts: now(),
          ...(state?.aim ? { aim: state.aim } : {}),
          ran: [...ran],
          ...(first.chosenEffort ? { effort: first.chosenEffort } : {}),
          pick: {
            model: first.pick,
            ...(first.pickEffort ? { effort: first.pickEffort } : {}),
            applied: first.applied,
          },
          calls: decisions.length,
          toolCalls: work.length,
          toolErrors: work.filter((w) => w.isError).length,
          ended,
          stopReasons: stops,
          outputTokens: output,
          refused: false,
        };
      };
      const enhSnapshotOf = (use: UseRow, runId: string): EnhSnapshot | undefined => {
        if (use.private || !tutorMaySee(use.session)) return undefined;
        const brief = (cardId: string) => {
          const c = cardMap.get(cardId);
          return { cardId, name: c?.name ?? cardId, purpose: c?.purpose ?? "" };
        };
        const aim = runs.get(runId)?.aim;
        return {
          taskId: use.taskId,
          sessionKey: use.session,
          ts: now(),
          ...(aim ? { aim } : {}),
          shown: use.shown.map((e) => brief(e.cardId)),
          used: use.used.map((u) => ({ ...brief(u.cardId), onList: u.onList })),
          outcome: use.outcome,
        };
      };
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
            if (evt.stream === "call") {
              tracker.onCall(evt.runId, evt.data);
            } else if (evt.stream === "tool" && evt.data.phase === "start") {
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
              const ended = evt.data.phase === "end" || evt.data.phase === "error";
              if (ended) {
                if (!svc.check.acts()) svc.check.observeEnd(evt.runId);
                if (!svc.finish.acts()) svc.finish.observeEnd(evt.runId);
              }
              let use: UseRow | undefined;
              if (evt.data.phase === "end") use = tracker.finish(evt.runId, "done");
              else if (evt.data.phase === "error") use = tracker.finish(evt.runId, "retried");
              if (ended && tutor) {
                const phase = evt.data.phase === "end" ? "end" : "error";
                const runId = evt.runId;
                defer(() => {
                  try {
                    tutor?.afterRun(
                      () => routingSnapshotOf(runId, phase),
                      () => (use ? enhSnapshotOf(use, runId) : undefined),
                    );
                  } catch (err) {
                    onError(err);
                  }
                });
              }
            }
          } catch {
            /* observing never breaks the bus */
          }
        }),
      );

      // The step read rides on the amygdala's call, but only when Jev is on at all.
      if (cfg.jev.enabled) {
        const riding = new RoutingReader({
          rides: true,
          questions,
          cards,
          config: readerConfig(),
          jevOn: jevOnNow,
        });
        cleanups.push(
          setRoutingReadProvider(
            createRoutingProvider({
              reader: riding,
              sourceOf: sourceOfSessionKey,
              onRead: (r) => {
                providerReads += 1;
                providerReadsByKind[r.kind] += 1;
                if (r.kind === "outcome") {
                  refusals?.observeOutcome(r);
                  if (r.outcome.state.value === "refused") tutor?.noteRefusal(r.sessionKey);
                }
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
      stops += 1;
      stopJevWatch?.();
      stopJevWatch = undefined;
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
      pointerSources = undefined;
      waker = undefined;
      catalogRefresh = undefined;
      services = undefined;
      runStates = undefined;
      scheduler = undefined;
      refusals = undefined;
      tutor = undefined;
      learning = undefined;
      lessons = undefined;
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

    /** A prompt arrived in a chat: a routing review waiting on that chat's last run reads it (2026-10-25). */
    notePrompt(sessionKey: string | undefined, prompt: string | undefined): void {
      if (sessionKey && prompt) tutor?.notePrompt(sessionKey, prompt);
    },

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
     * `thalamus.lessons.run`: the nightly lesson pass (`lesson-sleep.ts`). A dry run writes nothing and returns the report
     * a real run would write. The bundled sleep routine calls it; nothing here schedules it.
     */
    async lessonsRun(o: { dry: boolean }) {
      if (cfg.lessons.mode === "off") return { ok: false as const, error: "lessons-off" };
      if (!lessons) return { ok: false as const, error: "not-running" };
      return lessons.run(o);
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
        jev: {
          enabled: cfg.jev.enabled,
          sendRealSituations: cfg.jev.sendRealSituations,
          hasKey: jevHasKey(),
        },
        ...(store ? { counts: store.counts() } : {}),
        ...(running ? { shadow: shadowStats() } : {}),
        cache: { runs: feedRuns() },
        cards: cardMap.size,
        providerReads,
        providerReadsByKind: { ...providerReadsByKind },
        ...(refusals ? { refusals: refusals.stats() } : {}),
        ...(lastDecision ? { lastDecisionAt: lastDecision } : {}),
        anticipate: {
          mode: cfg.anticipate.mode,
          notes: pointerSources?.stats().notes ?? 0,
          chats: pointerSources?.stats().chats ?? 0,
          ...(pointerSources?.stats().builtAt ? { builtAt: pointerSources.stats().builtAt } : {}),
          wake: { mode: cfg.anticipate.wake.mode, ...(waker?.stats() ?? { today: 0, pending: 0 }) },
          ...(catalogRefresh ? { catalog: catalogRefresh.stats() } : {}),
        },
      };
    },

    /** Do pointers on the desk save rounds? The ledger's owner tasks since `sinceTs` (default: the last 7 days). */
    anticipateReport(o: { sinceTs?: number } = {}) {
      const sinceTs = o.sinceTs ?? now() - 7 * 86_400_000;
      return {
        ok: true as const,
        mode: cfg.anticipate.mode,
        report: anticipateReport(store?.listUses({ sinceTs }) ?? [], sinceTs),
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
