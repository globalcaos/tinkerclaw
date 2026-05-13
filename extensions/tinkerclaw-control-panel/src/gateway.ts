/**
 * FORK: tinkerclaw-control-panel — gateway method registrations.
 *
 * Exposes the control-panel.* RPCs to the agent and operator tooling. Each
 * handler is a thin shell that validates params and calls the matching
 * store-level function. Auth scope keys mirror existing fork plugins.
 */
import type { OpenClawPluginApi } from "../api.js";
import type { ControlPanelResolvedConfig } from "./paths.js";
import { pollMetricNow } from "./pollers/index.js";
import { addAxis, deleteAxis, listAxes, reorderAxes, updateAxis } from "./store/axes.js";
import { getCalendarDensity, listCalendarEvents } from "./store/calendar.js";
import {
  addEstPreset,
  deleteEstPreset,
  listEstPresets,
  reorderEstPresets,
  updateEstPreset,
} from "./store/est-presets.js";
import {
  addMetric,
  listMetrics,
  queryObservations,
  recordObservation,
} from "./store/observations.js";
import {
  addTask,
  dismissTask,
  getProgress,
  getTaskById,
  listTasks,
  removeTask,
  rescheduleTask,
  updateTask,
  type DismissalKind,
  type TaskAxis,
  type TaskListFilter,
  type TaskStatus,
} from "./store/tasks.js";
import { importTaskManifest, type TaskManifest } from "./tasks-import.js";

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

export function registerControlPanelMethods(params: {
  api: OpenClawPluginApi;
  cfg: ControlPanelResolvedConfig;
}) {
  const { api, cfg } = params;
  const log = (msg: string) => api.logger.info(`[control-panel] ${msg}`);

  // ───────────────────────────────────────────────────── tasks
  api.registerGatewayMethod(
    "control-panel.tasks.list",
    ok(({ params: p, respond }) => {
      const filter: TaskListFilter = {
        status: p?.status as TaskStatus | TaskStatus[] | undefined,
        axis: p?.axis as TaskAxis | TaskAxis[] | undefined,
        due_date_filter: p?.due_date_filter as TaskListFilter["due_date_filter"],
        briefing_pass_id: typeof p?.briefing_pass_id === "string" ? p.briefing_pass_id : undefined,
        since_ts: typeof p?.since_ts === "number" ? p.since_ts : undefined,
        limit: typeof p?.limit === "number" ? p.limit : undefined,
      };
      const rows = listTasks(cfg, filter);
      respond(true, { tasks: rows, count: rows.length });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.tasks.add",
    ok(({ params: p, respond }) => {
      if (typeof p?.text !== "string" || !p.text.trim()) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "tasks.add requires `text`",
        });
        return;
      }
      const row = addTask(cfg, {
        id: typeof p.id === "string" ? p.id : undefined,
        text: p.text.trim(),
        context_md: typeof p.context_md === "string" ? p.context_md : null,
        source: typeof p.source === "string" ? p.source : "conversation",
        source_ref: typeof p.source_ref === "string" ? p.source_ref : null,
        briefing_pass_id: typeof p.briefing_pass_id === "string" ? p.briefing_pass_id : null,
        priority_axis: p.priority_axis as TaskAxis | undefined,
        priority_rank: typeof p.priority_rank === "number" ? p.priority_rank : 50,
        due_date: typeof p.due_date === "string" ? p.due_date : null,
        est_minutes: typeof p.est_minutes === "number" ? p.est_minutes : null,
        hands: p.hands as "user" | "assistant" | "either" | undefined,
        inferred_signal: p.inferred_signal,
        metadata: p.metadata,
        recurrence_rule_text:
          typeof p.recurrence_rule_text === "string" ? p.recurrence_rule_text : null,
      });
      respond(true, { task: row });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.tasks.update",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string" || !p.id.trim()) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "tasks.update requires `id`",
        });
        return;
      }
      const row = updateTask(cfg, {
        id: p.id,
        status: p.status as TaskStatus | undefined,
        text: typeof p.text === "string" ? p.text : undefined,
        context_md:
          p.context_md === null
            ? null
            : typeof p.context_md === "string"
              ? p.context_md
              : undefined,
        priority_axis: p.priority_axis as TaskAxis | undefined,
        priority_rank: typeof p.priority_rank === "number" ? p.priority_rank : undefined,
        due_date:
          p.due_date === null ? null : typeof p.due_date === "string" ? p.due_date : undefined,
        est_minutes: typeof p.est_minutes === "number" ? p.est_minutes : undefined,
        hands: p.hands as "user" | "assistant" | "either" | undefined,
        inferred_signal: p.inferred_signal,
        metadata: p.metadata,
        note: typeof p.note === "string" ? p.note : undefined,
      });
      respond(true, { task: row });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.tasks.dismiss",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string" || typeof p?.dismissal_kind !== "string") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "tasks.dismiss requires `id` and `dismissal_kind`",
        });
        return;
      }
      const row = dismissTask(
        cfg,
        p.id,
        p.dismissal_kind as DismissalKind,
        typeof p.dismissal_note === "string" ? p.dismissal_note : undefined,
      );
      respond(true, { task: row });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.tasks.reschedule",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string" || typeof p?.due_date !== "string") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "tasks.reschedule requires `id` and `due_date`",
        });
        return;
      }
      const row = rescheduleTask(cfg, p.id, p.due_date);
      respond(true, { task: row });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.tasks.remove",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "tasks.remove requires `id`",
        });
        return;
      }
      const removed = removeTask(cfg, p.id);
      respond(true, { removed });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.tasks.import",
    ok(({ params: p, respond }) => {
      if (!p || typeof p.pass_id !== "string" || !Array.isArray(p.tasks)) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "tasks.import requires `pass_id` and `tasks[]`",
        });
        return;
      }
      const manifest: TaskManifest = {
        version: (typeof p.version === "number" ? p.version : 2) as 1 | 2,
        pass_id: p.pass_id,
        delivered_to_user_at:
          typeof p.delivered_to_user_at === "number" ? p.delivered_to_user_at : undefined,
        prune_missing: Boolean(p.prune_missing),
        tasks: p.tasks as TaskManifest["tasks"],
      };
      const result = importTaskManifest(cfg, manifest);
      respond(true, result);
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.tasks.progress",
    ok(({ params: p, respond }) => {
      const passId = typeof p?.pass_id === "string" ? p.pass_id : null;
      respond(true, getProgress(cfg, passId));
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.tasks.get",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string") {
        respond(false, undefined, { code: "invalid_argument", message: "tasks.get requires `id`" });
        return;
      }
      const row = getTaskById(cfg, p.id);
      if (!row) {
        respond(false, undefined, { code: "not_found", message: `no task with id ${p.id}` });
        return;
      }
      respond(true, { task: row });
    }),
    { scope: READ_SCOPE },
  );

  // ───────────────────────────────────────────────────── metrics
  api.registerGatewayMethod(
    "control-panel.list",
    ok(({ respond }) => {
      respond(true, { metrics: listMetrics(cfg) });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.add-metric",
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

  api.registerGatewayMethod(
    "control-panel.record",
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

  api.registerGatewayMethod(
    "control-panel.query",
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

  // FORK 2026-05-13 — on-demand re-poll for the per-row ↻ button in the
  // exec-panel Pulse tab. Runs the metric's registered poller synchronously
  // and writes one observation.
  api.registerGatewayMethod(
    "control-panel.metrics.poll",
    async ({ params: p, respond }) => {
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
    },
    { scope: WRITE_SCOPE },
  );

  // ───────────────────────────────────────────────────── calendar
  api.registerGatewayMethod(
    "control-panel.calendar.list",
    ok(({ params: p, respond }) => {
      if (typeof p?.from !== "string" || typeof p?.to !== "string") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "calendar.list requires `from` and `to` (ISO date strings)",
        });
        return;
      }
      const rows = listCalendarEvents(cfg, {
        from: p.from,
        to: p.to,
        source:
          typeof p.source === "string"
            ? (p.source as "google.primary" | "outlook.serra" | "manual")
            : undefined,
      });
      respond(true, { events: rows });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.calendar.density",
    ok(({ params: p, respond }) => {
      if (typeof p?.from !== "string" || typeof p?.to !== "string") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "calendar.density requires `from` and `to`",
        });
        return;
      }
      const rows = getCalendarDensity(cfg, {
        from: p.from,
        to: p.to,
        source:
          typeof p.source === "string"
            ? (p.source as "google.primary" | "outlook.serra" | "manual")
            : undefined,
      });
      respond(true, { density: rows });
    }),
    { scope: READ_SCOPE },
  );

  // ───────────────────────────────────────────────────── axes (v3.3)
  api.registerGatewayMethod(
    "control-panel.axes.list",
    ok(({ respond }) => {
      respond(true, { axes: listAxes(cfg) });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.axes.add",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string" || !p.id.trim()) {
        respond(false, undefined, { code: "invalid_argument", message: "axes.add requires `id`" });
        return;
      }
      if (typeof p?.label !== "string" || !p.label.trim()) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "axes.add requires `label`",
        });
        return;
      }
      const row = addAxis(cfg, {
        id: p.id.trim(),
        label: p.label.trim(),
        position: typeof p.position === "number" ? p.position : undefined,
      });
      respond(true, { axis: row });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.axes.update",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string" || !p.id.trim()) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "axes.update requires `id`",
        });
        return;
      }
      const row = updateAxis(cfg, {
        id: p.id,
        label: typeof p.label === "string" ? p.label : undefined,
        position: typeof p.position === "number" ? p.position : undefined,
      });
      respond(true, { axis: row });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.axes.delete",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string" || !p.id.trim()) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "axes.delete requires `id`",
        });
        return;
      }
      const reassignTo =
        p.reassign_to === null ? null : typeof p.reassign_to === "string" ? p.reassign_to : "meta";
      const result = deleteAxis(cfg, p.id, reassignTo);
      respond(true, result);
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.axes.reorder",
    ok(({ params: p, respond }) => {
      if (!Array.isArray(p?.ids) || p.ids.some((x: unknown) => typeof x !== "string")) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "axes.reorder requires `ids: string[]`",
        });
        return;
      }
      const rows = reorderAxes(cfg, p.ids as string[]);
      respond(true, { axes: rows });
    }),
    { scope: WRITE_SCOPE },
  );

  // ───────────────────────────────────────────────────── est-presets (v3.3)
  api.registerGatewayMethod(
    "control-panel.est-presets.list",
    ok(({ respond }) => {
      respond(true, { presets: listEstPresets(cfg) });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.est-presets.add",
    ok(({ params: p, respond }) => {
      if (typeof p?.minutes !== "number" || p.minutes <= 0) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "est-presets.add requires positive `minutes`",
        });
        return;
      }
      if (typeof p?.label !== "string" || !p.label.trim()) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "est-presets.add requires `label`",
        });
        return;
      }
      const row = addEstPreset(cfg, {
        minutes: p.minutes,
        label: p.label.trim(),
        position: typeof p.position === "number" ? p.position : undefined,
      });
      respond(true, { preset: row });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.est-presets.update",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "number") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "est-presets.update requires `id`",
        });
        return;
      }
      const row = updateEstPreset(cfg, {
        id: p.id,
        minutes: typeof p.minutes === "number" ? p.minutes : undefined,
        label: typeof p.label === "string" ? p.label : undefined,
        position: typeof p.position === "number" ? p.position : undefined,
      });
      respond(true, { preset: row });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.est-presets.delete",
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "number") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "est-presets.delete requires `id`",
        });
        return;
      }
      respond(true, deleteEstPreset(cfg, p.id));
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "control-panel.est-presets.reorder",
    ok(({ params: p, respond }) => {
      if (!Array.isArray(p?.ids) || p.ids.some((x: unknown) => typeof x !== "number")) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "est-presets.reorder requires `ids: number[]`",
        });
        return;
      }
      const rows = reorderEstPresets(cfg, p.ids as number[]);
      respond(true, { presets: rows });
    }),
    { scope: WRITE_SCOPE },
  );

  log(
    "registered control-panel.{tasks.*, list, add-metric, record, query, calendar.*, axes.*, est-presets.*}",
  );
}
