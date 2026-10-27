import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilePolicy } from "../src/policy.js";
import { evaluateRules } from "../src/rules.js";
import { RULE_EXAMPLES, SAFE_EXAMPLES } from "./rules.test.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain .mjs module, no types
const lib: any = await import("../hooks/lib.mjs");

const dirs: string[] = [];
const servers: Server[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "amyg-hooklib-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const policy = compilePolicy({ mode: "enforce", v31Enforcing: false });

describe("evalFloor", () => {
  it("denies a destructive Bash command", () => {
    const r = lib.evalFloor(policy, "Bash", { command: "rm -rf /home/x" });
    expect(r?.rule).toBe("FS_DESTRUCTIVE_ROOT");
  });
  it("the hook holds a printed credentials file, lets a captured one through, and holds the Read tool", () => {
    const bash = (command: string) => lib.evalFloor(policy, "Bash", { command })?.rule ?? null;
    expect(bash("cat /work/demo/secrets/credentials.env")).toBe("CREDENTIAL_FILE_PRINTED");
    expect(bash("export K=$(sed -n 's/^A=//p' /etc/x.d/key.conf) && node run.mjs")).toBeNull();
    expect(bash("cat package.json")).toBeNull();
    expect(lib.evalFloor(policy, "Read", { file_path: "/w/secrets/credentials.env" })?.rule).toBe(
      "CREDENTIAL_FILE_PRINTED",
    );
    expect(lib.evalFloor(policy, "Read", { file_path: "/w/config.yaml" })).toBeNull();
  });
  it("returns null when floorActive is false", () => {
    const off = compilePolicy({ mode: "shadow", v31Enforcing: true });
    expect(off.floorActive).toBe(false);
    expect(lib.evalFloor(off, "Bash", { command: "rm -rf /home/x" })).toBeNull();
  });
  it("fails closed on a match with no endpoint at all", () => {
    const dir = tmp();
    writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
    expect(lib.readEndpoint(dir)).toBeNull();
    const loaded = lib.loadPolicy(dir);
    expect(lib.evalFloor(loaded, "Bash", { command: "mkfs.ext4 /dev/sda1" })?.rule).toBe(
      "FS_FORMAT",
    );
  });
  it("never throws on garbage", () => {
    const garbage = [
      null,
      undefined,
      5,
      "x",
      { rules: 3 },
      { rules: [null, { source: "(", enforce: true }] },
    ];
    for (const bad of garbage) {
      expect(() => lib.evalFloor(bad, undefined, undefined)).not.toThrow();
      expect(() => lib.evalFloor(bad, "Bash", null)).not.toThrow();
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => lib.evalFloor(policy, "exec", circular)).not.toThrow();
  });
  it("matches evaluateRules({enforcedOnly}) on the rule examples", () => {
    for (const cmd of [...RULE_EXAMPLES.map(([, c]) => c), ...SAFE_EXAMPLES]) {
      const expected = evaluateRules("Bash", cmd, { enforcedOnly: true }).rule;
      const got = lib.evalFloor(policy, "Bash", { command: cmd })?.rule ?? null;
      expect(got).toBe(expected);
    }
  });
});

describe("loadPolicy / dataDir / spool", () => {
  it("missing or corrupt policy -> null", () => {
    const dir = tmp();
    expect(lib.loadPolicy(dir)).toBeNull();
    writeFileSync(join(dir, "policy.json"), "{not json");
    expect(lib.loadPolicy(dir)).toBeNull();
  });
  it("spool appends and swallows errors", () => {
    const dir = tmp();
    lib.spool(dir, { a: 1 });
    lib.spool(dir, { a: 2 });
    const lines = readFileSync(join(dir, "hook-spool.jsonl"), "utf-8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).a)).toEqual([1, 2]);
    expect(() => lib.spool(join(dir, "missing", "deeper"), { a: 3 })).not.toThrow();
  });
  it("dataDir honours AMYGDALA2_DATA_DIR", () => {
    const prev = process.env.AMYGDALA2_DATA_DIR;
    process.env.AMYGDALA2_DATA_DIR = "/x/y";
    try {
      expect(lib.dataDir()).toBe("/x/y");
    } finally {
      if (prev === undefined) delete process.env.AMYGDALA2_DATA_DIR;
      else process.env.AMYGDALA2_DATA_DIR = prev;
    }
  });
});

describe("readEndpoint / postJson", () => {
  function serve(): Promise<number> {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          if (req.headers.authorization !== "Bearer tok") {
            res.statusCode = 401;
            res.end("{}");
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({ echo: JSON.parse(Buffer.concat(chunks).toString()), path: req.url }),
          );
        });
      });
      servers.push(s);
      s.listen(0, "127.0.0.1", () => {
        resolve((s.address() as { port: number }).port);
      });
    });
  }

  it("reads the endpoint file", () => {
    const dir = tmp();
    writeFileSync(join(dir, "endpoint.json"), JSON.stringify({ port: 5, token: "t" }));
    expect(lib.readEndpoint(dir)).toEqual({ port: 5, token: "t" });
    writeFileSync(join(dir, "endpoint.json"), "garbage");
    expect(lib.readEndpoint(dir)).toBeNull();
  });
  it("accepts the token, rejects a wrong one with 401", async () => {
    const port = await serve();
    const ok = await lib.postJson({ port, token: "tok" }, "/p", { a: 1 }, 2000);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ echo: { a: 1 }, path: "/p" });
    const bad = await lib.postJson({ port, token: "nope" }, "/p", {}, 2000);
    expect(bad.status).toBe(401);
  });
  it("resolves null on a dead port or null endpoint", async () => {
    const port = await serve();
    servers.pop()?.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(await lib.postJson({ port, token: "tok" }, "/p", {}, 500)).toBeNull();
    expect(await lib.postJson(null, "/p", {}, 500)).toBeNull();
  });
});
