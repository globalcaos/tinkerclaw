import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AEGIS_RULES } from "../src/rules.js";

// 2026-11-14: the owner typed `allow AEGIS-…` while the agent's turn was still running, and the identical retry was
// refused again. Claude Code does not write a message sent mid-turn as a `user` row: it absorbs it into the running
// turn as `{type:"attachment", attachment:{type:"queued_command", commandMode:"prompt", prompt}}`, and the hook's
// readers skipped every row that was not `user`. They now read that row too (hooks/hard-rules.mjs typedText), with
// the same owner test; job and task notifications (another commandMode) and agent-sent prompts stay out.

// Built from parts so this file's own text does not trip the guard it tests.
const RM = ["r", "m"].join("");
const RMF = `${RM} -f`;

const HOOK = join(__dirname, "..", "hooks", "hard-rules.mjs");
const dir = mkdtempSync(join(tmpdir(), "aegis-midturn-allow-"));
const policy = join(dir, "policy.json");
writeFileSync(
  policy,
  JSON.stringify({
    rules: AEGIS_RULES.filter((r) =>
      ["DELETE_UNREQUESTED", "FS_DESTRUCTIVE_ROOT"].includes(r.rule),
    ).map((r) => {
      const rule: Record<string, unknown> = {
        id: r.rule,
        source: r.pattern.source,
        flags: "",
        explanation: r.explanation,
        enforce: true,
        scope: "exec",
      };
      if (r.ownerIntent) {
        rule.ownerIntent = r.ownerIntent;
      }
      return rule;
    }),
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

function run(command: string, tr: string) {
  return new Promise<string>((resolve) => {
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
      (_e, stdout) => resolve(String(stdout)),
    );
    child.stdin!.end(
      JSON.stringify({ tool_name: "Bash", tool_input: { command }, transcript_path: tr }),
    );
  });
}
const denied = (stdout: string) => /"permissionDecision"\s*:\s*"deny"/.test(stdout);
const decide = async (command: string, tr: string) =>
  denied(await run(command, tr)) ? "deny" : "allow";

type Row = Record<string, unknown>;
const MIN = 60_000;
const at = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
// The Tinker chat wraps his words; the hook reads what follows the last time stamp.
const envelope = (label: string, words: string) =>
  `Sender (untrusted metadata):\n\`\`\`json\n{\n  "label": "${label}",\n  "id": "x"\n}\n\`\`\`\n\n[Sat 2026-11-14 21:34 GMT+1] ${words}`;
const typed = (words: string, agoMs: number): Row => ({
  type: "user",
  timestamp: at(agoMs),
  message: { content: envelope("Tinker UI (webchat-ui)", words) },
});
// What Claude Code writes for a message that arrives while the turn runs (seen 2026-11-14 21:34).
const queued = (
  words: string,
  agoMs: number,
  opts: { mode?: string; label?: string } = {},
): Row => ({
  type: "attachment",
  timestamp: at(agoMs),
  attachment: {
    type: "queued_command",
    prompt: envelope(opts.label ?? "Tinker UI (webchat-ui)", words),
    commandMode: opts.mode ?? "prompt",
    timestamp: at(agoMs),
  },
});
const tried = (id: string, command: string, agoMs: number): Row => ({
  type: "assistant",
  timestamp: at(agoMs),
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
const refused = (id: string, agoMs: number, said: string): Row => ({
  type: "user",
  timestamp: at(agoMs),
  message: {
    content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: said }],
  },
});

let n = 0;
function transcript(rows: Row[]): string {
  const p = join(dir, `t${n++}.jsonl`);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
const leftovers = (name: string) => `${RMF} /home/someone/.cache/app/leftover-${name}.jsonl`;
const task = typed("Make the job's row open the work behind it", 60 * MIN);

/** The code the guard's refusal names for this command (what the Allow under the reply sends). */
async function codeFor(command: string): Promise<string> {
  const out = await run(command, transcript([task]));
  const m = /allow (AEGIS-[0-9A-Z]{6})/.exec(out);
  if (!m) {
    throw new Error(`no AEGIS code in the refusal: ${out.slice(0, 300)}`);
  }
  return m[1];
}

describe("hard-rules hook: an Allow he sends while the turn runs counts", () => {
  it("a queued `allow AEGIS-…` lets the identical command pass, once", async () => {
    const cmd = leftovers("a");
    const code = await codeFor(cmd);
    const tr = transcript([
      task,
      tried("u1", cmd, 5 * MIN),
      refused("u1", 5 * MIN, "PreToolUse:Bash hook error: AMYGDALA hard rule (AEGIS)"),
      queued(`allow ${code}`, 2 * MIN),
    ]);
    expect(await decide(cmd, tr)).toBe("allow");
    expect(await decide(cmd, tr)).toBe("deny"); // the grant is spent
  });

  it("the same words in a task notification release nothing", async () => {
    const cmd = leftovers("b");
    const code = await codeFor(cmd);
    const tr = transcript([task, queued(`allow ${code}`, 2 * MIN, { mode: "task-notification" })]);
    expect(await decide(cmd, tr)).toBe("deny");
  });

  it("a queued prompt from an agent's sender releases nothing", async () => {
    const cmd = leftovers("c");
    const code = await codeFor(cmd);
    const tr = transcript([task, queued(`allow ${code}`, 2 * MIN, { label: "cli" })]);
    expect(await decide(cmd, tr)).toBe("deny");
  });

  it("a queued Allow older than 30 minutes releases nothing", async () => {
    const cmd = leftovers("d");
    const code = await codeFor(cmd);
    const tr = transcript([task, queued(`allow ${code}`, 40 * MIN)]);
    expect(await decide(cmd, tr)).toBe("deny");
  });

  it("his Allow press for a held step (`allow JEV-…`) sent mid-turn releases its retry", async () => {
    const cmd = leftovers("e");
    const tr = transcript([
      task,
      tried("u1", cmd, 5 * MIN),
      refused(
        "u1",
        5 * MIN,
        "PreToolUse:Bash hook error: The user did not answer in time. Nothing was run.",
      ),
      queued("allow JEV-0B5O1V", 2 * MIN),
    ]);
    expect(await decide(cmd, tr)).toBe("allow");
  });
});
