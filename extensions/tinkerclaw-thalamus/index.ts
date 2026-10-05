/**
 * THALAMUS v4 (J19) — plugin entry.
 *
 * The plugin ships DISABLED (`enabledByDefault: false`), and even when an owner enables it the mode defaults to
 * `off`: `register()` then registers nothing and opens nothing. All logic lives in `src/runtime.ts`; this file is the
 * thin wiring into the gateway plugin API. Nothing here runs at import time.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  definePluginEntry,
  resolveGatewayPort,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { parseConfig } from "./src/config.js";
import { sourceOfSessionKey } from "./src/context-view.js";
import {
  createDigestHandler,
  createShortlistHandler,
  DIGEST_PATH,
  SHORTLIST_PATH,
} from "./src/http.js";
import { createRuntime, type ThalamusRuntime } from "./src/runtime.js";

const HEARTBEAT_MS = 60_000;

// One running runtime per data folder in a process. The gateway loads its plugins more than once (a run that needs a
// registry of its own loads them again, in full), and each load used to start another runtime on the same database:
// its own counters, its own bus listener, its own endpoint token, and the routing-provider slot taken by the newest.
// The gateway binds its methods once, at start, so `thalamus.status` read the first runtime while every Jev read landed
// on the last one (2026-10-01: three loads in one process, providerReads 0). A later load now shares the running one.
const LIVE = Symbol.for("openclaw.thalamus.liveRuntimes");
function liveRuntimes(): Map<string, ThalamusRuntime> {
  const g = globalThis as { [LIVE]?: Map<string, ThalamusRuntime> };
  return (g[LIVE] ??= new Map());
}

export default definePluginEntry({
  id: "tinkerclaw-thalamus",
  name: "Thalamus v4",
  description:
    "Routes each model call, ranks the assistant's skills, recipes and plugins for each task, and records what it would have done. Ships disabled; mode off by default.",
  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") return;
    const cfg = parseConfig(api.pluginConfig as Record<string, unknown> | undefined);
    if (cfg.mode === "off") {
      api.logger.info("[thalamus] mode is off: nothing registered");
      return;
    }

    let port = 0;
    try {
      port = resolveGatewayPort(api.config);
    } catch {
      port = 0;
    }

    const broadcast = (name: string, payload: unknown): void => {
      try {
        (api as unknown as { broadcast?: (e: string, p: unknown) => void }).broadcast?.(
          name,
          payload,
        );
      } catch {
        /* broadcast is best-effort */
      }
    };
    const gatewayCfg = (): unknown => {
      try {
        return api.runtime.config.current();
      } catch {
        return api.config;
      }
    };

    const live = liveRuntimes();
    const shared = live.get(cfg.dataDir);
    const runtime =
      shared ??
      createRuntime({
        config: cfg,
        // questions/ and hooks/ sit next to this file and are listed in the manifest's runtimeAssets.
        extensionRoot: dirname(fileURLToPath(import.meta.url)),
        gatewayPort: port,
        gatewayCfg,
        onAgentEvent: (l) => onAgentEvent((evt) => l(evt as never)),
        broadcast,
        logger: api.logger,
      });
    if (!shared) {
      live.set(cfg.dataDir, runtime);
      runtime.start().catch((err) => {
        if (live.get(cfg.dataDir) === runtime) live.delete(cfg.dataDir);
        api.logger.error(`[thalamus] runtime failed to start: ${String(err)}`);
      });
    }

    // The embedded runner: work out the short list before the prompt is built. Only `enforce` adds anything to it.
    api.on("before_prompt_build", async (event, ctx) => {
      const seam = runtime.shortlist();
      if (!seam) return undefined;
      try {
        const runId = ctx.runId ?? `run:${ctx.sessionKey ?? "x"}:${Date.now()}`;
        const out = await seam.prepare({
          id: runId,
          runId,
          ts: Date.now(),
          sessionKey: ctx.sessionKey ?? runId,
          text: event.prompt ?? "",
          source: sourceOfSessionKey(ctx.sessionKey),
          trigger: ctx.trigger,
        });
        return out.text ? { prependContext: out.text } : undefined;
      } catch {
        return undefined;
      }
    });

    // The Claude Code hook script posts here; shadow answers empty.
    const handler = createShortlistHandler(
      {
        prepare: async (i) => {
          const seam = runtime.shortlist();
          if (!seam)
            return {
              list: {
                entries: [],
                noneFitsProb: 1,
                shown: false,
                reason: "not-asked",
                source: "local",
              },
              injected: false,
              usedJev: false,
            };
          return seam.prepare(i);
        },
        sourceOf: sourceOfSessionKey,
      },
      () => runtime.token(),
    );
    api.registerHttpRoute({ path: SHORTLIST_PATH, auth: "plugin", match: "exact", handler });

    // Enforce with the digest flag only: the Claude Code PostToolUse hook posts a long tool result here. Without the
    // route (shadow, or the flag off) the hook gets a 404, prints nothing and the tool's output is untouched. The hook
    // script is not installed by this branch.
    if (cfg.mode === "enforce" && cfg.enforce.digest) {
      api.registerHttpRoute({
        path: DIGEST_PATH,
        auth: "plugin",
        match: "exact",
        handler: createDigestHandler({ digest: (i) => runtime.digestForSession(i) }, () =>
          runtime.token(),
        ),
      });
    }

    // Enforce only: the other-family check before a run finishes, and the one writer for the words the user reads.
    // Each service answers "no change" unless its own flag is on.
    if (cfg.mode === "enforce") {
      api.on("before_agent_finalize", async (event, ctx) => {
        try {
          return await runtime.services()?.check.finalize({
            runId: event.runId ?? ctx.runId,
            lastAssistantMessage: event.lastAssistantMessage,
            stopHookActive: event.stopHookActive,
          });
        } catch {
          return undefined;
        }
      });
      api.on("message_sending", async (event, ctx) => {
        try {
          const content = await runtime
            .services()
            ?.finish.rewrite(event.content, { runId: ctx.runId });
          return content ? { content } : undefined;
        } catch {
          return undefined;
        }
      });
    }

    const method = (name: string, fn: (p: Record<string, unknown>) => unknown): void => {
      api.registerGatewayMethod(name, ({ params, respond }) => {
        try {
          respond(true, fn((params ?? {}) as Record<string, unknown>));
        } catch (err) {
          console.error(`[thalamus] ${name} failed`, err);
          respond(true, { ok: false, error: String(err) });
        }
      });
    };
    method("thalamus.status", () => runtime.status());
    method("thalamus.feed", (p) => ({
      ok: true,
      decisions: runtime.feed({
        sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
        sinceTs: typeof p.sinceTs === "number" ? p.sinceTs : undefined,
        limit: typeof p.limit === "number" ? p.limit : undefined,
      }),
    }));
    // The model the "Rewind and retry with X" button would use after a refused reply. Reads, sends nothing.
    method("thalamus.retryPick", (p) => runtime.retryPick(p));
    method("thalamus.plan.preview", (p) => {
      const out = runtime.previewPlan(p);
      return out ?? { ok: false, error: "not-running" };
    });
    // Phase F. `learning.run` is async, so it answers through `respond` itself.
    api.registerGatewayMethod("thalamus.learning.run", async ({ params, respond }) => {
      try {
        const dry = (params as Record<string, unknown> | undefined)?.dryRun !== false;
        respond(true, await runtime.learningRun({ dry }));
      } catch (err) {
        console.error("[thalamus] thalamus.learning.run failed", err);
        respond(true, { ok: false, error: String(err) });
      }
    });
    method("thalamus.learning.report", () => runtime.learningReport());
    method("thalamus.panel", () => runtime.panel());
    method("thalamus.learning.pin", (p) =>
      typeof p.taskId === "string" && typeof p.cardId === "string"
        ? runtime.pin({
            taskId: p.taskId,
            cardId: p.cardId,
            ...(typeof p.by === "string" ? { by: p.by } : {}),
          })
        : { ok: false, error: "taskId and cardId are required" },
    );
    method("thalamus.explain", (p) => {
      const d = typeof p.decisionId === "string" ? runtime.explain(p.decisionId) : undefined;
      return d ? { ok: true, decision: d } : { ok: false, error: "unknown-decision" };
    });

    // The load that started the runtime owns its heartbeat and its stop; a load that shares it adds neither.
    const timer = shared
      ? undefined
      : setInterval(() => {
          try {
            broadcast("thalamus.status", runtime.status());
            void runtime.maybeRefreshCards();
          } catch (err) {
            api.logger.warn(`[thalamus] heartbeat failed: ${String(err)}`);
          }
        }, HEARTBEAT_MS);
    timer?.unref?.();
    api.registerService({
      id: "tinkerclaw-thalamus",
      start: () => {},
      stop: () => {
        if (shared) return;
        clearInterval(timer);
        runtime.stop();
        if (live.get(cfg.dataDir) === runtime) live.delete(cfg.dataDir);
      },
    });
    api.logger.info(
      `[thalamus] registered (mode=${cfg.mode}${shared ? ", sharing the running runtime" : ""})`,
    );
  },
});
