import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDigestHandler, DIGEST_PATH } from "../src/http.js";
import { createRunStates } from "../src/run-state.js";

// Design D3, the Claude Code lane: the route the PostToolUse hook posts to, the hook script itself, and the lookup
// that joins a bridge chat to its run.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "hooks", "post-tool-digest.mjs");

describe("the run state's session lookup", () => {
  it("returns the newest run of the session that has a base, and nothing for a session that has none", () => {
    const runs = createRunStates();
    runs.ensure("r1", "s1");
    runs.ensure("r2", "s1");
    runs.setBase("r1", { incumbentKey: "a" } as never, { sessionKey: "s1" });
    runs.ensure("r3", "s2");
    expect(runs.latestForSession("s1")?.runId).toBe("r1");
    runs.setBase("r2", { incumbentKey: "b" } as never, { sessionKey: "s1" });
    expect(runs.latestForSession("s1")?.runId).toBe("r2");
    expect(runs.latestForSession("s2")).toBeUndefined();
    expect(runs.latestForSession("nobody")).toBeUndefined();
  });
});

function req(
  o: { method?: string; url?: string; token?: string; body?: string } = {},
): IncomingMessage {
  const r = new EventEmitter() as unknown as IncomingMessage;
  r.method = o.method ?? "POST";
  r.url = o.url ?? DIGEST_PATH;
  r.headers = o.token === undefined ? {} : { authorization: `Bearer ${o.token}` };
  (r as unknown as { destroy: () => void }).destroy = () => {};
  queueMicrotask(() => {
    if (o.body !== undefined) r.emit("data", Buffer.from(o.body));
    r.emit("end");
  });
  return r;
}
function res() {
  const out = { status: 0, body: "" };
  const r = {
    writableEnded: false,
    destroyed: false,
    writeHead: (s: number) => void (out.status = s),
    end: (b: string) => {
      out.body = b;
      r.writableEnded = true;
    },
  };
  return { r: r as unknown as ServerResponse, out };
}
const TOKEN = "t".repeat(48);
const body = (o: object = {}) =>
  JSON.stringify({
    tc_session_key: "s1",
    tool_name: "Bash",
    tool_use_id: "tu1",
    text: "x".repeat(50),
    ...o,
  });

describe("the Claude Code digest route", () => {
  it("only answers its own path, only to POST, only with the token", async () => {
    const h = createDigestHandler({ digest: async () => "d" }, () => TOKEN);
    expect(await h(req({ url: "/other", token: TOKEN, body: body() }), res().r)).toBe(false);
    const get = res();
    expect(await h(req({ method: "GET", token: TOKEN }), get.r)).toBe(true);
    expect(get.out.status).toBe(405);
    const bad = res();
    expect(await h(req({ token: "wrong", body: body() }), bad.r)).toBe(true);
    expect(bad.out.status).toBe(401);
    const none = res();
    await h(req({ body: body() }), none.r);
    expect(none.out.status).toBe(401);
  });

  it("hands the runtime the session, tool and text, and returns the digest as {text}", async () => {
    const digest = vi.fn(async () => "a short digest");
    const h = createDigestHandler({ digest }, () => TOKEN);
    const { r, out } = res();
    await h(req({ token: TOKEN, body: body() }), r);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ text: "a short digest" });
    expect(digest).toHaveBeenCalledWith({
      sessionKey: "s1",
      toolName: "Bash",
      toolCallId: "tu1",
      text: "x".repeat(50),
    });
  });

  it("answers {} when there is nothing to replace, when the runtime throws, or when the body is incomplete", async () => {
    const answers = async (rt: { digest: () => Promise<string | undefined> }, b: string) => {
      const { r, out } = res();
      await createDigestHandler(rt, () => TOKEN)(req({ token: TOKEN, body: b }), r);
      return out;
    };
    expect(await answers({ digest: async () => undefined }, body())).toMatchObject({
      status: 200,
      body: "{}",
    });
    expect(
      await answers(
        {
          digest: async () => {
            throw new Error("boom");
          },
        },
        body(),
      ),
    ).toMatchObject({ status: 200, body: "{}" });
    expect(
      await answers({ digest: async () => "never" }, body({ tc_session_key: "" })),
    ).toMatchObject({ body: "{}" });
    expect(await answers({ digest: async () => "never" }, body({ text: "" }))).toMatchObject({
      body: "{}",
    });
    expect((await answers({ digest: async () => "never" }, "{not json")).status).toBe(400);
  });

  it("accepts a result far larger than the short-list route's prompt limit, and refuses one beyond its own", async () => {
    const digest = vi.fn(async () => "d");
    const h = createDigestHandler({ digest }, () => TOKEN, 300 * 1024);
    const big = res();
    await h(req({ token: TOKEN, body: body({ text: "y".repeat(200 * 1024) }) }), big.r);
    expect(JSON.parse(big.out.body)).toEqual({ text: "d" });
    const huge = res();
    await h(req({ token: TOKEN, body: body({ text: "y".repeat(400 * 1024) }) }), huge.r);
    expect(huge.out.status).toBe(413);
  });
});

describe("the Claude Code PostToolUse hook script", () => {
  let tmp = "";
  let server: Server;
  let port = 0;
  let reply: () => { status: number; body: string } = () => ({ status: 200, body: "{}" });
  const seen: string[] = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "thalamus-post-"));
    server = createServer((rq, rs) => {
      const chunks: Buffer[] = [];
      rq.on("data", (c: Buffer) => chunks.push(c));
      rq.on("end", () => {
        seen.push(Buffer.concat(chunks).toString());
        const r = reply();
        rs.writeHead(r.status, { "Content-Type": "application/json" });
        rs.end(r.body);
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as AddressInfo).port;
    mkdirSync(join(tmp, "ok"), { recursive: true });
    writeFileSync(join(tmp, "ok", "endpoint.json"), JSON.stringify({ port, token: "tok" }));
  });
  afterAll(async () => {
    await new Promise((ok) => server.close(ok));
    rmSync(tmp, { recursive: true, force: true });
  });

  const run = (stdin: string, env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [SCRIPT], {
        env: {
          ...process.env,
          THALAMUS_DATA_DIR: join(tmp, "ok"),
          TC_SESSION_KEY: "agent:main:tinker:abc",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out }));
      p.stdin.end(stdin);
    });

  const LONG = "z".repeat(9000);
  const hook = (toolResponse: unknown) =>
    JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "cc-1",
      tool_name: "Bash",
      tool_use_id: "tu7",
      tool_response: toolResponse,
    });

  it("replaces only the largest string of the tool's response and leaves the rest of its shape as it was", async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ text: "DIGEST" }) });
    seen.length = 0;
    const response = { stdout: LONG, stderr: "warn", interrupted: false, meta: { n: 1 } };
    const r = await run(hook(response));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: { stdout: "DIGEST", stderr: "warn", interrupted: false, meta: { n: 1 } },
      },
    });
    expect(JSON.parse(seen[0])).toEqual({
      tc_session_key: "agent:main:tinker:abc",
      session_id: "cc-1",
      tool_name: "Bash",
      tool_use_id: "tu7",
      text: LONG,
    });
  });

  it("handles a string response and a nested one (a file read)", async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ text: "DIGEST" }) });
    expect(JSON.parse((await run(hook(LONG))).out).hookSpecificOutput.updatedToolOutput).toBe(
      "DIGEST",
    );
    const nested = { type: "text", file: { filePath: "/a", content: LONG, numLines: 3 } };
    expect(JSON.parse((await run(hook(nested))).out).hookSpecificOutput.updatedToolOutput).toEqual({
      type: "text",
      file: { filePath: "/a", content: "DIGEST", numLines: 3 },
    });
  });

  it("makes no request for a short result, or with no session key, and prints nothing", async () => {
    seen.length = 0;
    expect(await run(hook({ stdout: "short" }))).toEqual({ code: 0, out: "" });
    expect(await run(hook({ stdout: LONG }), { TC_SESSION_KEY: "" })).toEqual({ code: 0, out: "" });
    expect(seen).toHaveLength(0);
  });

  it("fails open: an empty route, a refusal, junk, a missing endpoint and bad input all print nothing and exit 0", async () => {
    reply = () => ({ status: 200, body: "{}" });
    expect(await run(hook({ stdout: LONG }))).toEqual({ code: 0, out: "" });
    reply = () => ({ status: 401, body: JSON.stringify({ text: "must not print" }) });
    expect(await run(hook({ stdout: LONG }))).toEqual({ code: 0, out: "" });
    reply = () => ({ status: 200, body: JSON.stringify({ text: 42 }) });
    expect(await run(hook({ stdout: LONG }))).toEqual({ code: 0, out: "" });
    reply = () => ({ status: 200, body: "<html>" });
    expect(await run(hook({ stdout: LONG }))).toEqual({ code: 0, out: "" });
    expect(await run(hook({ stdout: LONG }), { THALAMUS_DATA_DIR: join(tmp, "missing") })).toEqual({
      code: 0,
      out: "",
    });
    expect(await run("not json")).toEqual({ code: 0, out: "" });
    expect(await run(JSON.stringify({ tool_name: "Bash" }))).toEqual({ code: 0, out: "" });
  });
});
