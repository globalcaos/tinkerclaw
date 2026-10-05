/**
 * FORK: bind-host policy for the Tinkerclaw Browser Relay.
 *
 * Kept in its own module (no plugin-SDK import) so the security decision — may this relay
 * listen on a non-loopback interface? — is unit-testable on its own.
 *
 * Why the guard exists: the relay hands a CDP control channel to whoever connects, which is
 * full control of the shared browser tabs. The relay itself does authenticate
 * (src/browser/extension-relay.ts upgrade handler), and it refuses to start without a gateway
 * token at all (src/browser/extension-relay-auth.ts:72). This guard is the second lock: it
 * fails loudly at config time instead of leaving a LAN-exposed port to a runtime error.
 */

export const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * Local loopback check. The gateway's isLoopbackHost lives in src/gateway/net.ts and is not
 * reachable from a bundled plugin (no plugin-sdk entrypoint exports it), so this plugin
 * carries its own minimal copy rather than importing across the boundary.
 */
export function isLoopbackBindHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "::ffff:127.0.0.1" ||
    /^127\./.test(h)
  );
}

export type RelayBindDecision =
  | { bindHost: string; allowed: true }
  | { bindHost: string; allowed: false; reason: string };

export function resolveRelayBind(params: {
  pluginConfig?: Record<string, unknown> | null;
  /** cfg.gateway.auth.token — a string, or a SecretRef object resolved later. */
  gatewayAuthToken?: unknown;
  env?: Record<string, string | undefined>;
  port: number;
}): RelayBindDecision {
  const raw = params.pluginConfig?.bindHost;
  const bindHost =
    (typeof raw === "string" ? raw.trim() : "") || DEFAULT_BIND_HOST;

  if (isLoopbackBindHost(bindHost)) {
    return { bindHost, allowed: true };
  }

  const env = params.env ?? {};
  const envToken =
    (env.OPENCLAW_GATEWAY_TOKEN ?? "").trim() ||
    (env.CLAWDBOT_GATEWAY_TOKEN ?? "").trim();
  const token = params.gatewayAuthToken;
  const hasConfigToken =
    typeof token === "string"
      ? token.trim().length > 0
      : typeof token === "object" && token !== null;

  if (envToken || hasConfigToken) {
    return { bindHost, allowed: true };
  }

  return {
    bindHost,
    allowed: false,
    reason:
      `Refusing to bind ${bindHost}:${params.port}: the relay hands out CDP control of shared tabs, ` +
      "and a non-loopback bindHost requires gateway.auth.token (or OPENCLAW_GATEWAY_TOKEN) so the " +
      `extension must authenticate. Set a gateway token, or leave bindHost at ${DEFAULT_BIND_HOST}.`,
  };
}
