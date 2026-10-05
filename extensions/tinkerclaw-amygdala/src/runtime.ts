/**
 * The plugin runtime (design doc §3 M11). Everything that is not a thin call into the gateway plugin API lives here so
 * it can be tested without a gateway: the clock, file paths, the v3.1 probe, the Jev transport and the emit function are
 * all injected. Nothing runs at import time; `start()` does the work.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeSessionMap, SeenSessions } from "./bridge-session-map.js";
import { routingCompanion } from "./companion.js";
import type { AmygdalaConfig } from "./config.js";
import { TurnContexts } from "./context.js";
import { decide, type DecideDeps, type DecideResult } from "./decide.js";
import type { DecisionEvent, InterventionEvent } from "./events.js";
import { enabledFamilies, type Family } from "./families/index.js";
import {
  changeView,
  questionRows,
  rebuildEvents,
  type ChangeViewOut,
  type QuestionRowOut,
} from "./feed.js";
import type { HookAction } from "./hook-action.js";
import { JevClient, type JevTransport } from "./jev.js";
import { createLearning, type Learning } from "./learning.js";
import {
  buildHookSettings,
  compilePolicy,
  computeFloorActive,
  mergeHookSettings,
  policyPaths,
  stageHooks,
  writeHookSettings,
  writePolicy,
} from "./policy.js";
import { QuestionBook } from "./question-book.js";
import { redactForSend } from "./redact.js";
import type { SessionMap } from "./rewind.js";
import { evaluateRules } from "./rules.js";
import { SessionTracker, type HookPayload } from "./session-tracker.js";
import { buildSituation, type SeamInput } from "./situation.js";
import { dayBounds, spendBetween, spendToday } from "./spend.js";
import { buildStatus, readSpool, type StatusEvent } from "./status.js";
import { AmygdalaStore } from "./store.js";
import { narrationBefore } from "./transcript.js";
import type { Intervention, Question, Seam, Situation, Verdict } from "./types.js";
import { probeV31, type V31ProbeInput } from "./v31-probe.js";
import { WaitRegistry, type WaitAnswer } from "./wait-registry.js";

export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RuntimeOptions {
  config: AmygdalaConfig;
  /** Folder holding `questions/` and `hooks/`. */
  extensionRoot: string;
  /** Defaults to `config.dataDir`. */
  dataDir?: string;
  gatewayPort: number;
  v31: { readPluginConfig(): V31ProbeInput["pluginConfig"]; settingsPath?: string };
  transport?: JevTransport;
  /** Read per call; the default reads `TYPESAFE_API_KEY`. Nothing else in the runtime touches the key. */
  apiKey?: () => string | undefined;
  emit: (event: string, payload: unknown) => void;
  now?: () => number;
  idGen?: () => string;
  logger: RuntimeLogger;
  /** Defaults to `enabledFamilies(config)`. Injectable so tests need no registered family. */
  families?: Family[];
  /** The rewind method's session map (tests inject one). Without it and without `bridgeMapFile`, `rewind` does nothing (inert). */
  sessionMap?: SessionMap;
  /**
   * Path of the bridge's session-map.json (or `true` for its default path): builds the real `SessionMap` over it. Only the
   * plugin entry passes this, i.e. only while the plugin is enabled; the file is touched only when the user presses Rewind.
   */
  bridgeMapFile?: string | true;
}

export interface FeedQuery {
  sessionKey?: string;
  sinceTs?: number;
  limit?: number;
}

export interface Runtime {
  readonly mode: "shadow" | "enforce";
  start(): void;
  stop(): void;
  heartbeat(): void;
  floorActive(): boolean;
  /** The bearer token written to endpoint.json at the last start (empty before start). */
  token(): string;
  /** `tabKey` is the chat tab's key the hook forwarded (`TC_SESSION_KEY`); everything is keyed by it when present. */
  decide(
    seam: Seam,
    hook: HookPayload,
    tabKey?: string,
  ): Promise<{ decisionId: string; hook: HookAction }>;
  waitFor(interventionId: string, timeoutMs: number): Promise<WaitAnswer>;
  /**
   * Judge a PAST exchange at the stop seam, stamped with its own time `at` and its own turn id, so its cards land under
   * that reply in the chat. For turns that ran before the amygdala was on, or on a runner whose hooks it did not hear
   * (2026-09-30: two refusals in the CTO tab, written by Grok at 00:08 and 00:10). The live turn counter is untouched.
   */
  replay(o: {
    sessionKey: string;
    at: number;
    prompt: string;
    reply: string;
  }): Promise<DecideResult>;
  answer(interventionId: string, answer: string): boolean;
  feed(q?: FeedQuery): {
    decisions: ReturnType<AmygdalaStore["decisionsSince"]>;
    /** Rebuilt views (title, chips, command); a row whose situation was pruned falls back to a minimal one. */
    interventions: InterventionEvent[];
    /** One event per answered question, rebuilt so a reload redraws the Jev windows. */
    decisionEvents: DecisionEvent[];
    changes: ChangeViewOut[];
    questions: QuestionRowOut[];
    precedents: number;
    counts: { checks: number; held: number; asked: number };
    status: StatusEvent;
    spend: ReturnType<typeof spendToday> & { eur30: number };
  };
  /** Run canary: a known dangerous step through the floor, and one synthetic question through the judge when it is up. */
  canary(): Promise<{ heldBy: "hard-rule" | "none"; floorMs: number; judgeMs: number | null }>;
  status(): StatusEvent;
  /** Why start() failed, or null while it has not failed. A failed start reports `Not running` in status. */
  startError(): string | null;
  refreshEffective(): boolean;
  /** A note the native runner could not deliver (counted in status as `notesDropped`). */
  noteNotesDropped(n?: number): void;
  /**
   * Notes of an `enforceFamilies` family decided while `mode` is shadow, waiting for the chat's next hook call
   * (2026-10-03). A shadow hook hangs up after 150 ms, before Jev answers, so the note rides on the next step instead;
   * the paper places it "before the next step" anyway. Taking them empties the queue.
   */
  takeNotes(sessionKey: string): string[];
  /** Learning (design §7.3): the operations behind the label / approve / undo / propose / nightly / rewind methods. */
  learning(): Learning;
}

const V31_DEFAULT_SETTINGS = join(
  homedir(),
  ".openclaw",
  "data",
  "amygdala",
  "cc-hook-settings.json",
);
const ANSWER_RE = /^(allow-once|keep-held|option:.+)$/;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function atomicWrite0600(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const TOKENS = Symbol.for("tinkerclaw.amygdala.endpointTokens");

/**
 * One token per gateway process and endpoint file. The gateway can run register() more than once (a second plugin
 * registry ~30 s after boot); each start rewrites endpoint.json, and the HTTP route that answers belongs to the first
 * runtime. With a fresh token per start the hooks read a token the live route rejects (401, 2026-09-30). A new process
 * still gets a new token.
 */
function processToken(endpointPath: string): string {
  const g = globalThis as { [TOKENS]?: Map<string, string> };
  const tokens = (g[TOKENS] ??= new Map<string, string>());
  let t = tokens.get(endpointPath);
  if (!t) {
    t = randomBytes(32).toString("hex");
    tokens.set(endpointPath, t);
  }
  return t;
}

export function createRuntime(o: RuntimeOptions): Runtime {
  const { config, logger } = o;
  const dataDir = o.dataDir ?? config.dataDir;
  const now = o.now ?? Date.now;
  const paths = policyPaths(dataDir);
  const v31Path = o.v31.settingsPath ?? V31_DEFAULT_SETTINGS;
  const newSettingsPath = join(dataDir, "cc-hook-settings.json");
  const effectiveName = "cc-hook-settings.effective.json";
  const effectivePath = join(dataDir, effectiveName);

  // The epoch keeps a tab's turn ids apart across gateway restarts (2026-10-02: three turns merged into "#1").
  const tracker = new SessionTracker({ now, epoch: Date.now().toString(36) });
  const seen = new SeenSessions();
  const sessionMap: SessionMap | undefined =
    o.sessionMap ??
    (o.bridgeMapFile !== undefined
      ? new BridgeSessionMap({
          mapFile: o.bridgeMapFile === true ? undefined : o.bridgeMapFile,
          seen,
          now,
        })
      : undefined);
  const registry = new WaitRegistry({ now });
  const lastSeam: Partial<Record<Seam, number>> = {};
  const interventionEvents = new Map<string, InterventionEvent>();
  const judge: { lastMs: number | null; errors: number; silentSince?: number } = {
    lastMs: null,
    errors: 0,
  };

  let store: AmygdalaStore | null = null;
  let learn: Learning | null = null;
  let deps: DecideDeps | null = null;
  let started = false;
  let startError: string | null = null;
  let floorActive = true;
  let v31On = false;
  let policyWrittenAt = 0;
  let rulesInfo = { n: 0, version: 1 };
  let lastEffectiveMerged: boolean | null = null;
  let notesDropped = 0;
  // Per chat, at most NOTE_CAP notes younger than NOTE_TTL_MS: a chat whose hooks never come back (the native runner)
  // cannot pile them up, and a note is never delivered long after the step it was about.
  const NOTE_CAP = 3;
  const NOTE_TTL_MS = 10 * 60_000;
  const pendingNotes = new Map<string, { text: string; ts: number }[]>();
  let endpointToken = "";

  function need(): AmygdalaStore {
    if (!store) throw new Error("amygdala runtime not started");
    return store;
  }

  const emit = (event: string, payload: unknown): void => {
    if (event === "amygdala2.intervention") {
      const e = payload as InterventionEvent;
      interventionEvents.set(e.id, e);
      if (interventionEvents.size > 200) {
        const oldest = interventionEvents.keys().next().value;
        if (oldest !== undefined) interventionEvents.delete(oldest);
      }
    }
    try {
      o.emit(event, payload);
    } catch (err) {
      logger.warn(`[amygdala] emit ${event} failed: ${String(err)}`);
    }
  };

  /** Count consecutive judge failures from the verdicts (status line "Judge silent N min"). */
  function noteJudge(vs: Verdict[]): void {
    const live = vs.filter((v) => !v.skipped);
    const failed = vs.some(
      (v) => v.skipped === "timeout" || v.skipped === "error" || v.skipped === "breaker-open",
    );
    if (live.length > 0) {
      judge.errors = 0;
      judge.silentSince = undefined;
      const fresh = live.filter((v) => !v.cacheHit);
      if (fresh.length > 0) judge.lastMs = Math.max(...fresh.map((v) => v.latencyMs));
    } else if (failed) {
      judge.errors += 1;
      judge.silentSince ??= now();
    }
  }

  function writePolicyNow(): void {
    const p = compilePolicy({ mode: config.mode, v31Enforcing: v31On, now: now() });
    writePolicy(dataDir, p);
    policyWrittenAt = now();
    rulesInfo = { n: p.rules.length, version: p.version };
  }

  function writeEndpoint(): void {
    endpointToken = processToken(paths.endpointPath);
    atomicWrite0600(
      paths.endpointPath,
      JSON.stringify({ port: o.gatewayPort, token: endpointToken }) + "\n",
    );
  }

  /**
   * Build `cc-hook-settings.effective.json` (contract C18): shadow + v3.1 file present -> merged with v3.1 entries first;
   * enforce, or no v3.1 file -> ours alone. Rewritten only when a source is newer than it, or the kind changed.
   */
  function refreshEffective(): boolean {
    if (!config.hooks.enabled || !existsSync(newSettingsPath)) return false;
    let v31Json: object | null = null;
    if (config.mode === "shadow" && existsSync(v31Path)) {
      try {
        v31Json = JSON.parse(readFileSync(v31Path, "utf-8")) as object;
      } catch {
        v31Json = null;
      }
    }
    const merged = v31Json !== null;
    const eff = mtimeOf(effectivePath);
    const sources = [mtimeOf(newSettingsPath), mtimeOf(v31Path)].filter(
      (n): n is number => n !== null,
    );
    const stale = eff === null || sources.some((s) => s > eff) || lastEffectiveMerged !== merged;
    if (!stale) return false;
    const next = JSON.parse(readFileSync(newSettingsPath, "utf-8")) as object;
    const out = merged ? (mergeHookSettings(v31Json, next) ?? next) : next;
    writeHookSettings(dataDir, out, effectiveName);
    lastEffectiveMerged = merged;
    return true;
  }

  function todayCounts(): { checks: number; held: number; asked: number } {
    const rows = need().decisionsSince(dayBounds(now()).start);
    return {
      checks: rows.length,
      held: rows.filter((r) => r.response.kind === "hold").length,
      asked: rows.filter((r) => r.response.kind === "ask").length,
    };
  }

  function status(): StatusEvent {
    // FORK 2026-09-30: the store is created before the step that can throw (the question book), so a failed
    // start used to answer a normal "Shadow: watching" here while nothing was running (live 06:30). Report the
    // failure instead: degraded, "Not running", and the floor shown off because no hook was staged.
    if (startError !== null || !store) {
      return buildStatus({
        now: now(),
        mode: config.mode,
        floorActive: false,
        seams: {},
        rules: rulesInfo,
        judge: { ...judge },
        spendEurToday: 0,
        counts: { checks: 0, held: 0, asked: 0 },
        waitingForYou: 0,
        floorMissing: false,
        notesDropped,
        startError: startError ?? "not started",
      });
    }
    const s = need();
    const t = now();
    const spool = readSpool(dataDir);
    const seams: Partial<Record<Seam, number>> = { ...spool.seams };
    for (const [k, v] of Object.entries(lastSeam)) {
      const seam = k as Seam;
      seams[seam] = Math.max(seams[seam] ?? 0, v);
    }
    return buildStatus({
      now: t,
      mode: config.mode,
      floorActive,
      seams,
      rules: rulesInfo,
      judge: { ...judge },
      spendEurToday: spendToday(s, t, config.cost.eurPerUsd).eur,
      counts: todayCounts(),
      waitingForYou:
        s.listInterventions({ state: "open" }).length + s.listChanges({ status: "pending" }).length,
      floorMissing: spool.floorMissingTs !== null && spool.floorMissingTs > policyWrittenAt,
      hooksRefused: spool.refused,
      notesDropped,
    });
  }

  function closeIntervention(id: string, state: Intervention["state"]): void {
    need().closeIntervention(id, state, now(), "user");
    const ev = interventionEvents.get(id);
    emit("amygdala2.intervention", ev ? { ...ev, state } : { id, state, ts: now() });
  }

  return {
    mode: config.mode,

    start(): void {
      if (started) return;
      started = true;
      startError = null;
      try {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        try {
          chmodSync(dataDir, 0o700);
        } catch {
          /* not ours to chmod */
        }
        store = new AmygdalaStore(join(dataDir, "amygdala.sqlite"));
        const book = new QuestionBook({
          seedDir: join(o.extensionRoot, "questions"),
          overlayDir: join(dataDir, "questions.d"),
        });
        const jev = new JevClient({
          transport: o.transport,
          apiKey: o.apiKey ?? (() => process.env.TYPESAFE_API_KEY),
          baseUrl: config.jev.baseUrl,
          model: config.jev.model,
          buildState: (s: Situation, qs: Question[]) =>
            redactForSend(s, qs, { allowReal: config.jev.sendRealSituations, homeDir: homedir() }),
          now,
          idGen: o.idGen,
        });
        const tracked: DecideDeps["jev"] = {
          async ask(s, qs, opt) {
            const vs = await jev.ask(s, qs, opt);
            noteJudge(vs);
            return vs;
          },
        };
        const contexts = new TurnContexts({
          store,
          now,
          standingFactsPath: join(dataDir, "standing-facts.json"),
        });
        learn = createLearning({
          store,
          book,
          jev: tracked,
          config,
          extensionRoot: o.extensionRoot,
          dataDir,
          emit,
          now,
          idGen: o.idGen,
          sessionMap,
        });
        deps = {
          jev: tracked,
          book,
          store,
          contexts,
          families: o.families ?? enabledFamilies(config, { book }),
          config: {
            mode: config.mode,
            failClosedOnLevel3: config.failClosedOnLevel3,
            enforceFamilies: config.enforceFamilies,
          },
          floorActive: () => floorActive,
          now,
          idGen: o.idGen,
          emit,
          cutoffFor: learn.cutoffFor,
          precedents: learn.precedents,
          companion: routingCompanion,
        };

        v31On = probeV31({ readPluginConfig: o.v31.readPluginConfig, settingsPath: v31Path });
        floorActive = computeFloorActive(config.mode, v31On);
        writePolicyNow();
        stageHooks(dataDir, join(o.extensionRoot, "hooks"));
        writeEndpoint();
        if (config.hooks.enabled) {
          writeHookSettings(
            dataDir,
            buildHookSettings(dataDir, { mode: config.mode }),
            "cc-hook-settings.json",
          );
          refreshEffective();
        }
      } catch (err) {
        startError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    },

    startError(): string | null {
      return startError;
    },

    stop(): void {
      registry.dispose();
      if (store) {
        try {
          store.close();
        } catch {
          /* already closed */
        }
      }
      store = null;
      learn = null;
      deps = null;
      started = false;
    },

    heartbeat(): void {
      if (!started) return;
      v31On = probeV31({ readPluginConfig: o.v31.readPluginConfig, settingsPath: v31Path });
      const next = computeFloorActive(config.mode, v31On);
      if (next !== floorActive) {
        floorActive = next;
        writePolicyNow();
        logger.info(
          `[amygdala] hard-rule floor is now ${floorActive ? "ON" : "OFF"} (v3.1 enforcing: ${v31On})`,
        );
      }
      try {
        refreshEffective();
      } catch (err) {
        logger.warn(`[amygdala] effective settings refresh failed: ${String(err)}`);
      }
      emit("amygdala2.status", status());
    },

    floorActive: () => floorActive,

    token: () => endpointToken,

    async decide(seam, hook, tabKey) {
      if (!deps) throw new Error("amygdala runtime not started");
      const t = now();
      lastSeam[seam] = t;
      const sessionKey = tabKey ?? str(hook.session_id) ?? "unknown";
      if (tabKey) seen.note(tabKey, hook, t);
      if (seam === "prompt") tracker.notePrompt(sessionKey, str(hook.prompt));
      else if (seam === "post-tool") tracker.recordToolResult(sessionKey, hook);
      // stop_hook_active is read for logging only.
      if (seam === "stop" && hook.stop_hook_active === true) {
        logger.info(`[amygdala] stop seam re-entered for ${sessionKey} (stop_hook_active)`);
      }
      const turnId = tracker.turnId(sessionKey);
      const cwd = str(hook.cwd);
      // Double-check reads only the bounded tail of this file at Stop (transcript.ts), never the whole transcript.
      const transcriptPath = str(hook.transcript_path);
      if (seam === "stop" && transcriptPath) {
        deps.contexts.get(sessionKey, turnId).transcriptPath = transcriptPath;
      }
      // Surprise compares the result with what the agent said it was about to do (2026-10-03: never filled before).
      const toolUseId = str(hook.tool_use_id);
      const expectation =
        seam === "post-tool" && transcriptPath && toolUseId
          ? (narrationBefore(transcriptPath, toolUseId) ?? undefined)
          : undefined;
      const payload: SeamInput = {
        seam,
        sessionKey,
        turnId,
        now: t,
        tool: str(hook.tool_name),
        toolInput: rec(hook.tool_input),
        toolResponse: hook.tool_response,
        toolUseId: str(hook.tool_use_id),
        prompt: str(hook.prompt),
        reply: str(hook.last_assistant_message),
        cwd,
      };
      const result: DecideResult = await decide(deps, {
        seam,
        payload,
        session: {
          ...tracker.sessionContext(sessionKey, cwd),
          ...(expectation ? { expectation } : {}),
        },
      });
      if (seam === "prompt") tracker.setRequest(sessionKey, result.situation.request.value);
      if (config.mode !== "enforce" && result.decision.enforced && result.hook.kind === "context") {
        const q = (pendingNotes.get(sessionKey) ?? []).filter((n) => t - n.ts < NOTE_TTL_MS);
        q.push({ text: result.hook.text, ts: t });
        pendingNotes.set(sessionKey, q.slice(-NOTE_CAP));
      }
      learn?.observe(result);
      for (const id of result.released ?? []) learn?.onAnswer(id, "evidence");
      if (result.hook.kind === "wait") {
        const r = result.decision.response;
        registry.register({
          interventionId: result.hook.interventionId,
          options:
            r.kind === "ask" ? r.options.map((x) => ({ id: x.id, label: x.label })) : undefined,
          ttlMs: result.hook.timeoutMs,
        });
      }
      return { decisionId: result.id, hook: result.hook };
    },

    takeNotes(sessionKey) {
      const q = pendingNotes.get(sessionKey) ?? [];
      pendingNotes.delete(sessionKey);
      const t = now();
      return q.filter((n) => t - n.ts < NOTE_TTL_MS).map((n) => n.text);
    },

    async replay(o) {
      if (!deps) throw new Error("amygdala runtime not started");
      const turnId = `${o.sessionKey}#replay-${o.at}`;
      const home = homedir();
      // Replaying the same exchange again replaces its earlier judgement (2026-09-30: two replays stacked).
      need().deleteReplayTurn(turnId);
      const request = buildSituation(
        { seam: "prompt", sessionKey: o.sessionKey, turnId, now: o.at, prompt: o.prompt },
        { workspaceRoot: home, homeDir: home },
      ).request.value;
      // The judge's verdicts carry its own clock; stamp them with the exchange's time too, or the chat places the
      // turn by today's verdict time instead of under its reply (2026-09-30).
      const live = deps.jev;
      const jev: DecideDeps["jev"] = {
        ask: async (s, qs, opt) => (await live.ask(s, qs, opt)).map((v) => ({ ...v, ts: o.at })),
      };
      return decide(
        { ...deps, now: () => o.at, jev },
        {
          seam: "stop",
          payload: { seam: "stop", sessionKey: o.sessionKey, turnId, now: o.at, reply: o.reply },
          session: { workspaceRoot: home, homeDir: home, request: request ?? undefined },
        },
      );
    },

    async waitFor(interventionId, timeoutMs) {
      const r = await registry.wait(interventionId, timeoutMs);
      if (r.answer === "timeout" && store) {
        const open = store
          .listInterventions({ state: "open" })
          .some((i) => i.id === interventionId);
        if (open) closeIntervention(interventionId, "expired");
      }
      return r;
    },

    answer(interventionId, answer) {
      if (!store || !ANSWER_RE.test(answer)) return false;
      let ok = registry.answer(interventionId, answer);
      if (!ok) {
        // No live long-poll (e.g. after a gateway restart): an open intervention can still be closed by the user.
        ok = store.listInterventions({ state: "open" }).some((i) => i.id === interventionId);
      }
      if (!ok) return false;
      closeIntervention(interventionId, answer === "keep-held" ? "denied" : "released");
      learn?.onAnswer(interventionId, answer);
      return true;
    },

    feed(q = {}) {
      const s = need();
      const since = q.sinceTs ?? dayBounds(now()).start;
      const limit = q.limit ?? 200;
      let decisions = q.sessionKey
        ? s.decisionsSinceForSession(since, q.sessionKey)
        : s.decisionsSince(since);
      decisions = decisions.slice(-limit).reverse();
      const book = deps?.book;
      const rebuilt = book
        ? rebuildEvents(s, book, { since, limit, sessionKey: q.sessionKey })
        : { decisionEvents: [], interventions: [] };
      const known = new Set(rebuilt.interventions.map((i) => i.id));
      const minimal: InterventionEvent[] = s
        .listInterventions({ sinceTs: since, limit })
        .filter((i) => !known.has(i.id) && q.sessionKey === undefined)
        .map((i) => ({
          id: i.id,
          decisionId: i.decisionId,
          ts: i.ts,
          sessionKey: "",
          turnId: "",
          kind: i.kind,
          state: i.state,
          title: "",
          chips: [],
        }));
      const t = now();
      const rate = config.cost.eurPerUsd;
      return {
        decisions,
        interventions: [...rebuilt.interventions, ...minimal],
        decisionEvents: rebuilt.decisionEvents,
        changes: learn ? learn.changes().map((c) => changeView(c, deps!.book)) : [],
        questions: book ? questionRows(s, book, dayBounds(t).start) : [],
        precedents: s.allPrecedents().length,
        counts: todayCounts(),
        status: status(),
        spend: {
          ...spendToday(s, t, rate),
          eur30: spendBetween(s, t - 30 * 86_400_000, t, rate).eur,
        },
      };
    },

    async canary() {
      if (!deps) throw new Error("amygdala runtime not started");
      // The floor: a step the hard rules must hold, timed. Text built so the source never contains the literal command.
      const step = ["rm", "-rf", "/" + "canary-target"].join(" ");
      const t0 = performance.now();
      const hit = evaluateRules("Bash", step, { enforcedOnly: true });
      const floorMs = Math.round((performance.now() - t0) * 10) / 10;
      // The judge: one synthetic question, only when it is configured; synthetic situations may leave the machine.
      let judgeMs: number | null = null;
      const q = deps.book.get("runs-or-quotes");
      if (q) {
        const probe = buildSituation(
          {
            seam: "pre-tool",
            sessionKey: "canary",
            turnId: "canary#1",
            now: now(),
            originKind: "synthetic",
            tool: "Bash",
            toolInput: { command: step },
          },
          { workspaceRoot: "/work/demo", homeDir: "/home/demo" },
        );
        const t1 = performance.now();
        const vs = await deps.jev.ask(probe, [q], { budgetMs: config.jev.timeoutMs });
        if (vs.some((v) => !v.skipped)) judgeMs = Math.round(performance.now() - t1);
      }
      return { heldBy: hit.decision === "hard_block" ? "hard-rule" : "none", floorMs, judgeMs };
    },

    status,
    refreshEffective,

    noteNotesDropped(n = 1): void {
      notesDropped += n;
    },

    learning(): Learning {
      if (!learn) throw new Error("amygdala runtime not started");
      return learn;
    },
  };
}
