import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "prompt-shortlist.mjs");
let tmp = "";
let server: Server;
let port = 0;
let reply: (req: {
  auth?: string;
  body: string;
}) => Promise<{ status: number; body: string }> = async () => ({ status: 200, body: "{}" });
const seen: Array<{ auth?: string; body: string }> = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "thalamus-hook-"));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const call = { auth: req.headers.authorization, body: Buffer.concat(chunks).toString() };
      seen.push(call);
      const r = await reply(call);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  rmSync(tmp, { recursive: true, force: true });
});

function endpoint(dir: string, o: object) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "endpoint.json"), JSON.stringify(o));
}

function run(
  stdin: string,
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
    p.stdin.end(stdin);
  });
}

const hookJson = JSON.stringify({
  prompt: "compare my translation",
  session_id: "sess-1",
  cwd: "/w",
});

describe("the Claude Code hook script", () => {
  it("prints nothing when the route answers empty (shadow): the prompt goes through untouched", async () => {
    const dir = join(tmp, "a");
    endpoint(dir, { port, token: "tok" });
    reply = async () => ({ status: 200, body: "{}" });
    const r = await run(hookJson, { THALAMUS_DATA_DIR: dir });
    expect(r).toEqual({ code: 0, out: "" });
  });

  it("prints the UserPromptSubmit output, and only that, when the route returns a note (enforce)", async () => {
    const dir = join(tmp, "b");
    endpoint(dir, { port, token: "tok" });
    reply = async () => ({ status: 200, body: JSON.stringify({ additionalContext: "the list" }) });
    const r = await run(hookJson, { THALAMUS_DATA_DIR: dir });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "the list" },
    });
  });

  it("sends the token from endpoint.json and the prompt and session from the hook", async () => {
    const dir = join(tmp, "c");
    endpoint(dir, { port, token: "secret-token" });
    seen.length = 0;
    await run(hookJson, { THALAMUS_DATA_DIR: dir });
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe("Bearer secret-token");
    expect(JSON.parse(seen[0].body)).toEqual({
      prompt: "compare my translation",
      session_id: "sess-1",
    });
  });

  it("fails open: nothing printed, exit 0, whatever goes wrong", async () => {
    const none = await run(hookJson, { THALAMUS_DATA_DIR: join(tmp, "missing") });
    expect(none).toEqual({ code: 0, out: "" });

    const badPort = join(tmp, "d");
    endpoint(badPort, { port: 1, token: "t" });
    expect(await run(hookJson, { THALAMUS_DATA_DIR: badPort })).toEqual({ code: 0, out: "" });

    const badFile = join(tmp, "e");
    mkdirSync(badFile, { recursive: true });
    writeFileSync(join(badFile, "endpoint.json"), "{not json");
    expect(await run(hookJson, { THALAMUS_DATA_DIR: badFile })).toEqual({ code: 0, out: "" });

    expect(await run("not json at all", { THALAMUS_DATA_DIR: badPort })).toEqual({
      code: 0,
      out: "",
    });
    expect(await run(JSON.stringify({ prompt: "" }), { THALAMUS_DATA_DIR: badPort })).toEqual({
      code: 0,
      out: "",
    });
  });

  it("prints nothing when the route refuses or answers with something else", async () => {
    const dir = join(tmp, "f");
    endpoint(dir, { port, token: "t" });
    reply = async () => ({
      status: 401,
      body: JSON.stringify({ additionalContext: "must not print" }),
    });
    expect(await run(hookJson, { THALAMUS_DATA_DIR: dir })).toEqual({ code: 0, out: "" });
    reply = async () => ({ status: 200, body: JSON.stringify({ additionalContext: 42 }) });
    expect(await run(hookJson, { THALAMUS_DATA_DIR: dir })).toEqual({ code: 0, out: "" });
    reply = async () => ({ status: 200, body: "<html>" });
    expect(await run(hookJson, { THALAMUS_DATA_DIR: dir })).toEqual({ code: 0, out: "" });
  });

  it("gives up on a slow route within its timeout instead of holding the prompt", async () => {
    const dir = join(tmp, "g");
    endpoint(dir, { port, token: "t" });
    reply = () =>
      new Promise((ok) =>
        setTimeout(
          () => ok({ status: 200, body: JSON.stringify({ additionalContext: "late" }) }),
          2000,
        ),
      );
    const t0 = Date.now();
    const r = await run(hookJson, { THALAMUS_DATA_DIR: dir, THALAMUS_HOOK_TIMEOUT_MS: "200" });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r).toEqual({ code: 0, out: "" });
  });
});
