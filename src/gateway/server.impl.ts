import { monitorEventLoopDelay } from "node:perf_hooks";
import { getActiveEmbeddedRunCount } from "../agents/embedded-agent-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { createDefaultDeps } from "../cli/deps.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import {
  getRuntimeConfig,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshot,
  recoverConfigFromLastKnownGood,
  registerConfigWriteListener,
  resolveConfigSnapshotHash,
} from "../config/io.js";
import { replaceConfigFile } from "../config/mutate.js";
import { isNixMode } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext } from "../infra/agent-events.js";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { isTruthyEnvValue, isVitestRuntimeEnv, logAcceptedEnvOption } from "../infra/env.js";
import { startDiagnosticBusBridge } from "../infra/events/bridge-diagnostic-bus.js";
import { startEventWriter, stopEventWriter } from "../infra/events/emit.js";
import {
  emitGatewayBoot,
  startGatewayHealthSampler,
} from "../infra/events/samplers/gateway-health.js";
import {
  startWorkerResourceSampler,
  stopWorkerResourceSampler,
} from "../infra/events/samplers/worker-resources.js";
import { resolveCommitHash } from "../infra/git-commit.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { releaseRestartDrain } from "../infra/restart-drain.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { VoiceWakeRoutingConfig } from "../infra/voicewake-routing.js";
import {
  type DiagnosticReplyPhaseProbe,
  getDiagnosticWorkCounts,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { getActiveBundledRuntimeDepsInstallCount } from "../plugins/bundled-runtime-deps-activity.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { runGlobalGatewayStopSafely } from "../plugins/hook-runner-global.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  getInspectableTaskRegistrySummary,
  stopTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { resolveGatewayAuth } from "./auth.js";
import { clearGatewayShutdownState } from "./gateway-shutdown-state.js";
import { findReplyOperation } from "./reply-registry-key.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createChannelManager } from "./server-channels.js";
import { resolveGatewayControlUiRootState } from "./server-control-ui-root.js";
import { buildGatewayCronService } from "./server-cron.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { createGatewayServerLiveState, type GatewayServerLiveState } from "./server-live-state.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { bootstrapGatewayNetworkRuntime } from "./server-network-runtime.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import { setFallbackGatewayContextResolver } from "./server-plugins.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import {
  activateGatewayScheduledServices,
  startGatewayRuntimeServices,
} from "./server-runtime-services.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  getRequiredSharedGatewaySessionGeneration,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import {
  createRuntimeSecretsActivator,
  loadGatewayStartupConfigSnapshot,
  prepareGatewayStartupConfig,
} from "./server-startup-config.js";
import { prepareGatewayPluginBootstrap } from "./server-startup-plugins.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./server-startup-unavailable-methods.js";
import { startGatewayEarlyRuntime, startGatewayPostAttachRuntime } from "./server-startup.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { attachGatewayWsHandlers } from "./server-ws-runtime.js";
import { createGatewayEventLoopHealthMonitor } from "./server/event-loop-health.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";
import { createReadinessChecker } from "./server/readiness.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

ensureOpenClawCliOnPath();

const MAX_MEDIA_TTL_HOURS = 24 * 7;

function resolveMediaCleanupTtlMs(ttlHoursRaw: number): number {
  const ttlHours = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS);
  const ttlMs = ttlHours * 60 * 60_000;
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) {
    throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
  }
  return ttlMs;
}

/**
 * FORK 2026-09-24 (TINKER_UI_DESIGN_BIBLE/prompt-queue.md §7 G6). The reply-phase probe for the
 * `[diagnostic] stuck session` line: the phase of the reply operation the session holds, so a turn
 * the gateway accepted but has not taken to the model reads `phase=queued` instead of looking like
 * a hung model call. src/logging/diagnostic.ts owns the seam and must not import reply-pipeline
 * code; src/gateway/ already reads the reply-run registry, so the gateway builds the probe.
 *
 * KEY SPELLINGS. The diagnostic state is keyed by the RAW inbound `ctx.SessionKey`
 * (dispatch-from-config.ts markProcessing); the reply operation by the key initSessionState
 * derives from it, which agent-runner uses as replySessionKey. A chat.send turn already dispatches
 * that key, so the raw lookup hits; a short, legacy, mixed-case or global-scope spelling does not.
 * findReplyOperation (reply-registry-key.ts, the one owner of that derivation) tries the key as
 * given, then the key initSessionState derives from it, and nothing else. Deliberately not the
 * store key: resolveSessionStoreKey folds a legacy `agent:main:<mainKey>` onto the default agent
 * (`agent:ops:work`), where a DIFFERENT dispatch's turn registers. On an exact hit, or with no
 * operation registered at all, the probe reads no config.
 *
 * Reads `phase=none` because the key alone cannot reach the operation: a native command's or a
 * bound conversation's retarget (the operation lives on another session), a channel plugin's own
 * explicit-key normaliser keyed on the inbound provider, and a state that carries only a
 * sessionId (the registry exports no sessionId-to-phase lookup). A throw is not caught here: the
 * seam reports it as `phase=unknown`.
 */
export function createGatewayReplyPhaseProbe(
  getConfig: () => OpenClawConfig = getRuntimeConfig,
): DiagnosticReplyPhaseProbe {
  return ({ sessionKey }) => findReplyOperation(sessionKey, getConfig)?.phase;
}

/**
 * Starts the diagnostic heartbeat the way the gateway runs it: the config read live on every tick,
 * and the reply-phase probe on the stuck-session line. Startup calls this and nothing else, so a
 * test starts exactly what production starts (diagnostic-phase-wiring.test.ts).
 */
export function startGatewayDiagnosticHeartbeat(
  getConfig: () => OpenClawConfig = getRuntimeConfig,
): void {
  startDiagnosticHeartbeat(undefined, {
    getConfig,
    replyPhaseProbe: createGatewayReplyPhaseProbe(getConfig),
  });
}

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");

let cachedChannelRuntimePromise: Promise<PluginRuntime["channel"]> | null = null;
let cachedStartupChannelRuntimePromise: Promise<ChannelRuntimeSurface> | null = null;

function getChannelRuntime() {
  cachedChannelRuntimePromise ??= import("../plugins/runtime/runtime-channel.js").then(
    ({ createRuntimeChannel }) => createRuntimeChannel(),
  );
  return cachedChannelRuntimePromise;
}

function getStartupChannelRuntime() {
  cachedStartupChannelRuntimePromise ??=
    import("../plugins/runtime/channel-runtime-contexts.js").then(
      ({ createChannelRuntimeContextRegistry }) => ({
        runtimeContexts: createChannelRuntimeContextRegistry(),
      }),
    );
  return cachedStartupChannelRuntimePromise;
}

async function closeMcpLoopbackServerOnDemand(): Promise<void> {
  const { closeMcpLoopbackServer } = await import("./mcp-http.js");
  await closeMcpLoopbackServer();
}

let gatewayCloseModulePromise: Promise<typeof import("./server-close.js")> | null = null;

function loadGatewayCloseModule(): Promise<typeof import("./server-close.js")> {
  gatewayCloseModulePromise ??= import("./server-close.js");
  return gatewayCloseModulePromise;
}

const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);

function createGatewayStartupTrace() {
  const enabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
  const eventLoopDelay = enabled ? monitorEventLoopDelay({ resolution: 10 }) : undefined;
  eventLoopDelay?.enable();
  const started = performance.now();
  let last = started;
  const formatMetric = (key: string, value: number | string) =>
    `${key}=${typeof value === "number" ? value.toFixed(1) : value}`;
  const readEventLoopMaxMs = () => {
    if (!eventLoopDelay) {
      return 0;
    }
    const maxMs = eventLoopDelay.max / 1_000_000;
    eventLoopDelay.reset();
    return maxMs;
  };
  const emit = (
    name: string,
    durationMs: number,
    totalMs: number,
    extras: ReadonlyArray<readonly [string, number | string]> = [],
  ) => {
    if (enabled) {
      const metrics = [
        `eventLoopMax=${readEventLoopMaxMs().toFixed(1)}ms`,
        ...extras.map(([key, value]) => formatMetric(key, value)),
      ].join(" ");
      log.info(
        `startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms ${metrics}`,
      );
    }
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
      if (name === "ready") {
        eventLoopDelay?.disable();
      }
    },
    detail(name: string, metrics: ReadonlyArray<readonly [string, number | string]>) {
      if (!enabled) {
        return;
      }
      log.info(
        `startup trace: ${name} ${metrics.map(([key, value]) => formatMetric(key, value)).join(" ")}`,
      );
    },
    async measure<T>(name: string, run: () => Promise<T> | T): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

type AuthRateLimitConfig = Parameters<typeof createAuthRateLimiter>[0];

function createGatewayAuthRateLimiters(rateLimitConfig: AuthRateLimitConfig | undefined): {
  rateLimiter?: AuthRateLimiter;
  browserRateLimiter: AuthRateLimiter;
} {
  const rateLimiter = rateLimitConfig ? createAuthRateLimiter(rateLimitConfig) : undefined;
  // Browser-origin WS auth attempts always use loopback-non-exempt throttling.
  const browserRateLimiter = createAuthRateLimiter({
    ...rateLimitConfig,
    exemptLoopback: false,
  });
  return { rateLimiter, browserRateLimiter };
}

export type GatewayServer = {
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer loopback, else LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/responses` (OpenResponses API).
   * Default: config `gateway.http.endpoints.responses.enabled` (or false when absent).
   */
  openResponsesEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
  /**
   * Test-only: override the setup wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
  /**
   * Let post-listen sidecars (channels, plugin services) finish in the background.
   * Defaults to false so gateway startup waits until sidecars are ready.
   */
  deferStartupSidecars?: boolean;
  /**
   * Optional startup timestamp used for concise readiness logging.
   */
  startupStartedAt?: number;
};

type SetupWizardRunner = NonNullable<GatewayServerOptions["wizardRunner"]>;

const runDefaultSetupWizard: SetupWizardRunner = async (...args) => {
  const { runSetupWizard } = await import("../wizard/setup.js");
  return runSetupWizard(...args);
};

export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  // FORK 2026-09-29 (lifecycles.md L4b): an in-process (SIGUSR1) restart keeps module state, so the
  // previous close handler's "shutting down" mark must not outlive it into the new server.
  clearGatewayShutdownState();
  // The same holds for the restart drain: left active, it would hold every new run at its first
  // model call. Releasing also lets go of whatever this process still holds (a cc-bridge worker
  // frozen for the stop that turned out to be in-process); aborted turns ignore a release.
  void releaseRestartDrain();
  bootstrapGatewayNetworkRuntime();

  const minimalTestGateway =
    isVitestRuntimeEnv() && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";

  // Ensure all default port derivations (browser/canvas) see the actual runtime port.
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM",
    description: "raw stream logging enabled",
  });
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM_PATH",
    description: "raw stream log path override",
  });
  const startupTrace = createGatewayStartupTrace();

  const startupConfigLoad = await startupTrace.measure("config.snapshot", () =>
    loadGatewayStartupConfigSnapshot({
      minimalTestGateway,
      log,
      measure: (name, run) => startupTrace.measure(name, run),
    }),
  );
  const configSnapshot = startupConfigLoad.snapshot;

  const emitSecretsStateEvent = (
    code: "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED",
    message: string,
    cfg: OpenClawConfig,
  ) => {
    enqueueSystemEvent(`[${code}] ${message}`, {
      sessionKey: resolveMainSessionKey(cfg),
      contextKey: code,
    });
  };
  const activateRuntimeSecrets = createRuntimeSecretsActivator({
    logSecrets,
    emitStateEvent: emitSecretsStateEvent,
  });

  let cfgAtStart: OpenClawConfig;
  let startupInternalWriteHash: string | null = null;
  let startupLastGoodSnapshot = configSnapshot;
  const startupActivationSourceConfig = configSnapshot.sourceConfig;
  const startupRuntimeConfig = applyConfigOverrides(configSnapshot.config);
  const authBootstrap = await startupTrace.measure("config.auth", () =>
    prepareGatewayStartupConfig({
      configSnapshot,
      authOverride: opts.auth,
      tailscaleOverride: opts.tailscale,
      activateRuntimeSecrets,
      persistStartupAuth: startupConfigLoad.degradedProviderApi !== true,
    }),
  );
  cfgAtStart = authBootstrap.cfg;
  if (authBootstrap.generatedToken) {
    if (authBootstrap.persistedGeneratedToken) {
      log.info(
        "Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).",
      );
    } else {
      log.warn(
        "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.",
      );
    }
  }
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  setDiagnosticsEnabledForProcess(diagnosticsEnabled);
  if (diagnosticsEnabled) {
    startGatewayDiagnosticHeartbeat();
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
  setPreRestartDeferralCheck(
    () =>
      getTotalQueueSize() +
      getTotalPendingReplies() +
      getActiveEmbeddedRunCount() +
      getActiveBundledRuntimeDepsInstallCount() +
      getInspectableTaskRegistrySummary().active,
  );
  // Unconditional startup migration: seed gateway.controlUi.allowedOrigins for existing
  // non-loopback installs that upgraded to v2026.2.26+ without required origins.
  const controlUiSeed = minimalTestGateway
    ? { config: cfgAtStart, persistedAllowedOriginsSeed: false }
    : await startupTrace.measure("control-ui.seed", () =>
        maybeSeedControlUiAllowedOriginsAtStartup({
          config: cfgAtStart,
          writeConfig: async (nextConfig) => {
            await replaceConfigFile({
              nextConfig,
              afterWrite: { mode: "auto" },
            });
          },
          log,
          runtimeBind: opts.bind,
          runtimePort: port,
        }),
      );
  cfgAtStart = controlUiSeed.config;
  // Capture the final config hash only after startup writes (plugin auto-enable,
  // auth token generation, control-UI origin seeding) so the config reloader can
  // suppress its own persistence events without rereading config on every boot.
  if (
    startupConfigLoad.wroteConfig ||
    authBootstrap.persistedGeneratedToken ||
    controlUiSeed.persistedAllowedOriginsSeed
  ) {
    const startupSnapshot = await startupTrace.measure("config.final-snapshot", () =>
      readConfigFileSnapshot(),
    );
    startupInternalWriteHash = startupSnapshot.hash ?? null;
    startupLastGoodSnapshot = startupSnapshot;
  }
  const pluginBootstrap = await startupTrace.measure("plugins.bootstrap", () =>
    prepareGatewayPluginBootstrap({
      cfgAtStart,
      activationSourceConfig: startupActivationSourceConfig,
      startupRuntimeConfig,
      pluginMetadataSnapshot: startupConfigLoad.pluginMetadataSnapshot,
      minimalTestGateway,
      log,
    }),
  );
  const {
    gatewayPluginConfigAtStart,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    pluginLookUpTable,
    baseMethods,
  } = pluginBootstrap;
  setCurrentPluginMetadataSnapshot(pluginLookUpTable, { config: gatewayPluginConfigAtStart });
  if (pluginLookUpTable) {
    const metrics = pluginLookUpTable.metrics;
    startupTrace.detail("plugins.lookup-table", [
      ["registrySnapshotMs", metrics.registrySnapshotMs],
      ["manifestRegistryMs", metrics.manifestRegistryMs],
      ["startupPlanMs", metrics.startupPlanMs],
      ["ownerMapsMs", metrics.ownerMapsMs],
      ["totalMs", metrics.totalMs],
      ["indexPlugins", String(metrics.indexPluginCount)],
      ["manifestPlugins", String(metrics.manifestPluginCount)],
      ["startupPlugins", String(metrics.startupPluginCount)],
      ["deferredChannelPlugins", String(metrics.deferredChannelPluginCount)],
    ]);
  }
  let { pluginRegistry, baseGatewayMethods } = pluginBootstrap;
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as unknown as Record<ChannelId, RuntimeEnv>;
  const listActiveGatewayMethods = (nextBaseGatewayMethods: string[]) =>
    Array.from(
      new Set([
        ...nextBaseGatewayMethods,
        ...listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []),
      ]),
    );
  const runtimeConfig = await startupTrace.measure("runtime.config", () =>
    resolveGatewayRuntimeConfig({
      cfg: cfgAtStart,
      port,
      bind: opts.bind,
      host: opts.host,
      controlUiEnabled: opts.controlUiEnabled,
      openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
      openResponsesEnabled: opts.openResponsesEnabled,
      auth: opts.auth,
      tailscale: opts.tailscale,
    }),
  );
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    controlUiBasePath,
    controlUiRoot: controlUiRootOverride,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
  } = runtimeConfig;
  const getResolvedAuth = () =>
    resolveGatewayAuth({
      authConfig:
        getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth ?? getRuntimeConfig().gateway?.auth,
      authOverride: opts.auth,
      env: process.env,
      tailscaleMode,
    });
  const resolveSharedGatewaySessionGenerationForConfig = (config: OpenClawConfig) =>
    resolveSharedGatewaySessionGeneration(
      resolveGatewayAuth({
        authConfig: config.gateway?.auth,
        authOverride: opts.auth,
        env: process.env,
        tailscaleMode,
      }),
    );
  const resolveCurrentSharedGatewaySessionGeneration = () =>
    resolveSharedGatewaySessionGeneration(getResolvedAuth());
  const resolveSharedGatewaySessionGenerationForRuntimeSnapshot = () =>
    resolveSharedGatewaySessionGeneration(
      resolveGatewayAuth({
        authConfig: getRuntimeConfig().gateway?.auth,
        authOverride: opts.auth,
        env: process.env,
        tailscaleMode,
      }),
    );
  const sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState = {
    current: resolveCurrentSharedGatewaySessionGeneration(),
    required: null,
  };
  const initialHooksConfig = runtimeConfig.hooksConfig;
  const initialHookClientIpConfig = resolveHookClientIpConfig(cfgAtStart);
  const canvasHostEnabled = runtimeConfig.canvasHostEnabled;

  // Create auth rate limiters used by connect/auth flows.
  const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
  const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } =
    createGatewayAuthRateLimiters(rateLimitConfig);

  const controlUiRootState = await startupTrace.measure("control-ui.root", () =>
    resolveGatewayControlUiRootState({
      controlUiRootOverride,
      controlUiEnabled,
      gatewayRuntime,
      log,
    }),
  );

  const wizardRunner = opts.wizardRunner ?? runDefaultSetupWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();

  const deps = createDefaultDeps();
  let runtimeState: GatewayServerLiveState | null = null;
  let canvasHostServer: CanvasHostServer | null = null;
  const gatewayTls = await startupTrace.measure("tls.runtime", () =>
    loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls")),
  );
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const serverStartedAt = Date.now();
  const readinessEventLoopHealth = createGatewayEventLoopHealthMonitor();
  let startupSidecarsReady = minimalTestGateway;
  const channelManager = createChannelManager({
    getRuntimeConfig: () =>
      applyPluginAutoEnable({
        config: getRuntimeConfig(),
        env: process.env,
      }).config,
    channelLogs,
    channelRuntimeEnvs,
    resolveChannelRuntime: getChannelRuntime,
    resolveStartupChannelRuntime: getStartupChannelRuntime,
    startupTrace,
  });
  const getReadiness = createReadinessChecker({
    channelManager,
    startedAt: serverStartedAt,
    getStartupPending: () => !startupSidecarsReady,
    getEventLoopHealth: readinessEventLoopHealth.snapshot,
  });
  log.info("starting HTTP server...");
  const {
    canvasHost,
    releasePluginRouteRegistry,
    httpServer,
    httpServers,
    httpBindHosts,
    startListening,
    wss,
    preauthConnectionBudget,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    chatDeltaLastBroadcastLen,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
  } = await startupTrace.measure("runtime.state", () =>
    createGatewayRuntimeState({
      cfg: cfgAtStart,
      bindHost,
      port,
      controlUiEnabled,
      controlUiBasePath,
      controlUiRoot: controlUiRootState,
      openAiChatCompletionsEnabled,
      openAiChatCompletionsConfig,
      openResponsesEnabled,
      openResponsesConfig,
      strictTransportSecurityHeader,
      resolvedAuth,
      rateLimiter: authRateLimiter,
      gatewayTls,
      getResolvedAuth,
      hooksConfig: () => runtimeState?.hooksConfig ?? initialHooksConfig,
      getHookClientIpConfig: () => runtimeState?.hookClientIpConfig ?? initialHookClientIpConfig,
      pluginRegistry,
      pinChannelRegistry: !minimalTestGateway,
      deps,
      canvasRuntime,
      canvasHostEnabled,
      allowCanvasHostInTests: opts.allowCanvasHostInTests,
      logCanvas,
      log,
      logHooks,
      logPlugins,
      getReadiness,
    }),
  );
  const {
    nodeRegistry,
    nodePresenceTimers,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll,
    broadcastVoiceWakeChanged,
    hasMobileNodeConnected,
  } = createGatewayNodeSessionRuntime({ broadcast });
  applyGatewayLaneConcurrency(cfgAtStart);

  // FORK 2026-09-24 (logging.md §9 step 3): start the structured-events writer. A no-op when
  // OPENCLAW_EVENTS_DB=0, and refused by paths.ts under a test runner; stopped in runClosePrelude.
  startEventWriter();
  // FORK 2026-09-25 (logging.md §4.9, §9 step 5): the per-worker memory and CPU trend sampler.
  // A no-op while the writer is disabled; stopped in runClosePrelude, before the writer.
  startWorkerResourceSampler();

  // FORK 2026-09-25 (logging.md §9 step 4): the gateway's own rows. The diagnostic bridge maps
  // three bus types (gw.liveness.warning, gw.memory.pressure, gw.session.stuck) and the
  // instrument-liveness report (instrument.census, instrument.transition); gw.health.sample reads
  // a stall-clock monitor of its OWN every 30 s, whether or not diagnostics are enabled. Started
  // after the writer on purpose: both install nothing while no writer runs. gw.boot is emitted
  // once the deferred channel plugins have loaded (below). All stop in runClosePrelude, before
  // the writer's final flush.
  const stopDiagnosticBusBridge = startDiagnosticBusBridge();
  const gatewayHealthLoop = createGatewayEventLoopHealthMonitor();
  const gatewayHealthSampler = startGatewayHealthSampler({
    readLoopHealth: gatewayHealthLoop.snapshot,
    readWork: getDiagnosticWorkCounts,
  });

  runtimeState = createGatewayServerLiveState({
    hooksConfig: initialHooksConfig,
    hookClientIpConfig: initialHookClientIpConfig,
    cronState: buildGatewayCronService({
      cfg: cfgAtStart,
      deps,
      broadcast,
    }),
    gatewayMethods: listActiveGatewayMethods(baseGatewayMethods),
  });
  deps.cron = runtimeState.cronState.cron;

  const runClosePrelude = async () => {
    clearCurrentPluginMetadataSnapshot();
    // FORK 2026-09-25 (logging.md §9 step 4): stop the gateway's own row producers before the
    // writer, so its final flush below carries their last rows and nothing emits into it after.
    stopDiagnosticBusBridge();
    gatewayHealthSampler.stop();
    gatewayHealthLoop.stop();
    // FORK 2026-09-25 (logging.md §4.9): the worker-resources sampler, before the writer: a sample
    // taken after its stop would only be counted as dropped.
    stopWorkerResourceSampler();
    // FORK 2026-09-24 (logging.md §7.5 Shutdown): flush the events queue (2 s deadline) and stop
    // the writer thread; records still queued are counted in its final journal line.
    await stopEventWriter().catch((err) => log.warn(`events writer shutdown: ${String(err)}`));
    const { runGatewayClosePrelude } = await loadGatewayCloseModule();
    await runGatewayClosePrelude({
      ...(diagnosticsEnabled ? { stopDiagnostics: stopDiagnosticHeartbeat } : {}),
      clearSkillsRefreshTimer: () => {
        if (!runtimeState?.skillsRefreshTimer) {
          return;
        }
        clearTimeout(runtimeState.skillsRefreshTimer);
        runtimeState.skillsRefreshTimer = null;
      },
      skillsChangeUnsub: runtimeState.skillsChangeUnsub,
      ...(authRateLimiter ? { disposeAuthRateLimiter: () => authRateLimiter.dispose() } : {}),
      disposeBrowserAuthRateLimiter: () => browserAuthRateLimiter.dispose(),
      stopModelPricingRefresh: runtimeState.stopModelPricingRefresh,
      stopChannelHealthMonitor: () => runtimeState?.channelHealthMonitor?.stop(),
      stopReadinessEventLoopHealth: readinessEventLoopHealth.stop,
      clearSecretsRuntimeSnapshot,
      closeMcpServer: closeMcpLoopbackServerOnDemand,
    });
  };
  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;
  const refreshGatewayHealthSnapshotWithRuntime: typeof refreshGatewayHealthSnapshot = (opts) =>
    refreshGatewayHealthSnapshot({
      ...opts,
      getRuntimeSnapshot,
    });
  const createCloseHandler =
    () => async (opts?: { reason?: string; restartExpectedMs?: number | null }) => {
      const { createGatewayCloseHandler } = await loadGatewayCloseModule();
      await createGatewayCloseHandler({
        bonjourStop: runtimeState.bonjourStop,
        tailscaleCleanup: runtimeState.tailscaleCleanup,
        canvasHost,
        canvasHostServer,
        releasePluginRouteRegistry,
        stopChannel,
        pluginServices: runtimeState.pluginServices,
        cron: runtimeState.cronState.cron,
        heartbeatRunner: runtimeState.heartbeatRunner,
        updateCheckStop: runtimeState.stopGatewayUpdateCheck,
        stopTaskRegistryMaintenance,
        nodePresenceTimers,
        broadcast,
        tickInterval: runtimeState.tickInterval,
        healthInterval: runtimeState.healthInterval,
        dedupeCleanup: runtimeState.dedupeCleanup,
        mediaCleanup: runtimeState.mediaCleanup,
        agentUnsub: runtimeState.agentUnsub,
        heartbeatUnsub: runtimeState.heartbeatUnsub,
        transcriptUnsub: runtimeState.transcriptUnsub,
        lifecycleUnsub: runtimeState.lifecycleUnsub,
        chatRunState,
        clients,
        configReloader: runtimeState.configReloader,
        wss,
        httpServer,
        httpServers,
      })(opts);
    };
  let clearFallbackGatewayContextForServer = () => {};
  const closeOnStartupFailure = async () => {
    try {
      await runClosePrelude();
      await createCloseHandler()({ reason: "gateway startup failed" });
    } finally {
      clearFallbackGatewayContextForServer();
    }
  };
  const broadcastVoiceWakeRoutingChanged = (config: VoiceWakeRoutingConfig) => {
    broadcast("voicewake.routing.changed", { config }, { dropIfSlow: true });
  };

  try {
    const earlyRuntime = await startupTrace.measure("runtime.early", () =>
      startGatewayEarlyRuntime({
        minimalTestGateway,
        cfgAtStart,
        port,
        gatewayTls,
        tailscaleMode,
        log,
        logDiscovery,
        nodeRegistry,
        pluginRegistry,
        broadcast,
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
        nodeSendToAllSubscribed,
        getPresenceVersion,
        getHealthVersion,
        refreshGatewayHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
        logHealth,
        dedupe,
        chatAbortControllers,
        chatRunState,
        chatRunBuffers,
        chatDeltaSentAt,
        chatDeltaLastBroadcastLen,
        removeChatRun,
        agentRunSeq,
        nodeSendToSession,
        ...(typeof cfgAtStart.media?.ttlHours === "number"
          ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.media.ttlHours) }
          : {}),
        skillsRefreshDelayMs: runtimeState.skillsRefreshDelayMs,
        getSkillsRefreshTimer: () => runtimeState.skillsRefreshTimer,
        setSkillsRefreshTimer: (timer) => {
          runtimeState.skillsRefreshTimer = timer;
        },
        getRuntimeConfig,
      }),
    );
    runtimeState.bonjourStop = earlyRuntime.bonjourStop;
    runtimeState.skillsChangeUnsub = earlyRuntime.skillsChangeUnsub;
    if (earlyRuntime.maintenance) {
      runtimeState.tickInterval = earlyRuntime.maintenance.tickInterval;
      runtimeState.healthInterval = earlyRuntime.maintenance.healthInterval;
      runtimeState.dedupeCleanup = earlyRuntime.maintenance.dedupeCleanup;
      runtimeState.mediaCleanup = earlyRuntime.maintenance.mediaCleanup;
    }

    Object.assign(
      runtimeState,
      startGatewayEventSubscriptions({
        broadcast,
        broadcastToConnIds,
        nodeSendToSession,
        agentRunSeq,
        chatRunState,
        resolveSessionKeyForRun,
        clearAgentRunContext,
        toolEventRecipients,
        sessionEventSubscribers,
        sessionMessageSubscribers,
        chatAbortControllers,
      }),
    );

    Object.assign(
      runtimeState,
      startGatewayRuntimeServices({
        minimalTestGateway,
        cfgAtStart,
        channelManager,
        log,
        pluginLookUpTable,
      }),
    );

    const { execApprovalManager, pluginApprovalManager, extraHandlers } = createGatewayAuxHandlers({
      log,
      activateRuntimeSecrets,
      sharedGatewaySessionGenerationState,
      resolveSharedGatewaySessionGenerationForConfig,
      clients,
      startChannel,
      stopChannel,
      logChannels,
    });

    const canvasHostServerPort = (canvasHostServer as CanvasHostServer | null)?.port;

    const unavailableGatewayMethods = new Set<string>(
      minimalTestGateway ? [] : STARTUP_UNAVAILABLE_GATEWAY_METHODS,
    );
    const gatewayRequestContext = createGatewayRequestContext({
      deps,
      runtimeState,
      getRuntimeConfig,
      execApprovalManager,
      pluginApprovalManager,
      loadGatewayModelCatalog,
      getHealthCache,
      refreshHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
      logHealth,
      logGateway: log,
      incrementPresenceVersion,
      getHealthVersion,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      nodeSendToAllSubscribed,
      nodeSubscribe,
      nodeUnsubscribe,
      nodeUnsubscribeAll,
      hasConnectedMobileNode: hasMobileNodeConnected,
      clients,
      enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig: OpenClawConfig) => {
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: sharedGatewaySessionGenerationState,
          nextConfig,
          resolveRuntimeSnapshotGeneration: resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
          clients,
        });
      },
      nodeRegistry,
      agentRunSeq,
      chatAbortControllers,
      chatAbortedRuns: chatRunState.abortedRuns,
      chatRunBuffers: chatRunState.buffers,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
      addChatRun,
      removeChatRun,
      subscribeSessionEvents: sessionEventSubscribers.subscribe,
      unsubscribeSessionEvents: sessionEventSubscribers.unsubscribe,
      subscribeSessionMessageEvents: sessionMessageSubscribers.subscribe,
      unsubscribeSessionMessageEvents: sessionMessageSubscribers.unsubscribe,
      unsubscribeAllSessionEvents: (connId: string) => {
        sessionEventSubscribers.unsubscribe(connId);
        sessionMessageSubscribers.unsubscribeAll(connId);
      },
      getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
      registerToolEventRecipient: toolEventRecipients.add,
      dedupe,
      wizardSessions,
      findRunningWizard,
      purgeWizardSession,
      getRuntimeSnapshot,
      startChannel,
      stopChannel,
      markChannelLoggedOut,
      wizardRunner,
      broadcastVoiceWakeChanged,
      unavailableGatewayMethods,
      broadcastVoiceWakeRoutingChanged,
    });

    const fallbackGatewayContextCleanup: unknown = setFallbackGatewayContextResolver(
      () => gatewayRequestContext,
    );
    clearFallbackGatewayContextForServer =
      typeof fallbackGatewayContextCleanup === "function"
        ? () => {
            fallbackGatewayContextCleanup();
          }
        : () => {};

    if (!minimalTestGateway) {
      if (deferredConfiguredChannelPluginIds.length > 0) {
        const { reloadDeferredGatewayPlugins } = await import("./server-plugin-bootstrap.js");
        ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = reloadDeferredGatewayPlugins({
          cfg: gatewayPluginConfigAtStart,
          activationSourceConfig: startupActivationSourceConfig,
          workspaceDir: defaultWorkspaceDir,
          log,
          coreGatewayMethodNames: baseMethods,
          baseMethods,
          pluginIds: startupPluginIds,
          pluginLookUpTable,
          logDiagnostics: false,
        }));
        runtimeState.gatewayMethods = listActiveGatewayMethods(baseGatewayMethods);
      }
    }

    // FORK 2026-09-25 (logging.md §4.1 gw.boot): once per boot, after the deferred channel
    // plugins reloaded `pluginRegistry`, so plugin_count is the set this boot actually serves.
    // Each source is read inside emitGatewayBoot's guard: a failing one is a NULL, never a
    // failed boot.
    emitGatewayBoot({
      commit: () => resolveCommitHash({ moduleUrl: import.meta.url }),
      pluginCount: () =>
        pluginRegistry.plugins.filter((plugin) => plugin.status === "loaded").length,
      configHash: () => resolveConfigSnapshotHash(startupLastGoodSnapshot),
    });

    attachGatewayWsHandlers({
      wss,
      clients,
      preauthConnectionBudget,
      port,
      gatewayHost: bindHost ?? undefined,
      canvasHostEnabled: Boolean(canvasHost),
      canvasHostServerPort,
      resolvedAuth,
      getResolvedAuth,
      getRequiredSharedGatewaySessionGeneration: () =>
        getRequiredSharedGatewaySessionGeneration(sharedGatewaySessionGenerationState),
      rateLimiter: authRateLimiter,
      browserRateLimiter: browserAuthRateLimiter,
      gatewayMethods: runtimeState.gatewayMethods,
      events: GATEWAY_EVENTS,
      logGateway: log,
      logHealth,
      logWsControl,
      extraHandlers: { ...pluginRegistry.gatewayHandlers, ...extraHandlers },
      broadcast,
      context: gatewayRequestContext,
    });
    await startListening();
    startupTrace.mark("http.bound");
    const sessionDeliveryRecoveryMaxEnqueuedAt = Date.now();
    ({
      stopGatewayUpdateCheck: runtimeState.stopGatewayUpdateCheck,
      tailscaleCleanup: runtimeState.tailscaleCleanup,
      pluginServices: runtimeState.pluginServices,
    } = await startupTrace.measure("runtime.post-attach", () =>
      startGatewayPostAttachRuntime({
        minimalTestGateway,
        cfgAtStart,
        bindHost,
        bindHosts: httpBindHosts,
        port,
        tlsEnabled: gatewayTls.enabled,
        log,
        isNixMode,
        startupStartedAt: opts.startupStartedAt,
        broadcast,
        tailscaleMode,
        resetOnExit: tailscaleConfig.resetOnExit ?? false,
        controlUiBasePath,
        logTailscale,
        gatewayPluginConfigAtStart,
        pluginRegistry,
        defaultWorkspaceDir,
        deps,
        startChannels,
        logHooks,
        logChannels,
        unavailableGatewayMethods,
        getCronService: () =>
          runtimeState?.cronState.cron as PluginHookGatewayCronService | undefined,
        onPluginServices: (pluginServices) => {
          runtimeState.pluginServices = pluginServices;
        },
        onSidecarsReady: () => {
          startupSidecarsReady = true;
        },
        startupTrace,
        deferSidecars: opts.deferStartupSidecars === true,
      }),
    ));
    startupTrace.mark("ready");

    const activated = activateGatewayScheduledServices({
      minimalTestGateway,
      cfgAtStart,
      deps,
      sessionDeliveryRecoveryMaxEnqueuedAt,
      cron: runtimeState.cronState.cron,
      logCron,
      log,
    });
    runtimeState.heartbeatRunner = activated.heartbeatRunner;

    const { startManagedGatewayConfigReloader } = await import("./server-reload-handlers.js");
    runtimeState.configReloader = startManagedGatewayConfigReloader({
      minimalTestGateway,
      initialConfig: cfgAtStart,
      initialCompareConfig: startupLastGoodSnapshot.sourceConfig,
      initialInternalWriteHash: startupInternalWriteHash,
      watchPath: configSnapshot.path,
      readSnapshot: readConfigFileSnapshot,
      recoverSnapshot: recoverConfigFromLastKnownGood,
      promoteSnapshot: promoteConfigSnapshotToLastKnownGood,
      subscribeToWrites: registerConfigWriteListener,
      deps,
      broadcast,
      getState: () => ({
        hooksConfig: runtimeState.hooksConfig,
        hookClientIpConfig: runtimeState.hookClientIpConfig,
        heartbeatRunner: runtimeState.heartbeatRunner,
        cronState: runtimeState.cronState,
        channelHealthMonitor: runtimeState.channelHealthMonitor,
      }),
      setState: (nextState) => {
        runtimeState.hooksConfig = nextState.hooksConfig;
        runtimeState.hookClientIpConfig = nextState.hookClientIpConfig;
        runtimeState.heartbeatRunner = nextState.heartbeatRunner;
        runtimeState.cronState = nextState.cronState;
        deps.cron = runtimeState.cronState.cron;
        runtimeState.channelHealthMonitor = nextState.channelHealthMonitor;
      },
      startChannel,
      stopChannel,
      logHooks,
      logChannels,
      logCron,
      logReload,
      channelManager,
      activateRuntimeSecrets,
      resolveSharedGatewaySessionGenerationForConfig,
      sharedGatewaySessionGenerationState,
      clients,
    });
    await promoteConfigSnapshotToLastKnownGood(startupLastGoodSnapshot).catch((err) => {
      log.warn(`gateway: failed to promote config last-known-good backup: ${String(err)}`);
    });
  } catch (err) {
    await closeOnStartupFailure();
    throw err;
  }

  const close = createCloseHandler();

  return {
    close: async (opts) => {
      try {
        // Run gateway_stop plugin hook before shutdown
        await runGlobalGatewayStopSafely({
          event: { reason: opts?.reason ?? "gateway stopping" },
          ctx: { port },
          onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`),
        });
        await runClosePrelude();
        await close(opts);
      } finally {
        clearFallbackGatewayContextForServer();
      }
    },
  };
}
