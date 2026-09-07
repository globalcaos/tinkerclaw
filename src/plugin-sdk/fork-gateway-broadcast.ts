/**
 * FORK: the gateway broadcast callback TYPE, as a declared plugin-SDK surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tinkerclaw-auth-reload` is handed a broadcast function by the host so it can announce
 * that an auth profile was re-armed. It needs the function's type to store it; it was
 * importing that type by relative path from `src/gateway/server-broadcast`.
 *
 * A TYPE ONLY, and deliberately so. This publishes the SHAPE of a callback the host
 * already hands to extensions — it grants no ability to broadcast that an extension did
 * not already have, because the function itself still has to be given to it. Typing a
 * capability you were handed is not the same as acquiring one.
 */

export type { GatewayBroadcastFn } from "../gateway/server-broadcast.js";
