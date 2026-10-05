import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks");
const TOKEN = "tok-abcdef";
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "amyg-hooks-"));
  dirs.push(d);
  return d;
}

interface Stub {
  port: number;
  decideBodies: unknown[];
  waitBodies: unknown[];
  notesBodies: unknown[];
}

/** Stub gateway. `wait` answer undefined = never answers. Checks the bearer token like the real one. */
async function stub(o: {
  hook?: unknown;
  delayMs?: number;
  wait?: unknown;
  notes?: string[];
}): Promise<Stub> {
  const s: Stub = { port: 0, decideBodies: [], waitBodies: [], notesBodies: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end("{}");
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      if (req.url === "/plugins/amygdala2/decide") {
        s.decideBodies.push(body);
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, decisionId: "d1", hook: o.hook ?? { kind: "none" } }));
        }, o.delayMs ?? 0);
      } else if (req.url === "/plugins/amygdala2/notes") {
        s.notesBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, notes: o.notes ?? [] }));
      } else if (req.url === "/plugins/amygdala2/wait") {
        s.waitBodies.push(body);
        if (o.wait === undefined) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o.wait));
      } else {
        res.writeHead(404).end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  s.port = (server.address() as AddressInfo).port;
  return s;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function setup(o: { port?: number; token?: string; policy?: unknown }): string {
  const dir = tmp();
  if (o.port !== undefined) {
    writeFileSync(
      join(dir, "endpoint.json"),
      JSON.stringify({ port: o.port, token: o.token ?? TOKEN }),
    );
  }
  if (o.policy !== undefined) writeFileSync(join(dir, "policy.json"), JSON.stringify(o.policy));
  return dir;
}

const floorPolicy = (floorActive: boolean) => ({
  floorActive,
  rules: [
    {
      id: "TEST_RULE",
      source: "forbidden-thing",
      flags: "",
      enforce: true,
      scope: "exec",
      explanation: "test explanation",
    },
  ],
});

function run(
  hook: string,
  dir: string,
  stdin: string,
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("node", [join(HOOKS, `${hook}.mjs`)], {
      env: { ...process.env, AMYGDALA2_DATA_DIR: dir, AMYGDALA2_SHADOW: "", ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
    p.stdin.end(stdin);
  });
}

const payload = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, ...extra });

const spoolRows = (dir: string): Array<Record<string, unknown>> => {
  try {
    return readFileSync(join(dir, "hook-spool.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

describe("hook stdout per HookAction (enforce)", () => {
  it("none prints nothing on all four", async () => {
    const s = await stub({ hook: { kind: "none" } });
    const dir = setup({ port: s.port, policy: floorPolicy(true) });
    for (const h of ["prompt", "pre-tool", "post-tool", "stop"]) {
      const r = await run(h, dir, payload());
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    }
    expect(s.decideBodies).toHaveLength(4);
    expect((s.decideBodies[0] as { seam: string }).seam).toBe("prompt");
  });

  it("context uses each hook's event name", async () => {
    const s = await stub({ hook: { kind: "context", text: "hello" } });
    const dir = setup({ port: s.port, policy: floorPolicy(true) });
    const names: Record<string, string> = {
      prompt: "UserPromptSubmit",
      "pre-tool": "PreToolUse",
      "post-tool": "PostToolUse",
    };
    for (const [h, ev] of Object.entries(names)) {
      const r = await run(h, dir, payload());
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({
        hookSpecificOutput: { hookEventName: ev, additionalContext: "hello" },
      });
    }
  });

  it("deny on pre-tool prints the deny JSON", async () => {
    const s = await stub({ hook: { kind: "deny", reason: "no way" } });
    const dir = setup({ port: s.port, policy: floorPolicy(true) });
    const r = await run("pre-tool", dir, payload());
    expect(JSON.parse(r.out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no way",
      },
    });
  });

  it("block on stop prints the block JSON", async () => {
    const s = await stub({ hook: { kind: "block", reason: "go back" } });
    const dir = setup({ port: s.port });
    const r = await run("stop", dir, payload());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ decision: "block", reason: "go back" });
  });

  it("a wrong bearer token gets 401 and the hook stays silent", async () => {
    const s = await stub({ hook: { kind: "context", text: "x" } });
    const dir = setup({ port: s.port, token: "wrong" });
    const r = await run("prompt", dir, payload());
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(s.decideBodies).toHaveLength(0);
    expect(spoolRows(dir).at(-1)).toMatchObject({ action: "refused", status: 401 });
  });
});

describe("wait flow", () => {
  const wait = (timeoutMs = 5000) => ({
    kind: "wait",
    interventionId: "iv1",
    timeoutMs,
    onKeep: "kept",
    onTimeout: "timed out",
  });
  const denyJson = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });

  it("allow-once prints nothing", async () => {
    const s = await stub({ hook: wait(), wait: { answer: "allow-once" } });
    const r = await run("pre-tool", setup({ port: s.port }), payload());
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(s.waitBodies).toEqual([{ interventionId: "iv1", timeoutMs: 5000 }]);
  });

  it("keep-held denies with onKeep", async () => {
    const s = await stub({ hook: wait(), wait: { answer: "keep-held" } });
    const r = await run("pre-tool", setup({ port: s.port }), payload());
    expect(JSON.parse(r.out)).toEqual(denyJson("kept"));
  });

  it("option:x denies with the rendered text", async () => {
    const s = await stub({ hook: wait(), wait: { answer: "option:x", text: "picked x" } });
    const r = await run("pre-tool", setup({ port: s.port }), payload());
    expect(JSON.parse(r.out)).toEqual(denyJson("picked x"));
  });

  it("option:x without text falls back to onKeep", async () => {
    const s = await stub({ hook: wait(), wait: { answer: "option:x" } });
    const r = await run("pre-tool", setup({ port: s.port }), payload());
    expect(JSON.parse(r.out)).toEqual(denyJson("kept"));
  });

  it("a wait that never answers ends in the timeout deny", async () => {
    const s = await stub({ hook: wait(200) });
    const r = await run("pre-tool", setup({ port: s.port }), payload());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(denyJson("timed out"));
  }, 20_000);
});

describe("shadow mode (C20)", () => {
  it("returns in < 300 ms against a 2 s gateway, prints nothing, the stub got the request", async () => {
    const s = await stub({ hook: { kind: "deny", reason: "no" }, delayMs: 2000 });
    const dir = setup({ port: s.port, policy: floorPolicy(true) });
    const r = await run("pre-tool", dir, payload(), { AMYGDALA2_SHADOW: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.ms).toBeLessThan(300);
    expect(s.decideBodies).toHaveLength(1);
  });

  it("a call the gateway refuses (401) is spooled as refused with its status, not as a quiet shadow row", async () => {
    // 2026-09-30: every chat hook got 401 for two hours and the spool said "shadow" each time.
    const s = await stub({});
    const dir = setup({ port: s.port, token: "wrong", policy: floorPolicy(true) });
    const r = await run("pre-tool", dir, payload(), { AMYGDALA2_SHADOW: "1" });
    expect(r.out).toBe("");
    const last = spoolRows(dir).at(-1)!;
    expect(last.action).toBe("refused");
    expect(last.status).toBe(401);
  });

  it("a tool result over the gateway's size limit is cut down, so the step still arrives (2026-10-02, 413s)", async () => {
    const s = await stub({});
    const dir = setup({ port: s.port });
    const big = payload({
      tool_name: "Read",
      tool_response: { file: { content: "x".repeat(600_000) } },
    });
    const r = await run("post-tool", dir, big, { AMYGDALA2_SHADOW: "1" });
    expect(r.out).toBe("");
    expect(s.decideBodies).toHaveLength(1);
    expect(JSON.stringify(s.decideBodies[0]).length).toBeLessThan(256 * 1024);
    const content = (
      s.decideBodies[0] as { hook: { tool_response: { file: { content: string } } } }
    ).hook.tool_response.file.content;
    expect(content).toMatch(/\[cut \d+ chars\]$/);
    expect(spoolRows(dir).at(-1)!.action).toBe("shadow");
  });

  // 2026-10-03, personality live while the rest stays in shadow: the gateway queues the note, the next hook prints it.
  it("a note the gateway queued for this chat is printed as context, without waiting for the judge", async () => {
    const s = await stub({
      notes: ["You expected the tests to pass; they failed."],
      delayMs: 2000,
    });
    const dir = setup({ port: s.port });
    const r = await run("post-tool", dir, payload(), {
      AMYGDALA2_SHADOW: "1",
      TC_SESSION_KEY: "agent:main:tinker:x",
    });
    expect(JSON.parse(r.out).hookSpecificOutput).toEqual({
      hookEventName: "PostToolUse",
      additionalContext: "You expected the tests to pass; they failed.",
    });
    expect(s.notesBodies[0]).toEqual({ tabKey: "agent:main:tinker:x" });
    expect(r.ms).toBeLessThan(600);
    expect(spoolRows(dir).at(-1)).toMatchObject({ action: "note", notes: 1 });
  });

  it("no queued note prints nothing; the stop step never asks", async () => {
    const s = await stub({});
    const r = await run("post-tool", setup({ port: s.port }), payload(), { AMYGDALA2_SHADOW: "1" });
    expect(r.out).toBe("");
    await run("stop", setup({ port: s.port }), payload(), { AMYGDALA2_SHADOW: "1" });
    expect(s.notesBodies).toHaveLength(1);
  });

  it("never denies from the gateway's action", async () => {
    const s = await stub({ hook: { kind: "block", reason: "no" } });
    const r = await run("stop", setup({ port: s.port }), payload(), { AMYGDALA2_SHADOW: "1" });
    expect(r.out).toBe("");
  });

  it("still denies a floor match when floorActive", async () => {
    const s = await stub({ delayMs: 2000 });
    const dir = setup({ port: s.port, policy: floorPolicy(true) });
    const r = await run(
      "pre-tool",
      dir,
      payload({ tool_input: { command: "do forbidden-thing" } }),
      {
        AMYGDALA2_SHADOW: "1",
      },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("TEST_RULE");
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("floor and failure paths", () => {
  it("dead gateway returns in < 200 ms with no output", async () => {
    const dir = setup({ port: await closedPort() });
    const r = await run("prompt", dir, payload());
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.ms).toBeLessThan(200);
  });

  it("no endpoint file exits immediately and silently", async () => {
    const dir = setup({});
    const r = await run("prompt", dir, payload());
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(spoolRows(dir).map((x) => x.action)).toContain("no-endpoint");
  });

  it("floor match denies with the gateway down", async () => {
    const dir = setup({ port: await closedPort(), policy: floorPolicy(true) });
    const r = await run("pre-tool", dir, payload({ tool_input: { command: "x forbidden-thing" } }));
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(j.hookSpecificOutput.permissionDecisionReason).toContain("TEST_RULE");
    const row = spoolRows(dir).find((x) => x.floor === true);
    expect(row?.rule).toBe("TEST_RULE");
  });

  it("floorActive:false means no floor deny", async () => {
    const dir = setup({ port: await closedPort(), policy: floorPolicy(false) });
    const r = await run("pre-tool", dir, payload({ tool_input: { command: "x forbidden-thing" } }));
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  it("missing policy spools floor-missing and continues fail-open", async () => {
    const dir = setup({ port: await closedPort() });
    const r = await run("pre-tool", dir, payload());
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(spoolRows(dir).map((x) => x.action)).toContain("floor-missing");
  });

  it("garbage stdin exits 0 silently", async () => {
    const s = await stub({ hook: { kind: "context", text: "x" } });
    const dir = setup({ port: s.port });
    for (const h of ["prompt", "pre-tool", "post-tool", "stop"]) {
      const r = await run(h, dir, "not json {{");
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    }
    expect(s.decideBodies).toHaveLength(0);
  });

  it("spool rows carry no prompt text or tool input", async () => {
    const s = await stub({ hook: { kind: "none" } });
    const dir = setup({ port: s.port });
    await run(
      "prompt",
      dir,
      payload({ prompt: "SECRET-PROMPT", tool_input: { command: "SECRET-CMD" } }),
    );
    const raw = readFileSync(join(dir, "hook-spool.jsonl"), "utf-8");
    expect(raw).not.toContain("SECRET");
  });
});
