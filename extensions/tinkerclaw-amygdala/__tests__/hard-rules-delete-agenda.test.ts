import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AEGIS_RULES } from "../src/rules.js";

// 2026-11-04: a deletion no longer needs the owner's own "Delete …" sentence. It passes when it
// serves the task in his recent prompts and is held only when Jev reads it as unrelated (a side
// agenda). The memory databases stay held whatever the task, and a recursive delete of an
// absolute path outside /tmp keeps its own hard floor (FS_DESTRUCTIVE_ROOT, every agent).

// Built from parts so this file's own text does not trip the guard it tests.
const RM = ["r", "m"].join("");
const RMF = `${RM} -f`;
const RMRF = `${RM} -${"r"}f`;

const HOOK = join(__dirname, "..", "hooks", "hard-rules.mjs");
const dir = mkdtempSync(join(tmpdir(), "aegis-agenda-"));
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

// A transcript whose latest owner prompt asks for a build fix (invented wording).
const transcript = join(dir, "t.jsonl");
writeFileSync(
  transcript,
  JSON.stringify({
    type: "user",
    timestamp: new Date().toISOString(),
    message: { content: "Fix the app build, the stale bundle in the build folder breaks it." },
  }) + "\n",
);
const empty = join(dir, "empty.jsonl");
writeFileSync(empty, "");

// Stub Jev: low score when the command touches "photos", high otherwise.
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
        JSON.stringify({ answers: { serves_task: { noul: /photos/.test(cmd) ? 0.05 : 0.9 } } }),
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

const bundle = "/home/someone/src/app/build/stale-bundle.js";

describe("hard-rules hook: deletions held only for a side agenda", () => {
  it("a deletion that serves the task passes", async () => {
    expect(await decide(`${RMF} ${bundle}`)).toBe("allow");
  });

  it("a deletion unrelated to the task is held", async () => {
    expect(await decide(`${RMF} /home/someone/photos/2019/beach.jpg`)).toBe("deny");
  });

  it("no Jev answer does not hold a deletion", async () => {
    expect(await decide(`${RMF} ${bundle}`, { jev: "down" })).toBe("allow");
  });

  it("the memory databases and recursive deletes of absolute paths stay held", async () => {
    expect(await decide(`${RMF} /home/someone/.openclaw/memory/main.sqlite`)).toBe("deny");
    expect(await decide(`${RMRF} /home/someone`)).toBe("deny");
    expect(await decide(`${RMRF} /home/someone/src/app/build`)).toBe("deny");
  });

  it("with no prompt to compare against, the old hold stays", async () => {
    expect(await decide(`${RMF} ${bundle}`, { tr: empty })).toBe("deny");
  });
});
