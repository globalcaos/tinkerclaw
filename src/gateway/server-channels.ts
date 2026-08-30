import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  getLoadedChannelPluginOrigin,
  listChannelPlugins,
} from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startChannelApprovalHandlerBootstrap } from "../infra/approval-handler-bootstrap.js";
import { type BackoffPolicy, computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { createTaskScopedChannelRuntime } from "../infra/channel-runtime-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAccountEntry, resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";
export type { ChannelRuntimeSnapshot };

const CHANNEL_RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};
const MAX_RESTART_ATTEMPTS = 10;
const CHANNEL_STOP_ABORT_TIMEOUT_MS = 5_000;
/**
 * Hard budget for the per-attempt account teardown hook.
 *
 * The crash / auto-restart chain must never wedge behind a plugin whose
 * `stopAccount` fails to return, so the wait is capped and the restart
 * continues after a warning rather than stalling the account forever.
 */
const CHANNEL_TEARDOWN_TIMEOUT_MS = 5_000;

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;
  starting: Map<string, Promise<void>>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
  /**
   * Once-guarded teardown closure for the account's CURRENT attempt.
   *
   * Registered at task hand-off and dropped with the task. Both the crash /
   * auto-restart chain and the manual `stopChannel` path resolve through this
   * entry so the plugin teardown executes exactly once per attempt even when a
   * manual stop races a clean exit.
   */
  teardowns: Map<string, () => Promise<void>>;
};

type HealthMonitorConfig = {
  healthMonitor?: {
    enabled?: boolean;
  };
};

type ChannelHealthMonitorConfig = HealthMonitorConfig & {
  accounts?: Record<string, HealthMonitorConfig>;
};

type GatewayStartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

function createRuntimeStore(): ChannelRuntimeStore {
  return {
    aborts: new Map(),
    starting: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
    teardowns: new Map(),
  };
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") {
    return true;
  }
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

function resolveDefaultRuntime(channelId: ChannelId): ChannelAccountSnapshot {
  const plugin = getChannelPlugin(channelId);
  return plugin?.status?.defaultRuntime ?? { accountId: DEFAULT_ACCOUNT_ID };
}

function cloneDefaultRuntime(channelId: ChannelId, accountId: string): ChannelAccountSnapshot {
  return { ...resolveDefaultRuntime(channelId), accountId };
}

async function waitForChannelStopGracefully(task: Promise<unknown> | undefined, timeoutMs: number) {
  if (!task) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    timer.unref?.();
    const resolveSettled = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    void task.then(resolveSettled, resolveSettled);
  });
}

/**
 * Runs `run()` under a hard time budget.
 *
 * Resolves `true` when `run()` settles inside `timeoutMs`, `false` when the
 * budget expires first — in which case the pending work is abandoned and never
 * awaited again. A rejection counts as "settled": callers own their error
 * handling inside `run()`, and a throwing hook must not wedge the caller.
 */
async function runBounded(run: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    timer.unref?.();
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    void Promise.resolve().then(run).then(finish, finish);
  });
}

function applyDescribedAccountFields(
  next: ChannelAccountSnapshot,
  described: ChannelAccountSnapshot | undefined,
) {
  if (!described) {
    next.configured ??= true;
    return next;
  }
  if (typeof described.configured === "boolean") {
    next.configured = described.configured;
  } else {
    next.configured ??= true;
  }
  if (described.mode !== undefined) {
    next.mode = described.mode;
  }
  return next;
}

type ChannelManagerOptions = {
  getRuntimeConfig: () => OpenClawConfig;
  channelLogs: Record<ChannelId, SubsystemLogger>;
  channelRuntimeEnvs: Record<ChannelId, RuntimeEnv>;
  /**
   * Optional channel runtime helpers for external channel plugins.
   *
   * When provided, this value is passed to all channel plugins via the
   * `channelRuntime` field in `ChannelGatewayContext`, enabling external
   * plugins to access advanced Plugin SDK features (AI dispatch, routing,
   * text processing, etc.).
   *
   * Bundled channels typically don't use this because they can directly
   * import internal modules from the monorepo.
   *
   * This field is optional - omitting it maintains backward compatibility
   * with existing channels. When provided, it must be a real
   * `createPluginRuntime().channel` surface; partial stubs are not supported.
   *
   * @example
   * ```typescript
   * import { createPluginRuntime } from "../plugins/runtime/index.js";
   *
   * const channelManager = createChannelManager({
   *   getRuntimeConfig,
   *   channelLogs,
   *   channelRuntimeEnvs,
   *   channelRuntime: createPluginRuntime().channel,
   * });
   * ```
   *
   * @since Plugin SDK 2026.2.19
   * @see {@link ChannelGatewayContext.channelRuntime}
   */
  channelRuntime?: ChannelRuntimeSurface;
  /**
   * Lazily resolves optional channel runtime helpers for external channel plugins.
   *
   * Use this when the caller wants to avoid instantiating the full plugin channel
   * runtime during gateway startup. The manager only needs the runtime surface once
   * a channel account actually starts. The resolved value must be a real
   * `createPluginRuntime().channel` surface.
   */
  resolveChannelRuntime?: () => ChannelRuntimeSurface | Promise<ChannelRuntimeSurface>;
  /**
   * Lightweight channel runtime used for bundled channel startup. Bundled
   * channels only need `runtimeContexts` while booting, so this avoids pulling
   * the full reply/routing/session runtime graph onto the critical path.
   */
  resolveStartupChannelRuntime?: () => ChannelRuntimeSurface | Promise<ChannelRuntimeSurface>;
  startupTrace?: GatewayStartupTrace;
};

type StartChannelOptions = {
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
};

export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;
  startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  isHealthMonitorEnabled: (channelId: ChannelId, accountId: string) => boolean;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager {
  const {
    getRuntimeConfig,
    channelLogs,
    channelRuntimeEnvs,
    channelRuntime,
    resolveChannelRuntime,
    resolveStartupChannelRuntime,
    startupTrace,
  } = opts;

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  // Tracks restart attempts per channel:account. Reset on successful start.
  const restartAttempts = new Map<string, number>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();

  const restartKey = (channelId: ChannelId, accountId: string) => `${channelId}:${accountId}`;

  const resolveAccountHealthMonitorOverride = (
    channelConfig: ChannelHealthMonitorConfig | undefined,
    accountId: string,
  ): boolean | undefined => {
    if (!channelConfig?.accounts) {
      return undefined;
    }
    const direct = resolveAccountEntry(channelConfig.accounts, accountId);
    if (typeof direct?.healthMonitor?.enabled === "boolean") {
      return direct.healthMonitor.enabled;
    }

    const normalizedAccountId = normalizeOptionalAccountId(accountId);
    if (!normalizedAccountId) {
      return undefined;
    }
    const match = resolveNormalizedAccountEntry(
      channelConfig.accounts,
      normalizedAccountId,
      normalizeAccountId,
    );
    if (typeof match?.healthMonitor?.enabled !== "boolean") {
      return undefined;
    }
    return match.healthMonitor.enabled;
  };

  const isHealthMonitorEnabled = (channelId: ChannelId, accountId: string): boolean => {
    const cfg = getRuntimeConfig();
    const channelConfig = cfg.channels?.[channelId] as ChannelHealthMonitorConfig | undefined;
    const accountOverride = resolveAccountHealthMonitorOverride(channelConfig, accountId);
    const channelOverride = channelConfig?.healthMonitor?.enabled;

    if (typeof accountOverride === "boolean") {
      return accountOverride;
    }

    if (typeof channelOverride === "boolean") {
      return channelOverride;
    }

    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return true;
    }
    try {
      // Probe only: health-monitor config is read directly from raw channel config above.
      // This call exists solely to fail closed if resolver-side config loading is broken.
      plugin.config.resolveAccount(cfg, accountId);
    } catch (err) {
      channelLogs[channelId].warn?.(
        `[${channelId}:${accountId}] health-monitor: failed to resolve account; skipping monitor (${formatErrorMessage(err)})`,
      );
      return false;
    }

    return true;
  };

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) {
      return existing;
    }
    const next = createRuntimeStore();
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return store.runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const next = { ...current, ...patch, accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const getChannelRuntime = async (
    channelId: ChannelId,
  ): Promise<ChannelRuntimeSurface | undefined> => {
    if (channelRuntime) {
      return channelRuntime;
    }
    if (getLoadedChannelPluginOrigin(channelId) === "bundled") {
      const startupRuntime = await resolveStartupChannelRuntime?.();
      if (startupRuntime) {
        return startupRuntime;
      }
    }
    return await resolveChannelRuntime?.();
  };
  const measureStartup = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    return startupTrace ? startupTrace.measure(name, run) : await run();
  };

  const evictStaleChannelAccountState = (
    channelId: ChannelId,
    store: ChannelRuntimeStore,
    accountIds: readonly string[],
  ) => {
    const activeAccountIds = new Set(accountIds);
    for (const id of store.runtimes.keys()) {
      if (
        activeAccountIds.has(id) ||
        store.aborts.has(id) ||
        store.starting.has(id) ||
        store.tasks.has(id)
      ) {
        continue;
      }
      store.runtimes.delete(id);
      restartAttempts.delete(restartKey(channelId, id));
      manuallyStopped.delete(restartKey(channelId, id));
    }
  };

  const startChannelInternal = async (
    channelId: ChannelId,
    accountId?: string,
    opts: StartChannelOptions = {},
  ) => {
    const plugin = getChannelPlugin(channelId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      return;
    }
    const { preserveRestartAttempts = false, preserveManualStop = false } = opts;
    const cfg = getRuntimeConfig();
    resetDirectoryCache({ channel: channelId, accountId });
    const store = getStore(channelId);
    const accountIds = accountId
      ? [accountId]
      : await measureStartup(`channels.${channelId}.list-accounts`, () =>
          plugin.config.listAccountIds(cfg),
        );
    if (!accountId) {
      evictStaleChannelAccountState(channelId, store, accountIds);
    }
    if (accountIds.length === 0) {
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        if (store.tasks.has(id)) {
          return;
        }
        const existingStart = store.starting.get(id);
        if (existingStart) {
          await existingStart;
          return;
        }

        let resolveStart: (() => void) | undefined;
        const startGate = new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
        store.starting.set(id, startGate);

        // Reserve the account before the first await so overlapping start calls
        // cannot race into duplicate provider boots for the same account.
        const abort = new AbortController();
        store.aborts.set(id, abort);
        let handedOffTask = false;
        const log = channelLogs[channelId];
        let scopedChannelRuntime: ReturnType<typeof createTaskScopedChannelRuntime> | null = null;
        let channelRuntimeForTask: ChannelRuntimeSurface | undefined;
        let stopApprovalBootstrap: () => Promise<void> = async () => {};
        const stopTaskScopedApprovalRuntime = async () => {
          const scopedRuntime = scopedChannelRuntime;
          scopedChannelRuntime = null;
          const stopBootstrap = stopApprovalBootstrap;
          stopApprovalBootstrap = async () => {};
          scopedRuntime?.dispose();
          await stopBootstrap();
        };
        const cleanupTaskScopedApprovalRuntime = async (label: string) => {
          try {
            await stopTaskScopedApprovalRuntime();
          } catch (error) {
            log.error?.(`[${id}] ${label}: ${formatErrorMessage(error)}`);
          }
        };

        try {
          const account = plugin.config.resolveAccount(cfg, id);
          const enabled = plugin.config.isEnabled
            ? plugin.config.isEnabled(account, cfg)
            : isAccountEnabled(account);
          if (!enabled) {
            setRuntime(channelId, id, {
              accountId: id,
              enabled: false,
              configured: true,
              running: false,
              restartPending: false,
              lastError: plugin.config.disabledReason?.(account, cfg) ?? "disabled",
            });
            return;
          }

          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await measureStartup(`channels.${channelId}.is-configured`, () =>
              plugin.config.isConfigured!(account, cfg),
            );
          }
          if (!configured) {
            setRuntime(channelId, id, {
              accountId: id,
              enabled: true,
              configured: false,
              running: false,
              restartPending: false,
              lastError: plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured",
            });
            return;
          }

          const rKey = restartKey(channelId, id);
          if (!preserveManualStop) {
            manuallyStopped.delete(rKey);
          }

          if (abort.signal.aborted || manuallyStopped.has(rKey)) {
            setRuntime(channelId, id, {
              accountId: id,
              running: false,
              restartPending: false,
              lastStopAt: Date.now(),
            });
            return;
          }

          scopedChannelRuntime = await measureStartup(`channels.${channelId}.runtime`, async () =>
            createTaskScopedChannelRuntime({
              channelRuntime: await getChannelRuntime(channelId),
            }),
          );
          channelRuntimeForTask = scopedChannelRuntime.channelRuntime;

          if (!preserveRestartAttempts) {
            restartAttempts.delete(rKey);
          }
          try {
            stopApprovalBootstrap = await measureStartup(
              `channels.${channelId}.approval-bootstrap`,
              () =>
                startChannelApprovalHandlerBootstrap({
                  plugin,
                  cfg,
                  accountId: id,
                  channelRuntime: channelRuntimeForTask,
                  logger: log,
                }),
            );
          } catch (error) {
            log.error?.(`[${id}] native approval bootstrap failed: ${formatErrorMessage(error)}`);
          }
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            configured: true,
            running: true,
            restartPending: false,
            lastStartAt: Date.now(),
            lastError: null,
            reconnectAttempts: preserveRestartAttempts ? (restartAttempts.get(rKey) ?? 0) : 0,
          });
          // FORK 2026-08-26: the crash / clean-exit path never ran the plugin's own
          // account teardown — `gateway.stopAccount` was reachable ONLY from the
          // manual `stopChannel`. Everything the previous attempt allocated
          // out-of-process (for WhatsApp: the `whatsmeow-node` Go sidecar) stayed
          // alive while attempt N+1 spawned a fresh one, so a long-running gateway
          // accumulated one orphan child per retry (181 orphans / ~4 GB RSS measured
          // over a single 5 h uptime). Teardown now runs on EVERY exit, exactly once
          // per attempt, under a hard budget, and is awaited BEFORE the account is
          // published as `running: false` and before the restart is scheduled — so
          // attempt N+1 cannot spawn while attempt N's child is still up.
          let teardownRun: Promise<void> | null = null;
          const teardownAccount = (): Promise<void> => {
            teardownRun ??= (async () => {
              const stopAccountHook = plugin.gateway?.stopAccount;
              if (!stopAccountHook) {
                // Not a silent no-op: a channel that owns out-of-process work and
                // ships no `stopAccount` cannot be reaped from here, and that gap
                // must be readable in the journal rather than inferred later from
                // a pile of orphaned pids.
                log.debug?.(
                  `[${id}] no gateway.stopAccount hook; manager cannot reap out-of-process children on exit`,
                );
                return;
              }
              const settled = await runBounded(async () => {
                try {
                  const teardownCfg = getRuntimeConfig();
                  await stopAccountHook({
                    cfg: teardownCfg,
                    accountId: id,
                    account: plugin.config.resolveAccount(teardownCfg, id),
                    runtime: channelRuntimeEnvs[channelId],
                    abortSignal: abort.signal,
                    log,
                    getStatus: () => getRuntime(channelId, id),
                    setStatus: (next) => setRuntime(channelId, id, next),
                  });
                } catch (error) {
                  log.error?.(`[${id}] channel teardown failed: ${formatErrorMessage(error)}`);
                }
              }, CHANNEL_TEARDOWN_TIMEOUT_MS);
              if (!settled) {
                log.warn?.(
                  `[${id}] channel teardown exceeded ${CHANNEL_TEARDOWN_TIMEOUT_MS}ms; ` +
                    "continuing restart (a child process may be orphaned)",
                );
              }
            })();
            return teardownRun;
          };
          const startAccountStartedAt = Date.now();
          const task = Promise.resolve().then(() =>
            measureStartup(`channels.${channelId}.start-account`, () =>
              startAccount({
                cfg,
                accountId: id,
                account,
                runtime: channelRuntimeEnvs[channelId],
                abortSignal: abort.signal,
                log,
                getStatus: () => getRuntime(channelId, id),
                setStatus: (next) => setRuntime(channelId, id, next),
                ...(channelRuntimeForTask ? { channelRuntime: channelRuntimeForTask } : {}),
              }),
            ),
          );
          const trackedPromise = task
            .then(() => {
              if (abort.signal.aborted || manuallyStopped.has(rKey)) {
                return;
              }
              const message = "channel exited without an error";
              const status = getRuntime(channelId, id);
              const lifetimeMs = Date.now() - startAccountStartedAt;
              setRuntime(channelId, id, { accountId: id, lastError: message });
              log.error?.(
                `[${id}] ${message} ` +
                  `(lifetimeMs=${lifetimeMs}, running=${String(status.running)}, ` +
                  `connected=${String(status.connected)}, lastError=${String(status.lastError)})`,
              );
            })
            .catch((err) => {
              const message = formatErrorMessage(err);
              setRuntime(channelId, id, { accountId: id, lastError: message });
              log.error?.(`[${id}] channel exited: ${message}`);
            })
            .finally(async () => {
              await cleanupTaskScopedApprovalRuntime("channel cleanup failed");
              // Reap this attempt's out-of-process children BEFORE the account is
              // published as stopped and before the restart continuation runs.
              // Ordering is the whole point: it is what stops attempt N+1 from
              // spawning on top of a still-live attempt N.
              await teardownAccount();
              setRuntime(channelId, id, {
                accountId: id,
                running: false,
                lastStopAt: Date.now(),
              });
            })
            .then(async () => {
              if (manuallyStopped.has(rKey)) {
                return;
              }
              const attempt = (restartAttempts.get(rKey) ?? 0) + 1;
              restartAttempts.set(rKey, attempt);
              if (attempt > MAX_RESTART_ATTEMPTS) {
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: false,
                  reconnectAttempts: attempt,
                });
                log.error?.(`[${id}] giving up after ${MAX_RESTART_ATTEMPTS} restart attempts`);
                return;
              }
              const delayMs = computeBackoff(CHANNEL_RESTART_POLICY, attempt);
              log.info?.(
                `[${id}] auto-restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS} in ${Math.round(delayMs / 1000)}s`,
              );
              setRuntime(channelId, id, {
                accountId: id,
                restartPending: true,
                reconnectAttempts: attempt,
              });
              try {
                await sleepWithAbort(delayMs, abort.signal);
                if (manuallyStopped.has(rKey)) {
                  return;
                }
                if (store.tasks.get(id) === trackedPromise) {
                  store.tasks.delete(id);
                }
                if (store.teardowns.get(id) === teardownAccount) {
                  store.teardowns.delete(id);
                }
                if (store.aborts.get(id) === abort) {
                  store.aborts.delete(id);
                }
                await startChannelInternal(channelId, id, {
                  preserveRestartAttempts: true,
                  preserveManualStop: true,
                });
              } catch {
                // abort or startup failure — next crash will retry
              }
            })
            .finally(() => {
              if (store.tasks.get(id) === trackedPromise) {
                store.tasks.delete(id);
              }
              if (store.teardowns.get(id) === teardownAccount) {
                store.teardowns.delete(id);
              }
              if (store.aborts.get(id) === abort) {
                store.aborts.delete(id);
              }
            });
          handedOffTask = true;
          store.teardowns.set(id, teardownAccount);
          store.tasks.set(id, trackedPromise);
        } catch (error) {
          if (!handedOffTask) {
            setRuntime(channelId, id, {
              accountId: id,
              running: false,
              restartPending: false,
              lastError: formatErrorMessage(error),
            });
          }
          throw error;
        } finally {
          resolveStart?.();
          if (store.starting.get(id) === startGate) {
            store.starting.delete(id);
          }
          if (!handedOffTask) {
            await cleanupTaskScopedApprovalRuntime("channel startup cleanup failed");
          }
          if (!handedOffTask && store.aborts.get(id) === abort) {
            store.aborts.delete(id);
          }
        }
      }),
    );
  };

  const startChannel = async (channelId: ChannelId, accountId?: string) => {
    await startChannelInternal(channelId, accountId);
  };

  const stopChannel = async (channelId: ChannelId, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    const store = getStore(channelId);
    // Fast path: nothing running and no explicit plugin shutdown hook to run.
    if (!plugin?.gateway?.stopAccount && store.aborts.size === 0 && store.tasks.size === 0) {
      return;
    }
    const cfg = getRuntimeConfig();
    const knownIds = new Set<string>([
      ...store.aborts.keys(),
      ...store.starting.keys(),
      ...store.tasks.keys(),
      ...(plugin ? plugin.config.listAccountIds(cfg) : []),
    ]);
    if (accountId) {
      knownIds.clear();
      knownIds.add(accountId);
    }

    await Promise.all(
      Array.from(knownIds.values()).map(async (id) => {
        const abort = store.aborts.get(id);
        const task = store.tasks.get(id);
        if (!abort && !task && !plugin?.gateway?.stopAccount) {
          return;
        }
        manuallyStopped.add(restartKey(channelId, id));
        abort?.abort();
        const log = channelLogs[channelId];
        // FORK 2026-08-26: a live attempt owns a once-guarded teardown closure that
        // the crash path also drives. Route the manual stop through it so a manual
        // stop racing a clean exit runs the plugin teardown exactly once instead of
        // twice. Fall back to a direct call when no attempt is live (the account is
        // already down, or was never started in this process).
        const registeredTeardown = store.teardowns.get(id);
        if (registeredTeardown) {
          await registeredTeardown();
        } else if (plugin?.gateway?.stopAccount) {
          const account = plugin.config.resolveAccount(cfg, id);
          await plugin.gateway.stopAccount({
            cfg,
            accountId: id,
            account,
            runtime: channelRuntimeEnvs[channelId],
            abortSignal: abort?.signal ?? new AbortController().signal,
            log: channelLogs[channelId],
            getStatus: () => getRuntime(channelId, id),
            setStatus: (next) => setRuntime(channelId, id, next),
          });
        }
        const stoppedCleanly = await waitForChannelStopGracefully(
          task,
          CHANNEL_STOP_ABORT_TIMEOUT_MS,
        );
        if (!stoppedCleanly) {
          log.warn?.(
            `[${id}] channel stop exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms after abort; continuing shutdown`,
          );
          setRuntime(channelId, id, {
            accountId: id,
            running: true,
            restartPending: false,
            lastError: `channel stop timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`,
          });
          return;
        }
        store.aborts.delete(id);
        store.tasks.delete(id);
        store.teardowns.delete(id);
        setRuntime(channelId, id, {
          accountId: id,
          running: false,
          restartPending: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startChannels = async () => {
    const pending = [...listChannelPlugins()];
    const workerCount = Math.min(8, pending.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const plugin = pending.shift();
          if (!plugin) {
            return;
          }
          try {
            await measureStartup(`channels.${plugin.id}.start`, () => startChannel(plugin.id));
          } catch (err) {
            channelLogs[plugin.id]?.error?.(
              `[${plugin.id}] channel startup failed: ${formatErrorMessage(err)}`,
            );
          }
        }
      }),
    );
  };

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const cfg = getRuntimeConfig();
    const resolvedId =
      accountId ??
      resolveChannelDefaultAccountId({
        plugin,
        cfg,
      });
    const current = getRuntime(channelId, resolvedId);
    const next: ChannelAccountSnapshot = {
      accountId: resolvedId,
      running: false,
      restartPending: false,
      lastError: cleared ? "logged out" : current.lastError,
    };
    if (typeof current.connected === "boolean") {
      next.connected = false;
    }
    setRuntime(channelId, resolvedId, next);
  };

  const getRuntimeSnapshot = (): ChannelRuntimeSnapshot => {
    const cfg = getRuntimeConfig();
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    for (const plugin of listChannelPlugins()) {
      const store = getStore(plugin.id);
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: Record<string, ChannelAccountSnapshot> = {};
      for (const id of accountIds) {
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const current = store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const next = { ...current, accountId: id };
        next.enabled = enabled;
        applyDescribedAccountFields(next, described);
        const configured = described?.configured;
        if (!next.running) {
          if (!enabled) {
            next.lastError ??= plugin.config.disabledReason?.(account, cfg) ?? "disabled";
          } else if (configured === false) {
            next.lastError ??= plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured";
          }
        }
        accounts[id] = next;
      }
      const defaultAccount =
        accounts[defaultAccountId] ?? cloneDefaultRuntime(plugin.id, defaultAccountId);
      channels[plugin.id] = defaultAccount;
      channelAccounts[plugin.id] = accounts;
    }
    return { channels, channelAccounts };
  };

  const isManuallyStopped_ = (channelId: ChannelId, accountId: string): boolean => {
    return manuallyStopped.has(restartKey(channelId, accountId));
  };

  const resetRestartAttempts_ = (channelId: ChannelId, accountId: string): void => {
    restartAttempts.delete(restartKey(channelId, accountId));
  };

  return {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
    isManuallyStopped: isManuallyStopped_,
    resetRestartAttempts: resetRestartAttempts_,
    isHealthMonitorEnabled,
  };
}
