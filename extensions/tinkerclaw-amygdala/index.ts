/**
 * Digital amygdala (J11 v6.7) — plugin entry.
 *
 * The plugin ships DISABLED (`enabledByDefault: false`); `register()` only runs when an owner enables it. All logic
 * lives in `src/runtime.ts`; this file is the thin wiring into the gateway plugin API (design doc §3 M11): two loopback
 * HTTP routes for the hooks, gateway methods for the UI and the by-hand nightly script, the native tool-call handlers, a 60 s heartbeat and a
 * service whose only job is to stop the runtime. Nothing here runs at import time.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  definePluginEntry,
  resolveGatewayPort,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { parseConfig } from "./src/config.js";
import { embeddedExplainRun } from "./src/explain-run.js";
import { createHttpHandlers, DECIDE_PATH, NOTES_PATH, WAIT_PATH } from "./src/http.js";
import { registerNativeHandlers } from "./src/native.js";
import { createRuntime } from "./src/runtime.js";
import type { V31ProbeInput } from "./src/v31-probe.js";

const V31_PLUGIN_ID = "tinkerclaw-learned-intuition";
const HEARTBEAT_MS = 60_000;

type ConfigShape = {
  plugins?: { entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }> };
};

/** What the v3.1 probe needs from the live gateway config. */
function readV31Config(api: OpenClawPluginApi): V31ProbeInput["pluginConfig"] {
  let cfg: unknown;
  try {
    cfg = api.runtime.config.current();
  } catch {
    cfg = api.config;
  }
  const entry = (cfg as ConfigShape | undefined)?.plugins?.entries?.[V31_PLUGIN_ID];
  if (!entry) return undefined;
  const c = entry.config ?? {};
  return {
    enabled: entry.enabled,
    observeOnly: typeof c.observeOnly === "boolean" ? c.observeOnly : undefined,
    hookEnforcement: typeof c.hookEnforcement === "boolean" ? c.hookEnforcement : undefined,
  };
}

export default definePluginEntry({
  id: "tinkerclaw-amygdala",
  name: "Amygdala (Jev)",
  description:
    "Digital amygdala: a typed fast judge (Jev) answers questions about each agent step and code chooses the response. Ships disabled; shadow mode by default.",
  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") return;
    const cfg = parseConfig(api.pluginConfig as Record<string, unknown> | undefined);

    let port = 0;
    try {
      port = resolveGatewayPort(api.config);
    } catch {
      port = 0;
    }
    if (!(port > 0)) {
      api.logger.warn(
        "[amygdala] gateway port unknown; endpoint.json gets port 0, so the hooks fail open",
      );
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

    const runtime = createRuntime({
      config: cfg,
      // questions/ and hooks/ sit next to this file; shipping them in dist needs STATIC_EXTENSION_ASSETS entries.
      extensionRoot: dirname(fileURLToPath(import.meta.url)),
      gatewayPort: port,
      // Rewind re-points a chat tab through the bridge's session map. Only reached while the plugin is enabled, and the file
      // is touched only when the user presses Rewind or Undo.
      bridgeMapFile: true,
      v31: { readPluginConfig: () => readV31Config(api) },
      emit: broadcast,
      logger: api.logger,
      explainRun: embeddedExplainRun(
        {
          currentConfig: () => {
            try {
              return api.runtime.config.current();
            } catch {
              return api.config;
            }
          },
          runEmbeddedPiAgent: (p) =>
            api.runtime.agent.runEmbeddedPiAgent(
              p as unknown as Parameters<typeof api.runtime.agent.runEmbeddedPiAgent>[0],
            ),
          resolveAgentDir: (c, id) => api.runtime.agent.resolveAgentDir(c as typeof api.config, id),
          resolveAgentWorkspaceDir: (c, id) =>
            api.runtime.agent.resolveAgentWorkspaceDir(c as typeof api.config, id),
        },
        cfg.explain.timeoutMs,
      ),
    });
    try {
      runtime.start();
    } catch (err) {
      // Routes below still register and fail open ("runtime not started"); the hooks never see a 500.
      api.logger.error(`[amygdala] runtime failed to start: ${String(err)}`);
    }

    // The token lives in endpoint.json, rewritten at every start; the handlers read it per request.
    const handlers = createHttpHandlers(runtime, () => runtime.token());
    api.registerHttpRoute({
      path: DECIDE_PATH,
      auth: "plugin",
      match: "exact",
      handler: handlers.decide,
    });
    api.registerHttpRoute({
      path: WAIT_PATH,
      auth: "plugin",
      match: "exact",
      handler: handlers.wait,
    });
    api.registerHttpRoute({
      path: NOTES_PATH,
      auth: "plugin",
      match: "exact",
      handler: handlers.notes,
    });

    api.registerGatewayMethod("amygdala2.status", ({ respond }) => {
      try {
        respond(true, runtime.status());
      } catch (err) {
        respond(true, { ok: false, error: String(err) });
      }
    });
    api.registerGatewayMethod("amygdala2.feed", ({ params, respond }) => {
      try {
        const p = params as { sessionKey?: unknown; sinceTs?: unknown; limit?: unknown };
        respond(
          true,
          runtime.feed({
            sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
            sinceTs: typeof p.sinceTs === "number" ? p.sinceTs : undefined,
            limit: typeof p.limit === "number" ? p.limit : undefined,
          }),
        );
      } catch (err) {
        respond(true, { ok: false, error: String(err) });
      }
    });
    api.registerGatewayMethod("amygdala2.reviews", ({ params, respond }) => {
      try {
        const p = (params ?? {}) as { sinceTs?: unknown };
        respond(true, runtime.reviewReport(typeof p.sinceTs === "number" ? p.sinceTs : undefined));
      } catch (err) {
        respond(true, { ok: false, error: String(err) });
      }
    });
    api.registerGatewayMethod("amygdala2.answer", ({ params, respond }) => {
      const p = params as { interventionId?: unknown; answer?: unknown };
      const ok =
        typeof p.interventionId === "string" &&
        typeof p.answer === "string" &&
        runtime.answer(p.interventionId, p.answer);
      respond(true, { ok });
    });

    // Learning and rewind (design §7.3). Every method answers `{ok:false, error}` instead of throwing.
    const method = (
      name: string,
      fn: (p: Record<string, unknown>) => unknown | Promise<unknown>,
    ): void => {
      api.registerGatewayMethod(name, async ({ params, respond }) => {
        try {
          respond(true, await fn((params ?? {}) as Record<string, unknown>));
        } catch (err) {
          console.error(`[amygdala] ${name} failed`, err);
          respond(true, { ok: false, error: String(err) });
        }
      });
    };
    const text = (v: unknown, name: string): string => {
      if (typeof v !== "string" || v === "") throw new Error(`${name} is required`);
      return v;
    };
    method("amygdala2.label", (p) => {
      const kind = text(p.kind, "kind");
      if (!["outcome", "judge", "useful", "miss", "undone"].includes(kind))
        throw new Error("bad kind");
      if (p.value !== -1 && p.value !== 0 && p.value !== 1)
        throw new Error("value must be -1, 0 or 1");
      const targetKind = p.targetKind === "verdict" ? "verdict" : "decision";
      // A vote on an explained decision also records whether it matched the explainer's suggestion.
      if (kind === "useful" && targetKind === "decision")
        runtime.explanationVote(text(p.targetId, "targetId"), p.value as number);
      return {
        ok: true,
        ...runtime.learning().label({
          targetId: text(p.targetId, "targetId"),
          targetKind,
          kind: kind as "outcome" | "judge" | "useful" | "miss" | "undone",
          value: p.value,
        }),
      };
    });
    method("amygdala2.approve", (p) =>
      runtime.learning().approve(text(p.changeId, "changeId"), p.approve === true),
    );
    method("amygdala2.undo", (p) => runtime.learning().undo(text(p.changeId, "changeId")));
    method("amygdala2.propose", async (p) => {
      const cand = p.candidate;
      if (!cand || typeof cand !== "object") throw new Error("candidate is required");
      return {
        ok: true,
        outcome: await runtime
          .learning()
          .propose(
            text(p.questionId, "questionId"),
            cand as Record<string, unknown>,
            String(p.source ?? "nightly-script"),
          ),
      };
    });
    method("amygdala2.nightly", async () => ({
      ok: true,
      ...(await runtime.learning().nightly()),
    }));
    method("amygdala2.canary", async () => ({ ok: true, ...(await runtime.canary()) }));
    method("amygdala2.questionRecord", (p) => {
      const q = runtime.learning().questionRecord(text(p.questionId, "questionId"));
      return q ? { ok: true, question: q } : { ok: false, error: "unknown-question" };
    });
    method("amygdala2.replay", async (p) => {
      const at = p.at;
      if (typeof at !== "number" || !Number.isFinite(at))
        throw new Error("at must be a time in ms");
      const r = await runtime.replay({
        sessionKey: text(p.sessionKey, "sessionKey"),
        at,
        prompt: typeof p.prompt === "string" ? p.prompt : "",
        reply: text(p.reply, "reply"),
      });
      return {
        ok: true,
        decisionId: r.id,
        turnId: r.situation.turnId,
        response: r.decision.response.kind,
        reasonCode: r.decision.reasonCode,
      };
    });
    method("amygdala2.rewind", (p) =>
      runtime.learning().rewind({
        sessionKey: text(p.sessionKey, "sessionKey"),
        turnId: typeof p.turnId === "string" ? p.turnId : "",
        undo: p.undo === true,
      }),
    );

    registerNativeHandlers(api, runtime);

    const timer = setInterval(() => {
      try {
        runtime.heartbeat();
      } catch (err) {
        api.logger.warn(`[amygdala] heartbeat failed: ${String(err)}`);
      }
    }, HEARTBEAT_MS);
    timer.unref?.();
    api.registerService({
      id: "tinkerclaw-amygdala",
      start: () => {},
      stop: () => {
        clearInterval(timer);
        runtime.stop();
      },
    });

    const failed = runtime.startError();
    if (failed) {
      api.logger.error(
        `[amygdala] loaded but NOT running (mode=${cfg.mode}): ${failed} — status reports "Not running"`,
      );
    } else {
      api.logger.info(
        `[amygdala] started (mode=${cfg.mode}, dataDir=${cfg.dataDir}, port=${port}, floorActive=${runtime.floorActive()})`,
      );
    }
  },
});
