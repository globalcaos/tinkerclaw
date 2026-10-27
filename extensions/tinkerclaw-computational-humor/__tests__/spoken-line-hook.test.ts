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

  type Respond = (ok: boolean, payload?: unknown, err?: { message?: string }) => void;
  type Method = (o: { params: unknown; respond: Respond }) => Promise<void>;
  let methods: Map<string, Method>;

  async function hook() {
    const on = vi.fn();
    methods = new Map();
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      pluginConfig: { frequency: "low", sensitivityThreshold: 0.8 },
      on,
      registerGatewayMethod: (name: string, fn: Method) => methods.set(name, fn),
    };
    const mod = await import("../index.js");
    mod.default.register(api as any);
    return on.mock.calls.find((c: unknown[]) => c[0] === "before_prompt_build")![1] as (
      e: unknown,
      c: unknown,
    ) => Promise<{ prependContext?: string; prependSystemContext?: string } | undefined>;
  }

  async function tap(params: Record<string, unknown>) {
    let res: { ok: boolean; payload?: any; err?: { message?: string } } | undefined;
    await methods.get("limbic.reaction.set")!({
      params,
      respond: (ok, payload, err) => {
        res = { ok, payload, err };
      },
    });
    return res!;
  }

  const stored = () =>
    JSON.parse(readFileSync(join(home, ".openclaw/cognitive/computational-humor.json"), "utf8"))
      .recentSpokenLines as Array<Record<string, unknown>>;

  const tab = { sessionKey: "agent:main:tinker:abc" };
  const reply = (text: string) => [
    { role: "user", content: "earlier ask" },
    { role: "assistant", content: [{ type: "text", text }] },
  ];

  it("records the last spoken line with his laugh and shows it next turn", async () => {
    const run = await hook();
    const first = await run({ prompt: "Fix the comma", messages: [] }, tab);
    expect(first?.prependContext).toMatch(/a joke is welcome/);

    const second = await run(
      {
        prompt: "hahaha ok, next",
        messages: reply("**Jarvis:** *Four hours, one comma.*\n\nDone."),
      },
      tab,
    );
    expect(second?.prependContext).toContain('"Four hours, one comma." → he laughed');

    const state = JSON.parse(
      readFileSync(join(home, ".openclaw/cognitive/computational-humor.json"), "utf8"),
    );
    expect(state.recentSpokenLines).toHaveLength(1);
    expect(state.recentSpokenLines[0].reaction).toBe("laughed");
  });

  // 2026-10-09 (J7 §8): 13 of 23 joke follow-ups were not his. The next message after a line counts only when he wrote it.
  it("a line followed by an agent's turn is recorded unobserved; his stamped prompt with the doctrine welcomes a joke", async () => {
    const run = await hook();
    const wake = await run(
      {
        prompt:
          "[Fri 2026-10-09 13:10 GMT+2] ⟦AGENT:🌿 Fractal · prompt 174⟧ The turn above is finished.\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line. what should\nnever happen again — and it leaves **durable change on disk**, not commentary.",
        messages: reply("**Jarvis:** *Four hours, one comma.*\n\nDone."),
      },
      tab,
    );
    expect(wake?.prependContext).toContain('"Four hours, one comma." → unobserved');
    const own = await run(
      {
        prompt:
          "[Thu 2026-10-01 05:21 GMT+2] Keep improving Jev's prompts\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line. what should\nnever happen again — and it leaves **durable change on disk**, not commentary.",
        messages: [],
      },
      tab,
    );
    expect(own?.prependContext).toMatch(/a joke is welcome/);
    const state = JSON.parse(
      readFileSync(join(home, ".openclaw/cognitive/computational-humor.json"), "utf8"),
    );
    expect(state.recentSpokenLines[0].reaction).toBe("unobserved");
  });

  it("rides the turn as prependContext, never the system prompt, and skips a /compact turn (Phase 1.5)", async () => {
    const run = await hook();
    const turn = await run(
      { prompt: "[Sat 2026-10-10 11:31 GMT+2] Fix the comma", messages: [] },
      tab,
    );
    expect(turn?.prependContext).toMatch(/## Humor: the purple line only/);
    expect(turn?.prependSystemContext).toBeUndefined();
    expect(
      await run({ prompt: "[Sat 2026-10-10 11:32 GMT+2] /compact", messages: [] }, tab),
    ).toBeUndefined();
  });

  it("says no joke when he is frustrated, and stays out of non-Tinker sessions", async () => {
    const run = await hook();
    const tense = await run({ prompt: "it's still not working!!", messages: [] }, tab);
    expect(tense?.prependContext).toMatch(/NO JOKE/);
    expect(
      await run({ prompt: "hi", messages: [] }, { sessionKey: "agent:main:whatsapp:direct:x" }),
    ).toBeUndefined();
    expect(
      await run({ prompt: "hi", messages: [] }, { sessionKey: "agent:main:cron:job" }),
    ).toBeUndefined();
  });

  // 2026-10-10 (plan Phase 1.4): he never types a laugh (0 in ~620 follow-ups); the chip on the purple line is his label.
  it("a tap before the next turn creates the row; his next prompt does not overwrite it", async () => {
    const run = await hook();
    const r = await tap({ ...tab, line: "Four hours, one comma.", reaction: "not-now" });
    expect(r.ok).toBe(true);
    expect(r.payload.row).toMatchObject({
      reaction: "not-now",
      reactionSource: "tap",
      isJoke: true,
    });
    expect(stored()).toHaveLength(1);

    const next = await run(
      {
        prompt: "hahaha ok, next",
        messages: reply("**Jarvis:** *Four hours, one comma.*\n\nDone."),
      },
      tab,
    );
    expect(stored()).toHaveLength(1);
    expect(stored()[0].reaction).toBe("not-now");
    expect(next?.prependContext).toContain(
      '"Four hours, one comma." (a joke) → he tapped not now (wrong moment for a joke)',
    );
  });

  it("a tap after the turn recorded the line replaces the text reading; neutral leaves isJoke unjudged", async () => {
    const run = await hook();
    await run(
      { prompt: "ok", messages: reply("**Jarvis:** *Merged, three tests green.*\n\nDone.") },
      tab,
    );
    expect(stored()[0]).toMatchObject({ reaction: "no-reaction", reactionSource: "text" });
    const r = await tap({ ...tab, line: "Merged, three tests green.", reaction: "neutral" });
    expect(r.ok).toBe(true);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ reaction: "neutral", reactionSource: "tap" });
    expect(stored()[0].isJoke).toBeUndefined();
  });

  it("refuses a tap outside a Tinker chat, an empty line or an unknown reaction", async () => {
    await hook();
    const line = "Four hours, one comma.";
    expect(
      (await tap({ sessionKey: "agent:main:whatsapp:direct:x", line, reaction: "laughed" })).ok,
    ).toBe(false);
    expect((await tap({ ...tab, line: "  ", reaction: "laughed" })).ok).toBe(false);
    expect((await tap({ ...tab, line, reaction: "lol" })).ok).toBe(false);
  });
});
