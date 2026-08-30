/**
 * FORK: tinkerclaw-cron-panel — gateway method registrations.
 *
 * Read-only RPCs over the cron registry + report files (operator.read):
 *   cronpanel.ping    → {ok:true} (exec-tab liveness probe)
 *   cronpanel.list    → all jobs joined with their latest report
 *   cronpanel.reports → {jobId, days?} → report history for one job
 *
 * BOARD RPCs over the per-job cards (`~/.openclaw/cron/board/<jobId>.json`,
 * see board-types.ts). The split is by EFFECT, not by file: reading a board
 * ingests first — folding in every report written since the last visit — but
 * ingest only ever derives from the immutable report files, so it stays
 * operator.read:
 *   cronpanel.board.get    → {jobId} → {board}
 *   cronpanel.board.list   → {}      → {summaries} (one per registered job)
 *   cronpanel.board.digest → {jobId} → {digest} plain text for the cron agent
 *
 * Mutations carry operator.write, because they change what the NEXT nightly
 * run is told — a dismiss reason is an instruction, not a UI preference:
 *   cronpanel.board.read          {jobId, read}                   — whole-card ack (kept)
 *   cronpanel.board.acknowledge   {jobId, itemId, acknowledged}   — per-issue checkbox
 *   cronpanel.board.dismiss       {jobId, itemId, reason}         — reason is MANDATORY
 *   cronpanel.board.restore  {jobId, itemId}
 *   cronpanel.board.reorder  {jobId, itemIds}
 *   cronpanel.board.pin      {jobId, itemId, pinned}
 *
 * Every mutation responds with the board RE-READ FROM DISK, never with the
 * mutator's return value, so the UI can never paint a state that failed to
 * persist.
 */
import type { OpenClawPluginApi } from "../api.js";
import {
  acknowledgeItem,
  boardDigest,
  dismissItem,
  ingestBoard,
  markRead,
  pinItem,
  readBoard,
  reorderItems,
  restoreItem,
  summarizeBoard,
} from "./board-store.js";
import type { CronBoardSummary } from "./board-types.js";
import {
  listJobsJoined,
  readJobs,
  readReportsForJob,
  type CronPanelResolvedConfig,
} from "./cron-data.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

type GatewayMethodHandlerArg = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayParams = GatewayMethodHandlerArg["params"];
type GatewayRespond = GatewayMethodHandlerArg["respond"];

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

/**
 * A jobId names a FILE (`board/<jobId>.json`). The read-only side only ever
 * opened paths that already existed; the board side CREATES them, so a
 * traversal in the id would write outside the cron dir. Every registry id is a
 * slug or a UUID, so banning separators and `..` costs nothing real.
 */
function requireJobId(p: GatewayParams, method: string, respond: GatewayRespond): string | null {
  const jobId = typeof p?.jobId === "string" ? p.jobId.trim() : "";
  if (!jobId || jobId.includes("/") || jobId.includes("\\") || jobId.includes("..")) {
    respond(false, undefined, {
      code: "invalid_argument",
      message: `${method} requires a plain \`jobId\``,
    });
    return null;
  }
  return jobId;
}

function requireItemId(p: GatewayParams, method: string, respond: GatewayRespond): string | null {
  const itemId = typeof p?.itemId === "string" ? p.itemId.trim() : "";
  if (!itemId) {
    respond(false, undefined, {
      code: "invalid_argument",
      message: `${method} requires \`itemId\``,
    });
    return null;
  }
  return itemId;
}

/**
 * Returns null AFTER responding. `false` is a legal value here, so callers must
 * compare against null — a truthiness check would reject un-reading a card.
 */
function requireBoolean(
  p: GatewayParams,
  key: string,
  method: string,
  respond: GatewayRespond,
): boolean | null {
  const value = p?.[key];
  if (typeof value !== "boolean") {
    respond(false, undefined, {
      code: "invalid_argument",
      message: `${method} requires a boolean \`${key}\``,
    });
    return null;
  }
  return value;
}

/**
 * Ingest THEN read. Opening a card must fold in every report written since the
 * last visit, and ingest only ever derives from the immutable report files —
 * which is why the three reading board methods stay on READ_SCOPE. The board
 * returned is the one that is ON DISK, not the mutator's in-memory view.
 */
async function freshBoard(cfg: CronPanelResolvedConfig, jobId: string) {
  await ingestBoard(cfg, jobId);
  return readBoard(cfg, jobId);
}

export function registerCronPanelMethods(params: {
  api: OpenClawPluginApi;
  cfg: CronPanelResolvedConfig;
}) {
  const { api, cfg } = params;

  api.registerGatewayMethod(
    "cronpanel.ping",
    ok(({ respond }) => respond(true, { ok: true })),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.list",
    ok(({ respond }) => {
      const jobs = listJobsJoined(cfg);
      respond(true, { jobs, count: jobs.length });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.reports",
    ok(({ params: p, respond }) => {
      if (typeof p?.jobId !== "string" || !p.jobId.trim()) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "cronpanel.reports requires `jobId`",
        });
        return;
      }
      const days = typeof p.days === "number" && p.days > 0 ? Math.min(p.days, 365) : 14;
      respond(true, { jobId: p.jobId, reports: readReportsForJob(cfg, p.jobId, days) });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.board.get",
    ok(async ({ params: p, respond }) => {
      const jobId = requireJobId(p, "cronpanel.board.get", respond);
      if (!jobId) return;
      respond(true, { board: await freshBoard(cfg, jobId) });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.board.list",
    ok(async ({ respond }) => {
      // One card per REGISTERED job, including jobs whose board is still empty:
      // a job that runs but never reports is exactly the silence this panel
      // exists to surface, so it must not vanish from the list.
      const summaries: CronBoardSummary[] = [];
      for (const job of readJobs(cfg)) {
        summaries.push(summarizeBoard(await freshBoard(cfg, job.id)));
      }
      respond(true, { summaries, count: summaries.length });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.board.digest",
    ok(async ({ params: p, respond }) => {
      const jobId = requireJobId(p, "cronpanel.board.digest", respond);
      if (!jobId) return;
      // Ingest first: a cron reading its own digest at run start may be the
      // FIRST reader since last night, and nothing else would have folded that
      // report in. Ingest is idempotent via lastIngestedDate.
      await ingestBoard(cfg, jobId);
      respond(true, { jobId, digest: await boardDigest(cfg, jobId) });
    }),
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.board.read",
    ok(async ({ params: p, respond }) => {
      const jobId = requireJobId(p, "cronpanel.board.read", respond);
      if (!jobId) return;
      const read = requireBoolean(p, "read", "cronpanel.board.read", respond);
      if (read === null) return;
      await markRead(cfg, jobId, read);
      respond(true, { board: await readBoard(cfg, jobId) });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.board.acknowledge",
    ok(async ({ params: p, respond }) => {
      const jobId = requireJobId(p, "cronpanel.board.acknowledge", respond);
      if (!jobId) return;
      const itemId = requireItemId(p, "cronpanel.board.acknowledge", respond);
      if (!itemId) return;
      const acknowledged = requireBoolean(
        p,
        "acknowledged",
        "cronpanel.board.acknowledge",
        respond,
      );
      if (acknowledged === null) return;
      await acknowledgeItem(cfg, jobId, itemId, acknowledged);
      respond(true, { board: await readBoard(cfg, jobId) });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.board.dismiss",
    ok(async ({ params: p, respond }) => {
      const jobId = requireJobId(p, "cronpanel.board.dismiss", respond);
      if (!jobId) return;
      const itemId = requireItemId(p, "cronpanel.board.dismiss", respond);
      if (!itemId) return;
      // The reason is the instruction channel back to the cron (boardDigest
      // replays it), so a blank one is REJECTED, never stored.
      const reason = typeof p?.reason === "string" ? p.reason.trim() : "";
      if (!reason) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "cronpanel.board.dismiss requires a non-empty `reason`",
        });
        return;
      }
      await dismissItem(cfg, jobId, itemId, reason);
      respond(true, { board: await readBoard(cfg, jobId) });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.board.restore",
    ok(async ({ params: p, respond }) => {
      const jobId = requireJobId(p, "cronpanel.board.restore", respond);
      if (!jobId) return;
      const itemId = requireItemId(p, "cronpanel.board.restore", respond);
      if (!itemId) return;
      await restoreItem(cfg, jobId, itemId);
      respond(true, { board: await readBoard(cfg, jobId) });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.board.reorder",
    ok(async ({ params: p, respond }) => {
      const jobId = requireJobId(p, "cronpanel.board.reorder", respond);
      if (!jobId) return;
      const rawIds = p?.itemIds;
      if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string" || !id.trim())) {
        respond(false, undefined, {
          code: "invalid_argument",
          message: "cronpanel.board.reorder requires `itemIds` as an array of strings",
        });
        return;
      }
      const itemIds = (rawIds as string[]).map((id) => id.trim());
      await reorderItems(cfg, jobId, itemIds);
      respond(true, { board: await readBoard(cfg, jobId) });
    }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "cronpanel.board.pin",
    ok(async ({ params: p, respond }) => {
      const jobId = requireJobId(p, "cronpanel.board.pin", respond);
      if (!jobId) return;
      const itemId = requireItemId(p, "cronpanel.board.pin", respond);
      if (!itemId) return;
      const pinned = requireBoolean(p, "pinned", "cronpanel.board.pin", respond);
      if (pinned === null) return;
      await pinItem(cfg, jobId, itemId, pinned);
      respond(true, { board: await readBoard(cfg, jobId) });
    }),
    { scope: WRITE_SCOPE },
  );

  api.logger.info(
    "[cron-panel] registered cronpanel.{ping, list, reports} + " +
      "cronpanel.board.{get, list, digest, read, acknowledge, dismiss, restore, reorder, pin}",
  );
}
