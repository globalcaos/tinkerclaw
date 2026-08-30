export type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};

export type GatewayBroadcastOpts = {
  dropIfSlow?: boolean;
  stateVersion?: GatewayBroadcastStateVersion;
};

/**
 * Per-broadcast delivery counters.
 *
 * FORK 2026-08-26 (chat-deliver): `broadcastInternal` used to return nothing and
 * swallowed every per-socket failure in a bare ignore-catch, so "this chat final
 * reached zero sockets" was indistinguishable from a healthy delivery in every
 * log the gateway produces. Every broadcast now yields these counters —
 * including the zero-client early return, which yields a ZEROED object and never
 * `undefined`, so a broadcast with nobody connected stays observable.
 *
 * `attempted` counts the clients this call considered, after any `targetConnIds`
 * filter. The buckets do NOT always sum to `attempted`: a slow client without
 * `dropIfSlow` is closed with 1008 and lands only in `attempted`, so the residual
 * `attempted - (sent + scopeSkipped + droppedSlow + sendThrew)` is the number of
 * slow consumers this broadcast disconnected.
 */
export type GatewayBroadcastCounts = {
  attempted: number;
  sent: number;
  scopeSkipped: number;
  droppedSlow: number;
  sendThrew: number;
};

// Returns `GatewayBroadcastCounts | void`, not plain `GatewayBroadcastCounts`.
// This alias is a CONSUMER contract — several relays declare a broadcast
// callback and only forward it (e.g. `AttachGatewayWsConnectionHandlerParams` in
// server/ws-connection.ts hands its void-typed callback to
// `broadcastPresenceSnapshot`). Requiring the counters here would reject every
// one of those void-returning relays and force a signature cascade for a value
// none of them reads. The union admits them while still naming the counters in
// the shared type. For the precise counter type, use the `broadcast` returned by
// `createGatewayBroadcaster`, which is typed `=> GatewayBroadcastCounts`.
export type GatewayBroadcastFn = (
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
) => GatewayBroadcastCounts | void;

// Stays `void` on purpose. The targeted path shares `broadcastInternal`, so the
// counters are produced either way, but no caller reads them and a
// counter-returning function is assignable to a void-returning type — widening
// this alias would churn every targeted call site for nothing.
export type GatewayBroadcastToConnIdsFn = (
  event: string,
  payload: unknown,
  connIds: ReadonlySet<string>,
  opts?: GatewayBroadcastOpts,
) => void;
