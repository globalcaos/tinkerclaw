// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createJevChip, parseJevStatus, renderJevChip } from "./jev-chip.js";

const base = {
  state: "dormant",
  on: false,
  keySource: null,
  reason: "no-token",
  since: 1,
  lastProbe: null,
  breakerOpen: false,
  enables: ["safety checks", "routing reads", "recipe ranking"],
  tokenFile: "/home/u/.openclaw/jev/token",
  line: "Jev: off — no token (enables: safety checks, routing reads, recipe ranking)",
};

describe("jev chip: parsing", () => {
  it("accepts a status and nothing else", () => {
    expect(parseJevStatus(base)?.state).toBe("dormant");
    expect(parseJevStatus(null)).toBeNull();
    expect(parseJevStatus({ state: "weird", line: "x" })).toBeNull();
    expect(parseJevStatus({ state: "armed" })).toBeNull(); // no line to show
  });
});

describe("jev chip: what is drawn", () => {
  it("draws nothing before the gateway has answered (an older gateway has no such method)", () => {
    expect(renderJevChip(null)).toBe("");
  });

  it("dormant: 'Jev: off — no token', the whole line and where the token goes in the hint", () => {
    const html = renderJevChip(parseJevStatus(base));
    expect(html).toContain("jev-chip--off");
    expect(html).toContain("Jev: off — no token");
    expect(html).toContain("enables: safety checks, routing reads, recipe ranking");
    expect(html).toContain("/home/u/.openclaw/jev/token");
  });

  it("armed: 'Jev: on'", () => {
    const html = renderJevChip(
      parseJevStatus({ ...base, state: "armed", on: true, line: "Jev: on" }),
    );
    expect(html).toContain("jev-chip--on");
    expect(html).toMatch(/>Jev: on</);
  });

  it("unverified, refused and paused each read differently", () => {
    const u = renderJevChip(
      parseJevStatus({
        ...base,
        state: "unverified",
        on: true,
        line: "Jev: on — token not checked yet",
      }),
    );
    expect(u).toContain("jev-chip--checking");
    const r = renderJevChip(
      parseJevStatus({
        ...base,
        state: "rejected",
        on: false,
        line: "Jev: off — the token was rejected by Jev",
      }),
    );
    expect(r).toContain("jev-chip--refused");
    expect(r).toContain("Jev: off — token refused");
    const p = renderJevChip(
      parseJevStatus({
        ...base,
        state: "armed",
        on: true,
        breakerOpen: true,
        line: "Jev: on — paused for a moment after errors",
      }),
    );
    expect(p).toContain("jev-chip--checking");
    expect(p).toContain("Jev: on — paused");
  });

  it("escapes what the gateway sends", () => {
    const html = renderJevChip(
      parseJevStatus({ ...base, tokenFile: "<img src=x onerror=1>", line: "Jev: off <b>x</b>" }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
  });

  it("never draws a token, even if one were sent", () => {
    const html = renderJevChip(
      parseJevStatus({ ...base, token: "tok-secret", apiKey: "tok-secret" } as never),
    );
    expect(html).not.toContain("tok-secret");
  });
});

describe("jev chip: the live state", () => {
  it("asks on connect and repaints; an unknown method leaves it empty", async () => {
    const repaint = vi.fn();
    const chip = createJevChip({ req: async () => base, repaint });
    expect(chip.html()).toBe("");
    await chip.onConnected();
    expect(chip.html()).toContain("Jev: off");
    expect(repaint).toHaveBeenCalled();

    const old = createJevChip({
      req: async () => {
        throw new Error("unknown method: jev.status");
      },
      repaint: vi.fn(),
    });
    await old.onConnected();
    expect(old.html()).toBe("");
  });

  it("follows jev.status events, and ignores anything malformed", async () => {
    const repaint = vi.fn();
    const chip = createJevChip({ req: async () => base, repaint });
    await chip.onConnected();
    chip.onEvent({ ...base, state: "armed", on: true, line: "Jev: on" });
    expect(chip.html()).toContain("Jev: on");
    chip.onEvent({ nonsense: true });
    expect(chip.html()).toContain("Jev: on");
  });
});
