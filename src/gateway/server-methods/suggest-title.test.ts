/**
 * Fork-owned RPC (bible unit-tests.md: `src/gateway/server-methods/*` fork-added RPCs).
 *
 * The failure this guards (2026-09-12): the title suggester ran ONE hardcoded
 * supply. xAI's weekly allowance hit 100%, every run threw
 * `FailoverError: 403 "You have run out of credits"`, and tab auto-rename
 * silently stopped for the rest of the week. The wrapper under test is the REAL
 * `runWithModelFallback`; only the model runner and the agent-scope resolvers
 * are mocked, so a green run proves the ladder actually advances.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-agent"),
  resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent/.openclaw-agent"),
}));

vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
}));

import { TITLE_SUGGEST_LADDER, extractTitleText, suggestTitleViaBridge } from "./suggest-title.js";

const cfg = {} as OpenClawConfig;

/** Verbatim shape of the live failure (gateway journal 2026-09-12 16:11:26). */
const outOfCredits = () =>
  new FailoverError(
    '403 "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok."',
    { reason: "auth", provider: "xai", model: "grok-4.6", status: 403 },
  );

const callArg = (i: number) =>
  runEmbeddedPiAgentMock.mock.calls[i]?.[0] as Record<string, unknown> | undefined;

describe("suggestTitleViaBridge — the recovery ladder", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
  });

  it("serves the primary rung's title and never touches the fallback", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [{ text: " 🔧 Fix auth bug \n" }] });

    const title = await suggestTitleViaBridge({ prompt: "rename me", cfg });

    expect(title).toBe("🔧 Fix auth bug");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(callArg(0)).toEqual(
      expect.objectContaining({
        provider: "xai",
        model: "grok-4.6",
        disableTools: true,
        modelRun: true,
        promptMode: "none",
        prompt: "rename me",
      }),
    );
  });

  it("moves to the next supply when the primary is out of credits (the 2026-09-12 failure)", async () => {
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(outOfCredits())
      .mockResolvedValueOnce({ payloads: [{ text: "Fix auth bug" }] });

    const title = await suggestTitleViaBridge({ prompt: "rename me", cfg });

    expect(title).toBe("Fix auth bug");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(callArg(1)).toEqual(
      expect.objectContaining({ provider: "claude-code", model: "claude-haiku-4-5" }),
    );
  });

  it("gives every rung a FRESH transcript so a failed rung's error turn is not the next rung's history", async () => {
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(outOfCredits())
      .mockResolvedValueOnce({ payloads: [{ text: "Fix auth bug" }] });

    await suggestTitleViaBridge({ prompt: "rename me", cfg });

    const files = [callArg(0)?.sessionFile, callArg(1)?.sessionFile];
    expect(files.every((f) => typeof f === "string" && f.length > 0)).toBe(true);
    expect(new Set(files).size).toBe(2);
  });

  it("treats a rung that returns only an error payload as a miss, not a title", async () => {
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({ payloads: [{ text: "upstream 500", isError: true }] })
      .mockResolvedValueOnce({ payloads: [{ text: "Fix auth bug" }] });

    expect(await suggestTitleViaBridge({ prompt: "rename me", cfg })).toBe("Fix auth bug");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
  });

  it("returns null — never throws — when every rung fails", async () => {
    runEmbeddedPiAgentMock.mockRejectedValue(outOfCredits());

    expect(await suggestTitleViaBridge({ prompt: "rename me", cfg })).toBeNull();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(TITLE_SUGGEST_LADDER.length);
  });

  it("honours a caller-supplied ladder", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [{ text: "Titled" }] });

    await suggestTitleViaBridge({ prompt: "rename me", cfg, ladder: ["ollama/gemma4:26b"] });

    expect(callArg(0)).toEqual(
      expect.objectContaining({ provider: "ollama", model: "gemma4:26b" }),
    );
  });
});

describe("TITLE_SUGGEST_LADDER — shape invariants", () => {
  it("has at least two rungs — one exhausted supply must never end the rename", () => {
    expect(TITLE_SUGGEST_LADDER.length).toBeGreaterThanOrEqual(2);
  });

  it("puts every rung on a DIFFERENT provider — rungs sharing a billing pool fail together", () => {
    const providers = TITLE_SUGGEST_LADDER.map((k) => k.split("/")[0]);
    expect(new Set(providers).size).toBe(TITLE_SUGGEST_LADDER.length);
  });

  it("uses provider/model keys only", () => {
    for (const key of TITLE_SUGGEST_LADDER) {
      expect(key).toMatch(/^[a-z0-9-]+\/[^/\s]+$/);
    }
  });
});

describe("extractTitleText", () => {
  it("skips error and reasoning payloads and trims the first real text", () => {
    expect(
      extractTitleText({
        payloads: [
          { text: "thinking…", isReasoning: true },
          { text: "boom", isError: true },
          { text: "  Real title  " },
        ],
      }),
    ).toBe("Real title");
  });

  it("returns null for an empty, malformed, or error-only result", () => {
    expect(extractTitleText(undefined)).toBeNull();
    expect(extractTitleText({})).toBeNull();
    expect(extractTitleText({ payloads: [] })).toBeNull();
    expect(extractTitleText({ payloads: [{ text: "boom", isError: true }] })).toBeNull();
    expect(extractTitleText({ payloads: [{ text: "   " }] })).toBeNull();
  });
});
