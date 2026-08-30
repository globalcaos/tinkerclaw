/**
 * FORK: tinkerclaw-pulse-panel — gateway method registrations.
 *
 * Exposes the pulsepanel.* RPCs (metrics list/add/record/query + on-demand
 * poll) split out of tinkerclaw-control-panel on 2026-07-24. Every method is
 * ALSO registered under its legacy `control-panel.*` name so existing UI
 * call sites keep working; the control-panel plugin itself is now an inert
 * shell and no longer registers anything.
 */
import type { OpenClawPluginApi } from "../api.js";
import type { ControlPanelResolvedConfig } from "./paths.js";
import { pollMetricNow } from "./pollers/index.js";
import {
  addMetric,
  listMetrics,
  queryObservations,
  recordObservation,
} from "./store/observations.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

type GatewayMethodHandlerArg = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];

function ok(handler: (p: GatewayMethodHandlerArg) => Promise<void> | void) {
  return async (arg: GatewayMethodHandlerArg) => {
    try {
      await handler(arg);
    } catch (err) {
      arg.respond(false, undefined, {
        code: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function registerPulsePanelMethods(params: {
  api: OpenClawPluginApi;
  cfg: ControlPanelResolvedConfig;
}) {
  const { api, cfg } = params;
  const log = (msg: string) => api.logger.info(`[pulse-panel] ${msg}`);

  // Register one handler under its pulsepanel.* name plus legacy aliases.
  const register = (
    names: string[],
    handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1],
    opts: { scope: typeof READ_SCOPE | typeof WRITE_SCOPE },
  ) => {
    for (const name of names) api.registerGatewayMethod(name, handler, opts);
  };

  // Liveness probe for the exec-panel tab registry in tinker-ui.
  register(
    ["pulsepanel.ping"],
    ok(({ respond }) => respond(true, { ok: true })),
    { scope: READ_SCOPE },
  );

  register(
    ["pulsepanel.list", "control-panel.list"],
    ok(({ respond }) => {
      respond(true, { metrics: listMetrics(cfg) });
    }),
    { scope: READ_SCOPE },
  );

  register(
    ["pulsepanel.add-metric", "control-panel.add-metric"],
    ok(({ params: p, respond }) => {
      if (
        typeof p?.id !== "string" ||
        typeof p?.class !== "string" ||
        typeof p?.source !== "string"
      ) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "add-metric requires `id`, `class` (LIVE|SNAPSHOT), and `source`",
        });
        return;
      }
      const metric = addMetric(cfg, {
        id: p.id,
        class: p.class as "LIVE" | "SNAPSHOT",
        source: p.source,
        cadence_seconds: typeof p.cadence_seconds === "number" ? p.cadence_seconds : null,
        template:
          (p.template as "sparkline" | "single-stat" | "traffic-light" | "streak" | "bar-trend") ??
          "sparkline",
        labels_schema: p.labels_schema,
        alert_rule: p.alert_rule,
        retention_days: typeof p.retention_days === "number" ? p.retention_days : undefined,
      });
      respond(true, { metric });
    }),
    { scope: WRITE_SCOPE },
  );

  register(
    ["pulsepanel.record", "control-panel.record"],
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string" || typeof p?.value !== "number") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "record requires `id` and `value` (number)",
        });
        return;
      }
      recordObservation(cfg, {
        metric_id: p.id,
        value: p.value,
        ts: typeof p.ts === "number" ? p.ts : undefined,
        labels:
          typeof p.labels === "object" && p.labels
            ? (p.labels as Record<string, unknown>)
            : undefined,
      });
      respond(true, { ok: true });
    }),
    { scope: WRITE_SCOPE },
  );

  register(
    ["pulsepanel.query", "control-panel.query"],
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string") {
        respond(false, undefined, { code: "invalid_argument", message: "query requires `id`" });
        return;
      }
      const rows = queryObservations(cfg, {
        metric_id: p.id,
        from_ts: typeof p.from_ts === "number" ? p.from_ts : undefined,
        to_ts: typeof p.to_ts === "number" ? p.to_ts : undefined,
        limit: typeof p.limit === "number" ? p.limit : undefined,
      });
      respond(true, { observations: rows });
    }),
    { scope: READ_SCOPE },
  );

  // On-demand re-poll for the per-row ↻ button in the exec-panel Pulse tab.
  // Runs the metric's registered poller synchronously and writes one
  // observation.
  const pollHandler = async ({ params: p, respond }: GatewayMethodHandlerArg) => {
    try {
      if (typeof p?.id !== "string") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "metrics.poll requires `id`",
        });
        return;
      }
      const result = await pollMetricNow(cfg, p.id, api.logger);
      respond(true, { ok: true, ...result });
    } catch (err) {
      respond(false, undefined, {
        code: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
  register(["pulsepanel.metrics.poll", "control-panel.metrics.poll"], pollHandler, {
    scope: WRITE_SCOPE,
  });

  log(
    "registered pulsepanel.{ping, list, add-metric, record, query, metrics.poll} (+ control-panel.* aliases)",
  );
}
