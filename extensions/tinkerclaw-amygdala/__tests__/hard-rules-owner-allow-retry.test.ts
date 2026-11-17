import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AEGIS_RULES } from "../src/rules.js";

// 2026-11-13: a clean-up step was held by the judge layer's scope question. The owner pressed Allow
// ("allow JEV-…") three hours later, and the identical retry was refused again, by this hook, as a
// side agenda: the hook knew only its own AEGIS codes, so one step needed two Allows. His Allow press
// now releases, once, the identical retry of a step a guard hook refused since his message before it.

// Built from parts so this file's own text does not trip the guard it tests.
const RM = ["r", "m"].join("");
const RMF = `${RM} -f`;

const HOOK = join(__dirname, "..", "hooks", "hard-rules.mjs");
const dir = mkdtempSync(join(tmpdir(), "aegis-allow-retry-"));
const policy = join(dir, "policy.json");
writeFileSync(
  policy,
  JSON.stringify({
    rules: AEGIS_RULES.filter((r) =>
      ["DELETE_UNREQUESTED", "FS_DESTRUCTIVE_ROOT"].includes(r.rule),
    ).map((r) => ({
      id: r.rule,
      source: r.pattern.source,
      flags: "",
      explanation: r.explanation,
      enforce: true,
      scope: "exec",
      ...(r.ownerIntent ? { ownerIntent: r.ownerIntent } : {}),
    })),
  }),
);

// Stub Jev: every deletion reads as unrelated to the task, so only his Allow can let one through.
let server: Server;
let url = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answers: { serves_task: { noul: 0.05 } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/`;
});
afterAll(() => server.close());

function decide(command: string, tr: string) {
  return new Promise<"deny" | "allow">((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      {
        env: {
          ...process.env,
          AMYGDALA_POLICY_PATH: policy,
          AMYGDALA_DATA_DIR: dir,
          TYPESAFE_API_KEY: "test-key",
          AMYGDALA_JEV_URL: url,
        },
        timeout: 15_000,
      },
      (_e, stdout) => resolve(/"permissionDecision"\s*:\s*"deny"/.test(stdout) ? "deny" : "allow"),
    );
    child.stdin!.end(
      JSON.stringify({ tool_name: "Bash", tool_input: { command }, transcript_path: tr }),
    );
  });
}

type Row = Record<string, unknown>;
const MIN = 60_000;
const at = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
const owner = (words: string, agoMs: number): Row => ({
  type: "user",
  timestamp: at(agoMs),
  message: { content: words },
});
const tried = (id: string, command: string, agoMs: number): Row => ({
  type: "assistant",
  timestamp: at(agoMs),
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
const answered = (id: string, agoMs: number, refusal?: string): Row => ({
  type: "user",
  timestamp: at(agoMs),
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        is_error: refusal !== undefined,
        content: refusal ?? "done",
      },
    ],
  },
});
// What claude-cli writes back when the judge layer's question ran out of time (2026-11-13 12:35).
const HELD =
  "PreToolUse:Bash hook error: The user did not answer in time. Nothing was run; say so, and say the Allow under your reply still releases this step.";
const PRESS = "allow JEV-0B5O1V";
// The Tinker chat wraps his words; the hook reads what follows the last time stamp.
const fromTinker = (words: string) =>
  `Sender (untrusted metadata):\n{"label": "Tinker UI (webchat-ui)"}\n\n[Fri 2026-11-13 15:29 GMT+1] ${words}\n\n<!-- TINKERCLAW chat-row contract -->\nnarrate every tool call`;

let n = 0;
function transcript(rows: Row[]): string {
  const p = join(dir, `t${n++}.jsonl`);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
const cache = (name: string) => `${RMF} /home/someone/src/app/scripts/__pycache__/${name}.pyc`;
const task = owner("What would be the delivery date for the laptop?", 200 * MIN);

describe("hard-rules hook: his Allow press releases the retry of a held step", () => {
  it("the identical retry of the step a guard refused passes after his press", async () => {
    const cmd = cache("a");
    const tr = transcript([
      task,
      tried("u1", cmd, 190 * MIN),
      answered("u1", 185 * MIN, HELD),
      owner(fromTinker(PRESS), 4 * MIN),
    ]);
    expect(await decide(cmd, tr)).toBe("allow");
  });

  it("one press releases one retry", async () => {
    const cmd = cache("b");
    const tr = transcript([
      task,
      tried("u1", cmd, 190 * MIN),
      answered("u1", 185 * MIN, HELD),
      owner(PRESS, 4 * MIN),
    ]);
    expect(await decide(cmd, tr)).toBe("allow");
    expect(await decide(cmd, tr)).toBe("deny");
  });

  it("another deletion in the same turn is still judged", async () => {
    const tr = transcript([
      task,
      tried("u1", cache("c"), 190 * MIN),
      answered("u1", 185 * MIN, HELD),
      owner(PRESS, 4 * MIN),
    ]);
    expect(await decide(`${RMF} /home/someone/photos/2019/beach.jpg`, tr)).toBe("deny");
  });

  it("without his press the retry is still judged", async () => {
    const cmd = cache("d");
    const tr = transcript([
      task,
      tried("u1", cmd, 190 * MIN),
      answered("u1", 185 * MIN, HELD),
      owner("carry on with the laptop search", 4 * MIN),
    ]);
    expect(await decide(cmd, tr)).toBe("deny");
  });

  it("a press older than 30 minutes releases nothing", async () => {
    const cmd = cache("e");
    const tr = transcript([
      task,
      tried("u1", cmd, 190 * MIN),
      answered("u1", 185 * MIN, HELD),
      owner(PRESS, 40 * MIN),
    ]);
    expect(await decide(cmd, tr)).toBe("deny");
  });

  it("a step that ran was not held, so the press does not cover it", async () => {
    const cmd = cache("f");
    const tr = transcript([
      task,
      tried("u1", cmd, 190 * MIN),
      answered("u1", 185 * MIN),
      owner(PRESS, 4 * MIN),
    ]);
    expect(await decide(cmd, tr)).toBe("deny");
  });

  it("a step refused before his previous message is not released", async () => {
    const cmd = cache("g");
    const tr = transcript([
      task,
      tried("u1", cmd, 190 * MIN),
      answered("u1", 185 * MIN, HELD),
      owner("thanks, now check the other shop", 100 * MIN),
      owner(PRESS, 4 * MIN),
    ]);
    expect(await decide(cmd, tr)).toBe("deny");
  });

  it("the memory databases stay held", async () => {
    const cmd = `${RMF} /home/someone/.openclaw/memory/main.sqlite`;
    const tr = transcript([
      task,
      tried("u1", cmd, 190 * MIN),
      answered("u1", 185 * MIN, HELD),
      owner(PRESS, 4 * MIN),
    ]);
    expect(await decide(cmd, tr)).toBe("deny");
  });
});
