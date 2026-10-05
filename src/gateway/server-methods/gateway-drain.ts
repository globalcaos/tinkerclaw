// FORK 2026-09-29 (TINKER_UI_DESIGN_BIBLE/lifecycles.md L4b) — `gateway.drain` / `gateway.drainRelease`.
//
// The restart skill calls `gateway.drain` BEFORE it stops the gateway: every live turn is brought
// to its next model-call boundary and held (infra/restart-drain.ts), with no systemd stop timeout
// in the way, so a long thinking call is never cut. The close handler then finds everything held
// and stops at once. `gateway.drainRelease` calls the restart off: every held turn goes on as if
// nothing had happened.
import { drainForRestart, releaseRestartDrain } from "../../infra/restart-drain.js";
import { noteRestartReason } from "../restart-notice.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_BUDGET_MS = 10 * 60_000;
const MAX_BUDGET_MS = 30 * 60_000;

export const gatewayDrainHandlers: GatewayRequestHandlers = {
  "gateway.drain": async ({ params, respond }) => {
    const p = params as { budgetMs?: unknown; reason?: unknown } | undefined;
    const raw = p?.budgetMs;
    const budgetMs =
      typeof raw === "number" && Number.isFinite(raw)
        ? Math.min(MAX_BUDGET_MS, Math.max(0, Math.floor(raw)))
        : DEFAULT_BUDGET_MS;
    // The reason shows in each paused chat's restart notice (restart-notice.ts).
    if (typeof p?.reason === "string") {
      noteRestartReason(p.reason);
    }
    const result = await drainForRestart(budgetMs);
    respond(true, result, undefined);
  },
  "gateway.drainRelease": async ({ respond }) => {
    noteRestartReason(undefined);
    await releaseRestartDrain();
    respond(true, { released: true }, undefined);
  },
};
