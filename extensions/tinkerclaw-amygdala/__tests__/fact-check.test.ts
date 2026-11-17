import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeOnly,
  createFactCheck,
  FACT_CHECK_MARKER,
  FACT_CHECK_OPENING,
  type FactCheckMode,
} from "../src/fact-check.js";
import { renderTemplate } from "../src/templates.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o);
/** A transcript whose last turn: the owner asks, one grep finds nothing, the reply states an absence. */
function transcript(prompt = "[Sat 2026-11-14 00:14 GMT+1] fix it"): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "amy-fact-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  writeFileSync(
    path,
    [
      line({ type: "user", message: { content: prompt } }),
      line({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu1",
              name: "Bash",
              input: { command: "grep '^Host .*laptop' ~/.ssh/config" },
            },
          ],
        },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "" }] },
      }),
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "The Pi has no ssh key on the laptop." }] },
      }),
    ].join("\n") + "\n",
  );
  return { path, dir };
}

function harness(
  answer: string | null,
  mode: FactCheckMode = "wake",
  ladder = ["claude-code/claude-sonnet-5-5"],
) {
  const sent: [string, string][] = [];
  const logs: string[] = [];
  const prompts: string[] = [];
  const rungs: string[] = [];
  const { path, dir } = transcript();
  const fc = createFactCheck({
    mode,
    ladder,
    timeoutMs: 1000,
    dailyCap: 2,
    runOnce: async (prompt, rung) => {
      prompts.push(prompt);
      rungs.push(rung);
      return answer;
    },
    deliver: (k, m) => sent.push([k, m]),
    log: (l) => logs.push(l),
    homeDir: "/home/demo",
    recordPath: join(dir, "fact-checks.jsonl"),
    now: () => Date.parse("2026-11-14T10:00:00Z"),
  });
  const turn = {
    sessionKey: "agent:main:tinker:t1",
    turnId: "t1#1",
    reply: "The Pi has no ssh key on the laptop.",
    transcriptPath: path,
  };
  return { fc, sent, logs, prompts, rungs, turn, dir };
}

describe("fact check — a statement the evidence does not carry wakes the chat once", () => {
  it("contradicted: one wake in the same chat, worded by code, with the sentence and why", async () => {
    const h = harness('[{"n":1,"label":"contradicted"}]');
    h.fc.observe(h.turn);
    await h.fc.idle();
    expect(h.sent).toHaveLength(1);
    const [key, msg] = h.sent[0] as [string, string];
    expect(key).toBe("agent:main:tinker:t1");
    expect(msg.startsWith(FACT_CHECK_MARKER)).toBe(true);
    expect(msg).toContain(
      '"The Pi has no ssh key on the laptop." (the evidence shows the opposite)',
    );
    expect(msg).toContain("say it as a hypothesis");
    expect(h.prompts[0]).toContain(
      "[call 1] Bash: grep '^Host .*laptop' ~/.ssh/config (no output)",
    );
    expect(h.logs.join("\n")).toMatch(
      /fact-check session=agent:main:tinker:t1 turn=t1#1 candidates=1 .*acted=1 mode=wake/,
    );
  });

  it("shown: no wake, and the record keeps the statement with its label", async () => {
    const h = harness('[{"n":1,"label":"shown"}]');
    h.fc.observe(h.turn);
    await h.fc.idle();
    expect(h.sent).toEqual([]);
    const row = JSON.parse(readFileSync(join(h.dir, "fact-checks.jsonl"), "utf8").trim());
    expect(row.statements).toEqual([
      { text: "The Pi has no ssh key on the laptop.", kind: "absence", label: "shown" },
    ]);
  });

  it("shadow: judged and recorded, never sent", async () => {
    const h = harness('[{"n":1,"label":"beyond"}]', "shadow");
    h.fc.observe(h.turn);
    await h.fc.idle();
    expect(h.sent).toEqual([]);
    expect(h.logs.join("\n")).toContain("acted=1 mode=shadow");
  });

  it("no wake once a newer turn has started in the chat", async () => {
    const h = harness('[{"n":1,"label":"contradicted"}]');
    h.fc.observe({ ...h.turn, stillCurrent: () => false });
    await h.fc.idle();
    expect(h.sent).toEqual([]);
    expect(h.logs.join("\n")).toContain("superseded: a newer turn started, no wake");
  });

  it("an unreadable answer acts on nothing", async () => {
    const h = harness("I cannot tell.");
    h.fc.observe(h.turn);
    await h.fc.idle();
    expect(h.sent).toEqual([]);
    expect(h.logs.join("\n")).toContain("error=");
  });
});

describe("fact check — limits", () => {
  it("never checks the turn its own wake started", async () => {
    expect(renderTemplate("fact-check-wake", { what: "x" }).startsWith(FACT_CHECK_OPENING)).toBe(
      true,
    );
    const h = harness('[{"n":1,"label":"contradicted"}]');
    const { path } = transcript(`${FACT_CHECK_MARKER} Your last reply stated as fact …`);
    h.fc.observe({ ...h.turn, transcriptPath: path });
    await h.fc.idle();
    expect(h.prompts).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("asks Claude rungs only: tool output never goes to another provider", async () => {
    expect(claudeOnly(["xai/grok-4.6", "claude-code/claude-haiku-4-5"])).toEqual([
      "claude-code/claude-haiku-4-5",
    ]);
    const h = harness('[{"n":1,"label":"shown"}]', "wake", [
      "xai/grok-4.6",
      "claude-code/claude-haiku-4-5",
    ]);
    h.fc.observe(h.turn);
    await h.fc.idle();
    expect(h.rungs).toEqual(["claude-code/claude-haiku-4-5"]);
    const none = harness('[{"n":1,"label":"contradicted"}]', "wake", ["xai/grok-4.6"]);
    none.fc.observe(none.turn);
    await none.fc.idle();
    expect(none.prompts).toEqual([]);
  });

  it("checks a turn once, a reply with no candidate never, and stops at the daily cap", async () => {
    const h = harness('[{"n":1,"label":"shown"}]');
    h.fc.observe(h.turn);
    h.fc.observe(h.turn);
    h.fc.observe({ ...h.turn, turnId: "t1#2", reply: "Done: merged and live." });
    h.fc.observe({ ...h.turn, turnId: "t1#3" });
    h.fc.observe({ ...h.turn, turnId: "t1#4" });
    await h.fc.idle();
    expect(h.prompts).toHaveLength(2);
  });
});
