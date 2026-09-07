/**
 * FORK: tinkerclaw-task-panel — gateway method registrations.
 *
 * Exposes the taskpanel.* RPCs (tasks + calendar + axes + est-presets) split
 * out of tinkerclaw-control-panel on 2026-07-24. Each handler is a thin shell
 * that validates params and calls the matching store-level function. Every
 * method is ALSO registered under its legacy `control-panel.*` name so
 * existing UI call sites keep working; the control-panel plugin itself is now
 * an inert shell and no longer registers anything.
 */
import type { OpenClawPluginApi } from "../api.js";
import type { ControlPanelResolvedConfig } from "./paths.js";
import { addAxis, deleteAxis, listAxes, reorderAxes, updateAxis } from "./store/axes.js";
import { syncGoogleCalendarRange } from "./store/calendar-sync.js";
import { getCalendarDensity, listCalendarEvents } from "./store/calendar.js";
import {
  addEstPreset,
  deleteEstPreset,
  listEstPresets,
  reorderEstPresets,
  updateEstPreset,
} from "./store/est-presets.js";
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

export function registerTaskPanelMethods(params: {
  api: OpenClawPluginApi;
  cfg: ControlPanelResolvedConfig;
}) {
  const { api, cfg } = params;
  const log = (msg: string) => api.logger.info(`[task-panel] ${msg}`);

  // Register one handler under its taskpanel.* name plus the legacy
  // control-panel.* alias the UI still calls.
  const register = (
    names: string[],
    handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1],
    opts: { scope: typeof READ_SCOPE | typeof WRITE_SCOPE },
  ) => {
    for (const name of names) api.registerGatewayMethod(name, handler, opts);
  };

  // Liveness probe for the exec-panel tab registry in tinker-ui.
  register(
    ["taskpanel.ping"],
    ok(({ respond }) => respond(true, { ok: true })),
    { scope: READ_SCOPE },
  );

  // ───────────────────────────────────────────────────── tasks
  register(
    ["taskpanel.tasks.list", "control-panel.tasks.list"],
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

  register(
    ["taskpanel.tasks.add", "control-panel.tasks.add"],
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

  register(
    ["taskpanel.tasks.update", "control-panel.tasks.update"],
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

  register(
    ["taskpanel.tasks.dismiss", "control-panel.tasks.dismiss"],
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

  register(
    ["taskpanel.tasks.reschedule", "control-panel.tasks.reschedule"],
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

  register(
    ["taskpanel.tasks.remove", "control-panel.tasks.remove"],
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

  register(
    ["taskpanel.tasks.import", "control-panel.tasks.import"],
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

  register(
    ["taskpanel.tasks.progress", "control-panel.tasks.progress"],
    ok(({ params: p, respond }) => {
      const passId = typeof p?.pass_id === "string" ? p.pass_id : null;
      respond(true, getProgress(cfg, passId));
    }),
    { scope: READ_SCOPE },
  );

  register(
    ["taskpanel.tasks.get", "control-panel.tasks.get"],
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

  // ───────────────────────────────────────────────────── calendar
  register(
    ["taskpanel.calendar.list", "control-panel.calendar.list"],
    ok(async ({ params: p, respond }) => {
      if (typeof p?.from !== "string" || typeof p?.to !== "string") {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "calendar.list requires `from` and `to` (ISO date strings)",
        });
        return;
      }
      // When refresh:true, the caller wants a fresh pull from Google before
      // reading the cache (used by the reschedule picker). Failure is logged
      // but non-fatal: we still serve whatever is cached.
      let syncInfo: { ok: boolean; synced: number; skipped: number; error?: string } | undefined;
      if (p.refresh === true) {
        syncInfo = await syncGoogleCalendarRange(cfg, { from: p.from, to: p.to });
        if (!syncInfo.ok) {
          // eslint-disable-next-line no-console
          console.warn(`[task-panel] calendar refresh failed: ${syncInfo.error}`);
        }
      }
      const rows = listCalendarEvents(cfg, {
        from: p.from,
        to: p.to,
        source:
          typeof p.source === "string"
            ? (p.source as "google.primary" | "outlook.serra" | "manual")
            : undefined,
      });
      respond(true, { events: rows, sync: syncInfo });
    }),
    { scope: READ_SCOPE },
  );

  register(
    ["taskpanel.calendar.density", "control-panel.calendar.density"],
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
  register(
    ["taskpanel.axes.list", "control-panel.axes.list"],
    ok(({ respond }) => {
      respond(true, { axes: listAxes(cfg) });
    }),
    { scope: READ_SCOPE },
  );

  register(
    ["taskpanel.axes.add", "control-panel.axes.add"],
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
      // v3.5 — optional parent_id. Null/undefined = top-level; non-empty
      // string = sub-group under an existing top-level axis. Depth cap is
      // enforced by addAxis (throws "nesting beyond two levels").
      let parentId: string | null | undefined;
      if (p.parent_id !== undefined && p.parent_id !== null) {
        if (typeof p.parent_id !== "string" || !p.parent_id.trim()) {
          respond(false, undefined, {
            code: "invalid_argument",
            message: "axes.add `parent_id` must be a non-empty string when provided",
          });
          return;
        }
        parentId = p.parent_id.trim();
      } else if (p.parent_id === null) {
        parentId = null;
      }
      try {
        const row = addAxis(cfg, {
          id: p.id.trim(),
          label: p.label.trim(),
          position: typeof p.position === "number" ? p.position : undefined,
          parent_id: parentId,
        });
        respond(true, { axis: row });
      } catch (err) {
        respond(false, undefined, {
          code: "axis_add_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
    { scope: WRITE_SCOPE },
  );

  register(
    ["taskpanel.axes.update", "control-panel.axes.update"],
    ok(({ params: p, respond }) => {
      if (typeof p?.id !== "string" || !p.id.trim()) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "axes.update requires `id`",
        });
        return;
      }
      // v3.5 — optional parent_id. Same shape as axes.add: undefined leaves
      // it unchanged, explicit null clears the parent (promote to top-level),
      // string sets a new parent. Depth cap enforced by updateAxis.
      let parentId: string | null | undefined;
      if (p.parent_id !== undefined && p.parent_id !== null) {
        if (typeof p.parent_id !== "string" || !p.parent_id.trim()) {
          respond(false, undefined, {
            code: "invalid_argument",
            message: "axes.update `parent_id` must be a non-empty string when provided",
          });
          return;
        }
        parentId = p.parent_id.trim();
      } else if (p.parent_id === null) {
        parentId = null;
      }
      try {
        const row = updateAxis(cfg, {
          id: p.id,
          label: typeof p.label === "string" ? p.label : undefined,
          position: typeof p.position === "number" ? p.position : undefined,
          parent_id: parentId,
        });
        respond(true, { axis: row });
      } catch (err) {
        respond(false, undefined, {
          code: "axis_update_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
    { scope: WRITE_SCOPE },
  );

  register(
    ["taskpanel.axes.delete", "control-panel.axes.delete"],
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

  register(
    ["taskpanel.axes.reorder", "control-panel.axes.reorder"],
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
  register(
    ["taskpanel.est-presets.list", "control-panel.est-presets.list"],
    ok(({ respond }) => {
      respond(true, { presets: listEstPresets(cfg) });
    }),
    { scope: READ_SCOPE },
  );

  register(
    ["taskpanel.est-presets.add", "control-panel.est-presets.add"],
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

  register(
    ["taskpanel.est-presets.update", "control-panel.est-presets.update"],
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

  register(
    ["taskpanel.est-presets.delete", "control-panel.est-presets.delete"],
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

  register(
    ["taskpanel.est-presets.reorder", "control-panel.est-presets.reorder"],
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
    "registered taskpanel.{ping, tasks.*, calendar.*, axes.*, est-presets.*} (+ control-panel.* aliases)",
  );
}
