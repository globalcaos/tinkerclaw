import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The prompt hook end to end: a Tinker chat gets the humor block; the reaction to the last line is kept. */
describe("before_prompt_build on a Tinker chat (J7 v4.9 §9.4)", () => {
  let home: string;

  // Tests run in worker threads, where setting process.env.HOME does not reach os.homedir(): mock it instead,
  // or the hook writes into the real ~/.openclaw state.
  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "limbic-home-"));
    vi.doMock("node:os", async (orig) => ({
      ...(await orig<typeof import("node:os")>()),
      homedir: () => home,
    }));
  });
  afterEach(() => {
    vi.doUnmock("node:os");
  });

  async function hook() {
    const on = vi.fn();
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { frequency: "low", sensitivityThreshold: 0.8 },
      on,
    };
    const mod = await import("../index.js");
    mod.default.register(api as any);
    return on.mock.calls.find((c: unknown[]) => c[0] === "before_prompt_build")![1] as (
      e: unknown,
      c: unknown,
    ) => Promise<{ prependSystemContext?: string } | undefined>;
  }

  const tab = { sessionKey: "agent:main:tinker:abc" };
  const reply = (text: string) => [
    { role: "user", content: "earlier ask" },
    { role: "assistant", content: [{ type: "text", text }] },
  ];

  it("records the last spoken line with his laugh and shows it next turn", async () => {
    const run = await hook();
    const first = await run({ prompt: "Fix the comma", messages: [] }, tab);
    expect(first?.prependSystemContext).toMatch(/a joke is welcome/);

    const second = await run(
      {
        prompt: "hahaha ok, next",
        messages: reply("**Jarvis:** *Four hours, one comma.*\n\nDone."),
      },
      tab,
    );
    expect(second?.prependSystemContext).toContain('"Four hours, one comma." → he laughed');

    const state = JSON.parse(
      readFileSync(join(home, ".openclaw/cognitive/computational-humor.json"), "utf8"),
    );
    expect(state.recentSpokenLines).toHaveLength(1);
    expect(state.recentSpokenLines[0].reaction).toBe("laughed");
  });

  it("says no joke when he is frustrated, and stays out of non-Tinker sessions", async () => {
    const run = await hook();
    const tense = await run({ prompt: "it's still not working!!", messages: [] }, tab);
    expect(tense?.prependSystemContext).toMatch(/NO JOKE/);
    expect(
      await run({ prompt: "hi", messages: [] }, { sessionKey: "agent:main:whatsapp:direct:x" }),
    ).toBeUndefined();
    expect(
      await run({ prompt: "hi", messages: [] }, { sessionKey: "agent:main:cron:job" }),
    ).toBeUndefined();
  });
});
