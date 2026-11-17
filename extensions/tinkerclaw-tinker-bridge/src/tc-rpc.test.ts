import { execFile } from "node:child_process";
import type { EventEmitter } from "node:events";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

// FORK 2026-10-29: bin/tc-rpc.mjs, the lean client the plan-tools prompt sends prefrontal.plan.*
// through instead of the CLI line, which boots the whole CLI (about 8 s a call on the Pi). The
// client runs here as a real child process against a fake gateway on loopback. Its two copied
// facts, the protocol version and the least-privilege scopes, are pinned against their sources,
// and the worker side is checked where TC_RPC enters the child env. Its exit code says whether the
// request can have reached the gateway, and the prompt falls back to the CLI only when it did not,
// so a plan mutation that may already have run is never sent twice.

type FakeStream = EventEmitter & { writes: string[] };

const harness = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[] }>,
}));

// The worker's systemd-run spawn is captured, as in worker.fractal-guard.test.ts; every other
// child, the tc-rpc runs included, is real.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: Emitter } = await import("node:events");
  const stream = (): FakeStream => {
    const writes: string[] = [];
    return Object.assign(new Emitter(), {
      writes,
      setEncoding: () => undefined,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: () => undefined,
    });
  };
  const spawn = (
    file: string,
    args: string[],
    options?: import("node:child_process").SpawnOptions,
  ) => {
    if (file !== "systemd-run") {
      return actual.spawn(file, args, options ?? {});
    }
    harness.spawns.push({ file, args });
    return Object.assign(new Emitter(), {
      pid: 4242,
      stdin: stream(),
      stdout: stream(),
      stderr: stream(),
      kill: () => true,
    });
  };
  return { ...actual, spawn };
});

vi.mock("./moral-code-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./moral-code-delivery.js")>()),
  resolveCorePluginDir: () => "/nonexistent/tinkerclaw-core-fixture",
  readMaterializedMoralCode: () => "",
}));

vi.mock("./prompt-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt-loader.js")>()),
  loadPromptFile: () => "",
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const SCRIPT = path.resolve(here, "..", "bin", "tc-rpc.mjs");
const TOKEN = "tc-rpc-fixture-token-5b1e";
const readRepoFile = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

type CallResult = { code: number; out?: string; err?: string };

type TcRpc = {
  PROTOCOL_VERSION: number;
  METHOD_SCOPES: Record<string, readonly string[]>;
  EXIT: Record<string, number>;
  callGateway: (call: {
    url: string;
    origin: string;
    token: string;
    method: string;
    params: unknown;
    scopes: readonly string[];
    timeoutMs: number;
  }) => Promise<CallResult>;
};
// By URL: the script ships as plain .mjs, with no type declarations to import against.
const tcRpc = (await import(pathToFileURL(SCRIPT).href)) as TcRpc;

// worker.ts imports openclaw/plugin-sdk/*, which only the repo's vitest config maps to src/. A
// one-file config in a worktree without dist/ cannot resolve it (every worker*.test.ts fails there
// the same way), so the worker block at the end skips and says why. Any other failure to load
// worker.ts still fails this file.
const workerImport = await import("./worker.js").then(
  (module) => ({ module, skipped: "" }),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!/openclaw\/plugin-sdk\/|Cannot find package 'openclaw'/.test(message)) {
      throw err;
    }
    return { module: undefined, skipped: message.split("\n")[0] };
  },
);

type Frame = { type?: string; id?: string; method?: string; params?: Record<string, unknown> };

type FakeGateway = {
  url: string;
  frames: Frame[];
  upgrades: Array<{ url: string; headers: Record<string, unknown> }>;
  /** With upgradeDelayMs, settles once the late accept has run; without it, at once. */
  lateAccept: Promise<void>;
  /** The client connections the gateway still holds. */
  liveClients: () => number;
  close: () => Promise<void>;
};

type Answer = { ok: true; payload: unknown } | { ok: false; error: Record<string, unknown> };

async function startFakeGateway(opts: {
  token: string;
  behavior?: "answer" | "never-answer" | "no-challenge" | "drop-after-request";
  echoTokenOnRefusal?: boolean;
  answer?: Answer;
  /** Accept the WebSocket upgrade only this long after it arrives, as a busy gateway can. */
  upgradeDelayMs?: number;
}): Promise<FakeGateway> {
  const delay = opts.upgradeDelayMs;
  let lateAcceptRan: () => void = () => undefined;
  const lateAccept =
    delay === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          lateAcceptRan = () => resolve();
        });
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    // ws holds the upgrade until accept(), and then drops a client that has already hung up.
    ...(delay === undefined
      ? {}
      : {
          verifyClient: (_info: unknown, accept: (verified: boolean) => void) => {
            setTimeout(() => {
              accept(true);
              lateAcceptRan();
            }, delay);
          },
        }),
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const frames: Frame[] = [];
  const upgrades: FakeGateway["upgrades"] = [];
  server.on("connection", (socket, req) => {
    upgrades.push({ url: req.url ?? "", headers: { ...req.headers } });
    if (opts.behavior !== "no-challenge") {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "fixture-nonce", ts: Date.now() },
        }),
      );
    }
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      frames.push(frame);
      if (frame.method === "connect") {
        const presented = (frame.params?.auth as { token?: string } | undefined)?.token;
        if (presented !== opts.token) {
          // The real gateway never echoes a token; a fake that does proves tc-rpc's own redaction.
          const message = opts.echoTokenOnRefusal
            ? `unauthorized: token ${presented} does not match`
            : "unauthorized: gateway token mismatch";
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "INVALID_REQUEST", message, details: { code: "AUTH_TOKEN_MISMATCH" } },
            }),
          );
          socket.close(1008, "unauthorized");
          return;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { type: "hello-ok", auth: { role: "operator", scopes: frame.params?.scopes } },
          }),
        );
        // A connected client also gets ticks; tc-rpc must not take one for its answer.
        socket.send(JSON.stringify({ type: "event", event: "tick", payload: { ts: Date.now() } }));
        return;
      }
      if (opts.behavior === "never-answer") {
        return;
      }
      if (opts.behavior === "drop-after-request") {
        // The gateway goes away with the request in hand: the client cannot tell whether it ran.
        socket.terminate();
        return;
      }
      const answer = opts.answer ?? { ok: true, payload: { ok: true } };
      socket.send(JSON.stringify({ type: "res", id: frame.id, ...answer }));
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    frames,
    upgrades,
    lateAccept,
    liveClients: () => server.clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => resolve());
      }),
  };
}

type Run = { code: number; stdout: string; stderr: string };

function runTcRpc(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env, timeout: 20_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const gatewayEnv = (gateway: FakeGateway) => ({
  OPENCLAW_GATEWAY_URL: gateway.url,
  OPENCLAW_GATEWAY_TOKEN: TOKEN,
});

const PLAN_SET = [
  "prefrontal.plan.set",
  JSON.stringify({
    sessionKey: "agent:test:fixture",
    intent: "fixture",
    steps: [{ title: "one" }],
  }),
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("tc-rpc against a fake gateway", () => {
  let gateway: FakeGateway | undefined;
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  it("sends the token only in the connect frame, asks for the plan method's least-privilege scope, and prints the result", async () => {
    gateway = await startFakeGateway({ token: TOKEN });
    const params = { sessionKey: "agent:test:fixture", stepIndex: 0, status: "done", note: "n" };
    const run = await runTcRpc(
      ["prefrontal.plan.step", JSON.stringify(params)],
      gatewayEnv(gateway),
    );

    expect(run.stderr).toBe("");
    expect(run.code).toBe(tcRpc.EXIT.OK);
    expect(JSON.parse(run.stdout)).toEqual({ ok: true });
    expect(gateway.frames.map((frame) => frame.method)).toEqual([
      "connect",
      "prefrontal.plan.step",
    ]);
    const [connect, request] = gateway.frames;
    expect(connect.params).toMatchObject({
      minProtocol: tcRpc.PROTOCOL_VERSION,
      maxProtocol: tcRpc.PROTOCOL_VERSION,
      client: { id: "gateway-client", mode: "backend" },
      role: "operator",
      scopes: ["operator.admin"],
    });
    expect(connect.params?.device).toBeUndefined();
    expect(request.params).toEqual(params);

    // The token travels once, in connect.params.auth: never in the request, the URL or a header.
    const { auth, ...connectRest } = connect.params ?? {};
    expect(auth).toEqual({ token: TOKEN });
    expect(JSON.stringify(connectRest)).not.toContain(TOKEN);
    expect(JSON.stringify(request)).not.toContain(TOKEN);
    expect(gateway.upgrades).toHaveLength(1);
    expect(gateway.upgrades[0].url).not.toContain(TOKEN);
    expect(JSON.stringify(gateway.upgrades[0].headers)).not.toContain(TOKEN);
    expect(run.stdout).not.toContain(TOKEN);
  });

  it("asks health for operator.read and nothing more, and takes --params as the CLI line does", async () => {
    gateway = await startFakeGateway({
      token: TOKEN,
      answer: { ok: true, payload: { ok: true, ts: 1 } },
    });
    const run = await runTcRpc(
      ["health", "--params", "{}", "--timeout", "5000"],
      gatewayEnv(gateway),
    );
    expect(run.code).toBe(tcRpc.EXIT.OK);
    expect(JSON.parse(run.stdout)).toEqual({ ok: true, ts: 1 });
    expect(gateway.frames[0].params?.scopes).toEqual(["operator.read"]);
    expect(gateway.frames[1]).toMatchObject({ method: "health", params: {} });
  });

  it("reports the gateway's answer to a bad request with exit 1", async () => {
    gateway = await startFakeGateway({
      token: TOKEN,
      answer: {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message:
            "prefrontal.plan.step: invalid params: (root) must have required property 'sessionKey'",
        },
      },
    });
    const run = await runTcRpc(["prefrontal.plan.step", '{"stepIndex":0}'], gatewayEnv(gateway));
    expect(run.code).toBe(tcRpc.EXIT.RPC_ERROR);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("must have required property 'sessionKey'");
  });

  it("exits NOT_SENT on an auth failure and never prints the token, even when the gateway echoes it", async () => {
    gateway = await startFakeGateway({
      token: "the-gateway-holds-another-token",
      echoTokenOnRefusal: true,
    });
    const run = await runTcRpc(
      ["prefrontal.plan.get", '{"sessionKey":"agent:test:fixture"}'],
      gatewayEnv(gateway),
    );
    expect(run.code).toBe(tcRpc.EXIT.NOT_SENT);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("the gateway refused the connection");
    expect(run.stderr).toContain("AUTH_TOKEN_MISMATCH");
    expect(run.stderr).toContain("nothing was sent");
    expect(run.stderr).toContain("<redacted>");
    expect(run.stderr).not.toContain(TOKEN);
    expect(gateway.frames.map((frame) => frame.method)).toEqual(["connect"]);
  });

  it("times out as OUTCOME_UNKNOWN once the request is written and as NOT_SENT before, without printing the token", async () => {
    gateway = await startFakeGateway({ token: TOKEN, behavior: "never-answer" });
    const unanswered = await runTcRpc(
      [
        "prefrontal.plan.close",
        '{"sessionKey":"agent:test:fixture","status":"done"}',
        "--timeout",
        "1500",
      ],
      gatewayEnv(gateway),
    );
    expect(unanswered.code).toBe(tcRpc.EXIT.OUTCOME_UNKNOWN);
    expect(unanswered.stderr).toContain(
      "timed out after 1500 ms waiting for the answer to prefrontal.plan.close; the request was sent, so the gateway may have applied it",
    );
    expect(unanswered.stdout + unanswered.stderr).not.toContain(TOKEN);
    await gateway.close();

    gateway = await startFakeGateway({ token: TOKEN, behavior: "no-challenge" });
    const unchallenged = await runTcRpc(["health", "--timeout=400"], gatewayEnv(gateway));
    expect(unchallenged.code).toBe(tcRpc.EXIT.NOT_SENT);
    expect(unchallenged.stderr).toContain(
      "waiting for the gateway's connect challenge; nothing was sent",
    );
    expect(gateway.frames).toEqual([]);
  });

  it("exits OUTCOME_UNKNOWN when the connection drops after the request frame was written", async () => {
    gateway = await startFakeGateway({ token: TOKEN, behavior: "drop-after-request" });
    const run = await runTcRpc(PLAN_SET, gatewayEnv(gateway));
    expect(gateway.frames.map((frame) => frame.method)).toEqual(["connect", "prefrontal.plan.set"]);
    expect(run.code).toBe(tcRpc.EXIT.OUTCOME_UNKNOWN);
    expect(run.stderr).toContain("the request was sent, so the gateway may have applied it");
  });

  it("sends nothing once it has settled, even when the gateway accepts the upgrade after the timeout", async () => {
    // The sequence the cross-provider review reproduced: tc-rpc times out while the upgrade is
    // still pending, and the gateway accepts it later. tc-rpc exited 5 and then still sent connect
    // and the plan mutation, so the prompt's fallback ran the same mutation a second time.
    gateway = await startFakeGateway({ token: TOKEN, upgradeDelayMs: 1_000 });
    const [run] = await Promise.all([
      runTcRpc([...PLAN_SET, "--timeout", "300"], gatewayEnv(gateway)),
      gateway.lateAccept,
    ]);
    expect(gateway.frames).toEqual([]);
    expect(run.code).toBe(tcRpc.EXIT.NOT_SENT);
    expect(run.stderr).toContain(
      "timed out after 300 ms waiting for the gateway's connect challenge; nothing was sent",
    );
  });

  it("tears down a connection that is still being set up when the call settles", async () => {
    // In process, so no process exit hides a socket left open. The afterEach close takes a few
    // seconds here: after the abort, Node's built-in client opens a spare connection that sends
    // nothing and idles until its keep-alive timeout.
    gateway = await startFakeGateway({ token: TOKEN, upgradeDelayMs: 1_000 });
    const result = await tcRpc.callGateway({
      url: gateway.url,
      origin: gateway.url,
      token: TOKEN,
      method: "prefrontal.plan.set",
      params: {},
      scopes: ["operator.admin"],
      timeoutMs: 300,
    });
    await gateway.lateAccept;
    // Long enough for a client that kept its socket to finish the upgrade and the handshake.
    await sleep(300);
    expect(gateway.liveClients()).toBe(0);
    expect(gateway.frames).toEqual([]);
    expect(result.code).toBe(tcRpc.EXIT.NOT_SENT);
  });

  it("fails at once on a refused connect instead of waiting out its timeout", async () => {
    // Node 22's built-in client reports a refused connect with an error event and no close event.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const started = Date.now();
    const run = await runTcRpc(["health"], {
      OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${port}`,
      OPENCLAW_GATEWAY_TOKEN: TOKEN,
    });
    expect(run.code).toBe(tcRpc.EXIT.NOT_SENT);
    expect(run.stderr).toContain("could not open a WebSocket to the gateway");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("refuses a method whose least-privilege scope it does not know, before connecting", async () => {
    gateway = await startFakeGateway({ token: TOKEN });
    const run = await runTcRpc(["sessions.patch", "{}"], gatewayEnv(gateway));
    expect(run.code).toBe(tcRpc.EXIT.NOT_SENT);
    expect(run.stderr).toContain("openclaw gateway call");
    expect(gateway.upgrades).toEqual([]);
  });

  it("stays off without both gateway variables, and never sends the token in plaintext off loopback", async () => {
    const none = await runTcRpc(["health"], {});
    expect(none.code).toBe(tcRpc.EXIT.NOT_SENT);
    expect(none.stderr).toContain("OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN");
    const tokenOnly = await runTcRpc(["health"], { OPENCLAW_GATEWAY_TOKEN: TOKEN });
    expect(tokenOnly.code).toBe(tcRpc.EXIT.NOT_SENT);
    expect(tokenOnly.stderr).not.toContain(TOKEN);
    const remote = await runTcRpc(["health"], {
      OPENCLAW_GATEWAY_URL: "ws://192.0.2.10:18789",
      OPENCLAW_GATEWAY_TOKEN: TOKEN,
    });
    expect(remote.code).toBe(tcRpc.EXIT.NOT_SENT);
    expect(remote.stderr).toContain("refusing plaintext ws://");
    expect(remote.stderr).not.toContain(TOKEN);
  });
});

describe("the facts tc-rpc copies match their sources", () => {
  it("speaks the gateway's protocol version", () => {
    const source = readRepoFile("src/gateway/protocol/schema/protocol-schemas.ts");
    const version = /export const PROTOCOL_VERSION = (\d+) as const;/.exec(source)?.[1];
    expect(version).toBeDefined();
    expect(tcRpc.PROTOCOL_VERSION).toBe(Number(version));
  });

  it("asks the plan RPCs for the one scope tinkerclaw-prefrontal registers them with", () => {
    const rpcs = readRepoFile("extensions/tinkerclaw-prefrontal/plan-rpcs.ts");
    const planMethods = [...rpcs.matchAll(/"(prefrontal\.plan\.[a-z]+)": async/g)]
      .map((match) => match[1])
      .toSorted();
    expect(planMethods).toEqual([
      "prefrontal.plan.close",
      "prefrontal.plan.get",
      "prefrontal.plan.set",
      "prefrontal.plan.step",
    ]);
    const index = readRepoFile("extensions/tinkerclaw-prefrontal/index.ts");
    expect(index).toContain('const ADMIN_METHOD = { scope: "operator.admin" } as const;');
    expect(index).toMatch(
      /for \(const \[name, handler\] of Object\.entries\(planRpcs\)\) \{\s*api\.registerGatewayMethod\(\s*name,[\s\S]*?ADMIN_METHOD,\s*\);\s*\}/,
    );
    const tablePlanMethods = Object.keys(tcRpc.METHOD_SCOPES)
      .filter((method) => method.startsWith("prefrontal.plan."))
      .toSorted();
    expect(tablePlanMethods).toEqual(planMethods);
    for (const method of planMethods) {
      expect(tcRpc.METHOD_SCOPES[method]).toEqual(["operator.admin"]);
    }
  });

  it("asks health for the scope core lists it under, and knows no other method", () => {
    const scopes = readRepoFile("src/gateway/method-scopes.ts");
    const readGroup = /\[READ_SCOPE\]: \[([\s\S]*?)\n {2}\],/.exec(scopes)?.[1] ?? "";
    expect(readGroup).toMatch(/^\s*"health",$/m);
    expect(readRepoFile("src/gateway/operator-scopes.ts")).toContain(
      'export const READ_SCOPE = "operator.read" as const;',
    );
    expect(tcRpc.METHOD_SCOPES.health).toEqual(["operator.read"]);
    expect(Object.keys(tcRpc.METHOD_SCOPES).toSorted()).toEqual([
      "health",
      "prefrontal.plan.close",
      "prefrontal.plan.get",
      "prefrontal.plan.set",
      "prefrontal.plan.step",
    ]);
  });

  it("imports nothing but Node built-ins, so it never loads the CLI or the plugin graph", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    const specifiers = [...source.matchAll(/^import\s[^;]*?\sfrom\s+"([^"]+)";$/gm)].map(
      (match) => match[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
    expect(source).not.toMatch(/\bimport\(|\brequire\(/);
  });

  it("documents every exit code it returns in its header", () => {
    const header = fs.readFileSync(SCRIPT, "utf8").split("*/")[0];
    for (const [name, code] of Object.entries(tcRpc.EXIT)) {
      expect(header).toMatch(new RegExp(`^ \\*\\s+${code}\\s+${name}\\s`, "m"));
    }
  });
});

describe("the prompt and the worker side of TC_RPC", () => {
  it("runs the CLI line only when tc-rpc sent nothing, and reads the plan back when the outcome is unknown", () => {
    const prompt = fs.readFileSync(path.join(here, "..", "prompts", "plan-tools.md"), "utf8");
    const { NOT_SENT, OUTCOME_UNKNOWN } = tcRpc.EXIT;
    for (const method of ["prefrontal.plan.set", "prefrontal.plan.step"]) {
      expect(prompt).toContain(
        `r=${NOT_SENT}; [ -z "$TC_RPC" ] || { node "$TC_RPC" ${method} "$P"; r=$?; }; if [ $r -eq ${NOT_SENT} ]; then openclaw gateway call ${method} --timeout 60000 --params "$P"; else (exit $r); fi`,
      );
    }
    // Every CLI half sits behind the not-sent test: no line falls back on any other failure.
    const count = (needle: string) => prompt.split(needle).length - 1;
    const cliHalves = count("openclaw gateway call prefrontal.plan.");
    expect(cliHalves).toBeGreaterThan(0);
    expect(count(`if [ $r -eq ${NOT_SENT} ]; then openclaw gateway call prefrontal.plan.`)).toBe(
      cliHalves,
    );
    expect(prompt).not.toContain("|| openclaw gateway call");
    // An unknown outcome sends the worker to the read-only plan.get, never to a blind second send.
    const unknown = prompt.indexOf(`exits ${OUTCOME_UNKNOWN},`);
    expect(unknown).toBeGreaterThan(-1);
    expect(prompt.slice(unknown, unknown + 600)).toContain("`prefrontal.plan.get`");
    expect(prompt).toContain("`prefrontal.plan.close`");
  });

  it("sets TC_RPC from the env the child really gets, after the allowlist copy (source check)", () => {
    const worker = fs.readFileSync(path.join(here, "worker.ts"), "utf8");
    const copied = worker.indexOf("cleanEnv[key] = v;");
    const decided = worker.indexOf("tcRpcEnvFor(cleanEnv, resolveTcRpcPath())");
    const logged = worker.indexOf("env for claude spawn");
    expect(copied).toBeGreaterThan(-1);
    expect(decided).toBeGreaterThan(copied);
    expect(logged).toBeGreaterThan(decided);
    expect(worker).toContain("cleanEnv.TC_RPC = tcRpc.TC_RPC;");
  });
});

describe.skipIf(!workerImport.module)(
  `the worker exports TC_RPC only when the child can use it${workerImport.skipped ? ` (skipped: ${workerImport.skipped})` : ""}`,
  () => {
    const KEYS = [
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "TINKERCLAW_TC_RPC_BIN",
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
    ];
    const saved = new Map<string, string | undefined>();
    beforeEach(() => {
      harness.spawns.length = 0;
      for (const key of KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const key of KEYS) {
        const value = saved.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
    const worker = () => {
      if (!workerImport.module) {
        throw new Error("worker.ts did not load");
      }
      return workerImport.module;
    };
    const spawnArgs = async (): Promise<string[]> => {
      harness.spawns.length = 0;
      const child = new (worker().ClaudeCodeWorker)({
        sessionKey: "tinker-sp-fixture",
        cwd: os.tmpdir(),
      });
      await child.start();
      return harness.spawns[0]?.args ?? [];
    };
    const hasTcRpc = (args: string[]) => args.some((arg) => arg.startsWith("--setenv=TC_RPC="));

    it("finds the copy of the script this plugin ships in bin/", () => {
      expect(worker().resolveTcRpcPath({})).toBe(SCRIPT);
      // An override that points nowhere falls through to the shipped copy.
      expect(
        worker().resolveTcRpcPath({
          TINKERCLAW_TC_RPC_BIN: path.join(os.tmpdir(), "no-such-tc-rpc.mjs"),
        }),
      ).toBe(SCRIPT);
    });

    it("exports TC_RPC beside the gateway URL and token when the gateway env carries both", async () => {
      process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
      process.env.OPENCLAW_GATEWAY_TOKEN = TOKEN;
      const args = await spawnArgs();
      expect(args).toContain(`--setenv=TC_RPC=${SCRIPT}`);
      expect(args).toContain("--setenv=OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789");
    });

    it("leaves TC_RPC out when the URL or the token is missing, so the prompt takes the CLI line", async () => {
      const cases: Array<Record<string, string>> = [
        {},
        { OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789" },
        { OPENCLAW_GATEWAY_TOKEN: TOKEN },
      ];
      for (const env of cases) {
        delete process.env.OPENCLAW_GATEWAY_URL;
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
        Object.assign(process.env, env);
        const args = await spawnArgs();
        // The spawn really built the child env, so a missing TC_RPC is a decision, not an empty argv.
        expect(args).toContain("--setenv=TC_SESSION_KEY=tinker-sp-fixture");
        expect(hasTcRpc(args)).toBe(false);
      }
    });
  },
);
