/**
 * FORK 2026-10-06: `jev.status` — is Jev dormant (no token), checking a token, armed, or refused. Read-only; the snapshot
 * carries no token. The chat chip and `openclaw jev status` both read it.
 */
import { jevAvailability, refreshJevNow } from "../../infra/jev/availability.js";
import type { GatewayRequestHandlers } from "./types.js";

export const jevHandlers: GatewayRequestHandlers = {
  "jev.status": ({ respond }) => {
    refreshJevNow();
    respond(true, jevAvailability());
  },
};
