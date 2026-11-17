import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AEGIS_RULES } from "../src/rules.js";

// 2026-11-05: a stored secret no longer needs the owner to name it. It passes when Jev reads it as
// the credential for the service his recent prompts asked us to act on. Unlike deletion it fails
// closed: no Jev answer or no prompt keeps the hold.

// Built from parts so this file's own text does not trip the guard it tests.
const ENV = ["~/.openclaw/", ".env"].join("");

const HOOK = join(__dirname, "..", "hooks", "hard-rules.mjs");
const dir = mkdtempSync(join(tmpdir(), "aegis-secret-task-"));
const policy = join(dir, "policy.json");
writeFileSync(
  policy,
  JSON.stringify({
    rules: AEGIS_RULES.filter((r) => ["SECRET_UNREQUESTED"].includes(r.rule)).map((r) => ({
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

// A transcript whose latest owner prompt asks for a build fix (invented wording).
const transcript = join(dir, "t.jsonl");
writeFileSync(
  transcript,
  JSON.stringify({
    type: "user",
    timestamp: new Date().toISOString(),
    message: { content: "If you can edit my reply on the chat app, do it." },
  }) + "\n",
);
const empty = join(dir, "empty.jsonl");
writeFileSync(empty, "");

// Stub Jev: low score when the command reaches the bank, high otherwise.
let server: Server;
let url = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const cmd = JSON.parse(body).state.command as string;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ answers: { serves_task: { noul: /bank/.test(cmd) ? 0.05 : 0.9 } } }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/`;
});
afterAll(() => server.close());

function decide(command: string, opts: { jev?: "up" | "down"; tr?: string } = {}) {
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
          AMYGDALA_JEV_URL: opts.jev === "down" ? "http://127.0.0.1:9/" : url,
        },
        timeout: 15_000,
      },
      (_e, stdout) => resolve(/"permissionDecision"\s*:\s*"deny"/.test(stdout) ? "deny" : "allow"),
    );
    child.stdin!.end(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command },
        transcript_path: opts.tr ?? transcript,
      }),
    );
  });
}

const edit = `python3 -c "open('${ENV}').read()" # chat.update on the chat app`;

describe("hard-rules hook: a secret that serves the task passes", () => {
  it("the key for the service the owner asked about passes", async () => {
    expect(await decide(edit)).toBe("allow");
  });

  it("a key used for something else is held", async () => {
    expect(await decide(`python3 -c "open('${ENV}').read()" # bank transfer`)).toBe("deny");
  });

  it("no Jev answer keeps the hold", async () => {
    expect(await decide(edit, { jev: "down" })).toBe("deny");
  });

  it("with no prompt to compare against, the hold stays", async () => {
    expect(await decide(edit, { tr: empty })).toBe("deny");
  });
});
