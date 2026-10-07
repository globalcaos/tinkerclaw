import { describe, expect, it } from "vitest";
import { DEFAULT_BIND_HOST, isLoopbackBindHost, resolveRelayBind } from "./bind-host.js";

const PORT = 18792;

describe("isLoopbackBindHost", () => {
  it("accepts the loopback forms the relay treats as local", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LocalHost", "::1", "[::1]"]) {
      expect(isLoopbackBindHost(host), host).toBe(true);
    }
  });

  it("rejects LAN, wildcard and public hosts", () => {
    for (const host of ["0.0.0.0", "192.168.1.100", "10.0.0.5", "::", "example.com"]) {
      expect(isLoopbackBindHost(host), host).toBe(false);
    }
  });
});

describe("resolveRelayBind", () => {
  it("defaults to loopback when bindHost is unset, blank or not a string", () => {
    for (const pluginConfig of [{}, { bindHost: "   " }, { bindHost: 42 }, null]) {
      const decision = resolveRelayBind({ pluginConfig, port: PORT, env: {} });
      expect(decision.bindHost).toBe(DEFAULT_BIND_HOST);
      expect(decision.allowed).toBe(true);
    }
  });

  it("allows loopback with no gateway token at all", () => {
    const decision = resolveRelayBind({
      pluginConfig: { bindHost: "127.0.0.1" },
      port: PORT,
      env: {},
    });
    expect(decision.allowed).toBe(true);
  });

  it("REFUSES a non-loopback bindHost when no gateway token is configured", () => {
    const decision = resolveRelayBind({
      pluginConfig: { bindHost: "0.0.0.0" },
      port: PORT,
      env: {},
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("unreachable");
    }
    expect(decision.reason).toContain("0.0.0.0");
    expect(decision.reason).toContain("gateway.auth.token");
  });

  it("refuses when the configured token is an empty string", () => {
    const decision = resolveRelayBind({
      pluginConfig: { bindHost: "192.168.1.100" },
      gatewayAuthToken: "   ",
      port: PORT,
      env: {},
    });
    expect(decision.allowed).toBe(false);
  });

  it("allows a non-loopback bindHost once a config token is set", () => {
    const decision = resolveRelayBind({
      pluginConfig: { bindHost: "192.168.1.100" },
      gatewayAuthToken: "s3cret",
      port: PORT,
      env: {},
    });
    expect(decision).toEqual({ bindHost: "192.168.1.100", allowed: true });
  });

  it("accepts a SecretRef object as a configured token (it resolves at relay startup)", () => {
    const decision = resolveRelayBind({
      pluginConfig: { bindHost: "0.0.0.0" },
      gatewayAuthToken: { $secret: "op://vault/item/token" },
      port: PORT,
      env: {},
    });
    expect(decision.allowed).toBe(true);
  });

  it("accepts the env token under either supported variable", () => {
    for (const key of ["OPENCLAW_GATEWAY_TOKEN", "CLAWDBOT_GATEWAY_TOKEN"]) {
      const decision = resolveRelayBind({
        pluginConfig: { bindHost: "0.0.0.0" },
        port: PORT,
        env: { [key]: "from-env" },
      });
      expect(decision.allowed, key).toBe(true);
    }
  });

  it("ignores a blank env token", () => {
    const decision = resolveRelayBind({
      pluginConfig: { bindHost: "0.0.0.0" },
      port: PORT,
      env: { OPENCLAW_GATEWAY_TOKEN: "  " },
    });
    expect(decision.allowed).toBe(false);
  });
});
