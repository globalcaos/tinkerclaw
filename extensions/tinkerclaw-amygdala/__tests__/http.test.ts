import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import type { Family } from "../src/families/types.js";
import { createHttpHandlers, type HttpRuntime } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const EXT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "a".repeat(64);

const servers: http.Server[] = [];
const runtimes: Runtime[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const r of runtimes.splice(0)) r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function serve(runtime: HttpRuntime): Promise<number> {
  const h = createHttpHandlers(runtime, () => TOKEN);
  const server = http.createServer((req, res) => {
    if (req.url === "/plugins/amygdala2/decide") void h.decide(req, res);
    else if (req.url === "/plugins/amygdala2/wait") void h.wait(req, res);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as AddressInfo).port;
}

function call(
  port: number,
  o: { path?: string; method?: string; token?: string | null; body?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only JSON probing
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (o.token !== null) headers.Authorization = `Bearer ${o.token ?? TOKEN}`;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: o.path ?? "/plugins/amygdala2/decide",
        method: o.method ?? "POST",
        headers,
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

const DECIDE_BODY = JSON.stringify({ seam: "prompt", hook: { session_id: "s", prompt: "hi" } });

function stub(): HttpRuntime & { decides: number } {
  const s = {
    decides: 0,
    async decide() {
      s.decides += 1;
      return { decisionId: "d1", hook: { kind: "none" as const } };
    },
    async waitFor() {
      return { answer: "allow-once" };
    },
  };
  return s;
}

describe("decide route: auth and framing", () => {
  it("401 without a token, with a wrong token, and with a wrong token of another length", async () => {
    const rt = stub();
    const port = await serve(rt);
    expect((await call(port, { token: null, body: DECIDE_BODY })).status).toBe(401);
    expect((await call(port, { token: "b".repeat(64), body: DECIDE_BODY })).status).toBe(401);
    expect((await call(port, { token: "short", body: DECIDE_BODY })).status).toBe(401);
    expect(rt.decides).toBe(0);
  });

  it("200 with the right token", async () => {
    const rt = stub();
    const port = await serve(rt);
    const r = await call(port, { body: DECIDE_BODY });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, decisionId: "d1", hook: { kind: "none" } });
    expect(rt.decides).toBe(1);
  });

  it("405 for a non-POST method", async () => {
    const port = await serve(stub());
    expect((await call(port, { method: "GET" })).status).toBe(405);
  });

  it("413 over 256 KiB", async () => {
    const port = await serve(stub());
    const big = JSON.stringify({ seam: "prompt", hook: { prompt: "x".repeat(300 * 1024) } });
    expect((await call(port, { body: big })).status).toBe(413);
  });

  it("400 for bad JSON and for a bad shape", async () => {
    const port = await serve(stub());
    expect((await call(port, { body: "{nope" })).status).toBe(400);
    expect((await call(port, { body: JSON.stringify({ seam: "weird", hook: {} }) })).status).toBe(
      400,
    );
    expect((await call(port, { body: JSON.stringify({ seam: "prompt" }) })).status).toBe(400);
  });

  it("an error inside decide is 200 {ok:false, hook:none}", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await serve({
      decide: async () => {
        throw new Error("boom");
      },
      waitFor: async () => ({ answer: "timeout" }),
    });
    const r = await call(port, { body: DECIDE_BODY });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, hook: { kind: "none" } });
  });
});

const holdFamily: Family = {
  id: "safety",
  questionsFor: () => [],
  decide: () => ({
    response: { kind: "hold", ruleOrQuestion: "danger-level", releasable: "user-only" },
    drivers: [],
    reasonCode: "test-hold",
  }),
};

function realRuntime(): Runtime {
  const root = mkdtempSync(join(tmpdir(), "amy-http-"));
  dirs.push(root);
  const rt = createRuntime({
    config: parseConfig({ mode: "enforce", dataDir: join(root, "data") }),
    extensionRoot: EXT,
    gatewayPort: 1,
    v31: { readPluginConfig: () => undefined, settingsPath: join(root, "none.json") },
    apiKey: () => undefined,
    emit: () => {},
    logger: { info() {}, warn() {}, error() {} },
    families: [holdFamily],
  });
  runtimes.push(rt);
  rt.start();
  return rt;
}

const PRE = JSON.stringify({
  seam: "pre-tool",
  hook: { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/tmp" },
});

describe("with the real runtime", () => {
  it("a client that hangs up after sending still has its decision persisted", async () => {
    const rt = realRuntime();
    const port = await serve(rt);
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/plugins/amygdala2/decide",
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        },
        () => {},
      );
      req.on("error", () => {});
      req.end(PRE, () => {
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 5);
      });
    });
    const deadline = Date.now() + 3000;
    while (rt.feed().decisions.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(rt.feed().decisions).toHaveLength(1);
  });

  it("wait flow: decide returns wait, /wait blocks until runtime.answer releases it", async () => {
    const rt = realRuntime();
    const port = await serve(rt);
    const d = await call(port, { body: PRE });
    expect(d.json.hook.kind).toBe("wait");
    const id = d.json.hook.interventionId as string;
    const pending = call(port, {
      path: "/plugins/amygdala2/wait",
      body: JSON.stringify({ interventionId: id, timeoutMs: 5000 }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(rt.answer(id, "keep-held")).toBe(true);
    const w = await pending;
    expect(w.status).toBe(200);
    expect(w.json).toEqual({ answer: "keep-held" });
    expect(rt.feed().interventions.find((i) => i.id === id)?.state).toBe("denied");
  });

  it("an answer before /wait is remembered", async () => {
    const rt = realRuntime();
    const port = await serve(rt);
    const d = await call(port, { body: PRE });
    const id = d.json.hook.interventionId as string;
    expect(rt.answer(id, "allow-once")).toBe(true);
    const w = await call(port, {
      path: "/plugins/amygdala2/wait",
      body: JSON.stringify({ interventionId: id, timeoutMs: 5000 }),
    });
    expect(w.json).toEqual({ answer: "allow-once" });
    expect(rt.feed().interventions.find((i) => i.id === id)?.state).toBe("released");
  });

  it("timeout path: /wait returns timeout and the intervention expires", async () => {
    const rt = realRuntime();
    const port = await serve(rt);
    const d = await call(port, { body: PRE });
    const id = d.json.hook.interventionId as string;
    const w = await call(port, {
      path: "/plugins/amygdala2/wait",
      body: JSON.stringify({ interventionId: id, timeoutMs: 30 }),
    });
    expect(w.json).toEqual({ answer: "timeout" });
    expect(rt.feed().interventions.find((i) => i.id === id)?.state).toBe("expired");
  });

  it("wait needs the token too", async () => {
    const port = await serve(stub());
    const w = await call(port, {
      path: "/plugins/amygdala2/wait",
      token: "nope",
      body: JSON.stringify({ interventionId: "x", timeoutMs: 10 }),
    });
    expect(w.status).toBe(401);
  });
});
