import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEffectPrompt, changingSteps, createEffects, parseEffects } from "../src/effects.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function book(answer: string | null, exitCode = 0) {
  const dataDir = mkdtempSync(join(tmpdir(), "amy-effects-"));
  dirs.push(dataDir);
  const events: [string, unknown][] = [];
  const prompts: string[] = [];
  const ran: string[] = [];
  const make = () =>
    createEffects({
      dataDir,
      run: async (prompt) => {
        prompts.push(prompt);
        return answer;
      },
      ladder: ["xai/test"],
      timeoutMs: 1000,
      homeDir: "/home/demo",
      emit: (n, p) => events.push([n, p]),
      now: () => 1,
      logger: { info: () => {}, warn: () => {} },
      exec: async (cmd) => {
        ran.push(cmd);
        return { code: exitCode, output: "done" };
      },
    });
  return { make, events, prompts, ran };
}

const turn = {
  sessionKey: "agent:main:tinker:t1",
  turnId: "t1#3",
  ts: 100,
  steps: [
    { ran: "Read /work/demo/a.md", failed: false },
    { ran: "Bash scp page.html web:/var/www/biz/public/", failed: false },
  ],
  reply: "The page is live on the public host.",
};

const ANSWER = JSON.stringify({
  effects: [
    {
      what: "Test page published",
      where: "biz.example.test",
      week: 3,
      lifetime: 40,
      revert: "ssh web rm /var/www/biz/public/page.html",
    },
  ],
});

describe("effects", () => {
  it("a turn of reads changes nothing: no model call, no card", async () => {
    const b = book(ANSWER);
    const out = await b.make().observe({ ...turn, steps: [turn.steps[0]] });
    expect(out).toEqual([]);
    expect(b.prompts).toHaveLength(0);
  });

  it("the prompt lists only the changing steps, redacts the home dir and carries the reply", () => {
    expect(changingSteps(turn.steps).map((s) => s.ran)).toEqual([turn.steps[1].ran]);
    const p = buildEffectPrompt(
      { ...turn, steps: [{ ran: "Bash cat /home/demo/.config/x", failed: false }] },
      "/home/demo",
    );
    expect(p).not.toContain("/home/demo");
    expect(p).toContain("The page is live on the public host.");
  });

  it("the prompt says a WhatsApp send can be undone and gives the delete recipe", () => {
    const p = buildEffectPrompt(turn, "/home/demo");
    expect(p).toContain("'message','delete','--channel','whatsapp'");
    expect(p).toContain("whatsapp-history.db");
  });

  it("a card's revert gets the real phone number back where the prompt hid it", async () => {
    const send = {
      ...turn,
      steps: [
        {
          ran: "Bash openclaw message send --channel whatsapp -t +34600111222 -m hi",
          failed: false,
        },
      ],
    };
    const answer = JSON.stringify({
      effects: [
        {
          what: "Sent a WhatsApp",
          where: "Phone 1",
          week: 1,
          lifetime: 1,
          revert: "undo -t Phone 1",
        },
      ],
    });
    const b = book(answer);
    const [e] = await b.make().observe(send);
    expect(b.prompts[0]).toContain("Phone 1");
    expect(b.prompts[0]).not.toContain("34600111222");
    expect(e.revert).toBe("undo -t +34600111222");
  });

  it("a change other people see becomes a stored card, emitted live and kept across a restart", async () => {
    const b = book(ANSWER);
    const [e] = await b.make().observe(turn);
    expect(e).toMatchObject({
      id: "eff-t1#3-0",
      sessionKey: turn.sessionKey,
      what: "Test page published",
      week: 3,
      lifetime: 40,
      state: "live",
    });
    expect(b.events.map(([n]) => n)).toEqual(["amygdala2.effect"]);
    expect(b.make().list(turn.sessionKey)).toHaveLength(1);
    expect(b.make().list("agent:main:tinker:other")).toHaveLength(0);
  });

  it("Revert runs the stored command once and records the outcome", async () => {
    const b = book(ANSWER);
    const fx = b.make();
    const [e] = await fx.observe(turn);
    const after = await fx.revert(e.id);
    expect(b.ran).toEqual(["ssh web rm /var/www/biz/public/page.html"]);
    expect(after.state).toBe("reverted");
    expect((await fx.revert(e.id)).state).toBe("reverted");
    expect(b.ran).toHaveLength(1);
    expect(b.make().list()[0].state).toBe("reverted");
  });

  it("a failing revert is marked failed, and a change with no undo refuses", async () => {
    const failing = book(ANSWER, 1);
    const fx = failing.make();
    const [e] = await fx.observe(turn);
    expect((await fx.revert(e.id)).state).toBe("revert-failed");
    const sent = book(
      JSON.stringify({
        effects: [{ what: "Mail sent", where: "x@example.test", week: 1, revert: null }],
      }),
    );
    const sx = sent.make();
    const [m] = await sx.observe(turn);
    expect(m.lifetime).toBe(1);
    await expect(sx.revert(m.id)).rejects.toThrow("cannot be undone");
  });

  it("parse drops what it cannot read and never throws", () => {
    expect(parseEffects(null)).toEqual([]);
    expect(parseEffects("no json here")).toEqual([]);
    expect(parseEffects('{"effects":[{"where":"x"}]}')).toEqual([]);
    expect(parseEffects('Sure: {"effects":[]}')).toEqual([]);
    expect(parseEffects('{"effects":[{"what":"a","week":"7","lifetime":2}]}')).toEqual([
      { what: "a", where: "", week: 7, lifetime: 7, revert: null },
    ]);
  });
});
