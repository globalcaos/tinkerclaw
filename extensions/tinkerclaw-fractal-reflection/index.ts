/**
 * FORK: Parallel Fractal Reflection v2/v3 — plugin entry point.
 *
 * Design of record: TINKER_UI_DESIGN_BIBLE/bible.md §5.67a (v2 architecture) as
 * amended by §5.67b (v3 — where they conflict, §5.67b wins).
 *
 * Every main-turn `agent_end` is triaged OFF-CHANNEL by a cheap reflection lane
 * spawned on its own runId (it never blocks or steers the user's lane), and every
 * main turn yields exactly ONE append-only ledger row — including all guard paths
 * (`skipped`, `suspended`, `error`). The v1 in-band sessions.steer/debounce/
 * string-match machinery (src/fractal-inject.ts) is retired per §5.67a.
 *
 * This file is THIN wiring only — logic lives in the src/ modules:
 *   - src/types.ts          contract: FractalRow/FractalConfig + isFractalSessionKey
 *   - src/ledger.ts         append-only JSONL ledger (results.jsonl) + stats/feed
 *   - src/governor.ts       derived quota pressure, token bucket, circuit breaker
 *   - src/fractal-run.ts    triage lane spawn + verdict parse (cold arm, Drop 1)
 *   - src/fractal-result.ts two-event contract (pending stub / final) + watchdog
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emitFractalEvent, emitPendingStub, StubWatchdog } from "./src/fractal-result.js";
import { runTriage } from "./src/fractal-run.js";
import { Governor } from "./src/governor.js";
import { FractalLedger } from "./src/ledger.js";
import {
  DEFAULT_FRACTAL_CONFIG,
  isFractalSessionKey,
  type FractalConfig,
  type FractalRow,
} from "./src/types.js";

// ---------------------------------------------------------------------------
// Local structural shapes for the host hook payloads (src/plugins/hook-types.ts:
// PluginHookAgentEndEvent / PluginHookAgentContext). Typed inline so this entry
// point imports nothing from ../../src — supertypes are accepted contravariantly.
// ---------------------------------------------------------------------------

type AgentEndEvent = {
  runId?: string;
  messages?: unknown[];
  success?: boolean;
  error?: string;
  durationMs?: number;
};

type AgentEndContext = {
  runId?: string;
  sessionKey?: string;
  trigger?: string;
};

/** Persisted control state — a restart must NOT re-arm a suspended fractal (§5.67b). */
interface FractalControlState {
  suspended: boolean;
  suspendReason?: string;
  updatedAt?: string;
}

type QueuedTurn = {
  parentRunId: string;
  sessionKey: string;
  messages: unknown[];
  queuedAt: number;
};

type SessionSlot = {
  activeParentRunId: string;
  /** latest-wins: at most ONE queued turn per session; replacing it emits skipped:superseded */
  queued?: QueuedTurn;
};

export default definePluginEntry({
  id: "tinkerclaw-fractal-reflection",
  name: "Fractal Reflection",
  description:
    "Parallel post-turn reflection — a triage lane judges every finished main turn " +
    "off-channel; every turn yields exactly one ledger row (bible §5.67a/§5.67b).",
  register(api: OpenClawPluginApi) {
    const log = api.logger;

    const cfg: FractalConfig = {
      ...DEFAULT_FRACTAL_CONFIG,
      ...((api.pluginConfig ?? {}) as Partial<FractalConfig>),
    };
    const enabled = cfg.enabled !== false;

    // -----------------------------------------------------------------------
    // State dir + persisted control state. Same resolution pattern as
    // tinkerclaw-learned-intuition's decisions path (~/.openclaw/data/<area>/…);
    // the ledger owns results.jsonl inside this dir (§5.67b result store).
    // -----------------------------------------------------------------------
    const stateDir = join(homedir(), ".openclaw", "data", "fractal");
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch (err) {
      log.warn(`[fractal-reflection] could not create state dir ${stateDir}: ${String(err)}`);
    }

    const controlPath = join(stateDir, "control.json");
    let control: FractalControlState = { suspended: false };
    try {
      if (existsSync(controlPath)) {
        control = { suspended: false, ...JSON.parse(readFileSync(controlPath, "utf-8")) };
      }
    } catch (err) {
      log.warn(`[fractal-reflection] control state unreadable (using defaults): ${String(err)}`);
    }
    const persistControl = (): void => {
      try {
        writeFileSync(controlPath, JSON.stringify(control, null, 2), "utf-8");
      } catch (err) {
        log.error(`[fractal-reflection] control state persist FAILED: ${String(err)}`);
      }
    };

    // -----------------------------------------------------------------------
    // Collaborators
    // -----------------------------------------------------------------------
    const ledger = new FractalLedger(stateDir);

    // Governor usage feed: `usage.status` is a gateway server-method
    // (src/gateway/server-methods/usage.ts) backed by loadProviderUsageSummary()
    // in src/infra/provider-usage.js. Plugins run in-process with the gateway, so
    // the implementation IS reachable — but we resolve it dynamically and treat
    // ANY failure (module moved, out-of-process host, fetch error) as "no signal"
    // by returning null: the governor then fails-to-NEUTRAL (§5.67b — the throttle
    // branch falls back to the maxFixSpawnsPerHour ceiling, the surplus-spend
    // branch disarms). The gateway has no fresh quota signal for the cc-bridge
    // subscription path anyway, so null is an expected steady state, not an error.
    const readUsage = async (): Promise<unknown> => {
      try {
        const mod = (await import("../../src/infra/provider-usage.js")) as {
          loadProviderUsageSummary?: () => Promise<unknown>;
        };
        if (typeof mod.loadProviderUsageSummary !== "function") {
          return null;
        }
        return await mod.loadProviderUsageSummary();
      } catch {
        return null;
      }
    };
    const governor = new Governor({ cfg, readUsage });
    const watchdog = new StubWatchdog({ ledger, logger: log });

    // L2 ownership Set (loop guard): runIds THIS plugin spawned. The sessionKey
    // prefix predicate is the primary guard; the Set answers "did I spawn this run".
    const ownRunIds = new Set<string>();
    // Single-flight + latest-wins bookkeeping, one slot per sessionKey (§5.67b).
    const sessionSlots = new Map<string, SessionSlot>();
    let lastGovernorMode = "unknown";

    // -----------------------------------------------------------------------
    // Row helpers — EVERY guard path appends a row: the §5.67b invariant is that
    // every main-turn agent_end yields exactly one ledger row (incl. skipped/
    // suspended/error). The non-fire detector depends on it.
    // -----------------------------------------------------------------------
    const nowIso = (): string => new Date().toISOString();
    const guardRow = (params: {
      parentRunId: string;
      sessionKey: string;
      status: FractalRow["status"];
      skipReason?: "quota" | "superseded" | "budget";
      headline?: string;
    }): FractalRow =>
      // Cast: guard rows carry only the identity/status subset of the U1 row
      // contract — triage rows (assembled in src/) carry the full field set.
      ({
        version: 1,
        ts: nowIso(),
        parentRunId: params.parentRunId,
        sessionKey: params.sessionKey,
        status: params.status,
        ...(params.skipReason ? { skipReason: params.skipReason } : {}),
        ...(params.headline ? { headline: params.headline } : {}),
        findings: [],
      }) as FractalRow;

    const appendRow = (row: FractalRow): void => {
      try {
        ledger.append(row);
      } catch (err) {
        // A lost row breaks the one-row-per-turn invariant — plumbing alarm.
        log.error(`[fractal-reflection] LEDGER APPEND FAILED: ${String(err)}`);
      }
    };

    // -----------------------------------------------------------------------
    // The cycle (everything past the guards) — runs inside the rooted chain.
    // -----------------------------------------------------------------------
    const runCycle = async (turn: QueuedTurn): Promise<void> => {
      const { parentRunId, sessionKey, messages } = turn;
      const row = await runTriage({
        parentRunId,
        sessionKey,
        messages,
        api,
        cfg,
        ledger,
        // Fires the moment the triage lane spawns: take L2 ownership of the runId
        // (loop guard), emit the `pending` stub (two-event contract), and arm the
        // dead-stub watchdog (verified deadness only — never wall-clock-since-spawn).
        onSpawned: ({ runId }: { runId: string }) => {
          ownRunIds.add(runId);
          try {
            emitPendingStub({ parentRunId, triageRunId: runId, sessionKey });
          } catch (err) {
            log.warn(`[fractal-reflection] pending stub emit failed: ${String(err)}`);
          }
          watchdog.track({ parentRunId, sessionKey, runId });
        },
      });
      watchdog.cancel(parentRunId);
      appendRow(row);
      try {
        emitFractalEvent({ sessionKey, row });
      } catch (err) {
        log.warn(`[fractal-reflection] final event emit failed: ${String(err)}`);
      }
      governor.recordOutcome(row);
    };

    // -----------------------------------------------------------------------
    // Guard chain: suspended → single-flight/latest-wins → governor mode →
    // token bucket → cycle. Synchronous bookkeeping, then ONE rooted promise.
    // -----------------------------------------------------------------------
    const handleTurn = (turn: QueuedTurn): void => {
      const { parentRunId, sessionKey } = turn;

      if (control.suspended) {
        appendRow(
          guardRow({
            parentRunId,
            sessionKey,
            status: "suspended",
            headline: control.suspendReason ?? "fractal suspended",
          }),
        );
        return;
      }

      // Single-flight + latest-wins per sessionKey (§5.67b flood control): while
      // a triage is in flight at most ONE turn waits; a newer turn supersedes it
      // and the superseded parent gets its skipped:superseded row immediately.
      const slot = sessionSlots.get(sessionKey);
      if (slot) {
        if (slot.queued) {
          appendRow(
            guardRow({
              parentRunId: slot.queued.parentRunId,
              sessionKey,
              status: "skipped",
              skipReason: "superseded",
            }),
          );
        }
        slot.queued = turn;
        return;
      }

      // Reserve the slot BEFORE any async step so two near-simultaneous
      // agent_ends for the same session can never both launch.
      sessionSlots.set(sessionKey, { activeParentRunId: parentRunId });

      const releaseAndDrain = (): void => {
        const current = sessionSlots.get(sessionKey);
        sessionSlots.delete(sessionKey);
        if (current?.queued) {
          handleTurn(current.queued);
        }
      };

      // ONE rooted promise chain (§5.67b supervised detach): the agent_end
      // handler has already returned; every rejection is contained here — an
      // `error` row + console.error, never an unhandled rejection (the
      // playwright-relay crash class exits the gateway).
      void Promise.resolve()
        .then(() => governor.mode("triage"))
        .then((mode) => {
          lastGovernorMode = String(mode);
          if (mode === "skip") {
            appendRow(
              guardRow({ parentRunId, sessionKey, status: "skipped", skipReason: "quota" }),
            );
            return undefined;
          }
          if (!governor.tryTakeSpawnToken()) {
            // The token bucket is a plumbing ALARM, not a quota optimizer
            // (§5.67b): if it fires, something upstream fires far too often.
            log.error(
              `[fractal-reflection] SPAWN TOKEN BUCKET EXHAUSTED — plumbing alarm (parent=${parentRunId}, session=${sessionKey})`,
            );
            appendRow(
              guardRow({ parentRunId, sessionKey, status: "skipped", skipReason: "budget" }),
            );
            return undefined;
          }
          return runCycle(turn);
        })
        .catch((err) => {
          const row = guardRow({
            parentRunId,
            sessionKey,
            status: "error",
            headline: String((err as Error | undefined)?.message ?? err),
          });
          appendRow(row);
          try {
            governor.recordOutcome(row);
          } catch {
            // breaker accounting is best-effort on the error path
          }
          console.error(`[fractal-reflection] cycle failed (parent=${parentRunId}):`, err);
        })
        .finally(releaseAndDrain)
        .catch((err) => {
          console.error(`[fractal-reflection] supervisor failure (parent=${parentRunId}):`, err);
        });
    };

    // -----------------------------------------------------------------------
    // Hook: agent_end — fire-and-forget; returns synchronously, well inside the
    // 30s void-hook budget. RPCs below stay registered even when disabled so
    // fractal.status can report enabled:false (#11/#12 — no silent severance).
    // -----------------------------------------------------------------------
    if (enabled) {
      api.on("agent_end", (event: AgentEndEvent, ctx: AgentEndContext): void => {
        const sessionKey = ctx.sessionKey ?? "";
        const parentRunId = event.runId ?? ctx.runId ?? "";

        // FIRST LINE — the loop guard (§5.67b, fail-closed): a fractal lane
        // ending must never trigger another fractal. L2a = plugin-minted
        // sessionKey prefix via the ONE canonical predicate (src/types.ts,
        // prefix-only mode for Drop 1); L2b = the runId ownership Set. NO
        // string-matching on model output — ever (the §11.14 regression).
        if (isFractalSessionKey(sessionKey) || (parentRunId !== "" && ownRunIds.has(parentRunId))) {
          ownRunIds.delete(parentRunId); // terminal — keep the ownership Set bounded
          return;
        }

        handleTurn({
          parentRunId: parentRunId || `unknown:${Date.now()}`,
          sessionKey: sessionKey || "unknown",
          messages: Array.isArray(event.messages) ? event.messages : [],
          queuedAt: Date.now(),
        });
      });
    } else {
      log.info(
        "[fractal-reflection] disabled via config — RPC surface stays registered, no triage fires",
      );
    }

    // -----------------------------------------------------------------------
    // Gateway RPC surface (§5.67b: byRunId/stats/feed are the read half; status
    // is the live control-state read every suspend/resume transition mutates).
    // -----------------------------------------------------------------------
    const governorSnapshot = (): Record<string, unknown> => {
      try {
        const snap = (governor as { snapshot?: () => unknown }).snapshot?.();
        return snap && typeof snap === "object" ? (snap as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };

    api.registerGatewayMethod("fractal.byRunId", async ({ params, respond }) => {
      const runId = String((params as { runId?: unknown } | undefined)?.runId ?? "").trim();
      if (!runId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "runId is required" });
        return;
      }
      const row = await ledger.byParentRunId(runId);
      respond(true, { runId, row: row ?? null });
    });

    api.registerGatewayMethod("fractal.stats", async ({ params, respond }) => {
      const p = (params ?? {}) as { windowHours?: unknown };
      const windowHours = Number(p.windowHours ?? 24) || 24;
      const stats = await ledger.stats({ windowHours });
      respond(true, {
        windowHours,
        stats,
        pressure: governorSnapshot(),
        // TODO(§5.67b non-fire detector): missedTurns = INDEPENDENT main-turn
        // count minus ledger row count over the window. The independent count
        // source (main-session jsonl reconciliation, the failures.md probe)
        // lands later; null — never 0 — until then, so "unknown" cannot read
        // as "none missed".
        missedTurns: null,
      });
    });

    api.registerGatewayMethod("fractal.feed", async ({ params, respond }) => {
      const p = (params ?? {}) as { limit?: unknown; status?: unknown };
      const limit = Math.max(1, Math.min(500, Number(p.limit ?? 50) || 50));
      const status = typeof p.status === "string" && p.status.length > 0 ? p.status : undefined;
      respond(true, { rows: await ledger.feed({ limit, status }) });
    });

    api.registerGatewayMethod("fractal.status", async ({ respond }) => {
      const snap = governorSnapshot();
      respond(true, {
        enabled,
        suspended: control.suspended,
        suspendReason: control.suspendReason ?? null,
        breakerState: snap.breakerState ?? null,
        governorMode: lastGovernorMode,
        derivedPressure: snap.derivedPressure ?? snap.pressure ?? null,
        bucketRemaining: snap.bucketRemaining ?? null,
      });
    });

    api.registerGatewayMethod("fractal.suspend", async ({ params, respond }) => {
      const reason =
        String((params as { reason?: unknown } | undefined)?.reason ?? "").trim() ||
        "operator suspend";
      control = { suspended: true, suspendReason: reason, updatedAt: nowIso() };
      persistControl();
      const row = guardRow({
        parentRunId: `control:suspend:${Date.now()}`,
        sessionKey: "control",
        status: "suspended",
        headline: reason,
      });
      appendRow(row);
      try {
        emitFractalEvent({ sessionKey: "control", row });
      } catch (err) {
        log.warn(`[fractal-reflection] suspend event emit failed: ${String(err)}`);
      }
      log.warn(`[fractal-reflection] SUSPENDED: ${reason}`);
      respond(true, { suspended: true, suspendReason: reason });
    });

    api.registerGatewayMethod("fractal.resume", async ({ respond }) => {
      control = { suspended: false, updatedAt: nowIso() };
      persistControl();
      log.info("[fractal-reflection] resumed");
      respond(true, { suspended: false });
    });

    log.info(
      `[fractal-reflection] v2 ready — enabled=${enabled}, suspended=${control.suspended}, stateDir=${stateDir}`,
    );
  },
});
