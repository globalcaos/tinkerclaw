import { describe, expect, it, vi } from "vitest";
import type { JevAvailability } from "../infra/jev/availability.js";
import { formatJevStatus, readJevStatus } from "./jev-cli.js";

const base: JevAvailability = {
  state: "dormant",
  on: false,
  keySource: null,
  reason: "no-token",
  since: 1,
  lastProbe: null,
  breakerOpen: false,
  enables: ["safety checks", "routing reads", "recipe ranking"],
  tokenFile: "/home/x/.openclaw/jev/token",
  line: "Jev: off — no token (enables: safety checks, routing reads, recipe ranking)",
};

describe("openclaw jev status: the text", () => {
  it("dormant: says what is off, where to put the token, and that env needs a restart", () => {
    const out = formatJevStatus(base, "gateway").join("\n");
    expect(out).toContain("Jev: off — no token");
    expect(out).toContain("/home/x/.openclaw/jev/token");
    expect(out).toMatch(/without a restart/);
    expect(out).toMatch(/TYPESAFE_API_KEY.*restart/);
    expect(out).not.toMatch(/http/); // no pointer unless the owner configured one
  });

  it("shows the owner's token pointer only when it is configured", () => {
    const out = formatJevStatus(
      { ...base, tokenHelpUrl: "https://example.test/t" },
      "gateway",
    ).join("\n");
    expect(out).toContain("https://example.test/t");
  });

  it("armed: names the source and never prints a token", () => {
    const out = formatJevStatus(
      { ...base, state: "armed", on: true, keySource: "file", reason: "ok", line: "Jev: on" },
      "gateway",
    ).join("\n");
    expect(out).toContain("Jev: on");
    expect(out).toContain("token source: key file");
  });

  it("a local read says what it cannot know", () => {
    const out = formatJevStatus(
      {
        ...base,
        state: "unverified",
        on: true,
        keySource: "env",
        reason: "checking",
        line: "Jev: on — token not checked yet",
      },
      "local",
    ).join("\n");
    expect(out).toMatch(/gateway not reached/i);
    expect(out).toMatch(/armed or refused.*running gateway/i);
  });
});

describe("openclaw jev status: where it reads from", () => {
  it("uses the running gateway when it answers", async () => {
    const callGateway = vi.fn(async () => ({ ...base, state: "armed", on: true, line: "Jev: on" }));
    const local = vi.fn(() => base);
    const r = await readJevStatus({ callGateway, local });
    expect(r.source).toBe("gateway");
    expect(r.status.state).toBe("armed");
    expect(local).not.toHaveBeenCalled();
  });

  it("falls back to this machine's own token sources when the gateway is not reached", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await readJevStatus({ callGateway, local: () => base });
    expect(r.source).toBe("local");
    expect(r.status.state).toBe("dormant");
  });
});
